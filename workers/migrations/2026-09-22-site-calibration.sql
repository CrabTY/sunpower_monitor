CREATE TABLE IF NOT EXISTS site_calibration (
  collector_id TEXT PRIMARY KEY,
  grid_ratio REAL NOT NULL CHECK (grid_ratio BETWEEN 0.1 AND 2.0),
  updated_ts INTEGER NOT NULL
);
