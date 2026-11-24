/**
 * JSON backups (SPEC §5/§7): full export of the whole family in a versioned
 * envelope, and all-or-nothing import that always writes a pre-import
 * snapshot first.
 *
 * - A backup holds the catalogue (books, formats), the members (profile and
 *   admin flag only: never PIN hashes, failed attempts, locks or sign-in
 *   sessions), every member's shelf entries (with their tag links) and their
 *   reads, sessions, notes, tags, goals, timers and import provenance, each
 *   with its `memberId`. Soft-deleted rows are included, and so is import
 *   provenance (so a restored library can still be re-imported without
 *   duplicates).
 * - Import replaces all user data: the catalogue and every member's personal
 *   data. Members are upserted by id, keeping existing PIN hashes; members
 *   missing from the database are added without a PIN; members absent from
 *   the backup are kept, without personal data.
 * - A backup from before family profiles (schema version below
 *   {@link FAMILY_BACKUP_VERSION}) restores every row into the owner, with
 *   the books' status, rating and tags becoming the owner's shelf entries.
 * - Server-internal state (settings, sync op log, Notion page mapping and
 *   sign-in sessions) is not part of a backup.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FAMILY_BACKUP_VERSION,
  localDateKey,
  type BackupCounts,
  type BackupData,
  type BackupEnvelope,
  type BackupImportResponse,
  type FamilyBackupEnvelope,
  type LegacyBackupData,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { all, isConstraintError, run, transaction } from '../db/database.ts';
import { currentSchemaVersion } from '../db/migrate.ts';
import { AppError, validationError } from '../http/errors.ts';
import {
  listCatalogue,
  listShelfEntries,
  replaceBookTags,
  saveCatalogueBook,
  saveShelfEntry,
} from '../repositories/books.ts';
import { deleteAllImportLinks, listImportLinks, saveImportLink } from '../repositories/imports.ts';
import {
  findOwner,
  hasLiveAdmin,
  listMemberRecords,
  upsertMemberRecord,
} from '../repositories/members.ts';
import { listTimers, saveTimer } from '../repositories/records.ts';
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

/** Tag links of every member, keyed by `memberId:bookId`. */
function tagLinksByShelf(ctx: AppContext): Map<string, string[]> {
  const rows = all<{ member_id: string; book_id: string; tag_id: string }>(
    ctx.db,
    `SELECT t.member_id, bt.book_id, bt.tag_id FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
     ORDER BY bt.book_id, t.name_key, bt.tag_id`,
  );
  const links = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.member_id}:${row.book_id}`;
    links.set(key, [...(links.get(key) ?? []), row.tag_id]);
  }
  return links;
}

export function exportBackup(ctx: AppContext): FamilyBackupEnvelope {
  const { db } = ctx;
  const links = tagLinksByShelf(ctx);
  const shared = new Set(
    all<{ id: string }>(db, 'SELECT id FROM book_notes WHERE shared = 1').map((row) => row.id),
  );
  const data: BackupData = {
    members: listMemberRecords(db),
    books: listCatalogue(db),
    shelfEntries: listShelfEntries(db).map((entry) => ({
      ...entry,
      tagIds: links.get(`${entry.memberId}:${entry.bookId}`) ?? [],
    })),
    formats: findMany(db, formatsTable),
    reads: findMany(db, readsTable),
    sessions: findMany(db, sessionsTable),
    tags: findMany(db, tagsTable),
    notes: findMany(db, notesTable).map((note) => ({ ...note, shared: shared.has(note.id) })),
    goals: findMany(db, goalsTable),
    timers: listTimers(db),
    importLinks: listImportLinks(db),
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
    timer: data.timers.length,
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
  'shelf_entries',
  'tags',
  'goals',
  'books',
] as const;

/**
 * Converts a backup from before family profiles into the family format:
 * every row becomes the owner's, and the books' status, rating and tags
 * become the owner's shelf entries. Its members list is empty, so the owner
 * (already in the database) is kept as is.
 */
export function fromLegacyBackup(data: LegacyBackupData, ownerId: string): BackupData {
  const owned = <T>(row: T) => ({ ...row, memberId: ownerId });
  return {
    members: [],
    books: data.books.map(({ status: _status, rating: _rating, tagIds: _tagIds, ...book }) => book),
    shelfEntries: data.books.map((book) => ({
      memberId: ownerId,
      bookId: book.id,
      status: book.status,
      rating: book.rating,
      tagIds: book.tagIds,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      deletedAt: book.deletedAt,
    })),
    formats: data.formats,
    reads: data.reads.map(owned),
    sessions: data.sessions.map(owned),
    tags: data.tags.map(owned),
    notes: data.notes.map((note) => ({ ...owned(note), shared: false })),
    goals: data.goals.map(owned),
    timers: data.timer ? [owned(data.timer)] : [],
    importLinks: data.importLinks.map(owned),
  };
}

function backupData(ctx: AppContext, envelope: BackupEnvelope): BackupData {
  if (envelope.schemaVersion >= FAMILY_BACKUP_VERSION) return envelope.data as BackupData;
  const owner = findOwner(ctx.db);
  if (!owner) throw new AppError(500, 'internal_error', 'No owner member exists');
  return fromLegacyBackup(envelope.data as LegacyBackupData, owner.id);
}

/** Every tag link must use a tag of the shelf entry's member. */
function assertOwnTagLinks(data: BackupData): void {
  const tagOwners = new Map(data.tags.map((tag) => [tag.id, tag.memberId]));
  for (const entry of data.shelfEntries) {
    const foreign = entry.tagIds.find((id) => tagOwners.get(id) !== entry.memberId);
    if (foreign) {
      throw validationError(
        `Backup is inconsistent and was not imported (tag ${foreign} is not the shelf owner’s); existing data is unchanged`,
      );
    }
  }
}

function restore(ctx: AppContext, data: BackupData, at: string): void {
  const { db } = ctx;
  for (const table of USER_TABLES_CHILD_FIRST) run(db, `DELETE FROM ${table}`);
  deleteAllImportLinks(db);
  for (const member of data.members) upsertMemberRecord(db, member);
  if (!hasLiveAdmin(db)) {
    throw validationError(
      'Backup is inconsistent and was not imported (it leaves no admin); existing data is unchanged',
    );
  }
  assertOwnTagLinks(data);
  for (const book of data.books) saveCatalogueBook(db, book);
  for (const tag of data.tags) insertRow(db, tagsTable, tag);
  for (const { tagIds, ...entry } of data.shelfEntries) {
    saveShelfEntry(db, entry);
    replaceBookTags(db, entry.memberId, entry.bookId, tagIds, at);
  }
  for (const format of data.formats) insertRow(db, formatsTable, format);
  for (const read of data.reads) insertRow(db, readsTable, read);
  for (const session of data.sessions) insertRow(db, sessionsTable, session);
  for (const { shared, ...note } of data.notes) {
    insertRow(db, notesTable, note);
    if (shared) run(db, 'UPDATE book_notes SET shared = 1 WHERE id = ?', [note.id]);
  }
  for (const goal of data.goals) insertRow(db, goalsTable, goal);
  for (const timer of data.timers) saveTimer(db, timer);
  for (const link of data.importLinks) saveImportLink(db, link);
}

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
  const data = backupData(ctx, envelope);
  const snapshot = writeSnapshot(ctx, 'pre-import');
  const at = nowIso(ctx);
  try {
    transaction(ctx.db, () => {
      restore(ctx, data, at);
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
