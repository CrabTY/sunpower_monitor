"""Create the release installer with immutable source and image references."""

import argparse
import hashlib
import json
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, default=Path("dist/release"))
    args = parser.parse_args()
    for value, pattern in (
        (args.revision, r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?"),
        (args.commit, r"[0-9a-f]{40}"),
        (args.image, r"ghcr\.io/crabty/sunpower-monitor-collector@sha256:[0-9a-f]{64}"),
    ):
        if not re.fullmatch(pattern, value):
            parser.error("Expected a version tag, full Git SHA and official image digest")
    source = (Path(__file__).resolve().parents[1] / "install.sh").read_text()
    for name, value in (
        ("release_revision", args.revision),
        ("release_commit", args.commit),
        ("release_image", args.image),
    ):
        source, count = re.subn(rf"^{name}='[^']*'$", f"{name}='{value}'", source, flags=re.M)
        if count != 1:
            parser.error(f"Installer must contain exactly one {name} pin")
    args.output.mkdir(parents=True, exist_ok=True)
    installer = args.output / "install.sh"
    installer.write_text(source)
    installer.chmod(0o755)
    manifest = {
        "repository": "CrabTY/sunpower_monitor",
        "tag": args.revision,
        "commit": args.commit,
        "collector_image": args.image,
        "platforms": ["linux/amd64", "linux/arm64"],
        "installer_sha256": hashlib.sha256(installer.read_bytes()).hexdigest(),
    }
    (args.output / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
