"""Opt-in end-to-end check against a locally running ingest Worker.

    npx wrangler dev --port 8787 --ip 127.0.0.1        # in workers/ingest
    INGEST_LOCAL_URL=http://127.0.0.1:8787 INGEST_TOKEN=local-dev-token \
        python3 -m unittest tests.test_ingest_local

Skipped unless INGEST_LOCAL_URL and INGEST_TOKEN are set. It posts the exact
records the collector produces, so a contract drift between Python and the
Worker fails here before it reaches the Pi.
"""

import os
import time
import unittest
from datetime import datetime, timedelta, timezone

from collector.model import PanelSample, live_payload, parse_site, to_iso
from collector.rollup import SiteMinute, panel_entry, panel_sample_record
from collector.upload import AuthError, IngestClient, RejectedError

URL = os.environ.get("INGEST_LOCAL_URL")
TOKEN = os.environ.get("INGEST_TOKEN")
COLLECTOR = "local-check"


@unittest.skipUnless(URL and TOKEN, "set INGEST_LOCAL_URL and INGEST_TOKEN")
class LocalIngestTests(unittest.TestCase):
    def setUp(self):
        self.client = IngestClient(URL, TOKEN, timeout=10)
        self.minute = datetime.fromtimestamp(int(time.time()) // 60 * 60, timezone.utc)

    def site_minute(self, pv_kw_avg=3.2):
        minute = SiteMinute(self.minute)
        for second in range(0, 60, 10):
            minute.add(
                parse_site(
                    {
                        "/sys/livedata/pv_p": pv_kw_avg,
                        "/sys/livedata/site_load_p": 1.4,
                        "/sys/livedata/net_p": -1.8,
                        "/sys/livedata/time": to_iso(self.minute + timedelta(seconds=second)),
                    },
                    self.minute + timedelta(seconds=second),
                )
            )
        return minute.record(COLLECTOR, self.minute + timedelta(minutes=1))

    def panel_sample(self):
        panel = PanelSample(index="3", measured_at=self.minute, values={"ac_kw": 0.42, "energy_kwh_total": 500.0})
        return panel_sample_record(COLLECTOR, "p03", self.minute, panel_entry(panel, True, None))

    def test_live_history_replay_and_conflict(self):
        self.client.put_live(live_payload(COLLECTOR, parse_site({"/sys/livedata/pv_p": 3.2}, self.minute)))
        records = [self.site_minute(), self.panel_sample()]
        accepted = self.client.post_records(COLLECTOR, records)
        self.assertEqual(accepted, [record["record_id"] for record in records])
        self.assertEqual(self.client.post_records(COLLECTOR, records), accepted)
        conflicting = [self.site_minute(pv_kw_avg=4.4)]
        with self.assertRaises(RejectedError) as raised:
            self.client.post_records(COLLECTOR, conflicting)
        self.assertEqual(raised.exception.record_ids, [conflicting[0]["record_id"]])

    def test_unknown_fields_and_bad_tokens_are_rejected(self):
        bad = self.site_minute()
        bad["serialnum"] = "ZS99000042"
        with self.assertRaises(RejectedError):
            self.client.post_records(COLLECTOR, [bad])
        with self.assertRaises(AuthError):
            IngestClient(URL, "wrong-token", timeout=10).put_live({"collector_id": COLLECTOR})


if __name__ == "__main__":
    unittest.main()
