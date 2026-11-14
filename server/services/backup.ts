/**
 * JSON backups (SPEC §5/§7): full export in a versioned envelope, and
 * all-or-nothing import that always writes a pre-import snapshot first.
 * Backups include soft-deleted rows. Server-internal state (settings, sync
 * op log, Notion page mapping) is not part of a backup.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  localDateKey,
  type BackupCounts,
  type BackupData,
  type BackupEnvelope,
  type BackupImportResponse,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { isConstraintError, run, transaction } from '../db/database.ts';
import { currentSchemaVersion } from '../db/migrate.ts';
import { AppError } from '../http/errors.ts';
import { listAllBooks, replaceBookTags, saveBook } from '../repositories/books.ts';
import { findTimer, saveTimer } from '../repositories/records.ts';
import {
  findMany,
  formatsTable,
  goalsTable,
  insertRow,
  notesTable,
  readsTable,
  sessionsTable,
  tagsTable,
} from '../repositories/tables.ts';

/** Number of daily snapshots kept in `backups/`. */
export const SNAPSHOTS_TO_KEEP = 14;
const DAILY_SNAPSHOT_RE = /^bookshelf-\d{4}-\d{2}-\d{2}\.json$/;

export function exportBackup(ctx: AppContext): BackupEnvelope {
  const { db } = ctx;
  const data: BackupData = {
    books: listAllBooks(db),
    formats: findMany(db, formatsTable),
    reads: findMany(db, readsTable),
    sessions: findMany(db, sessionsTable),
    tags: findMany(db, tagsTable),
    notes: findMany(db, notesTable),
    goals: findMany(db, goalsTable),
    timer: findTimer(db) ?? null,
  };
  return {
    app: 'bookshelf',
    schemaVersion: currentSchemaVersion(db),
    exportedAt: nowIso(ctx),
    data,
  };
}

function countsOf(data: BackupData): BackupCounts {
  return {
    books: data.books.length,
    formats: data.formats.length,
    reads: data.reads.length,
    sessions: data.sessions.length,
    tags: data.tags.length,
    notes: data.notes.length,
    goals: data.goals.length,
    timer: data.timer ? 1 : 0,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

/** Deletes all but the newest {@link SNAPSHOTS_TO_KEEP} daily snapshots. Returns deleted names. */
export function pruneSnapshots(ctx: AppContext): string[] {
  const files = readdirSync(ctx.config.backupsDir)
    .filter((file) => DAILY_SNAPSHOT_RE.test(file))
    .sort()
    .reverse();
  const stale = files.slice(SNAPSHOTS_TO_KEEP);
  for (const file of stale) rmSync(join(ctx.config.backupsDir, file), { force: true });
  return stale;
}

/**
 * Writes the current export to `backups/`. `daily` snapshots are named by
 * local date (`bookshelf-YYYY-MM-DD.json`, overwriting that day's file) and
 * pruned to the newest 14; `pre-import` snapshots are timestamped and kept.
 * Returns the file name.
 */
export function writeSnapshot(ctx: AppContext, kind: 'daily' | 'pre-import'): string {
  mkdirSync(ctx.config.backupsDir, { recursive: true });
  const now = ctx.now();
  const name =
    kind === 'daily'
      ? `bookshelf-${localDateKey(now, ctx.config.timeZone)}.json`
      : `bookshelf-pre-import-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  writeJsonAtomic(join(ctx.config.backupsDir, name), exportBackup(ctx));
  if (kind === 'daily') pruneSnapshots(ctx);
  return name;
}

const USER_TABLES_CHILD_FIRST = [
  'active_timer',
  'book_tags',
  'sessions',
  'book_notes',
  'reads',
  'book_formats',
  'tags',
  'goals',
  'books',
] as const;

/** `POST /api/backup/import`: replaces all user data with the backup's. */
export function importBackup(ctx: AppContext, envelope: BackupEnvelope): BackupImportResponse {
  const supported = currentSchemaVersion(ctx.db);
  if (envelope.schemaVersion > supported) {
    throw new AppError(
      400,
      'unsupported_backup',
      `Backup schema version ${envelope.schemaVersion} is newer than this server supports (${supported})`,
    );
  }
  const snapshot = writeSnapshot(ctx, 'pre-import');
  const { data } = envelope;
  const at = nowIso(ctx);
  try {
    transaction(ctx.db, () => {
      for (const table of USER_TABLES_CHILD_FIRST) run(ctx.db, `DELETE FROM ${table}`);
      for (const book of data.books) saveBook(ctx.db, book);
      for (const tag of data.tags) insertRow(ctx.db, tagsTable, tag);
      for (const book of data.books) replaceBookTags(ctx.db, book.id, book.tagIds, at);
      for (const format of data.formats) insertRow(ctx.db, formatsTable, format);
      for (const read of data.reads) insertRow(ctx.db, readsTable, read);
      for (const session of data.sessions) insertRow(ctx.db, sessionsTable, session);
      for (const note of data.notes) insertRow(ctx.db, notesTable, note);
      for (const goal of data.goals) insertRow(ctx.db, goalsTable, goal);
      if (data.timer) saveTimer(ctx.db, data.timer);
    });
  } catch (error) {
    if (isConstraintError(error)) {
      throw new AppError(
        400,
        'validation_error',
        `Backup is inconsistent and was not imported (${error.message}); existing data is unchanged`,
      );
    }
    throw error;
  }
  ctx.logger.info('Backup imported', { snapshot, counts: countsOf(data) });
  return { imported: countsOf(data), snapshot };
}
