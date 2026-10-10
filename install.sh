#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="$PATH:/usr/local/bin"

# Run on the always-on Pi/NAS. The Node container exists only during setup.
[[ -t 0 ]] || { echo "Run this script in an interactive terminal, not through a pipe." >&2; exit 1; }
# The release workflow fills these pins in the GitHub Release installer asset.
release_revision='unreleased'
release_commit='unknown'
release_image=''
image=${SUNPOWER_COLLECTOR_IMAGE:-$release_image}
[[ -n "$image" ]] || { echo "Download install.sh from a published GitHub Release; this source template has no image pin." >&2; exit 1; }
[[ "$image" =~ ^[A-Za-z0-9._:/@-]+$ ]] || { echo "Invalid collector image configuration" >&2; exit 1; }
section() {
  printf '\n------------------------------------------------------------\n[%s/6] %s\n------------------------------------------------------------\n\n' "$1" "$2"
}
section 1 "Prepare your accounts and collector host"
echo "Keep this terminal on your always-on Pi, NAS, or Linux host."
echo "Use a personal computer or phone browser for the web steps."
echo "Docker may ask for this host's sudo password below."
printf '\n'
for command in docker curl tar; do
  command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 1; }
done

if docker info >/dev/null 2>&1; then
  docker_cmd() { docker "$@"; }
elif command -v sudo >/dev/null && sudo -v && sudo docker info >/dev/null 2>&1; then
  docker_cmd() { sudo docker "$@"; }
else
  echo "Docker must be installed and running on this host." >&2
  exit 1
fi

if docker_cmd container inspect sunpower-monitor-collector >/dev/null 2>&1 ||
   docker_cmd ps --format '{{.Image}}' | grep -q 'sunpower-monitor-collector'; then
  echo "A collector appears to exist already. Stop here to avoid polling the PVS twice." >&2
  exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
scratch=$(mktemp -d)
setup_volume=''
cleanup() {
  [[ -z "$setup_volume" ]] || docker_cmd volume rm "$setup_volume" >/dev/null 2>&1 || true
  rm -r -- "$scratch"
}
trap cleanup EXIT
setup_home=$scratch/setup-home
mkdir -p "$setup_home"
chmod 700 "$setup_home"
source_revision=unknown
if [[ -f "$script_dir/package-lock.json" && -f "$script_dir/workers/schema.sql" ]]; then
  source_dir=$script_dir
else
  mkdir -p "$scratch/source"
  echo "Downloading the source needed to deploy the Cloudflare Workers..."
  curl -fsSL "https://github.com/CrabTY/sunpower-monitor/archive/$release_commit.tar.gz" |
    tar -xz -C "$scratch/source" --strip-components=1 || {
      echo "Source download failed. Check that this release is publicly available." >&2
      exit 1
    }
  source_dir=$scratch/source
  source_revision=$release_commit
fi

state_dir=$HOME/.local/share/sunpower-monitor
mkdir -p "$state_dir/data"
chmod 700 "$state_dir" "$state_dir/data"
account_id=''
setup() {
  local mode=$1 workdir=$2
  shift 2
  local -a docker_args=(run --rm "$mode" --user "$(id -u):$(id -g)")
  [[ -z "$account_id" ]] || docker_args+=(-e "CLOUDFLARE_ACCOUNT_ID=$account_id")
  local variable
  for variable in D1_DATABASE_ID D1_DATABASE_NAME DASHBOARD_WORKER_NAME INGEST_WORKER_NAME \
    ALLOWED_USER_IDS COLLECTOR_ID DASHBOARD_HOST DEPLOY_TAG GIT_SHA; do
    docker_args+=(-e "$variable=${!variable:-}")
  done
  docker_cmd "${docker_args[@]}" \
    -v "$source_dir:/app" -v "$setup_home:/state" \
    -v "$setup_volume:/app/node_modules" \
    -e HOME=/state -e WRANGLER_OUTPUT_FILE_PATH=/state/deploy.ndjson \
    -w "/app/$workdir" node:22-bookworm-slim "$@"
}
pause() {
  printf '\n%s\n\n' "$1"
  read -r -p "Press Enter in this terminal to continue... " _
  printf '\n'
}
quiet_setup() {
  local label=$1
  shift
  printf '\n%s...\n' "$label"
  if setup "$@" > "$scratch/last-command.log" 2>&1; then
    echo "Done."
  else
    printf '\n%s failed. Last command output:\n\n' "$label" >&2
    tail -n 30 "$scratch/last-command.log" >&2
    return 1
  fi
}

printf 'In your browser, create or sign into both accounts:\n\n'
printf '  Cloudflare: https://dash.cloudflare.com/\n\n'
printf '  GitHub:     https://github.com/\n'
pause "When both accounts are ready, return to this terminal."
# Keep executable dependencies off host mounts such as Synology's noexec /tmp.
setup_volume=$(docker_cmd volume create)
docker_cmd run --rm --network none -v "$setup_volume:/deps" node:22-bookworm-slim \
  chown "$(id -u):$(id -g)" /deps
quiet_setup "Installing deployment tools (this can take a few minutes)" -i . npm ci
quiet_setup "Building the dashboard" -i . npm run build:web
section 2 "Browser task: authorize Cloudflare"
echo "The next command prints a link and device code here."
echo "Open that link in your personal browser, enter the code, and approve Wrangler."
echo "Keep this terminal open; it continues after approval."
printf '\n'
setup -it . npx wrangler login --device --browser=false
account_id=$(setup -i . node scripts/install/cloudflare-account.mjs)
if [[ -z "$account_id" ]]; then
  read -r -p "Cloudflare account ID from the list above: " account_id
fi
[[ "$account_id" =~ ^[a-fA-F0-9]{32}$ ]] || { echo "Invalid Cloudflare account ID" >&2; exit 1; }

section 3 "Terminal task: configure and deploy the cloud services"
echo "Choose an installation name; it names your database and two Workers."
printf '\n'
read -r -p "Name this installation (lowercase letters, digits, dashes; e.g. home-solar): " instance
[[ ${#instance} -le 53 && "$instance" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || {
  echo "Invalid installation name" >&2; exit 1;
}
export DASHBOARD_WORKER_NAME="$instance-dashboard"
export INGEST_WORKER_NAME="$instance-ingest"
export D1_DATABASE_NAME="$instance"
export COLLECTOR_ID="$instance"
echo "Workers: $DASHBOARD_WORKER_NAME and $INGEST_WORKER_NAME"
printf '\nLeave the next field blank unless you own a domain already on Cloudflare.\n\n'
read -r -p "Optional dashboard domain already on Cloudflare (blank for workers.dev): " DASHBOARD_HOST
[[ -z "$DASHBOARD_HOST" || "$DASHBOARD_HOST" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || {
  echo "Enter only a hostname, without https:// or a path" >&2; exit 1;
}
export DASHBOARD_HOST DEPLOY_TAG="install-$release_revision" GIT_SHA="$source_revision"

export ALLOWED_USER_IDS
printf '\nChoose the GitHub account that may sign into your private dashboard.\n'
printf 'A username or profile URL works even if your email is private.\n\n'
while true; do
  read -r -p "GitHub username, profile URL, or email allowed to view the dashboard: " github_input
  if github_user=$(setup -i . node scripts/install/github-user.mjs "$github_input"); then
    IFS=$'\t' read -r github_login ALLOWED_USER_IDS <<< "$github_user"
    break
  fi
  echo "Enter your GitHub username or profile URL, or retry after checking the connection." >&2
done
echo "Allowing GitHub user $github_login (numeric ID $ALLOWED_USER_IDS)."

database_id() {
  setup -i . node --input-type=module -e '
    import { execFileSync } from "node:child_process";
    const databases = JSON.parse(execFileSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8" }));
    const database = databases.find(item => item.name === process.argv[1]);
    if (database) process.stdout.write(database.uuid);
  ' "$D1_DATABASE_NAME"
}
db_id=$(database_id)
if [[ -n "$db_id" ]]; then
  echo "D1 database $D1_DATABASE_NAME already exists."
  read -r -p "Type REUSE to use it, or anything else to stop: " reply
  [[ "$reply" == REUSE ]] || exit 1
else
  quiet_setup "Creating the cloud database" -i . npx wrangler d1 create "$D1_DATABASE_NAME"
  db_id=$(database_id)
fi
[[ "$db_id" =~ ^[a-fA-F0-9-]{36}$ ]] || { echo "Could not determine the D1 database ID" >&2; exit 1; }
export D1_DATABASE_ID=$db_id
quiet_setup "Preparing deployment configuration" -i . node scripts/install/render-config.mjs
printf '\n'
echo "This will deploy Workers named $INGEST_WORKER_NAME and $DASHBOARD_WORKER_NAME."
read -r -p "Type DEPLOY to proceed (existing Workers with those names may be updated): " reply
[[ "$reply" == DEPLOY ]] || exit 1
quiet_setup "Applying the database schema" -i workers/ingest npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --file=../schema.sql
quiet_setup "Deploying the upload service" -i workers/ingest npx wrangler deploy
quiet_setup "Deploying the dashboard" -i workers/dashboard npx wrangler deploy

ingest_url=$(setup -i . node scripts/install/worker-origin.mjs /state/deploy.ndjson "$INGEST_WORKER_NAME" ingest)
dashboard_url=$(setup -i . node scripts/install/worker-origin.mjs /state/deploy.ndjson "$DASHBOARD_WORKER_NAME" dashboard "$DASHBOARD_HOST")
section 4 "Browser task: set up GitHub login for your dashboard"
cat <<GUIDE
The cloud services are ready. Your dashboard needs its own GitHub login app.
Keep this terminal open while completing these steps in your personal browser.

1. Open this page and sign into GitHub as $github_login:

   https://github.com/settings/applications/new

2. Fill in the form using these exact values:

   Application name:
     SunPower Monitor ($instance)

   Homepage URL:
     $dashboard_url

   Redirect URI (also called Authorization callback URL):
     $dashboard_url/auth/callback

   Leave the description empty. Keep wildcard matching and Device Flow disabled.

3. Click "Register application".
   On the app settings page, click "Generate a new client secret".
   Keep the page open: you need its Client ID and Client Secret next.

GUIDE
pause "After registering the app and generating its secret, return to this terminal."
configure_github_login() {
  local client_id client_secret
  while true; do
    printf '\nCopy BOTH values from the same GitHub OAuth App settings page.\n\n'
    read -r -p "GitHub Client ID: " client_id
    if [[ -z "$client_id" || "$client_id" == *[[:space:]]* ]]; then
      echo "Paste only the Client ID, without a label or spaces." >&2
      continue
    fi
    printf '\nCopy the generated Client Secret. Input is hidden; paste it here and press Enter.\n'
    printf 'Do not put it in chat, screenshots, Git, or the Docker image.\n\n'
    read -r -s -p "GitHub Client Secret (input hidden): " client_secret
    printf '\n'
    if [[ -z "$client_secret" || "$client_secret" == *[[:space:]]* ]]; then
      unset client_secret
      echo "Paste only the generated Client Secret. Enter both values again." >&2
      continue
    fi
    if printf '%s' "$client_id" | quiet_setup "Saving the GitHub Client ID" -i workers/dashboard npx wrangler secret put GITHUB_CLIENT_ID &&
       printf '%s' "$client_secret" | quiet_setup "Saving the GitHub Client Secret" -i workers/dashboard npx wrangler secret put GITHUB_CLIENT_SECRET; then
      unset client_secret
      return
    fi
    unset client_secret
    echo "Could not save the credential pair. Check the error above and enter both values again." >&2
  done
}
configure_github_login
setup -i . node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' |
  quiet_setup "Saving the session signing key" -i workers/dashboard npx wrangler secret put SESSION_SECRET

token_file=$state_dir/upload-token
if [[ ! -f "$token_file" ]]; then
  setup -i . node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "$token_file"
  chmod 600 "$token_file"
fi
[[ -s "$token_file" ]] || { echo "Upload token is empty" >&2; exit 1; }
quiet_setup "Saving the upload token" -i workers/ingest npx wrangler secret put UPLOAD_TOKEN < "$token_file"

dashboard_code=$(curl -sS -o /dev/null -w '%{http_code}' "$dashboard_url/api/v1/live")
ingest_code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$ingest_url/api/v1/live")
[[ "$dashboard_code" == 401 && "$ingest_code" == 401 ]] || {
  echo "Anonymous access check failed (dashboard $dashboard_code, ingest $ingest_code). Collector not started." >&2
  exit 1
}
section 5 "Browser task: check dashboard login"
while true; do
  printf 'Start a new login from this address in your personal browser:\n\n  %s\n\n' "$dashboard_url"
  echo "Sign in with your allowed GitHub account. An empty dashboard is expected before collection starts."
  printf '\nIf the page reports incorrect_client_credentials, enter R below to replace both GitHub values.\n'
  printf 'For redirect_uri_mismatch, fix the app Redirect URI to %s/auth/callback.\n' "$dashboard_url"
  printf 'For bad_verification_code, start a new login from the homepage; do not refresh the callback.\n\n'
  read -r -p "Press Enter after login succeeds, R to re-enter GitHub credentials, or Q to stop: " reply
  printf '\n'
  case "$reply" in
    '') break ;;
    r|R) configure_github_login ;;
    q|Q) exit 1 ;;
    *) echo "Choose Enter, R, or Q." >&2 ;;
  esac
done

section 6 "Terminal task: start the collector on this host"
echo "Enter the PVS LAN address from your home network, reachable from this host."
printf '\n'
read -r -p "PVS LAN address or hostname: " pvs_host
[[ "$pvs_host" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "Invalid PVS host" >&2; exit 1; }
printf '\nUsing collector image: %s\n' "$image"
echo "Docker selects the matching AMD64 or ARM64 variant automatically."
if [[ ${SUNPOWER_USE_LOCAL_IMAGE:-0} == 1 ]]; then
  docker_cmd image inspect "$image" >/dev/null
else
  docker_cmd pull "$image"
fi
docker_cmd run --rm --network host -e PVS_HOST="$pvs_host" "$image" \
  python3 -m collector.main --check

env_file=$state_dir/collector.env
printf 'PVS_HOST=%s\nCOLLECTOR_ID=%s\nINGEST_BASE_URL=%s\nINGEST_TOKEN_FILE=/run/secrets/upload-token\n' \
  "$pvs_host" "$COLLECTOR_ID" "$ingest_url" > "$env_file"
chmod 600 "$env_file"
docker_cmd run -d --name sunpower-monitor-collector --restart unless-stopped \
  --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --env-file "$env_file" \
  -v "$state_dir/data:/data" -v "$token_file:/run/secrets/upload-token:ro" "$image"
printf '\nInstallation complete. The collector is running on this host.\n\n'
printf 'Dashboard:\n  %s\n\n' "$dashboard_url"
printf 'Local queue and upload token:\n  %s\n' "$state_dir"
