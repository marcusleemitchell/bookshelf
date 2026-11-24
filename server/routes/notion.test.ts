import { afterEach, describe, expect, it } from 'vitest';
import {
  notionRunResultSchema,
  notionStatusSchema,
  type BookDetail,
  type NotionRunResult,
  type NotionStatus,
} from '../../shared/index.ts';
import {
  createNotionClient,
  createNotionMirror,
  MIN_REQUEST_INTERVAL_MS,
  NOTION_VERSION,
  NotionApiError,
  retryAfterMs,
} from '../services/notion.ts';
import { installFakeNotion, type FakeNotion } from '../test/fixtures/notion.ts';
import { createTestEnv, json, type TestEnv } from '../test/helpers.ts';

const TOKEN = 'ntn_test_secret_token_value';
const PARENT_ID = '01234567-89ab-cdef-0123-456789abcdef';

let env: TestEnv;
let fake: FakeNotion;

afterEach(() => {
  env.cleanup();
});

function setup(parentPageId = PARENT_ID) {
  env = createTestEnv({ notion: { token: TOKEN, parentPageId } });
  fake = installFakeNotion(env.fetchMock);
}

async function seed() {
  const tag = (await env.request<{ id: string }>('POST', '/api/tags', { name: 'Gothic, horror' }))
    .body;
  const book = (
    await env.request<BookDetail>('POST', '/api/books', {
      title: 'Mexican Gothic',
      authors: ['Silvia Moreno-Garcia'],
      genres: ['Horror', 'Fiction, gothic'],
      isbn13: '9780525620785',
      tagIds: [tag.id],
      formats: [{ format: 'kindle' }, { format: 'physical', pageCount: 320 }],
      status: 'reading',
    })
  ).body;
  const kindle = book.formats.find((f) => f.format === 'kindle')?.id as string;
  const session = (
    await env.request<{ id: string }>('POST', '/api/sessions', {
      bookId: book.id,
      formatId: kindle,
      startedAt: '2026-11-13T20:00:00Z',
      endedAt: '2026-11-13T20:40:00Z',
      progressUnit: 'percent',
      startValue: 0,
      endValue: 12.5,
      note: 'High Place',
    })
  ).body;
  const note = (
    await env.request<{ id: string }>('POST', `/api/books/${book.id}/notes`, {
      kind: 'quote',
      text: 'x'.repeat(4500),
      location: '12%',
    })
  ).body;
  return { book, session, note };
}

async function run() {
  return env.request<NotionRunResult>('POST', '/api/backup/notion');
}

describe('Notion mirror', () => {
  it('reports "not configured" gracefully when env vars are absent', async () => {
    env = createTestEnv();
    const status = await env.request<NotionStatus>('GET', '/api/backup/notion/status');
    expect(notionStatusSchema.parse(status.body)).toEqual({
      configured: false,
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastResult: null,
    });
    const res = await env.request<{ error: { code: string } }>('POST', '/api/backup/notion');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('notion_not_configured');
    expect(env.fetchMock.calls).toEqual([]);
  });

  it('creates the three databases on first run and mirrors every row', async () => {
    setup();
    const { book, session } = await seed();
    const res = await run();
    expect(res.status).toBe(200);
    expect(notionRunResultSchema.parse(res.body)).toMatchObject({
      books: { created: 1, updated: 0, archived: 0, unchanged: 0 },
      sessions: { created: 1, updated: 0, archived: 0, unchanged: 0 },
      notes: { created: 1, updated: 0, archived: 0, unchanged: 0 },
    });

    const books = fake.databaseByTitle('Bookshelf Books');
    const sessions = fake.databaseByTitle('Bookshelf Sessions');
    const notes = fake.databaseByTitle('Bookshelf Notes');
    expect([books?.parentPageId, sessions?.parentPageId, notes?.parentPageId]).toEqual([
      PARENT_ID,
      PARENT_ID,
      PARENT_ID,
    ]);
    expect(sessions?.properties['Book']).toEqual({
      relation: { database_id: books?.id, type: 'single_property', single_property: {} },
    });

    const [bookPage] = fake.pagesIn('Bookshelf Books');
    expect(bookPage?.properties).toMatchObject({
      Name: { title: [{ type: 'text', text: { content: 'Mexican Gothic' } }] },
      'Bookshelf ID': { rich_text: [{ type: 'text', text: { content: book.id } }] },
      Status: { select: { name: 'Reading' } },
      Progress: { number: 0.125 },
      Formats: { multi_select: [{ name: 'Kindle' }, { name: 'Physical' }] },
      Genres: { multi_select: [{ name: 'Horror' }, { name: 'Fiction gothic' }] },
      Tags: { multi_select: [{ name: 'Gothic horror' }] },
      Started: { date: { start: '2026-11-13', end: null } },
      Finished: { date: null },
    });
    const [sessionPage] = fake.pagesIn('Bookshelf Sessions');
    expect(sessionPage?.properties).toMatchObject({
      Name: { title: [{ type: 'text', text: { content: 'Mexican Gothic — 13/11/2026' } }] },
      'Bookshelf ID': { rich_text: [{ type: 'text', text: { content: session.id } }] },
      Book: { relation: [{ id: bookPage?.id }] },
      Date: { date: { start: '2026-11-13T20:00:00.000Z', end: '2026-11-13T20:40:00.000Z' } },
      Minutes: { number: 40 },
      Format: { select: { name: 'Kindle' } },
      'End %': { number: 0.125 },
    });
    const [notePage] = fake.pagesIn('Bookshelf Notes');
    const text = (notePage?.properties['Text'] as { rich_text: { text: { content: string } }[] })
      .rich_text;
    expect(text.map((t) => t.text.content.length)).toEqual([2000, 2000, 500]);
    expect(
      (notePage?.properties['Name'] as { title: { text: { content: string } }[] }).title[0]?.text
        .content,
    ).toHaveLength(80);

    const call = env.fetchMock.calls.find((c) => c.url.startsWith('https://api.notion.com/'));
    expect(call?.headers['notion-version']).toBe(NOTION_VERSION);
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);

    const status = (await env.request<NotionStatus>('GET', '/api/backup/notion/status')).body;
    expect(status).toMatchObject({
      configured: true,
      running: false,
      lastRunAt: '2026-11-14T12:00:00.000Z',
      lastError: null,
    });
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.lastResult?.books.created).toBe(1);
    expect(JSON.stringify(env.logs)).not.toContain(TOKEN);
  });

  it('mirrors a paused book with the Paused status option', async () => {
    setup();
    const { book } = await seed();
    await env.request('PATCH', `/api/books/${book.id}`, { status: 'paused' });
    await run();
    expect(fake.databaseByTitle('Bookshelf Books')?.properties['Status']).toMatchObject({
      select: { options: expect.arrayContaining([{ name: 'Paused' }]) as unknown },
    });
    const [bookPage] = fake.pagesIn('Bookshelf Books');
    expect(bookPage?.properties['Status']).toEqual({ select: { name: 'Paused' } });
  });

  it('mirrors an unknown session duration as empty minutes', async () => {
    setup();
    const { session } = await seed();
    await env.request('PATCH', `/api/sessions/${session.id}`, { durationSeconds: null });
    await run();
    const [sessionPage] = fake.pagesIn('Bookshelf Sessions');
    expect(sessionPage?.properties['Minutes']).toEqual({ number: null });
  });

  it('skips unchanged rows, updates changed ones and archives deleted ones', async () => {
    setup();
    const { book, session } = await seed();
    await run();
    const writesBefore = fake.log.length;

    const unchanged = await run();
    expect(unchanged.body.books).toEqual({ created: 0, updated: 0, archived: 0, unchanged: 1 });
    // Only the three database checks were made.
    expect(fake.log.slice(writesBefore)).toEqual([
      expect.stringMatching(/^GET \/databases\//),
      expect.stringMatching(/^GET \/databases\//),
      expect.stringMatching(/^GET \/databases\//),
    ]);

    await env.request('PATCH', `/api/books/${book.id}`, { rating: 4 });
    await env.request('DELETE', `/api/sessions/${session.id}`);
    const changed = await run();
    expect(changed.body.books).toEqual({ created: 0, updated: 1, archived: 0, unchanged: 0 });
    expect(changed.body.sessions).toEqual({ created: 0, updated: 0, archived: 1, unchanged: 0 });
    expect(fake.pagesIn('Bookshelf Books')[0]?.properties['Rating']).toEqual({ number: 4 });
    expect(fake.pagesIn('Bookshelf Sessions')).toEqual([]);

    // Archiving is not repeated.
    const after = await run();
    expect(after.body.sessions).toEqual({ created: 0, updated: 0, archived: 0, unchanged: 0 });
  });

  it('mirrors only the owner’s shelf, sessions and notes', async () => {
    setup();
    const { book } = await seed();
    const jo = env.addMember({ name: 'Jo' });
    // Jo shares the book (same ISBN) and has her own reading and notes on it, and another book.
    const shared = (
      await jo.request<BookDetail>('POST', '/api/books', {
        title: 'Mexican Gothic',
        isbn13: '9780525620785',
        status: 'finished',
        rating: 2,
      })
    ).body;
    expect(shared.id).toBe(book.id);
    const own = (await jo.request<BookDetail>('POST', '/api/books', { title: 'Jo’s book' })).body;
    await jo.request('POST', '/api/sessions', {
      bookId: shared.id,
      formatId: shared.formats[0]?.id,
      startedAt: '2026-11-13T21:00:00Z',
      endedAt: '2026-11-13T21:30:00Z',
      progressUnit: 'percent',
      endValue: 20,
    });
    await jo.request('POST', `/api/books/${own.id}/notes`, { kind: 'note', text: 'Private' });
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      books: { created: 1 },
      sessions: { created: 1 },
      notes: { created: 1 },
    });
    const [page] = fake.pagesIn('Bookshelf Books');
    expect(page?.properties['Status']).toEqual({ select: { name: 'Reading' } });
    expect(page?.properties['Rating']).toEqual({ number: null });

    // Taking the book off the owner's shelf archives its page, though Jo still has it.
    await env.request('DELETE', `/api/books/${book.id}`);
    const after = await run();
    expect(after.body.books).toEqual({ created: 0, updated: 0, archived: 1, unchanged: 0 });
  });

  it('finds existing pages by Bookshelf ID when the stored mapping is lost (no duplicates)', async () => {
    setup();
    await seed();
    await run();
    env.ctx.db.exec('DELETE FROM notion_pages');
    const res = await run();
    expect(res.body.books).toEqual({ created: 0, updated: 1, archived: 0, unchanged: 0 });
    expect(fake.pagesIn('Bookshelf Books')).toHaveLength(1);
    expect(fake.pagesIn('Bookshelf Sessions')).toHaveLength(1);
  });

  it('recreates a page deleted in Notion', async () => {
    setup();
    const { book } = await seed();
    await run();
    const page = fake.pagesIn('Bookshelf Books')[0];
    if (page) page.archived = true;
    await env.request('PATCH', `/api/books/${book.id}`, { rating: 3 });
    const res = await run();
    expect(res.body.books).toEqual({ created: 1, updated: 0, archived: 0, unchanged: 0 });
    expect(fake.pagesIn('Bookshelf Books')).toHaveLength(1);
  });

  it('tolerates archiving a page that is already gone', async () => {
    setup();
    const { session } = await seed();
    await run();
    const page = fake.pagesIn('Bookshelf Sessions')[0];
    if (page) page.archived = true;
    await env.request('DELETE', `/api/sessions/${session.id}`);
    expect((await run()).body.sessions.archived).toBe(1);
  });

  it('recreates all databases when the books database disappears', async () => {
    setup();
    await seed();
    await run();
    const oldBooks = fake.databaseByTitle('Bookshelf Books');
    if (oldBooks) oldBooks.archived = true;
    const res = await run();
    expect(res.body.books.created).toBe(1);
    expect(res.body.sessions.created).toBe(1);
    // New sessions/notes databases are created so their Book relation targets the new books
    // database; the orphaned old ones are left in Notion for the user to remove.
    expect(fake.databases.size).toBe(6);
    const newBooks = fake.databaseByTitle('Bookshelf Books');
    expect(newBooks?.id).not.toBe(oldBooks?.id);
    const newSessions = [...fake.databases.values()]
      .filter((d) => d.title === 'Bookshelf Sessions')
      .at(-1);
    expect(newSessions?.properties['Book']).toMatchObject({
      relation: { database_id: newBooks?.id },
    });
  });

  it('recreates only a missing child database', async () => {
    setup();
    await seed();
    await run();
    const notes = fake.databaseByTitle('Bookshelf Notes');
    if (notes) fake.databases.delete(notes.id);
    const res = await run();
    expect(res.body.notes.created).toBe(1);
    expect(res.body.books.unchanged).toBe(1);
    expect(fake.databases.size).toBe(3);
  });

  it('creates fresh databases when the parent page changes', async () => {
    setup();
    await seed();
    await run();
    const otherParent = 'fedcba98-7654-3210-fedc-ba9876543210';
    const mirror = createNotionMirror({
      ...env.ctx,
      config: { ...env.ctx.config, notion: { token: TOKEN, parentPageId: otherParent } },
    });
    const result = await mirror.run();
    expect(result.books.created).toBe(1);
    expect([...fake.databases.values()].filter((d) => d.parentPageId === otherParent)).toHaveLength(
      3,
    );
  });

  it('retries 429s honouring Retry-After and throttles to ~3 requests per second', async () => {
    setup();
    await seed();
    fake.queue.push(
      json({ object: 'error', status: 429, code: 'rate_limited', message: 'Rate limited' }, 429, {
        'Retry-After': '2',
      }),
    );
    const mirror = createNotionMirror(env.ctx, { clock: () => env.clock.ms() });
    const result = await mirror.run();
    expect(result.books.created).toBe(1);
    expect(env.sleeps[0]).toBe(2000);
    // Every later request waited for its throttle slot.
    expect(env.sleeps.slice(1).every((ms) => ms > 0 && ms <= MIN_REQUEST_INTERVAL_MS)).toBe(true);
    expect(env.sleeps.length).toBeGreaterThan(5);
  });

  it('records a failure in the status and returns 502 without leaking the token', async () => {
    setup();
    await seed();
    fake.queue.push(
      json(
        { object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' },
        401,
      ),
    );
    const res = await env.request<{ error: { code: string; message: string } }>(
      'POST',
      '/api/backup/notion',
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({
      code: 'upstream_error',
      message: 'Notion API error (401 unauthorized): API token is invalid.',
    });
    const status = (await env.request<NotionStatus>('GET', '/api/backup/notion/status')).body;
    expect(status.lastError).toBe('Notion API error (401 unauthorized): API token is invalid.');
    expect(status.lastSuccessAt).toBeNull();
    expect(JSON.stringify(env.logs)).not.toContain(TOKEN);
  });

  it('refuses a concurrent run', async () => {
    setup();
    await seed();
    let release: () => void = () => undefined;
    fake.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await env.request<NotionStatus>('GET', '/api/backup/notion/status')).body.running).toBe(
      true,
    );
    const second = await env.request<{ error: { code: string } }>('POST', '/api/backup/notion');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('notion_busy');
    fake.gate = null;
    release();
    expect((await first).status).toBe(200);
  });
});

describe('Notion client', () => {
  function client(responses: (Response | Error)[], maxAttempts?: number) {
    const sleeps: number[] = [];
    let now = 0;
    const calls: string[] = [];
    const c = createNotionClient({
      token: TOKEN,
      fetch: ((url: string) => {
        calls.push(url);
        const next = responses.shift();
        if (!next) throw new Error('No more responses');
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      }) as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
      clock: () => now,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    });
    return { c, sleeps, calls };
  }

  it('retries 5xx with backoff and network errors', async () => {
    const { c, sleeps } = client([
      new Response('', { status: 502 }),
      new TypeError('socket hang up'),
      json({ object: 'page', id: 'p1' }),
    ]);
    expect(await c.request('GET', '/pages/p1')).toEqual({ object: 'page', id: 'p1' });
    expect(sleeps.filter((ms) => ms >= 500)).toEqual([500, 1000]);
  });

  it('gives up after the maximum attempts', async () => {
    const { c } = client([new Response('', { status: 503 }), new Response('', { status: 503 })], 2);
    await expect(c.request('GET', '/x')).rejects.toMatchObject({
      status: 503,
      code: 'http_error',
      message: 'HTTP 503',
    });
    const network = client([new TypeError('offline')], 1);
    await expect(network.c.request('GET', '/x')).rejects.toBeInstanceOf(NotionApiError);
    const limited = client([json({ code: 'rate_limited', message: 'Slow down' }, 429)], 1);
    await expect(limited.c.request('GET', '/x')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
  });

  it('rejects responses without a page id', async () => {
    setup();
    await seed();
    env.fetchMock.on('https://api.notion.com/v1/databases', (call) =>
      call.method === 'POST' && call.url.endsWith('/databases')
        ? json({ object: 'database' })
        : json({}),
    );
    const res = await env.request<{ error: { message: string } }>('POST', '/api/backup/notion');
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('Notion response had no id');
  });

  it('parses Retry-After', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs('0.5')).toBe(500);
    expect(retryAfterMs('120')).toBe(60_000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs('soon')).toBe(1000);
    expect(retryAfterMs('-1')).toBe(1000);
  });
});
