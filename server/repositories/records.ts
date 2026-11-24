/**
 * Queries for the records hanging off a book: formats (shared by the
 * family), and each member's reads, sessions, notes, tags, goals and timer
 * (ADR 0010). Personal queries always take the member's id.
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
  findOwned,
  formatsTable,
  goalsTable,
  notesTable,
  readsTable,
  sessionsTable,
  tagNameKey,
  tagsTable,
  timerTable,
  upsertRow,
  type Owned,
} from './tables.ts';

function live<T extends { deletedAt: string | null }>(row: T | undefined): T | undefined {
  return row && row.deletedAt === null ? row : undefined;
}

// --- Formats (shared) --------------------------------------------------------

export function findFormat(db: Db, id: string): BookFormat | undefined {
  return live(findById(db, formatsTable, id));
}

export function bookFormats(db: Db, bookId: string): BookFormat[] {
  return findMany(db, formatsTable, 'book_id = ? AND deleted_at IS NULL', [bookId]);
}

// --- Reads -------------------------------------------------------------------

export function findRead(db: Db, memberId: string, id: string): Owned<Read> | undefined {
  return live(findOwned(db, readsTable, memberId, id));
}

export function bookReads(db: Db, memberId: string, bookId: string): Owned<Read>[] {
  return findMany(
    db,
    readsTable,
    'member_id = ? AND book_id = ? AND deleted_at IS NULL',
    [memberId, bookId],
    'number, created_at',
  );
}

/** The member's most recent live read of the book (highest number), whatever its outcome. */
export function latestRead(db: Db, memberId: string, bookId: string): Owned<Read> | undefined {
  return bookReads(db, memberId, bookId).at(-1);
}

/** The member's most recent live read of the book that is still in progress. */
export function inProgressRead(db: Db, memberId: string, bookId: string): Owned<Read> | undefined {
  return bookReads(db, memberId, bookId)
    .filter((read) => read.outcome === 'in_progress')
    .at(-1);
}

/**
 * The member's next read number for a book (counting soft-deleted reads, so
 * numbers are never reused). Numbers are per member and book.
 */
export function nextReadNumber(db: Db, memberId: string, bookId: string): number {
  const row = all<{ n: number | null }>(
    db,
    'SELECT MAX(number) AS n FROM reads WHERE member_id = ? AND book_id = ?',
    [memberId, bookId],
  )[0];
  return (row?.n ?? 0) + 1;
}

// --- Sessions ----------------------------------------------------------------

export function findSession(db: Db, memberId: string, id: string): Owned<Session> | undefined {
  return live(findOwned(db, sessionsTable, memberId, id));
}

export function readSessions(db: Db, memberId: string, readId: string): Owned<Session>[] {
  return findMany(
    db,
    sessionsTable,
    'member_id = ? AND read_id = ? AND deleted_at IS NULL',
    [memberId, readId],
    'started_at, id',
  );
}

/**
 * Re-derives start/end percents for every session of a format (after its
 * length changed), whoever logged them: formats are shared. Rows whose
 * percents change get `updated_at = at`.
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

export function findNote(db: Db, memberId: string, id: string): Owned<BookNote> | undefined {
  return live(findOwned(db, notesTable, memberId, id));
}

export function bookNotes(db: Db, memberId: string, bookId: string): Owned<BookNote>[] {
  return findMany(
    db,
    notesTable,
    'member_id = ? AND book_id = ? AND deleted_at IS NULL',
    [memberId, bookId],
    'created_at, rowid',
  );
}

// --- Tags --------------------------------------------------------------------

export function findTag(db: Db, memberId: string, id: string): Owned<Tag> | undefined {
  return live(findOwned(db, tagsTable, memberId, id));
}

export function listTags(db: Db, memberId: string): Owned<Tag>[] {
  return findMany(
    db,
    tagsTable,
    'member_id = ? AND deleted_at IS NULL',
    [memberId],
    'name_key, id',
  );
}

/** The member's live tag with the same case-insensitive name, other than `exceptId`. */
export function findTagByName(
  db: Db,
  memberId: string,
  name: string,
  exceptId?: string,
): Owned<Tag> | undefined {
  return findMany(
    db,
    tagsTable,
    'member_id = ? AND name_key = ? AND deleted_at IS NULL AND id != ?',
    [memberId, tagNameKey(name), exceptId ?? ''],
  )[0];
}

/** Soft-deletes a tag and removes its links from books. */
export function softDeleteTag(db: Db, id: string, at: string): void {
  run(db, 'DELETE FROM book_tags WHERE tag_id = ?', [id]);
  run(db, 'UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
}

// --- Goals -------------------------------------------------------------------

export function findGoal(db: Db, memberId: string, id: string): Owned<Goal> | undefined {
  return live(findOwned(db, goalsTable, memberId, id));
}

export function listGoals(db: Db, memberId: string): Owned<Goal>[] {
  return findMany(
    db,
    goalsTable,
    'member_id = ? AND deleted_at IS NULL',
    [memberId],
    'kind, year, id',
  );
}

/** The member's live goal with the same kind and year, other than `exceptId`. */
export function findGoalByKindYear(
  db: Db,
  memberId: string,
  kind: Goal['kind'],
  year: number | null,
  exceptId: string,
): Owned<Goal> | undefined {
  return findMany(
    db,
    goalsTable,
    'member_id = ? AND kind = ? AND ifnull(year, 0) = ? AND deleted_at IS NULL AND id != ?',
    [memberId, kind, year ?? 0, exceptId],
  )[0];
}

// --- Soft delete & timer -----------------------------------------------------

export type SoftDeletable = 'book_formats' | 'reads' | 'sessions' | 'book_notes' | 'goals';

/** Soft-deletes a row by id; callers check first that it is the member's (or shared). */
export function softDelete(db: Db, table: SoftDeletable, id: string, at: string): void {
  run(db, `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [at, at, id]);
}

/** The member's timer, if any (one per member). */
export function findTimer(db: Db, memberId: string): Owned<ActiveTimer> | undefined {
  return findMany(db, timerTable, 'member_id = ?', [memberId], 'created_at')[0];
}

/** Every member's timer (for backups). */
export function listTimers(db: Db): Owned<ActiveTimer>[] {
  return findMany(db, timerTable);
}

/** Replaces the member's timer with `timer`. */
export function saveTimer(db: Db, timer: Owned<ActiveTimer>): void {
  run(db, 'DELETE FROM active_timer WHERE member_id = ? AND id != ?', [timer.memberId, timer.id]);
  upsertRow(db, timerTable, timer);
}

export function deleteTimer(db: Db, memberId: string): void {
  run(db, 'DELETE FROM active_timer WHERE member_id = ?', [memberId]);
}
