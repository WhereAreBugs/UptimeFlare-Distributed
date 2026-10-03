CREATE TABLE IF NOT EXISTS probe_metadata (
  probe_id TEXT PRIMARY KEY,
  default_name TEXT NOT NULL,
  default_location TEXT NOT NULL
) WITHOUT ROWID;
