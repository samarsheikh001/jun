-- C-09 / T-13 (D-152): team replies from Slack. A workspace connects its own Slack app (made from the
-- desk's manifest); its bot token and signing secret live in the workspace hub's storage, never here.
-- (0026 is the whatsapp branch's migration.)
CREATE TABLE slack_connections (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  team_url      TEXT,
  bot_user_id   TEXT NOT NULL,
  channel_id    TEXT,
  channel_name  TEXT,
  -- 'handoff': a thread when a chat needs a person; 'all': for every new chat too.
  mode          TEXT NOT NULL DEFAULT 'handoff',
  -- The desk's address when it was connected, for "Open in desk" links.
  desk_url      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'connected', -- 'connected' | 'broken'
  last_error    TEXT,
  created_at    INTEGER NOT NULL
);

-- One Slack thread per conversation per Slack team. Old threads keep working after the channel changes.
CREATE TABLE slack_threads (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id          TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  thread_ts        TEXT NOT NULL,
  -- Messages up to this seq were in the thread's opening backfill (not posted again).
  through_seq      INTEGER NOT NULL DEFAULT 0,
  -- What the card at the top last showed, so it's only updated when that changes.
  card             TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, team_id)
);
CREATE UNIQUE INDEX slack_threads_ts ON slack_threads (workspace_id, team_id, channel_id, thread_ts);
