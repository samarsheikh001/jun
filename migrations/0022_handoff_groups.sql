-- D-137: a short group for each way the AI wrote a handoff reason ("Customer questions why they were
-- charged twice; …" → "Double charge check"), so Reports and Home count similar reasons as one. Keyed
-- by the reason's loose form (reasonKey in shared/metrics.ts): one AI pass per new wording, reused by
-- every chat that has it. `grp` NULL: looked at, no usable group (the reason shows as written). The
-- desk's own reasons, asking for a person and knowledge gaps are grouped in code and never stored.
CREATE TABLE handoff_groups (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reason_key    TEXT NOT NULL,
  grp           TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, reason_key)
);
