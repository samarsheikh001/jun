-- D-157: email + password sign-in beside passkeys. NULL = this person has no password.
-- Format: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url> (worker/auth/password.ts).
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- Failed password sign-ins, per email and per IP (hashed), so guessing is slow.
CREATE TABLE login_failures (
  key           TEXT PRIMARY KEY,   -- 'email:<sha256>' or 'ip:<sha256>'
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
