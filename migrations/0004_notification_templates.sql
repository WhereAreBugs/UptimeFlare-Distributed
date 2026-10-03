CREATE TABLE IF NOT EXISTS notification_state (
  monitor_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL,
  down_since INTEGER,
  observed_at INTEGER NOT NULL,
  version INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notification_outbox (
  event_id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_key TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS notification_ready ON notification_outbox(next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS notification_order ON notification_outbox(monitor_id, sequence);
