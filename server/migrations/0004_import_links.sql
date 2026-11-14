-- Import provenance (SPEC §8): which local row each imported record became,
-- so re-importing the same export updates rows instead of duplicating them.
-- external_id is the source's key (a Bookpine slug for books, or the book's
-- anchor slug plus a suffix such as `#read:1` or `#day:2026-03-02`).
-- `imported` holds the field values the import last wrote (JSON); a field
-- whose current value differs from it was edited by the user and is kept.

CREATE TABLE import_links (
  source TEXT NOT NULL CHECK (source IN ('bookpine')),
  entity TEXT NOT NULL CHECK (entity IN ('book', 'format', 'read', 'session', 'note')),
  external_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  imported TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  PRIMARY KEY (source, entity, external_id)
);
CREATE INDEX import_links_local_idx ON import_links (entity, local_id);
