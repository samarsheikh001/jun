-- T-20 (D-151): the collector's database (`npx wrangler d1 execute jun-telemetry --remote --file schema.sql`).
-- One row per desk (its latest ping) and one per desk per day. No IP addresses, no headers.
CREATE TABLE IF NOT EXISTS desks (
  id          TEXT PRIMARY KEY,   -- ins_<32 hex>, random per desk
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  version     TEXT NOT NULL,
  payload     TEXT NOT NULL       -- the latest ping, as checked by readPing
);

CREATE TABLE IF NOT EXISTS pings (
  day      TEXT NOT NULL,         -- YYYY-MM-DD (UTC)
  id       TEXT NOT NULL,
  version  TEXT NOT NULL,
  payload  TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
