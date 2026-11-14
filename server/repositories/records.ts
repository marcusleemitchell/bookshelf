/**
 * Queries for the records hanging off a book: formats, reads, sessions,
 * notes, plus tags, goals and the timer.
 */
import {
  computePercent,
  type ActiveTimer,
  type BookFormat,
  type BookNote,
  type Goal,
  type Read,
  type Session,
  type Tag,
} from '../../shared/index.ts';
import { all, run, type Db } from '../db/database.ts';
import {
  findById,
  findMany,
  formatsTable,
  goalsTable,
  notesTable,
  readsTable,
  sessionsTable,
  tagNameKey,
  tagsTable,
  timerTable,
  upsertRow,
} from './tables.ts';

function live<T extends { deletedAt: string | null }>(row: T | undefined): T | undefined {
  return row && row.deletedAt === null ? row : undefined;
}

// --- Formats -----------------------------------------------------------------

export function findFormat(db: Db, id: string): BookFormat | undefined {
  return live(findById(db, formatsTable, id));
}

export function bookFormats(db: Db, bookId: string): BookFormat[] {
  return findMany(db, formatsTable, 'book_id = ? AND deleted_at IS NULL', [bookId]);
}

// --- Reads -------------------------------------------------------------------

export function findRead(db: Db, id: string): Read | undefined {
  return live(findById(db, readsTable, id));
}

export function bookReads(db: Db, bookId: string): Read[] {
  return findMany(
    db,
    readsTable,
    'book_id = ? AND deleted_at IS NULL',
    [bookId],
    'number, created_at',
  );
}

/** The book's most recent live read (highest number), whatever its outcome. */
export function latestRead(db: Db, bookId: string): Read | undefined {
  return bookReads(db, bookId).at(-1);
}

/** The book's most recent live read that is still in progress. */
export function inProgressRead(db: Db, bookId: string): Read | undefined {
  return bookReads(db, bookId)
    .filter((read) => read.outcome === 'in_progress')
    .at(-1);
}

/** Next read number for a book (counting soft-deleted reads, so numbers are never reused). */
export function nextReadNumber(db: Db, bookId: string): number {
  const row = all<{ n: number | null }>(
    db,
    'SELECT MAX(number) AS n FROM reads WHERE book_id = ?',
    [bookId],
  )[0];
  return (row?.n ?? 0) + 1;
}

// --- Sessions ----------------------------------------------------------------

export function findSession(db: Db, id: string): Session | undefined {
  return live(findById(db, sessionsTable, id));
}

export function readSessions(db: Db, readId: string): Session[] {
  return findMany(
    db,
    sessionsTable,
    'read_id = ? AND deleted_at IS NULL',
    [readId],
    'started_at, id',
  );
}

/**
 * Re-derives start/end percents for every session of a format (after its
 * length changed). Rows whose percents change get `updated_at = at`.
 */
export function recomputeFormatSessions(db: Db, format: BookFormat, at: string): number {
  let changed = 0;
  for (const session of findMany(db, sessionsTable, 'format_id = ?', [format.id])) {
    const startPercent = computePercent(session.progressUnit, session.startValue, format);
    const endPercent = computePercent(session.progressUnit, session.endValue, format);
    if (startPercent === session.startPercent && endPercent === session.endPercent) continue;
    upsertRow(db, sessionsTable, { ...session, startPercent, endPercent, updatedAt: at });
    changed += 1;
  }
  return changed;
}

// --- Notes -------------------------------------------------------------------

export function findNote(db: Db, id: string): BookNote | undefined {
  return live(findById(db, notesTable, id));
}

export function bookNotes(db: Db, bookId: string): BookNote[] {
  return findMany(
    db,
    notesTable,
    'book_id = ? AND deleted_at IS NULL',
    [bookId],
    'created_at, rowid',
  );
}

// --- Tags --------------------------------------------------------------------

export function findTag(db: Db, id: string): Tag | undefined {
  return live(findById(db, tagsTable, id));
}

export function listTags(db: Db): Tag[] {
  return findMany(db, tagsTable, 'deleted_at IS NULL', [], 'name_key, id');
}

/** A live tag with the same case-insensitive name, other than `exceptId`. */
export function findTagByName(db: Db, name: string, exceptId?: string): Tag | undefined {
  return findMany(db, tagsTable, 'name_key = ? AND deleted_at IS NULL AND id != ?', [
    tagNameKey(name),
    exceptId ?? '',
  ])[0];
}

/** Soft-deletes a tag and removes its links from books. */
export function softDeleteTag(db: Db, id: string, at: string): void {
  run(db, 'DELETE FROM book_tags WHERE tag_id = ?', [id]);
  run(db, 'UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
}

// --- Goals -------------------------------------------------------------------

export function findGoal(db: Db, id: string): Goal | undefined {
  return live(findById(db, goalsTable, id));
}

export function listGoals(db: Db): Goal[] {
  return findMany(db, goalsTable, 'deleted_at IS NULL', [], 'kind, year, id');
}

/** A live goal with the same kind and year, other than `exceptId`. */
export function findGoalByKindYear(
  db: Db,
  kind: Goal['kind'],
  year: number | null,
  exceptId: string,
): Goal | undefined {
  return findMany(
    db,
    goalsTable,
    'kind = ? AND ifnull(year, 0) = ? AND deleted_at IS NULL AND id != ?',
    [kind, year ?? 0, exceptId],
  )[0];
}

// --- Soft delete & timer -----------------------------------------------------

export type SoftDeletable = 'book_formats' | 'reads' | 'sessions' | 'book_notes' | 'goals';

export function softDelete(db: Db, table: SoftDeletable, id: string, at: string): void {
  run(db, `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [at, at, id]);
}

export function findTimer(db: Db): ActiveTimer | undefined {
  return findMany(db, timerTable, '1 = 1', [], 'created_at')[0];
}

export function saveTimer(db: Db, timer: ActiveTimer): void {
  run(db, 'DELETE FROM active_timer WHERE id != ?', [timer.id]);
  upsertRow(db, timerTable, timer);
}

export function deleteTimer(db: Db): void {
  run(db, 'DELETE FROM active_timer');
}
