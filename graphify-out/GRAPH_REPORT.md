# Graph Report - sunpower_monitor  (2026-10-09)

## Corpus Check
- 91 files · ~244,786 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 12 file(s) not represented in the graph (top: (none) 5, .example 4, .css 2)

## Summary
- 1390 nodes · 2929 edges · 93 communities (67 shown, 26 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 100 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- contract.test.ts
- panels.js
- package.json
- check.js
- dashboard/src/index.ts
- site-check.mjs
- app.js
- history.js
- weather-sync.ts
- location.ts
- model.py
- query.ts
- ParsingTests
- notifications.ts
- CT 安装限制与家庭用电校准
- CollectorTestCase
- month-check.mjs
- PVSClient
- page-render-check.mjs
- Collector
- test_pvs.py
- test_collector.py
- pypvs-evaluation.py
- RejectedError
- local-cloud-check.mjs
- UploaderTests
- settings.js
- install.sh
- energy-plot.js
- fetch
- dashboard/test/weather.test.ts
- Security review
- ref_node_fs
- make_client
- FakePVS
- compilerOptions
- Operations
- Quick Start: one terminal on the collector host
- docs/README.md
- main.py
- Architecture
- FakeDb
- SunPower Monitor
- contract.ts
- Env
- Project layout
- test_ingest_local.py
- exportStats
- Manual installation: private dashboard without a custom domain
- Local preview with simulated data
- Documentation
- ingest/src/index.ts
- ref_node_assert
- live.ts
- FakeIngest
- Clock
- SiteMinute
- SDKChecks
- introduction-check.mjs
- Collector Recovery Implementation Plan
- api
- Response
- calibration.js
- CompatibilityTests
- Contributing
- IngestClient
- FakeDb
- diagrams/README.md
- AGENTS.md
- SERIES
- pre-push
- Bark Alerts Implementation Plan
- introduction.js
- .run_panels
- ReadCheckTests
- Reference projects, acknowledgements and collector comparison
- Optional iPhone notifications with Bark
- web_chart_engine_bundle
- web_chart_engine_bundle_chartpalette
- web_chart_engine_bundle_chartxvalueat
- web_chart_engine_bundle_clearechart
- web_chart_engine_bundle_disposeechart
- web_chart_engine_bundle_renderechart
- workers_dist_dashboard_src_session
- workers_dist_dashboard_src_session_signsession
- workers_dist_shared_contract
- workers_dist_shared_contract_digestof
- workers_dist_shared_contract_schema_version
- workers_dist_shared_contract_validatebatch
- PVS Compatibility Implementation Plan
- PVS compatibility and read-only checks
- ScriptedDb
- weather-controls.js

## God Nodes (most connected - your core abstractions)
1. `CollectorTestCase` - 48 edges
2. `num()` - 40 edges
3. `Collector` - 37 edges
4. `PendingQueue` - 32 edges
5. `PVSError` - 28 edges
6. `fetch()` - 25 edges
7. `SiteMinute` - 22 edges
8. `PVSClient` - 21 edges
9. `SDKChecks` - 20 edges
10. `routes()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Main push graph updates` --references--> `sql()`  [INFERRED]
  CONTRIBUTING.md → scripts/checks/local-cloud-check.mjs
- `Reproduce and validation` --references--> `ok()`  [INFERRED]
  docs/adr/0001-pypvs-client-evaluation.md → workers/dashboard/test/notifications.test.ts
- `What triggers an alert` --references--> `ok()`  [INFERRED]
  docs/notifications.md → workers/dashboard/test/notifications.test.ts
- `Hardware acceptance` --references--> `ok()`  [INFERRED]
  docs/pvs-compatibility.md → workers/dashboard/test/notifications.test.ts
- `Compatibility objective and implemented follow-up` --references--> `check_reads()`  [INFERRED]
  docs/adr/0001-pypvs-client-evaluation.md → collector/main.py

## Import Cycles
- None detected.

## Communities (93 total, 26 thin omitted)

### Community 0 - "contract.test.ts"
Cohesion: 0.19
Nodes (13): conflictStatement(), epochSeconds(), insertStatement(), knownPanelStatement(), PlannedWrite, planWrite(), upsertLatestSite(), WriteOutcome (+5 more)

### Community 1 - "panels.js"
Cohesion: 0.13
Nodes (51): num(), chartWindow(), dailyRequestWindow(), dailyRows(), dayDate(), dayLabel(), dayStartFor(), dayStartOf() (+43 more)

### Community 2 - "package.json"
Cohesion: 0.04
Nodes (41): dependencies, echarts, description, devDependencies, @cloudflare/workers-types, esbuild, @types/node, typescript (+33 more)

### Community 3 - "check.js"
Cohesion: 0.05
Nodes (45): COLORS, aligned, alignedRows, buckets, bucketWindows, calibratedEnergy, combined, correctedHistory (+37 more)

### Community 4 - "dashboard/src/index.ts"
Cohesion: 0.11
Nodes (31): RFC-7636, OAUTH_COOKIE, SCHEMA_VERSION, SESSION_COOKIE, SESSION_SECONDS, AssetFetcher, callback(), Env (+23 more)

### Community 5 - "site-check.mjs"
Cohesion: 0.20
Nodes (4): ref_node_vm, link(), files(), root

### Community 6 - "app.js"
Cohesion: 0.15
Nodes (36): dayEntry(), el(), flowLink(), formatKw(), formatKwh(), formatTime(), getJson(), hourEntry() (+28 more)

### Community 7 - "history.js"
Cohesion: 0.15
Nodes (32): ref_chart_engine_bundle_js, RESOLUTION_MS, zoneOffsetMs(), clock(), dayStart(), drawChart(), point(), drawDailyChart() (+24 more)

### Community 8 - "weather-sync.ts"
Cohesion: 0.12
Nodes (30): AIR_QUALITY_HOURLY, AIR_QUALITY_KIND, AIR_QUALITY_SOURCE, airQualityRows(), airQualityUrl(), alignHourly(), chunkStatements(), DaylightRow (+22 more)

### Community 9 - "location.ts"
Cohesion: 0.07
Nodes (49): allowResolve(), censusPlaces(), getJson(), isFiniteNumber(), isValidCoordinate(), isValidTimezone(), LOCATION_SOURCES, LocationSource (+41 more)

### Community 10 - "model.py"
Cohesion: 0.11
Nodes (28): device_fields(), finite_number(), floor_minute(), floor_slot(), _from_epoch(), _index_key(), _livedata_fields(), MeterSample (+20 more)

### Community 11 - "query.ts"
Cohesion: 0.14
Nodes (32): energyRange(), panels(), clampSpan(), daySql(), DEFAULT_SPAN_SECONDS, fiveMinuteSql(), HistoryView, instantSeconds() (+24 more)

### Community 12 - "ParsingTests"
Cohesion: 0.16
Nodes (5): Community collector references, inverter(), livedata(), ParsingTests, published()

### Community 13 - "notifications.ts"
Cohesion: 0.18
Nodes (21): ref_node_sqlite, checkNotifications(), decryptDeviceKey(), encoder, encryptDeviceKey(), encryptionKey(), getNotifications(), Issue (+13 more)

### Community 14 - "CT 安装限制与家庭用电校准"
Cohesion: 0.25
Nodes (8): 200A 入户电表箱的安装限制, 400A 系统的计量配置, CT 安装限制与家庭用电校准, SunPower 的发电与用电计量, 比例校准的依据与作用, 电表之后的供电结构, 电表对照与校准设置, 资料与图片

### Community 15 - "CollectorTestCase"
Cohesion: 0.18
Nodes (4): Network trouble, timeout, 429, or 5xx: keep the records and retry later., RetryableError, CollectorTestCase, One attempt a minute: the pause never grows past the first minute.

### Community 16 - "month-check.mjs"
Cohesion: 0.15
Nodes (23): ref_workers_dist_shared_contract_js, buildSql(), check(), clamp(), contractRecords(), daylightHours(), dayOfYear(), declination() (+15 more)

### Community 17 - "PVSClient"
Cohesion: 0.18
Nodes (6): PVSClient, Derive the in-memory session credential from a focused serial read., Every read gets at most one session refresh, regardless of rejection format., Small uncached query used to spot PVS restarts and rising load., Focused identity diagnostics; exclude SSID, MAC and other settings., One serialized read-only connection to a PVS varserver on the LAN.

### Community 18 - "page-render-check.mjs"
Cohesion: 0.06
Nodes (30): anchoredHistory, at, customHistory, disclosure, here, history, historyPayload, live (+22 more)

### Community 19 - "Collector"
Cohesion: 0.06
Nodes (20): Collector, Exception, One small cloud event per hour: proof the collector itself is alive., Name the group and exception behind an empty or short minute., Drive PVS reads on a monotonic schedule and persist what must survive., PendingQueue, Oldest pending records first, with their stored payload unchanged., Isolate records the cloud rejected so the queue can move on. (+12 more)

### Community 20 - "test_pvs.py"
Cohesion: 0.13
Nodes (22): base64, PVSAuthError, Read-only PVS varserver client: focused, serialized queries. Boundaries taken…, The PVS rejected the session with HTTP 401/403., datetime, errno, http_cookiejar, http_server (+14 more)

### Community 21 - "test_collector.py"
Cohesion: 0.11
Nodes (20): argparse, SQLite pending-upload queue and Pi-side anonymous panel mapping. Commit locally…, hashlib, json, os, pathlib, pty, re (+12 more)

### Community 22 - "pypvs-evaluation.py"
Cohesion: 0.12
Nodes (14): aiohttp, Read-only SunPower PVS varserver collector: LAN polling, local queue, cloud…, logging, math, pypvs, pypvs_models_common, pypvs_models_inverter, pypvs_models_livedata (+6 more)

### Community 23 - "RejectedError"
Cohesion: 0.18
Nodes (7): AuthError, Exception, Base class for ingest failures., The upload token was rejected; stop sending until an operator acts., The batch was rejected; isolate these record IDs and keep the rest., RejectedError, UploadError

### Community 24 - "local-cloud-check.mjs"
Cohesion: 0.14
Nodes (17): ref_workers_dist_dashboard_src_session_js, check(), failures, fixtures, log, main(), minuteRow(), now (+9 more)

### Community 25 - "UploaderTests"
Cohesion: 0.15
Nodes (5): _Opener, _raise_urlerror(), _Response, UploaderTests, handler()

### Community 26 - "settings.js"
Cohesion: 0.29
Nodes (23): el(), escapeHtml(), fact(), formatTime(), getJson(), load(), loadNotifications(), notificationControls() (+15 more)

### Community 27 - "install.sh"
Cohesion: 0.19
Nodes (17): cleanup(), COLLECTOR_ID, configure_github_login(), D1_DATABASE_ID, D1_DATABASE_NAME, DASHBOARD_WORKER_NAME, database_id(), DEPLOY_TAG (+9 more)

### Community 28 - "energy-plot.js"
Cohesion: 0.18
Nodes (18): alignedEnergy(), bucketBounds(), chartBounds(), counterDelta(), energyBuckets(), rangeEnergy(), solarDisplay(), WEATHER_LAYERS (+10 more)

### Community 29 - "fetch"
Cohesion: 0.35
Nodes (18): collectorId(), fetch(), getCalibration(), getLocation(), health(), history(), isoOrNull(), json() (+10 more)

### Community 30 - "dashboard/test/weather.test.ts"
Cohesion: 0.25
Nodes (4): MAX_WEATHER_SPAN_SECONDS, WEATHER_STALE_SECONDS, NOW, ScriptedDb

### Community 31 - "Security review"
Cohesion: 0.40
Nodes (4): Continuing checks, Limits and deployment responsibilities, Scope and results, Security review

### Community 32 - "ref_node_fs"
Cohesion: 0.08
Nodes (21): ref_node_fs, ref_node_http, ref_node_os, ref_node_path, ref_node_test, ref_node_url, source, configs (+13 more)

### Community 33 - "make_client"
Cohesion: 0.19
Nodes (7): AuthenticationTests, client(), http_error(), make_client(), A cache-only read can serve a partial variable set, so it is never used., A stale cookie gets 401 on every request, so re-login must drop it., routes()

### Community 34 - "FakePVS"
Cohesion: 0.24
Nodes (3): FakePVS, A partial PVS reply must not read as a smaller array on every page., Scripted read-only PVS stand-in; measured time follows the virtual clock.

### Community 35 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, lib, module, moduleResolution, noUncheckedIndexedAccess, outDir, rootDir, skipLibCheck (+4 more)

### Community 36 - "Operations"
Cohesion: 0.12
Nodes (16): AMD64 and ARM64 images, Backups and recovery, Capacity and optional weather, Choose what to redeploy, Collector service, Database upgrades, Deployment order, Direct Python service (+8 more)

### Community 37 - "Quick Start: one terminal on the collector host"
Cohesion: 0.22
Nodes (9): 1. Start the installer on the collector host, 2. Approve Cloudflare access in your browser, 3. Configure and deploy in the collector-host terminal, 4. Register GitHub login in your browser, 5. Check GitHub login in your browser, 6. Pull and start the collector on the same host, After installation: verify readings in your browser, Before you start (+1 more)

### Community 39 - "main.py"
Cohesion: 0.11
Nodes (21): ArgumentParser, build_parser(), check_reads(), connect_pvs(), main(), datetime, Serialized PVS varserver collector: tiered reads, minute rollup, local queue,…, One read-only pass over every group; prints values, stores nothing. (+13 more)

### Community 40 - "Architecture"
Cohesion: 0.22
Nodes (9): Architecture, Authentication and private settings, Browser dashboard, Collection and delivery, Compatibility, Components and boundaries, Data contract and history, Decisions (+1 more)

### Community 42 - "SunPower Monitor"
Cohesion: 0.12
Nodes (17): Acknowledgements, Contributing, Dashboard tour, Documentation, Frequently asked questions, Gateway compatibility, History: energy over time, How it works (+9 more)

### Community 43 - "contract.ts"
Cohesion: 0.12
Nodes (19): checkCommon(), checkKind(), EARLIEST_MS, FUTURE_TOLERANCE_MS, LIVE_FIELDS, LivePayload, MAX_BATCH, MAX_BODY_BYTES (+11 more)

### Community 44 - "Env"
Cohesion: 0.25
Nodes (3): Env, Virtual wall clock plus monotonic clock advanced by the collector's sleeps., The Pi's monotonic clock starts at boot, so due times need the offset.

### Community 45 - "Project layout"
Cohesion: 0.67
Nodes (3): Local configuration and persistent data, Project layout, Source and generated output

### Community 46 - "test_ingest_local.py"
Cohesion: 0.16
Nodes (15): live_payload(), PanelSample, One ``site_latest`` snapshot for the discardable live path., Deterministic record ID; replay keeps the same ID and content., record_id(), to_iso(), Insert records, ignoring ones already queued under the same ID., panel_entry() (+7 more)

### Community 48 - "Manual installation: private dashboard without a custom domain"
Cohesion: 0.29
Nodes (7): 1. Create the database and configuration, 2. Create a GitHub OAuth App, 3. Deploy the Workers and add secrets, 4. Start the collector, Before you start, Manual installation: private dashboard without a custom domain, Next steps

### Community 49 - "Local preview with simulated data"
Cohesion: 0.33
Nodes (6): GitHub Pages, Local preview with simulated data, 可直接托管的演示产物, 启动, 数据范围与实现, 项目介绍站点

### Community 50 - "Documentation"
Cohesion: 0.67
Nodes (3): Documentation, Images, Separate introduction site

### Community 51 - "ingest/src/index.ts"
Cohesion: 0.32
Nodes (12): authorized(), collectorId(), Env, fetch(), json(), postRecords(), putLive(), readJson() (+4 more)

### Community 52 - "ref_node_assert"
Cohesion: 0.25
Nodes (4): ref_node_assert, ref_node_child_process, result(), resolveUser()

### Community 53 - "live.ts"
Cohesion: 0.33
Nodes (6): DELAYED_THRESHOLD_SECONDS, freshness, LIVE_THRESHOLD_SECONDS, LiveRow, presentLatest(), toIso()

### Community 55 - "Clock"
Cohesion: 0.20
Nodes (4): Clock, FakeOpener, Virtual monotonic clock so adapter tests never sleep in real time., Minimal stand-in for urllib's opener; records every requested path.

### Community 56 - "SiteMinute"
Cohesion: 0.17
Nodes (3): Accumulates the site samples that belong to one UTC minute., SiteMinute, published()

### Community 57 - "SDKChecks"
Cohesion: 0.07
Nodes (10): ADR-0001: Evaluate PyPVS for the collector, Alternatives and consequences, Compatibility objective and implemented follow-up, Concrete official compatibility evidence, Findings, Recommendation, Reproduce and validation, Versions and method (+2 more)

### Community 58 - "introduction-check.mjs"
Cohesion: 0.07
Nodes (25): ref_node_events, assets, bodyClasses, buttons, caption, context, document, external (+17 more)

### Community 59 - "Collector Recovery Implementation Plan"
Cohesion: 0.33
Nodes (5): Collector Recovery Implementation Plan, Review and release boundary, Task 1: Write fault regressions, Task 2: Fix the shared paths, Task 3: Verify and document

### Community 60 - "api"
Cohesion: 0.39
Nodes (6): fixture(), allPanelHistory(), api(), history(), panelHistory(), PreviewDate

### Community 62 - "calibration.js"
Cohesion: 0.80
Nodes (4): calibrated(), calibrateHistory(), calibrateLive(), gridRatio()

### Community 63 - "CompatibilityTests"
Cohesion: 0.17
Nodes (5): _build_opener(), CompatibilityTests, do_GET(), local_opener(), Clearing a jar the opener does not use leaves the stale cookie in place.

### Community 64 - "Contributing"
Cohesion: 0.40
Nodes (5): Contributing, Local setup, Main push graph updates, Project layout, Pull requests

### Community 65 - "IngestClient"
Cohesion: 0.27
Nodes (6): _ids_from(), IngestClient, _parse_json(), Ingest client: discardable latest-value PUTs and idempotent history batches.…, HTTPS client for one ingest origin. Certificates are validated normally., Return the accepted record IDs; the caller deletes exactly those.

### Community 71 - "Bark Alerts Implementation Plan"
Cohesion: 0.29
Nodes (6): Bark Alerts Implementation Plan, Task 1: Storage and notification behavior, Task 2: Worker integration, Task 3: Settings and preview, Task 4: Upgrade guidance and verification, Verification completed

### Community 72 - "introduction.js"
Cohesion: 0.12
Nodes (18): cell(), buttons, comparison, header, imageLinks, navigation, originalImage, phone (+10 more)

### Community 75 - "Reference projects, acknowledgements and collector comparison"
Cohesion: 0.33
Nodes (6): Additional UI references, Decision, Notification delivery, Official local API documentation, Reference projects, acknowledgements and collector comparison, Reviewed versions

### Community 76 - "Optional iPhone notifications with Bark"
Cohesion: 0.40
Nodes (5): Enable from Settings, Optional iPhone notifications with Bark, Storage and delivery, Upgrade an existing deployment, What triggers an alert

### Community 89 - "PVS Compatibility Implementation Plan"
Cohesion: 0.40
Nodes (4): Evidence limits, PVS Compatibility Implementation Plan, Scope and accepted design, Steps

### Community 90 - "PVS compatibility and read-only checks"
Cohesion: 0.40
Nodes (5): Evidence and scope, Hardware acceptance, Implemented flow, PVS compatibility and read-only checks, Run the existing check

## Knowledge Gaps
- **346 isolated node(s):** `PATH`, `DASHBOARD_WORKER_NAME`, `INGEST_WORKER_NAME`, `D1_DATABASE_NAME`, `COLLECTOR_ID` (+341 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 579 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ADR-0001: Evaluate PyPVS for the collector` connect `SDKChecks` to `docs/README.md`, `main.py`?**
  _High betweenness centrality (0.302) - this node is a cross-community bridge._
- **Why does `ok()` connect `notifications.ts` to `PVS Compatibility Implementation Plan`, `SDKChecks`, `PVS compatibility and read-only checks`, `Optional iPhone notifications with Bark`?**
  _High betweenness centrality (0.237) - this node is a cross-community bridge._
- **Why does `Context and requirements` connect `main.py` to `SDKChecks`, `Collector`?**
  _High betweenness centrality (0.224) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `CollectorTestCase` (e.g. with `Collector` and `PVSError`) actually correct?**
  _`CollectorTestCase` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 8 inferred relationships involving `Collector` (e.g. with `PVSError` and `PendingQueue`) actually correct?**
  _`Collector` has 8 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `PendingQueue` (e.g. with `Collector` and `CollectorTestCase`) actually correct?**
  _`PendingQueue` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `PVSError` (e.g. with `check_reads()` and `Collector`) actually correct?**
  _`PVSError` has 10 INFERRED edges - model-reasoned connections that need verification._