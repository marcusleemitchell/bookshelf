/**
 * Alternative covers and synopses for a catalogue book (SPEC §5, ADR 0011),
 * for the Edit details screen: `GET /api/books/:id/alternatives`.
 *
 * Open Library: the book's edition record (found from its Open Library
 * edition id or ISBN) supplies "This edition" covers and description; the
 * work record (from the edition, the book's work id, or a title + author
 * search whose main title must match) supplies the work description and the
 * covers of every edition. Google Books, queried only when
 * `GOOGLE_BOOKS_API_KEY` is set (keyless requests are refused, ADR 0008),
 * adds the covers and descriptions of volumes with the same main title.
 *
 * Read-only: choosing an alternative is a normal `PATCH /api/books/:id`.
 */
import { z } from 'zod';
import {
  type BookAlternatives,
  type BookCandidate,
  type CatalogueBook,
  type CoverOption,
  type LookupSource,
  type SynopsisOption,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { upstreamError } from '../http/errors.ts';
import { normaliseKey, titleKeys } from '../import/plan.ts';
import { findCatalogueBook } from '../repositories/books.ts';
import { requireBook } from './library.ts';
import {
  attempt,
  cleanDescription,
  googleUrl,
  googleVolumes,
  OPEN_LIBRARY_BASE,
  olTextSchema,
  parseUpstream,
} from './lookup.ts';
import { fetchJson, OutboundError } from './outbound.ts';
import { requireCatalogueEditor, type MemberScope } from './scope.ts';

export const MAX_COVER_OPTIONS = 24;
export const MAX_SYNOPSIS_OPTIONS = 10;
/** Longest synopsis a catalogue book can hold (`catalogueFields.synopsis`). */
const MAX_SYNOPSIS_LENGTH = 20_000;
/** Google Books volumes requested per title + author query. */
export const GOOGLE_ALTERNATIVES_PAGE = 20;
/** Open Library search results checked for a matching title. */
const TITLE_SEARCH_LIMIT = 5;

const EDITION_ID = /^OL\d+M$/;
const WORK_ID = /^OL\d+W$/;
const WORK_KEY = /^\/works\/(OL\d+W)$/;

// --- Upstream payload shapes (only the fields used here) -----------------------

const olCoverIdsSchema = z.array(z.number()).optional();

const olEditionRecordSchema = z.object({
  description: olTextSchema.optional(),
  covers: olCoverIdsSchema,
  works: z.array(z.object({ key: z.string() })).optional(),
});

const olWorkRecordSchema = z.object({
  description: olTextSchema.optional(),
  covers: olCoverIdsSchema,
});

const olTitleSearchSchema = z.object({ docs: z.array(z.unknown()).default([]) });
const olTitleSearchDocSchema = z.object({ key: z.string(), title: z.string() });

type EditionRecord = z.output<typeof olEditionRecordSchema>;

// --- Collecting -------------------------------------------------------------------

/** Accumulates de-duplicated, capped options in the order they were found. */
class Options {
  readonly covers: CoverOption[] = [];
  readonly synopses: SynopsisOption[] = [];
  private readonly coverUrls = new Set<string>();
  private readonly synopsisKeys = new Set<string>();

  addOpenLibraryCovers(ids: readonly number[] | undefined, label: string): void {
    for (const id of ids ?? []) {
      // Open Library uses -1 (and sometimes 0) as a "no cover" placeholder.
      if (!Number.isInteger(id) || id <= 0) continue;
      this.addCover({
        url: `https://covers.openlibrary.org/b/id/${id}-L.jpg`,
        previewUrl: `https://covers.openlibrary.org/b/id/${id}-M.jpg`,
        source: 'openlibrary',
        label,
      });
    }
  }

  addCover(option: CoverOption): void {
    if (this.covers.length >= MAX_COVER_OPTIONS || this.coverUrls.has(option.url)) return;
    this.coverUrls.add(option.url);
    this.covers.push(option);
  }

  addSynopsis(text: string | null, source: LookupSource, label: string): void {
    if (!text || text.length > MAX_SYNOPSIS_LENGTH) return;
    if (this.synopses.length >= MAX_SYNOPSIS_OPTIONS) return;
    // Same words, different spacing or punctuation: the same synopsis.
    const key = normaliseKey(text);
    if (this.synopsisKeys.has(key)) return;
    this.synopsisKeys.add(key);
    this.synopses.push({ text, source, label });
  }
}

/** How each source fared: `failed` when any of its requests failed. */
interface SourceReport {
  attempted: boolean;
  failed: boolean;
}

// --- Open Library ---------------------------------------------------------------

/** Fetches JSON, answering null for a 404 (not known) instead of failing. */
async function fetchJsonOrNull(ctx: AppContext, url: string): Promise<unknown> {
  try {
    return await fetchJson(ctx, url);
  } catch (error) {
    if (error instanceof OutboundError && error.status === 404) return null;
    throw error;
  }
}

/** The book's own edition record: by Open Library edition id, else by ISBN. */
async function findEdition(
  ctx: AppContext,
  book: CatalogueBook,
  report: SourceReport,
): Promise<EditionRecord | null> {
  const paths: string[] = [];
  if (book.source === 'openlibrary' && book.sourceId && EDITION_ID.test(book.sourceId)) {
    paths.push(`/books/${book.sourceId}.json`);
  }
  // `/isbn/<isbn>.json` redirects to the edition record.
  for (const isbn of [book.isbn13, book.isbn10]) if (isbn) paths.push(`/isbn/${isbn}.json`);
  for (const path of paths) {
    const outcome = await attempt(ctx, 'openlibrary', async () => {
      const body = await fetchJsonOrNull(ctx, `${OPEN_LIBRARY_BASE}${path}`);
      return body === null ? null : parseUpstream(olEditionRecordSchema, body, 'Open Library');
    });
    if (!outcome.ok) {
      report.failed = true;
      continue;
    }
    if (outcome.value) return outcome.value;
  }
  return null;
}

/** A work id from an Open Library title + first author search with the same main title. */
async function searchWorkId(
  ctx: AppContext,
  book: CatalogueBook,
  report: SourceReport,
): Promise<string | null> {
  const params = new URLSearchParams({
    title: book.title.slice(0, 200),
    limit: String(TITLE_SEARCH_LIMIT),
    fields: 'key,title',
  });
  const author = book.authors[0];
  if (author) params.set('author', author.slice(0, 200));
  const outcome = await attempt(ctx, 'openlibrary', async () =>
    parseUpstream(
      olTitleSearchSchema,
      await fetchJson(ctx, `${OPEN_LIBRARY_BASE}/search.json?${params.toString()}`),
      'Open Library',
    ),
  );
  if (!outcome.ok) {
    report.failed = true;
    return null;
  }
  const want = titleKeys(book.title).main;
  for (const raw of outcome.value.docs) {
    const doc = olTitleSearchDocSchema.safeParse(raw);
    if (!doc.success || titleKeys(doc.data.title).main !== want) continue;
    const workId = WORK_KEY.exec(doc.data.key)?.[1];
    if (workId) return workId;
  }
  return null;
}

async function collectOpenLibrary(
  ctx: AppContext,
  book: CatalogueBook,
  options: Options,
  report: SourceReport,
): Promise<void> {
  report.attempted = true;
  let workId: string | null =
    book.source === 'openlibrary' && book.sourceId && WORK_ID.test(book.sourceId)
      ? book.sourceId
      : null;

  if (!workId) {
    const edition = await findEdition(ctx, book, report);
    if (edition) {
      options.addOpenLibraryCovers(edition.covers, 'This edition');
      options.addSynopsis(cleanDescription(edition.description), 'openlibrary', 'This edition');
      workId = WORK_KEY.exec(edition.works?.[0]?.key ?? '')?.[1] ?? null;
    }
  }
  workId ??= await searchWorkId(ctx, book, report);
  if (!workId) return;

  const id = workId;
  const work = await attempt(ctx, 'openlibrary', async () =>
    parseUpstream(
      olWorkRecordSchema,
      await fetchJson(ctx, `${OPEN_LIBRARY_BASE}/works/${id}.json`),
      'Open Library',
    ),
  );
  if (!work.ok) {
    report.failed = true;
    return;
  }
  options.addSynopsis(cleanDescription(work.value.description), 'openlibrary', 'Open Library work');
  options.addOpenLibraryCovers(work.value.covers, 'Open Library');
}

// --- Google Books ---------------------------------------------------------------

function googleLabel(candidate: BookCandidate): string {
  const details = [candidate.publisher, candidate.publishedDate?.slice(0, 4)].filter(Boolean);
  return details.length > 0 ? `Google Books · ${details.join(', ')}` : 'Google Books';
}

function quoted(value: string): string {
  return `"${value.replace(/"/g, ' ').trim()}"`;
}

async function collectGoogle(
  ctx: AppContext,
  book: CatalogueBook,
  options: Options,
  report: SourceReport,
): Promise<void> {
  report.attempted = true;
  const main = book.title.split(':')[0]?.trim() || book.title;
  const author = book.authors[0];
  const query = [
    `intitle:${quoted(main.slice(0, 150))}`,
    ...(author ? [`inauthor:${quoted(author.slice(0, 100))}`] : []),
  ].join(' ');
  const outcome = await attempt(ctx, 'googlebooks', () =>
    googleVolumes(ctx, googleUrl(ctx, query, 0, GOOGLE_ALTERNATIVES_PAGE)),
  );
  if (!outcome.ok) {
    report.failed = true;
    return;
  }
  const want = titleKeys(book.title).main;
  for (const candidate of outcome.value) {
    if (titleKeys(candidate.title).main !== want) continue;
    const label = googleLabel(candidate);
    if (candidate.coverUrl) {
      options.addCover({
        url: candidate.coverUrl,
        previewUrl: candidate.coverUrl,
        source: 'googlebooks',
        label,
      });
    }
    options.addSynopsis(candidate.synopsis, 'googlebooks', label);
  }
}

// --- Entry point ----------------------------------------------------------------

/**
 * `GET /api/books/:id/alternatives`: 404 unless the book is on the member's
 * shelf, 403 for a child, 502 when nothing was found because every source
 * that was asked failed. Otherwise the options found (possibly none), with
 * the sources that failed in `unavailable`.
 */
export async function findAlternatives(
  ctx: AppContext,
  scope: MemberScope,
  id: string,
): Promise<BookAlternatives> {
  requireBook(ctx, scope, id);
  requireCatalogueEditor(scope, 'change the details of a book');
  const book = findCatalogueBook(ctx.db, id) as CatalogueBook;

  const options = new Options();
  const openLibrary: SourceReport = { attempted: false, failed: false };
  const google: SourceReport = { attempted: false, failed: false };
  await collectOpenLibrary(ctx, book, options, openLibrary);
  if (ctx.config.googleBooksApiKey) await collectGoogle(ctx, book, options, google);

  const reports: [LookupSource, SourceReport][] = [
    ['openlibrary', openLibrary],
    ['googlebooks', google],
  ];
  const attempted = reports.filter(([, report]) => report.attempted);
  const unavailable = attempted.filter(([, report]) => report.failed).map(([source]) => source);
  const found = options.covers.length + options.synopses.length;
  if (found === 0 && unavailable.length === attempted.length) {
    throw upstreamError('Book lookup services are unavailable; try again later');
  }
  return { covers: options.covers, synopses: options.synopses, unavailable };
}
