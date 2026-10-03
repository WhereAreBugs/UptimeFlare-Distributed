CREATE TABLE IF NOT EXISTS uptimeflare (
    key VARCHAR(255) PRIMARY KEY,
    value BLOB NOT NULL
);
-- Independent tables: probe ingestion never rewrites the native compacted state.
CREATE TABLE IF NOT EXISTS probe_samples (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  up INTEGER NOT NULL CHECK (up IN (0, 1)),
  latency_ms REAL NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (probe_id, monitor_id, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_samples_retention ON probe_samples(time);
CREATE INDEX IF NOT EXISTS probe_failures ON probe_samples(probe_id, monitor_id, time DESC) WHERE up = 0;
CREATE TABLE IF NOT EXISTS probe_latest (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  up INTEGER NOT NULL,
  latency_ms REAL NOT NULL,
  stage TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (probe_id, monitor_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS probe_buckets (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  latency_sum REAL NOT NULL,
  PRIMARY KEY (probe_id, monitor_id, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_buckets_retention ON probe_buckets(time);
CREATE TABLE IF NOT EXISTS probe_bucket_stages (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  stage TEXT NOT NULL,
  failures INTEGER NOT NULL,
  PRIMARY KEY (probe_id, monitor_id, time, stage)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_bucket_stages_retention ON probe_bucket_stages(time);
CREATE TABLE IF NOT EXISTS probe_totals (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  latency_sum REAL NOT NULL,
  PRIMARY KEY (probe_id, monitor_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS probe_stage_totals (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  failures INTEGER NOT NULL,
  PRIMARY KEY (probe_id, monitor_id, stage)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS admin_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  address TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS admin_login_retention ON admin_login_attempts(window);

CREATE TABLE IF NOT EXISTS probe_metadata (
  probe_id TEXT PRIMARY KEY,
  default_name TEXT NOT NULL,
  default_location TEXT NOT NULL
) WITHOUT ROWID;
