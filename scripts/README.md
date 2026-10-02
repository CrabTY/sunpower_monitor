# Project scripts

Run commands from the repository root. The `npm run` entry points remain stable;
these folders group the implementation by purpose.

| Folder | Purpose | Files |
| --- | --- | --- |
| `install/` | Installer account/identity lookup, configuration rendering and deployed-origin discovery | `cloudflare-account.mjs`, `github-user.mjs`, `render-config.mjs`, `worker-origin.mjs` |
| `release/` | Generate the installer with a fixed source revision and collector image digest | `prepare-release.py` |
| `preview/` | Local preview, shared synthetic readings and the public static-site build | `preview.mjs`, `preview-client.js`, `build-site.mjs` |
| `checks/` | Installer, configuration, browser, static-site, local D1 and Git-hook checks | The eight check files in this folder |

Common commands:

```sh
npm run check
npm run preview
npm run build:site
```

Optional maintenance checks:

```sh
npm run check:local
npm run check:types && npm run check:month
python3 scripts/checks/check-graph-hook.py
```

`check:local` renders configuration from your local `.env` and uses temporary
local D1 state; `check:month` uses temporary local state and synthetic data.
Neither check deploys Workers or writes to a remote database. Keep rendered
configuration, build output and household data ignored.
