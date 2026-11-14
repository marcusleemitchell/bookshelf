/**
 * Realistic API payloads for web tests, built from public bibliographic
 * metadata and validated with the shared schemas so they always match the
 * real contract.
 */
import {
  activeTimerSchema,
  bookCandidateSchema,
  bookDetailSchema,
  bookFormatSchema,
  bookListItemSchema,
  bookNoteSchema,
  bookpineReportSchema,
  calendarSchema,
  goalWithProgressSchema,
  readSchema,
  sessionSchema,
  statsDailySchema,
  statsSummarySchema,
  streaksSchema,
  tagSchema,
  timerResponseSchema,
  yearInReviewSchema,
  type ActiveTimer,
  type BookCandidate,
  type BookDetail,
  type BookFormat,
  type BookListItem,
  type BookNote,
  type BookpineReport,
  type CalendarResponse,
  type GoalWithProgress,
  type Read,
  type Session,
  type StatsDaily,
  type StatsSummary,
  type Tag,
  type TimerResponse,
  type YearInReview,
} from '../../../shared/index.ts';

/** The fixed "now" for web tests: Saturday 14/11/2026, 10:00 in London. */
export const NOW = '2026-11-14T10:00:00.000Z';
export const TODAY = '2026-11-14';
export const TIME_ZONE = 'Europe/London';

/** A valid, deterministic UUID v4 for test number `n`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const IDS = {
  leGuin: uuid(1),
  leGuinPhysical: uuid(2),
  leGuinRead: uuid(3),
  piranesi: uuid(11),
  piranesiKindle: uuid(12),
  hailMary: uuid(21),
  hailMaryAudio: uuid(22),
  hailMaryRead: uuid(23),
  tagSciFi: uuid(31),
  tagBookClub: uuid(32),
  timer: uuid(41),
  goalBooks: uuid(51),
  goalMinutes: uuid(52),
  note: uuid(61),
  session1: uuid(71),
  session2: uuid(72),
} as const;

const stamps = {
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-11-13T21:00:00.000Z',
  deletedAt: null,
};

export function makeFormat(overrides: Partial<BookFormat> & { bookId: string }): BookFormat {
  return bookFormatSchema.parse({
    id: uuid(900),
    format: 'physical',
    pageCount: 304,
    audioDurationSeconds: null,
    isbn: null,
    ...stamps,
    ...overrides,
  });
}

export function makeRead(overrides: Partial<Read> & { bookId: string }): Read {
  return readSchema.parse({
    id: uuid(901),
    number: 1,
    startedAt: '2026-11-01T19:00:00.000Z',
    finishedAt: null,
    outcome: 'in_progress',
    ...stamps,
    ...overrides,
  });
}

/** "The Left Hand of Darkness": reading, physical 304 pages, 40% through. */
export function leGuin(overrides: Partial<BookDetail> = {}): BookDetail {
  const read = makeRead({ id: IDS.leGuinRead, bookId: IDS.leGuin });
  return bookDetailSchema.parse({
    id: IDS.leGuin,
    title: 'The Left Hand of Darkness',
    subtitle: null,
    authors: ['Ursula K. Le Guin'],
    publisher: 'Ace',
    publishedDate: '1969',
    language: 'en',
    synopsis: 'A lone human emissary is sent to Winter, an alien world.',
    coverUrl: 'https://covers.openlibrary.org/b/id/8231856-L.jpg',
    coverPath: `${IDS.leGuin}.jpg`,
    isbn10: '0441478123',
    isbn13: '9780441478125',
    genres: ['Science fiction'],
    source: 'openlibrary',
    sourceId: 'OL59863W',
    status: 'reading',
    rating: null,
    ...stamps,
    tagIds: [IDS.tagSciFi],
    formats: [makeFormat({ id: IDS.leGuinPhysical, bookId: IDS.leGuin, pageCount: 304 })],
    currentRead: read,
    progressPercent: 40,
    coverSrc: `/api/covers/${IDS.leGuin}`,
    reads: [read],
    estimatedFinish: { percentPerDay: 4, daysRemaining: 15, date: '2026-11-29' },
    ...overrides,
  });
}

/** "Piranesi": to read, Kindle without a known length, no reads. */
export function piranesi(overrides: Partial<BookDetail> = {}): BookDetail {
  return bookDetailSchema.parse({
    id: IDS.piranesi,
    title: 'Piranesi',
    subtitle: null,
    authors: ['Susanna Clarke'],
    publisher: 'Bloomsbury',
    publishedDate: '2020',
    language: 'en',
    synopsis: null,
    coverUrl: null,
    coverPath: null,
    isbn10: '1526622424',
    isbn13: '9781526622426',
    genres: ['Fantasy'],
    source: 'openlibrary',
    sourceId: 'OL20893680W',
    status: 'to_read',
    rating: null,
    ...stamps,
    tagIds: [IDS.tagBookClub],
    formats: [
      makeFormat({
        id: IDS.piranesiKindle,
        bookId: IDS.piranesi,
        format: 'kindle',
        pageCount: null,
      }),
    ],
    currentRead: null,
    progressPercent: null,
    coverSrc: null,
    reads: [],
    estimatedFinish: null,
    ...overrides,
  });
}

/** "Project Hail Mary": finished audiobook (16:10:35), rated 4.5. */
export function hailMary(overrides: Partial<BookDetail> = {}): BookDetail {
  const read = makeRead({
    id: IDS.hailMaryRead,
    bookId: IDS.hailMary,
    startedAt: '2026-09-01T08:00:00.000Z',
    finishedAt: '2026-10-02T20:00:00.000Z',
    outcome: 'finished',
  });
  return bookDetailSchema.parse({
    id: IDS.hailMary,
    title: 'Project Hail Mary',
    subtitle: null,
    authors: ['Andy Weir'],
    publisher: 'Ballantine Books',
    publishedDate: '2021',
    language: 'en',
    synopsis: null,
    coverUrl: null,
    coverPath: null,
    isbn10: null,
    isbn13: null,
    genres: ['Science fiction'],
    source: 'manual',
    sourceId: null,
    status: 'finished',
    rating: 4.5,
    ...stamps,
    tagIds: [],
    formats: [
      makeFormat({
        id: IDS.hailMaryAudio,
        bookId: IDS.hailMary,
        format: 'audiobook',
        pageCount: null,
        audioDurationSeconds: 58_235,
      }),
    ],
    currentRead: read,
    progressPercent: 100,
    coverSrc: null,
    reads: [read],
    estimatedFinish: null,
    ...overrides,
  });
}

export function toListItem(detail: BookDetail): BookListItem {
  return bookListItemSchema.parse(detail);
}

export function library(): BookListItem[] {
  return [leGuin(), piranesi(), hailMary()].map(toListItem);
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: IDS.session1,
    readId: IDS.leGuinRead,
    bookId: IDS.leGuin,
    formatId: IDS.leGuinPhysical,
    startedAt: '2026-11-13T20:00:00.000Z',
    endedAt: '2026-11-13T20:45:00.000Z',
    durationSeconds: 2700,
    progressUnit: 'pages',
    startValue: 90,
    endValue: 122,
    startPercent: 29.61,
    endPercent: 40.13,
    note: 'Genly and Estraven cross the ice.',
    source: 'app',
    ...stamps,
    ...overrides,
  });
}

export function makeTimer(overrides: Partial<ActiveTimer> = {}): ActiveTimer {
  return activeTimerSchema.parse({
    id: IDS.timer,
    bookId: IDS.leGuin,
    formatId: IDS.leGuinPhysical,
    startedAt: '2026-11-14T09:30:00.000Z',
    resumedAt: '2026-11-14T09:30:00.000Z',
    pausedAt: null,
    accumulatedSeconds: 0,
    createdAt: '2026-11-14T09:30:00.000Z',
    updatedAt: '2026-11-14T09:30:00.000Z',
    ...overrides,
  });
}

export function timerResponse(timer: ActiveTimer | null, serverTime = NOW): TimerResponse {
  const elapsed = timer
    ? timer.accumulatedSeconds +
      (timer.pausedAt === null
        ? Math.floor((Date.parse(serverTime) - Date.parse(timer.resumedAt)) / 1000)
        : 0)
    : 0;
  return timerResponseSchema.parse({ timer, elapsedSeconds: elapsed, serverTime });
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  return tagSchema.parse({
    id: IDS.tagSciFi,
    name: 'Science fiction',
    colour: '#2f5d50',
    ...stamps,
    ...overrides,
  });
}

export function tags(): Tag[] {
  return [makeTag(), makeTag({ id: IDS.tagBookClub, name: 'Book club', colour: '#8a6421' })];
}

export function makeNote(overrides: Partial<BookNote> = {}): BookNote {
  return bookNoteSchema.parse({
    id: IDS.note,
    bookId: IDS.leGuin,
    kind: 'quote',
    text: 'Light is the left hand of darkness.',
    location: 'p. 233',
    ...stamps,
    ...overrides,
  });
}

export function makeGoal(overrides: Partial<GoalWithProgress> = {}): GoalWithProgress {
  return goalWithProgressSchema.parse({
    id: IDS.goalMinutes,
    kind: 'minutes_per_day',
    year: null,
    target: 30,
    current: 20,
    ...stamps,
    ...overrides,
  });
}

export function streaks(current = 5, longest = 12) {
  return streaksSchema.parse({ current, longest, lastReadDate: TODAY, today: TODAY });
}

export function daily(
  days: { date: string; minutes: number; pages?: number; percent?: number }[],
  from?: string,
  to?: string,
): StatsDaily {
  return statsDailySchema.parse({
    from: from ?? days[0]?.date ?? TODAY,
    to: to ?? days[days.length - 1]?.date ?? TODAY,
    days: days.map((day) => ({
      date: day.date,
      seconds: day.minutes * 60,
      minutes: day.minutes,
      pages: day.pages ?? 0,
      percent: day.percent ?? 0,
      sessions: day.minutes > 0 ? 1 : 0,
      untimedSessions: 0,
    })),
  });
}

export function summary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return statsSummarySchema.parse({
    from: '2026-10-16',
    to: TODAY,
    totals: { seconds: 45_000, sessions: 21, pages: 412, booksFinished: 2, untimedSessions: 0 },
    byFormat: [
      { format: 'physical', seconds: 30_000, sessions: 14, pages: 412 },
      { format: 'audiobook', seconds: 15_000, sessions: 7, pages: 0 },
    ],
    byGenre: [{ genre: 'Science fiction', seconds: 45_000, sessions: 21, pages: 412 }],
    byTag: [
      { tagId: IDS.tagSciFi, name: 'Science fiction', seconds: 30_000, sessions: 14, pages: 412 },
    ],
    byAuthor: [
      { author: 'Ursula K. Le Guin', seconds: 30_000, sessions: 14, pages: 412 },
      { author: 'Andy Weir', seconds: 15_000, sessions: 7, pages: 0 },
    ],
    readingSpeed: [
      {
        format: 'physical',
        sessions: 14,
        seconds: 30_000,
        pagesPerHour: 49.4,
        percentPerHour: 16.2,
        listeningRatio: null,
      },
      {
        format: 'audiobook',
        sessions: 7,
        seconds: 15_000,
        pagesPerHour: null,
        percentPerHour: 20,
        listeningRatio: 1.5,
      },
    ],
    ...overrides,
  });
}

export function calendar(month = '2026-11'): CalendarResponse {
  return calendarSchema.parse({
    month,
    days: [
      {
        date: `${month}-03`,
        entries: [
          {
            bookId: IDS.leGuin,
            title: 'The Left Hand of Darkness',
            coverUrl: `/api/covers/${IDS.leGuin}`,
            minutes: 30,
            untimedSessions: 0,
          },
        ],
      },
      {
        date: `${month}-13`,
        entries: [
          {
            bookId: IDS.leGuin,
            title: 'The Left Hand of Darkness',
            coverUrl: `/api/covers/${IDS.leGuin}`,
            minutes: 45,
            untimedSessions: 0,
          },
          {
            bookId: IDS.hailMary,
            title: 'Project Hail Mary',
            coverUrl: null,
            minutes: 20,
            untimedSessions: 0,
          },
        ],
      },
    ],
  });
}

export function yearReview(year = 2026): YearInReview {
  return yearInReviewSchema.parse({
    year,
    totals: { seconds: 180_000, sessions: 90, pages: 2100, booksFinished: 1, daysRead: 70 },
    booksFinished: [
      {
        bookId: IDS.hailMary,
        title: 'Project Hail Mary',
        authors: ['Andy Weir'],
        coverSrc: null,
        finishedAt: '2026-10-02T20:00:00.000Z',
        rating: 4.5,
      },
    ],
    byMonth: Array.from({ length: 12 }, (_, i) => ({
      month: `${year}-${String(i + 1).padStart(2, '0')}`,
      seconds: i === 9 ? 36_000 : 12_000,
      sessions: 7,
      pages: 175,
      booksFinished: i === 9 ? 1 : 0,
    })),
    topAuthors: [{ author: 'Andy Weir', seconds: 60_000 }],
    topGenres: [{ genre: 'Science fiction', seconds: 120_000 }],
    longestSession: {
      sessionId: IDS.session1,
      bookId: IDS.hailMary,
      seconds: 9000,
      date: '2026-09-12',
    },
    longestStreak: 18,
  });
}

export function candidate(overrides: Partial<BookCandidate> = {}): BookCandidate {
  return bookCandidateSchema.parse({
    source: 'openlibrary',
    sourceId: 'OL20893680W',
    title: 'Piranesi',
    subtitle: null,
    authors: ['Susanna Clarke'],
    publisher: 'Bloomsbury',
    publishedDate: '2020',
    language: 'en',
    synopsis: 'Piranesi lives in the House.',
    coverUrl: 'https://covers.openlibrary.org/b/id/10521270-L.jpg',
    isbn10: '1526622424',
    isbn13: '9781526622426',
    genres: ['Fantasy'],
    pageCount: 272,
    ...overrides,
  });
}

export const health = { ok: true, version: '0.1.0', dbPath: '/tmp/bookshelf-test/bookshelf.db' };

export const notionStatus = {
  configured: true,
  running: false,
  lastRunAt: '2026-11-13T03:00:00.000Z',
  lastSuccessAt: '2026-11-13T03:00:00.000Z',
  lastError: null,
  lastResult: null,
};

/** A Bookpine import report (preview by default) with fictional slugs. */
export function bookpineReport(overrides: Partial<BookpineReport> = {}): BookpineReport {
  return bookpineReportSchema.parse({
    dryRun: true,
    rows: 20,
    books: { created: 15, updated: 0, unchanged: 0, skipped: 0, matched: 1 },
    merges: [{ title: 'Orchard at Dusk', slugs: ['orchard-at-dusk-1003', 'orchard-at-dusk-1004'] }],
    formats: { created: 18, updated: 0, unchanged: 0, skipped: 0 },
    reads: { created: 12, updated: 0, unchanged: 0, skipped: 0 },
    sessions: { created: 29, updated: 0, unchanged: 0, skipped: 0, untimed: 29 },
    notes: { created: 2, updated: 0, unchanged: 0, skipped: 0 },
    tags: { created: 2, names: ['favorites', 'owned'] },
    keptEdits: 0,
    enrichment: { pending: 40, found: 0, notFound: 0, failed: 0 },
    covers: { cached: 0, failed: 0 },
    warnings: [
      { slug: 'copper-and-thyme-1019', message: 'Ignored the invalid ISBN-13 "9780000000000"' },
      { slug: null, message: 'Not merged (same title, different first author): a-1, b-2' },
    ],
    snapshot: null,
    ...overrides,
  });
}
