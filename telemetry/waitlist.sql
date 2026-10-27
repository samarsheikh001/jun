-- The hosted-Jun waitlist from jun.so (`npx wrangler d1 execute jun-waitlist -c wrangler.jsonc --remote --file waitlist.sql`).
-- Its own database, apart from the anonymous pings: these are people who chose to leave an email. No IP addresses.
CREATE TABLE IF NOT EXISTS waitlist (
  email       TEXT PRIMARY KEY,   -- lowercased
  created_at  INTEGER NOT NULL,
  source      TEXT NOT NULL       -- where on jun.so they signed up, e.g. "home-cta"
);
