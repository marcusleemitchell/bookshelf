/**
 * The single typed client for the Bookshelf API (SPEC §5). Every response is
 * parsed with its shared Zod schema, so screens only ever see contract-valid
 * data. Two error types matter to callers:
 *
 * - {@link OfflineError}: the server could not be reached (network failure,
 *   or a proxy such as `tailscale serve` answering 502–504 because the Mac
 *   server is down). Offline-capable actions fall back to the outbox.
 * - {@link ApiError}: the server answered with the `{ error }` envelope (or
 *   an unexpected payload). A 401 `unauthorised` outside the sign-in routes
 *   means the session ended; the client reports it through `onUnauthorised`.
 */
import type { z } from 'zod';
import {
  authStateSchema,
  backupEnvelopeSchema,
  backupImportResponseSchema,
  bookCandidateListSchema,
  bookCandidateSchema,
  bookDetailSchema,
  bookFormatSchema,
  bookListSchema,
  bookNoteSchema,
  bookpineReportSchema,
  calendarSchema,
  errorResponseSchema,
  goalListSchema,
  goalWithProgressSchema,
  healthResponseSchema,
  noteListSchema,
  notionRunResultSchema,
  notionStatusSchema,
  readSchema,
  sessionListSchema,
  signInResponseSchema,
  sessionSchema,
  statsDailySchema,
  statsSummarySchema,
  streaksSchema,
  syncResponseSchema,
  tagListSchema,
  tagSchema,
  timerResponseSchema,
  yearInReviewSchema,
  type AuthSetup,
  type BackupEnvelope,
  type BookCreate,
  type BookListQuery,
  type BookUpdate,
  type ErrorCode,
  type FormatCreate,
  type FormatUpdate,
  type GoalPut,
  type NoteCreate,
  type NoteUpdate,
  type PinChange,
  type ReadCreate,
  type SessionCreate,
  type SessionListQuery,
  type SessionUpdate,
  type SignIn,
  type StatsRangeQuery,
  type SyncOp,
  type TagCreate,
  type TagUpdate,
  type TimerPut,
} from '../../../shared/index.ts';

/** The server answered with an error (or with a payload that broke the contract). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The server could not be reached. */
export class OfflineError extends Error {
  constructor(message = 'The Bookshelf server cannot be reached') {
    super(message);
    this.name = 'OfflineError';
  }
}

export function isOfflineError(error: unknown): error is OfflineError {
  return error instanceof OfflineError;
}

/** A user-facing message for any error thrown by the client. */
export function errorMessage(error: unknown): string {
  if (error instanceof OfflineError) return 'You’re offline: the server can’t be reached.';
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** Called with `true` after any answer from the server and `false` when it is unreachable. */
  onReachability?: (reachable: boolean) => void;
  /** Called when a request outside `/auth/` is refused because no one is signed in. */
  onUnauthorised?: () => void;
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions<S extends z.ZodType> {
  query?: Query;
  body?: unknown;
  schema: S;
  signal?: AbortSignal | undefined;
}

function buildPath(path: string, query: Query | undefined): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const PROXY_DOWN_STATUSES = new Set([502, 503, 504]);

export function createApiClient(options: ApiClientOptions = {}) {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const report = options.onReachability ?? (() => undefined);
  const signedOut = options.onUnauthorised ?? (() => undefined);

  async function send(
    method: string,
    path: string,
    query: Query | undefined,
    body: unknown,
    signal: AbortSignal | undefined,
    /** Sends `text` with this content type instead of a JSON body. */
    raw?: { text: string; type: string },
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    let headers: Record<string, string> = {};
    let payload: string | null = null;
    if (raw) {
      headers = { 'Content-Type': raw.type };
      payload = raw.text;
    } else if (body !== undefined) {
      headers = { 'Content-Type': 'application/json' };
      payload = JSON.stringify(body);
    }
    try {
      response = await doFetch(buildPath(`/api${path}`, query), {
        method,
        headers,
        body: payload,
        signal: signal ?? null,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      report(false);
      throw new OfflineError();
    }
    if (response.status === 204) {
      report(true);
      return { status: 204, json: undefined };
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const envelope = errorResponseSchema.safeParse(json);
      if (envelope.success) {
        report(true);
        const { code, message, details } = envelope.data.error;
        // A wrong PIN is also a 401, but it does not end a session.
        if (code === 'unauthorised' && !path.startsWith('/auth/')) signedOut();
        throw new ApiError(response.status, code, message, details);
      }
      if (PROXY_DOWN_STATUSES.has(response.status)) {
        report(false);
        throw new OfflineError();
      }
      report(true);
      throw new ApiError(
        response.status,
        'internal_error',
        `The server responded with HTTP ${response.status}`,
      );
    }
    report(true);
    return { status: response.status, json };
  }

  async function request<S extends z.ZodType>(
    method: string,
    path: string,
    options: RequestOptions<S>,
  ): Promise<z.output<S>> {
    const { json } = await send(method, path, options.query, options.body, options.signal);
    return parse(options.schema, json);
  }

  /** POSTs a CSV file's text (Bookpine imports) and parses the response with `schema`. */
  async function postCsv<S extends z.ZodType>(path: string, csv: string, schema: S) {
    const { json } = await send('POST', path, undefined, undefined, undefined, {
      text: csv,
      type: 'text/csv',
    });
    return parse(schema, json);
  }

  async function requestNoContent(method: string, path: string): Promise<void> {
    await send(method, path, undefined, undefined, undefined);
  }

  function parse<S extends z.ZodType>(schema: S, json: unknown): z.output<S> {
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new ApiError(
        500,
        'internal_error',
        'The server sent a response this app does not understand',
        result.error.issues,
      );
    }
    return result.data;
  }

  const id = encodeURIComponent;

  return {
    health: (signal?: AbortSignal) =>
      request('GET', '/health', { schema: healthResponseSchema, signal }),

    authState: () => request('GET', '/auth/state', { schema: authStateSchema }),
    /** First run: names the owner, sets their PIN and signs in. */
    setUp: (body: AuthSetup) =>
      request('POST', '/auth/setup', { body, schema: signInResponseSchema }),
    signIn: (body: SignIn) =>
      request('POST', '/auth/sign-in', { body, schema: signInResponseSchema }),
    signOut: () => requestNoContent('POST', '/auth/sign-out'),
    changePin: async (body: PinChange) => {
      await send('PUT', '/auth/pin', undefined, body, undefined);
    },

    lookupIsbn: (isbn: string) =>
      request('GET', `/lookup/isbn/${id(isbn)}`, { schema: bookCandidateSchema }),
    searchBooks: (q: string, page = 1) =>
      request('GET', '/lookup/search', { query: { q, page }, schema: bookCandidateListSchema }),

    listBooks: (query: BookListQuery = {}) =>
      request('GET', '/books', { query: { ...query }, schema: bookListSchema }),
    getBook: (bookId: string) =>
      request('GET', `/books/${id(bookId)}`, { schema: bookDetailSchema }),
    createBook: (body: BookCreate) => request('POST', '/books', { body, schema: bookDetailSchema }),
    updateBook: (bookId: string, patch: BookUpdate) =>
      request('PATCH', `/books/${id(bookId)}`, { body: patch, schema: bookDetailSchema }),
    deleteBook: (bookId: string) => requestNoContent('DELETE', `/books/${id(bookId)}`),

    createFormat: (bookId: string, body: FormatCreate) =>
      request('POST', `/books/${id(bookId)}/formats`, { body, schema: bookFormatSchema }),
    updateFormat: (bookId: string, formatId: string, patch: FormatUpdate) =>
      request('PATCH', `/books/${id(bookId)}/formats/${id(formatId)}`, {
        body: patch,
        schema: bookFormatSchema,
      }),
    deleteFormat: (bookId: string, formatId: string) =>
      requestNoContent('DELETE', `/books/${id(bookId)}/formats/${id(formatId)}`),

    startReread: (bookId: string, body: ReadCreate = {}) =>
      request('POST', `/books/${id(bookId)}/reads`, { body, schema: readSchema }),
    setBookTags: (bookId: string, tagIds: string[]) =>
      request('PUT', `/books/${id(bookId)}/tags`, { body: { tagIds }, schema: bookDetailSchema }),

    listNotes: (bookId: string) =>
      request('GET', `/books/${id(bookId)}/notes`, { schema: noteListSchema }),
    createNote: (bookId: string, body: NoteCreate) =>
      request('POST', `/books/${id(bookId)}/notes`, { body, schema: bookNoteSchema }),
    updateNote: (bookId: string, noteId: string, patch: NoteUpdate) =>
      request('PATCH', `/books/${id(bookId)}/notes/${id(noteId)}`, {
        body: patch,
        schema: bookNoteSchema,
      }),
    deleteNote: (bookId: string, noteId: string) =>
      requestNoContent('DELETE', `/books/${id(bookId)}/notes/${id(noteId)}`),

    listSessions: (query: SessionListQuery = {}) =>
      request('GET', '/sessions', { query: { ...query }, schema: sessionListSchema }),
    createSession: (body: SessionCreate) =>
      request('POST', '/sessions', { body, schema: sessionSchema }),
    updateSession: (sessionId: string, patch: SessionUpdate) =>
      request('PATCH', `/sessions/${id(sessionId)}`, { body: patch, schema: sessionSchema }),
    deleteSession: (sessionId: string) => requestNoContent('DELETE', `/sessions/${id(sessionId)}`),

    getTimer: () => request('GET', '/timer', { schema: timerResponseSchema }),
    putTimer: (body: TimerPut) => request('PUT', '/timer', { body, schema: timerResponseSchema }),
    deleteTimer: () => requestNoContent('DELETE', '/timer'),

    listTags: () => request('GET', '/tags', { schema: tagListSchema }),
    createTag: (body: TagCreate) => request('POST', '/tags', { body, schema: tagSchema }),
    updateTag: (tagId: string, patch: TagUpdate) =>
      request('PATCH', `/tags/${id(tagId)}`, { body: patch, schema: tagSchema }),
    deleteTag: (tagId: string) => requestNoContent('DELETE', `/tags/${id(tagId)}`),

    listGoals: () => request('GET', '/goals', { schema: goalListSchema }),
    /** `PUT /api/goals/:id`: `created` is true for a 201 (new goal), false for a 200 (replaced). */
    putGoal: async (goalId: string, body: GoalPut) => {
      const { status, json } = await send(
        'PUT',
        `/goals/${id(goalId)}`,
        undefined,
        body,
        undefined,
      );
      return { goal: parse(goalWithProgressSchema, json), created: status === 201 };
    },
    deleteGoal: (goalId: string) => requestNoContent('DELETE', `/goals/${id(goalId)}`),

    statsSummary: (range: StatsRangeQuery = {}) =>
      request('GET', '/stats/summary', { query: { ...range }, schema: statsSummarySchema }),
    statsDaily: (range: StatsRangeQuery = {}) =>
      request('GET', '/stats/daily', { query: { ...range }, schema: statsDailySchema }),
    streaks: () => request('GET', '/stats/streaks', { schema: streaksSchema }),
    yearInReview: (year: number) =>
      request('GET', `/stats/year/${year}`, { schema: yearInReviewSchema }),
    calendar: (month: string) =>
      request('GET', '/calendar', { query: { month }, schema: calendarSchema }),

    sync: (ops: SyncOp[]) =>
      request('POST', '/sync', { body: { ops }, schema: syncResponseSchema }),

    exportBackup: () => request('GET', '/backup/export', { schema: backupEnvelopeSchema }),
    importBackup: (envelope: BackupEnvelope) =>
      request('POST', '/backup/import', { body: envelope, schema: backupImportResponseSchema }),
    notionRun: () => request('POST', '/backup/notion', { schema: notionRunResultSchema }),
    notionStatus: () => request('GET', '/backup/notion/status', { schema: notionStatusSchema }),

    /** Dry run of a Bookpine CSV import: what would change (writes nothing). */
    previewBookpine: (csv: string) =>
      postCsv('/import/bookpine/preview', csv, bookpineReportSchema),
    /** Imports a Bookpine CSV export (lookups can take a few minutes). */
    importBookpine: (csv: string) => postCsv('/import/bookpine', csv, bookpineReportSchema),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
