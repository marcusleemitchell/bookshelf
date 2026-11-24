/**
 * Library operations (SPEC §5): books, formats, reads and book tags,
 * including read bookkeeping when a book's status changes. Books are the
 * shared catalogue seen through the member's shelf (ADR 0010): status,
 * rating, tags, reads and sessions are the member's; catalogue fields and
 * formats are shared, and only parents and admins may edit or delete them.
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
  type BookStatus,
  type CatalogueBook,
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
  findCatalogueBook,
  findCatalogueBookByIsbn13,
  findShelfEntry,
  listBooks,
  removeFromShelf,
  replaceBookTags,
  saveCatalogueBook,
  saveShelfEntry,
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
  type Owned,
  type TableName,
} from '../repositories/tables.ts';
import { cacheCover, clearCover, coverSrc } from './covers.ts';
import { requireCatalogueEditor, type MemberScope } from './scope.ts';

export type BookCreateInput = z.output<typeof bookCreateSchema>;
export type FormatCreateInput = z.output<typeof formatCreateSchema>;

/** A live book on the member's shelf, or a 404 (also for another member's book). */
export function requireBook(ctx: AppContext, scope: MemberScope, id: string): Book {
  const book = findBook(ctx.db, scope.member.id, id);
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

/** Throws a validation error unless every tag ID refers to a live tag of the member. */
export function assertTagsExist(
  ctx: AppContext,
  memberId: string,
  tagIds: readonly string[],
): void {
  const missing = tagIds.filter((id) => !findTag(ctx.db, memberId, id));
  if (missing.length > 0) throw validationError(`Unknown tag IDs: ${missing.join(', ')}`);
}

export function toListItem(ctx: AppContext, memberId: string, book: Book): BookListItem {
  const read = latestRead(ctx.db, memberId, book.id) ?? null;
  const sessions = read ? readSessions(ctx.db, memberId, read.id) : [];
  return {
    ...book,
    formats: bookFormats(ctx.db, book.id),
    currentRead: read,
    progressPercent: currentProgress(sessions),
    coverSrc: coverSrc(book),
  };
}

export function toDetail(ctx: AppContext, memberId: string, book: Book): BookDetail {
  const item = toListItem(ctx, memberId, book);
  const read = item.currentRead;
  const estimatedFinish =
    read?.outcome === 'in_progress'
      ? estimateFinish({
          currentPercent: item.progressPercent,
          sessions: readSessions(ctx.db, memberId, read.id),
          now: ctx.now(),
          timeZone: ctx.config.timeZone,
        })
      : null;
  return { ...item, reads: bookReads(ctx.db, memberId, book.id), estimatedFinish };
}

/** `GET /api/books`: the member's shelf. */
export function listBookItems(
  ctx: AppContext,
  scope: MemberScope,
  query: BookListQuery,
): BookListItem[] {
  const memberId = scope.member.id;
  return listBooks(ctx.db, memberId, { status: query.status, tagId: query.tag, q: query.q }).map(
    (book) => toListItem(ctx, memberId, book),
  );
}

export function getBookDetail(ctx: AppContext, scope: MemberScope, id: string): BookDetail {
  return toDetail(ctx, scope.member.id, requireBook(ctx, scope, id));
}

function insertRead(
  db: Db,
  memberId: string,
  bookId: string,
  fields: Pick<Read, 'startedAt' | 'finishedAt' | 'outcome'> & { id?: string | undefined },
  at: string,
): Read {
  const read: Owned<Read> = {
    id: fields.id ?? randomUUID(),
    memberId,
    bookId,
    number: nextReadNumber(db, memberId, bookId),
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
 * Keeps the member's reads consistent with a status set through the REST
 * API: `reading` opens a read if none is in progress; `finished`/`dnf` close
 * the in-progress read (or record a closed read when the book has none);
 * `to_read` leaves reads alone, and so does `paused`, which keeps the
 * in-progress read open so resuming continues it.
 */
export function applyStatusToReads(
  db: Db,
  memberId: string,
  bookId: string,
  status: BookStatus,
  at: string,
): void {
  const current = inProgressRead(db, memberId, bookId);
  if (status === 'reading') {
    if (!current)
      insertRead(
        db,
        memberId,
        bookId,
        { startedAt: at, finishedAt: null, outcome: 'in_progress' },
        at,
      );
    return;
  }
  if (status === 'finished' || status === 'dnf') {
    if (current) {
      upsertRow(db, readsTable, { ...current, outcome: status, finishedAt: at, updatedAt: at });
    } else if (bookReads(db, memberId, bookId).length === 0) {
      insertRead(db, memberId, bookId, { startedAt: at, finishedAt: at, outcome: status }, at);
    }
  }
}

/**
 * Changes fields of the member's live shelf entry for the book and stamps it
 * `at`. Callers have checked that the book is on the member's shelf.
 */
export function updateShelfEntry(
  db: Db,
  memberId: string,
  bookId: string,
  patch: { status?: BookStatus | undefined; rating?: number | null | undefined },
  at: string,
): void {
  const entry = findShelfEntry(db, memberId, bookId);
  if (!entry) throw notFound('Book');
  saveShelfEntry(db, {
    ...entry,
    status: patch.status ?? entry.status,
    rating: patch.rating !== undefined ? patch.rating : entry.rating,
    updatedAt: at,
  });
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

/** Throws a 409 when a row with `id` already exists in `table` (even soft-deleted, anyone's). */
export function assertNewId(ctx: AppContext, table: TableName, id: string): void {
  if (rowMeta(ctx.db, table, id)) throw conflict(`A record with id ${id} already exists`);
}

/**
 * `POST /api/books`: puts a book on the member's shelf. A live catalogue
 * book with the same ISBN-13 is reused (409 when it is already on their
 * shelf): the member gets a shelf entry, and each input format of a kind the
 * book lacks is added. Otherwise a catalogue book is created with its
 * formats. Returns the detail of the book on the shelf, whose id may differ
 * from the input's.
 */
export async function createBook(
  ctx: AppContext,
  scope: MemberScope,
  input: BookCreateInput,
): Promise<BookDetail> {
  const at = nowIso(ctx);
  const memberId = scope.member.id;
  const isbns = completeIsbns(input.isbn10, input.isbn13);
  const shelf = (bookId: string) => {
    saveShelfEntry(ctx.db, {
      memberId,
      bookId,
      status: input.status,
      rating: input.rating,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    });
    replaceBookTags(ctx.db, memberId, bookId, input.tagIds, at);
    applyStatusToReads(ctx.db, memberId, bookId, input.status, at);
  };
  const created = transaction(ctx.db, () => {
    assertTagsExist(ctx, memberId, input.tagIds);
    const existing = isbns.isbn13 ? findCatalogueBookByIsbn13(ctx.db, isbns.isbn13) : undefined;
    if (existing) {
      if (findShelfEntry(ctx.db, memberId, existing.id)?.deletedAt === null) {
        throw conflict('This book is already on your shelf');
      }
      const kinds = new Set(bookFormats(ctx.db, existing.id).map((format) => format.format));
      for (const formatInput of input.formats) {
        if (kinds.has(formatInput.format)) continue;
        const format = buildFormat(existing.id, formatInput, at);
        assertNewId(ctx, 'book_formats', format.id);
        insertRow(ctx.db, formatsTable, format);
        kinds.add(format.format);
      }
      shelf(existing.id);
      return { id: existing.id, coverUrl: null };
    }
    const id = input.id ?? randomUUID();
    const record: CatalogueBook = {
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
      ...isbns,
      genres: input.genres,
      source: input.source,
      sourceId: input.sourceId,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    const formats = input.formats.map((format) => buildFormat(id, format, at));
    assertNewId(ctx, 'books', id);
    for (const format of formats) assertNewId(ctx, 'book_formats', format.id);
    saveCatalogueBook(ctx.db, record);
    for (const format of formats) insertRow(ctx.db, formatsTable, format);
    shelf(id);
    return { id, coverUrl: record.coverUrl };
  });
  if (created.coverUrl) await cacheCover(ctx, created.id, created.coverUrl);
  return getBookDetail(ctx, scope, created.id);
}

/**
 * `PATCH /api/books/:id`. Status and rating change the member's shelf entry
 * (with read bookkeeping); catalogue fields change the shared book and need
 * a parent or an admin (403 for a child).
 */
export async function updateBook(
  ctx: AppContext,
  scope: MemberScope,
  id: string,
  patch: BookUpdate,
): Promise<BookDetail> {
  const at = nowIso(ctx);
  const memberId = scope.member.id;
  const existing = requireBook(ctx, scope, id);
  const { status, rating, ...fields } = patch;
  const catalogueChanged = Object.keys(fields).length > 0;
  if (catalogueChanged) requireCatalogueEditor(scope, 'change the details of a book');
  const current = findCatalogueBook(ctx.db, id) as CatalogueBook;
  const merged: CatalogueBook = { ...current, ...fields, updatedAt: at };
  if (fields.isbn10 !== undefined || fields.isbn13 !== undefined) {
    Object.assign(
      merged,
      completeIsbns(
        fields.isbn10 !== undefined ? fields.isbn10 : current.isbn10,
        fields.isbn13 !== undefined ? fields.isbn13 : current.isbn13,
      ),
    );
  }
  const coverChanged = fields.coverUrl !== undefined && fields.coverUrl !== current.coverUrl;
  if (coverChanged) merged.coverPath = null;
  transaction(ctx.db, () => {
    if (catalogueChanged) saveCatalogueBook(ctx.db, merged);
    if (status !== undefined || rating !== undefined) {
      updateShelfEntry(ctx.db, memberId, id, { status, rating }, at);
      if (status !== undefined && status !== existing.status) {
        applyStatusToReads(ctx.db, memberId, id, status, at);
      }
    }
  });
  if (coverChanged) {
    clearCover(ctx, id);
    if (merged.coverUrl) await cacheCover(ctx, id, merged.coverUrl);
  }
  return getBookDetail(ctx, scope, id);
}

/**
 * `DELETE /api/books/:id`: removes the book from the member's shelf with
 * their records on it; the catalogue book goes once no shelf has it.
 */
export function deleteBook(ctx: AppContext, scope: MemberScope, id: string): void {
  requireBook(ctx, scope, id);
  transaction(ctx.db, () => {
    removeFromShelf(ctx.db, scope.member.id, id, nowIso(ctx));
  });
}

/** `PUT /api/books/:id/tags`: replaces the member's tags on the book. */
export function setBookTags(
  ctx: AppContext,
  scope: MemberScope,
  id: string,
  tagIds: readonly string[],
): BookDetail {
  requireBook(ctx, scope, id);
  const memberId = scope.member.id;
  const at = nowIso(ctx);
  transaction(ctx.db, () => {
    assertTagsExist(ctx, memberId, tagIds);
    replaceBookTags(ctx.db, memberId, id, tagIds, at);
    updateShelfEntry(ctx.db, memberId, id, {}, at);
  });
  return getBookDetail(ctx, scope, id);
}

/** `POST /api/books/:id/reads`: starts a reread. */
export function startReread(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  input: ReadCreate,
): Read {
  const book = requireBook(ctx, scope, bookId);
  const memberId = scope.member.id;
  const at = nowIso(ctx);
  return transaction(ctx.db, () => {
    if (inProgressRead(ctx.db, memberId, bookId)) {
      throw conflict('This book already has a read in progress');
    }
    if (input.id) assertNewId(ctx, 'reads', input.id);
    const read = insertRead(
      ctx.db,
      memberId,
      bookId,
      { id: input.id, startedAt: input.startedAt ?? at, finishedAt: null, outcome: 'in_progress' },
      at,
    );
    if (book.status !== 'reading') {
      updateShelfEntry(ctx.db, memberId, bookId, { status: 'reading' }, at);
    }
    return read;
  });
}

function requireFormat(ctx: AppContext, bookId: string, formatId: string): BookFormat {
  const format = findFormat(ctx.db, formatId);
  if (format?.bookId !== bookId) throw notFound('Format');
  return format;
}

/** `POST /api/books/:id/formats`: anyone may add a format to a book on their shelf. */
export function createFormat(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  input: FormatCreateInput,
): BookFormat {
  requireBook(ctx, scope, bookId);
  const format = buildFormat(bookId, input, nowIso(ctx));
  transaction(ctx.db, () => {
    assertNewId(ctx, 'book_formats', format.id);
    insertRow(ctx.db, formatsTable, format);
  });
  return format;
}

/**
 * `PATCH /api/books/:id/formats/:formatId` (parents and admins); re-derives
 * session percents, every member's, when lengths change.
 */
export function updateFormat(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  formatId: string,
  patch: FormatUpdate,
): BookFormat {
  requireBook(ctx, scope, bookId);
  const existing = requireFormat(ctx, bookId, formatId);
  requireCatalogueEditor(scope, 'change a format');
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

/**
 * `DELETE /api/books/:id/formats/:formatId` (parents and admins): soft
 * delete; sessions keep their history, and every member's timer on the
 * format is discarded.
 */
export function deleteFormat(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  formatId: string,
): void {
  requireBook(ctx, scope, bookId);
  requireFormat(ctx, bookId, formatId);
  requireCatalogueEditor(scope, 'delete a format');
  transaction(ctx.db, () => {
    softDelete(ctx.db, 'book_formats', formatId, nowIso(ctx));
    run(ctx.db, 'DELETE FROM active_timer WHERE format_id = ?', [formatId]);
  });
}
