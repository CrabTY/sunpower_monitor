# ADR-0001: Evaluate PyPVS for the collector

**Status:** Accepted: retain the current client and absorb documented compatibility information. SDK migration not implemented; compatibility follow-up implemented on `feature/pvs-compatibility`.
**Date:** 2026-10-09.
**Project baseline:** `47970446abe6ecdc23711d07ca668e88cc28531a`.

## Recommendation

Keep the current collector client for now. Do not replace it directly with the
unmodified PyPVS `0.2.9` release or the reviewed upstream main revision.
Continue using and crediting SunStrong's official local API documentation.
This is a recommendation about the SDK dependency, not a recommendation to
limit investigation to the one tested PVS6 firmware. Broader gateway/firmware
compatibility is a separate, valuable objective, with concrete evidence below.

This recommendation follows executable compatibility checks, rather than a
general preference against dependencies. The low-level SDK can return data to
our parser, but its request encoding and logging need changes or containment.
Its higher-level models and update cycle also differ from our missing-data and
failure-reporting contract. A production adapter has not been built, so no
measured net code reduction is claimed.

## Compatibility objective and implemented follow-up

The investigation baseline flow was:

```text
Configured LAN host
  -> PVSClient: clear cookies, read serial, derive password, GET /auth?login
  -> Serialized GET /vars queries: livedata / meter / inverter / health
  -> Our allowlisted parsers: units, timestamps, zero versus unknown
  -> Live upload + minute/panel rollups -> SQLite queue -> cloud -> dashboard
```

The client uses the common varserver interface, rather than checking for build
61846 in code. The supported-installation statement is narrower because only
PVS6 `2025.10.20.61846` without a battery has been verified on hardware.

The compatibility follow-up keeps that pipeline and adds evidence at its
front, reusing `check_reads` rather than adding a separate installer wizard:

```text
Configured LAN host -> Existing login
  -> Focused gateway model / software revision diagnostics
  -> Existing group reads + check required fields and source timestamps
  -> Report available, missing, or unverified capabilities
  -> Same parsers, collection schedule, queue, cloud and dashboard
```

This follow-up is implemented without an SDK dependency. Version information
explains diagnostics rather than rejecting unlisted builds. HTTP 200 alone does
not establish compatibility: `check_reads` now fails on unusable core site
powers/timestamps and explicitly reports partial/empty device groups without
claiming hardware verification or permanent absence. A gateway metadata failure
does not block collection. Normal polling continues to retry empty groups.

The client normalizes validated name/value envelopes and shares one bounded
session refresh across group, health and gateway reads. Our parsers also accept
the official nested device-data examples while preserving unknown values and
AC/DC separation. The existing scheduler, queue and cloud contract are retained.
See [implemented behavior and evidence limits](../pvs-compatibility.md).

The alternative SDK replacement would reach only the transport/login part:

```text
Existing scheduler -> PyPVS low-level client + compatibility adapter
  -> Raw dictionary -> Our parsers -> Existing queue/cloud/dashboard
```

That adapter would preserve spacing, timeout, query parameters, safe errors and
our recovery policy. Taking the complete SDK discovery/update/model cycle would
replace more than transport and is unnecessary for the compatibility objective.

### Concrete official compatibility evidence

The [pinned official README](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/README.md)
lists PVS5 minimum `2025.11`, build `5412`, and PVS6 minimum `2025.06`, build
`61839`. The same revision's [LocalAPI document](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/doc/LocalAPI.md)
instead says PVS6 `61840+`, PVS5 coming soon, and PVS2 unsupported. These sources
are inconsistent; the README supplies a broader candidate scope, not verified
lower firmware bounds for our project.

We compared the current collector allowlists against both official CSVs at the
same revision using Python's `csv.DictReader`:

| Current requirement | [PVS5 variable table](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/doc/varserver-variables-public-pvs5.csv) | [PVS6 variable table](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/doc/varserver-variables-public-pvs6.csv) |
| --- | --- | --- |
| Site fields plus measurement time | 8/8 present | 8/8 present |
| Panel fields plus measurement time and serial | 10/10 present | 10/10 present |
| Meter fields plus measurement time | 4/4 present | 4/4 present |
| Serial bootstrap and three health fields | 4/4 present | 4/4 present |
| Metadata reference: model, system type, software/hardware revision | 4/4 present | 4/4 present |

All 26 baseline measurement/authentication/health path patterns have matching declared types and read roles
in both tables. PVS5's `ess_p` is explicitly marked NOT USED; its presence must
not be treated as evidence of working storage telemetry. The timestamp
descriptions also differ, so timestamp freshness needs behavioral validation.
CSV defaults are declarations, not actual device readings or test fixtures.

The SDK itself uses shared authentication, variable paths and device-group
probes; it does not dispatch to per-build implementations. Despite its name,
`PVSFirmware.setup()` reads serial/SSID/MAC, not software version. Gateway models
read `/sys/info/model` and `/sys/info/sw_rev`. The useful ideas to absorb are
model/revision diagnostics, capability discovery and explicit optional fields,
rather than an assumed SDK firmware translation layer.

The shared field contract makes newer PVS5 and other documented PVS6 builds
credible compatibility candidates without a parser rewrite or SDK dependency.
Normalization and capability reporting are now tested with synthetic cases.
Next work should obtain read-only hardware evidence for authentication,
actual response shape, source freshness and complete device membership. Official
LocalAPI examples include nested `/sys/devices/{id}/inverter/data` objects,
whereas the baseline parser and current SDK updaters use flat
`/sys/devices/inverter/{index}/{field}` paths. Our follow-up accepts both, backed
by format-specific synthetic tests; that does not establish that both layouts
are returned on every build or that their identities can be mixed safely.

The initial SDK investigation did not change the production flow. The subsequent
compatibility implementation updates the collector and distinguishes documented
candidates from the same hardware-verified configuration. No new hardware support
claim or deployment is implied by synthetic checks.

## Context and requirements

The investigation baseline uses a synchronous scheduler and a 169-line
[PVS client](../../collector/pvs.py). It reads three allowlisted groups and
three health fields, preserves source timestamps and unknown values, and
returns `(dictionary, latency_ms)` or `PVSError` with safe diagnostics.
The scheduler handles group-specific cooldown, reboot recovery, minute
rollups, panel identity, queueing and upload retry separately.

Any replacement must preserve:

- Serialized requests, an eight-second request timeout and at least three
  seconds between requests, including authentication attempts.
- Focused serial discovery, authentication and session recovery, including
  the current handling of HTTP 401/403 and JSON `errorcode` responses.
- Named group queries on every read. Hardware observations led us to retain
  `match=` alongside cache IDs instead of reusing cache membership alone.
- Missing/invalid readings remaining unknown, measured zero remaining zero,
  AC/DC separation, and source measurement timestamps.
- No credentials, session cookies, serials, arbitrary response bodies or
  network identifiers in collector/cloud logs. LAN certificate handling stays
  separate from certificate validation on outbound cloud uploads.
- Existing queue, record identity, parser and cloud API contracts.

The impacted callers are `Collector._read_*`, `Collector._read_health`,
`check_reads` and `connect_pvs` in [collector/main.py](../../collector/main.py).
Migration would also reach client/parser/recovery tests, the collector Docker
image and direct-Python installation instructions. Neither Bark nor the cloud
Workers require an SDK change.

## Versions and method

| Subject | Exact version inspected |
| --- | --- |
| Published package | [PyPI `pypvs==0.2.9`](https://pypi.org/project/pypvs/0.2.9/), uploaded 2026-04-13 |
| Release source | [`v0.2.9`, commit `0f594bba9a55b199f1a733eb1384f1fc50c48a18`](https://github.com/SunStrong-Management/pypvs/tree/0f594bba9a55b199f1a733eb1384f1fc50c48a18) |
| Upstream main | [`adb6a61f6f272f1171d487949ccdb43183db8479`](https://github.com/SunStrong-Management/pypvs/tree/adb6a61f6f272f1171d487949ccdb43183db8479), committed 2026-04-28 |
| Test environment | CPython 3.11.14, `aiohttp==3.14.4`, macOS ARM64 |

The installed PyPI wheel SHA-256 is
`d4ba36424584b361a60f494f43d75d20ecbd44b990b737243da9d294449c2b8d`.
The package credits Aleksandar Mitev / SunStrong Management and is MIT licensed.
Its runtime dependency is `aiohttp`; `zeroconf` is listed in the upstream
development requirements, rather than the package's runtime dependency metadata.
See the [pinned project metadata](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/pyproject.toml).

The [evaluation checks](../../scripts/checks/pypvs-evaluation.py) invoke actual
SDK classes against an HTTP server bound only to `127.0.0.1`. They use synthetic
credentials and readings, with no PVS host, cloud credentials or live telemetry.
The same checks ran against the installed wheel and the pinned source checkout.
Assertions characterize current behavior, including gaps; passing them does
not certify the SDK as suitable for this collector.

## Findings

| Check | Observed result | Effect on adoption |
| --- | --- | --- |
| One `match` parameter | `PVS.getVarserverVars("livedata")` returned a dictionary that our site parser accepted. | The low-level SDK is a plausible future integration point; it can preserve our parser. |
| Multiple parameters | Both versions sent `match=livedatafmt=objcache=ldata`; the local server parsed one combined match value instead of three parameters. | Our `match`, `fmt`, `cache` query contract cannot be carried unchanged through this method. Fix encoding upstream or use an explicitly tested alternative. |
| Lazy login and expired HTTP 401 | Both versions logged in and successfully retried. | Useful SDK functionality we currently maintain ourselves. Main logs in proactively; 0.2.9 tries the request first and requires serial details before login. |
| HTTP 403 | Both raised a post error without refreshing authentication. | Preserve our existing 403 recovery policy in an adapter, unless firmware tests justify changing it. |
| HTTP 400 / 500 | 0.2.9 refreshed on 400 and 500; main refreshed on 500 but raised on 400. | Release and main have different policies. A 500 also causes an extra login request; it is not automatically equivalent to our group cooldown behavior. |
| HTTP 200 with `errorcode` | The low-level client returned the error object without refreshing. | Keep application-level validation and error mapping. |
| Logging | Serial details and session cookies appeared at INFO; encoded Basic authentication appeared at DEBUG. | Suppress SDK logs or fix their redaction before enabling these levels. This is conditional on log configuration, not a claim that installation alone leaks credentials. |
| Exception text | Main included the synthetic private response body in its 403 exception; 0.2.9's exception did not. | Main errors need sanitization before they enter project diagnostics. |
| High-level discovery | Read serial, SSID and LAN MAC. | The current serial-only bootstrap would need a narrower discovery path. |
| Missing inverter power | `PVSInverter.from_varserver` produced `0.0`; our parser produced `None` for the same missing field. | Keep our raw-data parser. Adopting the SDK models would change data meaning. |
| Live numeric/timestamp parsing | The SDK live model accepted numeric NaN and rejected an ISO timestamp that our parser accepted. | Retain our finite-value checks and supported timestamp formats. |
| Inverter read failure | The high-level updater caught a synthetic timeout and returned an empty inverter collection without raising. | A direct high-level replacement would bypass our exception-driven failure diagnostics and cooldown. |

The request, retry and logging findings are reproducible in the
[pinned FCGI client](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/src/pypvs/pvs_fcgi.py).
The model and discovery/update findings are in the
[inverter model](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/src/pypvs/models/inverter.py),
[live model](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/src/pypvs/models/livedata.py),
[firmware discovery](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/src/pypvs/firmware.py)
and [inverter updater](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/src/pypvs/updaters/production_inverters.py).

Source review also found no request-spacing mechanism in `PVSFCGIClient`.
Timeouts are configured by its caller's `aiohttp.ClientSession`.
The high-level `PVS` registers gateway, inverter, meter, ESS and transfer-switch
updaters, while our supported installation is PVS6 without a battery. It does
not replace our separate live-reading schedule, queue or history pipeline.
The SDK exposes mutation/WebSocket methods, but their existence is not an
adoption blocker: a narrow adapter could expose only allowlisted reads.

## Alternatives and consequences

| Option | Benefit | Remaining cost | Recommendation |
| --- | --- | --- | --- |
| Keep the existing client | Existing hardware fixes, query boundaries, diagnostics and scheduler remain in place. | We continue maintaining HTTP/auth/session behavior; the recent cookie/cache faults demonstrate that cost. | Retain for this release. |
| Use only the SDK's low-level client | Reuse upstream authentication/session handling; keep our parser, queue and cloud contract. | Async loop/session lifecycle, request pacing, query encoding, serial bootstrap, retry differences, log containment and safe error translation still need an adapter. | Revisit after encoding/logging fixes and a small adapter proves a net reduction in maintenance. |
| Use the full `PVS` models/update cycle | Reuse broader gateway/device discovery, models and future upstream device support. | Change missing-data semantics, failure signaling, discovery scope and independent polling schedules. | Does not fit the current collector contract as a direct replacement. |
| Maintain a patched SDK fork | Can fix encoding and logging immediately. | Adds a fork, release packaging and reconciliation with upstream while retaining the adapter requirements. | No demonstrated maintenance advantage over the current small client. |

Installing PyPVS is feasible on the tested Python 3.11 host. `aiohttp` alone is
not a rejection reason. Adopting it would add runtime dependency installation
to the current Docker image/direct-Python setup and require pinned, tested
dependency versions. Linux AMD64/ARM64 packaging was not validated here.

Reconsider a low-level adapter when a released, pinned SDK correctly encodes
the required parameter combinations and has safe logging or a documented
containment strategy. Keep our parsers and collector scheduler initially.
Run the existing tests through the candidate adapter, then perform one
serialized, read-only firmware comparison after arranging that it does not
compete with the production collector. Test expired-session recovery, full
panel membership, zero/unknown readings and repeated outage behavior before
any deployment. A live collector replacement needs a separate rollout.

## Reproduce and validation

From this investigation worktree, using Python 3.11:

```sh
python3.11 -m venv tmp/pypvs-evaluation/venv
tmp/pypvs-evaluation/venv/bin/python -m pip install pypvs==0.2.9 aiohttp==3.14.4 pytest==8.4.2
git clone https://github.com/SunStrong-Management/pypvs.git references/pypvs
git -C references/pypvs checkout adb6a61f6f272f1171d487949ccdb43183db8479

tmp/pypvs-evaluation/venv/bin/python scripts/checks/pypvs-evaluation.py
PYTHONPATH=references/pypvs/src tmp/pypvs-evaluation/venv/bin/python scripts/checks/pypvs-evaluation.py
PYTHONPATH=references/pypvs/src tmp/pypvs-evaluation/venv/bin/python -m pytest -q references/pypvs/tests
python3.11 -m unittest discover -s tests
```

Results: 15 evaluation checks passed for each SDK version; 14 upstream main
model/firmware tests passed; 72 existing project Python tests passed and two
ingest integration tests skipped because `INGEST_LOCAL_URL`/`INGEST_TOKEN`
were not supplied. SDK transport behavior is covered by our additional
loopback checks, rather than inferred from the upstream model tests.

The SDK/venv checkout and local outputs are ignored. The initial investigation
changed no runtime dependency, production client, installer, collector process,
cloud database or Worker. The compatibility follow-up changes the collector but
adds no SDK dependency and is not deployed. No request reached a real PVS. Firmware-specific POST behavior,
certificate/session-cookie edge cases, long-running reliability and actual
adapter code savings remain unverified.

Compatibility follow-up validation: 87 project Python tests passed, two ingest
integration tests skipped without their local service/token, and 15 released-SDK
characterization checks still passed. Installer mock flow, introduction page/
interaction checks, static site build/check, local documentation links and
`git diff --check` passed. The new HTTP test uses a synthetic loopback gateway
and real urllib cookie handling; it does not validate LAN TLS or real firmware.
