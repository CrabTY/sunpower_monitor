"""Adapter tests: authentication, focused queries, parsing, and quality."""

import base64
import errno
import http.cookiejar
import http.server
import io
import json
import unittest
import threading
import urllib.error
import urllib.request
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from collector import model
from collector.main import check_reads
from collector.pvs import PVSAuthError, PVSClient, PVSError, _build_opener

SERIAL = "ZS99000042"  # synthetic, not a real device
BASE = datetime(2026, 9, 18, 2, 0, tzinfo=timezone.utc)
HOST = "pvs.local"
EPOCH = 1758160800


def published(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def livedata(seconds=0, pv=3.0, load=1.2, net=-1.8):
    return {
        "/sys/livedata/pv_p": pv,
        "/sys/livedata/pv_en": "12345.6",
        "/sys/livedata/site_load_p": load,
        "/sys/livedata/site_load_en": "67890.1",
        "/sys/livedata/net_p": net,
        "/sys/livedata/net_en": "-4321.0",
        "/sys/livedata/time": published(BASE + timedelta(seconds=seconds)),
    }


def inverter(index, ac=0.4, dc=0.45, measured=0):
    return {
        f"/sys/devices/inverter/{index}/p3phsumKw": ac,
        f"/sys/devices/inverter/{index}/pMppt1Kw": dc,
        f"/sys/devices/inverter/{index}/vMppt1V": 41.5,
        f"/sys/devices/inverter/{index}/iMppt1A": 10.8,
        f"/sys/devices/inverter/{index}/vln3phavgV": 241.2,
        f"/sys/devices/inverter/{index}/i3phsumA": 1.7,
        f"/sys/devices/inverter/{index}/tHtsnkDegc": 38.0,
        f"/sys/devices/inverter/{index}/ltea3phsumKwh": 1234.5,
        f"/sys/devices/inverter/{index}/msmtEps": published(BASE + timedelta(seconds=measured)),
        f"/sys/devices/inverter/{index}/serialnum": "must-not-be-read",
    }


class Response:
    def __init__(self, payload, status=200):
        self.status = status
        self._body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    """Minimal stand-in for urllib's opener; records every requested path."""

    def __init__(self, table):
        self.routes = table
        self.requests = []
        self.sleeps = []

    def open(self, request, timeout=None):
        parts = urlsplit(request.full_url)
        path = parts.path + "?" + parts.query
        self.requests.append((path, {key.lower(): value for key, value in request.header_items()}))
        route = self.routes.get(path)
        if route is None:
            raise urllib.error.HTTPError(request.full_url, 404, "not found", None, io.BytesIO(b""))
        if isinstance(route, list):
            route = route.pop(0) if len(route) > 1 else route[0]
        if isinstance(route, Exception):
            raise route
        return Response(route)


def http_error(status, payload=b""):
    return urllib.error.HTTPError(f"https://{HOST}/x", status, "error", None, io.BytesIO(payload))


def routes(**overrides):
    table = {
        "/vars?name=/sys/info/serialnum&fmt=obj": {"/sys/info/serialnum": SERIAL},
        "/auth?login": {},
        "/vars?match=livedata&fmt=obj&cache=ldata": livedata(),
        "/vars?fmt=obj&cache=ldata": livedata(seconds=10),
        "/vars?match=meter&fmt=obj&cache=mdata": {"/sys/devices/meter/0/p3phsumKw": 1.1},
        "/vars?fmt=obj&cache=mdata": {"/sys/devices/meter/0/p3phsumKw": 1.1},
        "/vars?match=inverter&fmt=obj&cache=idata": {**inverter("0"), **inverter("1")},
        "/vars?fmt=obj&cache=idata": {**inverter("0"), **inverter("1")},
        "/vars?name=/sys/info/uptime,/sys/info/cpu_usage,/sys/info/flash_usage&fmt=obj": {
            "/sys/info/uptime": 123456,
            "/sys/info/cpu_usage": 12.5,
            "/sys/info/flash_usage": 41.0,
        },
    }
    table.update(overrides)
    return table


class Clock:
    """Virtual monotonic clock so adapter tests never sleep in real time."""

    def __init__(self):
        self.value = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds


def make_client(table):
    opener = FakeOpener(table)
    clock = Clock()
    pvs = PVSClient(HOST, opener=opener, sleep=clock.sleep, monotonic=clock.monotonic, min_gap=3.0)
    return pvs, opener, clock


def client(**overrides):
    pvs, opener, _ = make_client(routes(**overrides))
    return pvs, opener


class AuthenticationTests(unittest.TestCase):
    def test_authenticates_with_focused_serial_read(self):
        _, opener = client()
        paths = [path for path, _ in opener.requests]
        self.assertEqual(paths[0], "/vars?name=/sys/info/serialnum&fmt=obj")
        self.assertEqual(paths[1], "/auth?login")
        expected = base64.b64encode(f"ssm_owner:{SERIAL[-5:]}".encode()).decode()
        self.assertEqual(opener.requests[1][1]["authorization"], f"Basic {expected}")

    def test_every_read_names_its_group(self):
        """A cache-only read can serve a partial variable set, so it is never used."""
        pvs, opener = client()
        pvs.read_site()
        pvs.read_site()
        requested = [path for path, _ in opener.requests]
        self.assertEqual(requested.count("/vars?match=livedata&fmt=obj&cache=ldata"), 2)
        self.assertNotIn("/vars?fmt=obj&cache=ldata", requested)

    def test_authenticate_discards_a_stale_session_cookie(self):
        """A stale cookie gets 401 on every request, so re-login must drop it."""
        pvs, _, _ = make_client(routes())
        pvs._cookies.set_cookie(
            http.cookiejar.Cookie(
                version=0,
                name="session",
                value="stale",
                port=None,
                port_specified=False,
                domain=HOST,
                domain_specified=True,
                domain_initial_dot=False,
                path="/",
                path_specified=True,
                secure=True,
                expires=None,
                discard=False,
                comment=None,
                comment_url=None,
                rest={},
                rfc2109=False,
            )
        )
        pvs.authenticate()
        self.assertEqual(list(pvs._cookies), [])

    def test_the_real_opener_keeps_the_jar_the_client_clears(self):
        """Clearing a jar the opener does not use leaves the stale cookie in place."""
        jar = http.cookiejar.CookieJar()
        opener = _build_opener(jar)
        processor = next(
            handler for handler in opener.handlers if isinstance(handler, urllib.request.HTTPCookieProcessor)
        )
        self.assertIs(processor.cookiejar, jar)

    def test_never_requests_the_full_tree_or_a_write_path(self):
        pvs, opener = client()
        pvs.read_site()
        pvs.read_meters()
        pvs.read_inverters()
        pvs.read_health()
        for path, _ in opener.requests:
            self.assertNotIn("match=/", path)
            self.assertNotIn("set=", path)
            self.assertNotIn("devices/list", path)

    def test_requests_are_spaced_by_the_minimum_gap(self):
        pvs, opener, clock = make_client(routes())
        pvs.read_meters()
        self.assertTrue(opener.requests)
        self.assertTrue(clock.sleeps)
        self.assertTrue(all(gap == 3.0 for gap in clock.sleeps))

    def test_http_401_reauthenticates_once_and_retries(self):
        table = routes()
        table["/vars?match=livedata&fmt=obj&cache=ldata"] = [http_error(401), livedata()]
        pvs, opener, _ = make_client(table)
        data, _ = pvs.read_site()
        self.assertEqual(data["/sys/livedata/pv_p"], 3.0)
        self.assertEqual(sum(1 for path, _ in opener.requests if path == "/auth?login"), 2)

    def test_repeated_401_is_reported_after_one_retry(self):
        table = routes()
        table["/vars?match=livedata&fmt=obj&cache=ldata"] = http_error(403)
        table["/vars?fmt=obj&cache=ldata"] = http_error(403)
        pvs, opener, _ = make_client(table)
        with self.assertRaises(PVSError):
            pvs.read_site()
        attempts = [path for path, _ in opener.requests if "cache=ldata" in path]
        self.assertEqual(len(attempts), 2)
        self.assertTrue(issubclass(PVSAuthError, PVSError))

    def test_errorcode_response_reauthenticates_once(self):
        table = routes()
        table["/vars?match=meter&fmt=obj&cache=mdata"] = [{"errorcode": 1}, {"/sys/devices/meter/0/p3phsumKw": 0.9}]
        pvs, opener, _ = make_client(table)
        data, _ = pvs.read_meters()
        self.assertEqual(data["/sys/devices/meter/0/p3phsumKw"], 0.9)

    def test_persistent_errorcode_is_a_read_failure(self):
        table = routes()
        table["/vars?match=meter&fmt=obj&cache=mdata"] = {"errorcode": 3}
        pvs, opener, _ = make_client(table)
        with self.assertRaises(PVSError):
            pvs.read_meters()

    def test_missing_serial_is_an_authentication_failure(self):
        opener = FakeOpener(routes(**{"/vars?name=/sys/info/serialnum&fmt=obj": {}}))
        clock = Clock()
        with self.assertRaises(PVSError):
            PVSClient(HOST, opener=opener, sleep=clock.sleep, monotonic=clock.monotonic)

    def test_transport_errors_do_not_leak_the_request(self):
        pvs, opener, _ = make_client(routes())
        opener.routes["/vars?match=meter&fmt=obj&cache=mdata"] = urllib.error.URLError("boom")
        with self.assertRaises(PVSError) as raised:
            pvs.read_meters()
        self.assertNotIn("boom", str(raised.exception))

    def test_malformed_json_is_a_read_failure(self):
        pvs, _, _ = make_client(routes(**{"/vars?match=meter&fmt=obj&cache=mdata": b"<html>nope</html>"}))
        with self.assertRaises(PVSError):
            pvs.read_meters()

    def test_safe_failure_diagnostics_distinguish_http_transport_and_json(self):
        cases = [
            (http_error(400, b"private response"), "http", {"http_status": 400}),
            (TimeoutError("private timeout"), "timeout", {}),
            (urllib.error.URLError(OSError(errno.EHOSTUNREACH, "private route")), "transport", {"errno": errno.EHOSTUNREACH}),
            (b"private non-JSON response", "invalid_json", {}),
        ]
        for response, reason, expected in cases:
            with self.subTest(reason=reason):
                pvs, opener, _ = make_client(routes())
                opener.routes["/vars?match=meter&fmt=obj&cache=mdata"] = response
                with self.assertRaises(PVSError) as caught:
                    pvs.read_meters()
                details = caught.exception.diagnostics
                self.assertEqual(details["reason"], reason)
                self.assertEqual(details["stage"], "read")
                self.assertGreaterEqual(details["latency_ms"], 0)
                for key, value in expected.items():
                    self.assertEqual(details[key], value)
                self.assertNotIn("private", json.dumps(details))

    def test_login_failure_retains_safe_auth_diagnostics(self):
        with self.assertRaises(PVSError) as caught:
            make_client(routes(**{"/auth?login": http_error(403)}))
        self.assertEqual(caught.exception.diagnostics["stage"], "auth")
        self.assertEqual(caught.exception.diagnostics["http_status"], 403)


class CompatibilityTests(unittest.TestCase):
    def test_real_http_cookie_session_recovers_after_expiry(self):
        seen = []
        session = [0]

        class Gateway(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                cookie = self.headers.get("Cookie")
                seen.append((self.path, cookie))
                if self.path == "/auth?login":
                    expected = "Basic " + base64.b64encode(f"ssm_owner:{SERIAL[-5:]}".encode()).decode()
                    if self.headers.get("Authorization") != expected:
                        self.send_error(403)
                        return
                    session[0] += 1
                    self.send_response(200)
                    self.send_header("Set-Cookie", f"session=synthetic-{session[0]}; Path=/")
                    self.end_headers()
                    self.wfile.write(b"{}")
                    return
                if self.path == "/vars?name=/sys/info/serialnum&fmt=obj":
                    payload = {"/sys/info/serialnum": SERIAL}
                    if cookie:
                        self.send_error(401)
                        return
                else:
                    if cookie != f"session=synthetic-{session[0]}":
                        self.send_error(401)
                        return
                    payload = livedata()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Gateway)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)

        def local_opener(cookies):
            real = _build_opener(cookies)

            class Loopback:
                def open(self, request, **kwargs):
                    # Exercise urllib cookies/HTTP on loopback; this test does not validate TLS.
                    request.full_url = request.full_url.replace("https://", "http://", 1)
                    return real.open(request, **kwargs)

            return Loopback()

        with patch("collector.pvs._build_opener", side_effect=local_opener):
            pvs = PVSClient(f"127.0.0.1:{server.server_port}", min_gap=0)
            self.assertEqual(pvs.read_site()[0]["/sys/livedata/pv_p"], 3)
            session[0] += 1
            self.assertEqual(pvs.read_site()[0]["/sys/livedata/pv_p"], 3)
        serial_queries = [cookie for path, cookie in seen if path.startswith("/vars?name=")]
        self.assertEqual(serial_queries, [None, None])
        self.assertEqual(session[0], 3)

    def test_name_value_envelope_works_for_login_bootstrap_and_group_reads(self):
        table = routes()
        for path, value in list(table.items()):
            if path.startswith("/vars"):
                table[path] = {"values": [{"name": k, "value": v} for k, v in value.items()], "count": len(value)}
        pvs, _, _ = make_client(table)
        sample = model.parse_site(pvs.read_site()[0])
        self.assertEqual(sample.values["pv_kw"], 3)
        self.assertEqual(sample.quality, "ok")

    def test_malformed_envelopes_are_safe_failures(self):
        for value in (None, {}, [None], [{"name": "/x"}], [{"name": 42, "value": 1}],
                      [{"name": "/x", "value": 1}, {"name": "/x", "value": 2}]):
            with self.subTest(value=value):
                pvs, _ = client(**{"/vars?match=livedata&fmt=obj&cache=ldata": {"values": value}})
                with self.assertRaises(PVSError) as caught:
                    pvs.read_site()
                self.assertEqual(caught.exception.diagnostics["reason"], "invalid_json")

    def test_health_and_gateway_share_bounded_session_recovery(self):
        from collector.pvs import GATEWAY_PATH, HEALTH_PATH
        for path, reader in ((HEALTH_PATH, "read_health"), (GATEWAY_PATH, "read_gateway")):
            for failure in (http_error(403), {"errorcode": 1}):
                with self.subTest(reader=reader, failure=type(failure).__name__):
                    pvs, opener, clock = make_client(routes(**{path: [failure, {"/sys/info/model": "PVS5"}]}))
                    self.assertEqual(getattr(pvs, reader)()[0]["/sys/info/model"], "PVS5")
                    self.assertEqual(sum(p == "/auth?login" for p, _ in opener.requests), 2)
                    self.assertTrue(all(gap == 3 for gap in clock.sleeps))
                    opener.routes[path] = {"errorcode": 1}
                    before = len(opener.requests)
                    with self.assertRaises(PVSError):
                        getattr(pvs, reader)()
                    self.assertEqual(sum(p == path for p, _ in opener.requests[before:]), 2)

    def test_group_recovery_does_not_stack_http_and_device_error_retries(self):
        path = "/vars?match=livedata&fmt=obj&cache=ldata"
        pvs, opener, _ = make_client(routes(**{path: [http_error(401), {"errorcode": 1}]}))
        with self.assertRaises(PVSError):
            pvs.read_site()
        self.assertEqual(sum(p == path for p, _ in opener.requests), 2)

    def test_documented_nested_devices_preserve_units_unknowns_and_identity(self):
        fields = {"sn": "SYNTHETIC", "msmtEps": published(BASE), "pMppt1Kw": "0.45",
                  "p3phsumKw": "nan", "wpa_key": "must-not-appear"}
        for raw in (fields, json.dumps(fields)):
            with self.subTest(shape=type(raw).__name__):
                panels = model.parse_panels({"/sys/devices/21/inverter/data": raw})
                self.assertEqual(len(panels), 1)
                self.assertEqual(panels[0].index, "21")
                self.assertEqual(panels[0].serial, "SYNTHETIC")
                self.assertEqual(panels[0].values["dc_kw"], 0.45)
                self.assertIsNone(panels[0].values["ac_kw"])
                self.assertEqual(panels[0].measured_at, BASE)
                self.assertNotIn("wpa_key", panels[0].values)
        meters = model.parse_meters({"/sys/devices/12/meter/data": {"p3phsumKw": 0, "msmtEps": published(BASE)}})
        self.assertEqual(meters[0].values["kw"], 0)

    def test_flat_fields_take_precedence_over_nested_fields(self):
        pairs = [("/sys/devices/1/inverter/data", {"p3phsumKw": 9}),
                 ("/sys/devices/inverter/1/p3phsumKw", 0)]
        for items in (pairs, pairs[::-1]):
            self.assertEqual(model.parse_panels(dict(items))[0].values["ac_kw"], 0)
        for raw in ("bad-json", "[]", [], None):
            self.assertEqual(model.parse_panels({"/sys/devices/1/inverter/data": raw}), [])

    def test_gateway_diagnostics_are_allowlisted_and_safe(self):
        self.assertEqual(model.gateway_info({"/sys/info/model": " PVS5 ", "/sys/info/sw_rev": "2025.11.01.5412"}),
                         {"model": "PVS5", "software_version": "2025.11.01.5412"})
        self.assertEqual(model.gateway_info({"/sys/info/model": "secret", "/sys/info/sw_rev": "cookie-secret", "/sys/info/wpa_key": "secret"}),
                         {"model": None, "software_version": None})


class ReadCheckTests(unittest.TestCase):
    def run_check(self, **overrides):
        from collector.pvs import GATEWAY_PATH
        table = routes(**{GATEWAY_PATH: {"/sys/info/model": "PVS5", "/sys/info/sw_rev": "2025.11.01.5412"}, **overrides})
        pvs, _, _ = make_client(table)
        logs = []
        with patch("collector.main.PVSClient", return_value=pvs):
            failures = check_reads(HOST, log=logs.append, now=lambda: BASE)
        return failures, "\n".join(logs)

    def test_synthetic_pvs5_shared_fields_use_the_existing_pipeline(self):
        failures, output = self.run_check()
        self.assertEqual(failures, 0)
        self.assertIn('"model": "PVS5"', output)
        self.assertIn('"software_version": "2025.11.01.5412"', output)
        self.assertIn("site capability=available", output)
        self.assertIn("inverters capability=available", output)
        self.assertIn('"battery_kw": null', output)

    def test_unknown_version_and_empty_groups_do_not_claim_absence_or_block_site(self):
        from collector.pvs import GATEWAY_PATH
        failures, output = self.run_check(**{GATEWAY_PATH: {}, "/vars?match=inverter&fmt=obj&cache=idata": {}})
        self.assertEqual(failures, 0)
        self.assertIn('"model": null', output)
        self.assertIn("inverters capability=unverified", output)
        self.assertIn("hardware_verified=no", output)

    def test_metadata_failure_is_optional_but_missing_core_site_fields_fail(self):
        from collector.pvs import GATEWAY_PATH
        failures, output = self.run_check(**{GATEWAY_PATH: http_error(404)})
        self.assertEqual(failures, 0)
        self.assertIn("gateway unverified", output)
        failures, output = self.run_check(**{"/vars?match=livedata&fmt=obj&cache=ldata": {}})
        self.assertEqual(failures, 1)
        self.assertIn("site capability=unusable", output)

    def test_stale_and_future_site_time_fail_but_measured_zero_passes(self):
        path = "/vars?match=livedata&fmt=obj&cache=ldata"
        for seconds in (-3600, 3600):
            failures, output = self.run_check(**{path: livedata(seconds=seconds)})
            self.assertEqual(failures, 1)
            self.assertIn("site capability=unusable", output)
        failures, output = self.run_check(**{path: livedata(pv=0, load=0, net=0)})
        self.assertEqual(failures, 0)
        self.assertIn("site capability=available", output)

    def test_authentication_failure_is_reported_without_traceback_or_secrets(self):
        logs = []
        with patch("collector.main.PVSClient", side_effect=PVSError("safe", reason="http", stage="auth", http_status=403)):
            self.assertEqual(check_reads(HOST, log=logs.append), 1)
        self.assertIn("connection FAILED", "\n".join(logs))

    def test_documented_envelope_and_nested_data_work_through_the_whole_check(self):
        from collector.pvs import GATEWAY_PATH
        table = routes(**{GATEWAY_PATH: {"/sys/info/model": "PVS6"},
                          "/vars?match=inverter&fmt=obj&cache=idata": {
                              "/sys/devices/21/inverter/data": {"pMppt1Kw": "0.45", "msmtEps": published(BASE)}}})
        for path, value in list(table.items()):
            if path.startswith("/vars"):
                table[path] = {"values": [{"name": k, "value": v} for k, v in value.items()]}
        pvs, _, _ = make_client(table)
        logs = []
        with patch("collector.main.PVSClient", return_value=pvs):
            self.assertEqual(check_reads(HOST, log=logs.append, now=lambda: BASE), 0)
        output = "\n".join(logs)
        self.assertIn("inverters capability=partial", output)
        self.assertIn('"ac_kw": null', output)
        self.assertIn('"dc_kw": 0.45', output)


class ParsingTests(unittest.TestCase):
    def test_site_units_signs_and_missing_values(self):
        sample = model.parse_site(
            {
                "/sys/livedata/pv_p": "3.0",
                "/sys/livedata/pv_en": "12345.6",
                "/sys/livedata/site_load_p": float("nan"),
                "/sys/livedata/net_p": -1.8,
                "/sys/livedata/net_en": "",
                "/sys/livedata/time": published(BASE),
                "/sys/livedata/unlisted": "ignore",
            },
            BASE,
        )
        self.assertEqual(sample.values["pv_kw"], 3.0)
        self.assertEqual(sample.values["grid_kw"], -1.8)
        self.assertEqual(sample.values["pv_kwh_total"], 12345.6)
        self.assertIsNone(sample.values["load_kw_reported"])
        self.assertIsNone(sample.values["grid_net_kwh_total"])
        self.assertIsNone(sample.values["battery_kw"])
        self.assertEqual(sample.quality, model.QUALITY_PARTIAL)
        self.assertEqual(sample.field_count, 7)

    def test_missing_measurement_time_is_clock_invalid_not_zero(self):
        sample = model.parse_site({"/sys/livedata/pv_p": 3.0}, BASE)
        self.assertIsNone(sample.measured_at)
        self.assertEqual(sample.quality, model.QUALITY_CLOCK_INVALID)

    def test_zero_is_measured_zero_and_not_missing(self):
        sample = model.parse_site(livedata(pv=0, load=0, net=0), BASE)
        self.assertEqual(sample.values["pv_kw"], 0.0)
        self.assertEqual(sample.quality, model.QUALITY_OK)

    def test_measured_time_formats(self):
        expected = datetime.fromtimestamp(EPOCH, timezone.utc)
        self.assertEqual(model.parse_measured_time(EPOCH), expected)
        self.assertEqual(model.parse_measured_time(str(EPOCH)), expected)
        self.assertEqual(model.parse_measured_time(EPOCH * 1000), expected)
        self.assertEqual(model.parse_measured_time("2026-09-18T02:00:00Z"), BASE)
        self.assertEqual(model.parse_measured_time("2026-09-17T19:00:00-07:00"), BASE)
        for bad in (None, "", "not-a-time", "NaN", True, float("inf")):
            self.assertIsNone(model.parse_measured_time(bad))

    def test_finite_number_rejects_non_finite_and_blank(self):
        self.assertEqual(model.finite_number(" 1.5 "), 1.5)
        self.assertEqual(model.finite_number(0), 0.0)
        for bad in (None, "", "None", "nan", float("nan"), float("inf"), [], {}, False):
            self.assertIsNone(model.finite_number(bad))

    def test_panel_parsing_discovers_devices_and_keeps_ac_dc_apart(self):
        panels = model.parse_panels({**inverter("10", ac=0.31, dc=0.36), **inverter("2", ac=0.4, dc=0.45)})
        self.assertEqual([panel.index for panel in panels], ["2", "10"])
        self.assertEqual(panels[0].values["ac_kw"], 0.4)
        self.assertEqual(panels[0].values["dc_kw"], 0.45)
        self.assertNotIn("serialnum", panels[0].values)
        self.assertEqual(panels[0].measured_at, BASE)

    def test_panel_missing_measurement_time_stays_missing(self):
        payload = inverter("0")
        payload["/sys/devices/inverter/0/msmtEps"] = ""
        panels = model.parse_panels(payload)
        self.assertIsNone(panels[0].measured_at)
        self.assertEqual(panels[0].values["ac_kw"], 0.4)

    def test_meter_parsing_keeps_directional_counters_separate(self):
        meters = model.parse_meters(
            {
                "/sys/devices/meter/1/p3phsumKw": "0.5",
                "/sys/devices/meter/1/posLtea3phsumKwh": 100.25,
                "/sys/devices/meter/1/negLtea3phsumKwh": 80.5,
                "/sys/devices/meter/1/msmtEps": EPOCH,
            }
        )
        self.assertEqual(len(meters), 1)
        self.assertEqual(meters[0].values["pos_kwh_total"], 100.25)
        self.assertEqual(meters[0].values["neg_kwh_total"], 80.5)

    def test_live_payload_carries_times_and_quality(self):
        payload = model.live_payload("home-pvs", model.parse_site(livedata(), BASE))
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["collector_id"], "home-pvs")
        self.assertEqual(payload["measured_at_utc"], published(BASE))
        self.assertEqual(payload["quality"], model.QUALITY_OK)
        self.assertIsNone(payload["battery_kw"])

    def test_uptime_regression_detection(self):
        self.assertTrue(model.pvs_uptime_regressed({"uptime": 500}, {"uptime": 12}))
        self.assertFalse(model.pvs_uptime_regressed({"uptime": 500}, {"uptime": 600}))
        self.assertFalse(model.pvs_uptime_regressed({}, {"uptime": 12}))

    def test_restart_detection_across_a_long_observation_gap(self):
        previous = {"uptime": 3600}
        self.assertTrue(model.pvs_uptime_regressed(previous, {"uptime": 7199}, elapsed_seconds=7200))
        self.assertFalse(model.pvs_uptime_regressed(previous, {"uptime": 10800}, elapsed_seconds=7200))
        self.assertFalse(model.pvs_uptime_regressed(previous, {"uptime": 10792}, elapsed_seconds=7200))
        self.assertFalse(model.pvs_uptime_regressed(previous, {"uptime": None}, elapsed_seconds=7200))


if __name__ == "__main__":
    unittest.main()
