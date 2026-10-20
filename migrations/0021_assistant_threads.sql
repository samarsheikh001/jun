-- D-139: Home's assistant threads (D-134) kept on the server per member per workspace, so they follow
-- the person across browsers (localStorage stays as a cache). `id` is the browser-made thread id
-- (`t…`). `turns` is the finished turns' JSON (≤ 200 KB, invite links never stored, D-133); a deleted
-- or trimmed thread stays as a tombstone (`deleted_at`, turns '[]') so another browser's cached copy
-- isn't uploaded again. At most 20 live threads per member: the oldest become tombstones.

CREATE TABLE assistant_threads (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  title        TEXT NOT NULL,
  turns        TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  PRIMARY KEY (workspace_id, user_id, id)
);
CREATE INDEX assistant_threads_recent ON assistant_threads (workspace_id, user_id, updated_at);
