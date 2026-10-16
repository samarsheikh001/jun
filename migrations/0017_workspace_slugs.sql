-- D-96: each workspace has a slug for its desk URLs (/w/<slug>/inbox). Existing workspaces get
-- theirs from the Worker on the next /me (made from the name, unique: SQLite has no regex to do it here).

ALTER TABLE workspaces ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX workspaces_slug ON workspaces (slug);
