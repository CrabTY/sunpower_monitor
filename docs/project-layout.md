# Project layout

The private installation and public demo use this one source tree. Generated
output and household configuration are kept separately from tracked source.

```text
sunpower_monitor/
├── collector/               Python collector, PVS client, queue and uploads
├── workers/
│   ├── ingest/              Upload API, weather sync and daily rollups
│   ├── dashboard/           GitHub login, private APIs and asset gate
│   ├── shared/              Record contract and shared cloud jobs
│   ├── schema.sql           Database schema for a new installation
│   └── tsconfig.json        Worker compilation settings
├── web/                     Production dashboard; also used by the demo
├── site/                    Public introduction pages and simulated images
├── scripts/
│   ├── install/             Account lookup and configuration rendering
│   ├── release/             Fixed-reference release installer generation
│   ├── preview/             Local preview, synthetic data and site build
│   └── checks/              Installer, browser, local D1 and hook checks
├── deploy/pi/               Dockerfile, Compose and optional systemd unit
├── tests/                   Python tests and optional integration checks
├── docs/
│   ├── diagrams/            Editable architecture JSON and generated SVG
│   └── screenshots/         Installation/login examples
├── .github/workflows/       Checks, releases, manual cloud deploy and Pages
├── .githooks/               Main-branch graph update before pushing
├── graphify-out/            Shared code graph and reports
├── install.sh               New-installation installer template
└── package.json             Stable npm build/check/preview entry points
```

This is a directory overview; root documentation, configuration examples and
individual source files are omitted. See [script topics and commands](../scripts/README.md)
and [architecture](architecture.md) for details.

## Source and generated output

| Path | Purpose and update behavior |
| --- | --- |
| `collector/`, `deploy/pi/` | Collector code and runtime setup; a code/image change needs a collector update |
| `workers/ingest/` | Deploy ingest when its runtime code changes |
| `workers/dashboard/`, `web/` | Deploy dashboard to update private APIs or browser assets; `web/` is bundled with that Worker |
| `workers/shared/` | Check which Worker imports the changed code; deploy each affected Worker |
| `workers/schema.sql` | Initial schema; an existing database needs reviewed incremental changes, not a blind replay |
| `site/`, `scripts/preview/` | Public site and synthetic demo build; no household data is used |
| `dist/site/` | Ignored output from `npm run build:site`, published by Pages |
| `workers/dist/`, `web/chart-engine.bundle.js` | Ignored compilation outputs, rebuilt by `npm run check` |
| `dist/release/` | Ignored release packaging output; ordinary source pushes do not create releases |
| `docs/`, `graphify-out/` | Documentation and shared graph; edits alone do not require production deployment |

The demo loads the same `web/` source with synthetic API responses. There is no
second dashboard implementation to maintain. GitHub Pages publishes only the
static build; the authenticated household dashboard runs on Cloudflare.

## Local configuration and persistent data

`.env`, rendered `workers/*/wrangler.toml`, `.dev.vars*`, `private/`, dependencies,
build directories and local database files are ignored. Keep deployment IDs,
secrets, exports and private notes there or in another private storage location;
do not copy them into documentation or images.

Collector data lives on the collector host, outside this source tree. Manual
Compose/systemd installations use `/var/lib/sunpower-monitor` for the queue and
panel mapping and `/etc/sunpower-monitor` for configuration and the token.
Installer-managed containers use `$HOME/.local/share/sunpower-monitor`.
Cloud history, location and calibration stay in the existing D1 database.

The former pre-v0.1.0 migration files were archived by the maintainer; they are
absent from the current tree but remain in existing Git history and older tags.
They are not a general upgrade sequence. Follow [database upgrade guidance](operations.md#database-upgrades)
and [redeployment steps](operations.md#upgrade-an-existing-deployment) when
updating an installation.
