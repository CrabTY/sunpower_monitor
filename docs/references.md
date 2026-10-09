# Reference projects, acknowledgements and collector comparison

We thank the authors and contributors of the projects below for sharing their protocol research, implementations and interface designs. The [README acknowledgements](../README.md#acknowledgements) name and link every project owner and summarize how each project informed this work.

Links identify the upstream versions reviewed for protocol and UI decisions. The collector and UI projects below are references, not bundled dependencies. Any directly copied code must retain the notices required by its MIT or Apache-2.0 license.

## Official local API documentation

Thank you to [SunStrong Management](https://github.com/SunStrong-Management) and the contributors to [PyPVS](https://github.com/SunStrong-Management/pypvs) for publishing the [local API documentation](https://github.com/SunStrong-Management/pypvs/blob/main/doc/LocalAPI.md) and [PVS6 variable reference](https://github.com/SunStrong-Management/pypvs/blob/main/doc/varserver-variables-public-pvs6.csv). The introduction site's compatibility and sampling explanations already cite these official materials. They document authentication, session cookies, `/vars` queries, cache parameters and request-pacing recommendations.

Our collector implements the local HTTP interface with Python's standard library. It does not install or import the `pypvs` package, call SunStrong's cloud service, or import historical records from that service. Each grouped read includes `match=` even when using a cache ID, following our hardware checks of stale cache membership; see [the collector implementation](../collector/pvs.py).

The SDK itself is assessed separately in the [PyPVS client evaluation](adr/0001-pypvs-client-evaluation.md), including executable checks of the published package and a pinned upstream revision.

## Community collector references

| Project | Collector entry point | Strengths | Limits for this project |
| --- | --- | --- | --- |
| [sunpower-monitor](https://github.com/karak2112/sunpower-monitor/blob/4806123242424696f570243b3dc01b40079d7a7c/services/collector/src/solar_collector/datasource/varserver.py) | Python `httpx`; authenticates, then makes grouped GET requests for `livedata`, `meter`, and `inverter`; parsing lives in [`parse.py`](https://github.com/karak2112/sunpower-monitor/blob/4806123242424696f570243b3dc01b40079d7a7c/services/collector/src/solar_collector/parse.py) | Targets the same 61846 firmware; focused read-only queries, timeouts, circuit breaker, redacted fixtures, and tests | [`poller.py`](https://github.com/karak2112/sunpower-monitor/blob/4806123242424696f570243b3dc01b40079d7a7c/services/collector/src/solar_collector/poller.py) writes directly to PostgreSQL/TimescaleDB. Its parser maps `pMppt1Kw` to inverter `power_kw`, but that is DC MPPT power and should not stand in for AC output. |
| [SunPower-PVS-Supervisor](https://github.com/steveturbek/SunPower-PVS-Supervisor/blob/fd211c1e7b6b4428f47355d0bdfe48fe8d07dd3b/collect-solar-data.py) | Python `requests`; reauthenticates each cycle, fetches all `match=/`, and emits raw JSON and CSV | Clear field examples; uses `p3phsumKw` for inverter AC power; cumulative-energy paths are useful references | Stores complete responses that may contain Wi-Fi credentials and serial numbers. It scans inverter indexes from zero until the first gap, which can omit devices. It writes local files without a retry queue. |
| [pvswatch](https://github.com/timkatz/pvswatch/blob/b31f49a3314394e7f1f04e9c85121f8744b826af/proxy.py) | Flask background polling; device list plus full and focused varserver queries; SQLite history | Prioritizes fresh `livedata` power; does not replace missing cumulative readings with zero; useful night, session renewal, and panel-chart handling | Collection, web serving, and history are coupled in a 1,500+ line `proxy.py`. It stores panel serial numbers by default. README guidance for old firmware does not exactly match current HTTPS authentication code. |
| [ha-esunpower](https://github.com/smcneece/ha-esunpower/blob/bcb344fd50c7946fdc876803a275446ff57a9441/custom_components/sunpower/varserver_client.py) | Home Assistant integration; `aiohttp` POST to `/vars`, grouped by device type; also offers WebSocket | Broad newer-firmware handling, session renewal, temporary missing devices around night/sunrise, and AC/DC metric separation | Deeply tied to Home Assistant. The client also exposes `set_var` and can enable telemetry WebSocket, beyond this collector's read-only scope. |
| [SunPower-Web-Monitor](https://github.com/thomastech/SunPower-Web-Monitor/blob/5029daa30d16ca69cee0432f0c5a93b239240bdf/html/proxy.py) | Flask proxy; authenticates over HTTPS on newer firmware, then reads `dl_cgi/devices/list` | Simple authentication proxy and current-reading UI reference | No history collection. Passing the user's password in a browser query parameter is unsuitable for the cloud design. |
| [pvs6-liberation](https://github.com/jschwerdtfeger/pvs6-liberation/blob/412e6dcf1a224cde89cda7e00c1920e5c54f3154/docs/local-api.md) | API documentation and a [WebSocket example](https://github.com/jschwerdtfeger/pvs6-liberation/blob/412e6dcf1a224cde89cda7e00c1920e5c54f3154/tools/ws_client.py) | Explains 61840+ authentication, `/vars`, device lists, and one-second streams; useful for protocol checks | Not a complete historical collector. It also covers device control, which this version does not need. |
| [dash-sunpower](https://github.com/strawtype/dash-sunpower/blob/97f340c071ef0ff624b0214d3fdf53bc46b9465b/README.md) | Dashboard querying Home Assistant/InfluxDB | Historical replay and panel layout ideas | Does not collect from PVS6 directly. |

## Decision

**The implemented collector uses the `sunpower-monitor` varserver client and parser tests as focused references.** None of the complete projects fits the goal of a Pi that only collects while the cloud holds long-term history.

1. Use the 61846 login and focused-query pattern verified by `sunpower-monitor`; the collector tests exercise all three GET groups. Derive the current firmware's authentication password in memory from the last five digits of the serial number read through a focused local request. Persist neither that credential nor full varserver responses.
2. Use `p3phsumKw` as primary inverter AC power. Keep `pMppt1Kw` as a separate DC metric. The [Home Assistant field separation](https://github.com/smcneece/ha-esunpower/blob/bcb344fd50c7946fdc876803a275446ff57a9441/custom_components/sunpower/varserver_client.py) also distinguishes these values.
3. Adopt `pvswatch`'s missing cumulative-energy semantics and the HA integration's handling of temporarily missing inverters at night and sunrise. Cloud samples must mark missing or stale values instead of presenting cached values as new measurements.
4. Do not fetch complete `match=/` responses, enable WebSocket, or call PVS mutation endpoints in this collector. Reconsider one-second streaming only if a concrete need emerges.

## Additional UI references

Collector analysis is separate from UI design. We also compared [Solar Sentinel](https://github.com/smcneece/solar-sentinel) for its panel matrix, daylight arc, time slider, and individual-panel history; [sunpower-monitor](https://github.com/karak2112/sunpower-monitor/tree/4806123242424696f570243b3dc01b40079d7a7c/apps/web) for current power, flow, freshness, and panel replay; and the presentation patterns in [PVS Watch](https://github.com/timkatz/pvswatch), [dash-sunpower](https://github.com/strawtype/dash-sunpower), [SunPower-Web-Monitor](https://github.com/thomastech/SunPower-Web-Monitor), and [SOLECTRUS](https://github.com/solectrus/solectrus). See the [current browser implementation](architecture.md#browser-dashboard) for the shipped interface. Solar Sentinel is a Home Assistant UI reference, not a collector for this project.

## Notification delivery

Optional iPhone alerts use [Bark](https://github.com/Finb/Bark), created by [Finb](https://github.com/Finb) and maintained with its contributors. Bark provides the receiving iOS app and push API; SunPower Monitor calls that API from its dashboard Worker after detecting a sustained fault or recovery. The current integration sends to `https://api.day.app/push`. See [Bark's official documentation](https://bark.day.app/) and our [notification setup guide](notifications.md).

## Reviewed versions

| Project | Reviewed commit | License |
| --- | --- | --- |
| `sunpower-monitor` | `4806123` | MIT |
| `SunPower-PVS-Supervisor` | `fd211c1` | MIT |
| `pvswatch` | `b31f49a` | MIT |
| `ha-esunpower` | `bcb344f` | Apache-2.0 |
| `SunPower-Web-Monitor` | `5029daa` | Apache-2.0 |
| `pvs6-liberation` | `412e6dc` | MIT |
| `dash-sunpower` | `97f340c` | Apache-2.0 |
| `solar-sentinel` | `f980859` | MIT; UI reference only |
