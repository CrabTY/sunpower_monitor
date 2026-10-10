# Manual installation: private dashboard without a custom domain

For a new installation, start with the [Release installer](quick-start.md). This manual alternative deploys Cloudflare Workers and D1 from a workstation and runs the collector on an always-on Linux host. It uses GitHub login and Cloudflare's `workers.dev` addresses. The collector reads the PVS only on your LAN; it does not use a SunPower cloud account.

## Before you start

- A PVS6 reachable from the collector host by LAN IP. For other firmware or a newer PVS5 exposing the official varserver API, review [compatibility evidence and checks](pvs-compatibility.md); these remain candidates until hardware verification.
- A Cloudflare account with Workers and D1 available, plus a GitHub account.
- A workstation with Node.js 22.5+, npm, Python 3.11+, and Git. The collector host needs Docker with Compose, or Python 3.11+ if you use the direct service path in [operations](operations.md).
- A separate, private place to keep the upload token. Do not put it in the repository, image, or GitHub Actions variables.

## 1. Create the database and configuration

Clone the official repository and select the reviewed release tag or full commit SHA you intend to install. Replace `YOUR_RELEASE_TAG_OR_COMMIT` below with that value. Use the same commit on the workstation and collector host:

```sh
git clone https://github.com/CrabTY/sunpower-monitor.git
cd sunpower-monitor
git checkout --detach YOUR_RELEASE_TAG_OR_COMMIT
git rev-parse HEAD
npm ci
npm run check
npx wrangler login
npx wrangler d1 create sunpower-monitor
```

Copy the `database_id` printed by the last command. Find your Cloudflare account ID and `workers.dev` account subdomain in the Cloudflare dashboard. Find the numeric ID of each GitHub user who may view the dashboard at `https://api.github.com/users/YOUR_LOGIN` (the `id` field).

```sh
cp .env.example .env
chmod 600 .env
```

Fill `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, and comma-separated `ALLOWED_USER_IDS` in `.env`. Keep `DASHBOARD_HOST` empty. These instructions use the example database/Worker names and `COLLECTOR_ID=home-pvs`; if you customize the names, use your chosen names in the commands and addresses too. Set `GIT_SHA` to the full commit printed above and `DEPLOY_TAG` to a label for this installation. A deployment label is independent of a Git release tag. Generate and review the deployment configuration:

```sh
npm run config
```

The dashboard address will be `https://sunpower-monitor-dashboard.YOUR_SUBDOMAIN.workers.dev/`; ingest will be `https://sunpower-monitor-ingest.YOUR_SUBDOMAIN.workers.dev/`.

## 2. Create a GitHub OAuth App

In GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**, set:

- Homepage URL: your dashboard address from step 1.
- Authorization callback URL: that address followed by `auth/callback`, for example `https://sunpower-monitor-dashboard.YOUR_SUBDOMAIN.workers.dev/auth/callback`.
- Wildcard callback matching: disabled.

Save its Client ID and generate a Client Secret. The dashboard asks GitHub only for a user identity, with no repository scopes. If you later add a custom domain, add its exact `/auth/callback` URL to the same OAuth App. [GitHub's OAuth App setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) allows multiple callbacks.

## 3. Deploy the Workers and add secrets

Initialize D1, then deploy the Workers. The dashboard remains unusable until its login secrets are set; the ingest Worker rejects uploads until its token is set.

```sh
cd workers/ingest
npx wrangler d1 execute sunpower-monitor --remote --file=../schema.sql
npx wrangler deploy
cd ../dashboard
npx wrangler deploy
```

Add the dashboard secrets when prompted for the two GitHub values. Generate a separate, random session signing secret without displaying it:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_urlsafe(32))' | npx wrangler secret put SESSION_SECRET
cd ../..
```

Generate one upload token in a private local file, then set that same token on the ingest Worker:

```sh
mkdir -p "$HOME/.config/sunpower-monitor"
chmod 700 "$HOME/.config/sunpower-monitor"
umask 077
python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_urlsafe(32))' > "$HOME/.config/sunpower-monitor/upload-token"
cd workers/ingest
npx wrangler secret put UPLOAD_TOKEN < "$HOME/.config/sunpower-monitor/upload-token"
cd ../..
```

Before configuring the collector, confirm that `GET` on the ingest version endpoint succeeds, an unauthenticated upload returns `401`, and the dashboard sends a browser to GitHub login. Sign in with one of the allowed GitHub accounts. The page should show an empty state until the collector sends data.

## 4. Start the collector

On the Linux collector host, clone the repository and check out the exact commit printed in step 1. Create the restricted collector account if it does not already exist:

```sh
git clone https://github.com/CrabTY/sunpower-monitor.git
cd sunpower-monitor
git checkout --detach YOUR_FULL_COMMIT_SHA
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin sunpower
sudo install -d -o root -g sunpower -m 0750 /etc/sunpower-monitor
sudo install -d -o sunpower -g sunpower -m 0700 /var/lib/sunpower-monitor
sudo install -o root -g sunpower -m 0640 deploy/pi/collector.env.example /etc/sunpower-monitor/collector.env
sudoedit /etc/sunpower-monitor/collector.env
```

Set `PVS_HOST` to the PVS LAN IP and `INGEST_BASE_URL` to the ingest Worker address. Keep `INGEST_TOKEN_FILE=/etc/sunpower-monitor/upload-token` and use the same `COLLECTOR_ID` as in `.env`.

Transfer the upload-token file from the workstation to the collector host over SSH. Replace `user@pi-host` with the collector host's SSH address:

```sh
# On the workstation:
scp "$HOME/.config/sunpower-monitor/upload-token" user@pi-host:~/upload-token

# On the collector host:
sudo install -o sunpower -g sunpower -m 0600 "$HOME/upload-token" /etc/sunpower-monitor/upload-token
rm "$HOME/upload-token"
```

The installed file must match the value stored on the ingest Worker.

Build the image on that host; Docker selects its native AMD64 or ARM64 architecture. Verify a read-only PVS check before running the persistent service:

```sh
sudo docker buildx build --load -t sunpower-monitor-collector:local -f deploy/pi/Dockerfile .
sudo docker run --rm --network host --env-file /etc/sunpower-monitor/collector.env \
  sunpower-monitor-collector:local python3 -m collector.main --check
sudo env COLLECTOR_UID="$(id -u sunpower)" COLLECTOR_GID="$(id -g sunpower)" \
  IMAGE_TAG=local docker compose -f deploy/pi/compose.yaml up -d --no-build --pull never
```

Check `sudo docker ps --filter name=collector` and the dashboard. The queue remains on the host if the Internet connection drops. If the host uses Python directly instead of Docker, follow the [service setup](operations.md#direct-python-service) and run only one collector process.

## Next steps

- [Operations and backups](operations.md)
- [Architecture and data contracts](architecture.md)
- [Contributing](../CONTRIBUTING.md)

Open-Meteo weather and location lookup are optional. Weather data uses Open-Meteo's separate service terms; the collector's solar readings do not depend on it.
