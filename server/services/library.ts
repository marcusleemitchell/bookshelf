/**
 * Library operations (SPEC §5): books, formats, reads and book tags,
 * including read bookkeeping when a book's status changes.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  currentProgress,
  estimateFinish,
  formatLengthError,
  normaliseIsbn,
  progressUnitError,
  type Book,
  type BookDetail,
  type BookFormat,
  type BookListItem,
  type BookListQuery,
  type BookRecord,
  type BookStatus,
  type BookUpdate,
  type FormatUpdate,
  type Read,
  type ReadCreate,
  type bookCreateSchema,
  type formatCreateSchema,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { run, transaction, type Db } from '../db/database.ts';
import { conflict, notFound, validationError } from '../http/errors.ts';
import {
  findBook,
  listBooks,
  replaceBookTags,
  saveBook,
  softDeleteBookCascade,
} from '../repositories/books.ts';
import {
  bookFormats,
  bookReads,
  findFormat,
  findTag,
  inProgressRead,
  latestRead,
  nextReadNumber,
  readSessions,
  recomputeFormatSessions,
  softDelete,
} from '../repositories/records.ts';
import {
  findMany,
  formatsTable,
  insertRow,
  readsTable,
  rowMeta,
  sessionsTable,
  upsertRow,
  type TableName,
} from '../repositories/tables.ts';
import { cacheCover, clearCover, coverSrc } from './covers.ts';

export type BookCreateInput = z.output<typeof bookCreateSchema>;
export type FormatCreateInput = z.output<typeof formatCreateSchema>;

/** A live book or a 404. */
export function requireBook(ctx: AppContext, id: string): Book {
  const book = findBook(ctx.db, id);
  if (!book) throw notFound('Book');
  return book;
}

/** Fills the missing ISBN form from the other one. */
export function completeIsbns(
  isbn10: string | null,
  isbn13: string | null,
): { isbn10: string | null; isbn13: string | null } {
  if (isbn13) {
    return { isbn13, isbn10: isbn10 ?? normaliseIsbn(isbn13)?.isbn10 ?? null };
  }
  if (isbn10) {
    return { isbn10, isbn13: normaliseIsbn(isbn10)?.isbn13 ?? null };
  }
  return { isbn10: null, isbn13: null };
}

/** Throws a validation error unless every tag ID refers to a live tag. */
export function assertTagsExist(ctx: AppContext, tagIds: readonly string[]): void {
  const missing = tagIds.filter((id) => !findTag(ctx.db, id));
  if (missing.length > 0) throw validationError(`Unknown tag IDs: ${missing.join(', ')}`);
}

export function toListItem(ctx: AppContext, book: Book): BookListItem {
  const read = latestRead(ctx.db, book.id) ?? null;
  const sessions = read ? readSessions(ctx.db, read.id) : [];
  return {
    ...book,
    formats: bookFormats(ctx.db, book.id),
    currentRead: read,
    progressPercent: currentProgress(sessions),
    coverSrc: coverSrc(book),
  };
}

export function toDetail(ctx: AppContext, book: Book): BookDetail {
  const item = toListItem(ctx, book);
  const read = item.currentRead;
  const estimatedFinish =
    read?.outcome === 'in_progress'
      ? estimateFinish({
          currentPercent: item.progressPercent,
          sessions: readSessions(ctx.db, read.id),
          now: ctx.now(),
          timeZone: ctx.config.timeZone,
        })
      : null;
  return { ...item, reads: bookReads(ctx.db, book.id), estimatedFinish };
}

export function listBookItems(ctx: AppContext, query: BookListQuery): BookListItem[] {
  return listBooks(ctx.db, { status: query.status, tagId: query.tag, q: query.q }).map((book) =>
    toListItem(ctx, book),
  );
}

export function getBookDetail(ctx: AppContext, id: string): BookDetail {
  return toDetail(ctx, requireBook(ctx, id));
}

function insertRead(
  db: Db,
  bookId: string,
  fields: Pick<Read, 'startedAt' | 'finishedAt' | 'outcome'> & { id?: string | undefined },
  at: string,
): Read {
  const read: Read = {
    id: fields.id ?? randomUUID(),
    bookId,
    number: nextReadNumber(db, bookId),
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt,
    outcome: fields.outcome,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  insertRow(db, readsTable, read);
  return read;
}

/**
 * Keeps reads consistent with a status set through the REST API:
 * `reading` opens a read if none is in progress; `finished`/`dnf` close the
 * in-progress read (or record a closed read when the book has none);
 * `to_read` leaves reads alone.
 */
export function applyStatusToReads(db: Db, bookId: string, status: BookStatus, at: string): void {
  const current = inProgressRead(db, bookId);
  if (status === 'reading') {
    if (!current)
      insertRead(db, bookId, { startedAt: at, finishedAt: null, outcome: 'in_progress' }, at);
    return;
  }
  if (status === 'finished' || status === 'dnf') {
    if (current) {
      upsertRow(db, readsTable, { ...current, outcome: status, finishedAt: at, updatedAt: at });
    } else if (bookReads(db, bookId).length === 0) {
      insertRead(db, bookId, { startedAt: at, finishedAt: at, outcome: status }, at);
    }
  }
}

function validateFormat(fields: Pick<BookFormat, 'format' | 'pageCount' | 'audioDurationSeconds'>) {
  const error = formatLengthError(fields);
  if (error) throw validationError(error);
}

function buildFormat(bookId: string, input: FormatCreateInput, at: string): BookFormat {
  validateFormat(input);
  return {
    id: input.id ?? randomUUID(),
    bookId,
    format: input.format,
    pageCount: input.pageCount,
    audioDurationSeconds: input.audioDurationSeconds,
    isbn: input.isbn,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

/** Throws a 409 when a row with `id` already exists in `table` (even soft-deleted). */
export function assertNewId(ctx: AppContext, table: TableName, id: string): void {
  if (rowMeta(ctx.db, table, id)) throw conflict(`A record with id ${id} already exists`);
}

/** `POST /api/books`: creates a book with formats and tags, then caches its cover. */
export async function createBook(ctx: AppContext, input: BookCreateInput): Promise<BookDetail> {
  const at = nowIso(ctx);
  const id = input.id ?? randomUUID();
  const record: BookRecord = {
    id,
    title: input.title,
    subtitle: input.subtitle,
    authors: input.authors,
    publisher: input.publisher,
    publishedDate: input.publishedDate,
    language: input.language,
    synopsis: input.synopsis,
    coverUrl: input.coverUrl,
    coverPath: null,
    ...completeIsbns(input.isbn10, input.isbn13),
    genres: input.genres,
    source: input.source,
    sourceId: input.sourceId,
    status: input.status,
    rating: input.rating,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  const formats = input.formats.map((format) => buildFormat(id, format, at));
  transaction(ctx.db, () => {
    assertNewId(ctx, 'books', id);
    for (const format of formats) assertNewId(ctx, 'book_formats', format.id);
    assertTagsExist(ctx, input.tagIds);
    saveBook(ctx.db, record);
    for (const format of formats) insertRow(ctx.db, formatsTable, format);
    replaceBookTags(ctx.db, id, input.tagIds, at);
    applyStatusToReads(ctx.db, id, record.status, at);
  });
  if (record.coverUrl) await cacheCover(ctx, id, record.coverUrl);
  return getBookDetail(ctx, id);
}

/** `PATCH /api/books/:id`. */
export async function updateBook(
  ctx: AppContext,
  id: string,
  patch: BookUpdate,
): Promise<BookDetail> {
  const at = nowIso(ctx);
  const existing = requireBook(ctx, id);
  const merged: BookRecord = { ...existing, ...patch, updatedAt: at };
  if (patch.isbn10 !== undefined || patch.isbn13 !== undefined) {
    Object.assign(
      merged,
      completeIsbns(
        patch.isbn10 !== undefined ? patch.isbn10 : existing.isbn10,
        patch.isbn13 !== undefined ? patch.isbn13 : existing.isbn13,
      ),
    );
  }
  const coverChanged = patch.coverUrl !== undefined && patch.coverUrl !== existing.coverUrl;
  if (coverChanged) merged.coverPath = null;
  transaction(ctx.db, () => {
    saveBook(ctx.db, merged);
    if (patch.status !== undefined && patch.status !== existing.status) {
      applyStatusToReads(ctx.db, id, patch.status, at);
    }
  });
  if (coverChanged) {
    clearCover(ctx, id);
    if (merged.coverUrl) await cacheCover(ctx, id, merged.coverUrl);
  }
  return getBookDetail(ctx, id);
}

/** `DELETE /api/books/:id`: soft-deletes the book and its records. */
export function deleteBook(ctx: AppContext, id: string): void {
  requireBook(ctx, id);
  transaction(ctx.db, () => {
    softDeleteBookCascade(ctx.db, id, nowIso(ctx));
  });
}

/** `PUT /api/books/:id/tags`: replaces the book's tags. */
export function setBookTags(ctx: AppContext, id: string, tagIds: readonly string[]): BookDetail {
  const book = requireBook(ctx, id);
  const at = nowIso(ctx);
  transaction(ctx.db, () => {
    assertTagsExist(ctx, tagIds);
    replaceBookTags(ctx.db, id, tagIds, at);
    saveBook(ctx.db, { ...book, updatedAt: at });
  });
  return getBookDetail(ctx, id);
}

/** `POST /api/books/:id/reads`: starts a reread. */
export function startReread(ctx: AppContext, bookId: string, input: ReadCreate): Read {
  const book = requireBook(ctx, bookId);
  const at = nowIso(ctx);
  return transaction(ctx.db, () => {
    if (inProgressRead(ctx.db, bookId)) {
      throw conflict('This book already has a read in progress');
    }
    if (input.id) assertNewId(ctx, 'reads', input.id);
    const read = insertRead(
      ctx.db,
      bookId,
      { id: input.id, startedAt: input.startedAt ?? at, finishedAt: null, outcome: 'in_progress' },
      at,
    );
    if (book.status !== 'reading') saveBook(ctx.db, { ...book, status: 'reading', updatedAt: at });
    return read;
  });
}

function requireFormat(ctx: AppContext, bookId: string, formatId: string): BookFormat {
  const format = findFormat(ctx.db, formatId);
  if (format?.bookId !== bookId) throw notFound('Format');
  return format;
}

/** `POST /api/books/:id/formats`. */
export function createFormat(
  ctx: AppContext,
  bookId: string,
  input: FormatCreateInput,
): BookFormat {
  requireBook(ctx, bookId);
  const format = buildFormat(bookId, input, nowIso(ctx));
  transaction(ctx.db, () => {
    assertNewId(ctx, 'book_formats', format.id);
    insertRow(ctx.db, formatsTable, format);
  });
  return format;
}

/** `PATCH /api/books/:id/formats/:formatId`; re-derives session percents when lengths change. */
export function updateFormat(
  ctx: AppContext,
  bookId: string,
  formatId: string,
  patch: FormatUpdate,
): BookFormat {
  requireBook(ctx, bookId);
  const existing = requireFormat(ctx, bookId, formatId);
  const at = nowIso(ctx);
  const merged: BookFormat = { ...existing, ...patch, updatedAt: at };
  validateFormat(merged);
  transaction(ctx.db, () => {
    if (merged.format !== existing.format) {
      const sessions = findMany(ctx.db, sessionsTable, 'format_id = ? AND deleted_at IS NULL', [
        formatId,
      ]);
      const incompatible = sessions.find((s) => progressUnitError(s.progressUnit, merged.format));
      if (incompatible) {
        throw validationError(
          `Cannot change to ${merged.format}: sessions record progress in ${incompatible.progressUnit}`,
        );
      }
    }
    upsertRow(ctx.db, formatsTable, merged);
    if (
      merged.pageCount !== existing.pageCount ||
      merged.audioDurationSeconds !== existing.audioDurationSeconds
    ) {
      recomputeFormatSessions(ctx.db, merged, at);
    }
  });
  return merged;
}

/** `DELETE /api/books/:id/formats/:formatId`: soft delete; sessions keep their history. */
export function deleteFormat(ctx: AppContext, bookId: string, formatId: string): void {
  requireBook(ctx, bookId);
  requireFormat(ctx, bookId, formatId);
  transaction(ctx.db, () => {
    softDelete(ctx.db, 'book_formats', formatId, nowIso(ctx));
    run(ctx.db, 'DELETE FROM active_timer WHERE format_id = ?', [formatId]);
  });
}
