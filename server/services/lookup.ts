/**
 * Book lookup (SPEC §5): Open Library first (its edition and work records
 * supply synopsis and language), Google Books as fallback and gap-filler
 * (ADR 0005, ADR 0008), all normalised into `BookCandidate`s. Upstream payloads are
 * parsed defensively; anything malformed is dropped rather than trusted.
 */
import { z } from 'zod';
import {
  bookCandidateSchema,
  isValidIsbn10,
  mergeCandidates,
  isValidIsbn13,
  normaliseIsbn,
  type BookCandidate,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { AppError, upstreamError, validationError } from '../http/errors.ts';
import { fetchJson, OutboundError } from './outbound.ts';

export const OPEN_LIBRARY_BASE = 'https://openlibrary.org';
export const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1';
export const SEARCH_PAGE_SIZE = 20;
/** Edition language Open Library search prefers (ISO 639-1). */
export const SEARCH_LANGUAGE = 'en';
const MAX_GENRES = 8;

// --- Upstream payload shapes (only the fields we use) ----------------------

const named = z.object({ name: z.string() });

const olBookSchema = z.object({
  key: z.string().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  authors: z.array(named).optional(),
  publishers: z.array(named).optional(),
  publish_date: z.string().optional(),
  number_of_pages: z.number().optional(),
  subjects: z.array(named).optional(),
  identifiers: z
    .object({
      isbn_10: z.array(z.string()).optional(),
      isbn_13: z.array(z.string()).optional(),
      openlibrary: z.array(z.string()).optional(),
    })
    .optional(),
  cover: z
    .object({
      small: z.string().optional(),
      medium: z.string().optional(),
      large: z.string().optional(),
    })
    .optional(),
});
const olBooksResponseSchema = z.record(z.string(), z.unknown());

/** Open Library text fields are either strings or `{ type: '/type/text', value }`. */
const olTextSchema = z.union([
  z.string(),
  z.object({ value: z.string() }).transform((text) => text.value),
]);
const olKeySchema = z.object({ key: z.string() });

const olEditionSchema = z.object({
  description: olTextSchema.optional(),
  languages: z.array(olKeySchema).optional(),
  works: z.array(olKeySchema).optional(),
});
const olWorkSchema = z.object({ description: olTextSchema.optional() });

/** The best-matching edition Open Library search returns for a work (`editions.*` fields). */
const olSearchEditionSchema = z.object({
  isbn: z.array(z.string()).optional(),
  language: z.array(z.string()).optional(),
  publisher: z.array(z.string()).optional(),
  publish_date: z.array(z.string()).optional(),
  cover_i: z.number().optional(),
});

const olSearchDocSchema = z.object({
  key: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  author_name: z.array(z.string()).optional(),
  first_publish_year: z.number().optional(),
  isbn: z.array(z.string()).optional(),
  cover_i: z.number().optional(),
  number_of_pages_median: z.number().optional(),
  publisher: z.array(z.string()).optional(),
  language: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
  editions: z.object({ docs: z.array(z.unknown()).default([]) }).optional(),
});
const olSearchResponseSchema = z.object({ docs: z.array(z.unknown()).default([]) });

const googleVolumeSchema = z.object({
  id: z.string(),
  volumeInfo: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    authors: z.array(z.string()).optional(),
    publisher: z.string().optional(),
    publishedDate: z.string().optional(),
    description: z.string().optional(),
    industryIdentifiers: z.array(z.object({ type: z.string(), identifier: z.string() })).optional(),
    pageCount: z.number().optional(),
    categories: z.array(z.string()).optional(),
    imageLinks: z
      .object({
        smallThumbnail: z.string().optional(),
        thumbnail: z.string().optional(),
        small: z.string().optional(),
        medium: z.string().optional(),
        large: z.string().optional(),
      })
      .optional(),
    language: z.string().optional(),
  }),
});
const googleResponseSchema = z.object({ items: z.array(z.unknown()).optional() });

// --- Normalisation helpers --------------------------------------------------

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Keeps short, unique, human-readable subjects (drops `nyt:`-style machine tags). */
export function cleanGenres(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const genres: string[] = [];
  for (const part of raw.flatMap((value) => value.split(/\s+\/\s+/))) {
    const genre = part.trim();
    if (!genre || genre.includes(':') || genre.length > 60) continue;
    const key = genre.toLocaleLowerCase('en-GB');
    if (seen.has(key)) continue;
    seen.add(key);
    genres.push(genre);
    if (genres.length >= MAX_GENRES) break;
  }
  return genres;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function monthNumber(name: string): number | null {
  const key = name.toLowerCase().replace(/\.$/, '');
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)] ?? null;
}

function isoDate(year: string, month: number, day?: number): string | null {
  const mm = String(month).padStart(2, '0');
  if (day === undefined) return `${year}-${mm}`;
  const date = new Date(Date.UTC(Number(year), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${mm}-${String(day).padStart(2, '0')}`;
}

/**
 * Normalises an upstream publication date to `YYYY`, `YYYY-MM` or
 * `YYYY-MM-DD` when it is recognisable ("May 04, 2021", "4 May 2021",
 * "April 2015", "c1995", "[2003]"); anything else is kept as given.
 */
export function normalisePublishedDate(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(value)) return value;
  const year = /^[c[]?(\d{4})[\].]?$/.exec(value);
  if (year?.[1]) return year[1];
  const monthDayYear = /^([A-Za-z]+\.?) (\d{1,2}),? (\d{4})$/.exec(value);
  if (monthDayYear?.[1] && monthDayYear[2] && monthDayYear[3]) {
    const month = monthNumber(monthDayYear[1]);
    if (month) return isoDate(monthDayYear[3], month, Number(monthDayYear[2])) ?? value;
  }
  const dayMonthYear = /^(\d{1,2}) ([A-Za-z]+\.?),? (\d{4})$/.exec(value);
  if (dayMonthYear?.[1] && dayMonthYear[2] && dayMonthYear[3]) {
    const month = monthNumber(dayMonthYear[2]);
    if (month) return isoDate(dayMonthYear[3], month, Number(dayMonthYear[1])) ?? value;
  }
  const monthYear = /^([A-Za-z]+\.?),? (\d{4})$/.exec(value);
  if (monthYear?.[1] && monthYear[2]) {
    const month = monthNumber(monthYear[1]);
    if (month) return isoDate(monthYear[2], month);
  }
  return value;
}

/**
 * Tidies an Open Library description: CRLF line breaks, markdown source
 * links (`([source][1])` + `[1]: url`), "Contains" appendices after a rule,
 * and trailing attributions such as `--back cover` or a bare `--`.
 */
export function cleanDescription(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const [main = ''] = raw.replace(/\r\n?/g, '\n').split(/\n-{5,}\n/);
  const cleaned = main
    .replace(/\s*\(\[source\]\[\d+\]\)/gi, '')
    .replace(/^[ \t]*\[\d+\]:[ \t]*\S+.*$/gm, '')
    .replace(
      /\s*-{2,}\s*(back cover|front cover|front flap|inside flap|jacket|publisher)?\s*$/i,
      '',
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || null;
}

/** Converts simple HTML (as found in Google Books descriptions) to plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.replace(/^http:\/\//, 'https://'));
    url.searchParams.delete('edge');
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstValid(values: readonly string[] | undefined, valid: (isbn: string) => boolean) {
  return values?.map((value) => value.replace(/[\s-]/g, '').toUpperCase()).find(valid) ?? null;
}

function positiveInt(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function finalise(candidate: BookCandidate): BookCandidate | null {
  const result = bookCandidateSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

export function fromOpenLibraryBook(raw: unknown): BookCandidate | null {
  const parsed = olBookSchema.safeParse(raw);
  if (!parsed.success) return null;
  const book = parsed.data;
  const ids = book.identifiers;
  return finalise({
    source: 'openlibrary',
    sourceId: ids?.openlibrary?.[0] ?? book.key?.split('/').pop() ?? book.title,
    title: book.title.trim(),
    subtitle: text(book.subtitle),
    authors: (book.authors ?? []).map((author) => author.name.trim()).filter(Boolean),
    publisher: text(book.publishers?.[0]?.name),
    publishedDate: normalisePublishedDate(book.publish_date),
    language: null,
    synopsis: null,
    coverUrl: httpsUrl(book.cover?.large ?? book.cover?.medium ?? book.cover?.small),
    isbn10: firstValid(ids?.isbn_10, isValidIsbn10),
    isbn13: firstValid(ids?.isbn_13, isValidIsbn13),
    genres: cleanGenres((book.subjects ?? []).map((subject) => subject.name)),
    pageCount: positiveInt(book.number_of_pages),
  });
}

export function fromOpenLibrarySearchDoc(raw: unknown): BookCandidate | null {
  const parsed = olSearchDocSchema.safeParse(raw);
  if (!parsed.success) return null;
  const doc = parsed.data;
  // Edition-level fields come from Open Library's best-matching edition. The
  // work-level lists mix every edition (any ISBN, any language), so they are
  // only used when no edition came back, and a language only when unambiguous.
  const editionResult = olSearchEditionSchema.safeParse(doc.editions?.docs[0]);
  const edition = editionResult.success ? editionResult.data : null;
  const isbns = edition ? edition.isbn : doc.isbn;
  const language = edition
    ? edition.language?.[0]
    : doc.language?.length === 1
      ? doc.language[0]
      : undefined;
  const coverId = edition?.cover_i ?? doc.cover_i;
  return finalise({
    source: 'openlibrary',
    sourceId: doc.key.split('/').pop() ?? doc.key,
    title: doc.title.trim(),
    subtitle: text(doc.subtitle),
    authors: doc.author_name ?? [],
    publisher: text(edition ? edition.publisher?.[0] : doc.publisher?.[0]),
    publishedDate:
      normalisePublishedDate(edition?.publish_date?.[0]) ??
      (doc.first_publish_year ? String(doc.first_publish_year) : null),
    language: text(language),
    synopsis: null,
    coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
    isbn10: firstValid(isbns, isValidIsbn10),
    isbn13: firstValid(isbns, isValidIsbn13),
    genres: cleanGenres(doc.subject ?? []),
    pageCount: positiveInt(doc.number_of_pages_median),
  });
}

export function fromGoogleVolume(raw: unknown): BookCandidate | null {
  const parsed = googleVolumeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { id, volumeInfo: info } = parsed.data;
  const identifiers = info.industryIdentifiers ?? [];
  const byType = (type: string) =>
    identifiers.filter((i) => i.type === type).map((i) => i.identifier);
  const images = info.imageLinks;
  const description = info.description ? htmlToText(info.description) : undefined;
  return finalise({
    source: 'googlebooks',
    sourceId: id,
    title: info.title.trim(),
    subtitle: text(info.subtitle),
    authors: info.authors ?? [],
    publisher: text(info.publisher),
    publishedDate: normalisePublishedDate(info.publishedDate),
    language: text(info.language),
    synopsis: text(description),
    coverUrl: httpsUrl(
      images?.large ??
        images?.medium ??
        images?.small ??
        images?.thumbnail ??
        images?.smallThumbnail,
    ),
    isbn10: firstValid(byType('ISBN_10'), isValidIsbn10),
    isbn13: firstValid(byType('ISBN_13'), isValidIsbn13),
    genres: cleanGenres(info.categories ?? []),
    pageCount: positiveInt(info.pageCount),
  });
}

// --- Upstream calls ----------------------------------------------------------

function parseUpstream<S extends z.ZodType>(schema: S, data: unknown, source: string): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new OutboundError(`Unexpected response shape from ${source}`, null);
  return result.data;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: OutboundError };

async function attempt<T>(
  ctx: AppContext,
  source: string,
  fn: () => Promise<T>,
): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (!(error instanceof OutboundError)) throw error;
    ctx.logger.warn('Lookup source failed', { source, error: error.message });
    return { ok: false, error };
  }
}

function googleUrl(ctx: AppContext, query: string, startIndex = 0, maxResults = 1): string {
  const params = new URLSearchParams({
    q: query,
    startIndex: String(startIndex),
    maxResults: String(maxResults),
    printType: 'books',
  });
  if (ctx.config.googleBooksApiKey) params.set('key', ctx.config.googleBooksApiKey);
  return `${GOOGLE_BOOKS_BASE}/volumes?${params.toString()}`;
}

async function openLibraryByIsbn(ctx: AppContext, isbn10: string | null, isbn13: string) {
  const keys = [`ISBN:${isbn13}`, ...(isbn10 ? [`ISBN:${isbn10}`] : [])];
  const params = new URLSearchParams({ bibkeys: keys.join(','), format: 'json', jscmd: 'data' });
  const body = parseUpstream(
    olBooksResponseSchema,
    await fetchJson(ctx, `${OPEN_LIBRARY_BASE}/api/books?${params.toString()}`),
    'Open Library',
  );
  for (const key of keys) {
    if (key in body) return fromOpenLibraryBook(body[key]);
  }
  return null;
}

/**
 * Fills a missing synopsis and language from the Open Library edition record
 * and, failing that, the work's description. Without a Google Books key this
 * is the only synopsis source (ADR 0008). Failures keep the candidate as is.
 */
async function enrichFromOpenLibrary(
  ctx: AppContext,
  candidate: BookCandidate,
): Promise<BookCandidate> {
  if (!/^OL\d+M$/.test(candidate.sourceId)) return candidate;
  if (candidate.synopsis !== null && candidate.language !== null) return candidate;
  const edition = await attempt(ctx, 'openlibrary', async () =>
    parseUpstream(
      olEditionSchema,
      await fetchJson(ctx, `${OPEN_LIBRARY_BASE}/books/${candidate.sourceId}.json`),
      'Open Library',
    ),
  );
  if (!edition.ok) return candidate;
  const language = edition.value.languages?.[0]?.key.split('/').pop();
  let synopsis = cleanDescription(edition.value.description);
  const workKey = edition.value.works?.[0]?.key;
  if (!synopsis && candidate.synopsis === null && workKey && /^\/works\/OL\d+W$/.test(workKey)) {
    const work = await attempt(ctx, 'openlibrary', async () =>
      parseUpstream(
        olWorkSchema,
        await fetchJson(ctx, `${OPEN_LIBRARY_BASE}${workKey}.json`),
        'Open Library',
      ),
    );
    if (work.ok) synopsis = cleanDescription(work.value.description);
  }
  return {
    ...candidate,
    synopsis: candidate.synopsis ?? synopsis,
    language: candidate.language ?? text(language),
  };
}

async function googleVolumes(ctx: AppContext, url: string): Promise<BookCandidate[]> {
  const body = parseUpstream(googleResponseSchema, await fetchJson(ctx, url), 'Google Books');
  return (body.items ?? [])
    .map(fromGoogleVolume)
    .filter((candidate): candidate is BookCandidate => candidate !== null);
}

function needsFilling(candidate: BookCandidate): boolean {
  return candidate.synopsis === null || candidate.coverUrl === null || candidate.pageCount === null;
}

/** `GET /api/lookup/isbn/:isbn`. */
export async function lookupIsbn(ctx: AppContext, rawIsbn: string): Promise<BookCandidate> {
  const isbn = normaliseIsbn(rawIsbn);
  if (!isbn) throw validationError(`"${rawIsbn}" is not a valid ISBN-10 or ISBN-13`);

  const ol = await attempt(ctx, 'openlibrary', () =>
    openLibraryByIsbn(ctx, isbn.isbn10, isbn.isbn13),
  );
  const olCandidate = ol.ok && ol.value ? await enrichFromOpenLibrary(ctx, ol.value) : null;

  let google: Outcome<BookCandidate[]> | null = null;
  if (!olCandidate || needsFilling(olCandidate)) {
    google = await attempt(ctx, 'googlebooks', () =>
      googleVolumes(ctx, googleUrl(ctx, `isbn:${isbn.isbn13}`)),
    );
  }
  const googleCandidate = google?.ok ? (google.value[0] ?? null) : null;

  let result: BookCandidate | null = null;
  if (olCandidate) {
    result = googleCandidate ? mergeCandidates(olCandidate, googleCandidate) : olCandidate;
  } else if (googleCandidate) {
    result = googleCandidate;
  }
  if (!result) {
    if (!ol.ok || (google && !google.ok)) {
      throw upstreamError('Book lookup services are unavailable; try again later');
    }
    throw new AppError(404, 'not_found', `No book found for ISBN ${isbn.isbn13}`);
  }
  return {
    ...result,
    isbn13: result.isbn13 ?? isbn.isbn13,
    isbn10: result.isbn10 ?? isbn.isbn10,
  };
}

/** `GET /api/lookup/search`: Open Library search, Google Books when it finds nothing. */
export async function searchBooks(
  ctx: AppContext,
  q: string,
  page: number,
): Promise<BookCandidate[]> {
  const params = new URLSearchParams({
    q,
    page: String(page),
    limit: String(SEARCH_PAGE_SIZE),
    fields: [
      'key,title,subtitle,author_name,first_publish_year,isbn,cover_i,number_of_pages_median,publisher,language,subject',
      'editions,editions.key,editions.isbn,editions.language,editions.publisher,editions.publish_date,editions.cover_i',
    ].join(','),
    // Prefer an English edition as each work's best edition (ISBN, publisher, language).
    lang: SEARCH_LANGUAGE,
  });
  const ol = await attempt(ctx, 'openlibrary', async () => {
    const body = parseUpstream(
      olSearchResponseSchema,
      await fetchJson(ctx, `${OPEN_LIBRARY_BASE}/search.json?${params.toString()}`),
      'Open Library',
    );
    return body.docs
      .map(fromOpenLibrarySearchDoc)
      .filter((candidate): candidate is BookCandidate => candidate !== null);
  });
  if (ol.ok && ol.value.length > 0) return ol.value;

  const google = await attempt(ctx, 'googlebooks', () =>
    googleVolumes(ctx, googleUrl(ctx, q, (page - 1) * SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE)),
  );
  if (google.ok) return google.value;
  if (!ol.ok) throw upstreamError('Book search services are unavailable; try again later');
  return [];
}
