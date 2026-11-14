import { afterEach, describe, expect, it } from 'vitest';
import {
  calendarSchema,
  statsDailySchema,
  statsSummarySchema,
  streaksSchema,
  yearInReviewSchema,
  type BookDetail,
  type CalendarResponse,
  type StatsDaily,
  type StatsSummary,
  type StreaksResponse,
  type Tag,
  type YearInReview,
} from '../../shared/index.ts';
import { createTestEnv, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

afterEach(() => {
  env.cleanup();
});

async function seed(timeZone = 'Europe/London') {
  env = createTestEnv({ timeZone });
  const tag = (await env.request<Tag>('POST', '/api/tags', { name: 'Favourites' })).body;
  const a = (
    await env.request<BookDetail>('POST', '/api/books', {
      title: 'The Dispossessed',
      authors: ['Ursula K. Le Guin'],
      genres: ['Science fiction'],
      tagIds: [tag.id],
      formats: [{ format: 'physical', pageCount: 400 }],
    })
  ).body;
  const b = (
    await env.request<BookDetail>('POST', '/api/books', {
      title: 'SPQR',
      authors: ['Mary Beard'],
      genres: ['History'],
      formats: [{ format: 'audiobook', audioDurationSeconds: 36_000 }],
    })
  ).body;
  const gone = (
    await env.request<BookDetail>('POST', '/api/books', {
      title: 'Deleted',
      formats: [{ format: 'kindle' }],
    })
  ).body;
  const aFormat = a.formats[0]?.id as string;
  const bFormat = b.formats[0]?.id as string;
  const log = async (
    book: BookDetail,
    formatId: string,
    startedAt: string,
    seconds: number,
    unit: string,
    start: number,
    end: number,
  ) => {
    const endedAt = new Date(Date.parse(startedAt) + seconds * 1000).toISOString();
    const res = await env.request('POST', '/api/sessions', {
      bookId: book.id,
      formatId,
      startedAt,
      endedAt,
      progressUnit: unit,
      startValue: start,
      endValue: end,
    });
    expect(res.status).toBe(201);
  };
  await log(a, aFormat, '2026-10-01T09:00:00.000Z', 1200, 'pages', 80, 100);
  await log(a, aFormat, '2026-11-12T09:00:00.000Z', 3600, 'pages', 0, 40);
  await log(a, aFormat, '2026-11-13T21:30:00.000Z', 1800, 'pages', 40, 80);
  await log(b, bFormat, '2026-11-14T08:00:00.000Z', 2700, 'audio_seconds', 0, 3600);
  await log(a, aFormat, '2026-11-14T10:00:00.000Z', 900, 'pages', 100, 110);
  await log(gone, gone.formats[0]?.id as string, '2026-11-14T07:00:00.000Z', 600, 'percent', 0, 5);
  await env.request('DELETE', `/api/books/${gone.id}`);
  await env.request('PATCH', `/api/books/${a.id}`, { status: 'finished' });
  return { a, b, tag };
}

describe('GET /api/stats/summary', () => {
  it('totals all time with breakdowns and reading speed', async () => {
    const { a, b, tag } = await seed();
    const res = await env.request<StatsSummary>('GET', '/api/stats/summary');
    expect(res.status).toBe(200);
    expect(statsSummarySchema.parse(res.body)).toEqual({
      from: null,
      to: null,
      totals: { seconds: 10_200, sessions: 5, pages: 110, booksFinished: 1 },
      byFormat: [
        { format: 'physical', seconds: 7500, sessions: 4, pages: 110 },
        { format: 'audiobook', seconds: 2700, sessions: 1, pages: 0 },
      ],
      byGenre: [
        { genre: 'Science fiction', seconds: 7500, sessions: 4, pages: 110 },
        { genre: 'History', seconds: 2700, sessions: 1, pages: 0 },
      ],
      byTag: [{ tagId: tag.id, name: 'Favourites', seconds: 7500, sessions: 4, pages: 110 }],
      byAuthor: [
        { author: 'Ursula K. Le Guin', seconds: 7500, sessions: 4, pages: 110 },
        { author: 'Mary Beard', seconds: 2700, sessions: 1, pages: 0 },
      ],
      readingSpeed: [
        {
          format: 'physical',
          sessions: 3,
          seconds: 6300,
          pagesPerHour: 51.43,
          percentPerHour: 12.86,
          listeningRatio: null,
        },
        {
          format: 'audiobook',
          sessions: 1,
          seconds: 2700,
          pagesPerHour: null,
          percentPerHour: 13.33,
          listeningRatio: 1.33,
        },
      ],
    });
    expect(a.id).not.toBe(b.id);
  });

  it('restricts to a local date range', async () => {
    await seed();
    const res = await env.request<StatsSummary>(
      'GET',
      '/api/stats/summary?from=2026-11-13&to=2026-11-13',
    );
    expect(res.body.totals).toEqual({ seconds: 1800, sessions: 1, pages: 40, booksFinished: 0 });
    // Speed uses the 30 days ending at `to`.
    expect(res.body.readingSpeed.map((s) => [s.format, s.sessions])).toEqual([['physical', 2]]);
    const finished = await env.request<StatsSummary>('GET', '/api/stats/summary?from=2026-11-14');
    expect(finished.body.totals.booksFinished).toBe(1);
  });

  it('validates the range', async () => {
    env = createTestEnv();
    expect(
      (await env.request('GET', '/api/stats/summary?from=2026-11-14&to=2026-11-01')).status,
    ).toBe(400);
    expect((await env.request('GET', '/api/stats/summary?from=2026-02-30')).status).toBe(400);
  });
});

describe('GET /api/stats/daily', () => {
  it('returns every day in the range', async () => {
    await seed();
    const res = await env.request<StatsDaily>(
      'GET',
      '/api/stats/daily?from=2026-11-12&to=2026-11-14',
    );
    expect(statsDailySchema.parse(res.body)).toEqual({
      from: '2026-11-12',
      to: '2026-11-14',
      days: [
        { date: '2026-11-12', seconds: 3600, minutes: 60, pages: 40, percent: 10, sessions: 1 },
        { date: '2026-11-13', seconds: 1800, minutes: 30, pages: 40, percent: 10, sessions: 1 },
        { date: '2026-11-14', seconds: 3600, minutes: 60, pages: 10, percent: 12.5, sessions: 2 },
      ],
    });
  });

  it('defaults to the 30 days ending today, or ending `to`', async () => {
    await seed();
    const res = await env.request<StatsDaily>('GET', '/api/stats/daily');
    expect(res.body.from).toBe('2026-10-16');
    expect(res.body.to).toBe('2026-11-14');
    expect(res.body.days).toHaveLength(30);
    const ending = await env.request<StatsDaily>('GET', '/api/stats/daily?to=2026-10-10');
    expect(ending.body.from).toBe('2026-09-11');
    expect(ending.body.days.find((d) => d.date === '2026-10-01')?.seconds).toBe(1200);
  });

  it('buckets by the configured timezone', async () => {
    await seed('Asia/Tokyo');
    const res = await env.request<StatsDaily>(
      'GET',
      '/api/stats/daily?from=2026-11-13&to=2026-11-14',
    );
    // 21:30 UTC on 13/11 is 06:30 on 14/11 in Tokyo, joining the two sessions of 14/11.
    expect(res.body.days.map((d) => [d.date, d.seconds])).toEqual([
      ['2026-11-13', 0],
      ['2026-11-14', 1800 + 2700 + 900],
    ]);
  });

  it('rejects inverted or overlong ranges', async () => {
    env = createTestEnv();
    expect((await env.request('GET', '/api/stats/daily?from=2026-12-01')).status).toBe(400);
    expect(
      (await env.request('GET', '/api/stats/daily?from=2000-01-01&to=2026-11-14')).status,
    ).toBe(400);
  });
});

describe('GET /api/stats/streaks', () => {
  it('computes current and longest streaks', async () => {
    await seed();
    const res = await env.request<StreaksResponse>('GET', '/api/stats/streaks');
    expect(streaksSchema.parse(res.body)).toEqual({
      current: 3,
      longest: 3,
      lastReadDate: '2026-11-14',
      today: '2026-11-14',
    });
  });

  it('is zero with no sessions', async () => {
    env = createTestEnv();
    expect((await env.request('GET', '/api/stats/streaks')).body).toEqual({
      current: 0,
      longest: 0,
      lastReadDate: null,
      today: '2026-11-14',
    });
  });
});

describe('GET /api/stats/year/:year', () => {
  it('summarises the year', async () => {
    const { a } = await seed();
    const res = await env.request<YearInReview>('GET', '/api/stats/year/2026');
    const body = yearInReviewSchema.parse(res.body);
    expect(body.totals).toEqual({
      seconds: 10_200,
      sessions: 5,
      pages: 110,
      booksFinished: 1,
      daysRead: 4,
    });
    expect(body.booksFinished).toEqual([
      {
        bookId: a.id,
        title: 'The Dispossessed',
        authors: ['Ursula K. Le Guin'],
        coverSrc: null,
        finishedAt: '2026-11-14T12:00:00.000Z',
        rating: null,
      },
    ]);
    expect(body.byMonth).toHaveLength(12);
    expect(body.byMonth[9]).toEqual({
      month: '2026-10',
      seconds: 1200,
      sessions: 1,
      pages: 20,
      booksFinished: 0,
    });
    expect(body.byMonth[10]).toEqual({
      month: '2026-11',
      seconds: 9000,
      sessions: 4,
      pages: 90,
      booksFinished: 1,
    });
    expect(body.topAuthors).toEqual([
      { author: 'Ursula K. Le Guin', seconds: 7500 },
      { author: 'Mary Beard', seconds: 2700 },
    ]);
    expect(body.topGenres[0]).toEqual({ genre: 'Science fiction', seconds: 7500 });
    expect(body.longestSession).toMatchObject({ bookId: a.id, seconds: 3600, date: '2026-11-12' });
    expect(body.longestStreak).toBe(3);
  });

  it('handles an empty year and validates the year', async () => {
    env = createTestEnv();
    const res = await env.request<YearInReview>('GET', '/api/stats/year/2020');
    expect(res.body.totals.seconds).toBe(0);
    expect(res.body.longestSession).toBeNull();
    expect(res.body.longestStreak).toBe(0);
    expect((await env.request('GET', '/api/stats/year/20x6')).status).toBe(400);
    expect((await env.request('GET', '/api/stats/year/1066')).status).toBe(400);
  });
});

describe('GET /api/calendar', () => {
  it('lists books read per day, most minutes first', async () => {
    const { a, b } = await seed();
    const res = await env.request<CalendarResponse>('GET', '/api/calendar?month=2026-11');
    expect(calendarSchema.parse(res.body)).toEqual({
      month: '2026-11',
      days: [
        {
          date: '2026-11-12',
          entries: [{ bookId: a.id, title: 'The Dispossessed', coverUrl: null, minutes: 60 }],
        },
        {
          date: '2026-11-13',
          entries: [{ bookId: a.id, title: 'The Dispossessed', coverUrl: null, minutes: 30 }],
        },
        {
          date: '2026-11-14',
          entries: [
            { bookId: b.id, title: 'SPQR', coverUrl: null, minutes: 45 },
            { bookId: a.id, title: 'The Dispossessed', coverUrl: null, minutes: 15 },
          ],
        },
      ],
    });
  });

  it('validates the month', async () => {
    env = createTestEnv();
    expect((await env.request('GET', '/api/calendar')).status).toBe(400);
    expect((await env.request('GET', '/api/calendar?month=2026-13')).status).toBe(400);
    expect(
      (await env.request<CalendarResponse>('GET', '/api/calendar?month=2026-02')).body,
    ).toEqual({
      month: '2026-02',
      days: [],
    });
  });
});
