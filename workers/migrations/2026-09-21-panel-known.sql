-- Known-panel inventory: one row per panel, maintained by the ingest.
--
-- `CREATE TABLE IF NOT EXISTS` never adds a table to an existing database, and
-- the ingest only starts writing this one once it is deployed, so run this file
-- once against each existing database, from workers/ingest, before deploying
-- the ingest that writes it:
--
--   npx wrangler d1 execute sunpower-monitor --remote --file ../../workers/migrations/2026-09-21-panel-known.sql
--
-- The dashboard reads the panel list from here instead of scanning every stored
-- sample for a distinct panel_id, which is a whole-partition read on every page
-- load. The backfill is a one-off scan of panel_sample, so the matrix keeps
-- listing every panel the site has already reported.

CREATE TABLE IF NOT EXISTS panel_known (
  collector_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  PRIMARY KEY (collector_id, panel_id)
);

INSERT OR IGNORE INTO panel_known (collector_id, panel_id, last_seen_ts)
SELECT collector_id, panel_id, MAX(slot_ts) FROM panel_sample GROUP BY collector_id, panel_id;
