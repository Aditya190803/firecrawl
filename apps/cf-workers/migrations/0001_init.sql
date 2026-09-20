-- Firecrawl CF Workers — D1 schema (free tier, single DB).
-- Apply with: wrangler d1 migrations apply firecrawl-db --remote

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'default',
  credits_used INTEGER NOT NULL DEFAULT 0,
  credits_limit INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys(team_id);

-- Async jobs: crawl | batch | extract | map | deep_research | llmstxt
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|active|completed|failed|cancelled
  request_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  credits_cost INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_team_status ON jobs(team_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status);

CREATE TABLE IF NOT EXISTS job_pages (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|done|failed
  data_json TEXT,
  error TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (job_id, url)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  team_id TEXT NOT NULL,
  key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (team_id, key)
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_team_time ON usage_log(team_id, created_at);

-- Seed the default single-user team (id = 'default'). The actual API key is
-- checked against the API_KEY secret first; this row only tracks usage.
INSERT OR IGNORE INTO teams (id, name, credits_used, credits_limit)
VALUES ('default', 'default', 0, 0);
