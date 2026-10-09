"""Serialized PVS6 collector: tiered reads, minute rollup, local queue, upload.

Two independent state dimensions are tracked: PVS reading and cloud upload.
A failed read produces no value; a failed upload keeps the record queued.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import model
from .model import SCHEMA_VERSION, floor_slot, to_iso, utc_now
from .pvs import PVSClient, PVSError
from .queue import PendingQueue
from .rollup import SiteMinute, panel_entry, panel_sample_record
from .upload import AuthError, IngestClient, RejectedError, RetryableError

INTERVALS = {"site": 10.0, "meters": 30.0, "inverters": 300.0, "health": 300.0}
COOLDOWN_FAILURES = 3
# A failing group waits a minute before trying again, and keeps to that pace.
# Measured PVS CPU never tracked our request rate (see docs/operations.md), so
# there is nothing to gain by lengthening the pause: a reboot or session blip is
# caught inside a minute, and one attempt a minute stays far below the upstream
# "never poll faster than a few seconds" floor.
COOLDOWN_SECONDS = 60.0
HEARTBEAT_SECONDS = 3600.0
HEARTBEAT_FIRST_SECONDS = 60.0
MAX_BATCH = 100
UPLOAD_BACKOFF_SECONDS = (10.0, 30.0, 60.0, 300.0)
QUEUE_WARN_ROWS = 50_000
QUEUE_WARN_FREE_BYTES = 200 * 1024 * 1024
QUEUE_WARN_INTERVAL = 3600.0
MAX_WAIT_SLICE = 1.0
STARTUP_BACKOFF_SECONDS = 10.0
MAX_STARTUP_BACKOFF_SECONDS = 300.0


class Collector:
    """Drive PVS reads on a monotonic schedule and persist what must survive."""

    def __init__(
        self,
        pvs,
        queue: PendingQueue,
        upload=None,
        *,
        collector_id: str = "home-pvs",
        intervals: dict | None = None,
        monotonic=time.monotonic,
        sleep=time.sleep,
        now=utc_now,
        log=print,
    ):
        self.pvs = pvs
        self.queue = queue
        self.upload = upload
        self.collector_id = collector_id
        self.intervals = dict(intervals or INTERVALS)
        self._monotonic = monotonic
        self._sleep = sleep
        self._now = now
        self._log = log
        self._groups = {group: {"failures": 0, "open_event": False} for group in self.intervals}
        self._due = {group: 0.0 for group in self.intervals}
        self._due["rollup"] = 0.0
        self._minute: SiteMinute | None = None
        self._next_boundary: datetime | None = None
        self._panel_count = 0
        self._panels_fresh = 0
        self._health: dict = {}
        self._uptime_observation: tuple[float, float] | None = None
        self._last_sample_at: datetime | None = None
        self._upload_open = False
        self._upload_backoff = 0.0
        self._upload_skip_until = 0.0
        self._last_queue_warning = float("-inf")

    # -- events and logging ------------------------------------------------
    def _log_line(self, **fields) -> None:
        fields.setdefault("ts", to_iso(self._now()))
        self._log(json.dumps(fields, separators=(",", ":"), sort_keys=True))

    def _event(self, event_type: str, details_code: str | None = None) -> None:
        event_ts = to_iso(self._now())
        self.queue.enqueue(
            [
                {
                    "schema_version": SCHEMA_VERSION,
                    "collector_id": self.collector_id,
                    "record_id": model.record_id(self.collector_id, "collector_event", f"{event_type}:{event_ts}"),
                    "kind": "collector_event",
                    "event_type": event_type,
                    "event_ts_utc": event_ts,
                    "details_code": details_code,
                }
            ]
        )
        self._log_line(event=event_type, details=details_code)

    def _heartbeat(self) -> None:
        """One small cloud event per hour: proof the collector itself is alive."""
        self._due["heartbeat"] = self._monotonic() + HEARTBEAT_SECONDS
        queue = self.queue.counts()
        failing = [group for group, state in self._groups.items() if state.get("error")]
        details = ",".join(
            [
                f"uptime={self._health_text('uptime')}",
                f"cpu_pct={self._health_text('cpu_pct')}",
                f"flash_pct={self._health_text('flash_pct')}",
                f"health_age_s={self._read_age_seconds('health')}",
                f"queue_pending={queue['pending']}",
                f"queue_failed={queue['failed']}",
                f"site_age_s={self._site_age_seconds()}",
                f"panels_fresh={self._panels_fresh if self._group_fresh('inverters') else 0}",
                f"panels_age_s={self._read_age_seconds('inverters')}",
                f"groups_failed={','.join(failing) or 'none'}",
            ]
        )
        self._event("collector_heartbeat", details)

    def _health_text(self, name: str) -> str:
        value = self._health.get(name) if self._group_fresh("health") else None
        return "null" if value is None else str(int(value))

    def _read_age_seconds(self, group: str) -> str:
        observed = self._groups.get(group, {}).get("last_success")
        return "null" if observed is None else str(max(0, int(self._monotonic() - observed)))

    def _group_fresh(self, group: str) -> bool:
        state = self._groups.get(group, {})
        observed = state.get("last_success")
        return (observed is not None and not state.get("error")
                and self._monotonic() - observed <= 2 * self.intervals[group])

    def _site_age_seconds(self) -> str:
        if self._last_sample_at is None:
            return "null"
        return str(max(0, int((self._now() - self._last_sample_at).total_seconds())))

    # -- schedule ----------------------------------------------------------
    def run(self, duration: float | None = None) -> None:
        started_at = self._now()
        self._next_boundary = model.floor_minute(started_at) + timedelta(minutes=1)
        # Due times are monotonic-clock values, and that clock starts at boot on
        # the Pi, so both offsets are added to it rather than used directly.
        self._due["rollup"] = self._monotonic() + max(0.0, (self._next_boundary - started_at).total_seconds())
        self._due["heartbeat"] = self._monotonic() + HEARTBEAT_FIRST_SECONDS
        self._log_line(
            event="collector_started",
            collector_id=self.collector_id,
            intervals=self.intervals,
            upload=self.upload is not None,
            panels_known=self.queue.panel_count(),
        )
        self._event("collector_started", "boot")
        deadline = None if duration is None else self._monotonic() + duration
        while deadline is None or self._monotonic() < deadline:
            group = min(self._due, key=lambda name: (self._due[name], name != "rollup"))
            wait = self._due[group] - self._monotonic()
            if wait > 0:
                self._sleep(min(wait, MAX_WAIT_SLICE))
                continue
            if deadline is not None and self._monotonic() >= deadline:
                break
            if group == "rollup":
                self._rollup()
            elif group == "heartbeat":
                self._heartbeat()
            else:
                self._read_group(group)
            self._drain_queue()
        # A partially collected minute is dropped rather than restamped with a
        # short window: at most 60s of samples are lost per restart.
        self._log_line(event="collector_stopped", queue=self.queue.counts())

    def _rollup(self) -> None:
        boundary = self._next_boundary or (model.floor_minute(self._now()) + timedelta(minutes=1))
        if self._minute is not None:
            failure = self._failure_code()
            self.queue.enqueue([self._minute.record(self.collector_id, boundary, failure)])
        self._minute = SiteMinute(boundary)
        self._next_boundary = boundary + timedelta(minutes=1)
        self._due["rollup"] = self._monotonic() + max(0.0, (self._next_boundary - self._now()).total_seconds())

    def _failure_code(self) -> str | None:
        """Name the group and exception behind an empty or short minute."""
        for group in ("site", "meters", "inverters", "health"):
            state = self._groups.get(group)
            # The class stays on the group until a read succeeds, so a cooldown
            # keeps explaining the minutes it is holding back.
            if state and state.get("error"):
                return f"{group}:{state['error']}"
        return None

    # -- reads -------------------------------------------------------------
    def _read_group(self, group: str) -> None:
        state = self._groups[group]
        self._due[group] = self._monotonic() + self.intervals[group]
        try:
            getattr(self, f"_read_{group}")()
        except (PVSError, ValueError) as exc:
            state["failures"] += 1
            state["error"] = type(exc).__name__
            diagnostics = exc.diagnostics if isinstance(exc, PVSError) else {"reason": "parse", "stage": "read"}
            if group == "inverters":
                self._panels_fresh = 0
            if not state["open_event"]:
                state["open_event"] = True
                details = ",".join(f"{key}={value}" for key, value in diagnostics.items())
                self._event("pvs_request_failed", f"{group}:{type(exc).__name__},{details}")
            self._log_line(event="read_failed", group=group, error=type(exc).__name__, failures=state["failures"], **diagnostics)
            if state["failures"] >= COOLDOWN_FAILURES:
                self._due[group] = self._monotonic() + COOLDOWN_SECONDS
                self._log_line(event="cooldown", group=group, seconds=COOLDOWN_SECONDS)
        else:
            if state["open_event"]:
                state["open_event"] = False
                self._event("pvs_recovered", group)
            state["failures"] = 0
            state.pop("error", None)
            state["last_success"] = self._monotonic()

    def _read_site(self) -> None:
        data, latency = self.pvs.read_site()
        sample = model.parse_site(data, self._now())
        if self._minute is not None and self._minute.add(sample):
            self._last_sample_at = sample.measured_at
        self._log_line(
            event="site_read",
            latency_ms=latency,
            quality=sample.quality,
            measured_at=sample.measured_at is not None,
            fields={name: sample.values[name] is not None for name in model.SITE_FIELDS},
        )
        self._upload_live(sample)

    def _read_meters(self) -> None:
        data, latency = self.pvs.read_meters()
        meters = model.parse_meters(data)
        # Meter roles and CT orientation are not verified yet, so meter values
        # stay out of site history and are read for diagnosis only.
        self._log_line(
            event="meter_read",
            latency_ms=latency,
            devices=len(meters),
            fresh_measurements=sum(meter.measured_at is not None for meter in meters),
        )

    def _read_inverters(self) -> None:
        data, latency = self.pvs.read_inverters()
        collected_at = self._now()
        panels = model.parse_panels(data)
        # A reply with a different number of inverters than the last one earns
        # one event: a partial PVS answer quietly shrinks every panel page, and
        # the pages themselves cannot tell that from an unplugged array.
        if self._panel_count and len(panels) != self._panel_count:
            self._event("panel_count_changed", f"{self._panel_count}->{len(panels)}")
        self._record_panels(panels, collected_at)
        measured = sum(panel.measured_at is not None for panel in panels)
        self._log_line(
            event="inverter_read",
            latency_ms=latency,
            devices=len(panels),
            measured_times=measured,
            power_values=sum(panel.values.get("ac_kw") is not None for panel in panels),
        )

    def _read_health(self) -> None:
        data, latency = self.pvs.read_health()
        observed_mono, observed_at = self._monotonic(), self._now()
        health = {
            "uptime": model.finite_number(data.get("/sys/info/uptime")),
            "cpu_pct": model.finite_number(data.get("/sys/info/cpu_usage")),
            "flash_pct": model.finite_number(data.get("/sys/info/flash_usage")),
        }
        uptime = health["uptime"]
        if uptime is not None and not 0 <= uptime <= observed_at.timestamp():
            health["uptime"] = uptime = None
        previous = self._uptime_observation
        restarted = model.pvs_uptime_regressed(
            {"uptime": previous[0]} if previous else {}, health,
            elapsed_seconds=observed_mono - previous[1] if previous else None,
        )
        if uptime is not None:
            self._uptime_observation = (uptime, observed_mono)
        self._health = health
        boot_ts = to_iso(observed_at - timedelta(seconds=uptime)) if uptime is not None else None
        self._log_line(event="health_read", ts=to_iso(observed_at), latency_ms=latency, boot_ts_utc=boot_ts, **health)
        if restarted:
            self._event("pvs_restarted", "uptime_reset")
            self.pvs.authenticate()

    # -- panels ------------------------------------------------------------
    def _record_panels(self, panels: list, collected_at: datetime) -> None:
        slot_start = floor_slot(collected_at)
        slot_ts = to_iso(slot_start)
        self._panel_count = len(panels)
        self._panels_fresh = 0
        known_indexes = self.queue.panel_indexes()
        assignment = {}
        records = []
        for panel in panels:
            # Identity follows the device serial, so a PVS renumbering cannot
            # move one panel's history onto another.
            panel_id = self.queue.panel_id(panel.index, panel.serial)
            assignment[panel.index] = panel_id
            last_valid = self.queue.panel_last_measured(panel_id)
            measured_at = to_iso(panel.measured_at)
            fresh = (measured_at is not None and (last_valid is None or measured_at > last_valid)
                     and self.queue.panel_last_sample_slot(panel_id) != slot_ts)
            if fresh:
                entry = panel_entry(panel, True, last_valid)
                records.append(panel_sample_record(self.collector_id, panel_id, slot_start, entry))
        self._panels_fresh = self.queue.enqueue(records)
        # A restart that reshuffles which device answers at which index is worth
        # one event: the panel ids stay right, but the array was re-enumerated.
        # The previous index comes from the stored map, so a collector restart
        # does not hide the change.
        moved = sum(
            1 for index, panel_id in assignment.items() if known_indexes.get(panel_id, index) != index
        )
        if moved > 0:
            self._event("panel_identity_changed", f"inverters={len(assignment)},moved={moved}")

    # -- uploads -----------------------------------------------------------
    def _upload_live(self, sample: model.SiteSample) -> None:
        if self.upload is None or self._monotonic() < self._upload_skip_until:
            return
        try:
            self.upload.put_live(model.live_payload(self.collector_id, sample))
        except AuthError as exc:
            self._upload_auth_failed(exc)
        except RetryableError as exc:
            self._upload_failed(exc)
        else:
            self._upload_ok()

    def _drain_queue(self) -> None:
        if self.upload is None or self._monotonic() < self._upload_skip_until:
            return
        rows = self.queue.batch(MAX_BATCH)
        if not rows:
            return
        ids = [row["record_id"] for row in rows]
        try:
            accepted = self.upload.post_records(self.collector_id, [row["payload"] for row in rows])
        except AuthError as exc:
            self._upload_auth_failed(exc)
            return
        except RetryableError as exc:
            self.queue.bump(ids)
            self._upload_failed(exc)
            return
        except RejectedError as exc:
            rejected = exc.record_ids or ids
            self.queue.fail(rejected, str(exc))
            self._event("record_rejected", f"{len(rejected)}")
            return
        self.queue.ack(accepted or ids)
        self._upload_ok()
        self._check_queue_capacity()

    def _upload_ok(self) -> None:
        self._upload_backoff = 0.0
        self._upload_skip_until = 0.0
        if self._upload_open:
            self._upload_open = False
            self._event("wan_recovered", "upload")

    def _upload_failed(self, exc: Exception) -> None:
        if not self._upload_open:
            self._upload_open = True
            self._event("wan_upload_failed", "upload")
        index = min(int(self._upload_backoff), len(UPLOAD_BACKOFF_SECONDS) - 1)
        self._upload_backoff = index + 1
        self._upload_skip_until = self._monotonic() + UPLOAD_BACKOFF_SECONDS[index]
        self._log_line(event="upload_failed", error=type(exc).__name__, retry_in=UPLOAD_BACKOFF_SECONDS[index])

    def _upload_auth_failed(self, exc: Exception) -> None:
        self._event("wan_upload_failed", "auth")
        self._log_line(event="upload_auth_failed", error=type(exc).__name__, action="sending_stopped")
        self.upload = None

    def _check_queue_capacity(self) -> None:
        stats = self.queue.counts()
        free = self.queue.free_bytes()
        if stats["pending"] < QUEUE_WARN_ROWS and free >= QUEUE_WARN_FREE_BYTES:
            return
        if self._monotonic() - self._last_queue_warning < QUEUE_WARN_INTERVAL:
            return
        self._last_queue_warning = self._monotonic()
        self._event("queue_capacity_warning", f"pending={stats['pending']}")
        self._log_line(event="queue_capacity", **stats, free_bytes=free, bytes_on_disk=self.queue.bytes_on_disk())


def check_reads(host: str, log=print) -> int:
    """One read-only pass over every group; prints values, stores nothing."""
    pvs = PVSClient(host)
    failures = 0
    try:
        data, latency = pvs.read_site()
        sample = model.parse_site(data)
        log(f"site ok latency_ms={latency} quality={sample.quality} field_count={sample.field_count}")
        log(f"site measured_at_utc={to_iso(sample.measured_at)}")
        log("site values " + json.dumps(sample.values, sort_keys=True))
        balance = sample.values["load_kw_reported"]
        derived = sum(
            value
            for value in (sample.values["pv_kw"], sample.values["grid_kw"], sample.values["battery_kw"])
            if value is not None
        )
        if balance is not None and all(sample.values[name] is not None for name in ("pv_kw", "grid_kw")):
            log(f"site balance_check load_minus_known_sources={round(balance - derived, 4)}")
    except PVSError as exc:
        failures += 1
        log(f"site FAILED {type(exc).__name__} " + json.dumps(exc.diagnostics, sort_keys=True))
    for name, reader, parse in (
        ("meters", pvs.read_meters, model.parse_meters),
        ("inverters", pvs.read_inverters, model.parse_panels),
    ):
        try:
            data, latency = reader()
        except PVSError as exc:
            failures += 1
            log(f"{name} FAILED {type(exc).__name__} " + json.dumps(exc.diagnostics, sort_keys=True))
            continue
        devices = parse(data)
        log(f"{name} ok latency_ms={latency} devices={len(devices)} path_fields={len(data)}")
        for device in devices:
            log(
                f"{name} device index={device.index} measured_at_utc={to_iso(device.measured_at)} "
                + json.dumps(device.values, sort_keys=True)
            )
    try:
        data, latency = pvs.read_health()
        log(f"health ok latency_ms={latency} " + json.dumps(data, sort_keys=True))
    except PVSError as exc:
        failures += 1
        log(f"health FAILED {type(exc).__name__} " + json.dumps(exc.diagnostics, sort_keys=True))
    log(f"check finished failures={failures} stored=no")
    return failures


def connect_pvs(host: str, *, log=print, sleep=time.sleep, client=PVSClient, deadline=None, monotonic=time.monotonic):
    """Wait for the PVS instead of crash-looping when it is rebooting or down."""
    delay = STARTUP_BACKOFF_SECONDS
    while deadline is None or monotonic() < deadline:
        try:
            return client(host)
        except PVSError as exc:
            wait = delay if deadline is None else min(delay, max(0.0, deadline - monotonic()))
            if wait <= 0:
                break
            log(json.dumps({"event": "pvs_unavailable", "error": type(exc).__name__, "retry_in_seconds": wait,
                            **exc.diagnostics}, sort_keys=True))
            sleep(wait)
            delay = min(delay * 2, MAX_STARTUP_BACKOFF_SECONDS)
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("PVS_HOST"), help="PVS LAN address (or set PVS_HOST)")
    parser.add_argument("--db", type=Path, default=Path("pilot-data/queue.sqlite3"), help="SQLite queue path")
    parser.add_argument("--collector-id", default=os.environ.get("COLLECTOR_ID", "home-pvs"))
    parser.add_argument("--ingest-url", default=os.environ.get("INGEST_BASE_URL"), help="ingest Worker origin")
    parser.add_argument("--token-file", type=Path, default=os.environ.get("INGEST_TOKEN_FILE"), help="file with the upload token")
    parser.add_argument("--duration", type=float, default=None, help="seconds to run (default: until stopped)")
    parser.add_argument("--check", action="store_true", help="one read-only pass over every group, then exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    # Keep journald lines immediate instead of block-buffered behind a pipe.
    sys.stdout.reconfigure(line_buffering=True)
    args = build_parser().parse_args(argv)
    if not args.host:
        build_parser().error("--host is required unless PVS_HOST is set")
    if args.check:
        return 1 if check_reads(args.host, log=print) else 0
    token = None
    if args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    token = token or os.environ.get("INGEST_TOKEN")
    if args.ingest_url and not token:
        build_parser().error("--ingest-url needs --token-file or INGEST_TOKEN")
    upload = IngestClient(args.ingest_url, token) if args.ingest_url else None
    queue = PendingQueue(args.db)
    deadline = None if args.duration is None else time.monotonic() + max(0.0, args.duration)

    def stop_on_sigterm(_signum, _frame):
        raise KeyboardInterrupt

    previous_sigterm = signal.signal(signal.SIGTERM, stop_on_sigterm)
    try:
        pvs = connect_pvs(args.host, deadline=deadline)
        if pvs is not None:
            remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
            Collector(pvs, queue, upload, collector_id=args.collector_id).run(remaining)
    except KeyboardInterrupt:
        print(json.dumps({"event": "interrupted", "queue": queue.counts()}, sort_keys=True))
    finally:
        queue.close()
        signal.signal(signal.SIGTERM, previous_sigterm)
    return 0


if __name__ == "__main__":
    sys.exit(main())
