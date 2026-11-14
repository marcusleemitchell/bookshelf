/**
 * Statistics and calendar (SPEC §5). Sessions are bucketed into the local
 * day (BOOKSHELF_TZ) on which they started; sessions of deleted books and
 * deleted sessions are excluded.
 */
import {
  addDays,
  computeStreaks,
  diffDays,
  eachDay,
  localDateKey,
  monthKey,
  monthRange,
  readingSpeeds,
  sessionPages,
  sessionPercentDelta,
  startOfLocalDay,
  type CalendarResponse,
  type DateKey,
  type FormatLength,
  type FormatType,
  type Session,
  type StatsDaily,
  type StatsSummary,
  type StreaksResponse,
  type YearInReview,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { all, type SqlValue } from '../db/database.ts';
import { validationError } from '../http/errors.ts';
import { fromRow, sessionsTable } from '../repositories/tables.ts';
import { coverSrc } from './covers.ts';

/** Longest range accepted by `GET /api/stats/daily` (about ten years). */
export const MAX_DAILY_RANGE_DAYS = 3660;

export interface DateRange {
  from?: DateKey | undefined;
  to?: DateKey | undefined;
}

interface StatBook {
  id: string;
  title: string;
  authors: string[];
  genres: string[];
  coverPath: string | null;
  coverUrl: string | null;
}

export interface StatSession {
  session: Session;
  format: FormatLength;
  book: StatBook;
  day: DateKey;
}

function rangeParams(
  ctx: AppContext,
  column: string,
  range: DateRange,
): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (range.from) {
    clauses.push(`${column} >= ?`);
    params.push(startOfLocalDay(range.from, ctx.config.timeZone).toISOString());
  }
  if (range.to) {
    clauses.push(`${column} < ?`);
    params.push(startOfLocalDay(addDays(range.to, 1), ctx.config.timeZone).toISOString());
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(''), params };
}

interface JoinedRow extends Record<string, unknown> {
  f_format: FormatType;
  f_page_count: number | null;
  f_audio: number | null;
  b_title: string;
  b_authors: string;
  b_genres: string;
  b_cover_path: string | null;
  b_cover_url: string | null;
}

/** Live sessions (of live books) started within `range`, with format and book details. */
export function loadStatSessions(ctx: AppContext, range: DateRange = {}): StatSession[] {
  const filter = rangeParams(ctx, 's.started_at', range);
  const rows = all<JoinedRow>(
    ctx.db,
    `SELECT s.*, f.format AS f_format, f.page_count AS f_page_count, f.audio_duration_seconds AS f_audio,
       b.title AS b_title, b.authors AS b_authors, b.genres AS b_genres,
       b.cover_path AS b_cover_path, b.cover_url AS b_cover_url
     FROM sessions s
     JOIN book_formats f ON f.id = s.format_id
     JOIN books b ON b.id = s.book_id
     WHERE s.deleted_at IS NULL AND b.deleted_at IS NULL${filter.sql}
     ORDER BY s.started_at, s.id`,
    filter.params,
  );
  return rows.map((row) => {
    const session = fromRow(sessionsTable, row);
    return {
      session,
      format: {
        format: row.f_format,
        pageCount: row.f_page_count,
        audioDurationSeconds: row.f_audio,
      },
      book: {
        id: session.bookId,
        title: row.b_title,
        authors: JSON.parse(row.b_authors) as string[],
        genres: JSON.parse(row.b_genres) as string[],
        coverPath: row.b_cover_path,
        coverUrl: row.b_cover_url,
      },
      day: localDateKey(session.startedAt, ctx.config.timeZone),
    };
  });
}

export interface FinishedRead {
  readId: string;
  finishedAt: string;
  day: DateKey;
  book: StatBook & { rating: number | null };
}

/** Finished reads (of live books) whose local finish date falls within `range`. */
export function loadFinishedReads(ctx: AppContext, range: DateRange = {}): FinishedRead[] {
  const filter = rangeParams(ctx, 'r.finished_at', range);
  const rows = all<{
    id: string;
    finished_at: string;
    book_id: string;
    title: string;
    authors: string;
    genres: string;
    cover_path: string | null;
    cover_url: string | null;
    rating: number | null;
  }>(
    ctx.db,
    `SELECT r.id, r.finished_at, b.id AS book_id, b.title, b.authors, b.genres, b.cover_path, b.cover_url, b.rating
     FROM reads r JOIN books b ON b.id = r.book_id
     WHERE r.outcome = 'finished' AND r.finished_at IS NOT NULL
       AND r.deleted_at IS NULL AND b.deleted_at IS NULL${filter.sql}
     ORDER BY r.finished_at, r.id`,
    filter.params,
  );
  return rows.map((row) => ({
    readId: row.id,
    finishedAt: row.finished_at,
    day: localDateKey(row.finished_at, ctx.config.timeZone),
    book: {
      id: row.book_id,
      title: row.title,
      authors: JSON.parse(row.authors) as string[],
      genres: JSON.parse(row.genres) as string[],
      coverPath: row.cover_path,
      coverUrl: row.cover_url,
      rating: row.rating,
    },
  }));
}

function loadBookTags(ctx: AppContext): Map<string, { tagId: string; name: string }[]> {
  const rows = all<{ book_id: string; tag_id: string; name: string }>(
    ctx.db,
    `SELECT bt.book_id, bt.tag_id, t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
     WHERE t.deleted_at IS NULL ORDER BY t.name_key`,
  );
  const byBook = new Map<string, { tagId: string; name: string }[]>();
  for (const row of rows) {
    const list = byBook.get(row.book_id) ?? [];
    list.push({ tagId: row.tag_id, name: row.name });
    byBook.set(row.book_id, list);
  }
  return byBook;
}

interface Totals {
  seconds: number;
  sessions: number;
  pages: number;
}

function emptyTotals(): Totals {
  return { seconds: 0, sessions: 0, pages: 0 };
}

function addSession(totals: Totals, item: StatSession): void {
  totals.seconds += item.session.durationSeconds;
  totals.sessions += 1;
  totals.pages += sessionPages(item.session, item.format);
}

function bump<K>(map: Map<K, Totals>, key: K, item: StatSession): void {
  let totals = map.get(key);
  if (!totals) {
    totals = emptyTotals();
    map.set(key, totals);
  }
  addSession(totals, item);
}

function sortedEntries<K>(map: Map<K, Totals>): [K, Totals][] {
  return [...map.entries()].sort(
    (a, b) => b[1].seconds - a[1].seconds || String(a[0]).localeCompare(String(b[0]), 'en-GB'),
  );
}

export function today(ctx: AppContext): DateKey {
  return localDateKey(ctx.now(), ctx.config.timeZone);
}

/** `GET /api/stats/summary`. Omitted bounds mean "all time". */
export function statsSummary(ctx: AppContext, range: DateRange): StatsSummary {
  const items = loadStatSessions(ctx, range);
  const tagsByBook = loadBookTags(ctx);
  const totals = emptyTotals();
  const byFormat = new Map<FormatType, Totals>();
  const byGenre = new Map<string, Totals>();
  const byTag = new Map<string, Totals>();
  const tagNames = new Map<string, string>();
  const byAuthor = new Map<string, Totals>();
  for (const item of items) {
    addSession(totals, item);
    bump(byFormat, item.format.format, item);
    for (const genre of item.book.genres) bump(byGenre, genre, item);
    for (const author of item.book.authors) bump(byAuthor, author, item);
    for (const tag of tagsByBook.get(item.book.id) ?? []) {
      tagNames.set(tag.tagId, tag.name);
      bump(byTag, tag.tagId, item);
    }
  }

  const now = ctx.now();
  const rangeEnd = range.to ? startOfLocalDay(addDays(range.to, 1), ctx.config.timeZone) : now;
  const speedRef = rangeEnd < now ? rangeEnd : now;
  const speedFrom = addDays(localDateKey(speedRef, ctx.config.timeZone), -30);
  const speedInputs = loadStatSessions(ctx, { from: speedFrom }).map((item) => ({
    session: item.session,
    format: item.format,
  }));

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    totals: { ...totals, booksFinished: loadFinishedReads(ctx, range).length },
    byFormat: sortedEntries(byFormat).map(([format, t]) => ({ format, ...t })),
    byGenre: sortedEntries(byGenre).map(([genre, t]) => ({ genre, ...t })),
    byTag: sortedEntries(byTag).map(([tagId, t]) => ({
      tagId,
      name: tagNames.get(tagId) ?? '',
      ...t,
    })),
    byAuthor: sortedEntries(byAuthor).map(([author, t]) => ({ author, ...t })),
    readingSpeed: readingSpeeds(speedInputs, speedRef, 30),
  };
}

/** `GET /api/stats/daily`. Defaults to the 30 days ending today (or ending `to`). */
export function statsDaily(ctx: AppContext, range: DateRange): StatsDaily {
  const to = range.to ?? today(ctx);
  const from = range.from ?? addDays(to, -29);
  if (from > to) throw validationError('`from` must not be after `to`');
  if (diffDays(from, to) + 1 > MAX_DAILY_RANGE_DAYS) {
    throw validationError(`Range must not exceed ${MAX_DAILY_RANGE_DAYS} days`);
  }
  const byDay = new Map<
    DateKey,
    { seconds: number; pages: number; percent: number; sessions: number }
  >();
  for (const item of loadStatSessions(ctx, { from, to })) {
    const day = byDay.get(item.day) ?? { seconds: 0, pages: 0, percent: 0, sessions: 0 };
    day.seconds += item.session.durationSeconds;
    day.pages += sessionPages(item.session, item.format);
    day.percent += sessionPercentDelta(item.session) ?? 0;
    day.sessions += 1;
    byDay.set(item.day, day);
  }
  return {
    from,
    to,
    days: eachDay(from, to).map((date) => {
      const day = byDay.get(date) ?? { seconds: 0, pages: 0, percent: 0, sessions: 0 };
      return {
        date,
        seconds: day.seconds,
        minutes: Math.round(day.seconds / 60),
        pages: day.pages,
        percent: Math.round(day.percent * 100) / 100,
        sessions: day.sessions,
      };
    }),
  };
}

/** `GET /api/stats/streaks`. */
export function statsStreaks(ctx: AppContext): StreaksResponse {
  const days = all<{ started_at: string }>(
    ctx.db,
    `SELECT s.started_at FROM sessions s JOIN books b ON b.id = s.book_id
     WHERE s.deleted_at IS NULL AND b.deleted_at IS NULL`,
  ).map((row) => localDateKey(row.started_at, ctx.config.timeZone));
  const todayKey = today(ctx);
  return { ...computeStreaks(days, todayKey), today: todayKey };
}

/** `GET /api/stats/year/:year`. */
export function yearInReview(ctx: AppContext, year: number): YearInReview {
  const range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const items = loadStatSessions(ctx, range);
  const finished = loadFinishedReads(ctx, range);
  const totals = emptyTotals();
  const months = new Map<string, Totals & { booksFinished: number }>();
  for (let m = 1; m <= 12; m += 1) {
    months.set(`${year}-${String(m).padStart(2, '0')}`, { ...emptyTotals(), booksFinished: 0 });
  }
  const authors = new Map<string, Totals>();
  const genres = new Map<string, Totals>();
  let longest: StatSession | null = null;
  for (const item of items) {
    addSession(totals, item);
    addSession(months.get(monthKey(item.day)) as Totals, item);
    for (const author of item.book.authors) bump(authors, author, item);
    for (const genre of item.book.genres) bump(genres, genre, item);
    if (!longest || item.session.durationSeconds > longest.session.durationSeconds) longest = item;
  }
  for (const read of finished) {
    (months.get(monthKey(read.day)) as { booksFinished: number }).booksFinished += 1;
  }
  const days = items.map((item) => item.day);
  return {
    year,
    totals: { ...totals, booksFinished: finished.length, daysRead: new Set(days).size },
    booksFinished: finished.map((read) => ({
      bookId: read.book.id,
      title: read.book.title,
      authors: read.book.authors,
      coverSrc: coverSrc(read.book),
      finishedAt: read.finishedAt,
      rating: read.book.rating,
    })),
    byMonth: [...months.entries()].map(([month, t]) => ({ month, ...t })),
    topAuthors: sortedEntries(authors)
      .slice(0, 5)
      .map(([author, t]) => ({ author, seconds: t.seconds })),
    topGenres: sortedEntries(genres)
      .slice(0, 5)
      .map(([genre, t]) => ({ genre, seconds: t.seconds })),
    longestSession: longest
      ? {
          sessionId: longest.session.id,
          bookId: longest.book.id,
          seconds: longest.session.durationSeconds,
          date: longest.day,
        }
      : null,
    longestStreak: computeStreaks(days, range.to).longest,
  };
}

/** `GET /api/calendar?month=YYYY-MM`: per-day books read, most minutes first. */
export function calendarMonth(ctx: AppContext, month: string): CalendarResponse {
  const range = monthRange(month);
  const byDay = new Map<
    DateKey,
    Map<string, { title: string; coverUrl: string | null; seconds: number }>
  >();
  for (const item of loadStatSessions(ctx, range)) {
    const books =
      byDay.get(item.day) ??
      new Map<string, { title: string; coverUrl: string | null; seconds: number }>();
    const entry = books.get(item.book.id) ?? {
      title: item.book.title,
      coverUrl: coverSrc(item.book),
      seconds: 0,
    };
    entry.seconds += item.session.durationSeconds;
    books.set(item.book.id, entry);
    byDay.set(item.day, books);
  }
  return {
    month,
    days: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, books]) => ({
        date,
        entries: [...books.entries()]
          .map(([bookId, entry]) => ({
            bookId,
            title: entry.title,
            coverUrl: entry.coverUrl,
            minutes: Math.round(entry.seconds / 60),
          }))
          .sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title, 'en-GB')),
      })),
  };
}
