-- D-84: which files each agent config version changed (shown in the Agent page's History).
-- Versions saved before this have NULL.
ALTER TABLE agent_configs ADD COLUMN changed TEXT;
