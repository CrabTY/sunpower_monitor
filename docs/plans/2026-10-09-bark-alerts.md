# Bark Alerts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let each deployment optionally configure one Bark device entirely from Settings, with cloud checks for missing or invalid readings and recovery notifications.

**Architecture:** Dashboard owns authenticated configuration, encrypted D1 storage and a minute cron. Derive a domain-separated AES-GCM key from the existing session secret using HKDF. Persist incident, retry and lease state in the same per-collector settings row. Installation prompts, collector and ingest remain unchanged.

**Tech Stack:** Existing TypeScript Workers, D1 SQLite, Web Crypto, plain HTML/JavaScript and Node tests; no new dependencies.

---

## Task 1: Storage and notification behavior

Create `workers/dashboard/src/notifications.ts`, `workers/dashboard/test/notifications.test.ts`, and `workers/migrations/2026-10-09-notifications.sql`; add the table to `workers/schema.sql`. Cover encryption/tampering, scoped keys, missing data grace, stale measurements, sustained invalid quality, zero nighttime power, recovery, cancelled pending alerts, retry/permanent errors, rate limiting and overlapping requests using synthetic keys and a real SQLite adapter. Run `npm run check:types` and the focused Node test before broad checks.

## Task 2: Worker integration

Modify `workers/dashboard/src/index.ts` and `workers/dashboard/wrangler.toml.example`. Add private same-origin bounded GET/PUT/POST-test/DELETE notification APIs and the minute scheduled handler. Never return key material or provider responses. Regression-test anonymous/cross-origin requests and configuration rendering. Keep `install.sh`, ingest and collector unchanged.

## Task 3: Settings and preview

Modify `web/settings.html`, `web/settings.js`, preview fixtures and page-render checks. Provide test-and-enable, test, pause/resume, replacement and deletion, with accessible status/errors. Clear submitted key inputs, do not persist browser credentials, show stale scheduler status, and keep public preview inert. Test UI actions with fake responses.

## Task 4: Upgrade guidance and verification

Document the optional webpage workflow, additive migration, dashboard-only deployment, session-secret rotation, shared settings permissions and delivery limitations in `docs/notifications.md`, linked from operations/quick start. Run `npm run check`, local D1 checks and a dashboard dry-run with synthetic configuration. Review the diff for personal credentials and unrelated edits. Do not deploy or send real notifications as part of implementation.

## Verification completed

- Full `npm run check`: 97 unit tests, four configuration tests, browser/render/preview/static-site checks passed.
- Sixteen notification tests use real SQLite, including sustained measurement lag, recovery retry and concurrent checks. Development checks require Node.js 22.5+ for the built-in SQLite module; no dependency was added.
- Dashboard `wrangler deploy --dry-run` and local D1 API checks passed in a temporary checkout with synthetic account/database configuration. Existing local deployment configuration was not replaced.
- The browser preview rendered the notification card with disabled notification controls. UI smoke tests exercised enable, test, pause, resume, deletion and rejection without sending a real message.
- `install.sh`, collector and ingest source are unchanged. No production schema change, deployment or personal device configuration was performed.
