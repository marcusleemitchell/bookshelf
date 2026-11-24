import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  syncResponseSchema,
  type BookDetail,
  type Session,
  type SyncOp,
  type SyncResponse,
  type TimerResponse,
} from '../../shared/index.ts';
import { createTestEnv, image, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => {
  env.cleanup();
});

const BOOK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FORMAT_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const READ_ID = 'aaaaaaaa-0000-4000-8000-000000000003';
const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000004';
const TAG_ID = 'aaaaaaaa-0000-4000-8000-000000000005';
const NOTE_ID = 'aaaaaaaa-0000-4000-8000-000000000006';
const GOAL_ID = 'aaaaaaaa-0000-4000-8000-000000000007';
const TIMER_ID = 'aaaaaaaa-0000-4000-8000-000000000008';

function bookPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    title: 'Piranesi',
    subtitle: null,
    authors: ['Susanna Clarke'],
    publisher: null,
    publishedDate: null,
    language: null,
    synopsis: null,
    coverUrl: null,
    isbn10: null,
    isbn13: '9781526622426',
    genres: [],
    source: 'manual',
    sourceId: null,
    status: 'reading',
    rating: null,
    ...overrides,
  };
}

const formatPayload = (overrides: Record<string, unknown> = {}) => ({
  id: FORMAT_ID,
  bookId: BOOK_ID,
  format: 'physical',
  pageCount: 272,
  audioDurationSeconds: null,
  isbn: null,
  ...overrides,
});

const readPayload = (overrides: Record<string, unknown> = {}) => ({
  id: READ_ID,
  bookId: BOOK_ID,
  number: 1,
  startedAt: '2026-11-10T08:00:00.000Z',
  finishedAt: null,
  outcome: 'in_progress',
  ...overrides,
});

const sessionPayload = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  readId: READ_ID,
  bookId: BOOK_ID,
  formatId: FORMAT_ID,
  startedAt: '2026-11-10T08:00:00.000Z',
  endedAt: '2026-11-10T08:30:00.000Z',
  durationSeconds: 1800,
  progressUnit: 'pages',
  startValue: 0,
  endValue: 68,
  note: null,
  ...overrides,
});

function op(
  entity: SyncOp['entity'],
  payload: unknown,
  clientUpdatedAt = '2026-11-14T10:00:00.000Z',
  action: SyncOp['action'] = 'upsert',
  opId: string = randomUUID(),
): SyncOp {
  return { opId, entity, action, payload, clientUpdatedAt };
}

async function sync(...ops: SyncOp[]): Promise<SyncResponse['results']> {
  const res = await env.request<SyncResponse>('POST', '/api/sync', { ops });
  expect(res.status).toBe(200);
  return syncResponseSchema.parse(res.body).results;
}

async function seed(): Promise<void> {
  const results = await sync(
    op('book', bookPayload()),
    op('format', formatPayload()),
    op('read', readPayload()),
    op('session', sessionPayload()),
  );
  expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
}

async function getBook(): Promise<BookDetail> {
  return (await env.request<BookDetail>('GET', `/api/books/${BOOK_ID}`)).body;
}

describe('POST /api/sync', () => {
  it('replays an ordered outbox, deriving session percents and using client timestamps', async () => {
    await seed();
    const book = await getBook();
    expect(book).toMatchObject({
      title: 'Piranesi',
      isbn10: '1526622424',
      createdAt: '2026-11-14T10:00:00.000Z',
      updatedAt: '2026-11-14T10:00:00.000Z',
      progressPercent: 25,
    });
    const sessions = await env.request<Session[]>('GET', '/api/sessions');
    expect(sessions.body[0]).toMatchObject({
      startPercent: 0,
      endPercent: 25,
      updatedAt: '2026-11-14T10:00:00.000Z',
    });
  });

  it('replicates a paused book without touching its open read', async () => {
    await seed();
    const [result] = await sync(
      op('book', bookPayload({ status: 'paused' }), '2026-11-14T11:00:00.000Z'),
    );
    expect(result?.status).toBe('applied');
    const book = await getBook();
    expect(book.status).toBe('paused');
    expect(book.currentRead).toMatchObject({ id: READ_ID, outcome: 'in_progress' });
  });

  it('keeps a session’s source when a client omits it, and accepts an unknown duration', async () => {
    await seed();
    const [imported] = await sync(
      op(
        'session',
        sessionPayload({ durationSeconds: null, source: 'bookpine' }),
        '2026-11-14T11:00:00.000Z',
      ),
    );
    expect(imported?.status).toBe('applied');
    // An older client re-sends the record without `source` after adding a duration.
    await sync(op('session', sessionPayload({ durationSeconds: 900 }), '2026-11-14T12:00:00.000Z'));
    const sessions = (await env.request<Session[]>('GET', '/api/sessions')).body;
    expect(sessions[0]).toMatchObject({ durationSeconds: 900, source: 'bookpine' });
  });

  it('is idempotent by opId', async () => {
    const first = op('book', bookPayload());
    expect(await sync(first)).toEqual([{ opId: first.opId, status: 'applied', duplicate: false }]);
    const replay = {
      ...first,
      payload: bookPayload({ title: 'Changed' }),
      clientUpdatedAt: '2026-11-14T11:00:00.000Z',
    };
    expect(await sync(replay)).toEqual([{ opId: first.opId, status: 'applied', duplicate: true }]);
    expect((await getBook()).title).toBe('Piranesi');
    const count = env.ctx.db.prepare('SELECT COUNT(*) AS n FROM sync_ops').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('resolves conflicts last-write-wins on updatedAt', async () => {
    await sync(op('book', bookPayload({ title: 'Newer' }), '2026-11-14T10:00:00.000Z'));
    const stale = await sync(
      op('book', bookPayload({ title: 'Older' }), '2026-11-14T09:00:00.000Z'),
    );
    expect(stale[0]?.status).toBe('stale');
    expect((await getBook()).title).toBe('Newer');

    const tie = await sync(op('book', bookPayload({ title: 'Tie' }), '2026-11-14T10:00:00.000Z'));
    expect(tie[0]?.status).toBe('applied');
    const newer = await sync(op('book', bookPayload({ title: 'Newest' }), '2026-11-14T10:00:01Z'));
    expect(newer[0]?.status).toBe('applied');
    expect((await getBook()).updatedAt).toBe('2026-11-14T10:00:01.000Z');

    // A REST edit stamps server time (12:00), which beats an older offline edit.
    await env.request('PATCH', `/api/books/${BOOK_ID}`, { rating: 5 });
    expect(
      (await sync(op('book', bookPayload({ title: 'Offline' }), '2026-11-14T11:00:00.000Z')))[0]
        ?.status,
    ).toBe('stale');
  });

  it('records stale ops so replays stay stale', async () => {
    await sync(op('book', bookPayload(), '2026-11-14T10:00:00.000Z'));
    const old = op('book', bookPayload({ title: 'Old' }), '2026-11-14T09:00:00.000Z');
    expect((await sync(old))[0]).toMatchObject({ status: 'stale', duplicate: false });
    expect((await sync(old))[0]).toMatchObject({ status: 'stale', duplicate: true });
  });

  it('soft-deletes with LWW and lets a newer upsert resurrect', async () => {
    await seed();
    const deleted = await sync(op('book', { id: BOOK_ID }, '2026-11-14T10:30:00.000Z', 'delete'));
    expect(deleted[0]?.status).toBe('applied');
    expect((await env.request('GET', `/api/books/${BOOK_ID}`)).status).toBe(404);
    expect((await env.request<Session[]>('GET', '/api/sessions')).body).toEqual([]);

    expect((await sync(op('book', bookPayload(), '2026-11-14T10:15:00.000Z')))[0]?.status).toBe(
      'stale',
    );
    expect((await sync(op('book', bookPayload(), '2026-11-14T10:45:00.000Z')))[0]?.status).toBe(
      'applied',
    );
    expect((await getBook()).deletedAt).toBeNull();
  });

  it('rejects stale and no-op deletes appropriately', async () => {
    await seed();
    expect(
      (await sync(op('session', { id: SESSION_ID }, '2026-11-14T09:00:00.000Z', 'delete')))[0]
        ?.status,
    ).toBe('stale');
    expect((await sync(op('session', { id: randomUUID() }, undefined, 'delete')))[0]?.status).toBe(
      'applied',
    );
    expect(
      (await sync(op('session', { id: SESSION_ID }, '2026-11-14T10:10:00.000Z', 'delete')))[0]
        ?.status,
    ).toBe('applied');
    // Deleting an already-deleted row is a no-op.
    expect(
      (await sync(op('session', { id: SESSION_ID }, '2026-11-14T10:20:00.000Z', 'delete')))[0]
        ?.status,
    ).toBe('applied');
    expect((await sync(op('session', { nope: true }, undefined, 'delete')))[0]?.error?.code).toBe(
      'validation_error',
    );
  });

  it('deletes every entity type', async () => {
    await seed();
    await sync(
      op('tag', { id: TAG_ID, name: 'Fantasy', colour: null }),
      op('note', {
        id: NOTE_ID,
        bookId: BOOK_ID,
        kind: 'quote',
        text: 'The Beauty of the House is immeasurable',
        location: null,
      }),
      op('goal', { id: GOAL_ID, kind: 'books_per_year', year: 2026, target: 20 }),
      op('book', bookPayload({ tagIds: [TAG_ID] }), '2026-11-14T10:01:00.000Z'),
    );
    const at = '2026-11-14T11:00:00.000Z';
    const results = await sync(
      op('note', { id: NOTE_ID }, at, 'delete'),
      op('goal', { id: GOAL_ID }, at, 'delete'),
      op('tag', { id: TAG_ID }, at, 'delete'),
      op('session', { id: SESSION_ID }, at, 'delete'),
      op('read', { id: READ_ID }, at, 'delete'),
      op('format', { id: FORMAT_ID }, at, 'delete'),
    );
    expect(results.every((r) => r.status === 'applied')).toBe(true);
    const book = await getBook();
    expect(book.tagIds).toEqual([]);
    expect(book.formats).toEqual([]);
    expect(book.reads).toEqual([]);
    expect((await env.request('GET', '/api/goals')).body).toEqual([]);
    expect((await env.request('GET', '/api/tags')).body).toEqual([]);
    expect((await env.request('GET', `/api/books/${BOOK_ID}/notes`)).body).toEqual([]);
  });

  it('reports reference errors without recording them, so the op can be retried', async () => {
    await sync(op('book', bookPayload()), op('format', formatPayload()));
    const sessionOp = op('session', sessionPayload());
    const failed = await sync(sessionOp);
    expect(failed[0]).toMatchObject({
      status: 'error',
      duplicate: false,
      error: { code: 'not_found' },
    });
    expect(failed[0]?.error?.message).toContain('readId');

    await sync(op('read', readPayload()));
    expect(await sync(sessionOp)).toEqual([
      { opId: sessionOp.opId, status: 'applied', duplicate: false },
    ]);
  });

  it('validates payloads and cross-record rules', async () => {
    await seed();
    const other = { ...bookPayload({ id: randomUUID(), title: 'Other' }) };
    await sync(op('book', other));
    const results = await sync(
      op('book', { id: BOOK_ID }),
      op('format', formatPayload({ format: 'audiobook' })),
      op('format', formatPayload({ bookId: other.id })),
      op('format', formatPayload({ id: randomUUID(), bookId: randomUUID() })),
      op('read', readPayload({ bookId: other.id })),
      op('session', sessionPayload({ progressUnit: 'audio_seconds' })),
      op('session', sessionPayload({ readId: READ_ID, bookId: other.id })),
      op('note', { id: NOTE_ID, bookId: randomUUID(), kind: 'note', text: 'x', location: null }),
      op('goal', { id: GOAL_ID, kind: 'minutes_per_day', year: 2026, target: 20 }),
    );
    expect(results.map((r) => r.error?.code)).toEqual([
      'validation_error',
      'validation_error',
      'validation_error',
      'not_found',
      'validation_error',
      'validation_error',
      'validation_error',
      'not_found',
      'validation_error',
    ]);
    expect(results.every((r) => r.status === 'error')).toBe(true);
  });

  it('enforces unique tag names and goal periods', async () => {
    await sync(
      op('tag', { id: TAG_ID, name: 'Fantasy', colour: '#aa00ff' }),
      op('goal', { id: GOAL_ID, kind: 'minutes_per_day', year: null, target: 20 }),
    );
    const results = await sync(
      op('tag', { id: randomUUID(), name: 'FANTASY', colour: null }),
      op('goal', { id: randomUUID(), kind: 'minutes_per_day', year: null, target: 30 }),
      op('tag', { id: TAG_ID, name: 'Fantasy & myth', colour: null }, '2026-11-14T10:01:00.000Z'),
    );
    expect(results.map((r) => (r.status === 'error' ? r.error?.code : r.status))).toEqual([
      'conflict',
      'conflict',
      'applied',
    ]);
  });

  it('re-derives session percents when a synced format length changes', async () => {
    await seed();
    await sync(op('format', formatPayload({ pageCount: 136 }), '2026-11-14T10:05:00.000Z'));
    const sessions = await env.request<Session[]>('GET', '/api/sessions');
    expect(sessions.body[0]).toMatchObject({
      endPercent: 50,
      updatedAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('syncs book tags, ignoring unknown tag IDs', async () => {
    await sync(op('tag', { id: TAG_ID, name: 'Fantasy', colour: null }));
    await sync(op('book', bookPayload({ tagIds: [TAG_ID, randomUUID()] })));
    expect((await getBook()).tagIds).toEqual([TAG_ID]);
    // Omitting tagIds leaves links untouched.
    await sync(op('book', bookPayload({ title: 'Piranesi (PB)' }), '2026-11-14T10:01:00.000Z'));
    expect((await getBook()).tagIds).toEqual([TAG_ID]);
  });

  it('caches the cover of a synced new book; later ops leave the catalogue alone', async () => {
    env.fetchMock.on('https://covers.example.org/', () => image());
    await sync(op('book', bookPayload({ coverUrl: 'https://covers.example.org/p.png' })));
    expect((await getBook()).coverPath).toBe(`${BOOK_ID}.png`);
    // The book exists now: catalogue fields in later ops are ignored (edited online only),
    // while the member's rating is applied.
    await sync(
      op(
        'book',
        bookPayload({ coverUrl: null, title: 'Renamed offline', rating: 4 }),
        '2026-11-14T10:01:00.000Z',
      ),
    );
    const book = await getBook();
    expect(book).toMatchObject({ coverPath: `${BOOK_ID}.png`, title: 'Piranesi', rating: 4 });
    expect(env.fetchMock.calls).toHaveLength(1);
  });

  it('resolves book ops against the member’s shelf entry, not the shared catalogue', async () => {
    await seed();
    const jo = env.addMember({ name: 'Jo' });
    const joSync = async (...ops: SyncOp[]) =>
      syncResponseSchema
        .parse((await jo.request<SyncResponse>('POST', '/api/sync', { ops })).body)
        .results.map((r) => r.error?.code ?? r.status);
    // Jo puts the existing catalogue book on her shelf at 10:05.
    expect(
      await joSync(op('book', bookPayload({ status: 'to_read' }), '2026-11-14T10:05:00.000Z')),
    ).toEqual(['applied']);
    // The owner edits the catalogue later (12:00, the test clock).
    expect(
      (await env.request('PATCH', `/api/books/${BOOK_ID}`, { subtitle: 'A Novel' })).status,
    ).toBe(200);
    // Jo's 11:00 change is newer than her shelf entry, so it applies despite the newer catalogue row…
    expect(
      await joSync(op('book', bookPayload({ rating: 5 }), '2026-11-14T11:00:00.000Z')),
    ).toEqual(['applied']);
    // …and one older than her shelf entry is stale.
    expect(
      await joSync(op('book', bookPayload({ rating: 1 }), '2026-11-14T10:30:00.000Z')),
    ).toEqual(['stale']);
    const joBook = (await jo.request<BookDetail>('GET', `/api/books/${BOOK_ID}`)).body;
    expect(joBook).toMatchObject({ subtitle: 'A Novel', status: 'reading', rating: 5 });
    expect((await getBook()).rating).toBeNull();
    // Removing it from Jo's shelf is last-write-wins against her entry too.
    expect(await joSync(op('book', { id: BOOK_ID }, '2026-11-14T10:59:00.000Z', 'delete'))).toEqual(
      ['stale'],
    );
    expect(await joSync(op('book', { id: BOOK_ID }, '2026-11-14T11:01:00.000Z', 'delete'))).toEqual(
      ['applied'],
    );
    expect((await jo.request('GET', `/api/books/${BOOK_ID}`)).status).toBe(404);
    expect((await env.request('GET', `/api/books/${BOOK_ID}`)).status).toBe(200);
    // A deleted catalogue book comes back when a member puts it on their shelf again.
    await sync(op('book', { id: BOOK_ID }, '2026-11-14T12:30:00.000Z', 'delete'));
    expect((await env.request('GET', `/api/books/${BOOK_ID}`)).status).toBe(404);
    expect(await joSync(op('book', bookPayload(), '2026-11-14T13:00:00.000Z'))).toEqual([
      'applied',
    ]);
    expect(
      (await jo.request<BookDetail>('GET', `/api/books/${BOOK_ID}`)).body.deletedAt,
    ).toBeNull();
  });

  it('syncs the timer with last-write-wins and deletes it', async () => {
    await seed();
    const timer = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      bookId: BOOK_ID,
      formatId: FORMAT_ID,
      startedAt: '2026-11-14T09:00:00.000Z',
      resumedAt: '2026-11-14T09:00:00.000Z',
      pausedAt: null,
      accumulatedSeconds: 0,
      ...overrides,
    });
    expect((await sync(op('timer', timer(TIMER_ID))))[0]?.status).toBe('applied');
    let state = (await env.request<TimerResponse>('GET', '/api/timer')).body;
    expect(state.timer?.id).toBe(TIMER_ID);
    expect(state.elapsedSeconds).toBe(3 * 3600);

    // Same timer, paused later.
    await sync(
      op(
        'timer',
        timer(TIMER_ID, { pausedAt: '2026-11-14T09:30:00.000Z', accumulatedSeconds: 1800 }),
        '2026-11-14T10:01:00.000Z',
      ),
    );
    state = (await env.request<TimerResponse>('GET', '/api/timer')).body;
    expect(state.timer?.createdAt).toBe('2026-11-14T10:00:00.000Z');
    expect(state.elapsedSeconds).toBe(1800);

    // A different, older timer loses; a newer one replaces it.
    const otherId = randomUUID();
    expect((await sync(op('timer', timer(otherId), '2026-11-14T09:59:00.000Z')))[0]?.status).toBe(
      'stale',
    );
    expect((await sync(op('timer', timer(otherId), '2026-11-14T10:02:00.000Z')))[0]?.status).toBe(
      'applied',
    );
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.timer?.id).toBe(otherId);

    // Deleting a timer that is not the active one is a no-op; stale deletes are ignored.
    expect((await sync(op('timer', { id: TIMER_ID }, undefined, 'delete')))[0]?.status).toBe(
      'applied',
    );
    expect(
      (await sync(op('timer', { id: otherId }, '2026-11-14T10:00:00.000Z', 'delete')))[0]?.status,
    ).toBe('stale');
    expect(
      (await sync(op('timer', { id: otherId }, '2026-11-14T10:03:00.000Z', 'delete')))[0]?.status,
    ).toBe('applied');
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.timer).toBeNull();

    const results = await sync(
      op('timer', timer(TIMER_ID, { formatId: randomUUID() })),
      op('timer', timer(TIMER_ID, { bookId: randomUUID() })),
    );
    expect(results.map((r) => r.error?.code)).toEqual(['not_found', 'not_found']);
  });

  it('removes a timer when its format is deleted via sync', async () => {
    await seed();
    await env.request('PUT', '/api/timer', {
      action: 'start',
      bookId: BOOK_ID,
      formatId: FORMAT_ID,
    });
    await sync(op('format', { id: FORMAT_ID }, '2026-11-14T10:10:00.000Z', 'delete'));
    expect((await env.request<TimerResponse>('GET', '/api/timer')).body.timer).toBeNull();
  });

  it('rejects a malformed request', async () => {
    expect((await env.request('POST', '/api/sync', { ops: [{ opId: 'x' }] })).status).toBe(400);
    expect((await env.request('POST', '/api/sync', {})).status).toBe(400);
  });

  it('rejects a timer whose format belongs to another book', async () => {
    await seed();
    const other = bookPayload({ id: randomUUID(), title: 'Other' });
    const otherFormat = formatPayload({ id: randomUUID(), bookId: other.id });
    await sync(op('book', other), op('format', otherFormat));
    const results = await sync(
      op('timer', {
        id: TIMER_ID,
        bookId: BOOK_ID,
        formatId: otherFormat.id,
        startedAt: '2026-11-14T09:00:00.000Z',
        resumedAt: '2026-11-14T09:00:00.000Z',
        pausedAt: null,
        accumulatedSeconds: 0,
      }),
    );
    expect(results[0]?.error?.code).toBe('validation_error');
  });

  it('reports database constraint violations and unexpected failures per op', async () => {
    env.ctx.db.exec(
      "CREATE TRIGGER block_tags BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    env.ctx.db.exec('CREATE TABLE doomed (id INTEGER)');
    env.ctx.db.exec(
      'CREATE TRIGGER broken_goals AFTER INSERT ON goals BEGIN INSERT INTO doomed VALUES (1); END',
    );
    env.ctx.db.exec('DROP TABLE doomed');
    const results = await sync(
      op('tag', { id: TAG_ID, name: 'Blocked', colour: null }),
      op('goal', { id: GOAL_ID, kind: 'minutes_per_day', year: null, target: 10 }),
    );
    expect(results[0]).toMatchObject({ status: 'error', error: { code: 'conflict' } });
    expect(results[1]).toMatchObject({
      status: 'error',
      error: { code: 'internal_error', message: 'Unexpected error while applying the op' },
    });
    expect(env.logs.some((l) => l['msg'] === 'Sync op failed unexpectedly')).toBe(true);
  });
});
