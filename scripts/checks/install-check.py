"""Mock the external services while exercising the installer's full prompt path."""

import os
import hashlib
import json
import pty
import select
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix="sunpower-install-check-") as temporary:
        temp = Path(temporary)
        bin_dir = temp / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text("""#!/bin/bash
set -e
printf '%s\\n' "$*" >> "$MOCK_STATE/docker.log"
[[ "$1" == info ]] && exit 0
[[ "$*" == 'volume create' ]] && { echo 'installer-test-deps'; exit 0; }
args=" $* "
if [[ "$args" == *'npm ci'* && "${MOCK_FAIL_NPM:-0}" == 1 ]]; then
  echo 'synthetic dependency failure' >&2
  exit 1
fi
[[ "$args" == *'container inspect'* ]] && exit 1
[[ "$args" == *'ps --format'* || "$args" == *'image inspect'* ]] && exit 0
[[ "$args" == *'randomBytes'* ]] && { printf 'test-only-random-value'; exit 0; }
[[ "$args" == *'node scripts/install/cloudflare-account.mjs'* ]] && { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; exit 0; }
if [[ "$args" == *'node scripts/install/github-user.mjs'* ]]; then
  if [[ "${@: -1}" == missing-test-user || "${@: -1}" == private@example.com ]]; then
    echo 'GitHub could not identify one user by that public email.' >&2
    exit 1
  fi
  printf 'alice\t123456'; exit 0
fi
if [[ "$args" == *'databases.find'* ]]; then
  [[ -f "$MOCK_STATE/d1-created" ]] && printf '00000000-0000-0000-0000-000000000001'
  exit 0
fi
[[ "$args" == *'wrangler d1 create'* ]] && { touch "$MOCK_STATE/d1-created"; exit 0; }
[[ "$args" == *'wrangler whoami'* ]] && { echo 'Account ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; exit 0; }
[[ "$args" == *'wrangler deploy'* ]] && { echo 'Deployment complete'; exit 0; }
if [[ "$args" == *'node scripts/install/worker-origin.mjs'* ]]; then
  if [[ "$args" == *'node scripts/install/worker-origin.mjs /state/deploy.ndjson demo-solar-ingest ingest'* ]]; then
    printf 'https://demo-solar-ingest.example.workers.dev'
  else
    printf 'https://demo-solar-dashboard.example.workers.dev'
  fi
  exit 0
fi
if [[ "$args" == *'wrangler secret put'* ]]; then
  cat >/dev/null
  if [[ "$args" == *'GITHUB_CLIENT_SECRET'* && ! -f "$MOCK_STATE/secret-retry" ]]; then
    touch "$MOCK_STATE/secret-retry"
    echo 'synthetic secret upload failure' >&2
    exit 1
  fi
  exit 0
fi
[[ "$args" == *' run -d '* ]] && { echo 'test-container'; exit 0; }
exit 0
""")
        docker.chmod(0o755)
        curl = bin_dir / "curl"
        curl.write_text("""#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_STATE/curl.log"
if [[ " $* " == *' -w %{http_code} '* ]]; then
  printf 401
else
  cat "$MOCK_STATE/source.tar.gz"
fi
""")
        curl.chmod(0o755)
        with tarfile.open(temp / "source.tar.gz", "w:gz") as archive:
            for name in ("package.json", "package-lock.json", "workers/schema.sql"):
                archive.add(ROOT / name, arcname="sunpower-monitor-main/" + name)
        installer = temp / "install.sh"
        revision = "v0.1.0"
        commit = "1" * 40
        release_image = "ghcr.io/crabty/sunpower-monitor-collector@sha256:" + "2" * 64
        import sys
        subprocess.run([
            sys.executable, str(ROOT / "scripts/release/prepare-release.py"),
            "--revision", revision, "--commit", commit,
            "--image", release_image, "--output", str(temp),
        ], check=True)
        manifest = json.loads((temp / "release.json").read_text())
        assert manifest["repository"] == "CrabTY/sunpower-monitor"
        assert manifest["tag"] == revision and manifest["commit"] == commit
        assert manifest["collector_image"] == release_image
        assert manifest["installer_sha256"] == hashlib.sha256(installer.read_bytes()).hexdigest()
        publication = (ROOT / ".github/workflows/release.yml").read_text()
        deployment = (ROOT / ".github/workflows/cloud-deploy.yml").read_text()
        assert "wrangler deploy" not in publication and "CLOUDFLARE_API_TOKEN" not in publication
        assert "workflow_dispatch:" in deployment and "tags:" not in deployment
        for flag, value in (("--revision", "v1;bad"), ("--commit", "short"), ("--image", "ghcr.io/other/image:latest")):
            command = [sys.executable, str(ROOT / "scripts/release/prepare-release.py"),
                       "--revision", revision, "--commit", commit,
                       "--image", release_image, "--output", str(temp)]
            command[command.index(flag) + 1] = value
            assert subprocess.run(command, capture_output=True).returncode != 0


        answers = "\n".join([
            "",  # browser accounts ready
            "demo-solar",
            "",  # no custom domain
            "private@example.com",  # private email prompts again without losing login
            "missing-test-user",  # lookup failure must also prompt again
            "https://github.com/alice",
            "DEPLOY",
            "",  # OAuth App created
            "",  # missing Client ID must retry here, not exit
            "Client ID: accidentally-copied-label",  # embedded spaces also retry
            "test-client-id",
            "",  # missing secret asks for both values again
            "test-client-id",
            "test-client-secret",
            "test-client-id",  # failed secret upload retries only the credential pair
            "test-client-secret",
            "R",  # rejected credentials can be replaced in the same installer
            "test-corrected-client-id",
            "test-corrected-client-secret",
            "unexpected-choice",  # cannot proceed without a valid choice
            "",  # browser login verified
            "pvs.local",
            "",
        ])
        master, slave = pty.openpty()
        env = {
            **os.environ,
            "HOME": str(temp),
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "MOCK_STATE": str(temp),
            "SUNPOWER_USE_LOCAL_IMAGE": os.environ.get("INSTALL_CHECK_USE_LOCAL_IMAGE", "1"),
        }
        env.pop("SUNPOWER_COLLECTOR_IMAGE", None)
        image = release_image
        if env["SUNPOWER_USE_LOCAL_IMAGE"] == "1":
            image = env["SUNPOWER_COLLECTOR_IMAGE"] = "sunpower-monitor-collector:test"
        proc = subprocess.Popen(
            ["bash", str(installer)], cwd=temp, stdin=slave, stdout=slave, stderr=slave,
            env=env, start_new_session=True,
        )
        os.close(slave)
        os.write(master, answers.encode())
        chunks = []
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunks.append(os.read(master, 65536))
                except OSError:
                    break
            if proc.poll() is not None:
                break
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        os.close(master)
        output = b"".join(chunks).decode(errors="replace")
        assert proc.returncode == 0, output
        assert "Downloading the source" in output, output
        assert "Installation complete" in output, output
        assert "Paste the ingest" not in output and "Paste the dashboard" not in output, output
        assert "Collector image reference" not in output, output
        assert f"Using collector image: {image}" in output, output
        assert f"https://github.com/CrabTY/sunpower-monitor/archive/{commit}.tar.gz" in (temp / "curl.log").read_text()
        assert "Homepage URL:\r\n     https://demo-solar-dashboard.example.workers.dev" in output, output
        assert "Generate a new client secret" in output, output
        assert output.index("[4/6]") < output.index("Register application") < output.index("[5/6]"), output
        assert "Deployment complete" not in output, output
        assert "Cloudflare account ID from the list" not in output, output
        assert "public email" in output, output
        assert "Enter your GitHub username or profile URL" in output, output
        assert "Paste only the Client ID" in output, output
        assert "Paste only the generated Client Secret" in output, output
        assert "Choose Enter, R, or Q." in output, output
        assert "synthetic secret upload failure" in output, output
        token = temp / ".local/share/sunpower-monitor/upload-token"
        assert token.read_text() == "test-only-random-value"
        assert token.stat().st_mode & 0o777 == 0o600
        commands = (temp / "docker.log").read_text()
        assert commands.index("npm run build:web") < commands.index("wrangler deploy")
        assert "-e D1_DATABASE_ID=00000000-0000-0000-0000-000000000001" in commands
        assert f"-e GIT_SHA={commit}" in commands
        assert "-v installer-test-deps:/app/node_modules" in commands
        assert "volume rm installer-test-deps" in commands
        assert commands.count("wrangler login --device") == 1
        assert commands.count("wrangler d1 create") == 1
        assert commands.count("wrangler deploy") == 2
        assert commands.count("secret put GITHUB_CLIENT_ID") == 3
        assert commands.count("secret put GITHUB_CLIENT_SECRET") == 3
        assert commands.count("secret put SESSION_SECRET") == 1
        assert commands.count("secret put UPLOAD_TOKEN") == 1
        image_operation = "image inspect" if env["SUNPOWER_USE_LOCAL_IMAGE"] == "1" else "pull"
        assert f"{image_operation} {image}" in commands
        assert f"PVS_HOST=pvs.local {image} python3 -m collector.main --check" in commands
        assert f"upload-token:ro {image}" in commands
        # Reject a malformed image override before authorization or deployment.
        master, slave = pty.openpty()
        invalid_env = {**env, "SUNPOWER_COLLECTOR_IMAGE": "invalid image"}
        invalid = subprocess.Popen(
            ["bash", str(installer)], cwd=temp, stdin=slave, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env=invalid_env,
        )
        os.close(slave)
        try:
            invalid_output = invalid.communicate(timeout=10)[0].decode()
            assert invalid.returncode == 1, invalid_output
            assert "Invalid collector image configuration" in invalid_output, invalid_output
            assert (temp / "docker.log").read_text() == commands
        finally:
            if invalid.poll() is None:
                invalid.kill()
                invalid.wait()
            os.close(master)
        # A hidden command failure must become visible and stop before authorization.
        master, slave = pty.openpty()
        failed = subprocess.Popen(
            ["bash", str(installer)], cwd=temp, stdin=slave, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env={**env, "MOCK_FAIL_NPM": "1"},
        )
        os.close(slave)
        try:
            os.write(master, b"\n")
            failure_output = failed.communicate(timeout=10)[0].decode()
            assert failed.returncode == 1, failure_output
            assert "failed. Last command output:" in failure_output, failure_output
            assert "synthetic dependency failure" in failure_output, failure_output
            assert (temp / "docker.log").read_text().count("wrangler login --device") == 1
        finally:
            if failed.poll() is None:
                failed.kill()
                failed.wait()
            os.close(master)
        print("installer mock flow passed")


if __name__ == "__main__":
    main()
