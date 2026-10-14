-- D-86: agent config versions saved through the desk's MCP server (/mcp) have source 'mcp'.
-- SQLite can't change a CHECK constraint, so the table is rebuilt with the same columns and rows.
-- Nothing references agent_configs, so dropping the old table is safe.

PRAGMA defer_foreign_keys = true;

CREATE TABLE agent_configs_new (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  files         TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL CHECK (source IN ('dashboard', 'cli', 'mcp')),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  changed       TEXT,
  UNIQUE (workspace_id, version)
);

INSERT INTO agent_configs_new (id, workspace_id, version, files, message, source, created_by, created_at, changed)
  SELECT id, workspace_id, version, files, message, source, created_by, created_at, changed FROM agent_configs;

DROP TABLE agent_configs;
ALTER TABLE agent_configs_new RENAME TO agent_configs;
