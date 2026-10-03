-- One bounded schedule row per active built-in/native target, plus one native state writer lease.
CREATE TABLE IF NOT EXISTS monitor_schedule (
  scope TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  configuration_key TEXT NOT NULL,
  last_started_at INTEGER NOT NULL,
  last_completed_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (scope, monitor_id)
) WITHOUT ROWID;
