"""Characterize PyPVS using synthetic data and a loopback HTTP server.

Optional investigation check, outside normal CI/runtime dependencies. Run with
the evaluation venv documented in docs/adr/0001-pypvs-client-evaluation.md.
These assertions record observed behavior, including adoption blockers; a
passing check does not mean the SDK meets the collector's requirements.
"""
from __future__ import annotations

import base64
import io
import logging
import math
from pathlib import Path
import sys
import unittest
from urllib.parse import parse_qs

import aiohttp
import pypvs
from aiohttp import web
from pypvs.models.common import CommonProperties
from pypvs.models.inverter import PVSInverter
from pypvs.models.livedata import PVSLiveData
from pypvs.models.pvs import PVSData
from pypvs.pvs import PVS
from pypvs.pvs_fcgi import PVSFCGIClient, PVSFCGIClientPostError
from pypvs.updaters.production_inverters import PVSProductionInvertersUpdater

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from collector import model

PASSWORD = "fake-password"
COOKIE = "fake-session-cookie"
SERIAL = "FAKE-SERIAL-12345"
INSTANT = "2026-04-10T11:30:00Z"
LIVE = {
    "/sys/livedata/time": 1775820600,
    "/sys/livedata/pv_p": 2.0,
    "/sys/livedata/site_load_p": 3.0,
    "/sys/livedata/net_p": 1.0,
}


class SDKChecks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.statuses = []
        self.override = None
        self.logins = 0
        self.logs = io.StringIO()
        self.logger = logging.getLogger("pypvs")
        self.previous_logging = (self.logger.level, self.logger.propagate, self.logger.handlers[:])
        self.logger.setLevel(logging.DEBUG)
        self.logger.propagate = False
        self.handler = logging.StreamHandler(self.logs)
        self.logger.handlers = [self.handler]
        self.addCleanup(self.restore_logging)
        app = web.Application()
        app.router.add_get("/auth", self.login)
        app.router.add_post("/vars", self.query)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        self.addAsyncCleanup(self.runner.cleanup)
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.runner.addresses[0][1]
        self.base = f"http://127.0.0.1:{port}"
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2))
        self.addAsyncCleanup(self.session.close)
        self.client = PVSFCGIClient(self.session, auth_user="ssm_owner", auth_password=PASSWORD)
        self.client.pvs_url = self.base
        self.client.set_pvs_details({"serial": SERIAL})
        # Explicit initial login makes the transport cases comparable across
        # 0.2.9 and main; test_lazy_login checks the unprimed path separately.
        await self.client.login_basic()

    def restore_logging(self):
        self.logger.setLevel(self.previous_logging[0])
        self.logger.propagate = self.previous_logging[1]
        self.logger.handlers = self.previous_logging[2]
        self.handler.close()

    async def login(self, request):
        expected = base64.b64encode(f"ssm_owner:{PASSWORD}".encode()).decode()
        if request.headers.get("Authorization", "").lower() != f"basic {expected}".lower():
            return web.Response(status=401)
        self.logins += 1
        response = web.json_response({"session": COOKIE})
        response.set_cookie("session", COOKIE)
        return response

    async def query(self, request):
        body = await request.text()
        params = parse_qs(body)
        self.requests.append({"method": request.method, "body": body, "params": params})
        if request.cookies.get("session") != COOKIE:
            return web.Response(status=401, text="synthetic expired session")
        status = self.statuses.pop(0) if self.statuses else 200
        if status != 200:
            return web.Response(status=status, text="synthetic private response")
        if self.override is not None:
            return web.json_response(self.override)
        fields = LIVE
        if "name" in params:
            name = params["name"][0]
            fields = {name: {"/sys/info/serialnum": SERIAL,
                             "/sys/info/ssid": "FAKE-SSID",
                             "/sys/info/lmac": "02:00:00:00:00:01"}.get(name, 123)}
        return web.json_response({"values": [{"name": name, "value": value} for name, value in fields.items()]})

    async def test_single_match_can_feed_existing_site_parser(self):
        pvs = PVS(self.session, user="ssm_owner", password=PASSWORD)
        pvs.fcgi_client = self.client
        data = await pvs.getVarserverVars("livedata")
        sample = model.parse_site(data)
        self.assertEqual(sample.values["pv_kw"], 2.0)
        self.assertEqual(sample.values["grid_kw"], 1.0)
        self.assertIsNotNone(sample.measured_at)

    async def test_multiple_parameters_are_concatenated_without_separators(self):
        params = {"match": "livedata", "fmt": "obj", "cache": "ldata"}
        await self.client.execute_post_request("/vars", params=params)
        self.assertEqual(self.requests[-1]["params"], {"match": ["livedatafmt=objcache=ldata"]})
        self.assertNotEqual(self.requests[-1]["params"], {key: [value] for key, value in params.items()})

    async def test_lazy_login_succeeds_on_an_initial_401(self):
        client = PVSFCGIClient(self.session, auth_user="ssm_owner", auth_password=PASSWORD)
        client.pvs_url = self.base
        client.set_pvs_details({"serial": SERIAL})
        data = await client.execute_post_request("/vars", params={"match": "livedata"})
        self.assertIn("values", data)
        self.assertEqual(self.logins, 2)

    async def test_401_refreshes_and_retries_once(self):
        self.statuses = [401, 200]
        await self.client.execute_post_request("/vars", params={"match": "livedata"})
        self.assertEqual((self.logins, len(self.requests)), (2, 2))

    async def test_403_does_not_refresh_and_error_text_differs_by_version(self):
        self.statuses = [403]
        with self.assertRaises(PVSFCGIClientPostError) as caught:
            await self.client.execute_post_request("/vars", params={"match": "livedata"})
        self.assertEqual((self.logins, len(self.requests)), (1, 1))
        if pypvs.__version__ == "0.2.9":
            self.assertNotIn("synthetic private response", str(caught.exception))
        else:
            self.assertIn("synthetic private response", str(caught.exception))

    async def test_400_retry_policy_differs_between_release_and_main(self):
        self.statuses = [400, 200]
        if pypvs.__version__ == "0.2.9":
            await self.client.execute_post_request("/vars", params={"match": "livedata"})
            self.assertEqual((self.logins, len(self.requests)), (2, 2))
        else:
            with self.assertRaises(PVSFCGIClientPostError):
                await self.client.execute_post_request("/vars", params={"match": "livedata"})
            self.assertEqual((self.logins, len(self.requests)), (1, 1))

    async def test_500_triggers_an_authentication_retry(self):
        self.statuses = [500, 200]
        await self.client.execute_post_request("/vars", params={"match": "livedata"})
        self.assertEqual((self.logins, len(self.requests)), (2, 2))

    async def test_http_200_errorcode_is_returned_without_refresh(self):
        self.override = {"errorcode": 1}
        result = await self.client.execute_post_request("/vars", params={"match": "livedata"})
        self.assertEqual(result, self.override)
        self.assertEqual((self.logins, len(self.requests)), (1, 1))

    async def test_serial_and_session_cookie_appear_in_info_logs(self):
        self.logger.setLevel(logging.INFO)
        self.logs.seek(0)
        self.logs.truncate()
        self.client.set_pvs_details({"serial": SERIAL})
        await self.client.login_basic()
        self.assertIn(SERIAL, self.logs.getvalue())
        self.assertIn(COOKIE, self.logs.getvalue())

    async def test_debug_logs_include_basic_authentication(self):
        token = base64.b64encode(f"ssm_owner:{PASSWORD}".encode()).decode()
        self.assertIn(token, self.logs.getvalue())

    async def test_discovery_reads_ssid_and_mac_beyond_our_serial_only_bootstrap(self):
        pvs = PVS(self.session, user="ssm_owner", password=PASSWORD)
        pvs.fcgi_client = self.client
        await pvs.discover()
        names = [request["params"]["name"][0] for request in self.requests]
        self.assertEqual(names, ["/sys/info/serialnum", "/sys/info/ssid", "/sys/info/lmac"])

    async def test_missing_inverter_power_is_zero_in_sdk_and_unknown_in_our_parser(self):
        raw = {"sn": "FAKE-INVERTER", "prodMdlNm": "TEST", "msmtEps": INSTANT}
        upstream = PVSInverter.from_varserver(raw)
        ours = model.parse_panels({f"/sys/devices/inverter/0/{key}": value for key, value in raw.items()})[0]
        self.assertEqual(upstream.last_report_kw, 0.0)
        self.assertIsNone(ours.values["ac_kw"])

    async def test_live_model_accepts_nonfinite_power(self):
        raw = {**LIVE, "/sys/livedata/pv_p": float("nan")}
        self.assertTrue(math.isnan(PVSLiveData.from_varserver(raw).pv_p))
        self.assertIsNone(model.parse_site(raw).values["pv_kw"])

    async def test_live_model_rejects_iso_timestamp_our_parser_accepts(self):
        raw = {**LIVE, "/sys/livedata/time": INSTANT}
        self.assertIsNone(PVSLiveData.from_varserver(raw).time)
        self.assertIsNotNone(model.parse_site(raw).measured_at)

    async def test_high_level_updater_swallows_a_read_failure(self):
        async def fail(_query):
            raise TimeoutError("synthetic timeout")
        updater = PVSProductionInvertersUpdater(fail, fail, CommonProperties())
        data = PVSData()
        await updater.update(data)
        self.assertEqual(data.inverters, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
