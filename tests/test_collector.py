"""Collector tests: rollup, queue durability, panel freshness, upload retry."""

import io
import http.server
import json
import select
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from collector import model
from collector.main import Collector, connect_pvs
from collector.pvs import PVSError
from collector.queue import PendingQueue
from collector.rollup import SiteMinute
from collector.upload import AuthError, IngestClient, RejectedError, RetryableError

START = datetime(2026, 9, 18, 2, 0, 30, tzinfo=timezone.utc)
MINUTE = START.replace(second=0)


def published(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class Env:
    """Virtual wall clock plus monotonic clock advanced by the collector's sleeps."""

    def __init__(self, start=START, monotonic_offset=0.0):
        self.clock = start
        self.mono = 0.0
        self.monotonic_offset = monotonic_offset

    def now(self):
        return self.clock

    def monotonic(self):
        return self.monotonic_offset + self.mono

    def sleep(self, seconds):
        self.mono += seconds
        self.clock += timedelta(seconds=seconds)


class FakePVS:
    """Scripted read-only PVS stand-in; measured time follows the virtual clock."""

    def __init__(self, env):
        self.env = env
        self.calls = {"site": 0, "meters": 0, "inverters": 0, "health": 0}
        self.fail = set()
        self.measured_offset = 0.0
        self.panel_ac = 0.42
        self.panel_count = 2
        # Which physical panel answers at each inverter index. None means the
        # index and the panel agree; a PVS restart can shuffle it.
        self.panel_order = None
        self.authenticated = 0
        self.frozen_measured_at = None

    def authenticate(self):
        self.authenticated += 1

    def _measured(self):
        if self.frozen_measured_at is not None:
            return self.frozen_measured_at
        return published(self.env.now() + timedelta(seconds=self.measured_offset))

    def _guard(self, group):
        self.calls[group] += 1
        if group in self.fail:
            raise PVSError(f"pvs {group} read failed: TimeoutError")

    def read_site(self):
        self._guard("site")
        return {
            "/sys/livedata/pv_p": 3.0,
            "/sys/livedata/pv_en": 12345.6,
            "/sys/livedata/site_load_p": 1.2,
            "/sys/livedata/site_load_en": 67890.1,
            "/sys/livedata/net_p": -1.8,
            "/sys/livedata/net_en": -4321.0,
            "/sys/livedata/time": self._measured(),
        }, 40

    def read_meters(self):
        self._guard("meters")
        return {"/sys/devices/meter/0/p3phsumKw": 1.1, "/sys/devices/meter/0/msmtEps": self._measured()}, 45

    def read_inverters(self):
        self._guard("inverters")
        payload = {}
        for index in range(self.panel_count):
            panel = index if self.panel_order is None else self.panel_order[index]
            payload[f"/sys/devices/inverter/{index}/p3phsumKw"] = self.panel_ac
            payload[f"/sys/devices/inverter/{index}/pMppt1Kw"] = self.panel_ac + 0.05
            payload[f"/sys/devices/inverter/{index}/vMppt1V"] = 41.5
            payload[f"/sys/devices/inverter/{index}/iMppt1A"] = 10.8
            payload[f"/sys/devices/inverter/{index}/vln3phavgV"] = 241.2
            payload[f"/sys/devices/inverter/{index}/i3phsumA"] = 1.7
            payload[f"/sys/devices/inverter/{index}/tHtsnkDegc"] = 38.0
            # The counter and the serial belong to the panel, not to the index.
            payload[f"/sys/devices/inverter/{index}/ltea3phsumKwh"] = 500.0 + panel
            payload[f"/sys/devices/inverter/{index}/sn"] = f"SN{panel:03d}"
            payload[f"/sys/devices/inverter/{index}/msmtEps"] = self._measured()
        return payload, 60

    def read_health(self):
        self._guard("health")
        return {"/sys/info/uptime": 100000 + int(self.env.mono), "/sys/info/cpu_usage": 10.0}, 30


class FakeIngest:
    """Records every upload and can be told to fail like a real WAN."""

    def __init__(self):
        self.live = []
        self.batches = []
        self.accepted_ids = []
        self.live_error = None
        self.batch_error = None

    def _raise(self, error):
        if error is not None:
            raise error

    def put_live(self, payload):
        self._raise(self.live_error)
        self.live.append(payload)

    def post_records(self, collector_id, records):
        self._raise(self.batch_error)
        self.batches.append(records)
        ids = [record["record_id"] for record in records]
        self.accepted_ids.extend(ids)
        return ids


class CollectorTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db = Path(self._tmp.name) / "queue.sqlite3"
        self.env = Env()
        self.pvs = FakePVS(self.env)
        self.queue = PendingQueue(self.db)
        self.addCleanup(self.queue.close)
        self.ingest = FakeIngest()

    def collector(self, upload=True, **kwargs):
        kwargs.setdefault("monotonic", self.env.monotonic)
        kwargs.setdefault("sleep", self.env.sleep)
        kwargs.setdefault("now", self.env.now)
        kwargs.setdefault("log", lambda *args: None)
        return Collector(self.pvs, self.queue, self.ingest if upload else None, **kwargs)

    def records(self, kind):
        return [row["payload"] for row in self.queue.batch(1000) if row["kind"] == kind]

    def events(self):
        return [record["event_type"] for record in self.records("collector_event")]

    # -- minute rollup ---------------------------------------------------
    def test_minute_rollup_averages_fresh_samples(self):
        self.collector(upload=False).run(duration=95)
        minutes = self.records("site_minute")
        self.assertEqual(len(minutes), 1)
        minute = minutes[0]
        self.assertEqual(minute["window_start_utc"], published(START.replace(second=0) + timedelta(minutes=1)))
        self.assertEqual(minute["window_end_utc"], published(START.replace(second=0) + timedelta(minutes=2)))
        self.assertEqual(minute["quality"], model.QUALITY_OK)
        self.assertEqual(minute["sample_count"], 6)
        self.assertTrue(minute["complete"])
        self.assertEqual(minute["pv_kw_avg"], 3.0)
        self.assertEqual(minute["load_kw_reported_avg"], 1.2)
        self.assertEqual(minute["grid_kw_avg"], -1.8)
        self.assertIsNone(minute["battery_kw_avg"])
        self.assertEqual(minute["pv_kwh_total_end"], 12345.6)
        self.assertEqual(
            minute["last_measured_at_utc"], published(START.replace(second=0) + timedelta(minutes=1, seconds=50))
        )

    def test_started_partial_minute_is_not_reported(self):
        self.collector(upload=False).run(duration=25)
        self.assertEqual(self.records("site_minute"), [])

    def test_record_ids_are_deterministic(self):
        first = SiteMinute(START.replace(second=0)).record("home-pvs", START)
        second = SiteMinute(START.replace(second=0)).record("home-pvs", START)
        self.assertEqual(first["record_id"], second["record_id"])
        self.assertEqual(first["record_id"], "home-pvs:site_minute:2026-09-18T02:00:00Z")

    def test_source_error_minute_when_every_read_fails(self):
        self.pvs.fail.add("site")
        self.collector(upload=False).run(duration=95)
        minutes = self.records("site_minute")
        self.assertEqual(len(minutes), 1)
        self.assertEqual(minutes[0]["quality"], model.QUALITY_SOURCE_ERROR)
        self.assertEqual(minutes[0]["sample_count"], 0)
        self.assertIsNone(minutes[0]["pv_kw_avg"])
        self.assertIsNone(minutes[0]["last_measured_at_utc"])
        self.assertFalse(minutes[0]["complete"])
        self.assertIn("pvs_request_failed", self.events())
        self.assertEqual(minutes[0]["valid_counts"]["error"], "site:PVSError")
        detail = [record for record in self.records("collector_event") if record["event_type"] == "pvs_request_failed"]
        self.assertEqual(detail[0]["details_code"], "site:PVSError,reason=unknown,stage=read")

    def test_partial_minute_below_the_sample_threshold(self):
        minute = SiteMinute(MINUTE)
        minute.add(model.parse_site({}, MINUTE))
        for offset in (0, 10, 20):
            minute.add(model.parse_site({"/sys/livedata/time": published(MINUTE + timedelta(seconds=offset))}, MINUTE))
        record = minute.record("home-pvs", MINUTE + timedelta(minutes=1))
        self.assertEqual(record["quality"], model.QUALITY_PARTIAL)
        self.assertFalse(record["complete"])
        self.assertEqual(record["valid_count"], 3)

    def test_repeated_measurement_times_are_not_counted_twice(self):
        minute = SiteMinute(MINUTE)
        for _ in range(3):
            minute.add(model.parse_site({"/sys/livedata/time": published(MINUTE)}, MINUTE))
        record = minute.record("home-pvs", MINUTE + timedelta(minutes=1))
        self.assertEqual(record["sample_count"], 3)
        self.assertEqual(record["valid_count"], 1)
        self.assertEqual(record["repeated_count"], 2)
        self.assertEqual(record["quality"], model.QUALITY_PARTIAL)

    def test_unparsable_measurement_time_is_clock_invalid(self):
        minute = SiteMinute(MINUTE)
        minute.add(model.parse_site({"/sys/livedata/time": ""}, MINUTE))
        record = minute.record("home-pvs", MINUTE + timedelta(minutes=1))
        self.assertEqual(record["invalid_count"], 1)
        self.assertEqual(record["quality"], model.QUALITY_CLOCK_INVALID)
        self.assertIsNone(record["pv_kw_avg"])

    # -- panels ----------------------------------------------------------
    def test_equal_power_with_new_measurement_time_is_a_valid_sample(self):
        self.run_panels()
        samples = self.records("panel_sample")
        self.assertEqual(len(samples), 3 * self.pvs.panel_count)
        for sample in samples:
            self.assertEqual(sample["quality"], model.QUALITY_OK)
            self.assertEqual(sample["ac_kw"], 0.42)
            # Diagnostics travel with the sample; they are never backfilled.
            self.assertEqual(sample["dc_kw"], 0.47)
            self.assertEqual(sample["dc_v"], 41.5)
            self.assertEqual(sample["dc_a"], 10.8)
            self.assertEqual(sample["ac_v"], 241.2)
            self.assertEqual(sample["ac_a"], 1.7)
            self.assertEqual(sample["heatsink_c"], 38.0)
        self.assertEqual([sample["panel_id"] for sample in samples], ["p01", "p02"] * 3)
        self.assertEqual(samples[0]["slot_ts"], published(START.replace(second=0)))
        self.assertEqual(samples[-1]["slot_ts"], published(START.replace(second=0) + timedelta(minutes=10)))

    def test_panel_sample_survives_restart_before_next_slot(self):
        self.collector(upload=False).run(duration=1)
        first = self.records("panel_sample")
        self.assertEqual(len(first), self.pvs.panel_count)
        self.assertEqual(self.queue.panel_last_measured("p01"), first[0]["measured_at_utc"])
        self.queue.close()
        self.queue = PendingQueue(self.db)
        self.addCleanup(self.queue.close)
        self.collector(upload=False).run(duration=1)
        self.assertEqual(self.records("panel_sample"), first, "a restart in the same slot does not replace a sent record")
        self.env.sleep(300)
        self.collector(upload=False).run(duration=1)
        self.assertEqual(len(self.records("panel_sample")), 2 * self.pvs.panel_count)

    def test_panel_sample_and_freshness_marker_commit_together(self):
        self.queue.panel_id("0", "SN000")
        with self.assertRaises(KeyError):
            self.queue.enqueue([{
                "record_id": "broken-panel",
                "kind": "panel_sample",
                "slot_ts": published(START),
                "panel_id": "p01",
            }])
        self.assertEqual(self.records("panel_sample"), [], "a failed marker update rolls back the sample")
        self.assertIsNone(self.queue.panel_last_sample_slot("p01"))

    def test_frozen_measurement_times_write_no_placeholder_panel_rows(self):
        """A frozen measurement time is not a reading: one bootstrap row, then a gap."""
        self.pvs.frozen_measured_at = published(START)
        self.run_panels()
        samples = self.records("panel_sample")
        self.assertEqual(len(samples), self.pvs.panel_count)  # first sighting only
        self.assertEqual({sample["slot_ts"] for sample in samples}, {published(START.replace(second=0))})

    def test_panel_ids_stay_stable_across_restart(self):
        self.run_panels()
        self.assertTrue(self.records("panel_sample"))
        self.queue.close()
        self.queue = PendingQueue(self.db)
        self.addCleanup(self.queue.close)
        self.assertEqual(self.queue.panel_id("0"), "p01")
        self.assertEqual(self.queue.panel_id("1"), "p02")

    def test_panel_ids_follow_the_serial_when_the_pvs_renumbers(self):
        """A PVS restart renumbers every index; identity has to come from the serial."""
        self.run_panels()
        first = {(sample["panel_id"]): sample["energy_kwh_total"] for sample in self.records("panel_sample")}
        self.assertEqual(first, {"p01": 500.0, "p02": 501.0})
        # The same two devices answer in the opposite order, as after a restart.
        self.pvs.panel_order = [1, 0]
        self.run_panels()
        samples = self.records("panel_sample")
        by_panel = {}
        for sample in samples:
            by_panel.setdefault(sample["panel_id"], []).append(sample["energy_kwh_total"])
        # Each panel id kept its own counter: nothing moved between panels.
        self.assertEqual({panel: sorted(set(values)) for panel, values in by_panel.items()}, {"p01": [500.0], "p02": [501.0]})
        self.assertIn("panel_identity_changed", self.events())

    def test_an_index_keyed_database_upgrades_without_renumbering(self):
        """An existing installation keeps its ids: its serials bind to them once."""
        queue = PendingQueue(self.db)
        self.assertEqual(queue.panel_id("0", "SN000"), "p01")
        queue.close()
        # Rewrite panel_map into the shape the previous release shipped.
        raw = sqlite3.connect(self.db)
        raw.executescript(
            "DROP TABLE panel_map;"
            "CREATE TABLE panel_map (inverter_index TEXT PRIMARY KEY, panel_id TEXT NOT NULL UNIQUE, last_measured_at_utc TEXT);"
            "INSERT INTO panel_map VALUES ('0', 'p01', '2026-09-18T02:00:00Z');"
        )
        raw.commit()
        raw.close()
        upgraded = PendingQueue(self.db)
        self.addCleanup(upgraded.close)
        self.assertEqual(upgraded.panel_id("0", "SN000"), "p01", "the index's panel id is adopted, so history keeps its panel")
        self.assertEqual(upgraded.panel_last_measured("p01"), "2026-09-18T02:00:00Z")
        self.assertEqual(upgraded.panel_id("7", "SN000"), "p01", "and it follows that serial from then on")
        self.assertEqual(upgraded.panel_last_measured("p01"), "2026-09-18T02:00:00Z", "freshness state follows the panel, not the index")

    def test_a_shrinking_inverter_reply_is_named(self):
        """A partial PVS reply must not read as a smaller array on every page."""
        self.pvs.panel_count = 3
        shrink_after_first_read = self.pvs.read_inverters
        reads = []

        def read_inverters():
            reads.append(1)
            if len(reads) > 1:
                self.pvs.panel_count = 1
            return shrink_after_first_read()

        self.pvs.read_inverters = read_inverters
        self.collector(upload=False).run(duration=700)
        events = [
            record["details_code"]
            for record in self.records("collector_event")
            if record["event_type"] == "panel_count_changed"
        ]
        self.assertEqual(events, ["3->1"], "one event per change, not one per read")

    def run_panels(self):
        return self.collector(upload=False).run(duration=700)

    # -- queue and replay ------------------------------------------------
    def test_enqueue_is_idempotent_and_survives_restart(self):
        record = SiteMinute(START).record("home-pvs", START + timedelta(minutes=1))
        self.assertEqual(self.queue.enqueue([record]), 1)
        self.assertEqual(self.queue.enqueue([record]), 0)
        self.queue.close()
        reopened = PendingQueue(self.db)
        rows = reopened.batch()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["payload"], record)
        reopened.ack([record["record_id"]])
        reopened.close()
        final = PendingQueue(self.db)
        self.addCleanup(final.close)
        self.assertEqual(final.counts()["pending"], 0)

    def test_queue_holds_at_least_a_week_of_offline_minutes(self):
        records = [SiteMinute(START).record("home-pvs", START + timedelta(minutes=n)) for n in range(1440)]
        self.queue.enqueue(records)
        per_day = self.queue.bytes_on_disk() / (1440 * 60)
        self.assertLess(per_day * 7 * 60, 32 * 1024 * 1024)

    def test_wan_loss_queues_then_replays_identical_records(self):
        self.ingest.batch_error = RetryableError("network down")
        self.collector().run(duration=125)
        pending_before = self.queue.batch(1000)
        self.assertGreaterEqual(len(pending_before), 1)
        self.assertIn("site_minute", [row["kind"] for row in pending_before])
        self.assertIn("wan_upload_failed", self.events())

        self.ingest.batch_error = None
        self.collector().run(duration=125)
        replayed = len(pending_before)
        self.assertEqual(self.ingest.accepted_ids[:replayed], [row["record_id"] for row in pending_before])
        self.assertEqual(self.ingest.batches[0][:replayed], [row["payload"] for row in pending_before])
        self.assertEqual(self.queue.counts()["pending"], 0)
        uploaded = [
            record["event_type"]
            for batch in self.ingest.batches
            for record in batch
            if record["kind"] == "collector_event"
        ]
        self.assertIn("wan_recovered", uploaded)

    def test_rejected_records_are_isolated_not_retried_forever(self):
        record = SiteMinute(START).record("home-pvs", START + timedelta(minutes=1))
        self.queue.enqueue([record])
        self.ingest.batch_error = RejectedError([record["record_id"]], "conflict")
        self.collector().run(duration=15)
        self.assertNotIn(record["record_id"], [row["record_id"] for row in self.queue.batch(1000)])
        self.assertGreaterEqual(self.queue.counts()["failed"], 1)
        self.assertIn("record_rejected", self.events())

    def test_authentication_failure_stops_uploading_and_keeps_collecting(self):
        record = SiteMinute(START).record("home-pvs", START + timedelta(minutes=1))
        self.queue.enqueue([record])
        self.ingest.batch_error = AuthError("token rejected")
        collector = self.collector()
        collector.run(duration=65)
        self.assertIsNone(collector.upload)
        self.assertGreater(self.pvs.calls["meters"], 1)
        self.assertEqual(self.ingest.accepted_ids, [])
        self.assertIn(record["record_id"], [row["record_id"] for row in self.queue.batch(1000)])
        self.assertIn("wan_upload_failed", self.events())

    def test_live_snapshots_are_not_queued_for_replay(self):
        self.ingest.live_error = RetryableError("network down")
        self.collector().run(duration=110)
        self.assertEqual(self.ingest.live, [])
        self.assertNotIn("live", [row["kind"] for row in self.queue.batch(1000)])
        self.assertIn("wan_upload_failed", self.events())

    def test_live_upload_is_not_waiting_on_a_closed_minute(self):
        self.collector().run(duration=25)
        self.assertGreaterEqual(len(self.ingest.live), 2)
        self.assertEqual(self.records("site_minute"), [])

    def test_backoff_after_three_failures_pauses_only_that_group(self):
        self.pvs.fail.add("site")
        self.collector(upload=False).run(duration=65)
        self.assertEqual(self.pvs.calls["site"], 3)
        self.assertGreater(self.pvs.calls["meters"], 1)

    def test_a_failing_group_retries_every_minute_without_escalating(self):
        """One attempt a minute: the pause never grows past the first minute."""
        self.pvs.fail.add("site")
        collector = self.collector(upload=False)
        logs = []
        collector._log = lambda line: logs.append(json.loads(line))
        collector.run(duration=700)
        cooldowns = [entry["seconds"] for entry in logs if entry.get("event") == "cooldown"]
        self.assertTrue(cooldowns, "a failing group records its pause")
        self.assertEqual(set(cooldowns), {60.0}, "the pause stays at one minute")
        self.assertGreaterEqual(self.pvs.calls["site"], 6, "and the group keeps probing")
        # The healthy groups were never paused.
        self.assertNotIn("meters", [entry.get("group") for entry in logs if entry.get("event") == "cooldown"])

    def test_failed_groups_keep_cooldown_until_recovery(self):
        collector = self.collector(upload=False)
        self.pvs.fail = set(self.pvs.calls)
        attempts = {group: [] for group in self.pvs.calls}
        guard = self.pvs._guard

        def record_attempt(group):
            attempts[group].append(self.env.monotonic())
            guard(group)

        self.pvs._guard = record_attempt
        collector.run(duration=1500)
        for group, times in attempts.items():
            with self.subTest(group=group):
                self.assertGreater(len(times), 4)
                self.assertEqual(set(b - a for a, b in zip(times[2:], times[3:])), {60.0})
        self.pvs.fail.clear()
        collector.run(duration=200)
        self.assertEqual(attempts["site"][-1] - attempts["site"][-2], 10.0)
        self.assertEqual(attempts["meters"][-1] - attempts["meters"][-2], 30.0)

    def test_heartbeat_marks_old_health_and_panel_values_as_stale(self):
        collector = self.collector(upload=False)
        collector._read_group("health")
        collector._read_group("inverters")
        self.env.sleep(3600)
        self.pvs.fail.update({"health", "inverters"})
        collector._read_group("health")
        collector._read_group("inverters")
        collector._heartbeat()
        beat = [r for r in self.records("collector_event") if r["event_type"] == "collector_heartbeat"][-1]
        for field in ("uptime=null", "cpu_pct=null", "panels_fresh=0", "health_age_s=3600", "panels_age_s=3600"):
            self.assertIn(field, beat["details_code"])

    def test_health_observation_survives_failed_reauthentication(self):
        collector = self.collector(upload=False)
        collector._read_group("health")
        self.env.sleep(7200)
        self.pvs.read_health = lambda: ({"/sys/info/uptime": 7199, "/sys/info/cpu_usage": 5}, 30)

        def authenticate():
            self.env.sleep(7)
            raise PVSError("private auth detail")

        self.pvs.authenticate = authenticate
        logs = []
        collector._log = lambda line: logs.append(json.loads(line))
        observed_at = self.env.now()
        collector._read_group("health")
        health = next(r for r in logs if r["event"] == "health_read")
        self.assertEqual(health["ts"], published(observed_at))
        self.assertNotIn("private", json.dumps(logs))
        self.pvs.read_health = lambda: ({"/sys/info/uptime": 7206}, 30)
        collector._read_group("health")
        self.assertEqual(self.events().count("pvs_restarted"), 1)

    def test_reboot_with_larger_uptime_uses_monotonic_time_after_missing_read(self):
        collector = self.collector(upload=False)
        self.pvs.read_health = lambda: ({"/sys/info/uptime": 3600}, 30)
        collector._read_group("health")
        self.env.sleep(3600)
        self.pvs.read_health = lambda: ({}, 30)
        collector._read_group("health")
        self.env.sleep(3600)
        self.env.clock += timedelta(hours=5)
        self.pvs.read_health = lambda: ({"/sys/info/uptime": 7199}, 30)
        collector._read_group("health")
        self.assertIn("pvs_restarted", self.events())
        self.assertEqual(self.pvs.authenticated, 1)

    def test_invalid_health_uptime_cannot_overflow_boot_timestamp(self):
        collector = self.collector(upload=False)
        for uptime in (-1, 1e308):
            self.pvs.read_health = lambda: ({"/sys/info/uptime": uptime}, 30)
            collector._read_group("health")
            self.assertIsNone(collector._health["uptime"])
            self.assertIsNone(collector._uptime_observation)

    def test_heartbeat_expires_values_even_before_a_failed_read(self):
        collector = self.collector(upload=False)
        collector._read_group("health")
        collector._read_group("inverters")
        self.env.sleep(601)
        collector._heartbeat()
        beat = [r for r in self.records("collector_event") if r["event_type"] == "collector_heartbeat"][-1]
        self.assertIn("uptime=null", beat["details_code"])
        self.assertIn("panels_fresh=0", beat["details_code"])

    def test_collector_logs_safe_structured_failure_without_exception_text(self):
        collector = self.collector(upload=False)
        logs = []
        collector._log = lambda line: logs.append(json.loads(line))

        def fail():
            raise PVSError("private cookie and response", reason="http", stage="auth", http_status=403, latency_ms=20)

        self.pvs.read_site = fail
        collector._read_group("site")
        failed = next(r for r in logs if r["event"] == "read_failed")
        self.assertEqual((failed["reason"], failed["stage"], failed["http_status"], failed["latency_ms"]), ("http", "auth", 403, 20))
        self.assertNotIn("private", json.dumps(logs))

    def test_recovery_emits_one_event_per_group(self):
        self.pvs.fail.add("meters")
        collector = self.collector(upload=False)
        collector.run(duration=35)
        self.pvs.fail.clear()
        collector.run(duration=35)
        events = self.events()
        self.assertEqual(events.count("pvs_request_failed"), 1)
        self.assertEqual(events.count("pvs_recovered"), 1)

    def test_heartbeat_reports_liveness_every_hour(self):
        self.collector(upload=False).run(duration=3700)
        beats = [record for record in self.records("collector_event") if record["event_type"] == "collector_heartbeat"]
        self.assertEqual(len(beats), 2)  # one at startup plus one hour
        details = beats[-1]["details_code"]
        for field in ("uptime=", "cpu_pct=", "flash_pct=", "queue_pending=", "site_age_s=", "panels_fresh=2"):
            self.assertIn(field, details)

    def test_boot_relative_monotonic_clock_keeps_the_schedule(self):
        """The Pi's monotonic clock starts at boot, so due times need the offset."""
        self.env = Env(monotonic_offset=9_000_000.0)
        self.pvs = FakePVS(self.env)
        self.collector(upload=False).run(duration=95)
        minutes = self.records("site_minute")
        self.assertEqual(len(minutes), 1)
        self.assertEqual(minutes[0]["sample_count"], 6)  # no reads pulled in early
        beats = [record for record in self.records("collector_event") if record["event_type"] == "collector_heartbeat"]
        self.assertEqual(len(beats), 1)
        self.assertIn("site_age_s=0", beats[0]["details_code"])


class UploaderTests(unittest.TestCase):
    def client(self, handler):
        return IngestClient("https://ingest.test", "synthetic-token", opener=_Opener(handler))

    def test_success_returns_accepted_ids(self):
        client = self.client(lambda method, path, body, headers: (200, {"accepted_ids": ["a"]}))
        self.assertEqual(client.post_records("home-pvs", [{"record_id": "a"}]), ["a"])

    def test_live_overwrite_accepts_204(self):
        self.client(lambda method, path, body, headers: (204, None)).put_live({"collector_id": "home-pvs"})

    def test_conflict_is_rejected_with_the_conflicting_ids(self):
        client = self.client(lambda method, path, body, headers: (409, {"conflicting_ids": ["b"]}))
        with self.assertRaises(RejectedError) as raised:
            client.post_records("home-pvs", [{"record_id": "a"}, {"record_id": "b"}])
        self.assertEqual(raised.exception.record_ids, ["b"])

    def test_bad_request_without_detail_isolates_the_whole_batch(self):
        client = self.client(lambda method, path, body, headers: (400, {"error": "schema"}))
        with self.assertRaises(RejectedError) as raised:
            client.post_records("home-pvs", [{"record_id": "a"}])
        self.assertEqual(raised.exception.record_ids, ["a"])

    def test_401_stops_with_an_auth_error(self):
        client = self.client(lambda method, path, body, headers: (401, None))
        with self.assertRaises(AuthError):
            client.put_live({})

    def test_server_errors_are_retryable(self):
        for status in (429, 500, 503):
            client = self.client(lambda method, path, body, headers, status=status: (status, None))
            with self.assertRaises(RetryableError):
                client.post_records("home-pvs", [{"record_id": "a"}])

    def test_network_errors_are_retryable(self):
        client = self.client(_raise_urlerror)
        with self.assertRaises(RetryableError):
            client.put_live({})

    def test_token_is_sent_as_a_bearer_header(self):
        seen = {}

        def handler(method, path, body, headers):
            seen.update(headers)
            return 204, None

        self.client(handler).put_live({})
        self.assertEqual(seen.get("authorization"), "Bearer synthetic-token")
        self.assertEqual(seen.get("user-agent"), "sunpower-monitor-collector/0.1")


class StartupTests(unittest.TestCase):
    def test_startup_waits_for_the_pvs_instead_of_crash_looping(self):
        attempts = []
        delays = []

        class Flaky:
            def __init__(self, host):
                attempts.append(host)
                if len(attempts) < 3:
                    raise PVSError("no route to host")

        client = connect_pvs("pvs.invalid", log=lambda *args: None, sleep=delays.append, client=Flaky)
        self.assertIsInstance(client, Flaky)
        self.assertEqual(delays, [10.0, 20.0])

    def test_duration_limits_startup_retries(self):
        env = Env()
        attempts = []

        class Down:
            def __init__(self, host):
                attempts.append(host)
                raise PVSError("unavailable")

        client = connect_pvs("pvs.invalid", log=lambda *args: None, sleep=env.sleep,
                             client=Down, deadline=env.monotonic() + 25, monotonic=env.monotonic)
        self.assertIsNone(client)
        self.assertEqual(env.mono, 25)
        self.assertEqual(len(attempts), 2)

    def test_sigterm_closes_queue_during_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.sqlite3"
            process = subprocess.Popen(
                [sys.executable, "-m", "collector.main", "--host", "127.0.0.1:1", "--db", str(queue)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                self.assertTrue(select.select([process.stdout], [], [], 5)[0], "collector did not enter startup retry")
                self.assertIn("pvs_unavailable", process.stdout.readline())
                process.terminate()
                output, errors = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 0, errors)
                self.assertIn("interrupted", output)
                with sqlite3.connect(queue) as db:
                    self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


class IngestSmokeTests(unittest.TestCase):
    """End to end over a real socket: collector -> HTTP -> queue drain."""

    def test_minute_history_reaches_the_endpoint_and_is_acknowledged(self):
        received = {"live": 0, "records": [], "tokens": set()}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def _payload(self):
                length = int(self.headers.get("Content-Length") or 0)
                received["tokens"].add(self.headers.get("Authorization"))
                return json.loads(self.rfile.read(length) or b"{}")

            def do_PUT(self):
                self._payload()
                received["live"] += 1
                self.send_response(204)
                self.end_headers()

            def do_POST(self):
                payload = self._payload()
                received["records"].extend(payload["records"])
                body = json.dumps({"accepted_ids": [r["record_id"] for r in payload["records"]]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        with tempfile.TemporaryDirectory() as tmp:
            env = Env()
            queue = PendingQueue(Path(tmp) / "queue.sqlite3")
            upload = IngestClient(f"http://127.0.0.1:{server.server_port}", "synthetic-token", timeout=5)
            collector = Collector(
                FakePVS(env),
                queue,
                upload,
                collector_id="smoke-pvs",
                monotonic=env.monotonic,
                sleep=env.sleep,
                now=env.now,
                log=lambda *args: None,
            )
            collector.run(duration=130)

            minutes = [record for record in received["records"] if record["kind"] == "site_minute"]
            self.assertEqual(len(minutes), 1)
            self.assertEqual(minutes[0]["collector_id"], "smoke-pvs")
            self.assertEqual(minutes[0]["window_start_utc"], published(MINUTE + timedelta(minutes=1)))
            self.assertEqual(minutes[0]["quality"], model.QUALITY_OK)
            self.assertEqual(minutes[0]["sample_count"], 6)
            self.assertGreaterEqual(received["live"], 2)
            self.assertEqual(queue.counts()["pending"], 0)
            self.assertEqual(received["tokens"], {"Bearer synthetic-token"})
            ids = [record["record_id"] for record in received["records"]]
            self.assertEqual(len(ids), len(set(ids)))
            queue.close()


def _raise_urlerror(method, path, body, headers):
    raise urllib.error.URLError("no network")


class _Opener:
    def __init__(self, handler):
        self.handler = handler

    def open(self, request, timeout=None):
        body = json.loads(request.data) if request.data else None
        headers = {key.lower(): value for key, value in request.header_items()}
        status, payload = self.handler(request.get_method(), urlsplit(request.full_url).path, body, headers)
        if status >= 400:
            detail = json.dumps(payload).encode() if payload else b""
            raise urllib.error.HTTPError(request.full_url, status, "error", None, io.BytesIO(detail))
        return _Response(status, payload)


class _Response:
    def __init__(self, status, payload):
        self.status = status
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    unittest.main()
