/**
 * Notion one-way mirror (SPEC §7, ADR 0006).
 *
 * On first run three databases (Bookshelf Books / Sessions / Notes) are
 * created under NOTION_PARENT_PAGE_ID and their IDs stored in `settings`.
 * Each run upserts one page per row keyed by the `Bookshelf ID` property:
 * the stored page ID is used when known, otherwise the database is queried
 * by Bookshelf ID before creating, so pages are never duplicated. Rows whose
 * mirrored content has not changed (by hash) are skipped; soft-deleted rows
 * have their pages archived. Requests are throttled to ~3/s and retried on
 * 429 (honouring Retry-After) and 5xx.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  notionStatusSchema,
  currentProgress,
  formatDate,
  localDateKey,
  type Book,
  type BookStatus,
  type FormatType,
  type NotionEntityCounts,
  type NotionRunResult,
  type NotionStatus,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { AppError, upstreamError } from '../http/errors.ts';
import { listAllBooks } from '../repositories/books.ts';
import { bookFormats, bookReads, latestRead, readSessions } from '../repositories/records.ts';
import {
  clearNotionPages,
  deleteNotionPage,
  findNotionPage,
  getSetting,
  saveNotionPage,
  setSetting,
  type NotionEntity,
} from '../repositories/state.ts';
import {
  findMany,
  formatsTable,
  notesTable,
  sessionsTable,
  tagsTable,
} from '../repositories/tables.ts';

export const NOTION_API = 'https://api.notion.com/v1';
/** Pinned Notion API version (ADR 0006). */
export const NOTION_VERSION = '2022-06-28';
export const MIN_REQUEST_INTERVAL_MS = 334;
export const MAX_ATTEMPTS = 5;

const DATABASES_KEY = 'notion.databases';
const STATUS_KEY = 'notion.status';

// --- HTTP client ---------------------------------------------------------------

export class NotionApiError extends Error {
  override readonly name = 'NotionApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface NotionClientOptions {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic milliseconds, used for throttling. */
  clock: () => number;
  minIntervalMs?: number;
  maxAttempts?: number;
}

export interface NotionClient {
  request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown>;
}

/** Retry-After in milliseconds (seconds header; default 1 s, capped at 60 s). */
export function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds, 60) * 1000;
}

async function errorFromResponse(response: Response): Promise<NotionApiError> {
  let code = 'http_error';
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Non-JSON error body: keep the generic message.
  }
  return new NotionApiError(response.status, code, message);
}

export function createNotionClient(options: NotionClientOptions): NotionClient {
  const minInterval = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  let nextSlot = 0;

  const throttle = async () => {
    const wait = nextSlot - options.clock();
    if (wait > 0) await options.sleep(wait);
    nextSlot = options.clock() + minInterval;
  };

  return {
    async request(method, path, body) {
      for (let attempt = 1; ; attempt += 1) {
        await throttle();
        let response: Response;
        try {
          response = await options.fetch(`${NOTION_API}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${options.token}`,
              'Notion-Version': NOTION_VERSION,
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          if (attempt >= maxAttempts) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new NotionApiError(0, 'network_error', `Could not reach Notion: ${reason}`);
          }
          await options.sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        if (response.ok) return response.json();
        if (response.status === 429 && attempt < maxAttempts) {
          await options.sleep(retryAfterMs(response.headers.get('retry-after')));
          continue;
        }
        if (response.status >= 500 && attempt < maxAttempts) {
          await options.sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw await errorFromResponse(response);
      }
    },
  };
}

// --- Property builders ------------------------------------------------------------

type Properties = Record<string, unknown>;

function textChunks(value: string | null): { type: 'text'; text: { content: string } }[] {
  if (!value) return [];
  const chunks: { type: 'text'; text: { content: string } }[] = [];
  for (let i = 0; i < value.length && chunks.length < 100; i += 2000) {
    chunks.push({ type: 'text', text: { content: value.slice(i, i + 2000) } });
  }
  return chunks;
}

const title = (value: string) => ({ title: textChunks(value.slice(0, 2000)) });
const richText = (value: string | null) => ({ rich_text: textChunks(value) });
const numberProp = (value: number | null) => ({ number: value });
const optionName = (value: string) =>
  value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const select = (value: string | null) => ({ select: value ? { name: optionName(value) } : null });
const multiSelect = (values: readonly string[]) => ({
  multi_select: [...new Set(values.map(optionName).filter(Boolean))].map((name) => ({ name })),
});
const date = (start: string | null, end: string | null = null) => ({
  date: start ? { start, end } : null,
});
const relation = (pageId: string | null) => ({ relation: pageId ? [{ id: pageId }] : [] });

const STATUS_LABELS: Record<BookStatus, string> = {
  to_read: 'To read',
  reading: 'Reading',
  paused: 'Paused',
  finished: 'Finished',
  dnf: 'Did not finish',
};
const FORMAT_LABELS: Record<FormatType, string> = {
  physical: 'Physical',
  kindle: 'Kindle',
  audiobook: 'Audiobook',
};
const options = (labels: readonly string[]) => ({ options: labels.map((name) => ({ name })) });

function databaseSchemas(booksDatabaseId: string | null) {
  const bookRelation = booksDatabaseId
    ? { relation: { database_id: booksDatabaseId, type: 'single_property', single_property: {} } }
    : null;
  return {
    book: {
      Name: { title: {} },
      'Bookshelf ID': { rich_text: {} },
      Authors: { rich_text: {} },
      Status: { select: options(Object.values(STATUS_LABELS)) },
      Rating: { number: { format: 'number' } },
      Progress: { number: { format: 'percent' } },
      Formats: { multi_select: options(Object.values(FORMAT_LABELS)) },
      Genres: { multi_select: {} },
      Tags: { multi_select: {} },
      'ISBN-13': { rich_text: {} },
      Publisher: { rich_text: {} },
      Started: { date: {} },
      Finished: { date: {} },
    },
    session: {
      Name: { title: {} },
      'Bookshelf ID': { rich_text: {} },
      Book: bookRelation,
      Date: { date: {} },
      Minutes: { number: { format: 'number' } },
      Format: { select: options(Object.values(FORMAT_LABELS)) },
      Unit: { select: options(['pages', 'percent', 'audio_seconds']) },
      Start: { number: { format: 'number' } },
      End: { number: { format: 'number' } },
      'Start %': { number: { format: 'percent' } },
      'End %': { number: { format: 'percent' } },
      Note: { rich_text: {} },
    },
    note: {
      Name: { title: {} },
      'Bookshelf ID': { rich_text: {} },
      Book: bookRelation,
      Kind: { select: options(['Note', 'Quote']) },
      Text: { rich_text: {} },
      Location: { rich_text: {} },
    },
  };
}

const DATABASE_TITLES: Record<NotionEntity, string> = {
  book: 'Bookshelf Books',
  session: 'Bookshelf Sessions',
  note: 'Bookshelf Notes',
};

interface MirrorRow {
  id: string;
  deleted: boolean;
  properties: Properties;
}

function percentFraction(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 10_000;
}

function bookRows(ctx: AppContext, books: readonly Book[]): MirrorRow[] {
  const tagNames = new Map(findMany(ctx.db, tagsTable).map((tag) => [tag.id, tag.name]));
  const tz = ctx.config.timeZone;
  return books.map((book) => {
    const reads = bookReads(ctx.db, book.id);
    const last = latestRead(ctx.db, book.id);
    const first = reads[0];
    return {
      id: book.id,
      deleted: book.deletedAt !== null,
      properties: {
        Name: title(book.title),
        'Bookshelf ID': richText(book.id),
        Authors: richText(book.authors.join(', ')),
        Status: select(STATUS_LABELS[book.status]),
        Rating: numberProp(book.rating),
        Progress: numberProp(
          percentFraction(last ? currentProgress(readSessions(ctx.db, last.id)) : null),
        ),
        Formats: multiSelect(bookFormats(ctx.db, book.id).map((f) => FORMAT_LABELS[f.format])),
        Genres: multiSelect(book.genres),
        Tags: multiSelect(book.tagIds.map((id) => tagNames.get(id) ?? '')),
        'ISBN-13': richText(book.isbn13),
        Publisher: richText(book.publisher),
        Started: date(first ? localDateKey(first.startedAt, tz) : null),
        Finished: date(last?.finishedAt ? localDateKey(last.finishedAt, tz) : null),
      },
    };
  });
}

// --- Mirror -------------------------------------------------------------------------

const storedDatabasesSchema = z.object({
  parentPageId: z.string(),
  book: z.string(),
  session: z.string(),
  note: z.string(),
});
type StoredDatabases = z.infer<typeof storedDatabasesSchema>;

const storedStatusSchema = notionStatusSchema.omit({ configured: true, running: true });
type StoredStatus = z.infer<typeof storedStatusSchema>;

export interface NotionMirror {
  run(): Promise<NotionRunResult>;
  status(): NotionStatus;
}

export function createNotionMirror(
  ctx: AppContext,
  options: { clock?: () => number; minIntervalMs?: number } = {},
): NotionMirror {
  let running = false;

  const storedStatus = (): StoredStatus =>
    getSetting(ctx.db, STATUS_KEY, storedStatusSchema) ?? {
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastResult: null,
    };

  const saveStatus = (patch: Partial<StoredStatus>) => {
    setSetting(ctx.db, STATUS_KEY, { ...storedStatus(), ...patch }, nowIso(ctx));
  };

  async function execute(client: NotionClient, parentPageId: string): Promise<NotionRunResult> {
    const startedAt = nowIso(ctx);
    const pageIdOf = (value: unknown): string => {
      const id = (value as { id?: unknown }).id;
      if (typeof id !== 'string')
        throw new NotionApiError(0, 'invalid_response', 'Notion response had no id');
      return id;
    };

    const databaseUsable = async (id: string): Promise<boolean> => {
      try {
        const db = (await client.request('GET', `/databases/${id}`)) as {
          archived?: boolean;
          in_trash?: boolean;
        };
        return db.archived !== true && db.in_trash !== true;
      } catch (error) {
        if (error instanceof NotionApiError && error.status === 404) return false;
        throw error;
      }
    };

    const createDatabase = async (entity: NotionEntity, booksDatabaseId: string | null) => {
      const schema = databaseSchemas(booksDatabaseId)[entity];
      const created = await client.request('POST', '/databases', {
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ type: 'text', text: { content: DATABASE_TITLES[entity] } }],
        properties: schema,
      });
      clearNotionPages(ctx.db, entity);
      ctx.logger.info('Created Notion database', { entity });
      return pageIdOf(created);
    };

    // 1. Ensure the three databases exist (books first: the others relate to it).
    let stored = getSetting(ctx.db, DATABASES_KEY, storedDatabasesSchema);
    if (stored && stored.parentPageId !== parentPageId) stored = null;
    let booksDb = stored && (await databaseUsable(stored.book)) ? stored.book : null;
    const booksRecreated = booksDb === null;
    booksDb ??= await createDatabase('book', null);
    const ensureChild = async (entity: 'session' | 'note') => {
      const existing = stored?.[entity];
      if (!booksRecreated && existing && (await databaseUsable(existing))) return existing;
      return createDatabase(entity, booksDb);
    };
    const sessionsDb = await ensureChild('session');
    const notesDb = await ensureChild('note');
    setSetting(
      ctx.db,
      DATABASES_KEY,
      { parentPageId, book: booksDb, session: sessionsDb, note: notesDb } satisfies StoredDatabases,
      nowIso(ctx),
    );

    // 2. Upsert rows.
    const findByBookshelfId = async (databaseId: string, id: string): Promise<string | null> => {
      const result = (await client.request('POST', `/databases/${databaseId}/query`, {
        filter: { property: 'Bookshelf ID', rich_text: { equals: id } },
        page_size: 1,
      })) as { results?: { id?: unknown }[] };
      const first = result.results?.[0];
      return typeof first?.id === 'string' ? first.id : null;
    };

    const push = async (
      entity: NotionEntity,
      databaseId: string,
      rows: readonly MirrorRow[],
    ): Promise<NotionEntityCounts> => {
      const counts: NotionEntityCounts = { created: 0, updated: 0, archived: 0, unchanged: 0 };
      for (const row of rows) {
        const mapping = findNotionPage(ctx.db, entity, row.id);
        if (row.deleted) {
          if (mapping) {
            try {
              await client.request('PATCH', `/pages/${mapping.pageId}`, { archived: true });
            } catch (error) {
              if (!(error instanceof NotionApiError && error.status === 404)) throw error;
            }
            deleteNotionPage(ctx.db, entity, row.id);
            counts.archived += 1;
          }
          continue;
        }
        const contentHash = createHash('sha256')
          .update(JSON.stringify(row.properties))
          .digest('hex');
        if (mapping?.contentHash === contentHash) {
          counts.unchanged += 1;
          continue;
        }
        let pageId: string | null = null;
        if (mapping) {
          try {
            await client.request('PATCH', `/pages/${mapping.pageId}`, {
              properties: row.properties,
            });
            pageId = mapping.pageId;
          } catch (error) {
            if (!(error instanceof NotionApiError && error.status === 404)) throw error;
          }
        }
        let created = false;
        if (!pageId) {
          pageId = await findByBookshelfId(databaseId, row.id);
          if (pageId) {
            await client.request('PATCH', `/pages/${pageId}`, { properties: row.properties });
          } else {
            pageId = pageIdOf(
              await client.request('POST', '/pages', {
                parent: { database_id: databaseId },
                properties: row.properties,
              }),
            );
            created = true;
          }
        }
        saveNotionPage(ctx.db, entity, row.id, { pageId, contentHash }, nowIso(ctx));
        if (created) counts.created += 1;
        else counts.updated += 1;
      }
      return counts;
    };

    const books = listAllBooks(ctx.db);
    const bookCounts = await push('book', booksDb, bookRows(ctx, books));
    const titles = new Map(books.map((book) => [book.id, book.title]));
    const bookPage = (bookId: string) => findNotionPage(ctx.db, 'book', bookId)?.pageId ?? null;
    const tz = ctx.config.timeZone;
    const formatLabels = new Map(
      findMany(ctx.db, formatsTable).map((format) => [format.id, FORMAT_LABELS[format.format]]),
    );

    const sessionRows: MirrorRow[] = findMany(ctx.db, sessionsTable).map((s) => ({
      id: s.id,
      deleted: s.deletedAt !== null,
      properties: {
        Name: title(`${titles.get(s.bookId) ?? 'Unknown book'} — ${formatDate(s.startedAt, tz)}`),
        'Bookshelf ID': richText(s.id),
        Book: relation(bookPage(s.bookId)),
        Date: date(s.startedAt, s.endedAt),
        Minutes: numberProp(s.durationSeconds === null ? null : Math.round(s.durationSeconds / 60)),
        Format: select(formatLabels.get(s.formatId) ?? null),
        Unit: select(s.progressUnit),
        Start: numberProp(s.startValue),
        End: numberProp(s.endValue),
        'Start %': numberProp(percentFraction(s.startPercent)),
        'End %': numberProp(percentFraction(s.endPercent)),
        Note: richText(s.note),
      },
    }));
    const sessionCounts = await push('session', sessionsDb, sessionRows);

    const noteRows: MirrorRow[] = findMany(ctx.db, notesTable).map((n) => ({
      id: n.id,
      deleted: n.deletedAt !== null,
      properties: {
        Name: title(n.text.length > 80 ? `${n.text.slice(0, 79)}…` : n.text),
        'Bookshelf ID': richText(n.id),
        Book: relation(bookPage(n.bookId)),
        Kind: select(n.kind === 'quote' ? 'Quote' : 'Note'),
        Text: richText(n.text),
        Location: richText(n.location),
      },
    }));
    const noteCounts = await push('note', notesDb, noteRows);

    return {
      books: bookCounts,
      sessions: sessionCounts,
      notes: noteCounts,
      startedAt,
      finishedAt: nowIso(ctx),
    };
  }

  return {
    status() {
      return { configured: ctx.config.notion !== null, running, ...storedStatus() };
    },

    async run() {
      const notion = ctx.config.notion;
      if (!notion) {
        throw new AppError(
          400,
          'notion_not_configured',
          'Notion is not configured: set NOTION_TOKEN and NOTION_PARENT_PAGE_ID',
        );
      }
      if (running) throw new AppError(409, 'notion_busy', 'A Notion sync is already running');
      running = true;
      saveStatus({ lastRunAt: nowIso(ctx) });
      const client = createNotionClient({
        token: notion.token,
        fetch: ctx.fetch,
        sleep: ctx.sleep,
        clock: options.clock ?? (() => performance.now()),
        ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
      });
      try {
        const result = await execute(client, notion.parentPageId);
        saveStatus({ lastSuccessAt: result.finishedAt, lastError: null, lastResult: result });
        ctx.logger.info('Notion sync finished', { result });
        return result;
      } catch (error) {
        const message =
          error instanceof NotionApiError
            ? `Notion API error (${error.status} ${error.code}): ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
        saveStatus({ lastError: message });
        ctx.logger.error('Notion sync failed', { error: message });
        if (error instanceof NotionApiError) throw upstreamError(message);
        throw error;
      } finally {
        running = false;
      }
    },
  };
}
