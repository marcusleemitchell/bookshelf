-- migrate:foreign-keys-off
-- Per-member data (ADR 0010, step 2). The catalogue (books, formats) stays
-- shared; everything personal gains a member_id, and every existing row is
-- assigned to the owner (the admin set by migration 0006), so the current
-- library becomes the owner's shelf unchanged.
--
-- - shelf_entries takes over books.status and books.rating: one row per
--   member and book, copied from every book (soft-deleted ones included)
--   with the book's timestamps.
-- - books is rebuilt without status and rating; every other column is
--   copied unchanged.
-- - reads, sessions, book_notes, tags, goals, active_timer and import_links
--   are rebuilt with member_id; every other column is copied unchanged.
--   book_notes gains `shared` (false for every existing note), tag names and
--   goal periods become unique per member, the timer becomes one per member
--   and import provenance is keyed per member.
--
-- SQLite cannot add a NOT NULL foreign key column or change constraints in
-- place, so the tables are rebuilt (create new → copy → drop old → rename)
-- with foreign keys off; the runner checks them before committing. No data
-- is dropped: status and rating move to shelf_entries first.

-- Shelf entries ---------------------------------------------------------------

CREATE TABLE shelf_entries (
  member_id TEXT NOT NULL REFERENCES members (id),
  book_id TEXT NOT NULL REFERENCES books (id),
  status TEXT NOT NULL CHECK (status IN ('to_read', 'reading', 'paused', 'finished', 'dnf')),
  rating REAL CHECK (rating IS NULL OR (rating BETWEEN 0.5 AND 5 AND rating * 2 = CAST(rating * 2 AS INTEGER))),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (member_id, book_id)
);

INSERT INTO shelf_entries (member_id, book_id, status, rating, created_at, updated_at, deleted_at)
SELECT
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  id, status, rating, created_at, updated_at, deleted_at
FROM books;

CREATE INDEX shelf_entries_book_idx ON shelf_entries (book_id);
CREATE INDEX shelf_entries_member_status_idx ON shelf_entries (member_id, status)
  WHERE deleted_at IS NULL;

-- Books (catalogue) -----------------------------------------------------------

CREATE TABLE books_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  authors TEXT NOT NULL DEFAULT '[]',
  publisher TEXT,
  published_date TEXT,
  language TEXT,
  synopsis TEXT,
  cover_url TEXT,
  cover_path TEXT,
  isbn10 TEXT,
  isbn13 TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('openlibrary', 'googlebooks', 'manual')),
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO books_new (
  id, title, subtitle, authors, publisher, published_date, language, synopsis, cover_url,
  cover_path, isbn10, isbn13, genres, source, source_id, created_at, updated_at, deleted_at
)
SELECT
  id, title, subtitle, authors, publisher, published_date, language, synopsis, cover_url,
  cover_path, isbn10, isbn13, genres, source, source_id, created_at, updated_at, deleted_at
FROM books;

DROP TABLE books;
ALTER TABLE books_new RENAME TO books;

CREATE INDEX books_isbn13_idx ON books (isbn13);

-- Reads -----------------------------------------------------------------------

CREATE TABLE reads_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  book_id TEXT NOT NULL REFERENCES books (id),
  number INTEGER NOT NULL CHECK (number >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('in_progress', 'finished', 'dnf')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO reads_new (
  id, member_id, book_id, number, started_at, finished_at, outcome, created_at, updated_at,
  deleted_at
)
SELECT
  id,
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  book_id, number, started_at, finished_at, outcome, created_at, updated_at, deleted_at
FROM reads;

DROP TABLE reads;
ALTER TABLE reads_new RENAME TO reads;

CREATE INDEX reads_book_idx ON reads (book_id, number);
CREATE INDEX reads_member_book_idx ON reads (member_id, book_id, number);
CREATE INDEX reads_member_finished_idx ON reads (member_id, finished_at);

-- Sessions --------------------------------------------------------------------

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  read_id TEXT NOT NULL REFERENCES reads (id),
  book_id TEXT NOT NULL REFERENCES books (id),
  format_id TEXT NOT NULL REFERENCES book_formats (id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  progress_unit TEXT NOT NULL CHECK (progress_unit IN ('pages', 'percent', 'audio_seconds')),
  start_value REAL,
  end_value REAL,
  start_percent REAL,
  end_percent REAL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'bookpine')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO sessions_new (
  id, member_id, read_id, book_id, format_id, started_at, ended_at, duration_seconds,
  progress_unit, start_value, end_value, start_percent, end_percent, note, source, created_at,
  updated_at, deleted_at
)
SELECT
  id,
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  read_id, book_id, format_id, started_at, ended_at, duration_seconds, progress_unit,
  start_value, end_value, start_percent, end_percent, note, source, created_at, updated_at,
  deleted_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX sessions_started_idx ON sessions (started_at);
CREATE INDEX sessions_member_started_idx ON sessions (member_id, started_at);
CREATE INDEX sessions_book_idx ON sessions (book_id);
CREATE INDEX sessions_read_idx ON sessions (read_id);
CREATE INDEX sessions_format_idx ON sessions (format_id);

-- Notes -----------------------------------------------------------------------

-- shared: whether the note is visible to the parents (ADR 0010); private by default.
CREATE TABLE book_notes_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  book_id TEXT NOT NULL REFERENCES books (id),
  kind TEXT NOT NULL CHECK (kind IN ('note', 'quote')),
  text TEXT NOT NULL,
  location TEXT,
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO book_notes_new (
  id, member_id, book_id, kind, text, location, shared, created_at, updated_at, deleted_at
)
SELECT
  id,
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  book_id, kind, text, location, 0, created_at, updated_at, deleted_at
FROM book_notes;

DROP TABLE book_notes;
ALTER TABLE book_notes_new RENAME TO book_notes;

CREATE INDEX book_notes_book_idx ON book_notes (book_id);
CREATE INDEX book_notes_member_book_idx ON book_notes (member_id, book_id);

-- Tags ------------------------------------------------------------------------

-- name_key is the NFKC-normalised, lower-cased name: unique among a member's live tags.
CREATE TABLE tags_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  colour TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO tags_new (id, member_id, name, name_key, colour, created_at, updated_at, deleted_at)
SELECT
  id,
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  name, name_key, colour, created_at, updated_at, deleted_at
FROM tags;

DROP TABLE tags;
ALTER TABLE tags_new RENAME TO tags;

CREATE UNIQUE INDEX tags_name_key_live_idx ON tags (member_id, name_key) WHERE deleted_at IS NULL;

-- Goals -----------------------------------------------------------------------

CREATE TABLE goals_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  kind TEXT NOT NULL CHECK (kind IN ('books_per_year', 'pages_per_year', 'minutes_per_day')),
  year INTEGER,
  target INTEGER NOT NULL CHECK (target > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((kind = 'minutes_per_day') = (year IS NULL))
);

INSERT INTO goals_new (id, member_id, kind, year, target, created_at, updated_at, deleted_at)
SELECT
  id,
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  kind, year, target, created_at, updated_at, deleted_at
FROM goals;

DROP TABLE goals;
ALTER TABLE goals_new RENAME TO goals;

CREATE UNIQUE INDEX goals_kind_year_live_idx ON goals (member_id, kind, ifnull(year, 0))
  WHERE deleted_at IS NULL;

-- Timer -----------------------------------------------------------------------

-- At most one timer per member (member_id is unique).
CREATE TABLE active_timer_new (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL UNIQUE REFERENCES members (id),
  book_id TEXT NOT NULL REFERENCES books (id),
  format_id TEXT NOT NULL REFERENCES book_formats (id),
  started_at TEXT NOT NULL,
  resumed_at TEXT NOT NULL,
  paused_at TEXT,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO active_timer_new (
  id, member_id, book_id, format_id, started_at, resumed_at, paused_at, accumulated_seconds,
  created_at, updated_at
)
SELECT
  id,
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  book_id, format_id, started_at, resumed_at, paused_at, accumulated_seconds, created_at,
  updated_at
FROM active_timer;

DROP TABLE active_timer;
ALTER TABLE active_timer_new RENAME TO active_timer;

-- Import provenance -----------------------------------------------------------

CREATE TABLE import_links_new (
  member_id TEXT NOT NULL REFERENCES members (id),
  source TEXT NOT NULL CHECK (source IN ('bookpine')),
  entity TEXT NOT NULL CHECK (entity IN ('book', 'format', 'read', 'session', 'note')),
  external_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  imported TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  PRIMARY KEY (member_id, source, entity, external_id)
);

INSERT INTO import_links_new (
  member_id, source, entity, external_id, local_id, imported, imported_at
)
SELECT
  (SELECT id FROM members WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1),
  source, entity, external_id, local_id, imported, imported_at
FROM import_links;

DROP TABLE import_links;
ALTER TABLE import_links_new RENAME TO import_links;

CREATE INDEX import_links_local_idx ON import_links (entity, local_id);
