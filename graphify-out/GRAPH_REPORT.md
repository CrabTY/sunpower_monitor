# Graph Report - sunpower_monitor  (2026-10-01)

## Corpus Check
- 80 files · ~230,070 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 12 file(s) not represented in the graph (top: (none) 5, .example 4, .css 2)

## Summary
- 1230 nodes · 2591 edges · 80 communities (55 shown, 25 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 74 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- contract.test.ts
- panels.js
- package.json
- check.js
- dashboard.test.ts
- site-check.mjs
- app.js
- history.js
- weather-sync.ts
- location.ts
- model.py
- query.ts
- AuthenticationTests
- Collector
- CT 安装限制与家庭用电校准
- CollectorTestCase
- month-check.mjs
- PVSError
- page-render-check.mjs
- PendingQueue
- test_pvs.py
- test_collector.py
- weather.ts
- IngestClient
- local-cloud-check.mjs
- UploaderTests
- settings.js
- install.sh
- energy-plot.js
- dashboard/src/index.ts
- dashboard/test/weather.test.ts
- Security review
- ref_node_fs
- prepare-release.py
- FakePVS
- compilerOptions
- Operations
- Quick Start: one terminal on the collector host
- AuthError
- Architecture
- FakeDb
- SunPower Monitor
- contract.ts
- .test_minute_history_reaches_the_endpoint_and_is_acknowledged
- Project layout
- main.py
- exportStats
- Manual installation: private dashboard without a custom domain
- Local preview with simulated data
- Documentation
- ingest/src/index.ts
- ref_node_child_process
- live.ts
- FakeIngest
- PVS
- introduction-check.mjs
- api
- Response
- calibration.js
- Contributing
- FakeDb
- diagrams/README.md
- AGENTS.md
- SERIES
- pre-push
- scripts/README.md
- introduction.js
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

## God Nodes (most connected - your core abstractions)
1. `num()` - 40 edges
2. `CollectorTestCase` - 39 edges
3. `Collector` - 35 edges
4. `PendingQueue` - 32 edges
5. `SiteMinute` - 22 edges
6. `fetch()` - 21 edges
7. `PVSError` - 19 edges
8. `el()` - 19 edges
9. `PVSClient` - 18 edges
10. `IngestClient` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Main push graph updates` --references--> `sql()`  [INFERRED]
  CONTRIBUTING.md → scripts/checks/local-cloud-check.mjs
- `Reference projects and collector comparison` --references--> `livedata()`  [INFERRED]
  docs/references.md → tests/test_pvs.py
- `Reference projects and collector comparison` --references--> `inverter()`  [INFERRED]
  docs/references.md → tests/test_pvs.py
- `CollectorTestCase` --uses--> `Collector`  [INFERRED]
  tests/test_collector.py → collector/main.py
- `IngestSmokeTests` --uses--> `Collector`  [INFERRED]
  tests/test_collector.py → collector/main.py

## Import Cycles
- None detected.

## Communities (80 total, 25 thin omitted)

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
Nodes (44): COLORS, aligned, alignedRows, buckets, bucketWindows, calibratedEnergy, combined, correctedHistory (+36 more)

### Community 4 - "dashboard.test.ts"
Cohesion: 0.13
Nodes (24): RFC-7636, callback(), login(), authorizeUrl(), exchangeCode(), Fetcher, fetchUserId(), GithubConfig (+16 more)

### Community 5 - "site-check.mjs"
Cohesion: 0.20
Nodes (4): ref_node_vm, link(), files(), root

### Community 6 - "app.js"
Cohesion: 0.15
Nodes (36): dayEntry(), el(), flowLink(), formatKw(), formatKwh(), formatTime(), getJson(), hourEntry() (+28 more)

### Community 7 - "history.js"
Cohesion: 0.14
Nodes (35): ref_chart_engine_bundle_js, bucketBounds(), chartBounds(), energyBuckets(), RESOLUTION_MS, zoneOffsetMs(), clock(), dayStart() (+27 more)

### Community 8 - "weather-sync.ts"
Cohesion: 0.12
Nodes (30): AIR_QUALITY_HOURLY, AIR_QUALITY_KIND, AIR_QUALITY_SOURCE, airQualityRows(), airQualityUrl(), alignHourly(), chunkStatements(), DaylightRow (+22 more)

### Community 9 - "location.ts"
Cohesion: 0.12
Nodes (29): allowResolve(), censusPlaces(), getJson(), isFiniteNumber(), isValidCoordinate(), isValidTimezone(), LOCATION_SOURCES, LocationSource (+21 more)

### Community 10 - "model.py"
Cohesion: 0.12
Nodes (26): device_fields(), finite_number(), _from_epoch(), _index_key(), _livedata_fields(), MeterSample, parse_measured_time(), parse_meters() (+18 more)

### Community 11 - "query.ts"
Cohesion: 0.12
Nodes (30): ref_node_test, clampSpan(), daySql(), DEFAULT_SPAN_SECONDS, fiveMinuteSql(), HistoryView, iso(), MAX_ENERGY_SPAN_SECONDS (+22 more)

### Community 12 - "AuthenticationTests"
Cohesion: 0.07
Nodes (20): Additional UI references, Decision, Reference projects and collector comparison, Reviewed versions, AuthenticationTests, client(), Clock, FakeOpener (+12 more)

### Community 13 - "Collector"
Cohesion: 0.21
Nodes (5): Collector, Exception, One small cloud event per hour: proof the collector itself is alive., Name the group and exception behind an empty or short minute., Drive PVS reads on a monotonic schedule and persist what must survive.

### Community 14 - "CT 安装限制与家庭用电校准"
Cohesion: 0.25
Nodes (8): 200A 入户电表箱的安装限制, 400A 系统的计量配置, CT 安装限制与家庭用电校准, SunPower 的发电与用电计量, 比例校准的依据与作用, 电表之后的供电结构, 电表对照与校准设置, 资料与图片

### Community 15 - "CollectorTestCase"
Cohesion: 0.14
Nodes (7): Network trouble, timeout, 429, or 5xx: keep the records and retry later., RetryableError, CollectorTestCase, published(), A frozen measurement time is not a reading: one bootstrap row, then a gap., A PVS restart renumbers every index; identity has to come from the serial., One attempt a minute: the pause never grows past the first minute.

### Community 16 - "month-check.mjs"
Cohesion: 0.15
Nodes (23): ref_workers_dist_shared_contract_js, buildSql(), check(), clamp(), contractRecords(), daylightHours(), dayOfYear(), declination() (+15 more)

### Community 17 - "PVSError"
Cohesion: 0.10
Nodes (18): ArgumentParser, build_parser(), check_reads(), connect_pvs(), main(), One read-only pass over every group; prints values, stores nothing., Wait for the PVS instead of crash-looping when it is rebooting or down., PVSClient (+10 more)

### Community 18 - "page-render-check.mjs"
Cohesion: 0.08
Nodes (23): anchoredHistory, at, customHistory, here, history, historyPayload, live, location (+15 more)

### Community 19 - "PendingQueue"
Cohesion: 0.07
Nodes (10): PendingQueue, Oldest pending records first, with their stored payload unchanged., Isolate records the cloud rejected so the queue can move on., Stable, serial-free panel ID for one inverter. The serial decides identity, and…, Keep one row per index, so the index fallback never reads a stale one., Last known inverter index per panel, so a renumbering is visible., One writer (the collector process) over one SQLite file., Move a pre-serial panel_map to the serial-keyed shape, keeping ids. (+2 more)

### Community 20 - "test_pvs.py"
Cohesion: 0.16
Nodes (19): base64, _build_opener(), PVSAuthError, Read-only PVS6 varserver client: focused, serialized queries. Boundaries taken…, The PVS rejected the session with HTTP 401/403., Ingest client: discardable latest-value PUTs and idempotent history batches.…, datetime, http_cookiejar (+11 more)

### Community 21 - "test_collector.py"
Cohesion: 0.09
Nodes (22): Read-only SunPower PVS6 collector: LAN polling, local queue, cloud upload., SQLite pending-upload queue and Pi-side anonymous panel mapping. Commit locally…, http_server, io, pathlib, pty, main(), Exercise local pushes and worktrees with fake Graphify; no external services. (+14 more)

### Community 22 - "weather.ts"
Cohesion: 0.15
Nodes (19): Validation, DEFAULT_WEATHER_SPAN_SECONDS, FORECAST_FIELDS, localDate(), MAX_WEATHER_ROWS, numberOrNull(), qualityOf(), readWeather() (+11 more)

### Community 23 - "IngestClient"
Cohesion: 0.15
Nodes (10): _ids_from(), IngestClient, _parse_json(), The batch was rejected; isolate these record IDs and keep the rest., HTTPS client for one ingest origin. Certificates are validated normally., Return the accepted record IDs; the caller deletes exactly those., RejectedError, Data contract and history (+2 more)

### Community 24 - "local-cloud-check.mjs"
Cohesion: 0.14
Nodes (17): ref_workers_dist_dashboard_src_session_js, check(), failures, fixtures, log, main(), minuteRow(), now (+9 more)

### Community 25 - "UploaderTests"
Cohesion: 0.15
Nodes (5): _Opener, _raise_urlerror(), _Response, UploaderTests, handler()

### Community 26 - "settings.js"
Cohesion: 0.36
Nodes (18): el(), escapeHtml(), fact(), formatTime(), getJson(), load(), refreshWeather(), renderCandidates() (+10 more)

### Community 27 - "install.sh"
Cohesion: 0.19
Nodes (17): cleanup(), COLLECTOR_ID, configure_github_login(), D1_DATABASE_ID, D1_DATABASE_NAME, DASHBOARD_WORKER_NAME, database_id(), DEPLOY_TAG (+9 more)

### Community 28 - "energy-plot.js"
Cohesion: 0.22
Nodes (15): alignedEnergy(), counterDelta(), rangeEnergy(), solarDisplay(), WEATHER_LAYERS, weatherBounds(), dailySiteOption(), dailySiteRows() (+7 more)

### Community 29 - "dashboard/src/index.ts"
Cohesion: 0.22
Nodes (28): AssetFetcher, collectorId(), energyRange(), fetch(), getCalibration(), getLocation(), health(), history() (+20 more)

### Community 30 - "dashboard/test/weather.test.ts"
Cohesion: 0.13
Nodes (11): ref_node_assert, resolveUser(), OAUTH_COOKIE, SCHEMA_VERSION, SESSION_COOKIE, SESSION_SECONDS, Env, MAX_WEATHER_SPAN_SECONDS (+3 more)

### Community 31 - "Security review"
Cohesion: 0.40
Nodes (4): Continuing checks, Limits and deployment responsibilities, Scope and results, Security review

### Community 32 - "ref_node_fs"
Cohesion: 0.08
Nodes (20): ref_node_fs, ref_node_http, ref_node_os, ref_node_path, ref_node_url, source, configs, dashboardHost (+12 more)

### Community 33 - "prepare-release.py"
Cohesion: 0.33
Nodes (4): argparse, hashlib, re, Create the release installer with immutable source and image references.

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

### Community 39 - "AuthError"
Cohesion: 0.40
Nodes (5): AuthError, Exception, Base class for ingest failures., The upload token was rejected; stop sending until an operator acts., UploadError

### Community 40 - "Architecture"
Cohesion: 0.25
Nodes (8): Architecture, Authentication and private settings, Browser dashboard, Collection and delivery, Compatibility, Components and boundaries, Decisions, Installation and upgrade artifacts

### Community 42 - "SunPower Monitor"
Cohesion: 0.12
Nodes (16): Contributing, Dashboard tour, Documentation, Frequently asked questions, Gateway compatibility, History: energy over time, How it works, Installation (+8 more)

### Community 43 - "contract.ts"
Cohesion: 0.12
Nodes (19): checkCommon(), checkKind(), EARLIEST_MS, FUTURE_TOLERANCE_MS, LIVE_FIELDS, LivePayload, MAX_BATCH, MAX_BODY_BYTES (+11 more)

### Community 44 - ".test_minute_history_reaches_the_endpoint_and_is_acknowledged"
Cohesion: 0.18
Nodes (6): Env, do_POST(), do_PUT(), _payload(), Virtual wall clock plus monotonic clock advanced by the collector's sleeps., The Pi's monotonic clock starts at boot, so due times need the offset.

### Community 45 - "Project layout"
Cohesion: 0.67
Nodes (3): Local configuration and persistent data, Project layout, Source and generated output

### Community 46 - "main.py"
Cohesion: 0.13
Nodes (22): datetime, Serialized PVS6 collector: tiered reads, minute rollup, local queue, upload.…, floor_minute(), floor_slot(), live_payload(), PanelSample, One ``site_latest`` snapshot for the discardable live path., Deterministic record ID; replay keeps the same ID and content. (+14 more)

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

### Community 53 - "live.ts"
Cohesion: 0.33
Nodes (6): DELAYED_THRESHOLD_SECONDS, freshness, LIVE_THRESHOLD_SECONDS, LiveRow, presentLatest(), toIso()

### Community 58 - "introduction-check.mjs"
Cohesion: 0.07
Nodes (25): ref_node_events, assets, bodyClasses, buttons, caption, context, document, external (+17 more)

### Community 60 - "api"
Cohesion: 0.39
Nodes (6): fixture(), allPanelHistory(), api(), history(), panelHistory(), PreviewDate

### Community 62 - "calibration.js"
Cohesion: 0.80
Nodes (4): calibrated(), calibrateHistory(), calibrateLive(), gridRatio()

### Community 64 - "Contributing"
Cohesion: 0.40
Nodes (5): Contributing, Local setup, Main push graph updates, Project layout, Pull requests

### Community 72 - "introduction.js"
Cohesion: 0.12
Nodes (18): cell(), buttons, comparison, header, imageLinks, navigation, originalImage, phone (+10 more)

## Knowledge Gaps
- **310 isolated node(s):** `PATH`, `DASHBOARD_WORKER_NAME`, `INGEST_WORKER_NAME`, `D1_DATABASE_NAME`, `COLLECTOR_ID` (+305 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 504 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **25 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Contributing` connect `Contributing` to `docs/README.md`?**
  _High betweenness centrality (0.400) - this node is a cross-community bridge._
- **Why does `sql()` connect `local-cloud-check.mjs` to `Contributing`?**
  _High betweenness centrality (0.399) - this node is a cross-community bridge._
- **Are the 6 inferred relationships involving `CollectorTestCase` (e.g. with `Collector` and `PendingQueue`) actually correct?**
  _`CollectorTestCase` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 8 inferred relationships involving `Collector` (e.g. with `PVSError` and `PendingQueue`) actually correct?**
  _`Collector` has 8 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `PendingQueue` (e.g. with `Collector` and `CollectorTestCase`) actually correct?**
  _`PendingQueue` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `SiteMinute` (e.g. with `Collector` and `SiteSample`) actually correct?**
  _`SiteMinute` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `PATH`, `DASHBOARD_WORKER_NAME`, `INGEST_WORKER_NAME` to the rest of the system?**
  _310 weakly-connected nodes found - possible documentation gaps or missing edges._