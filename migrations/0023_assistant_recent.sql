-- D-144: the member's last questions to Home's assistant (D-132's Recent), per member per workspace,
-- so they follow the person across browsers like the threads (D-139). `questions` is JSON
-- `[{ q, at }]`, newest first, at most 5, one per question (case-insensitive); the browser's
-- localStorage copy stays as a cache and each sync merges both (shared/ask-threads.ts `mergeRecent`).

CREATE TABLE assistant_recent (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  questions    TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
