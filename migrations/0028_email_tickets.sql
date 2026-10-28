-- C-13 (D-153): a forwarded support inbox. Mail to the workspace's forwarding address starts a
-- conversation of type 'ticket' (D-05) with the email's subject.
ALTER TABLE conversations ADD COLUMN subject TEXT;

-- 'email': a contact made for an email sender. Never verified, has no visitor token, and is the only
-- kind a later email from that address reuses (a widget visitor who typed the same address isn't).
ALTER TABLE contacts ADD COLUMN source TEXT;
CREATE INDEX contacts_email_source ON contacts(workspace_id, email) WHERE source = 'email';

-- Every Message-ID sent or received (SHA-256, the id without its brackets), so a reply that comes
-- back through support@ finds its conversation, and a retried delivery isn't a second ticket.
CREATE TABLE email_messages (
  message_id_hash  TEXT NOT NULL,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, message_id_hash)
);
CREATE INDEX email_messages_conversation ON email_messages(conversation_id);

-- "Mark as spam": an address (no +tag) or '@domain'. Their mail is accepted and dropped.
CREATE TABLE blocked_senders (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pattern       TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, pattern)
);
