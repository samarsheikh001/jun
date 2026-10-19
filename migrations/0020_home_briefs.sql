-- I-19 (D-127): Home's daily brief, one per member per workspace: written on the day's first open
-- (or Refresh) and kept until the next day in that member's time zone. `brief` is the whole Brief
-- JSON (shared/home-brief.ts): its points with their numbers worked out in code and the sentences.

CREATE TABLE home_briefs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,                -- 'YYYY-MM-DD' in `timezone`
  timezone     TEXT NOT NULL,
  brief        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
