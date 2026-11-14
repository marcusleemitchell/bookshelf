/**
 * Bookpine CSV import (SPEC §8, ADR 0009).
 *
 * - `previewBookpine`: parses and plans the export, then applies it inside a
 *   transaction that is always rolled back, so the report is exactly what an
 *   import would do — and nothing is written.
 * - `importBookpine`: looks books up (cover, synopsis, genres, page count)
 *   before touching the database, writes a pre-import snapshot, applies the
 *   plan in one transaction, then caches covers.
 *
 * Provenance (`import_links`) makes re-imports idempotent: every imported
 * record is keyed by the book's anchor slug plus a suffix, and remembers the
 * values the import last wrote. On re-import a field is only updated while
 * it still holds that value (otherwise the user edited it and it is kept);
 * rows the user deleted are not re-created.
 */
import { randomUUID } from 'node:crypto';
import {
  type Book,
  type BookCandidate,
  type BookFormat,
  type BookNote,
  type BookpineReport,
  type BookRecord,
  type FormatType,
  type ImportLink,
  type ImportLinkEntity,
  type ImportWarning,
  type Read,
  type Session,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { rollbackOnly, transaction, type Db } from '../db/database.ts';
import { AppError, conflict, validationError } from '../http/errors.ts';
import { BookpineFormatError, parseBookpineCsv } from '../import/bookpine.ts';
import {
  normaliseKey,
  planImport,
  titleKeys,
  type ImportPlan,
  type PlannedBook,
} from '../import/plan.ts';
import { findBook, listBooks, replaceBookTags, saveBook } from '../repositories/books.ts';
import { findImportLink, linksToLocal, saveImportLink } from '../repositories/imports.ts';
import {
  bookFormats,
  bookReads,
  findTagByName,
  nextReadNumber,
  recomputeFormatSessions,
} from '../repositories/records.ts';
import {
  findById,
  formatsTable,
  insertRow,
  notesTable,
  readsTable,
  sessionsTable,
  tagsTable,
  upsertRow,
} from '../repositories/tables.ts';
import { writeSnapshot } from './backup.ts';
import { cacheCover } from './covers.ts';
import { completeIsbns } from './library.ts';
import { lookupIsbn, searchBooks } from './lookup.ts';
import { derivePercents } from './sessions.ts';

const SOURCE = 'bookpine';
/** Pause between books while looking them up (polite to Open Library). */
export const ENRICH_INTERVAL_MS = 1000;
/** Pause between cover downloads after an import. */
export const COVER_INTERVAL_MS = 300;

const running = new WeakSet<Db>();

/** Parses and plans a Bookpine export; a file that is not one is a 400. */
export function readBookpinePlan(ctx: AppContext, csv: string): ImportPlan {
  let plan: ImportPlan;
  try {
    plan = planImport(parseBookpineCsv(csv), ctx.config.timeZone);
  } catch (error) {
    if (error instanceof BookpineFormatError) throw validationError(error.message);
    throw error;
  }
  if (plan.rows === 0) throw validationError('The Bookpine export has no books');
  return plan;
}

// --- Targets -------------------------------------------------------------------

interface Target {
  planned: PlannedBook;
  /** The existing book (live or deleted), or null to create one. */
  book: Book | null;
  /** True when an existing book that was never imported was matched by ISBN or title. */
  matched: boolean;
  /** Values the import last wrote to the book (empty when new or matched). */
  base: Record<string, unknown>;
  /** Prefix of every provenance key of this book. */
  anchor: string;
}

function titleAuthorKey(title: string, authors: readonly string[]): string {
  return `${titleKeys(title).main}\u0000${normaliseKey(authors[0] ?? '')}`;
}

/** Finds which existing book (if any) each planned book is. Read-only. */
function resolveTargets(ctx: AppContext, plan: ImportPlan, warnings: ImportWarning[]): Target[] {
  const { db } = ctx;
  const live = listBooks(db);
  const byIsbn = new Map<string, Book>();
  const byTitle = new Map<string, Book>();
  for (const book of live) {
    for (const isbn of [book.isbn13, book.isbn10])
      if (isbn && !byIsbn.has(isbn)) byIsbn.set(isbn, book);
    const key = titleAuthorKey(
      [book.title, book.subtitle].filter(Boolean).join(': '),
      book.authors,
    );
    if (!byTitle.has(key)) byTitle.set(key, book);
  }
  const claimed = new Set<string>();
  return plan.books.map((planned): Target => {
    const links = planned.slugs
      .map((slug) => findImportLink(db, SOURCE, 'book', slug))
      .filter((link): link is ImportLink => link !== undefined);
    const linkedIds = [...new Set(links.map((link) => link.localId))];
    if (linkedIds.length > 1) {
      warnings.push({
        slug: planned.anchor,
        message: `These editions were imported as ${linkedIds.length} separate books before; updating the first and linking the others to it`,
      });
    }
    const first = links[0];
    let book = first ? (findBook(db, first.localId, true) ?? null) : null;
    let matched = false;
    if (!book) {
      book =
        planned.isbns.map((isbn) => byIsbn.get(isbn)).find((b) => b && !claimed.has(b.id)) ??
        [byTitle.get(titleAuthorKey(planned.title, planned.authors))].find(
          (b) => b && !claimed.has(b.id),
        ) ??
        null;
      if (book) {
        matched = linksToLocal(db, 'book', book.id).length === 0;
        warnings.push({
          slug: planned.anchor,
          message: `Linked to “${book.title}”, already in your library, instead of adding it again`,
        });
      }
    }
    if (book) claimed.add(book.id);
    const linkedSlugs = book ? linksToLocal(db, 'book', book.id).map((l) => l.externalId) : [];
    const anchor = linkedSlugs.length > 0 ? ([...linkedSlugs].sort()[0] as string) : planned.anchor;
    return { planned, book, matched, base: first?.imported ?? {}, anchor };
  });
}

// --- Enrichment ----------------------------------------------------------------

type Enrichment =
  | { status: 'found'; candidate: BookCandidate }
  | { status: 'notFound' }
  | { status: 'failed'; message: string };

function needsEnrichment(db: Db, target: Target): boolean {
  const { book } = target;
  if (!book) return true;
  if (book.deletedAt !== null) return false;
  const formatsMissingPages = bookFormats(db, book.id).some(
    (f) => f.format !== 'audiobook' && f.pageCount === null,
  );
  return (
    book.synopsis === null ||
    book.coverUrl === null ||
    book.genres.length === 0 ||
    formatsMissingPages
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.status === 404;
}

/** Looks a book up by ISBN-13, then ISBN-10, then title and author. Never throws for lookups. */
async function enrich(ctx: AppContext, planned: PlannedBook): Promise<Enrichment> {
  try {
    for (const isbn of [planned.isbn13, planned.isbn10]) {
      if (!isbn) continue;
      try {
        return { status: 'found', candidate: await lookupIsbn(ctx, isbn) };
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    const query = [planned.title, planned.authors[0]].filter(Boolean).join(' ');
    const results = await searchBooks(ctx, query.slice(0, 200), 1);
    const want = titleKeys(planned.title).main;
    const candidate = results.find((result) => titleKeys(result.title).main === want);
    return candidate ? { status: 'found', candidate } : { status: 'notFound' };
  } catch (error) {
    if (error instanceof AppError) return { status: 'failed', message: error.message };
    throw error;
  }
}

// --- Applying ------------------------------------------------------------------

function emptyCounts() {
  return { created: 0, updated: 0, unchanged: 0, skipped: 0 };
}

function blankReport(plan: ImportPlan, dryRun: boolean): BookpineReport {
  return {
    dryRun,
    rows: plan.rows,
    books: { ...emptyCounts(), matched: 0 },
    merges: plan.merges,
    formats: emptyCounts(),
    reads: emptyCounts(),
    sessions: { ...emptyCounts(), untimed: 0 },
    notes: emptyCounts(),
    tags: { created: 0, names: [] },
    keptEdits: 0,
    enrichment: { pending: 0, found: 0, notFound: 0, failed: 0 },
    covers: { cached: 0, failed: 0 },
    warnings: [...plan.warnings],
    snapshot: null,
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/**
 * Three-way merge of imported fields into a row: a field takes the incoming
 * value when the row still holds what the import last wrote (`base`), or —
 * without a base — when it is empty; otherwise the user's value is kept.
 * Returns the merged row, whether it changed, and the new base.
 */
function merge3<T extends Record<string, unknown>>(
  current: T,
  base: Record<string, unknown>,
  incoming: Partial<T>,
  report: BookpineReport,
): { row: T; changed: boolean; base: Record<string, unknown> } {
  const row = { ...current };
  const nextBase = { ...base };
  let changed = false;
  for (const [field, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    nextBase[field] = value;
    const now = current[field];
    if (same(now, value)) continue;
    const untouched = field in base ? same(now, base[field]) : isEmpty(now);
    if (untouched) {
      (row as Record<string, unknown>)[field] = value;
      changed = true;
    } else {
      report.keptEdits += 1;
    }
  }
  return { row, changed, base: nextBase };
}

interface ApplyContext {
  ctx: AppContext;
  at: string;
  report: BookpineReport;
}

function link(
  apply: ApplyContext,
  entity: ImportLinkEntity,
  externalId: string,
  localId: string,
  imported: Record<string, unknown>,
): void {
  saveImportLink(apply.ctx.db, {
    source: SOURCE,
    entity,
    externalId,
    localId,
    imported,
    importedAt: apply.at,
  });
}

function bookFields(planned: PlannedBook) {
  return {
    title: planned.title,
    subtitle: planned.subtitle,
    authors: planned.authors,
    publishedDate: planned.publishedDate,
    language: planned.language,
    ...completeIsbns(planned.isbn10, planned.isbn13),
    status: planned.status,
    rating: planned.rating,
  };
}

function enrichmentFields(enrichment: Enrichment | undefined) {
  if (enrichment?.status !== 'found') return {};
  const { candidate } = enrichment;
  return {
    synopsis: candidate.synopsis ?? undefined,
    coverUrl: candidate.coverUrl ?? undefined,
    genres: candidate.genres.length > 0 ? candidate.genres : undefined,
    publisher: candidate.publisher ?? undefined,
  };
}

/** Adds the planned tags (creating missing ones); returns true when the book's tags changed. */
function applyTags(
  apply: ApplyContext,
  book: Book,
  names: readonly string[],
  base: unknown,
): boolean {
  const { db } = apply.ctx;
  const previous = new Set(Array.isArray(base) ? (base as string[]) : []);
  const current = new Set(book.tagIds);
  const ids = [...book.tagIds];
  for (const name of names) {
    let tag = findTagByName(db, name);
    if (!tag) {
      tag = {
        id: randomUUID(),
        name,
        colour: null,
        createdAt: apply.at,
        updatedAt: apply.at,
        deletedAt: null,
      };
      insertRow(db, tagsTable, tag);
      apply.report.tags.created += 1;
      apply.report.tags.names.push(name);
    }
    // A tag imported before but no longer on the book was removed by the user.
    if (!current.has(tag.id) && !previous.has(name)) ids.push(tag.id);
  }
  if (ids.length === book.tagIds.length) return false;
  replaceBookTags(db, book.id, ids, apply.at);
  return true;
}

function applyBook(
  apply: ApplyContext,
  target: Target,
  enrichment: Enrichment | undefined,
): Book | null {
  const { db } = apply.ctx;
  const { report, at } = apply;
  const { planned } = target;
  if (target.book?.deletedAt) {
    report.books.skipped += 1;
    report.warnings.push({
      slug: planned.anchor,
      message: 'Deleted in Bookshelf after an earlier import; not imported again',
    });
    return null;
  }
  const incoming = { ...bookFields(planned), ...enrichmentFields(enrichment) };
  let book: Book;
  let base: Record<string, unknown>;
  let changed = false;
  if (!target.book) {
    const found = enrichment?.status === 'found' ? enrichment.candidate : null;
    const record: BookRecord = {
      id: randomUUID(),
      ...bookFields(planned),
      publisher: found?.publisher ?? null,
      synopsis: found?.synopsis ?? null,
      coverUrl: found?.coverUrl ?? null,
      coverPath: null,
      genres: found?.genres ?? [],
      source: found?.source ?? 'manual',
      sourceId: found?.sourceId ?? null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    saveBook(db, record);
    book = { ...record, tagIds: [] };
    base = Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined));
  } else {
    const merged = merge3(target.book, target.base, incoming, report);
    book = merged.row;
    base = merged.base;
    changed = merged.changed;
  }
  const tagsChanged = applyTags(apply, book, planned.tags, target.base['tags']);
  base['tags'] = planned.tags;
  if (target.book && (changed || tagsChanged)) saveBook(db, { ...book, updatedAt: at });
  if (!target.book) report.books.created += 1;
  else if (target.matched) report.books.matched += 1;
  else if (changed || tagsChanged) report.books.updated += 1;
  else report.books.unchanged += 1;
  for (const slug of planned.slugs) link(apply, 'book', slug, book.id, base);
  return findBook(db, book.id) ?? null;
}

function liveRow<T extends { deletedAt: string | null }>(row: T | undefined): T | undefined {
  return row && row.deletedAt === null ? row : undefined;
}

function applyFormats(
  apply: ApplyContext,
  target: Target,
  book: Book,
  enrichment: Enrichment | undefined,
): Map<FormatType, BookFormat> {
  const { db } = apply.ctx;
  const { report, at } = apply;
  const result = new Map<FormatType, BookFormat>();
  const enrichedPages = enrichment?.status === 'found' ? enrichment.candidate.pageCount : null;
  for (const planned of target.planned.formats) {
    const key = `${target.anchor}#format:${planned.type}`;
    const existingLink = findImportLink(db, SOURCE, 'format', key);
    const linked = existingLink ? findById(db, formatsTable, existingLink.localId) : undefined;
    const sameType = bookFormats(db, book.id).find((f) => f.format === planned.type);
    const incoming = {
      pageCount:
        planned.type === 'audiobook' ? null : (planned.pageCount ?? enrichedPages ?? undefined),
      audioDurationSeconds: planned.type === 'audiobook' ? planned.audioDurationSeconds : null,
      isbn: planned.isbn,
    };
    let format = liveRow(linked) ?? sameType;
    let base = liveRow(linked) ? (existingLink?.imported ?? {}) : {};
    if (!format && linked) {
      // The user deleted the imported format and has no other of this type.
      report.formats.skipped += 1;
      continue;
    }
    if (!format) {
      format = {
        id: randomUUID(),
        bookId: book.id,
        format: planned.type,
        pageCount: incoming.pageCount ?? null,
        audioDurationSeconds: incoming.audioDurationSeconds,
        isbn: incoming.isbn,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      };
      insertRow(db, formatsTable, format);
      base = incoming;
      report.formats.created += 1;
    } else {
      const merged = merge3(format, base, incoming, report);
      base = merged.base;
      if (merged.changed) {
        const lengthChanged =
          merged.row.pageCount !== format.pageCount ||
          merged.row.audioDurationSeconds !== format.audioDurationSeconds;
        format = { ...merged.row, updatedAt: at };
        upsertRow(db, formatsTable, format);
        if (lengthChanged) recomputeFormatSessions(db, format, at);
        report.formats.updated += 1;
      } else {
        report.formats.unchanged += 1;
      }
    }
    link(apply, 'format', key, format.id, base);
    result.set(planned.type, format);
  }
  return result;
}

function applyReads(
  apply: ApplyContext,
  target: Target,
  book: Book,
  formats: Map<FormatType, BookFormat>,
): void {
  const { db } = apply.ctx;
  const { report, at } = apply;
  const plannedSessions = target.planned.reads.reduce((n, r) => n + r.sessions.length, 0);
  if (target.matched && bookReads(db, book.id).length > 0) {
    report.reads.skipped += target.planned.reads.length;
    report.sessions.skipped += plannedSessions;
    if (target.planned.reads.length > 0) {
      report.warnings.push({
        slug: target.anchor,
        message:
          'Already has reading history in Bookshelf; its Bookpine readings were not imported',
      });
    }
    return;
  }
  for (const plannedRead of target.planned.reads) {
    const readKey = `${target.anchor}#${plannedRead.suffix}`;
    const readLink = findImportLink(db, SOURCE, 'read', readKey);
    const linkedRead = readLink ? findById(db, readsTable, readLink.localId) : undefined;
    if (linkedRead?.deletedAt) {
      report.reads.skipped += 1;
      report.sessions.skipped += plannedRead.sessions.length;
      continue;
    }
    const incoming = {
      startedAt: plannedRead.startedAt,
      finishedAt: plannedRead.finishedAt,
      outcome: plannedRead.outcome,
    };
    let read: Read;
    let readBase: Record<string, unknown>;
    if (!linkedRead) {
      read = {
        id: randomUUID(),
        bookId: book.id,
        number: nextReadNumber(db, book.id),
        ...incoming,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      };
      insertRow(db, readsTable, read);
      readBase = incoming;
      report.reads.created += 1;
    } else {
      const merged = merge3(linkedRead, readLink?.imported ?? {}, incoming, report);
      readBase = merged.base;
      read = merged.row;
      if (merged.changed) {
        read = { ...read, updatedAt: at };
        upsertRow(db, readsTable, read);
        report.reads.updated += 1;
      } else {
        report.reads.unchanged += 1;
      }
    }
    link(apply, 'read', readKey, read.id, readBase);

    for (const plannedSession of plannedRead.sessions) {
      const format = formats.get(plannedSession.format);
      const key = `${target.anchor}#${plannedSession.suffix}`;
      const sessionLink = findImportLink(db, SOURCE, 'session', key);
      const linked = sessionLink ? findById(db, sessionsTable, sessionLink.localId) : undefined;
      if (!format || linked?.deletedAt) {
        report.sessions.skipped += 1;
        continue;
      }
      const incomingSession = {
        readId: read.id,
        formatId: format.id,
        startedAt: plannedSession.startedAt,
        endedAt: plannedSession.endedAt,
        progressUnit: plannedSession.progressUnit,
        startValue: plannedSession.startValue,
        endValue: plannedSession.endValue,
      };
      let session: Session;
      let sessionBase: Record<string, unknown>;
      if (!linked) {
        session = {
          id: randomUUID(),
          bookId: book.id,
          ...incomingSession,
          durationSeconds: null,
          ...derivePercents(
            format,
            plannedSession.progressUnit,
            plannedSession.startValue,
            plannedSession.endValue,
          ),
          note: null,
          source: 'bookpine',
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        };
        insertRow(db, sessionsTable, session);
        sessionBase = incomingSession;
        report.sessions.created += 1;
      } else {
        const merged = merge3(linked, sessionLink?.imported ?? {}, incomingSession, report);
        sessionBase = merged.base;
        session = merged.row;
        if (merged.changed) {
          const sessionFormat = findById(db, formatsTable, session.formatId) ?? format;
          session = {
            ...session,
            ...derivePercents(
              sessionFormat,
              session.progressUnit,
              session.startValue,
              session.endValue,
            ),
            updatedAt: at,
          };
          upsertRow(db, sessionsTable, session);
          report.sessions.updated += 1;
        } else {
          report.sessions.unchanged += 1;
        }
      }
      if (session.durationSeconds === null) report.sessions.untimed += 1;
      link(apply, 'session', key, session.id, sessionBase);
    }
  }
}

function applyNotes(apply: ApplyContext, target: Target, book: Book): void {
  const { db } = apply.ctx;
  const { report, at } = apply;
  for (const plannedNote of target.planned.notes) {
    const key = `${target.anchor}#${plannedNote.suffix}`;
    const noteLink = findImportLink(db, SOURCE, 'note', key);
    const linked = noteLink ? findById(db, notesTable, noteLink.localId) : undefined;
    if (linked?.deletedAt) {
      report.notes.skipped += 1;
      continue;
    }
    const incoming = { text: plannedNote.text };
    let note: BookNote;
    let base: Record<string, unknown>;
    if (!linked) {
      note = {
        id: randomUUID(),
        bookId: book.id,
        kind: 'note',
        text: plannedNote.text,
        location: null,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      };
      insertRow(db, notesTable, note);
      base = incoming;
      report.notes.created += 1;
    } else {
      const merged = merge3(linked, noteLink?.imported ?? {}, incoming, report);
      base = merged.base;
      note = merged.row;
      if (merged.changed) {
        upsertRow(db, notesTable, { ...note, updatedAt: at });
        report.notes.updated += 1;
      } else {
        report.notes.unchanged += 1;
      }
    }
    link(apply, 'note', key, note.id, base);
  }
}

/** Applies the plan to the database (the caller provides the transaction). */
function applyPlan(
  ctx: AppContext,
  plan: ImportPlan,
  report: BookpineReport,
  enrichments: ReadonlyMap<PlannedBook, Enrichment>,
): Book[] {
  const apply: ApplyContext = { ctx, at: nowIso(ctx), report };
  const targets = resolveTargets(ctx, plan, report.warnings);
  const touched: Book[] = [];
  for (const target of targets) {
    const enrichment = enrichments.get(target.planned);
    const book = applyBook(apply, target, enrichment);
    if (!book) {
      const sessions = target.planned.reads.reduce((n, r) => n + r.sessions.length, 0);
      report.reads.skipped += target.planned.reads.length;
      report.sessions.skipped += sessions;
      report.notes.skipped += target.planned.notes.length;
      report.formats.skipped += target.planned.formats.length;
      continue;
    }
    const formats = applyFormats(apply, target, book, enrichment);
    applyReads(apply, target, book, formats);
    applyNotes(apply, target, book);
    touched.push(book);
  }
  return touched;
}

/** Runs one preview or import at a time per database (409 otherwise). */
async function guard<T>(ctx: AppContext, fn: () => Promise<T>): Promise<T> {
  if (running.has(ctx.db)) throw conflict('A Bookpine import is already running');
  running.add(ctx.db);
  try {
    return await fn();
  } finally {
    running.delete(ctx.db);
  }
}

/** `POST /api/import/bookpine/preview`: what an import would do; writes nothing. */
export function previewBookpine(ctx: AppContext, csv: string): Promise<BookpineReport> {
  return guard(ctx, () => {
    const plan = readBookpinePlan(ctx, csv);
    const report = blankReport(plan, true);
    const lookups = resolveTargets(ctx, plan, []);
    report.enrichment.pending = lookups.filter((target) => needsEnrichment(ctx.db, target)).length;
    rollbackOnly(ctx.db, () => applyPlan(ctx, plan, report, new Map()));
    return Promise.resolve(report);
  });
}

export interface ImportOptions {
  /** Called before each lookup with (done, total), e.g. for CLI progress. */
  onLookup?: (done: number, total: number) => void;
}

/** `POST /api/import/bookpine`: enrich, snapshot, apply in one transaction, cache covers. */
export function importBookpine(
  ctx: AppContext,
  csv: string,
  options: ImportOptions = {},
): Promise<BookpineReport> {
  return guard(ctx, async () => {
    const plan = readBookpinePlan(ctx, csv);
    const report = blankReport(plan, false);

    const toEnrich = resolveTargets(ctx, plan, []).filter((target) =>
      needsEnrichment(ctx.db, target),
    );
    const enrichments = new Map<PlannedBook, Enrichment>();
    for (const [index, target] of toEnrich.entries()) {
      if (index > 0) await ctx.sleep(ENRICH_INTERVAL_MS);
      options.onLookup?.(index, toEnrich.length);
      const result = await enrich(ctx, target.planned);
      enrichments.set(target.planned, result);
      if (result.status === 'found') {
        report.enrichment.found += 1;
      } else if (result.status === 'notFound') {
        report.enrichment.notFound += 1;
        report.warnings.push({
          slug: target.planned.anchor,
          message: 'Not found by ISBN or title; imported without a cover or synopsis',
        });
      } else {
        report.enrichment.failed += 1;
        report.warnings.push({
          slug: target.planned.anchor,
          message: `Lookup failed (${result.message}); imported without a cover or synopsis`,
        });
      }
    }

    report.snapshot = writeSnapshot(ctx, 'pre-import');
    const touched = transaction(ctx.db, () => applyPlan(ctx, plan, report, enrichments));

    let first = true;
    for (const book of touched) {
      const current = findBook(ctx.db, book.id);
      if (!current?.coverUrl || current.coverPath) continue;
      if (!first) await ctx.sleep(COVER_INTERVAL_MS);
      first = false;
      if (await cacheCover(ctx, current.id, current.coverUrl)) report.covers.cached += 1;
      else report.covers.failed += 1;
    }
    ctx.logger.info('Bookpine import finished', {
      rows: report.rows,
      books: report.books,
      reads: report.reads,
      sessions: report.sessions,
      enrichment: report.enrichment,
      warnings: report.warnings.length,
      snapshot: report.snapshot,
    });
    return report;
  });
}
