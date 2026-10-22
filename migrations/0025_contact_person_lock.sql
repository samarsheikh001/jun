-- V-18 (D-148): an agent linked or unlinked this contact by hand (Link / Unlink on the person's page), so
-- automatic linking by email or user id leaves it where it is.
ALTER TABLE contacts ADD COLUMN person_locked INTEGER NOT NULL DEFAULT 0;
