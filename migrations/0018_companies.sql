-- V-11 (D-109): companies. The host app's signed identity token can say which company the
-- user belongs to (`company` claim: id, name, attributes); contacts of one company are grouped,
-- so agents and the AI see the account (plan, seats, MRR…) and its other people's chats.

CREATE TABLE companies (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The host app's company id (`company.id`).
  external_id   TEXT NOT NULL,
  name          TEXT,
  -- Strings, numbers, booleans, as the latest token said (the host app is the source of truth).
  attributes    TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX companies_external ON companies (workspace_id, external_id);

ALTER TABLE contacts ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX contacts_company ON contacts (company_id) WHERE company_id IS NOT NULL;
