/**
 * The Bookshelf data and API contract (SPEC §4–§5).
 *
 * JSON on the wire uses camelCase field names; the database uses snake_case.
 * Every request body/query and every response body has a schema here, and
 * both the server and the web client validate against them.
 */
import { z } from 'zod';
import { isDateKey, isValidTimeZone } from './time.ts';
import { isValidIsbn10, isValidIsbn13 } from './isbn.ts';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const idSchema = z.uuid();
/**
 * ISO 8601 UTC instant, e.g. `2026-11-14T09:30:00.000Z`. Normalised to
 * millisecond precision so stored instants compare correctly as strings.
 */
export const instantSchema = z.iso.datetime().transform((value) => new Date(value).toISOString());
/** Local calendar date `YYYY-MM-DD`. */
export const dateKeySchema = z
  .string()
  .refine(isDateKey, { message: 'Expected a calendar date in YYYY-MM-DD format' });
/** Month `YYYY-MM`. */
export const monthKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month in YYYY-MM format');
export const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: 'Expected an IANA timezone, e.g. Europe/London' });

export const isbn10Schema = z.string().refine(isValidIsbn10, { message: 'Invalid ISBN-10' });
export const isbn13Schema = z.string().refine(isValidIsbn13, { message: 'Invalid ISBN-13' });
export const httpUrlSchema = z.url({ protocol: /^https?$/ });
/** `#rrggbb` colour. */
export const colourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour');

const optionalText = (max: number) => z.string().trim().max(max).nullable();

/**
 * `paused` keeps the in-progress read open (SPEC §4) but takes the book off
 * the currently-reading list.
 */
export const bookStatusSchema = z.enum(['to_read', 'reading', 'paused', 'finished', 'dnf']);
export const bookSourceSchema = z.enum(['openlibrary', 'googlebooks', 'manual']);
export const formatTypeSchema = z.enum(['physical', 'kindle', 'audiobook']);
export const readOutcomeSchema = z.enum(['in_progress', 'finished', 'dnf']);
export const progressUnitSchema = z.enum(['pages', 'percent', 'audio_seconds']);
export const noteKindSchema = z.enum(['note', 'quote']);
/** Where a session came from: logged in Bookshelf, or imported from Bookpine (SPEC §8). */
export const sessionSourceSchema = z.enum(['app', 'bookpine']);
export const goalKindSchema = z.enum(['books_per_year', 'pages_per_year', 'minutes_per_day']);
export const ratingSchema = z
  .number()
  .min(0.5)
  .max(5)
  .refine((value) => Number.isInteger(value * 2), { message: 'Rating must be in steps of 0.5' });

export type BookStatus = z.infer<typeof bookStatusSchema>;
export type BookSource = z.infer<typeof bookSourceSchema>;
export type FormatType = z.infer<typeof formatTypeSchema>;
export type ReadOutcome = z.infer<typeof readOutcomeSchema>;
export type ProgressUnit = z.infer<typeof progressUnitSchema>;
export type NoteKind = z.infer<typeof noteKindSchema>;
export type SessionSource = z.infer<typeof sessionSourceSchema>;
export type GoalKind = z.infer<typeof goalKindSchema>;

const timestamps = {
  createdAt: instantSchema,
  updatedAt: instantSchema,
  deletedAt: instantSchema.nullable(),
};

// Shared field definitions (used by entities and request bodies).
const bookFields = {
  title: z.string().trim().min(1).max(500),
  subtitle: optionalText(500),
  authors: z.array(z.string().trim().min(1).max(200)).max(50),
  publisher: optionalText(200),
  publishedDate: optionalText(50),
  language: optionalText(20),
  synopsis: optionalText(20_000),
  coverUrl: httpUrlSchema.nullable(),
  isbn10: isbn10Schema.nullable(),
  isbn13: isbn13Schema.nullable(),
  genres: z.array(z.string().trim().min(1).max(100)).max(50),
  source: bookSourceSchema,
  sourceId: optionalText(200),
  status: bookStatusSchema,
  rating: ratingSchema.nullable(),
};

const formatFields = {
  format: formatTypeSchema,
  pageCount: z.int().positive().max(100_000).nullable(),
  audioDurationSeconds: z.int().positive().max(1_000_000).nullable(),
  isbn: optionalText(20),
};

const sessionFields = {
  startedAt: instantSchema,
  endedAt: instantSchema,
  /**
   * Reading time. Null = unknown (imported reading days): such sessions
   * count for the calendar and streaks but not for time, speed or finish
   * estimates (SPEC §4).
   */
  durationSeconds: z
    .int()
    .min(0)
    .max(7 * 86_400)
    .nullable(),
  progressUnit: progressUnitSchema,
  startValue: z.number().min(0).nullable(),
  endValue: z.number().min(0).nullable(),
  note: optionalText(5_000),
};

const noteFields = {
  kind: noteKindSchema,
  text: z.string().trim().min(1).max(20_000),
  location: optionalText(100),
};

const goalFields = {
  kind: goalKindSchema,
  year: z.int().min(1900).max(9999).nullable(),
  target: z.int().positive().max(1_000_000),
};

const tagFields = {
  name: z.string().trim().min(1).max(50),
  colour: colourSchema.nullable(),
};

// ---------------------------------------------------------------------------
// Entities (SPEC §4)
// ---------------------------------------------------------------------------

/** A book row as stored (without its tag links). */
export const bookRecordSchema = z.object({
  id: idSchema,
  ...bookFields,
  /** Cached cover file name inside the data dir's `covers/` folder (server-managed). */
  coverPath: z.string().nullable(),
  ...timestamps,
});
export type BookRecord = z.infer<typeof bookRecordSchema>;

/** A book with the IDs of its (non-deleted) tags. */
export const bookSchema = bookRecordSchema.extend({ tagIds: z.array(idSchema) });
export type Book = z.infer<typeof bookSchema>;

export const bookFormatSchema = z.object({
  id: idSchema,
  bookId: idSchema,
  ...formatFields,
  ...timestamps,
});
export type BookFormat = z.infer<typeof bookFormatSchema>;

export const readSchema = z.object({
  id: idSchema,
  bookId: idSchema,
  number: z.int().min(1),
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  outcome: readOutcomeSchema,
  ...timestamps,
});
export type Read = z.infer<typeof readSchema>;

export const sessionSchema = z.object({
  id: idSchema,
  readId: idSchema,
  bookId: idSchema,
  formatId: idSchema,
  ...sessionFields,
  /** Derived server-side from unit + format length; null when the length is unknown. */
  startPercent: z.number().min(0).max(100).nullable(),
  endPercent: z.number().min(0).max(100).nullable(),
  source: sessionSourceSchema,
  ...timestamps,
});
export type Session = z.infer<typeof sessionSchema>;

/**
 * The single active timer. Running when `pausedAt` is null. `resumedAt` is
 * the start of the current running segment; `accumulatedSeconds` holds the
 * time from earlier segments. Elapsed = accumulated + (running ? now − resumedAt : 0).
 */
export const activeTimerSchema = z.object({
  id: idSchema,
  bookId: idSchema,
  formatId: idSchema,
  startedAt: instantSchema,
  resumedAt: instantSchema,
  pausedAt: instantSchema.nullable(),
  accumulatedSeconds: z.int().min(0),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ActiveTimer = z.infer<typeof activeTimerSchema>;

export const tagSchema = z.object({ id: idSchema, ...tagFields, ...timestamps });
export type Tag = z.infer<typeof tagSchema>;

export const bookNoteSchema = z.object({
  id: idSchema,
  bookId: idSchema,
  ...noteFields,
  ...timestamps,
});
export type BookNote = z.infer<typeof bookNoteSchema>;

export const goalSchema = z.object({ id: idSchema, ...goalFields, ...timestamps });
export type Goal = z.infer<typeof goalSchema>;

// ---------------------------------------------------------------------------
// Errors & health
// ---------------------------------------------------------------------------

export const errorCodeSchema = z.enum([
  'validation_error',
  'not_found',
  'conflict',
  'upstream_error',
  'notion_not_configured',
  'notion_busy',
  'unsupported_backup',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  dbPath: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** A normalised book found via Open Library or Google Books. */
export const bookCandidateSchema = z.object({
  source: z.enum(['openlibrary', 'googlebooks']),
  sourceId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  publishedDate: z.string().nullable(),
  language: z.string().nullable(),
  synopsis: z.string().nullable(),
  coverUrl: httpUrlSchema.nullable(),
  isbn10: isbn10Schema.nullable(),
  isbn13: isbn13Schema.nullable(),
  genres: z.array(z.string()),
  pageCount: z.int().positive().nullable(),
});
export type BookCandidate = z.infer<typeof bookCandidateSchema>;

export const lookupSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).max(100).default(1),
});
export type LookupSearchQuery = z.infer<typeof lookupSearchQuerySchema>;

export const bookCandidateListSchema = z.array(bookCandidateSchema);

// ---------------------------------------------------------------------------
// Books & formats
// ---------------------------------------------------------------------------

/** Format input when creating a format (alone or with a new book). */
export const formatCreateSchema = z.object({
  id: idSchema.optional(),
  format: formatTypeSchema,
  pageCount: formatFields.pageCount.default(null),
  audioDurationSeconds: formatFields.audioDurationSeconds.default(null),
  isbn: formatFields.isbn.default(null),
});
export type FormatCreate = z.input<typeof formatCreateSchema>;

export const formatUpdateSchema = z
  .object(formatFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type FormatUpdate = z.infer<typeof formatUpdateSchema>;

export const bookCreateSchema = z.object({
  id: idSchema.optional(),
  title: bookFields.title,
  subtitle: bookFields.subtitle.default(null),
  authors: bookFields.authors.default([]),
  publisher: bookFields.publisher.default(null),
  publishedDate: bookFields.publishedDate.default(null),
  language: bookFields.language.default(null),
  synopsis: bookFields.synopsis.default(null),
  coverUrl: bookFields.coverUrl.default(null),
  isbn10: bookFields.isbn10.default(null),
  isbn13: bookFields.isbn13.default(null),
  genres: bookFields.genres.default([]),
  source: bookFields.source.default('manual'),
  sourceId: bookFields.sourceId.default(null),
  status: bookFields.status.default('to_read'),
  rating: bookFields.rating.default(null),
  formats: z.array(formatCreateSchema).max(10).default([]),
  tagIds: z.array(idSchema).max(100).default([]),
});
export type BookCreate = z.input<typeof bookCreateSchema>;

export const bookUpdateSchema = z
  .object(bookFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type BookUpdate = z.infer<typeof bookUpdateSchema>;

export const bookListQuerySchema = z.object({
  status: bookStatusSchema.optional(),
  tag: idSchema.optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
export type BookListQuery = z.infer<typeof bookListQuerySchema>;

export const finishEstimateSchema = z.object({
  percentPerDay: z.number(),
  daysRemaining: z.int().min(0),
  date: dateKeySchema,
});

export const bookListItemSchema = bookSchema.extend({
  formats: z.array(bookFormatSchema),
  currentRead: readSchema.nullable(),
  /** Current progress (SPEC §4) of the current read; null when unknown. */
  progressPercent: z.number().nullable(),
  /** Relative URL of the cover (`/api/covers/:id`), or null when the book has no cover. */
  coverSrc: z.string().nullable(),
});
export type BookListItem = z.infer<typeof bookListItemSchema>;
export const bookListSchema = z.array(bookListItemSchema);

export const bookDetailSchema = bookListItemSchema.extend({
  reads: z.array(readSchema),
  estimatedFinish: finishEstimateSchema.nullable(),
});
export type BookDetail = z.infer<typeof bookDetailSchema>;

export const readCreateSchema = z.object({
  id: idSchema.optional(),
  startedAt: instantSchema.optional(),
});
export type ReadCreate = z.infer<typeof readCreateSchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const sessionCreateSchema = z.object({
  id: idSchema.optional(),
  bookId: idSchema,
  formatId: idSchema,
  /** Defaults to the book's in-progress read (created when there is none). */
  readId: idSchema.optional(),
  startedAt: sessionFields.startedAt,
  endedAt: sessionFields.endedAt,
  /** Defaults to endedAt − startedAt; null records an unknown duration. */
  durationSeconds: sessionFields.durationSeconds.optional(),
  progressUnit: sessionFields.progressUnit,
  /** Defaults to the read's current progress converted into `progressUnit` (or 0). */
  startValue: sessionFields.startValue.optional(),
  endValue: sessionFields.endValue.default(null),
  note: sessionFields.note.default(null),
});
export type SessionCreate = z.input<typeof sessionCreateSchema>;

export const sessionUpdateSchema = z
  .object({ formatId: idSchema, ...sessionFields })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

export const sessionListQuerySchema = z.object({
  bookId: idSchema.optional(),
  /** Inclusive local date (bucketed by session start in BOOKSHELF_TZ). */
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export const sessionListSchema = z.array(sessionSchema);

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

export const timerPutSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    id: idSchema.optional(),
    bookId: idSchema,
    formatId: idSchema,
    /** Client time of the action; defaults to server now. */
    at: instantSchema.optional(),
  }),
  z.object({ action: z.literal('pause'), at: instantSchema.optional() }),
  z.object({ action: z.literal('resume'), at: instantSchema.optional() }),
]);
export type TimerPut = z.infer<typeof timerPutSchema>;

export const timerResponseSchema = z.object({
  timer: activeTimerSchema.nullable(),
  /** Elapsed seconds at `serverTime` (0 when there is no timer). */
  elapsedSeconds: z.int().min(0),
  serverTime: instantSchema,
});
export type TimerResponse = z.infer<typeof timerResponseSchema>;

// ---------------------------------------------------------------------------
// Tags, notes, goals
// ---------------------------------------------------------------------------

export const tagCreateSchema = z.object({
  id: idSchema.optional(),
  name: tagFields.name,
  colour: tagFields.colour.default(null),
});
export type TagCreate = z.input<typeof tagCreateSchema>;

export const tagUpdateSchema = z
  .object(tagFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type TagUpdate = z.infer<typeof tagUpdateSchema>;

export const tagListSchema = z.array(tagSchema);

export const bookTagsPutSchema = z.object({ tagIds: z.array(idSchema).max(100) });
export type BookTagsPut = z.infer<typeof bookTagsPutSchema>;

export const noteCreateSchema = z.object({
  id: idSchema.optional(),
  kind: noteFields.kind,
  text: noteFields.text,
  location: noteFields.location.default(null),
});
export type NoteCreate = z.input<typeof noteCreateSchema>;

export const noteUpdateSchema = z
  .object(noteFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type NoteUpdate = z.infer<typeof noteUpdateSchema>;

export const noteListSchema = z.array(bookNoteSchema);

/**
 * Goal body for `PUT /api/goals/:id`. `year` is required for the per-year
 * kinds and must be null (or omitted) for `minutes_per_day`.
 */
export const goalPutSchema = z
  .object({ kind: goalFields.kind, year: goalFields.year.default(null), target: goalFields.target })
  .refine((goal) => (goal.kind === 'minutes_per_day') === (goal.year === null), {
    message: 'year is required for per-year goals and must be null for minutes_per_day',
    path: ['year'],
  });
export type GoalPut = z.input<typeof goalPutSchema>;

export const goalWithProgressSchema = goalSchema.extend({
  /** Progress towards the target: books finished / pages read in `year`, or minutes today. */
  current: z.number().min(0),
});
export type GoalWithProgress = z.infer<typeof goalWithProgressSchema>;
export const goalListSchema = z.array(goalWithProgressSchema);

// ---------------------------------------------------------------------------
// Stats & calendar
// ---------------------------------------------------------------------------

export const statsRangeQuerySchema = z
  .object({ from: dateKeySchema.optional(), to: dateKeySchema.optional() })
  .refine((range) => !range.from || !range.to || range.from <= range.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });
export type StatsRangeQuery = z.infer<typeof statsRangeQuerySchema>;

const totalsFields = {
  seconds: z.int().min(0),
  sessions: z.int().min(0),
  pages: z.int().min(0),
};

export const readingSpeedSchema = z.object({
  format: formatTypeSchema,
  sessions: z.int().min(0),
  seconds: z.int().min(0),
  pagesPerHour: z.number().nullable(),
  percentPerHour: z.number().nullable(),
  listeningRatio: z.number().nullable(),
});

export const statsSummarySchema = z.object({
  from: dateKeySchema.nullable(),
  to: dateKeySchema.nullable(),
  totals: z.object({
    ...totalsFields,
    booksFinished: z.int().min(0),
    /** Sessions with an unknown duration (counted in `sessions`, not in `seconds`). */
    untimedSessions: z.int().min(0),
  }),
  byFormat: z.array(z.object({ format: formatTypeSchema, ...totalsFields })),
  byGenre: z.array(z.object({ genre: z.string(), ...totalsFields })),
  byTag: z.array(z.object({ tagId: idSchema, name: z.string(), ...totalsFields })),
  byAuthor: z.array(z.object({ author: z.string(), ...totalsFields })),
  /** Speed per format over the 30 days ending at `to` (or today). */
  readingSpeed: z.array(readingSpeedSchema),
});
export type StatsSummary = z.infer<typeof statsSummarySchema>;

export const statsDailySchema = z.object({
  from: dateKeySchema,
  to: dateKeySchema,
  days: z.array(
    z.object({
      date: dateKeySchema,
      seconds: z.int().min(0),
      minutes: z.int().min(0),
      pages: z.int().min(0),
      percent: z.number().min(0),
      sessions: z.int().min(0),
      /** Sessions with an unknown duration (counted in `sessions`, not in the minutes). */
      untimedSessions: z.int().min(0),
    }),
  ),
});
export type StatsDaily = z.infer<typeof statsDailySchema>;

export const streaksSchema = z.object({
  current: z.int().min(0),
  longest: z.int().min(0),
  lastReadDate: dateKeySchema.nullable(),
  today: dateKeySchema,
});
export type StreaksResponse = z.infer<typeof streaksSchema>;

export const yearInReviewSchema = z.object({
  year: z.int(),
  totals: z.object({ ...totalsFields, booksFinished: z.int().min(0), daysRead: z.int().min(0) }),
  booksFinished: z.array(
    z.object({
      bookId: idSchema,
      title: z.string(),
      authors: z.array(z.string()),
      coverSrc: z.string().nullable(),
      finishedAt: instantSchema,
      rating: z.number().nullable(),
    }),
  ),
  byMonth: z.array(
    z.object({ month: monthKeySchema, ...totalsFields, booksFinished: z.int().min(0) }),
  ),
  topAuthors: z.array(z.object({ author: z.string(), seconds: z.int().min(0) })),
  topGenres: z.array(z.object({ genre: z.string(), seconds: z.int().min(0) })),
  longestSession: z
    .object({
      sessionId: idSchema,
      bookId: idSchema,
      seconds: z.int().min(0),
      date: dateKeySchema,
    })
    .nullable(),
  longestStreak: z.int().min(0),
});
export type YearInReview = z.infer<typeof yearInReviewSchema>;

export const calendarQuerySchema = z.object({ month: monthKeySchema });
export const calendarSchema = z.object({
  month: monthKeySchema,
  /** Only days with at least one session, ascending. */
  days: z.array(
    z.object({
      date: dateKeySchema,
      entries: z.array(
        z.object({
          bookId: idSchema,
          title: z.string(),
          /** Relative cover URL (`/api/covers/:id`) or null. */
          coverUrl: z.string().nullable(),
          /** Minutes of the day's sessions with a known duration. */
          minutes: z.int().min(0),
          /** Sessions that day with an unknown duration (imported); shown as "time unknown". */
          untimedSessions: z.int().min(0),
        }),
      ),
    }),
  ),
});
export type CalendarResponse = z.infer<typeof calendarSchema>;

// ---------------------------------------------------------------------------
// Sync (offline outbox replay)
// ---------------------------------------------------------------------------

export const syncEntitySchema = z.enum([
  'book',
  'format',
  'read',
  'session',
  'tag',
  'note',
  'goal',
  'timer',
]);
export type SyncEntity = z.infer<typeof syncEntitySchema>;

/**
 * Upsert payloads: the full client-side record. Timestamps are taken from
 * the op's `clientUpdatedAt`; `createdAt` is kept from the existing row (or
 * set to `clientUpdatedAt` on insert). Session percents are re-derived by
 * the server. A book's `tagIds`, when present, replace its tag links.
 */
export const syncPayloadSchemas = {
  book: z.object({ id: idSchema, ...bookFields, tagIds: z.array(idSchema).max(100).optional() }),
  format: z.object({ id: idSchema, bookId: idSchema, ...formatFields }),
  read: readSchema.pick({
    id: true,
    bookId: true,
    number: true,
    startedAt: true,
    finishedAt: true,
    outcome: true,
  }),
  session: z.object({
    id: idSchema,
    readId: idSchema,
    bookId: idSchema,
    formatId: idSchema,
    ...sessionFields,
    /** Omitted by older clients: the stored row keeps its source ('app' when new). */
    source: sessionSourceSchema.optional(),
  }),
  tag: z.object({ id: idSchema, ...tagFields }),
  note: z.object({ id: idSchema, bookId: idSchema, ...noteFields }),
  goal: z.object({ id: idSchema, ...goalFields }),
  timer: activeTimerSchema.pick({
    id: true,
    bookId: true,
    formatId: true,
    startedAt: true,
    resumedAt: true,
    pausedAt: true,
    accumulatedSeconds: true,
  }),
} as const satisfies Record<SyncEntity, z.ZodType>;

export const syncDeletePayloadSchema = z.object({ id: idSchema });

export const syncOpSchema = z.object({
  opId: idSchema,
  entity: syncEntitySchema,
  action: z.enum(['upsert', 'delete']),
  /** Validated per entity: an upsert payload, or `{ id }` for deletes. */
  payload: z.unknown(),
  clientUpdatedAt: instantSchema,
});
export type SyncOp = z.infer<typeof syncOpSchema>;

export const syncRequestSchema = z.object({ ops: z.array(syncOpSchema).max(500) });
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export const syncOpResultSchema = z.object({
  opId: idSchema,
  /**
   * `applied`: written. `stale`: ignored because the stored row is newer
   * (last-write-wins). `error`: rejected; not recorded, so it may be retried.
   */
  status: z.enum(['applied', 'stale', 'error']),
  /** True when this opId had already been processed; the original result is returned. */
  duplicate: z.boolean(),
  error: z.object({ code: errorCodeSchema, message: z.string() }).optional(),
});
export type SyncOpResult = z.infer<typeof syncOpResultSchema>;

export const syncResponseSchema = z.object({ results: z.array(syncOpResultSchema) });
export type SyncResponse = z.infer<typeof syncResponseSchema>;

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/** Backups from schema version 1–2 have no session `source`: those sessions were logged in the app. */
export const backupSessionSchema = sessionSchema.extend({
  source: sessionSourceSchema.default('app'),
});

export const backupDataSchema = z.object({
  books: z.array(bookSchema),
  formats: z.array(bookFormatSchema),
  reads: z.array(readSchema),
  sessions: z.array(backupSessionSchema),
  tags: z.array(tagSchema),
  notes: z.array(bookNoteSchema),
  goals: z.array(goalSchema),
  timer: activeTimerSchema.nullable(),
});
export type BackupData = z.infer<typeof backupDataSchema>;

export const backupEnvelopeSchema = z.object({
  app: z.literal('bookshelf'),
  /** Highest applied migration version when exported. */
  schemaVersion: z.int().min(1),
  exportedAt: instantSchema,
  data: backupDataSchema,
});
export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;

export const backupCountsSchema = z.object({
  books: z.int().min(0),
  formats: z.int().min(0),
  reads: z.int().min(0),
  sessions: z.int().min(0),
  tags: z.int().min(0),
  notes: z.int().min(0),
  goals: z.int().min(0),
  timer: z.int().min(0),
});
export type BackupCounts = z.infer<typeof backupCountsSchema>;

export const backupImportResponseSchema = z.object({
  imported: backupCountsSchema,
  /** File name of the pre-import snapshot written to `backups/`. */
  snapshot: z.string(),
});
export type BackupImportResponse = z.infer<typeof backupImportResponseSchema>;

export const notionCountsSchema = z.object({
  created: z.int().min(0),
  updated: z.int().min(0),
  archived: z.int().min(0),
  unchanged: z.int().min(0),
});
export type NotionEntityCounts = z.infer<typeof notionCountsSchema>;

export const notionRunResultSchema = z.object({
  books: notionCountsSchema,
  sessions: notionCountsSchema,
  notes: notionCountsSchema,
  startedAt: instantSchema,
  finishedAt: instantSchema,
});
export type NotionRunResult = z.infer<typeof notionRunResultSchema>;

export const notionStatusSchema = z.object({
  configured: z.boolean(),
  running: z.boolean(),
  lastRunAt: instantSchema.nullable(),
  lastSuccessAt: instantSchema.nullable(),
  lastError: z.string().nullable(),
  lastResult: notionRunResultSchema.nullable(),
});
export type NotionStatus = z.infer<typeof notionStatusSchema>;
