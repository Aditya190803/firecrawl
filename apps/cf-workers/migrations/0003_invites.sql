-- Invite-only accounts. Apply with: wrangler d1 migrations apply firecrawl-db --remote

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN invite_token_hash TEXT;
ALTER TABLE users ADD COLUMN invite_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_invite ON users(invite_token_hash);
