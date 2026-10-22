-- V-18 (D-147): contacts that are the same person. Each browser stays its own contact (the widget
-- shows a browser only its own chats), but contacts sharing an email or a user id are linked: the
-- desk shows them as one person. `person_id` is the id of the group's main contact (a verified one
-- when there is one, else the oldest); NULL when the contact stands alone. `claimed_id` is the user
-- id a page gave without a token (JunDesk.identify({ id }) or a PostHog bridge): not verified,
-- only used to link.
ALTER TABLE contacts ADD COLUMN person_id TEXT;
ALTER TABLE contacts ADD COLUMN claimed_id TEXT;
CREATE INDEX contacts_person ON contacts (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX contacts_email ON contacts (workspace_id, email) WHERE email IS NOT NULL;
CREATE INDEX contacts_claimed ON contacts (workspace_id, claimed_id) WHERE claimed_id IS NOT NULL;

-- One-time pass: link the contacts that already share an email (claimed ids are new, so none yet), with
-- the same rules as planPersonLink in shared/contacts.ts: the main contact is a verified one (the most
-- recently seen when several), else the oldest; verified contacts are never pointed at another person.
UPDATE contacts SET person_id = (
  SELECT r.id FROM contacts r WHERE r.workspace_id = contacts.workspace_id AND r.email = contacts.email
  ORDER BY r.verified_at IS NULL, CASE WHEN r.verified_at IS NOT NULL THEN -r.last_seen_at ELSE r.created_at END, r.id
  LIMIT 1
)
WHERE email IS NOT NULL AND verified_at IS NULL
  AND EXISTS (SELECT 1 FROM contacts o WHERE o.workspace_id = contacts.workspace_id AND o.email = contacts.email AND o.id != contacts.id);
UPDATE contacts SET person_id = id
WHERE person_id IS NULL AND EXISTS (SELECT 1 FROM contacts m WHERE m.person_id = contacts.id AND m.id != contacts.id);
