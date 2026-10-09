# Contributing

Thanks for helping improve SunPower Monitor. The collector only reads a PVS6, and the dashboard must keep private telemetry behind authentication. Please keep those two boundaries intact.

## Local setup

Fork the repository to your GitHub account if you want to submit changes, then clone your fork. Installation uses the published Release installer on the collector host; see the [Quick Start](docs/quick-start.md).

Use Python 3.11+ and Node.js 22.5+ (the notification tests use built-in SQLite):

```sh
npm ci
python3 -m unittest discover -s tests
bash -n install.sh
python3 scripts/checks/install-check.py
INSTALL_CHECK_USE_LOCAL_IMAGE=0 python3 scripts/checks/install-check.py
npm run check
```

### Main push graph updates

Install Graphify (the tested version is `graphifyy==0.9.71`), make its `graphify` command available on your PATH, and enable the shared hook once per clone:

```sh
uv tool install graphifyy==0.9.71
git config --local core.hooksPath .githooks
```

Only a push targeting `refs/heads/main` runs the pre-push hook. Ordinary commits, feature-branch pushes, and branch deletion do not update the graph. Develop in separate branches/worktrees, merge the final changes into main, then push from main's worktree.

The hook synchronously runs `graphify update .` against a temporary archive of the exact commit being pushed. Uncommitted code and untracked files are excluded. If the committed graph is current, the push proceeds. If it changes, the hook writes `graph.json`, `graph.html`, and `GRAPH_REPORT.md` in that worktree and pauses the push. Submit the generated results and retry:

```sh
git add -- graphify-out/graph.json graphify-out/graph.html graphify-out/GRAPH_REPORT.md
git commit --only -m "Update graph after integration" -- graphify-out/graph.json graphify-out/graph.html graphify-out/GRAPH_REPORT.md
git push
```

The hook never stages, commits, or amends files automatically. Existing staged/unstaged graph edits are preserved: commit or stash them first. If the commit being pushed is not the current worktree's HEAD, the hook asks you to check it out in its worktree before writing updated results. Missing Graphify or a failed rebuild stops main's push. Temporary source archives have no Git history; structural content, rather than the final commit hash, is the freshness reference.

`AGENTS.md` and the three graph results are shared project files. Graphify caches, timestamp manifests, hidden local metadata, and dated backups are ignored. This hook performs structural extraction without an API; use `/graphify --update` for semantic document/image changes. Hooks must be enabled by each contributor and can be bypassed by Git; repository-wide CI enforcement is a separate gate.

SQL extraction additionally requires Graphify's `sql` extra; without it, Graphify warns and skips SQL files. This affects graph coverage, not the project's SQL runtime checks.

Run `python3 scripts/checks/check-graph-hook.py` to check real local pushes and worktree isolation in temporary repositories without contacting external services.

`npm run check` builds the browser chart bundle, compiles and tests the Workers, checks page behavior, and tests deployment configuration rendering. It does not deploy or contact a production D1 database. For a repeatable browser view with simulated readings, run `npm run preview` and open `http://127.0.0.1:4173/`.

## Project layout

See [Project layout](docs/project-layout.md) for the directory tree, script topics,
build outputs and private configuration boundaries. [Operations](docs/operations.md#upgrade-an-existing-deployment)
maps source changes to the services that need redeployment.

## Pull requests

Keep changes focused and describe the user-facing behavior, relevant checks, and any migration or rollback step. Update the Quick Start or operations guide when configuration changes. Include one meaningful check for nontrivial parsing, security, or deployment logic. UI changes should include a local preview screenshot or clear reproduction steps.

Never commit real PVS serials, LAN or account details, telemetry, utility bills, `.env` files, upload tokens, OAuth secrets, Worker secrets, D1 exports, or queue databases. Use `example.com`, documentation IP addresses, and simulated readings in tests and screenshots. Report a suspected credential leak privately to the maintainer before opening a public issue.

The project uses the [MIT license](LICENSE); contributions are submitted under that license.
