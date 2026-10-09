# SunPower Monitor

**A private solar dashboard with live power, energy history, and individual-panel monitoring for SunPower PVS6.**

[![Checks](https://github.com/CrabTY/sunpower_monitor/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/CrabTY/sunpower_monitor/actions/workflows/check.yml)
[![Security checks](https://github.com/CrabTY/sunpower_monitor/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/CrabTY/sunpower_monitor/actions/workflows/security.yml)
[![GitHub Pages](https://github.com/CrabTY/sunpower_monitor/actions/workflows/pages.yml/badge.svg?branch=main)](https://crabty.github.io/sunpower_monitor/)
[![Release](https://img.shields.io/github/v/release/CrabTY/sunpower_monitor)](https://github.com/CrabTY/sunpower_monitor/releases/latest)
[![Live demo](https://img.shields.io/badge/demo-live-green)](https://crabty.github.io/sunpower_monitor/demo/?scenario=day)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Website](https://crabty.github.io/sunpower_monitor/) · [Live demo](https://crabty.github.io/sunpower_monitor/demo/?scenario=day) · [Installation](#installation) · [Dashboard tour](#dashboard-tour) · [Compatibility](#gateway-compatibility) · [FAQ](#frequently-asked-questions) · [Documentation](docs/README.md) · [Acknowledgements](#acknowledgements)

SunPower Monitor helps you see what your solar system is doing now, how its energy use changes over time, and how each panel performs. It reads your PVS6 on the home network, records history, and serves a dashboard you can open on a computer or phone, including when you are away from home.

A small collector runs on your Raspberry Pi, NAS, or Linux host. Your own Cloudflare account stores the readings and hosts the dashboard; GitHub login limits access to the people you allow. Collection is read-only and does not require a SunPower cloud account.

![Live dashboard showing solar production, home load, grid flow, and daylight context](site/assets/live.png)

*All screenshots show the actual dashboard with simulated readings, not household data. [View the mobile screenshot](site/assets/mobile.png).*

## Gateway compatibility

The hardware-verified configuration is **SunPower PVS6 firmware `2025.10.20.61846`, without a battery**. The installer performs a read-only device check before starting collection. Other PVS6 builds and newer PVS5 gateways using the official varserver API are compatibility candidates: the collector accepts the documented response formats and checks available fields, without restricting collection to one firmware number. PVS5 has not been hardware-verified here. PVS2, other vendors, and battery systems remain outside the supported installation path. See [compatibility evidence and the read-only check](docs/pvs-compatibility.md).

The collector must reach the PVS over your LAN. It handles the verified firmware's local authentication; it does not commission the system, provision devices, or change PVS settings. Home and grid readings depend on your installed consumption current transformers (CTs); see the [CT coverage and calibration guide](docs/ct-calibration.md).

## Installation

### What you need

| You need | Purpose |
| --- | --- |
| A PVS6 reachable on the collector's LAN | Supplies the measurements |
| An always-on ARM64 or AMD64 Linux host with Docker | Runs the collector and installer |
| A Cloudflare account with Workers and D1 | Hosts the private dashboard and history |
| A GitHub account and OAuth App | Signs allowed users into the dashboard |

You can use Cloudflare's `workers.dev` address without a custom domain. Home Assistant and a separate database server on the collector host are not required.

### Set up your dashboard

> Source code and the v0.1.0 Release installer are public. The collector image is still private, so automated installation is not available yet. Follow the [manual installation guide](docs/manual-installation.md) to build or run from source.

For a published version, follow the [Quick Start](docs/quick-start.md):

1. Download `install.sh` and `SHA256SUMS` from the same [GitHub Release](https://github.com/CrabTY/sunpower_monitor/releases) onto the collector host.
2. Verify the installer and run it in that host's terminal:

   ```sh
   sha256sum --check --ignore-missing SHA256SUMS && bash install.sh
   ```

3. Follow the browser prompts to authorize Cloudflare, register the GitHub OAuth App, and verify dashboard login.
4. Enter the PVS LAN address and let the installer check the device and start the collector.

The Release installer fixes the source commit and collector image digest; Docker selects the host architecture. Keep the collector-host terminal open while completing browser tasks on your computer or phone. Your personal computer needs only a browser.

For an existing installation, follow [Operations](docs/operations.md) before upgrading so that credentials, queued records, and stored history are preserved.

## Dashboard tour

### Live: power right now

The Live page shows solar production, estimated home load, and grid direction together. Positive grid power means import; negative grid power means export. The chart lets you inspect the last hour, day so far, daylight, or a selected time range.

Readings include freshness information. A stale or missing sample is not presented as a new reading. Optional weather and daylight context come from Open-Meteo and remain separate from measured power.

### History: energy over time

![Seven-day energy history with daily solar production, grid import and export, and weather context](site/assets/history.jpg)

Explore a day, week, month, year, or exact time range. Switch between power in kW and energy in kWh, inspect individual windows, and see the sources and destinations of energy. History starts when your collector begins recording; the dashboard does not retrieve earlier SunPower cloud history.

Site energy totals are estimates from valid power samples. Missing intervals stay visible instead of becoming zero consumption or production. Weather overlays can help compare sunny and cloudy periods.

### Panels: individual output and recorded history

![Panel overview and individual-panel power history](site/assets/panels.png)

Select a panel or compare the array, inspect recorded five-minute samples, and view daily production for a selected panel. The display distinguishes panels producing now, finished for the day, without production, and not reporting while the rest of the array reports.

| Available diagnostic | Meaning |
| --- | --- |
| AC power | Microinverter output |
| DC power, voltage, and current | Panel-side readings |
| AC voltage and current | Inverter-side readings |
| Heatsink temperature | Reported inverter temperature |
| Recorded energy | Stored cumulative-counter readings and their coverage |

Diagnostics appear when the PVS supplies a valid value. A panel that stops reporting may have a device problem or a failed read; the dashboard cannot determine the cause from missing data alone.

### Settings: notifications, location and calibration

**Optional iPhone alerts with [Bark](https://github.com/Finb/Bark).** SunPower Monitor detects missing or invalid site readings; Bark delivers the phone notifications. After ten minutes of missing or invalid readings, you receive one alert for the ongoing fault. Three consecutive normal background checks trigger a recovery notification.

Notifications are off by default. Enable them after installing your dashboard:

1. Install [Bark](https://bark.day.app/) on your iPhone, allow notifications, and copy your own device Key from the app.
2. Sign in to your dashboard and open **Settings → Phone notifications**. Paste the Key (not the full push URL) and select **Test and enable**.
3. Confirm that **SunPower notification test** arrives on your phone. Settings shows **Enabled** and, once the first scheduled check completes, **Background checks: Running**. Monitoring continues when you close the webpage.

The dashboard stores your Key encrypted and checks readings every minute. This optional setup adds no `install.sh` steps. See the [Bark notification guide](docs/notifications.md) for Key examples, delivery limits, and the database/Worker upgrade required for existing installations.

Set the site's location and time zone for daylight and local-date views. Display calibration can correct a verified, stable grid-reading ratio after comparison with utility-meter data. It adjusts the displayed grid reading and corresponding home-load estimate, preserves raw records, and leaves solar production unchanged. See the [calibration procedure](docs/ct-calibration.md) before changing the ratio.

## How it works

```text
PVS6 on your LAN → Collector + local SQLite queue → Cloudflare Workers + D1
                                                           ↓
                                                Private browser dashboard
```

Only the collector contacts the PVS. It uploads over outbound HTTPS, so remote viewing does not require opening an inbound route to your home network. Recorded history queues locally during an Internet outage and retries when connectivity returns; live snapshots resume with current readings. The [architecture guide](docs/architecture.md) describes the data flow and authentication boundaries.

## Frequently asked questions

**Can I use it without installing anything first?**
Yes: [open the read-only live demo](https://crabty.github.io/sunpower_monitor/demo/?scenario=day). It uses the same dashboard code with simulated readings, without a PVS, Cloudflare deployment, account, or household data. Developers can also [preview it locally](docs/preview.md).

**Does it run entirely offline?**
PVS collection happens locally, but the hosted dashboard requires Cloudflare and an Internet connection. Historical records queue on the collector during a connection outage. Latest live snapshots are not replayed as history.

**Can I view my system while away from home?**
Yes, through your Cloudflare-hosted dashboard after GitHub login. Access is limited by the configured GitHub user allowlist.

**Why do home consumption or grid readings differ from my utility meter?**
CT coverage, sample timing, and the distinction between instantaneous power and interval energy can affect the comparison. A stable proportional error may be suitable for display calibration; a missing electrical branch cannot generally be recovered with one fixed ratio. Start with the [CT guide](docs/ct-calibration.md).

**Can I use this to identify a failed panel?**
Panel comparisons and history help investigate unusual output, but shading, night, device faults, and failed reads can produce similar symptoms. Check the available measurements and their timestamps before treating a display state as a diagnosis.

**Do I need Home Assistant?**
No. This collector and dashboard work independently. Home Assistant integrations and other community approaches are listed in [References](docs/references.md).

## Documentation

| Looking for | Read |
| --- | --- |
| Directory structure and script topics | [Project layout](docs/project-layout.md) |
| Setup and first readings | [Quick Start](docs/quick-start.md) |
| Workstation deployment or a direct Python service | [Manual installation](docs/manual-installation.md), [Operations](docs/operations.md) |
| Updates and redeployment | [Upgrade steps](docs/operations.md#upgrade-an-existing-deployment) |
| Backups and recovery | [Operations](docs/operations.md) |
| Optional iPhone alerts configured from Settings | [Bark phone notifications](docs/notifications.md) |
| Collector, cloud, and authentication design | [Architecture](docs/architecture.md) |
| CT coverage and display calibration | [CT guide, Chinese](docs/ct-calibration.md) |
| Simulated dashboard for local development | [Preview](docs/preview.md) |

The [documentation index](docs/README.md) also links the bilingual introduction, comparison, and technical references.

## Security

The [security review](docs/security-review.md) records the source review, fixes, automated checks, and their limits. GitHub Actions is configured to run dependency auditing, Semgrep, and Gitleaks on pull requests, main updates, and weekly. The release workflow requires those checks before publishing artifacts. These checks passed for the v0.1.0 release. The badge shows the latest main-branch results; passing checks are not a security certification.

Keep deployment credentials and household telemetry private. Use GitHub private vulnerability reporting when enabled, and avoid posting sensitive details in public issues.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull requests. You can work on the dashboard using simulated readings without a PVS or production Cloudflare account.

## Acknowledgements

This project benefited from the work shared by the following project owners and their contributors. Thank you for documenting local PVS access, sharing collector implementations and dashboard designs, and providing phone notification delivery.

| Project | Project owner | Contribution to this project |
| --- | --- | --- |
| [PyPVS and local API documentation](https://github.com/SunStrong-Management/pypvs) | [SunStrong Management](https://github.com/SunStrong-Management) | Official protocol reference for local authentication, session cookies, query/cache parameters and request-pacing guidance, cited in the compatibility and sampling explanations. |
| [sunpower-monitor](https://github.com/karak2112/sunpower-monitor) | [karak2112](https://github.com/karak2112) | Primary reference for 61846 authentication, focused varserver queries, parser behavior and tests; also reviewed for dashboard presentation. |
| [SunPower-PVS-Supervisor](https://github.com/steveturbek/SunPower-PVS-Supervisor) | [steveturbek](https://github.com/steveturbek) | PVS field examples, inverter AC-power interpretation and cumulative-energy readings. |
| [PVS Watch](https://github.com/timkatz/pvswatch) | [timkatz](https://github.com/timkatz) | Missing-energy semantics, nighttime behavior, session renewal and panel-chart references. |
| [ha-esunpower](https://github.com/smcneece/ha-esunpower) | [smcneece](https://github.com/smcneece) | Newer-firmware handling, temporary missing-inverter behavior and AC/DC field separation. |
| [SunPower Web Monitor](https://github.com/thomastech/SunPower-Web-Monitor) | [thomastech](https://github.com/thomastech) | Newer-firmware authentication proxy and current-reading dashboard reference. |
| [pvs6-liberation](https://github.com/jschwerdtfeger/pvs6-liberation) | [jschwerdtfeger](https://github.com/jschwerdtfeger) | Local API documentation and examples used for protocol checks. |
| [dash-sunpower](https://github.com/strawtype/dash-sunpower) | [strawtype](https://github.com/strawtype) | Historical replay and panel-layout ideas. |
| [Solar Sentinel](https://github.com/smcneece/solar-sentinel) | [smcneece](https://github.com/smcneece) | Panel matrix, daylight arc, time slider and individual-panel history design references. |
| [SOLECTRUS](https://github.com/solectrus/solectrus) | [SOLECTRUS community](https://github.com/solectrus) | Additional solar-dashboard presentation reference. |
| [Bark](https://github.com/Finb/Bark) | [Finb](https://github.com/Finb) | Open-source iOS app and push API used to deliver optional alert and recovery notifications. |

See [References](docs/references.md) for the detailed comparisons, reviewed source revisions and recorded licenses, and [Bark's documentation](https://bark.day.app/) for its app and push API.

## Support and license

Maintained by [CrabTY](https://github.com/CrabTY). If the project is useful to you, you can [support its development on Ko-fi](https://ko-fi.com/crabty).

Project code and original documentation are [MIT licensed](LICENSE). Third-party components retain their own license notices. Optional weather data is subject to Open-Meteo's service terms.
