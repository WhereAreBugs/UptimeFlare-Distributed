-- Additive migration. Legacy tables remain available until explicit rollback/retention decisions.
CREATE TABLE IF NOT EXISTS storage_versions (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, migrated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commit_leases (scope TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commit_runs (run_id TEXT PRIMARY KEY, protocol INTEGER NOT NULL, payload_hash TEXT NOT NULL, committed_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS commit_runs_retention ON commit_runs(committed_at);
CREATE TABLE IF NOT EXISTS native_hot (monitor_id TEXT PRIMARY KEY, time INTEGER NOT NULL, up INTEGER NOT NULL CHECK(up IN(0,1)), ping REAL NOT NULL, location TEXT NOT NULL, error TEXT NOT NULL, incident_start INTEGER, first_seen INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS native_incidents (monitor_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, PRIMARY KEY(monitor_id,start)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS native_incidents_retention ON native_incidents(end) WHERE end IS NOT NULL;
CREATE TABLE IF NOT EXISTS native_incident_reasons (monitor_id TEXT NOT NULL, incident_start INTEGER NOT NULL, time INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(monitor_id,incident_start,time)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS native_latency_blocks (monitor_id TEXT NOT NULL, window INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(monitor_id,window)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS native_latency_retention ON native_latency_blocks(window);
CREATE TABLE IF NOT EXISTS probe_result_blocks (probe_id TEXT NOT NULL, window INTEGER NOT NULL, chunk INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(probe_id,window,chunk)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_blocks_retention ON probe_result_blocks(window);
CREATE TABLE IF NOT EXISTS probe_failure_events (probe_id TEXT NOT NULL, monitor_id TEXT NOT NULL, time INTEGER NOT NULL, stage TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(probe_id,monitor_id,time)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS probe_failure_retention ON probe_failure_events(time);
CREATE TABLE IF NOT EXISTS migration_runs (name TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notification_deliveries (event_id TEXT NOT NULL, destination TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY(event_id,destination)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS notification_deliveries_retention ON notification_deliveries(delivered_at);

CREATE INDEX IF NOT EXISTS probe_days_empty ON probe_days(checks,probe_id,monitor_id,time) WHERE checks<=0;

CREATE INDEX IF NOT EXISTS native_incident_recent ON native_incidents(start DESC,monitor_id DESC);
