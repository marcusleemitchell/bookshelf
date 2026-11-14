-- migrate:foreign-keys-off
-- Adds the `paused` book status (SPEC §4). SQLite cannot alter a CHECK
-- constraint, so the books table is rebuilt with every row copied
-- unchanged; the runner disables foreign keys for the rebuild and checks
-- them before committing.

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
  status TEXT NOT NULL CHECK (status IN ('to_read', 'reading', 'paused', 'finished', 'dnf')),
  rating REAL CHECK (rating IS NULL OR (rating BETWEEN 0.5 AND 5 AND rating * 2 = CAST(rating * 2 AS INTEGER))),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO books_new (
  id, title, subtitle, authors, publisher, published_date, language, synopsis, cover_url,
  cover_path, isbn10, isbn13, genres, source, source_id, status, rating, created_at,
  updated_at, deleted_at
)
SELECT
  id, title, subtitle, authors, publisher, published_date, language, synopsis, cover_url,
  cover_path, isbn10, isbn13, genres, source, source_id, status, rating, created_at,
  updated_at, deleted_at
FROM books;

DROP TABLE books;
ALTER TABLE books_new RENAME TO books;

CREATE INDEX books_status_idx ON books (status) WHERE deleted_at IS NULL;
CREATE INDEX books_isbn13_idx ON books (isbn13);
