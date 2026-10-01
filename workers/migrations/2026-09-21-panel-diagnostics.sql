-- Inverter diagnostics on panel_sample.
--
-- schema.sql adds these columns for a fresh database, but `CREATE TABLE IF NOT
-- EXISTS` never alters an existing one, and D1's SQLite has no
-- `ADD COLUMN IF NOT EXISTS`. Run this file once against each existing
-- database, from workers/ingest:
--
--   npx wrangler d1 execute sunpower-monitor --remote --file ../../workers/migrations/2026-09-21-panel-diagnostics.sql
--
-- Existing rows keep NULL for every added column: the collector never
-- backfills a measurement it did not take.

ALTER TABLE panel_sample ADD COLUMN dc_kw REAL;
ALTER TABLE panel_sample ADD COLUMN dc_v REAL;
ALTER TABLE panel_sample ADD COLUMN dc_a REAL;
ALTER TABLE panel_sample ADD COLUMN ac_v REAL;
ALTER TABLE panel_sample ADD COLUMN ac_a REAL;
ALTER TABLE panel_sample ADD COLUMN heatsink_c REAL;
