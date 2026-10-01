#!/usr/bin/env python3
"""Read-only PVS6 cadence and health pilot. Logs metadata, never power values."""

import argparse
import base64
import http.cookiejar
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


INTERVALS = {"livedata": 10, "meter": 30, "inverter": 300, "info": 300}
FIELDS = {"livedata": ("pv_p", "site_load_p", "net_p"), "meter": ("p3phsumKw",), "inverter": ("p3phsumKw",)}


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def summarize(group, data, previous):
    if group == "info":
        return {
            "uptime": data.get("/sys/info/uptime"),
            "cpu_pct": data.get("/sys/info/cpu_usage"),
            "flash_pct": data.get("/sys/info/flash_usage"),
        }, {}
    if group == "livedata":
        values = tuple(data.get(f"/sys/livedata/{field}") for field in FIELDS[group])
        result = {
            "pvs_time": data.get("/sys/livedata/time"),
            "power_changed": values != previous.get("values") if previous else None,
            "field_count": len(data),
        }
        return result, {"values": values}
    devices = {}
    for path, value in data.items():
        parts = path.split("/")
        if len(parts) == 6 and parts[3] == group and parts[5] in ("msmtEps", *FIELDS[group]):
            devices.setdefault(parts[4], {})[parts[5]] = value
    result = {
        "device_count": len(devices),
        "measurement_time_changed": sum(
            fields.get("msmtEps") != previous.get("devices", {}).get(idx, {}).get("msmtEps")
            for idx, fields in devices.items()
        ) if previous else None,
        "power_changed": sum(
            fields.get("p3phsumKw") != previous.get("devices", {}).get(idx, {}).get("p3phsumKw")
            for idx, fields in devices.items()
        ) if previous else None,
    }
    return result, {"devices": devices}


class PVS:
    def __init__(self, host):
        self.base = f"https://{host}"
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
        )
        self.last_request = 0.0
        self.cached = set()
        self.login()

    def get(self, path, headers=None):
        gap = 3 - (time.monotonic() - self.last_request)
        if gap > 0:
            time.sleep(gap)
        start = time.monotonic()
        try:
            with self.opener.open(
                urllib.request.Request(self.base + path, headers=headers or {}), timeout=8
            ) as response:
                return json.load(response), round((time.monotonic() - start) * 1000)
        finally:
            self.last_request = time.monotonic()

    def login(self):
        public, _ = self.get("/vars?name=/sys/info/serialnum&fmt=obj")
        serial = public.get("/sys/info/serialnum")
        if not isinstance(serial, str) or len(serial) < 5:
            raise RuntimeError("PVS serial not available through targeted read")
        auth = base64.b64encode(("ssm_owner:" + serial[-5:]).encode()).decode()
        self.get("/auth?login", {"Authorization": "Basic " + auth})
        self.cached.clear()

    def read(self, group):
        data, latency = self._read_once(group)
        if isinstance(data, dict) and "errorcode" in data:
            self.login()
            data, latency = self._read_once(group, retry=False)
        if not isinstance(data, dict) or "errorcode" in data:
            raise RuntimeError("PVS returned an error response")
        return data, latency

    def _read_once(self, group, retry=True):
        if group == "info":
            path = "/vars?name=/sys/info/uptime,/sys/info/cpu_usage,/sys/info/flash_usage&fmt=obj"
        elif group in self.cached:
            path = f"/vars?fmt=obj&cache=pilot_{group}"
        else:
            path = f"/vars?match={group}&fmt=obj&cache=pilot_{group}"
        try:
            data, latency = self.get(path)
        except urllib.error.HTTPError as exc:
            if exc.code != 401 or not retry:
                raise
            self.login()
            return self._read_once(group, retry=False)
        if group != "info":
            self.cached.add(group)
        return data, latency


def run(host, output, duration):
    pvs = PVS(host)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    due = {group: time.monotonic() for group in INTERVALS}
    previous = {}
    failures = {group: 0 for group in INTERVALS}
    deadline = time.time() + duration
    with os.fdopen(fd, "a", encoding="utf-8") as log:
        next_flush = time.monotonic() + 60
        print(f"pilot_started={now_utc()} output={output}", flush=True)
        while time.time() < deadline:
            group = min(due, key=due.get)
            wait = due[group] - time.monotonic()
            if wait > 0:
                time.sleep(min(wait, max(0, deadline - time.time())))
            if time.time() >= deadline:
                break
            row = {"ts": now_utc(), "group": group}
            try:
                data, latency = pvs.read(group)
                details, previous[group] = summarize(group, data, previous.get(group, {}))
                row.update({"ok": True, "latency_ms": latency, **details})
                failures[group] = 0
            except (OSError, ValueError, RuntimeError, urllib.error.URLError) as exc:
                row.update({"ok": False, "error": type(exc).__name__})
                if isinstance(exc, urllib.error.HTTPError):
                    row["http_status"] = exc.code
                failures[group] += 1
            log.write(json.dumps(row, separators=(",", ":")) + "\n")
            due[group] = time.monotonic() + INTERVALS[group]
            if failures[group] >= 3:
                log.write(json.dumps({"ts": now_utc(), "group": "cooldown", "seconds": 900}) + "\n")
                log.flush()
                time.sleep(min(900, max(0, deadline - time.time())))
                failures[group] = 0
            if time.monotonic() >= next_flush:
                log.flush()
                next_flush = time.monotonic() + 60
        print(f"pilot_finished={now_utc()} output={output}", flush=True)


def self_test():
    first = {"/sys/devices/meter/0/msmtEps": "a", "/sys/devices/meter/0/p3phsumKw": "1"}
    second = {"/sys/devices/meter/0/msmtEps": "b", "/sys/devices/meter/0/p3phsumKw": "2"}
    result, prior = summarize("meter", first, {})
    assert result["device_count"] == 1
    result, _ = summarize("meter", second, prior)
    assert result["measurement_time_changed"] == result["power_changed"] == 1
    assert "2" not in json.dumps(result)
    print("self_test_passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("PVS_HOST"), help="PVS LAN address (or set PVS_HOST)")
    parser.add_argument("--duration", type=int, default=86400, help="Seconds to run")
    parser.add_argument("--output", type=Path, default=Path("pilot-data/cadence.jsonl"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if not args.host:
            parser.error("--host is required unless PVS_HOST is set")
        run(args.host, args.output, args.duration)
