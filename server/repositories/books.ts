/**
 * Book persistence (ADR 0010): the shared catalogue (`books`), each member's
 * shelf entries (status and rating) and their tag links. A member sees a
 * book as the catalogue row joined with their shelf entry.
 */
import type { Book, BookStatus, CatalogueBook, ShelfEntry } from '../../shared/index.ts';
import { all, run, type Db, type Row, type SqlValue } from '../db/database.ts';
import { booksTable, findById, fromRow, upsertRow } from './tables.ts';

/** IDs of the member's live tags on a book, sorted by tag name. */
export function bookTagIds(db: Db, memberId: string, bookId: string): string[] {
  return all<{ tag_id: string }>(
    db,
    `SELECT bt.tag_id FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE bt.book_id = ? AND t.member_id = ? AND t.deleted_at IS NULL ORDER BY t.name_key`,
    [bookId, memberId],
  ).map((row) => row.tag_id);
}

const SHELF_COLUMNS = `se.status AS se_status, se.rating AS se_rating,
  se.created_at AS se_created_at, se.updated_at AS se_updated_at, se.deleted_at AS se_deleted_at`;

interface ShelfColumns {
  se_status: BookStatus;
  se_rating: number | null;
  se_created_at: string;
  se_updated_at: string;
  se_deleted_at: string | null;
}

/** The member's view of a catalogue row joined with their shelf entry. */
function toBook(db: Db, memberId: string, row: Row & ShelfColumns): Book {
  const record = fromRow(booksTable, row);
  return {
    ...record,
    status: row.se_status,
    rating: row.se_rating,
    createdAt: row.se_created_at,
    updatedAt: record.updatedAt > row.se_updated_at ? record.updatedAt : row.se_updated_at,
    deletedAt: row.se_deleted_at ?? record.deletedAt,
    tagIds: bookTagIds(db, memberId, record.id),
  };
}

function selectShelf(
  db: Db,
  memberId: string,
  where: string,
  params: readonly SqlValue[],
  orderBy: string,
): Book[] {
  return all<Row & ShelfColumns>(
    db,
    `SELECT b.*, ${SHELF_COLUMNS} FROM books b
     JOIN shelf_entries se ON se.book_id = b.id AND se.member_id = ?
     WHERE ${where} ORDER BY ${orderBy}`,
    [memberId, ...params],
  ).map((row) => toBook(db, memberId, row));
}

/**
 * A book on the member's shelf. With `includeDeleted`, also a book they
 * removed (or whose catalogue row is deleted); never one they never had.
 */
export function findBook(
  db: Db,
  memberId: string,
  id: string,
  includeDeleted = false,
): Book | undefined {
  const live = includeDeleted ? '' : ' AND b.deleted_at IS NULL AND se.deleted_at IS NULL';
  return selectShelf(db, memberId, `b.id = ?${live}`, [id], 'b.id')[0];
}

export interface BookFilter {
  status?: BookStatus | undefined;
  tagId?: string | undefined;
  q?: string | undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Live books on the member's shelf matching the filter, ordered by title. */
export function listBooks(db: Db, memberId: string, filter: BookFilter = {}): Book[] {
  const where = ['b.deleted_at IS NULL', 'se.deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (filter.status) {
    where.push('se.status = ?');
    params.push(filter.status);
  }
  if (filter.tagId) {
    where.push(
      `EXISTS (SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
        WHERE bt.book_id = b.id AND bt.tag_id = ? AND t.member_id = se.member_id)`,
    );
    params.push(filter.tagId);
  }
  if (filter.q) {
    const like = `%${escapeLike(filter.q)}%`;
    where.push(
      `(b.title LIKE ? ESCAPE '\\' OR b.subtitle LIKE ? ESCAPE '\\' OR b.authors LIKE ? ESCAPE '\\'
        OR b.isbn10 LIKE ? ESCAPE '\\' OR b.isbn13 LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like);
  }
  return selectShelf(db, memberId, where.join(' AND '), params, 'b.title COLLATE NOCASE, b.id');
}

/** Every book the member has a shelf entry for, including removed ones (for mirrors). */
export function listShelfBooks(db: Db, memberId: string): Book[] {
  return selectShelf(db, memberId, '1 = 1', [], 'se.created_at, b.rowid');
}

// --- Catalogue -----------------------------------------------------------------

/** A catalogue row by id, including soft-deleted ones, whoever's shelf it is on. */
export function findCatalogueBook(db: Db, id: string): CatalogueBook | undefined {
  return findById(db, booksTable, id);
}

/** The oldest live catalogue book with this ISBN-13, if any. */
export function findCatalogueBookByIsbn13(db: Db, isbn13: string): CatalogueBook | undefined {
  const row = all(
    db,
    'SELECT * FROM books WHERE isbn13 = ? AND deleted_at IS NULL ORDER BY created_at, rowid LIMIT 1',
    [isbn13],
  )[0];
  return row ? fromRow(booksTable, row) : undefined;
}

/** Every catalogue row including soft-deleted ones (for backups). */
export function listCatalogue(db: Db): CatalogueBook[] {
  return all(db, 'SELECT * FROM books ORDER BY created_at, rowid').map((row) =>
    fromRow(booksTable, row),
  );
}

/** Writes the catalogue row (insert or replace). Extra fields (status, tags…) are ignored. */
export function saveCatalogueBook(db: Db, book: CatalogueBook): void {
  upsertRow(db, booksTable, book);
}

/** Sets the cached cover file name without touching `updated_at` (server-managed field). */
export function setCoverPath(db: Db, bookId: string, coverPath: string | null): void {
  run(db, 'UPDATE books SET cover_path = ? WHERE id = ?', [coverPath, bookId]);
}

// --- Shelf entries -------------------------------------------------------------

interface ShelfRow {
  member_id: string;
  book_id: string;
  status: BookStatus;
  rating: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toShelfEntry(row: ShelfRow): ShelfEntry {
  return {
    memberId: row.member_id,
    bookId: row.book_id,
    status: row.status,
    rating: row.rating,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/** The member's shelf entry for a book (live or removed), if they ever had one. */
export function findShelfEntry(db: Db, memberId: string, bookId: string): ShelfEntry | undefined {
  const row = all<ShelfRow>(db, 'SELECT * FROM shelf_entries WHERE member_id = ? AND book_id = ?', [
    memberId,
    bookId,
  ])[0];
  return row ? toShelfEntry(row) : undefined;
}

/** Every shelf entry of every member, including removed ones (for backups). */
export function listShelfEntries(db: Db): ShelfEntry[] {
  return all<ShelfRow>(db, 'SELECT * FROM shelf_entries ORDER BY created_at, rowid').map(
    toShelfEntry,
  );
}

/** Inserts or replaces the member's shelf entry for the book. */
export function saveShelfEntry(db: Db, entry: ShelfEntry): void {
  run(
    db,
    `INSERT INTO shelf_entries (member_id, book_id, status, rating, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id, book_id) DO UPDATE SET status = excluded.status,
       rating = excluded.rating, created_at = excluded.created_at,
       updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    [
      entry.memberId,
      entry.bookId,
      entry.status,
      entry.rating,
      entry.createdAt,
      entry.updatedAt,
      entry.deletedAt,
    ],
  );
}

/** True while any member has the book on their shelf. */
export function onAnyShelf(db: Db, bookId: string): boolean {
  return (
    all(db, 'SELECT 1 FROM shelf_entries WHERE book_id = ? AND deleted_at IS NULL LIMIT 1', [
      bookId,
    ]).length > 0
  );
}

// --- Tag links -----------------------------------------------------------------

/** Replaces the member's tag links on a book; other members' links are untouched. */
export function replaceBookTags(
  db: Db,
  memberId: string,
  bookId: string,
  tagIds: readonly string[],
  at: string,
): void {
  run(
    db,
    'DELETE FROM book_tags WHERE book_id = ? AND tag_id IN (SELECT id FROM tags WHERE member_id = ?)',
    [bookId, memberId],
  );
  for (const tagId of new Set(tagIds)) {
    run(db, 'INSERT INTO book_tags (book_id, tag_id, created_at) VALUES (?, ?, ?)', [
      bookId,
      tagId,
      at,
    ]);
  }
}

// --- Removing ------------------------------------------------------------------

/**
 * Removes a book from the member's shelf: soft-deletes their shelf entry and
 * their reads, sessions and notes on it, removes their tag links on it and
 * discards their timer on it. When no live shelf entry remains, the
 * catalogue row and its formats are soft-deleted too (and any timer left on
 * the book is discarded). Rows already deleted keep their `deleted_at`.
 */
export function removeFromShelf(db: Db, memberId: string, bookId: string, at: string): void {
  for (const table of ['shelf_entries', 'reads', 'sessions', 'book_notes']) {
    run(
      db,
      `UPDATE ${table} SET deleted_at = ?, updated_at = ?
       WHERE member_id = ? AND book_id = ? AND deleted_at IS NULL`,
      [at, at, memberId, bookId],
    );
  }
  run(
    db,
    'DELETE FROM book_tags WHERE book_id = ? AND tag_id IN (SELECT id FROM tags WHERE member_id = ?)',
    [bookId, memberId],
  );
  run(db, 'DELETE FROM active_timer WHERE member_id = ? AND book_id = ?', [memberId, bookId]);
  if (onAnyShelf(db, bookId)) return;
  run(
    db,
    `UPDATE book_formats SET deleted_at = ?, updated_at = ? WHERE book_id = ? AND deleted_at IS NULL`,
    [at, at, bookId],
  );
  run(db, 'DELETE FROM active_timer WHERE book_id = ?', [bookId]);
  run(db, 'UPDATE books SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [
    at,
    at,
    bookId,
  ]);
}
