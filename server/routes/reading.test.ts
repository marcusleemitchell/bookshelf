import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  errorResponseSchema,
  sessionSchema,
  timerResponseSchema,
  type BookDetail,
  type GoalWithProgress,
  type Read,
  type Session,
  type Tag,
  type TimerResponse,
} from '../../shared/index.ts';
import { createTestEnv, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => {
  env.cleanup();
});

function expectError(res: { status: number; body: unknown }, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(errorResponseSchema.parse(res.body).error.code).toBe(code);
}

async function addBook(body: Record<string, unknown> = {}): Promise<BookDetail> {
  const res = await env.request<BookDetail>('POST', '/api/books', {
    title: 'The Left Hand of Darkness',
    formats: [
      { format: 'physical', pageCount: 400 },
      { format: 'audiobook', audioDurationSeconds: 36_000 },
      { format: 'kindle' },
    ],
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body;
}

function formatId(book: BookDetail, format: string): string {
  const found = book.formats.find((f) => f.format === format);
  if (!found) throw new Error(`No ${format} format`);
  return found.id;
}

async function logSession(body: Record<string, unknown>) {
  return env.request<Session>('POST', '/api/sessions', {
    startedAt: '2026-11-14T09:00:00Z',
    endedAt: '2026-11-14T10:00:00Z',
    ...body,
  });
}

describe('POST /api/sessions', () => {
  it('logs a page session, opens a read and moves the book to reading', async () => {
    const book = await addBook();
    const res = await logSession({
      bookId: book.id,
      formatId: formatId(book, 'physical'),
      progressUnit: 'pages',
      startValue: 0,
      endValue: 100,
      note: 'Great opening',
    });
    expect(res.status).toBe(201);
    expect(sessionSchema.parse(res.body)).toMatchObject({
      durationSeconds: 3600,
      startPercent: 0,
      endPercent: 25,
      note: 'Great opening',
    });
    const detail = await env.request<BookDetail>('GET', `/api/books/${book.id}`);
    expect(detail.body.status).toBe('reading');
    expect(detail.body.currentRead?.id).toBe(res.body.readId);
    expect(detail.body.progressPercent).toBe(25);
    // 25 points in the 14-day window ⇒ 25/14 per day ⇒ 42 days for the remaining 75.
    expect(detail.body.estimatedFinish).toEqual({
      percentPerDay: 1.79,
      daysRemaining: 42,
      date: '2026-12-26',
    });
  });

  it('defaults the start value to the current progress in the new unit', async () => {
    const book = await addBook();
    const first = await logSession({
      bookId: book.id,
      formatId: formatId(book, 'physical'),
      progressUnit: 'pages',
      startValue: 0,
      endValue: 100,
    });
    const audio = await logSession({
      bookId: book.id,
      formatId: formatId(book, 'audiobook'),
      startedAt: '2026-11-14T11:00:00Z',
      endedAt: '2026-11-14T11:30:00Z',
      progressUnit: 'audio_seconds',
      endValue: 18_000,
    });
    expect(audio.body).toMatchObject({
      readId: first.body.readId,
      startValue: 9000,
      startPercent: 25,
      endPercent: 50,
      durationSeconds: 1800,
    });
  });

  it('defaults the start value to 0 when progress is unknown, and keeps null percents', async () => {
    const book = await addBook();
    const res = await logSession({
      bookId: book.id,
      formatId: formatId(book, 'kindle'),
      progressUnit: 'pages',
      endValue: 50,
    });
    expect(res.body).toMatchObject({ startValue: 0, startPercent: null, endPercent: null });
  });

  it('honours an explicit duration (pauses) and an explicit read', async () => {
    const book = await addBook({ status: 'finished' });
    const reread = await env.request<Read>('POST', `/api/books/${book.id}/reads`);
    const res = await logSession({
      bookId: book.id,
      formatId: formatId(book, 'kindle'),
      readId: book.reads[0]?.id,
      progressUnit: 'percent',
      startValue: 10,
      endValue: 20,
      durationSeconds: 1200,
    });
    expect(res.body.durationSeconds).toBe(1200);
    expect(res.body.readId).toBe(book.reads[0]?.id);
    expect(res.body.readId).not.toBe(reread.body.id);
  });

  it('rejects invalid sessions', async () => {
    const book = await addBook();
    const other = await addBook({ title: 'Other' });
    const physical = formatId(book, 'physical');
    const base = { bookId: book.id, formatId: physical, progressUnit: 'pages', endValue: 10 };
    expectError(
      await logSession({ ...base, bookId: '00000000-0000-4000-8000-000000000000' }),
      400,
      'validation_error',
    );
    expectError(
      await logSession({ ...base, formatId: '00000000-0000-4000-8000-000000000000' }),
      400,
      'validation_error',
    );
    expectError(
      await logSession({ ...base, formatId: formatId(other, 'physical') }),
      400,
      'validation_error',
    );
    expectError(
      await logSession({ ...base, progressUnit: 'audio_seconds' }),
      400,
      'validation_error',
    );
    expectError(
      await logSession({ ...base, formatId: formatId(book, 'audiobook') }),
      400,
      'validation_error',
    );
    expectError(
      await logSession({ ...base, endedAt: '2026-11-14T08:00:00Z' }),
      400,
      'validation_error',
    );
    expectError(await logSession({ ...base, readId: other.id }), 400, 'validation_error');
    const ok = await logSession(base);
    expectError(await logSession({ ...base, id: ok.body.id }), 409, 'conflict');
  });
});

describe('PATCH/DELETE /api/sessions/:id', () => {
  it('updates fields, re-derives percents and soft-deletes', async () => {
    const book = await addBook();
    const created = await logSession({
      bookId: book.id,
      formatId: formatId(book, 'physical'),
      progressUnit: 'pages',
      startValue: 0,
      endValue: 100,
    });
    env.clock.advance(5000);
    const updated = await env.request<Session>('PATCH', `/api/sessions/${created.body.id}`, {
      formatId: formatId(book, 'kindle'),
      progressUnit: 'percent',
      startValue: 10,
      endValue: 30,
      note: null,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      progressUnit: 'percent',
      startPercent: 10,
      endPercent: 30,
      updatedAt: '2026-11-14T12:00:05.000Z',
    });
    expectError(
      await env.request('PATCH', `/api/sessions/${created.body.id}`, {
        formatId: '00000000-0000-4000-8000-000000000000',
      }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('PATCH', `/api/sessions/${created.body.id}`, {
        endedAt: '2026-11-13T00:00:00Z',
      }),
      400,
      'validation_error',
    );
    expect((await env.request('DELETE', `/api/sessions/${created.body.id}`)).status).toBe(204);
    expectError(await env.request('DELETE', `/api/sessions/${created.body.id}`), 404, 'not_found');
    expectError(
      await env.request('PATCH', `/api/sessions/${created.body.id}`, { note: 'x' }),
      404,
      'not_found',
    );
  });
});

describe('GET /api/sessions', () => {
  it('filters by book and local date range (Europe/London)', async () => {
    const a = await addBook();
    const b = await addBook({ title: 'B' });
    const make = (book: BookDetail, startedAt: string, endedAt: string) =>
      logSession({
        bookId: book.id,
        formatId: formatId(book, 'kindle'),
        progressUnit: 'percent',
        endValue: 5,
        startedAt,
        endedAt,
      });
    // 23:30 UTC on 31/10 is 31/10 locally (GMT after the clocks change on 25/10).
    await make(a, '2026-10-31T23:30:00Z', '2026-10-31T23:50:00Z');
    await make(a, '2026-11-01T09:00:00Z', '2026-11-01T09:30:00Z');
    await make(b, '2026-11-02T09:00:00Z', '2026-11-02T09:30:00Z');

    const all = await env.request<Session[]>('GET', '/api/sessions');
    expect(all.body.map((s) => s.startedAt)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-01T09:00:00.000Z',
      '2026-10-31T23:30:00.000Z',
    ]);
    const byBook = await env.request<Session[]>('GET', `/api/sessions?bookId=${a.id}`);
    expect(byBook.body).toHaveLength(2);
    const november = await env.request<Session[]>(
      'GET',
      '/api/sessions?from=2026-11-01&to=2026-11-01',
    );
    expect(november.body.map((s) => s.startedAt)).toEqual(['2026-11-01T09:00:00.000Z']);
    expectError(await env.request('GET', '/api/sessions?from=01/11/2026'), 400, 'validation_error');
  });
});

describe('timer', () => {
  it('starts, pauses, resumes and discards', async () => {
    const book = await addBook();
    const kindle = formatId(book, 'kindle');
    const empty = await env.request<TimerResponse>('GET', '/api/timer');
    expect(empty.body).toEqual({
      timer: null,
      elapsedSeconds: 0,
      serverTime: '2026-11-14T12:00:00.000Z',
    });

    const started = await env.request<TimerResponse>('PUT', '/api/timer', {
      action: 'start',
      bookId: book.id,
      formatId: kindle,
    });
    expect(timerResponseSchema.parse(started.body).timer).toMatchObject({
      bookId: book.id,
      formatId: kindle,
      startedAt: '2026-11-14T12:00:00.000Z',
      pausedAt: null,
      accumulatedSeconds: 0,
    });

    env.clock.advance(600_000);
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.elapsedSeconds).toBe(600);

    const paused = await env.request<TimerResponse>('PUT', '/api/timer', { action: 'pause' });
    expect(paused.body.timer?.accumulatedSeconds).toBe(600);
    env.clock.advance(300_000);
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.elapsedSeconds).toBe(600);

    const resumed = await env.request<TimerResponse>('PUT', '/api/timer', { action: 'resume' });
    expect(resumed.body.timer?.pausedAt).toBeNull();
    env.clock.advance(60_000);
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.elapsedSeconds).toBe(660);

    expect((await env.request('DELETE', '/api/timer')).status).toBe(204);
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.timer).toBeNull();
  });

  it('accepts client action times', async () => {
    const book = await addBook();
    await env.request('PUT', '/api/timer', {
      action: 'start',
      bookId: book.id,
      formatId: formatId(book, 'kindle'),
      at: '2026-11-14T11:00:00Z',
    });
    const paused = await env.request<TimerResponse>('PUT', '/api/timer', {
      action: 'pause',
      at: '2026-11-14T11:30:00Z',
    });
    expect(paused.body.elapsedSeconds).toBe(1800);
    expectError(
      await env.request('PUT', '/api/timer', { action: 'resume', at: '2026-11-14T11:00:00Z' }),
      400,
      'validation_error',
    );
  });

  it('rejects invalid transitions', async () => {
    const book = await addBook();
    const other = await addBook({ title: 'Other' });
    expectError(await env.request('PUT', '/api/timer', { action: 'pause' }), 404, 'not_found');
    expectError(await env.request('PUT', '/api/timer', { action: 'resume' }), 404, 'not_found');
    expectError(await env.request('DELETE', '/api/timer'), 404, 'not_found');
    expectError(
      await env.request('PUT', '/api/timer', {
        action: 'start',
        bookId: '00000000-0000-4000-8000-000000000000',
        formatId: formatId(book, 'kindle'),
      }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('PUT', '/api/timer', {
        action: 'start',
        bookId: book.id,
        formatId: formatId(other, 'kindle'),
      }),
      400,
      'validation_error',
    );
    await env.request('PUT', '/api/timer', {
      action: 'start',
      bookId: book.id,
      formatId: formatId(book, 'kindle'),
    });
    expectError(
      await env.request('PUT', '/api/timer', {
        action: 'start',
        bookId: book.id,
        formatId: formatId(book, 'kindle'),
      }),
      409,
      'conflict',
    );
    expectError(await env.request('PUT', '/api/timer', { action: 'resume' }), 409, 'conflict');
    await env.request('PUT', '/api/timer', { action: 'pause' });
    expectError(await env.request('PUT', '/api/timer', { action: 'pause' }), 409, 'conflict');
    expectError(
      await env.request('PUT', '/api/timer', { action: 'stop' }),
      400,
      'validation_error',
    );
  });
});

describe('tags', () => {
  it('creates, lists, renames and deletes tags with case-insensitive uniqueness', async () => {
    const created = await env.request<Tag>('POST', '/api/tags', {
      name: 'Sci-fi',
      colour: '#3366ff',
    });
    expect(created.status).toBe(201);
    await env.request('POST', '/api/tags', { name: 'classics' });
    expectError(await env.request('POST', '/api/tags', { name: 'SCI-FI' }), 409, 'conflict');
    expectError(
      await env.request('POST', '/api/tags', { id: created.body.id, name: 'New' }),
      409,
      'conflict',
    );
    expectError(
      await env.request('POST', '/api/tags', { name: 'Bad', colour: 'blue' }),
      400,
      'validation_error',
    );

    const list = await env.request<Tag[]>('GET', '/api/tags');
    expect(list.body.map((t) => t.name)).toEqual(['classics', 'Sci-fi']);

    expectError(
      await env.request('PATCH', `/api/tags/${created.body.id}`, { name: 'Classics' }),
      409,
      'conflict',
    );
    const renamed = await env.request<Tag>('PATCH', `/api/tags/${created.body.id}`, {
      name: 'Science fiction',
    });
    expect(renamed.body.name).toBe('Science fiction');
    const sameName = await env.request<Tag>('PATCH', `/api/tags/${created.body.id}`, {
      name: 'SCIENCE fiction',
    });
    expect(sameName.status).toBe(200);

    expect((await env.request('DELETE', `/api/tags/${created.body.id}`)).status).toBe(204);
    expectError(await env.request('DELETE', `/api/tags/${created.body.id}`), 404, 'not_found');
    expectError(
      await env.request('PATCH', `/api/tags/${created.body.id}`, { name: 'x' }),
      404,
      'not_found',
    );
    // A deleted tag's name can be reused.
    expect((await env.request('POST', '/api/tags', { name: 'science FICTION' })).status).toBe(201);
  });
});

describe('goals', () => {
  it('upserts goals with progress and enforces one goal per kind and period', async () => {
    const book = await addBook();
    await logSession({
      bookId: book.id,
      formatId: formatId(book, 'physical'),
      startedAt: '2026-11-14T08:00:00Z',
      endedAt: '2026-11-14T08:45:00Z',
      progressUnit: 'pages',
      startValue: 0,
      endValue: 40,
    });
    await env.request('PATCH', `/api/books/${book.id}`, { status: 'finished' });

    const ids = {
      books: '11111111-1111-4111-8111-111111111111',
      pages: '22222222-2222-4222-8222-222222222222',
      minutes: '33333333-3333-4333-8333-333333333333',
    };
    const books = await env.request<GoalWithProgress>('PUT', `/api/goals/${ids.books}`, {
      kind: 'books_per_year',
      year: 2026,
      target: 30,
    });
    expect(books.status).toBe(201);
    expect(books.body.current).toBe(1);
    const pages = await env.request<GoalWithProgress>('PUT', `/api/goals/${ids.pages}`, {
      kind: 'pages_per_year',
      year: 2026,
      target: 10_000,
    });
    expect(pages.body.current).toBe(40);
    const minutes = await env.request<GoalWithProgress>('PUT', `/api/goals/${ids.minutes}`, {
      kind: 'minutes_per_day',
      target: 30,
    });
    expect(minutes.body.current).toBe(45);

    env.clock.advance(1000);
    const updated = await env.request<GoalWithProgress>('PUT', `/api/goals/${ids.books}`, {
      kind: 'books_per_year',
      year: 2026,
      target: 40,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      target: 40,
      createdAt: '2026-11-14T12:00:00.000Z',
      updatedAt: '2026-11-14T12:00:01.000Z',
    });

    expectError(
      await env.request('PUT', '/api/goals/44444444-4444-4444-8444-444444444444', {
        kind: 'books_per_year',
        year: 2026,
        target: 5,
      }),
      409,
      'conflict',
    );
    expectError(
      await env.request('PUT', '/api/goals/44444444-4444-4444-8444-444444444444', {
        kind: 'minutes_per_day',
        target: 5,
      }),
      409,
      'conflict',
    );
    expectError(
      await env.request('PUT', `/api/goals/${ids.books}`, { kind: 'books_per_year', target: 5 }),
      400,
      'validation_error',
    );

    const list = await env.request<GoalWithProgress[]>('GET', '/api/goals');
    expect(list.body.map((g) => g.kind)).toEqual([
      'books_per_year',
      'minutes_per_day',
      'pages_per_year',
    ]);

    expect((await env.request('DELETE', `/api/goals/${ids.books}`)).status).toBe(204);
    expectError(await env.request('DELETE', `/api/goals/${ids.books}`), 404, 'not_found');
    // Re-creating a deleted goal id counts as a create.
    const recreated = await env.request('PUT', `/api/goals/${ids.books}`, {
      kind: 'books_per_year',
      year: 2027,
      target: 12,
    });
    expect(recreated.status).toBe(201);
  });
});
