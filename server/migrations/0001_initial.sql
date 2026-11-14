-- Initial schema (SPEC §4). Timestamps are ISO 8601 UTC strings; JSON
-- arrays are stored as TEXT. Syncable tables carry updated_at/deleted_at.

CREATE TABLE books (
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
  status TEXT NOT NULL CHECK (status IN ('to_read', 'reading', 'finished', 'dnf')),
  rating REAL CHECK (rating IS NULL OR (rating BETWEEN 0.5 AND 5 AND rating * 2 = CAST(rating * 2 AS INTEGER))),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX books_status_idx ON books (status) WHERE deleted_at IS NULL;
CREATE INDEX books_isbn13_idx ON books (isbn13);

CREATE TABLE book_formats (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id),
  format TEXT NOT NULL CHECK (format IN ('physical', 'kindle', 'audiobook')),
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  audio_duration_seconds INTEGER CHECK (audio_duration_seconds IS NULL OR audio_duration_seconds > 0),
  isbn TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX book_formats_book_idx ON book_formats (book_id);

CREATE TABLE reads (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id),
  number INTEGER NOT NULL CHECK (number >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('in_progress', 'finished', 'dnf')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX reads_book_idx ON reads (book_id, number);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  read_id TEXT NOT NULL REFERENCES reads (id),
  book_id TEXT NOT NULL REFERENCES books (id),
  format_id TEXT NOT NULL REFERENCES book_formats (id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  progress_unit TEXT NOT NULL CHECK (progress_unit IN ('pages', 'percent', 'audio_seconds')),
  start_value REAL,
  end_value REAL,
  start_percent REAL,
  end_percent REAL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX sessions_started_idx ON sessions (started_at);
CREATE INDEX sessions_book_idx ON sessions (book_id);
CREATE INDEX sessions_read_idx ON sessions (read_id);
CREATE INDEX sessions_format_idx ON sessions (format_id);

-- At most one row: the singleton column is constrained to 1 and unique.
CREATE TABLE active_timer (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  book_id TEXT NOT NULL REFERENCES books (id),
  format_id TEXT NOT NULL REFERENCES book_formats (id),
  started_at TEXT NOT NULL,
  resumed_at TEXT NOT NULL,
  paused_at TEXT,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- name_key is the NFKC-normalised, lower-cased name: unique among live tags.
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  colour TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX tags_name_key_live_idx ON tags (name_key) WHERE deleted_at IS NULL;

CREATE TABLE book_tags (
  book_id TEXT NOT NULL REFERENCES books (id),
  tag_id TEXT NOT NULL REFERENCES tags (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (book_id, tag_id)
);
CREATE INDEX book_tags_tag_idx ON book_tags (tag_id);

CREATE TABLE book_notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id),
  kind TEXT NOT NULL CHECK (kind IN ('note', 'quote')),
  text TEXT NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX book_notes_book_idx ON book_notes (book_id);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('books_per_year', 'pages_per_year', 'minutes_per_day')),
  year INTEGER,
  target INTEGER NOT NULL CHECK (target > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((kind = 'minutes_per_day') = (year IS NULL))
);
CREATE UNIQUE INDEX goals_kind_year_live_idx ON goals (kind, ifnull(year, 0)) WHERE deleted_at IS NULL;

-- Server key/value state (e.g. Notion database IDs and last-run status). JSON values.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Processed sync ops, for idempotent outbox replay (SPEC §5).
CREATE TABLE sync_ops (
  op_id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  status TEXT NOT NULL CHECK (status IN ('applied', 'stale')),
  client_updated_at TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

-- Notion page mirrored for each local row; content_hash skips unchanged rows.
CREATE TABLE notion_pages (
  entity TEXT NOT NULL CHECK (entity IN ('book', 'session', 'note')),
  local_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (entity, local_id)
);
