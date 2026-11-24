-- Family members and sign-in (ADR 0010, step 1). Every existing row stays
-- the owner's: this migration creates the owner, a parent without a PIN
-- whom the app asks for a name and PIN on first open. Later steps add
-- member_id to the personal tables and backfill it with the owner.

-- pin_hash is `scrypt$N$r$p$salt$hash` (base64), null until a PIN is set.
-- failed_pin_attempts counts consecutive wrong PINs; reaching the limit sets
-- locked_until and resets the count.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  role TEXT NOT NULL CHECK (role IN ('parent', 'child')),
  pin_hash TEXT,
  failed_pin_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_pin_attempts >= 0),
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- One row per signed-in device. Only the SHA-256 hash of the cookie token is
-- stored; a row past expires_at no longer signs anyone in.
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  created_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_member_idx ON auth_sessions (member_id);

-- The owner, with a random UUID v4 (version nibble 4, variant 8–b).
INSERT INTO members (id, name, role, created_at, updated_at)
SELECT id, 'Owner', 'parent', at, at
FROM (
  SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + abs(random()) % 4, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))) AS id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at
);
