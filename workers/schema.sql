-- D1 schema for the sunpower-monitor database (both Workers bind this DB).
-- Times are integer UTC epoch seconds; the API converts to ISO strings.
-- Apply with: wrangler d1 execute sunpower-monitor --local --file=../schema.sql

CREATE TABLE IF NOT EXISTS latest_site (
  collector_id TEXT PRIMARY KEY,
  collected_ts INTEGER NOT NULL,
  measured_ts INTEGER,
  received_ts INTEGER NOT NULL,
  quality TEXT NOT NULL,
  pv_kw REAL,
  load_kw_reported REAL,
  grid_kw REAL,
  battery_kw REAL,
  pv_kwh_total REAL,
  load_kwh_total_reported REAL,
  grid_net_kwh_total REAL
);

CREATE TABLE IF NOT EXISTS site_minute (
  collector_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  window_end_ts INTEGER,
  sample_count INTEGER NOT NULL,
  valid_count INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  quality TEXT NOT NULL,
  pv_kw_avg REAL,
  load_kw_reported_avg REAL,
  grid_kw_avg REAL,
  battery_kw_avg REAL,
  valid_counts_json TEXT,
  pv_kwh_total_end REAL,
  load_kwh_total_reported_end REAL,
  grid_net_kwh_total_end REAL,
  last_measured_ts INTEGER,
  digest TEXT NOT NULL,
  received_ts INTEGER NOT NULL,
  PRIMARY KEY (collector_id, minute_ts)
);

-- One site-local daily view for long history ranges. Minute rows remain the
-- source of truth; the hourly cron refreshes today and fills older gaps.
CREATE TABLE IF NOT EXISTS site_day (
  collector_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  windows INTEGER NOT NULL,
  ok_windows INTEGER NOT NULL,
  source_error_windows INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  valid_count INTEGER NOT NULL,
  pv_kw_avg REAL,
  load_kw_reported_avg REAL,
  grid_kw_avg REAL,
  battery_kw_avg REAL,
  pv_kwh_total_end REAL,
  last_measured_ts INTEGER,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (collector_id, local_date)
);

CREATE TABLE IF NOT EXISTS panel_sample (
  collector_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  slot_ts INTEGER NOT NULL,
  ac_kw REAL,
  energy_kwh_total REAL,
  dc_kw REAL,
  dc_v REAL,
  dc_a REAL,
  ac_v REAL,
  ac_a REAL,
  heatsink_c REAL,
  measured_ts INTEGER,
  quality TEXT NOT NULL,
  digest TEXT NOT NULL,
  received_ts INTEGER NOT NULL,
  PRIMARY KEY (collector_id, panel_id, slot_ts)
);

-- Known panels, one row per panel, so the matrix can list a panel that stopped
-- reporting without walking every stored sample to discover the panel list.
-- The ingest writes a row the first time it sees a panel and never rewrites it
-- (a per-slot upsert cost 2 rows written per panel per slot); the newest slot
-- comes from panel_sample, and the dashboard reads O(panels).
CREATE TABLE IF NOT EXISTS panel_known (
  collector_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  PRIMARY KEY (collector_id, panel_id)
);

-- latest_panel retired: nothing ever wrote or read it. The dashboard reads the
-- newest slot straight from panel_sample. The drop makes existing databases
-- match this file; it is a no-op once applied.
DROP TABLE IF EXISTS latest_panel;

CREATE TABLE IF NOT EXISTS collector_event (
  event_id TEXT PRIMARY KEY,
  collector_id TEXT NOT NULL,
  event_ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  details_code TEXT,
  digest TEXT NOT NULL,
  received_ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS collector_event_by_collector ON collector_event (collector_id, event_ts);

-- The dashboard asks for the newest stored slot and for every slot inside a day
-- range. Without this index both can scan the collector's whole partition.
CREATE INDEX IF NOT EXISTS panel_sample_by_slot ON panel_sample (collector_id, slot_ts, panel_id);

CREATE TABLE IF NOT EXISTS site_location (
  collector_id TEXT PRIMARY KEY,
  latitude REAL,
  longitude REAL,
  timezone TEXT,
  source TEXT,
  updated_ts INTEGER NOT NULL
);

-- PVS net-grid power divided by utility net-grid power. Telemetry remains raw.
CREATE TABLE IF NOT EXISTS site_calibration (
  collector_id TEXT PRIMARY KEY,
  grid_ratio REAL NOT NULL CHECK (grid_ratio BETWEEN 0.1 AND 2.0),
  updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_hour (
  collector_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  temperature_c REAL,
  weather_code INTEGER,
  cloud_cover_pct REAL,
  precipitation_mm REAL,
  precipitation_probability_pct REAL,
  uv_index REAL,
  source TEXT NOT NULL,
  fetched_ts INTEGER NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY (collector_id, hour_ts, kind)
);

-- Hourly modeled sunshine duration, aligned with the UTC weather forecast.
-- Keeping it by hour lets the dashboard total it by the site's local date.
CREATE TABLE IF NOT EXISTS weather_sunshine_hour (
  collector_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,
  sunshine_seconds REAL CHECK (sunshine_seconds IS NULL OR sunshine_seconds BETWEEN 0 AND 3600),
  PRIMARY KEY (collector_id, hour_ts)
);
