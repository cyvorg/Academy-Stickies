-- Migration 0012: admin role + moderation columns
--
-- is_admin is a member-level identity flag (not a profile field): an admin
-- keeps their powers even without a profile row. hidden_at/hidden_by give
-- staff non-destructive moderation (hide/restore) on stickies and letters;
-- permanent deletion stays a separate, explicit action. feedback.read_at
-- backs the new admin feedback inbox.
PRAGMA foreign_keys = ON;

ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

ALTER TABLE stickies ADD COLUMN hidden_at INTEGER;
ALTER TABLE stickies ADD COLUMN hidden_by TEXT;

ALTER TABLE letters ADD COLUMN hidden_at INTEGER;
ALTER TABLE letters ADD COLUMN hidden_by TEXT;

ALTER TABLE feedback ADD COLUMN read_at INTEGER;

-- Deactivate is the default access-removal path (login links and sessions
-- stop working, wall/notes/media stay intact); hard deletion stays separate.
ALTER TABLE members ADD COLUMN disabled_at INTEGER;

-- Who-did-what for staff actions (moderation, destructive, member admin).
CREATE TABLE IF NOT EXISTS admin_actions (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL, -- no FK: audit rows must survive member deletion
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
