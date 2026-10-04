CREATE TABLE IF NOT EXISTS notification_observations (
  monitor_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL,
  down_since INTEGER,
  sample_time INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
