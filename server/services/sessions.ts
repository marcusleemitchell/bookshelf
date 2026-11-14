/**
 * Reading sessions (SPEC §4–§5). Percents are always derived server-side
 * from the progress unit and the format's length.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  computePercent,
  currentProgress,
  percentToUnit,
  progressUnitError,
  startOfLocalDay,
  addDays,
  type BookFormat,
  type ProgressUnit,
  type Session,
  type SessionListQuery,
  type SessionUpdate,
  type sessionCreateSchema,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { all, transaction, type SqlValue } from '../db/database.ts';
import { conflict, notFound, validationError } from '../http/errors.ts';
import { findBook, saveBook } from '../repositories/books.ts';
import {
  findFormat,
  findRead,
  findSession,
  inProgressRead,
  nextReadNumber,
  readSessions,
  softDelete,
} from '../repositories/records.ts';
import {
  findById,
  fromRow,
  insertRow,
  readsTable,
  sessionsTable,
  upsertRow,
} from '../repositories/tables.ts';

export type SessionCreateInput = z.output<typeof sessionCreateSchema>;

/** Start/end percents for a session's values against its format. */
export function derivePercents(
  format: BookFormat,
  unit: ProgressUnit,
  startValue: number | null,
  endValue: number | null,
): { startPercent: number | null; endPercent: number | null } {
  return {
    startPercent: computePercent(unit, startValue, format),
    endPercent: computePercent(unit, endValue, format),
  };
}

/** Checks the cross-field rules shared by REST and sync writes. Throws validation errors. */
export function validateSessionShape(
  session: Pick<Session, 'startedAt' | 'endedAt' | 'progressUnit' | 'bookId'>,
  format: BookFormat,
): void {
  if (format.bookId !== session.bookId) {
    throw validationError('formatId does not belong to this book');
  }
  const unitError = progressUnitError(session.progressUnit, format.format);
  if (unitError) throw validationError(unitError);
  if (Date.parse(session.endedAt) < Date.parse(session.startedAt)) {
    throw validationError('endedAt must not be before startedAt');
  }
}

function defaultDuration(startedAt: string, endedAt: string): number {
  return Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
}

/**
 * `POST /api/sessions`. Uses the given read, else the book's in-progress
 * read, else opens a new one. A `to_read` or `paused` book becomes `reading`.
 */
export function createSession(ctx: AppContext, input: SessionCreateInput): Session {
  const at = nowIso(ctx);
  return transaction(ctx.db, () => {
    const book = findBook(ctx.db, input.bookId);
    if (!book) throw validationError('Unknown bookId');
    const format = findFormat(ctx.db, input.formatId);
    if (!format) throw validationError('Unknown formatId');
    validateSessionShape({ ...input, bookId: book.id }, format);
    if (input.id && findById(ctx.db, sessionsTable, input.id)) {
      throw conflict(`A record with id ${input.id} already exists`);
    }

    let read = input.readId ? findRead(ctx.db, input.readId) : inProgressRead(ctx.db, book.id);
    if (input.readId && read?.bookId !== book.id) {
      throw validationError('readId does not belong to this book');
    }
    if (!read) {
      read = {
        id: randomUUID(),
        bookId: book.id,
        number: nextReadNumber(ctx.db, book.id),
        startedAt: input.startedAt,
        finishedAt: null,
        outcome: 'in_progress',
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      };
      insertRow(ctx.db, readsTable, read);
    } else if (input.startedAt < read.startedAt) {
      // A session logged retrospectively moves the read's start back to it.
      read = { ...read, startedAt: input.startedAt, updatedAt: at };
      upsertRow(ctx.db, readsTable, read);
    }

    const startValue =
      input.startValue !== undefined
        ? input.startValue
        : (percentToUnit(
            input.progressUnit,
            currentProgress(readSessions(ctx.db, read.id)),
            format,
          ) ?? 0);
    const session: Session = {
      id: input.id ?? randomUUID(),
      readId: read.id,
      bookId: book.id,
      formatId: format.id,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationSeconds:
        input.durationSeconds !== undefined
          ? input.durationSeconds
          : defaultDuration(input.startedAt, input.endedAt),
      progressUnit: input.progressUnit,
      startValue,
      endValue: input.endValue,
      ...derivePercents(format, input.progressUnit, startValue, input.endValue),
      note: input.note,
      source: 'app',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    insertRow(ctx.db, sessionsTable, session);
    // Logging reading puts a to-read or paused book (back) on the reading shelf.
    if (book.status === 'to_read' || book.status === 'paused') {
      saveBook(ctx.db, { ...book, status: 'reading', updatedAt: at });
    }
    return session;
  });
}

function requireSession(ctx: AppContext, id: string): Session {
  const session = findSession(ctx.db, id);
  if (!session) throw notFound('Session');
  return session;
}

/** `PATCH /api/sessions/:id`: merges fields and re-derives percents. */
export function updateSession(ctx: AppContext, id: string, patch: SessionUpdate): Session {
  const existing = requireSession(ctx, id);
  const at = nowIso(ctx);
  return transaction(ctx.db, () => {
    const format = findFormat(ctx.db, patch.formatId ?? existing.formatId);
    if (!format) throw validationError('Unknown formatId');
    const merged: Session = { ...existing, ...patch, updatedAt: at };
    validateSessionShape(merged, format);
    const session: Session = {
      ...merged,
      ...derivePercents(format, merged.progressUnit, merged.startValue, merged.endValue),
    };
    upsertRow(ctx.db, sessionsTable, session);
    return session;
  });
}

/** `DELETE /api/sessions/:id` (soft delete). */
export function deleteSession(ctx: AppContext, id: string): void {
  requireSession(ctx, id);
  softDelete(ctx.db, 'sessions', id, nowIso(ctx));
}

/** `GET /api/sessions`: live sessions of live books, newest first. */
export function listSessions(ctx: AppContext, query: SessionListQuery): Session[] {
  const where = ['s.deleted_at IS NULL', 'b.deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (query.bookId) {
    where.push('s.book_id = ?');
    params.push(query.bookId);
  }
  if (query.from) {
    where.push('s.started_at >= ?');
    params.push(startOfLocalDay(query.from, ctx.config.timeZone).toISOString());
  }
  if (query.to) {
    where.push('s.started_at < ?');
    params.push(startOfLocalDay(addDays(query.to, 1), ctx.config.timeZone).toISOString());
  }
  return all(
    ctx.db,
    `SELECT s.* FROM sessions s JOIN books b ON b.id = s.book_id
     WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC, s.id`,
    params,
  ).map((row) => fromRow(sessionsTable, row));
}
