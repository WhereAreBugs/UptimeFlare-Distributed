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

-- Daily rollups keep public ninety-day history reads bounded to ninety rows per assignment.
CREATE TABLE IF NOT EXISTS probe_days (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  checks INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  latency_checks INTEGER NOT NULL,
  latency_sum REAL NOT NULL,
  PRIMARY KEY (probe_id, monitor_id, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_days_retention ON probe_days(time);
-- Recompute, rather than increment, so applying init/migration again cannot double count.
INSERT INTO probe_days (probe_id,monitor_id,time,checks,failures,latency_checks,latency_sum)
SELECT probe_id,monitor_id,CAST(time/86400 AS INTEGER)*86400,SUM(checks),SUM(failures),
  SUM(CASE WHEN failures=0 THEN checks ELSE 0 END),
  SUM(CASE WHEN failures=0 THEN latency_sum ELSE 0 END)
FROM probe_buckets WHERE 1 GROUP BY probe_id,monitor_id,CAST(time/86400 AS INTEGER)*86400
ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=excluded.checks,
  failures=excluded.failures,latency_checks=excluded.latency_checks,latency_sum=excluded.latency_sum;
-- Optional measurements are sparse. Ordinary HTTP/TCP checks consume no extra metadata rows.
CREATE TABLE IF NOT EXISTS probe_sample_details (
  probe_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  time INTEGER NOT NULL,
  details TEXT NOT NULL,
  PRIMARY KEY (probe_id, monitor_id, time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_sample_details_retention ON probe_sample_details(time);

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

-- Management credentials never enter the editable configuration or public status response.
CREATE TABLE IF NOT EXISTS management_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  group_ids TEXT NOT NULL,
  permissions INTEGER NOT NULL CHECK (permissions BETWEEN 1 AND 3),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS management_tokens_retention ON management_tokens(created_at);
