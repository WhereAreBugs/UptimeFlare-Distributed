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
