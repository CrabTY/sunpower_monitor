# Local preview with simulated data

Try the [project introduction](https://crabty.github.io/sunpower-monitor/) or [read-only simulated demo](https://crabty.github.io/sunpower-monitor/demo/?scenario=day) online. The steps below describe local development and reproduction.

The preview loads the current worktree's `web/` pages with fixed simulated API data for Live, History, Panels and Settings. It **does not export real history from the production D1 database** or request or modify production APIs. Use it to compare page states repeatedly; it cannot establish actual production or validate database queries.

## Start the preview

Use Node.js 22.5 or newer. Install dependencies and start from the repository root:

```sh
npm ci
npm run preview
```

Open <http://127.0.0.1:4173/>. The top banner says `Simulated data · local review` and lets you select a scenario. The browser keeps that selection across page navigation. If port 4173 is occupied, run `PORT=4174 npm run preview` and open the corresponding port. Stop with `Ctrl-C`.

| Scenario | Fixed time in America/Los_Angeles | What to review |
| --- | --- | --- |
| Night | 2026-09-23 00:45 PDT | Tiny nighttime readings, the 0.5 kW minimum Live/History scale, and Panels waiting for daylight |
| Day | 2026-09-22 14:00 PDT | Normal daytime curves, with 19 of 21 panels producing and two not reporting |
| Day without output | 2026-09-22 14:00 PDT | Daytime samples with zero output, compared with Night before the day's sampling begins |

You can also select a scenario directly with `/?scenario=night`, `/?scenario=day` or `/?scenario=idle`, then navigate to History or Panels.

## Data coverage and implementation

- Simulated data starts on 2026-08-24 at 00:00 PDT. It generates site power and cumulative energy every minute, panel readings every five minutes, and hourly weather, sunrise/sunset and sunshine duration. History's minute, five-minute and daily views use the same data.
- Clouds reduce output on 2026-09-19. A source-error interval on 2026-09-21 from 10:30 to 11:05 PDT exercises history gaps. Night includes tiny readings displayed as `0.0 kW`.
- The server is [`scripts/preview/preview.mjs`](../scripts/preview/preview.mjs). Data generation, the fixed clock and in-browser `/api/v1/*` replacements are in [`scripts/preview/preview-client.js`](../scripts/preview/preview-client.js). Pages load the current `web/` files, so refresh after editing the frontend.
- The dataset covers about 30 days for Today, Week, Month and custom-date checks. Year still has only that simulated coverage, and the page identifies missing periods. The fixed PDT preview does not test daylight-saving transitions.

Run `npm run check:preview` to check the three scenarios and panel-data consistency. `npm run check` runs the repository's full set of checks.

## Project introduction

The same server exposes four public pages under `/introduction/`: overview, getting started, comparison and project details. They remain bilingual; `?lang=en` selects English and `?lang=zh` selects Chinese. Source lives separately in `site/`, using simulated interface screenshots from `site/assets/` without accessing household data.

## Static demo artifact

```sh
npm run build:site
python3 -m http.server 4174 --bind 127.0.0.1 --directory dist/site
```

Open <http://127.0.0.1:4174/> and enter the demo from the introduction. `dist/site/` is a disposable, reproducible build artifact, not another source tree. It can be hosted at a domain root or a GitHub Pages project subpath. Publish that directory; configure the domain and GitHub About website address after verifying publication.

The demo reuses `web/` and the same simulated data. All APIs respond inside the browser without connecting to a PVS or Cloudflare. Unmocked network requests are rejected, and Settings controls and geolocation are disabled. Displayed coordinates are an example at the center of San Francisco. The production dashboard requires login and uses each owner's deployment and data.

### GitHub Pages

The introduction and simulated demo use this repository's `.github/workflows/pages.yml`, which publishes only generated `dist/site/`. No separate source repository, committed build output or `gh-pages` branch is needed.

This repository is already published on GitHub Pages with **Settings → Pages → Source** set to **GitHub Actions**. For your own repository, first meet the applicable Pages plan/visibility requirements and select the same publishing source. The workflow does not change repository visibility or enable Pages automatically.

A manual `pages` run with `publish` unchecked verifies security checks, the build and a temporary Pages artifact. Checking `publish` also publishes the site. After initial publication, relevant `main` updates in a public repository publish automatically; failed security checks block publication. Pushes in private repositories validate the build without automatic publication.

The homepage is `https://crabty.github.io/sunpower-monitor/`, with the demo under `demo/`. README and GitHub About use those verified addresses. For another repository, verify links against the workflow's actual `page_url`. GitHub Pages does not read Cloudflare's `_headers`; the demo's network restrictions use HTML CSP and browser replacements, while settings and real geolocation remain disabled.
