-- Management credentials are independent from editable probe and page configuration.
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
