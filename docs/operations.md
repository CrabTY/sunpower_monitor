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

Back up D1 before a cloud update and the SQLite queue before an image replacement. Apply the schema, deploy ingest, then deploy dashboard. Check version endpoints, anonymous access, an allowed user's login, fresh readings, panel history, location, and calibration afterward. Keep the previous Worker revision and image available for rollback. A rollback changes code, not database history.

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

No `pip install` is required. Use `journalctl -u sunpower-monitor -f` for service logs. A read-only device check is `sudo -u sunpower PVS_HOST=YOUR_PVS_LAN_IP /usr/bin/python3 -m collector.main --check` from `/opt/sunpower-monitor`. To update this service, stop it, back up its queue, select the reviewed commit in `/opt/sunpower-monitor`, and start it again. Keep the prior commit for rollback and preserve `/etc/sunpower-monitor` and `/var/lib/sunpower-monitor`.

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
