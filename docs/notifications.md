# Optional phone notifications

Phone notifications are configured after installation in the private dashboard's **Settings → Phone notifications**. They are off by default. There are no new `install.sh` prompts, environment variables, Cloudflare credentials or Worker secrets to configure.

## Enable from Settings

1. Install [Bark](https://bark.day.app/) on your iPhone, allow notifications and copy your device Key.
2. Sign in to your own SunPower Monitor dashboard. In Settings, paste that Key and select **Test and enable**.
3. Check your phone for **SunPower notification test**. The page reports submission to Bark, not confirmed phone delivery. Background checks start automatically; the page can be closed.

**Send test** uses the saved device without changing monitoring. **Pause notifications** retains the encrypted Key but clears pending incidents. **Test and enable** resumes monitoring with a fresh ten-minute grace period. To replace the device, paste its new Key and select **Test and save device**; a failed test keeps the previous configuration. **Delete configuration** removes the Key and pending incident from the active database (existing backups are not rewritten). Already submitted notifications cannot be recalled.

Tests and enable requests are limited to one per 30 seconds per collector, including after deleting configuration. A brief database lease serializes tests, edits and scheduled checks; if an operation is busy, wait and try again. Existing GitHub allowlist permissions apply: all users allowed into Settings can change this installation's single receiving device.

## What triggers an alert

- A missing live row, or site collection/upload times that have stopped advancing, triggers one alert after ten minutes. A newly enabled configuration receives a ten-minute grace period, including if the collector has never uploaded.
- Stale measurement times, missing measurement times or sustained non-`ok` quality trigger an alert after ten minutes. A transient failure does not. Zero solar power at night is healthy when current valid site measurements continue.
- Three consecutive normal checks, one minute apart, trigger a recovery notification only if the incident alert was successfully submitted. Old records replayed after an outage cannot count as recovery.
- One incident sends one alert. A change in fault type during the same incident does not send another. An unsent alert is cancelled if valid readings resume. A new incident after recovery can alert again.

Notifications identify missing or invalid **site readings**; they cannot conclusively identify a powered-off collector versus a network or PVS failure. Panel-specific performance and power-value anomaly detection are not part of this feature.

Settings shows the last background check, last submitted notification and safe delivery errors. If checks stop updating for more than three minutes, it shows that background checks may have stopped. This is visible when the page is open; a stopped cloud monitor cannot notify about its own failure.

## Storage and delivery

The dashboard Worker stores configuration and incident state in `site_notifications`, scoped to `COLLECTOR_ID`. It derives a separate AES-256-GCM key from the existing `SESSION_SECRET` using HKDF, uses a random nonce for each encryption and authenticates the collector ID. The Key is not returned by read APIs, saved in browser storage, embedded in the frontend or logged. Keep the session secret when redeploying; rotating it makes saved Keys unreadable. Paste the Bark Key again to recover. Encrypted backup restoration also needs the original session secret.

The server sends fixed-format JSON to `https://api.day.app/push`. Notification text and the device Key pass through Bark; delivery uses Apple push notifications. Default messages contain generic diagnostic information without address, account IDs, household power values or dashboard links. See [Bark's API](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md).

Network/server failures retry after 1, 2, 4, 8, 16, 32 and then at most every 60 minutes. Permanent rejection or an unreadable Key pauses notifications and exposes an actionable error in Settings. Submitting a new tested configuration clears the error. HTTP and Bark response codes are checked. A 10-second request timeout and database leases bound each operation. A crash after Bark accepts a request but before the database acknowledgement can duplicate a message; acceptance also does not guarantee delivery to a phone. Normal notifications respect the phone's notification/Focus settings.

The minute cron is deployed with the dashboard. Disabled deployments still use approximately 1,440 small Worker invocations and indexed configuration reads per day, but perform no telemetry queries or notification requests. These count toward the deployment's Cloudflare quotas. The public preview is read only and cannot send notifications.

## Upgrade an existing deployment

Use the reviewed source and existing deployment configuration, as described in [Operations](operations.md#upgrade-an-existing-deployment). Back up D1 first. Apply only the additive notifications migration to your own database, then deploy the dashboard Worker with its existing secrets and assets:

```sh
npm ci
npm run check
npm run config
(cd workers/dashboard && npx wrangler deploy --dry-run)
(cd workers/dashboard && npx wrangler d1 execute DB --remote --file=../migrations/2026-10-09-notifications.sql)
(cd workers/dashboard && npx wrangler deploy)
```

The SQL creates one new table and is safe to repeat. It does not alter or delete telemetry. New installations get the table from `workers/schema.sql`; the existing manual deployment workflow applies that baseline too. Collector and ingest updates are unnecessary for this feature. Do not rerun the installer or replace login/upload secrets.

Cloudflare Cron changes can take up to 15 minutes to propagate ([documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). Verify that the last background check starts advancing after enabling notifications, then check your own phone. A schema/code upgrade is required once; later configuration changes take effect on the next check without another deployment. Rollback to the previous dashboard code can leave the additive table in place; its old template has no notification Cron.
