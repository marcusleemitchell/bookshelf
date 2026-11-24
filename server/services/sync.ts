/**
 * Offline outbox replay (SPEC §5, ADR 0004, ADR 0010).
 *
 * - Ops are applied in order, each in its own transaction, for the signed-in
 *   member (never a member named in the payload).
 * - Idempotent by `opId`: applied/stale ops are recorded in `sync_ops`;
 *   replaying one returns the original status with `duplicate: true`.
 * - Last-write-wins per row: an op is ignored (`stale`) when the stored row's
 *   `updated_at` is newer than the op's `clientUpdatedAt`; otherwise the row
 *   is replaced and stamped with `clientUpdatedAt`. For books, the row is the
 *   member's shelf entry: a `book` upsert creates the catalogue book when it
 *   is new and otherwise only applies status, rating and tags to the
 *   member's shelf, so last-write-wins only ever resolves one person's edits.
 * - Personal rows (reads, sessions, notes, tags, goals, timer) must be the
 *   member's: another member's row id is a `forbidden` op error, and a book
 *   that was never on the member's shelf is `not_found`. Changing an existing
 *   format needs a parent or an admin (`forbidden` for a child); adding one
 *   does not.
 * - Sync is row replication: REST side effects (e.g. opening a read when a
 *   session is logged) are not repeated, so clients send every row they
 *   changed. Session percents are still derived server-side.
 * - Rejected ops are not recorded, so the client may fix and retry them.
 */
import type { z } from 'zod';
import {
  formatLengthError,
  syncDeletePayloadSchema,
  syncPayloadSchemas,
  type BookFormat,
  type CatalogueBook,
  type SyncEntity,
  type SyncOp,
  type SyncOpResult,
  type SyncResponse,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { isConstraintError, run, transaction } from '../db/database.ts';
import { AppError, conflict, forbidden, validationError } from '../http/errors.ts';
import {
  findCatalogueBook,
  findShelfEntry,
  removeFromShelf,
  replaceBookTags,
  saveCatalogueBook,
  saveShelfEntry,
} from '../repositories/books.ts';
import {
  deleteTimer,
  findGoalByKindYear,
  findTag,
  findTagByName,
  findTimer,
  recomputeFormatSessions,
  saveTimer,
  softDelete,
  softDeleteTag,
} from '../repositories/records.ts';
import { findSyncOp, recordSyncOp } from '../repositories/state.ts';
import {
  findById,
  formatsTable,
  goalsTable,
  notesTable,
  personalRowMeta,
  readsTable,
  rowMeta,
  sessionsTable,
  tagsTable,
  timerTable,
  upsertRow,
  type Owned,
  type PersonalTableName,
  type Table,
} from '../repositories/tables.ts';
import { completeIsbns } from './library.ts';
import { canEditCatalogue, type MemberScope } from './scope.ts';
import { cacheCover } from './covers.ts';
import { derivePercents, validateSessionShape } from './sessions.ts';

type Status = 'applied' | 'stale';

interface OpContext {
  ctx: AppContext;
  scope: MemberScope;
  /** The member whose data the op writes. */
  memberId: string;
  at: string;
  /** New catalogue books whose cover must be cached after commit. */
  coverJobs: Map<string, string>;
}

function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw validationError(`Invalid payload: ${where}${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}

function isStale(existing: { updatedAt: string } | undefined, at: string): boolean {
  return existing !== undefined && existing.updatedAt > at;
}

function unknown(label: string, id: string): AppError {
  return new AppError(404, 'not_found', `Unknown ${label} ${id}`);
}

function notYours(label: string, id: string): AppError {
  return forbidden(`The ${label} ${id} belongs to another member`);
}

function requireRow<T>(op: OpContext, table: Table<T>, id: string, label: string): T {
  const row = findById(op.ctx.db, table, id);
  if (!row) throw unknown(label, id);
  return row;
}

/**
 * The member's row with `id` (any state), or undefined when no such row
 * exists. Another member's row is `forbidden`.
 */
function ownRow<T>(
  op: OpContext,
  table: Table<Owned<T>>,
  id: string,
  label: string,
): Owned<T> | undefined {
  const row = findById(op.ctx.db, table, id);
  if (row && row.memberId !== op.memberId) throw notYours(label, id);
  return row;
}

/**
 * Checks that the book has been on the member's shelf (a shelf entry, live
 * or removed, like a deleted book row before family profiles).
 */
function requireShelf(op: OpContext, bookId: string): void {
  if (!findShelfEntry(op.ctx.db, op.memberId, bookId)) throw unknown('bookId', bookId);
}

function syncTimestamps(existing: { createdAt: string } | undefined, at: string) {
  return { createdAt: existing?.createdAt ?? at, updatedAt: at, deletedAt: null };
}

function assertSameBook(existing: { bookId: string } | undefined, bookId: string, label: string) {
  if (existing && existing.bookId !== bookId) {
    throw validationError(`A ${label} cannot be moved to another book`);
  }
}

const FORMAT_FIELDS = ['bookId', 'format', 'pageCount', 'audioDurationSeconds', 'isbn'] as const;

function sameFormat(
  existing: BookFormat,
  incoming: Pick<BookFormat, (typeof FORMAT_FIELDS)[number]>,
) {
  return (
    existing.deletedAt === null && FORMAT_FIELDS.every((key) => existing[key] === incoming[key])
  );
}

const upserts: Record<SyncEntity, (op: OpContext, payload: unknown) => Status> = {
  book(op, payload) {
    const p = parsePayload(syncPayloadSchemas.book, payload);
    const { db } = op.ctx;
    const entry = findShelfEntry(db, op.memberId, p.id);
    if (isStale(entry, op.at)) return 'stale';
    const { tagIds, status, rating, ...fields } = p;
    const catalogue = findCatalogueBook(db, p.id);
    if (!catalogue) {
      const record: CatalogueBook = {
        ...fields,
        ...completeIsbns(p.isbn10, p.isbn13),
        coverPath: null,
        ...syncTimestamps(undefined, op.at),
      };
      saveCatalogueBook(db, record);
      if (record.coverUrl) op.coverJobs.set(p.id, record.coverUrl);
    } else if (catalogue.deletedAt !== null) {
      // Back on a shelf: the catalogue book is live again (its fields are kept).
      saveCatalogueBook(db, { ...catalogue, deletedAt: null, updatedAt: op.at });
    }
    saveShelfEntry(db, {
      memberId: op.memberId,
      bookId: p.id,
      status,
      rating,
      ...syncTimestamps(entry, op.at),
    });
    if (tagIds) {
      replaceBookTags(
        db,
        op.memberId,
        p.id,
        tagIds.filter((id) => findTag(db, op.memberId, id)),
        op.at,
      );
    }
    return 'applied';
  },

  format(op, payload) {
    const p = parsePayload(syncPayloadSchemas.format, payload);
    const { db } = op.ctx;
    requireShelf(op, p.bookId);
    const existing = findById(db, formatsTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    assertSameBook(existing, p.bookId, 'format');
    if (existing && !canEditCatalogue(op.scope)) {
      if (sameFormat(existing, p)) return 'applied';
      throw forbidden('Only a parent can change a format');
    }
    const lengthError = formatLengthError(p);
    if (lengthError) throw validationError(lengthError);
    const format = { ...p, ...syncTimestamps(existing, op.at) };
    upsertRow(db, formatsTable, format);
    if (
      existing &&
      (existing.pageCount !== format.pageCount ||
        existing.audioDurationSeconds !== format.audioDurationSeconds)
    ) {
      recomputeFormatSessions(db, format, nowIso(op.ctx));
    }
    return 'applied';
  },

  read(op, payload) {
    const p = parsePayload(syncPayloadSchemas.read, payload);
    requireShelf(op, p.bookId);
    const existing = ownRow(op, readsTable, p.id, 'read');
    if (isStale(existing, op.at)) return 'stale';
    assertSameBook(existing, p.bookId, 'read');
    upsertRow(op.ctx.db, readsTable, {
      ...p,
      memberId: op.memberId,
      ...syncTimestamps(existing, op.at),
    });
    return 'applied';
  },

  session(op, payload) {
    const p = parsePayload(syncPayloadSchemas.session, payload);
    requireShelf(op, p.bookId);
    const read = ownRow(op, readsTable, p.readId, 'readId');
    if (!read) throw unknown('readId', p.readId);
    const format = requireRow(op, formatsTable, p.formatId, 'formatId');
    if (read.bookId !== p.bookId) throw validationError('readId does not belong to this book');
    validateSessionShape(p, format);
    const existing = ownRow(op, sessionsTable, p.id, 'session');
    if (isStale(existing, op.at)) return 'stale';
    upsertRow(op.ctx.db, sessionsTable, {
      ...p,
      memberId: op.memberId,
      source: p.source ?? existing?.source ?? 'app',
      ...derivePercents(format, p.progressUnit, p.startValue, p.endValue),
      ...syncTimestamps(existing, op.at),
    });
    return 'applied';
  },

  tag(op, payload) {
    const p = parsePayload(syncPayloadSchemas.tag, payload);
    const existing = ownRow(op, tagsTable, p.id, 'tag');
    if (isStale(existing, op.at)) return 'stale';
    if (findTagByName(op.ctx.db, op.memberId, p.name, p.id))
      throw conflict(`A tag named "${p.name}" already exists`);
    upsertRow(op.ctx.db, tagsTable, {
      ...p,
      memberId: op.memberId,
      ...syncTimestamps(existing, op.at),
    });
    return 'applied';
  },

  note(op, payload) {
    const p = parsePayload(syncPayloadSchemas.note, payload);
    requireShelf(op, p.bookId);
    const existing = ownRow(op, notesTable, p.id, 'note');
    if (isStale(existing, op.at)) return 'stale';
    assertSameBook(existing, p.bookId, 'note');
    upsertRow(op.ctx.db, notesTable, {
      ...p,
      memberId: op.memberId,
      ...syncTimestamps(existing, op.at),
    });
    return 'applied';
  },

  goal(op, payload) {
    const p = parsePayload(syncPayloadSchemas.goal, payload);
    if ((p.kind === 'minutes_per_day') !== (p.year === null)) {
      throw validationError(
        'year is required for per-year goals and must be null for minutes_per_day',
      );
    }
    const existing = ownRow(op, goalsTable, p.id, 'goal');
    if (isStale(existing, op.at)) return 'stale';
    if (findGoalByKindYear(op.ctx.db, op.memberId, p.kind, p.year, p.id)) {
      throw conflict(`Another ${p.kind} goal already exists for that period`);
    }
    upsertRow(op.ctx.db, goalsTable, {
      ...p,
      memberId: op.memberId,
      ...syncTimestamps(existing, op.at),
    });
    return 'applied';
  },

  timer(op, payload) {
    const p = parsePayload(syncPayloadSchemas.timer, payload);
    requireShelf(op, p.bookId);
    const format = requireRow(op, formatsTable, p.formatId, 'formatId');
    if (format.bookId !== p.bookId) throw validationError('formatId does not belong to this book');
    ownRow(op, timerTable, p.id, 'timer');
    const existing = findTimer(op.ctx.db, op.memberId);
    if (isStale(existing, op.at)) return 'stale';
    saveTimer(op.ctx.db, {
      ...p,
      memberId: op.memberId,
      createdAt: existing?.id === p.id ? existing.createdAt : op.at,
      updatedAt: op.at,
    });
    return 'applied';
  },
};

const personalTables: Record<'read' | 'session' | 'tag' | 'note' | 'goal', PersonalTableName> = {
  read: 'reads',
  session: 'sessions',
  tag: 'tags',
  note: 'book_notes',
  goal: 'goals',
};

function applyDelete(op: OpContext, entity: SyncEntity, payload: unknown): Status {
  const { id } = parsePayload(syncDeletePayloadSchema, payload);
  const { db } = op.ctx;
  if (entity === 'timer') {
    ownRow(op, timerTable, id, 'timer');
    const timer = findTimer(db, op.memberId);
    if (timer?.id !== id) return 'applied';
    if (isStale(timer, op.at)) return 'stale';
    deleteTimer(db, op.memberId);
    return 'applied';
  }
  if (entity === 'book') {
    // Removes the book from the member's shelf (the catalogue goes with the last shelf).
    const entry = findShelfEntry(db, op.memberId, id);
    if (!entry || entry.deletedAt !== null) return 'applied';
    if (isStale(entry, op.at)) return 'stale';
    removeFromShelf(db, op.memberId, id, op.at);
    return 'applied';
  }
  if (entity === 'format') {
    const existing = rowMeta(db, 'book_formats', id);
    if (!existing || existing.deletedAt !== null) return 'applied';
    if (!canEditCatalogue(op.scope)) throw forbidden('Only a parent can delete a format');
    if (isStale(existing, op.at)) return 'stale';
    softDelete(db, 'book_formats', id, op.at);
    run(db, 'DELETE FROM active_timer WHERE format_id = ?', [id]);
    return 'applied';
  }
  const table = personalTables[entity];
  const existing = personalRowMeta(db, table, id);
  if (existing && existing.memberId !== op.memberId) throw notYours(entity, id);
  if (!existing || existing.deletedAt !== null) return 'applied';
  if (isStale(existing, op.at)) return 'stale';
  if (table === 'tags') softDeleteTag(db, id, op.at);
  else softDelete(db, table, id, op.at);
  return 'applied';
}

function processOp(
  ctx: AppContext,
  scope: MemberScope,
  op: SyncOp,
  coverJobs: OpContext['coverJobs'],
): SyncOpResult {
  const prior = findSyncOp(ctx.db, op.opId);
  if (prior) return { opId: op.opId, status: prior.status, duplicate: true };
  const pendingCovers = new Map<string, string>();
  const opContext: OpContext = {
    ctx,
    scope,
    memberId: scope.member.id,
    at: op.clientUpdatedAt,
    coverJobs: pendingCovers,
  };
  try {
    const status = transaction(ctx.db, () => {
      const result =
        op.action === 'delete'
          ? applyDelete(opContext, op.entity, op.payload)
          : upserts[op.entity](opContext, op.payload);
      recordSyncOp(ctx.db, {
        opId: op.opId,
        entity: op.entity,
        action: op.action,
        status: result,
        clientUpdatedAt: op.clientUpdatedAt,
        processedAt: nowIso(ctx),
      });
      return result;
    });
    for (const [bookId, url] of pendingCovers) coverJobs.set(bookId, url);
    return { opId: op.opId, status, duplicate: false };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        opId: op.opId,
        status: 'error',
        duplicate: false,
        error: { code: error.code, message: error.message },
      };
    }
    if (isConstraintError(error)) {
      return {
        opId: op.opId,
        status: 'error',
        duplicate: false,
        error: {
          code: 'conflict',
          message: `Write violates a database constraint: ${error.message}`,
        },
      };
    }
    ctx.logger.error('Sync op failed unexpectedly', { opId: op.opId, entity: op.entity, error });
    return {
      opId: op.opId,
      status: 'error',
      duplicate: false,
      error: { code: 'internal_error', message: 'Unexpected error while applying the op' },
    };
  }
}

/** `POST /api/sync`: applies the ops for the scope's member. */
export async function processSync(
  ctx: AppContext,
  scope: MemberScope,
  ops: readonly SyncOp[],
): Promise<SyncResponse> {
  const coverJobs = new Map<string, string>();
  const results = ops.map((op) => processOp(ctx, scope, op, coverJobs));
  for (const [bookId, url] of coverJobs) await cacheCover(ctx, bookId, url);
  return { results };
}
