# Documentation

These documents describe the current installation and code. Start with the guide for your task.

| Task | Guide |
| --- | --- |
| Install from a published Release | [Quick Start](quick-start.md) |
| Configure and deploy manually | [Manual installation](manual-installation.md) |
| Upgrade, back up and recover | [Operations](operations.md) |
| Understand components and data boundaries | [Architecture](architecture.md) |
| Understand CT coverage and display calibration | [CT guide, Chinese](ct-calibration.md) |
| Review security checks, remediation and limits | [Security review](security-review.md) |
| Find protocol/UI sources and reviewed versions | [Reference projects](references.md) |
| Develop with simulated dashboard readings | [Local preview](preview.md), [Contributing](../CONTRIBUTING.md) |

## Separate introduction site

The Chinese/English introduction source lives in [site/](../site/), alongside its styles, script and simulated screenshots. It is not an online website link; the introduction and demo have not been hosted yet. Run `npm run preview` and open `http://127.0.0.1:4173/introduction/` to view it, or run `npm run build:site` and serve `dist/site/` to include the read-only simulated demo.

## Images

`screenshots/` holds the installation/login examples referenced by the Quick Start. Product interface screenshots belong to `site/assets/`. The CT guide reuses three original conceptual diagrams in `site/assets/`; they are not wiring or installation instructions. Unlicensed product photographs are excluded from the current release tree.
