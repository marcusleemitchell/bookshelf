/**
 * Offline outbox replay (SPEC §5, ADR 0004).
 *
 * - Ops are applied in order, each in its own transaction.
 * - Idempotent by `opId`: applied/stale ops are recorded in `sync_ops`;
 *   replaying one returns the original status with `duplicate: true`.
 * - Last-write-wins per row: an op is ignored (`stale`) when the stored row's
 *   `updated_at` is newer than the op's `clientUpdatedAt`; otherwise the row
 *   is replaced and stamped with `clientUpdatedAt`.
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
  type BookRecord,
  type SyncEntity,
  type SyncOp,
  type SyncOpResult,
  type SyncResponse,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { isConstraintError, run, transaction } from '../db/database.ts';
import { AppError, conflict, validationError } from '../http/errors.ts';
import { replaceBookTags, saveBook, softDeleteBookCascade } from '../repositories/books.ts';
import {
  deleteTimer,
  findTag,
  findTagByName,
  findGoalByKindYear,
  findTimer,
  recomputeFormatSessions,
  saveTimer,
  softDelete,
  softDeleteTag,
} from '../repositories/records.ts';
import { findSyncOp, recordSyncOp } from '../repositories/state.ts';
import {
  booksTable,
  findById,
  formatsTable,
  goalsTable,
  notesTable,
  readsTable,
  sessionsTable,
  rowMeta,
  tagsTable,
  upsertRow,
  type Table,
  type TableName,
} from '../repositories/tables.ts';
import { cacheCover, clearCover } from './covers.ts';
import { completeIsbns } from './library.ts';
import { derivePercents, validateSessionShape } from './sessions.ts';

type Status = 'applied' | 'stale';

interface OpContext {
  ctx: AppContext;
  at: string;
  /** Books whose cover must be (re)cached after commit; null URL = clear. */
  coverJobs: Map<string, string | null>;
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

function requireRow<T>(op: OpContext, table: Table<T>, id: string, label: string): T {
  const row = findById(op.ctx.db, table, id);
  if (!row) throw new AppError(404, 'not_found', `Unknown ${label} ${id}`);
  return row;
}

function syncTimestamps(existing: { createdAt: string } | undefined, at: string) {
  return { createdAt: existing?.createdAt ?? at, updatedAt: at, deletedAt: null };
}

function assertSameBook(existing: { bookId: string } | undefined, bookId: string, label: string) {
  if (existing && existing.bookId !== bookId) {
    throw validationError(`A ${label} cannot be moved to another book`);
  }
}

const upserts: Record<SyncEntity, (op: OpContext, payload: unknown) => Status> = {
  book(op, payload) {
    const p = parsePayload(syncPayloadSchemas.book, payload);
    const { db } = op.ctx;
    const existing = findById(db, booksTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    const coverChanged = existing?.coverUrl !== p.coverUrl;
    const { tagIds, ...fields } = p;
    const record: BookRecord = {
      ...fields,
      ...completeIsbns(p.isbn10, p.isbn13),
      coverPath: coverChanged ? null : existing.coverPath,
      ...syncTimestamps(existing, op.at),
    };
    saveBook(db, record);
    if (tagIds) {
      replaceBookTags(
        db,
        p.id,
        tagIds.filter((id) => findTag(db, id)),
        op.at,
      );
    }
    if (coverChanged) op.coverJobs.set(p.id, p.coverUrl);
    return 'applied';
  },

  format(op, payload) {
    const p = parsePayload(syncPayloadSchemas.format, payload);
    const { db } = op.ctx;
    requireRow(op, booksTable, p.bookId, 'bookId');
    const existing = findById(db, formatsTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    assertSameBook(existing, p.bookId, 'format');
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
    requireRow(op, booksTable, p.bookId, 'bookId');
    const existing = findById(op.ctx.db, readsTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    assertSameBook(existing, p.bookId, 'read');
    upsertRow(op.ctx.db, readsTable, { ...p, ...syncTimestamps(existing, op.at) });
    return 'applied';
  },

  session(op, payload) {
    const p = parsePayload(syncPayloadSchemas.session, payload);
    requireRow(op, booksTable, p.bookId, 'bookId');
    const read = requireRow(op, readsTable, p.readId, 'readId');
    const format = requireRow(op, formatsTable, p.formatId, 'formatId');
    if (read.bookId !== p.bookId) throw validationError('readId does not belong to this book');
    validateSessionShape(p, format);
    const existing = findById(op.ctx.db, sessionsTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    upsertRow(op.ctx.db, sessionsTable, {
      ...p,
      ...derivePercents(format, p.progressUnit, p.startValue, p.endValue),
      ...syncTimestamps(existing, op.at),
    });
    return 'applied';
  },

  tag(op, payload) {
    const p = parsePayload(syncPayloadSchemas.tag, payload);
    const existing = findById(op.ctx.db, tagsTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    if (findTagByName(op.ctx.db, p.name, p.id))
      throw conflict(`A tag named "${p.name}" already exists`);
    upsertRow(op.ctx.db, tagsTable, { ...p, ...syncTimestamps(existing, op.at) });
    return 'applied';
  },

  note(op, payload) {
    const p = parsePayload(syncPayloadSchemas.note, payload);
    requireRow(op, booksTable, p.bookId, 'bookId');
    const existing = findById(op.ctx.db, notesTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    assertSameBook(existing, p.bookId, 'note');
    upsertRow(op.ctx.db, notesTable, { ...p, ...syncTimestamps(existing, op.at) });
    return 'applied';
  },

  goal(op, payload) {
    const p = parsePayload(syncPayloadSchemas.goal, payload);
    if ((p.kind === 'minutes_per_day') !== (p.year === null)) {
      throw validationError(
        'year is required for per-year goals and must be null for minutes_per_day',
      );
    }
    const existing = findById(op.ctx.db, goalsTable, p.id);
    if (isStale(existing, op.at)) return 'stale';
    if (findGoalByKindYear(op.ctx.db, p.kind, p.year, p.id)) {
      throw conflict(`Another ${p.kind} goal already exists for that period`);
    }
    upsertRow(op.ctx.db, goalsTable, { ...p, ...syncTimestamps(existing, op.at) });
    return 'applied';
  },

  timer(op, payload) {
    const p = parsePayload(syncPayloadSchemas.timer, payload);
    requireRow(op, booksTable, p.bookId, 'bookId');
    const format = requireRow(op, formatsTable, p.formatId, 'formatId');
    if (format.bookId !== p.bookId) throw validationError('formatId does not belong to this book');
    const existing = findTimer(op.ctx.db);
    if (isStale(existing, op.at)) return 'stale';
    saveTimer(op.ctx.db, {
      ...p,
      createdAt: existing?.id === p.id ? existing.createdAt : op.at,
      updatedAt: op.at,
    });
    return 'applied';
  },
};

const deleteTables: Record<Exclude<SyncEntity, 'timer'>, TableName> = {
  book: 'books',
  format: 'book_formats',
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
    const timer = findTimer(db);
    if (timer?.id !== id) return 'applied';
    if (isStale(timer, op.at)) return 'stale';
    deleteTimer(db);
    return 'applied';
  }
  const table = deleteTables[entity];
  const existing = rowMeta(db, table, id);
  if (!existing || existing.deletedAt !== null) return 'applied';
  if (isStale(existing, op.at)) return 'stale';
  if (table === 'books') {
    softDeleteBookCascade(db, id, op.at);
  } else if (table === 'tags') {
    softDeleteTag(db, id, op.at);
  } else {
    softDelete(db, table, id, op.at);
    if (table === 'book_formats') run(db, 'DELETE FROM active_timer WHERE format_id = ?', [id]);
  }
  return 'applied';
}

function processOp(ctx: AppContext, op: SyncOp, coverJobs: OpContext['coverJobs']): SyncOpResult {
  const prior = findSyncOp(ctx.db, op.opId);
  if (prior) return { opId: op.opId, status: prior.status, duplicate: true };
  const pendingCovers = new Map<string, string | null>();
  const opContext: OpContext = { ctx, at: op.clientUpdatedAt, coverJobs: pendingCovers };
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

/** `POST /api/sync`. */
export async function processSync(ctx: AppContext, ops: readonly SyncOp[]): Promise<SyncResponse> {
  const coverJobs = new Map<string, string | null>();
  const results = ops.map((op) => processOp(ctx, op, coverJobs));
  for (const [bookId, url] of coverJobs) {
    if (url) await cacheCover(ctx, bookId, url);
    else clearCover(ctx, bookId);
  }
  return { results };
}
