-- Admin flag (ADR 0010): a parent who is an admin also sees and changes
-- every member's personal data (except private notes) and grants or revokes
-- admin. The owner (the oldest live parent, created by migration 0005)
-- becomes the admin; from now on the owner is the oldest live admin.
-- Adding a column with a constant default needs no table rebuild.

ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1));

UPDATE members SET is_admin = 1
WHERE id = (
  SELECT id FROM members
  WHERE role = 'parent' AND deleted_at IS NULL
  ORDER BY created_at, id LIMIT 1
);
