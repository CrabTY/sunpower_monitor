# Operations

Start with the [Quick Start](quick-start.md) for a new installation. Keep real hosts, account IDs, tokens, exports, and household measurements in private local notes. Run only one collector process for a PVS6 at a time.

## Deployment order

1. On the collector host, run `install.sh` and approve Cloudflare device login in your personal browser. Choose the installation name and optional dashboard domain.
2. The installer creates D1, applies `workers/schema.sql`, and deploys `ingest` and `dashboard`.
3. Use the printed dashboard address to register the exact GitHub OAuth callback in your browser. Enter the OAuth credentials in the collector-host terminal; the installer sets Worker secrets and verifies anonymous requests return `401`.
4. Confirm GitHub login in the browser. Then enter the PVS address in the terminal; the installer uses the release's pinned collector image, and Docker selects the host architecture before starting the collector.

The [Quick Start](quick-start.md) is the installer path; [manual installation](manual-installation.md) preserves the workstation/Compose setup steps. The manual [cloud deployment workflow](../.github/workflows/cloud-deploy.yml) applies the schema and deploys both Workers from a selected ref for maintainers. Supply a deployment label separately from any public Git tag. Public `v*` tags only publish artifacts; they do not deploy Workers. It needs GitHub Actions variables `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `ALLOWED_USER_IDS`, `COLLECTOR_ID`, and optionally `DASHBOARD_HOST`, `D1_DATABASE_NAME`, `DASHBOARD_WORKER_NAME`, and `INGEST_WORKER_NAME`; empty name variables retain the original deployment names. `CLOUDFLARE_API_TOKEN` belongs in Actions **secrets**. Runtime secrets stay on their respective Workers, not in Actions variables.

## Upgrade an existing deployment

Update the Workers with the manual cloud deployment workflow described above, or the [manual deployment commands](manual-installation.md#3-deploy-the-workers-and-add-secrets) using your existing configuration. `install.sh` is for new installations: it chooses a collector ID and saves login/session/upload credentials, and its collector-existence check only sees Docker on the installer host. Running it on another host can create a second collector or replace credentials used by the existing one. An upgrade does not require regenerating those secrets.

Keep the existing D1 ID, Worker names, `COLLECTOR_ID`, allowlist, custom domain, OAuth callback, and Worker secrets. Location, calibration, and history are keyed by the collector ID; changing it does not migrate those records. Compare the rendered configuration before deploying. Use Node.js 22+ for Wrangler, even when the unit checks pass on an older Node version.

Evaluate deployment only when the running source or required configuration changes. A Git history rewrite, documentation edit or release tag alone does not require restarting the collector or redeploying Workers.

Keep the queue, panel map, token, and ownership during an actual collector update. Compose requires `COLLECTOR_UID` and `COLLECTOR_GID`; use the account's actual IDs, including during rollback.

Back up D1 before a cloud update and the SQLite queue before an image replacement. Apply only the database changes required by the selected release (see below), deploy ingest, then deploy dashboard. Check version endpoints, anonymous access, an allowed user's login, fresh readings, panel history, location, and calibration afterward. Keep the previous Worker revision and image available for rollback. A rollback changes code, not database history.

### Choose what to redeploy

| Changed source | Update required |
| --- | --- |
| Documentation, architecture images or graph reports | None for the household services |
| `site/` or the public preview/build tools | Pages site/demo; no collector or private Worker update |
| `web/` or `workers/dashboard/` runtime code | Dashboard Worker, including its browser assets |
| `workers/ingest/` runtime code | Ingest Worker |
| `workers/shared/` runtime code | Each Worker that imports the changed code |
| `collector/` runtime code or collector runtime configuration | Collector image/container or Python service |
| Database structure required by the new code | Reviewed database changes first, then affected Workers |

Tests, comments and source-directory moves alone do not imply a runtime change.
A changed dependency can affect its consumers too. See [Project layout](project-layout.md)
for source and generated directories. Deploy only the affected components while
keeping their record contract compatible.

### Select and check the source

On the workstation, update the existing checkout. For a checkout maintained on
`main`, use a fast-forward update; stop and review if local changes or divergent
history prevent it. A release installation can instead select its reviewed tag
or full commit in the existing checkout. Record the previously deployed commit,
Worker version IDs and collector image before replacing anything.

```sh
git fetch origin --tags
git switch main
git pull --ff-only origin main
git rev-parse HEAD
npm ci
npm run check
```

Review the changes between the running commit and this target. Passing checks
does not deploy it. Keep the ignored `.env`, Worker configuration and secrets;
do not copy examples over an existing installation. Use Node.js 22+.

### Redeploy the affected Workers

Use the workstation's existing Cloudflare account/login and `.env`. Set version
metadata for the reviewed source, then regenerate the ignored configuration:

```sh
export GIT_SHA="$(git rev-parse HEAD)"
export DEPLOY_TAG="update-$(git rev-parse --short HEAD)"
npm run config
```

Review the generated files privately against the previous deployment: D1 ID,
Worker names, collector ID, allowlist and routes must still identify your existing
installation. Wrangler preserves Worker secrets during deployment, but configured
variables and routes can change. Do not set new OAuth/session/upload secrets for
a routine update.

Back up D1 using the [export command](#backups-and-recovery) before a cloud update.
If the release requires a schema change, complete the [database upgrade review](#database-upgrades)
first. With an unchanged schema, skip database initialization and migration commands.

For a dashboard or `web/` update, run from the repository root:

```sh
(cd workers/dashboard && npx wrangler deploy --dry-run)
(cd workers/dashboard && npx wrangler deploy)
```

For an ingest update:

```sh
(cd workers/ingest && npx wrangler deploy --dry-run)
(cd workers/ingest && npx wrangler deploy)
```

The dry run builds and checks without uploading; the next command changes the
live Worker. If both need updating, deploy ingest first, then dashboard. The
dashboard command also publishes `web/` assets; there is no separate private
frontend deployment.

Alternatively, maintainers can run **Actions → cloud-deploy → Run workflow**,
select the reviewed ref and enter a deployment label. That workflow checks the
source, renders configuration from repository variables, applies the base schema
and deploys **both** Workers. It has no dashboard-only option and does not create
missing incremental migrations; use the commands above for a selective update.

After deployment, check both public `/api/v1/version` endpoints against the
expected metadata for each component, repeat the [anonymous-access checks](#verify-a-release),
sign in as an allowed user and verify fresh readings, History, Panels and Settings.
An unaffected component may correctly report its previous revision. For a Worker
rollback, select that Worker's recorded previous version in Cloudflare; confirm
its configuration and assets as well. This does not roll back D1 data.

### Update the collector or public site

If collector code changed, select the reviewed source on the existing collector
host checkout too. Use the [manual Compose update](#update-a-manual-compose-collector)
or [direct Python service update](#direct-python-service) for your existing setup.
Keep its queue, panel map, token, collector ID, PVS address and ingest URL. An
unchanged collector can continue running during a dashboard-only update.

Installer-managed containers use different paths and launch settings from manual
Compose. Preserve their existing mounts, environment, user, network and restart
settings when replacing the image; stop the old collector and back up its data
first. Do not start the manual Compose example alongside one or rerun the
new-installation installer. The collector image is currently private; build from
the reviewed source or use an authorized private image, rather than assuming an
anonymous `docker pull` will work.

For the public website/demo, relevant pushes to `main` run the Pages workflow
after its security checks. You can also run **Actions → pages → Run workflow**
on `main` with **publish** enabled. `npm run build:site` only builds local
`dist/site/`; a documentation-only push does not trigger Pages. This updates
synthetic public pages and never deploys household Workers or the collector.

### Database upgrades

The public installation baseline is v0.1.0. Its `workers/schema.sql` already
contains the current panel diagnostics, known-panel table, slot index and
calibration table. New installations use that schema; the repository does not
automatically replay migration files.

For an existing database, follow the selected release's migration instructions
and check its actual tables, columns and indexes before applying changes.
`CREATE TABLE IF NOT EXISTS` does not add columns to an existing table. Reapplying
the base schema is not a substitute for an incremental upgrade, and repeating
an `ALTER TABLE ... ADD COLUMN` migration can fail on an already upgraded database.

Pre-v0.1.0 development migrations and a household-specific panel-ID repair have
been archived locally by the maintainer. They are not part of the general public
upgrade path. An older development installation needs an individually reviewed
schema comparison and any required data backfill before updating its Workers.
Back up first; do not apply another installation's panel-ID permutation.

## Verify a release

| Request | Expected result |
| --- | --- |
| `GET <ingest-origin>/api/v1/version` | `200`, version metadata only |
| Unauthenticated `PUT <ingest-origin>/api/v1/live` | `401` |
| Browser visit to `<dashboard-origin>/` | GitHub login, then a private page for an allowed user |
| Anonymous `GET <dashboard-origin>/api/v1/live` | `401` |
| Anonymous static asset request | Redirect to login or an authorization failure |

Repeat the anonymous checks on `workers.dev`, every custom domain, and any preview address before sending household data. Match each usable login origin with an exact callback in the GitHub OAuth App. `GET /api/v1/version` intentionally exposes only deployment metadata.

## Collector service

The Docker image contains only the Python standard-library collector. The installer stores the SQLite queue and panel mapping in `$HOME/.local/share/sunpower-monitor/data`, and the token in `$HOME/.local/share/sunpower-monitor/upload-token` on the collector host. Its container is named `sunpower-monitor-collector`; inspect it with `docker logs sunpower-monitor-collector`. These files do not belong in an image or Git checkout. The container has no listening port and can queue while offline.

The paths and commands below are **manual alternatives**. Do not run a second collector alongside the installer container.

### Manual Docker Compose

The [Compose file](../deploy/pi/compose.yaml) uses `/var/lib/sunpower-monitor` and `/etc/sunpower-monitor`. Follow [manual installation step 4](manual-installation.md#4-start-the-collector) to prepare the account, configuration, token and image. Compose needs the UID and GID of that account:

```sh
sudo env COLLECTOR_UID="$(id -u sunpower)" COLLECTOR_GID="$(id -g sunpower)" \
  IMAGE_TAG=local docker compose -f deploy/pi/compose.yaml config --quiet
sudo env COLLECTOR_UID="$(id -u sunpower)" COLLECTOR_GID="$(id -g sunpower)" \
  IMAGE_TAG=local docker compose -f deploy/pi/compose.yaml up -d --no-build --pull never
sudo docker ps --filter name=collector
```

Use a new `IMAGE_TAG` for each manual Compose update. Back up the queue before replacing an image; keep the previous image available for rollback. Stop any other collector before starting Compose.

#### Update a manual Compose collector

On the collector host, work in the existing Compose project's checkout at the
reviewed commit. Keep the same project name, configuration files and account.
The example below builds natively on that host; check Buildx availability first.
Record the previous image tag privately for rollback.

```sh
export IMAGE_TAG="update-$(git rev-parse --short HEAD)"
sudo docker buildx build --load -t "sunpower-monitor-collector:$IMAGE_TAG" -f deploy/pi/Dockerfile .
sudo docker run --rm "sunpower-monitor-collector:$IMAGE_TAG" python3 -m collector.main --help
sudo env COLLECTOR_UID="$(id -u sunpower)" COLLECTOR_GID="$(id -g sunpower)" \
  IMAGE_TAG="$IMAGE_TAG" docker compose -f deploy/pi/compose.yaml stop collector
sudo install -d -m 0700 /var/backups/sunpower-monitor
sudo cp -a /var/lib/sunpower-monitor "/var/backups/sunpower-monitor/data-$(date -u +%Y%m%dT%H%M%SZ)"
sudo env COLLECTOR_UID="$(id -u sunpower)" COLLECTOR_GID="$(id -g sunpower)" \
  IMAGE_TAG="$IMAGE_TAG" docker compose -f deploy/pi/compose.yaml up -d --no-build --pull never collector
sudo env COLLECTOR_UID="$(id -u sunpower)" COLLECTOR_GID="$(id -g sunpower)" \
  IMAGE_TAG="$IMAGE_TAG" docker compose -f deploy/pi/compose.yaml logs --tail 50 collector
```

Build/startup help is a smoke check, not a live acceptance test. Confirm new
uploads, queue recovery and fresh dashboard readings after restarting. The stopped
data-directory copy includes any SQLite WAL files and the panel mapping. Keep
backups private. Stop after any failed command and inspect it before continuing.
To roll back, repeat the Compose `up` command with the recorded previous image
tag, retaining the same data and token mounts. If a future release changes the
queue format, review backward compatibility before selecting the older image.

### Direct Python service

For a host without Docker, use the provided [systemd unit](../deploy/pi/sunpower-monitor.service). Confirm `/usr/bin/python3 --version` is 3.11 or newer. First complete the account, directory, configuration and token setup in [manual installation step 4](manual-installation.md#4-start-the-collector), stopping before its Docker commands. The service expects the repository in `/opt/sunpower-monitor`. For a fresh service installation, select the same full source commit as the deployed Workers:

```sh
sudo install -d -o sunpower -g sunpower -m 0750 /opt/sunpower-monitor
sudo -u sunpower git clone https://github.com/CrabTY/sunpower_monitor.git /opt/sunpower-monitor
sudo -u sunpower git -C /opt/sunpower-monitor checkout --detach YOUR_FULL_COMMIT_SHA
sudo install -m 0644 /opt/sunpower-monitor/deploy/pi/sunpower-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sunpower-monitor
systemctl status sunpower-monitor --no-pager
```

No `pip install` is required. Use `journalctl -u sunpower-monitor -f` for service logs. A read-only device check is `sudo -u sunpower PVS_HOST=YOUR_PVS_LAN_IP /usr/bin/python3 -m collector.main --check` from `/opt/sunpower-monitor`.

For an existing service, replace `YOUR_REVIEWED_FULL_COMMIT_SHA` below with the
reviewed source revision. Record the currently running commit for rollback,
fetch the target, then stop and back up before switching:

```sh
sudo -u sunpower git -C /opt/sunpower-monitor rev-parse HEAD
sudo -u sunpower git -C /opt/sunpower-monitor fetch origin --tags
sudo systemctl stop sunpower-monitor
sudo install -d -m 0700 /var/backups/sunpower-monitor
sudo cp -a /var/lib/sunpower-monitor "/var/backups/sunpower-monitor/data-$(date -u +%Y%m%dT%H%M%SZ)"
sudo -u sunpower git -C /opt/sunpower-monitor checkout --detach YOUR_REVIEWED_FULL_COMMIT_SHA
sudo systemctl start sunpower-monitor
systemctl status sunpower-monitor --no-pager
sudo journalctl -u sunpower-monitor --since '5 minutes ago' --no-pager
```

Stop after a failed command. Preserve `/etc/sunpower-monitor` and
`/var/lib/sunpower-monitor`, and confirm uploads after starting. If the unit file
itself changed, review and install it, then run `sudo systemctl daemon-reload`
before starting. To roll back code, stop, select the recorded previous commit
and start; do not replace current queue data with an older backup for a code-only
rollback.

## Backups and recovery

Back up the local queue with Python's SQLite backup API while the collector is stopped, or by taking a consistent filesystem snapshot. Copying only the main `.sqlite3` file while WAL mode is active can lose committed records. Preserve `panel_map` with the queue so panel identity does not change after restore.

Export D1 to a private path from `workers/ingest`:

```sh
umask 077
npx wrangler d1 export DB --remote --output /path/to/private-backups/sunpower-monitor.sql
```

The SQL export contains telemetry, location, and history. Keep it outside the repository. Test any restore into a separate D1 database before changing a live binding. Apply schema changes before deploying Worker code that requires them. A Worker rollback does not reverse a D1 migration.

## AMD64 and ARM64 images

The [release workflow](../.github/workflows/release.yml) checks a reviewed `vMAJOR.MINOR.PATCH` tag on main, builds AMD64 and ARM64, and publishes `ghcr.io/crabty/sunpower-monitor-collector:<tag>`. Its OCI source label names `CrabTY/sunpower_monitor`. It verifies the image index, then attaches `install.sh`, `release.json`, `image-index.json`, and `SHA256SUMS` to the GitHub Release. The generated installer pins the image by digest and downloads the exact source commit. The source-tree `install.sh` is a template; it stops before setup when no release image is set. Ordinary pushes, PRs and check runs do not publish.

For maintainers, package visibility and Actions write access are configured independently of repository visibility. Review all exposed image versions and provenance before making a package public, and verify anonymous Release downloads and image pulls before advertising the installer.

The same Dockerfile builds both architectures. These commands are for maintainers preparing private/offline packages; the Quick Start installer pulls a prebuilt multi-platform image once one is approved for public access. This Dockerfile has no build-time `RUN` step, so Buildx can prepare either variant without emulation. Running a variant still requires a matching host or configured emulation.

Check `docker buildx version` with the same user or sudo invocation used for the build. If the plugin is missing, install it using the [official Buildx instructions](https://github.com/docker/buildx#installing) before building; do not fall back to the deprecated legacy builder. `buildx build` always uses BuildKit, and `--load` makes the result available to local collector containers.

```sh
mkdir -p dist
docker buildx build --platform linux/amd64 --load -t sunpower-monitor-collector:linux-amd64 -f deploy/pi/Dockerfile .
docker save -o dist/sunpower-monitor-collector-linux-amd64.tar sunpower-monitor-collector:linux-amd64
docker buildx build --platform linux/arm64 --load -t sunpower-monitor-collector:linux-arm64 -f deploy/pi/Dockerfile .
docker save -o dist/sunpower-monitor-collector-linux-arm64.tar sunpower-monitor-collector:linux-arm64
```

Run `docker run --rm --platform linux/amd64 sunpower-monitor-collector:linux-amd64 python3 -m collector.main --help` and the equivalent ARM64 command where the host can run that architecture. The `dist/` directory is ignored by Git. To deploy a tar on another host, use `docker load -i <tar-path>` and set `IMAGE_TAG` to the matching tag.

## Capacity and optional weather

Monitor D1 storage and read/write usage in Cloudflare. For an installer deployment, check the local queue with `du -h "$HOME"/.local/share/sunpower-monitor/data/queue.sqlite3*`; manual Compose and systemd deployments use `/var/lib/sunpower-monitor/queue.sqlite3*`. The hourly `:47` job refreshes daily rollups; the `:17` job fetches optional Open-Meteo weather. The solar collector and history continue to work if weather is unavailable. Check the current [D1 limits](https://developers.cloudflare.com/d1/platform/pricing/) before setting retention or relying on a free tier for long-term history.
