-- Additive, repeatable upgrade for optional webpage-configured Bark notifications.
CREATE TABLE IF NOT EXISTS site_notifications (
  collector_id TEXT PRIMARY KEY,
  device_key_cipher TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  enabled_ts INTEGER NOT NULL DEFAULT 0,
  observed_state TEXT NOT NULL DEFAULT 'normal',
  failure_since_ts INTEGER,
  notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
  recovery_count INTEGER NOT NULL DEFAULT 0,
  last_checked_ts INTEGER,
  last_sent_ts INTEGER,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_at_ts INTEGER NOT NULL DEFAULT 0,
  next_test_ts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until_ts INTEGER NOT NULL DEFAULT 0
);
