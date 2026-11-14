-- Sessions with an unknown duration (SPEC §4): imported reading days carry
-- no reading time, so duration_seconds becomes nullable, and `source`
-- records where a session came from ('app' = logged in Bookshelf,
-- 'bookpine' = imported). SQLite cannot drop a NOT NULL in place, so the
-- table is rebuilt; every existing row is copied unchanged with source 'app'.
-- No other table references sessions, so foreign keys stay on.

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
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
  id, read_id, book_id, format_id, started_at, ended_at, duration_seconds, progress_unit,
  start_value, end_value, start_percent, end_percent, note, source, created_at, updated_at,
  deleted_at
)
SELECT
  id, read_id, book_id, format_id, started_at, ended_at, duration_seconds, progress_unit,
  start_value, end_value, start_percent, end_percent, note, 'app', created_at, updated_at,
  deleted_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX sessions_started_idx ON sessions (started_at);
CREATE INDEX sessions_book_idx ON sessions (book_id);
CREATE INDEX sessions_read_idx ON sessions (read_id);
CREATE INDEX sessions_format_idx ON sessions (format_id);
