# Documentation

These documents describe the current installation and code. Start with the guide for your task.

| Task | Guide |
| --- | --- |
| Find source, script topics, generated output and local data | [Project layout](project-layout.md) |
| Install from a published Release | [Quick Start](quick-start.md) |
| Configure and deploy manually | [Manual installation](manual-installation.md) |
| Update and redeploy an existing installation | [Upgrade steps](operations.md#upgrade-an-existing-deployment) |
| Back up and recover | [Operations](operations.md) |
| Understand components and data boundaries | [Architecture](architecture.md) |
| Understand CT coverage and display calibration | [CT guide, Chinese](ct-calibration.md) |
| Review security checks, remediation and limits | [Security review](security-review.md) |
| Find protocol/UI sources and reviewed versions | [Reference projects](references.md) |
| Develop with simulated dashboard readings | [Local preview](preview.md), [Contributing](../CONTRIBUTING.md) |

## Separate introduction site

Open the [Chinese/English introduction website](https://crabty.github.io/sunpower_monitor/) or the [read-only live demo](https://crabty.github.io/sunpower_monitor/demo/?scenario=day). Their source lives in [site/](../site/), alongside its styles, script and simulated screenshots; the demo reuses `web/`. For local development, run `npm run preview` and open `http://127.0.0.1:4173/introduction/`, or run `npm run build:site` and serve `dist/site/` to include the demo.

## Images

`screenshots/` holds the installation/login examples referenced by the Quick Start. Product interface screenshots belong to `site/assets/`. The CT guide reuses three original conceptual diagrams in `site/assets/`; they are not wiring or installation instructions. Unlicensed product photographs are excluded from the current release tree.
