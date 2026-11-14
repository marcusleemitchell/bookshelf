/**
 * Book persistence: book rows plus their tag links.
 */
import type { Book, BookRecord, BookStatus } from '../../shared/index.ts';
import { all, run, type Db, type SqlValue } from '../db/database.ts';
import { booksTable, findById, findMany, upsertRow } from './tables.ts';

/** IDs of a book's live tags, sorted by tag name. */
export function bookTagIds(db: Db, bookId: string): string[] {
  return all<{ tag_id: string }>(
    db,
    `SELECT bt.tag_id FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE bt.book_id = ? AND t.deleted_at IS NULL ORDER BY t.name_key`,
    [bookId],
  ).map((row) => row.tag_id);
}

function withTags(db: Db, record: BookRecord): Book {
  return { ...record, tagIds: bookTagIds(db, record.id) };
}

/** A book by id; soft-deleted books only when `includeDeleted`. */
export function findBook(db: Db, id: string, includeDeleted = false): Book | undefined {
  const record = findById(db, booksTable, id);
  if (!record || (record.deletedAt !== null && !includeDeleted)) return undefined;
  return withTags(db, record);
}

export interface BookFilter {
  status?: BookStatus | undefined;
  tagId?: string | undefined;
  q?: string | undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Live books matching the filter, ordered by title. */
export function listBooks(db: Db, filter: BookFilter = {}): Book[] {
  const where = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.tagId) {
    where.push('EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = books.id AND bt.tag_id = ?)');
    params.push(filter.tagId);
  }
  if (filter.q) {
    const like = `%${escapeLike(filter.q)}%`;
    where.push(
      `(title LIKE ? ESCAPE '\\' OR subtitle LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\'
        OR isbn10 LIKE ? ESCAPE '\\' OR isbn13 LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like);
  }
  return findMany(db, booksTable, where.join(' AND '), params, 'title COLLATE NOCASE, id').map(
    (record) => withTags(db, record),
  );
}

/** Every book row including soft-deleted ones (for backups and mirrors). */
export function listAllBooks(db: Db): Book[] {
  return findMany(db, booksTable).map((record) => withTags(db, record));
}

/** Writes the book row (insert or replace). Tag links are written separately. */
export function saveBook(db: Db, book: BookRecord): void {
  upsertRow(db, booksTable, book);
}

/** Replaces a book's tag links. */
export function replaceBookTags(
  db: Db,
  bookId: string,
  tagIds: readonly string[],
  at: string,
): void {
  run(db, 'DELETE FROM book_tags WHERE book_id = ?', [bookId]);
  for (const tagId of new Set(tagIds)) {
    run(db, 'INSERT INTO book_tags (book_id, tag_id, created_at) VALUES (?, ?, ?)', [
      bookId,
      tagId,
      at,
    ]);
  }
}

/** Sets the cached cover file name without touching `updated_at` (server-managed field). */
export function setCoverPath(db: Db, bookId: string, coverPath: string | null): void {
  run(db, 'UPDATE books SET cover_path = ? WHERE id = ?', [coverPath, bookId]);
}

/**
 * Soft-deletes a book and everything that hangs off it (formats, reads,
 * sessions, notes), and discards a timer on it. Children already deleted
 * keep their original `deleted_at`.
 */
export function softDeleteBookCascade(db: Db, bookId: string, at: string): void {
  for (const table of ['book_formats', 'reads', 'sessions', 'book_notes']) {
    run(
      db,
      `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE book_id = ? AND deleted_at IS NULL`,
      [at, at, bookId],
    );
  }
  run(db, 'DELETE FROM active_timer WHERE book_id = ?', [bookId]);
  run(db, 'UPDATE books SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, bookId]);
}
