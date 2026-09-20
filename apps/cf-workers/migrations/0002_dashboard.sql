-- Dashboard: multi-user login + per-key rate limits.
-- Apply with: wrangler d1 migrations apply firecrawl-db --remote

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

ALTER TABLE api_keys ADD COLUMN user_id TEXT;
ALTER TABLE api_keys ADD COLUMN rate_limit_per_min INTEGER NOT NULL DEFAULT 60;
ALTER TABLE api_keys ADD COLUMN monthly_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
ALTER TABLE usage_log ADD COLUMN key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage_log(key_id, created_at);
