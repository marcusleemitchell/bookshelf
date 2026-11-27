import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bookDetailSchema,
  bookListSchema,
  errorResponseSchema,
  type BookDetail,
  type BookFormat,
  type BookListItem,
  type BookNote,
  type ErrorResponse,
  type Read,
  type Tag,
} from '../../shared/index.ts';
import { createTestEnv, image, PNG_BYTES, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => {
  env.cleanup();
});

async function addBook(body: Record<string, unknown> = {}): Promise<BookDetail> {
  const res = await env.request<BookDetail>('POST', '/api/books', { title: 'Dune', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function addTag(name: string): Promise<Tag> {
  const res = await env.request<Tag>('POST', '/api/tags', { name });
  expect(res.status).toBe(201);
  return res.body;
}

function expectError(res: { status: number; body: unknown }, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorResponseSchema.parse(res.body);
  expect(body.error.code).toBe(code);
  return body;
}

/** `coverSrc` is `/api/covers/:id?v=<12 hex>`, versioned by the cover's source. */
function coverSrcPattern(bookId: string): RegExp {
  return new RegExp(`^/api/covers/${bookId}\\?v=[0-9a-f]{12}$`);
}

describe('POST /api/books', () => {
  it('creates a manual book with defaults', async () => {
    const book = await addBook({ authors: ['Frank Herbert'] });
    expect(bookDetailSchema.parse(book)).toBeTruthy();
    expect(book).toMatchObject({
      title: 'Dune',
      authors: ['Frank Herbert'],
      status: 'to_read',
      source: 'manual',
      coverPath: null,
      coverSrc: null,
      formats: [],
      reads: [],
      currentRead: null,
      progressPercent: null,
      estimatedFinish: null,
      tagIds: [],
      createdAt: '2026-11-14T12:00:00.000Z',
      deletedAt: null,
    });
  });

  it('accepts a client-generated id and rejects reuse', async () => {
    const id = '9b2f6f0e-2a4c-4d6e-8f10-1a2b3c4d5e6f';
    expect((await addBook({ id })).id).toBe(id);
    expectError(await env.request('POST', '/api/books', { id, title: 'Again' }), 409, 'conflict');
  });

  it('completes ISBN-10 from ISBN-13 and vice versa', async () => {
    expect(await addBook({ isbn13: '9780306406157' })).toMatchObject({
      isbn10: '0306406152',
      isbn13: '9780306406157',
    });
    expect(await addBook({ isbn10: '080442957X' })).toMatchObject({
      isbn10: '080442957X',
      isbn13: '9780804429573',
    });
    expect(await addBook({ isbn13: '9791090636071' })).toMatchObject({ isbn10: null });
  });

  it('creates formats and tags with the book', async () => {
    const tag = await addTag('Sci-fi');
    const book = await addBook({
      formats: [
        { format: 'physical', pageCount: 600 },
        { format: 'audiobook', audioDurationSeconds: 75_600 },
      ],
      tagIds: [tag.id],
    });
    expect(book.formats.map((f) => [f.format, f.pageCount, f.audioDurationSeconds])).toEqual([
      ['physical', 600, null],
      ['audiobook', null, 75_600],
    ]);
    expect(book.tagIds).toEqual([tag.id]);
  });

  it('rejects inconsistent formats, unknown tags and invalid bodies', async () => {
    expectError(
      await env.request('POST', '/api/books', {
        title: 'X',
        formats: [{ format: 'audiobook', pageCount: 10 }],
      }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('POST', '/api/books', {
        title: 'X',
        tagIds: ['00000000-0000-4000-8000-000000000000'],
      }),
      400,
      'validation_error',
    );
    const invalid = expectError(
      await env.request('POST', '/api/books', { title: '' }),
      400,
      'validation_error',
    );
    expect(invalid.error.message).toMatch(/^title:/);
    expectError(await env.request('POST', '/api/books', '{not json'), 400, 'validation_error');
    expectError(await env.request('POST', '/api/books'), 400, 'validation_error');
  });

  it('opens a read when created as reading, and a closed read when created finished', async () => {
    const reading = await addBook({ status: 'reading' });
    expect(reading.currentRead).toMatchObject({
      number: 1,
      outcome: 'in_progress',
      finishedAt: null,
    });
    const finished = await addBook({ status: 'finished' });
    expect(finished.currentRead).toMatchObject({
      number: 1,
      outcome: 'finished',
      finishedAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('downloads the cover into the cache', async () => {
    env.fetchMock.on('https://covers.example.org/', () => image());
    const book = await addBook({ coverUrl: 'https://covers.example.org/dune.png' });
    expect(book.coverPath).toBe(`${book.id}.png`);
    expect(book.coverSrc).toMatch(coverSrcPattern(book.id));
    expect(readFileSync(join(env.ctx.config.coversDir, `${book.id}.png`))).toEqual(PNG_BYTES);
    expect(env.fetchMock.calls[0]?.headers['user-agent']).toMatch(/^Bookshelf/);
  });

  it('still creates the book when the cover download fails', async () => {
    env.fetchMock.on('https://covers.example.org/', () => new Response('nope', { status: 500 }));
    const book = await addBook({ coverUrl: 'https://covers.example.org/missing.jpg' });
    expect(book.coverPath).toBeNull();
    expect(book.coverSrc).toMatch(coverSrcPattern(book.id));
    expect(env.logs.some((log) => log['msg'] === 'Cover download failed')).toBe(true);
  });

  it('rejects covers that are not images or are empty', async () => {
    env.fetchMock.on(
      'https://covers.example.org/html',
      () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    env.fetchMock.on('https://covers.example.org/empty', () => image(Buffer.alloc(0)));
    env.fetchMock.on('https://covers.example.org/down', () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    for (const path of ['html', 'empty', 'down']) {
      const book = await addBook({ coverUrl: `https://covers.example.org/${path}` });
      expect(book.coverPath).toBeNull();
    }
  });
});

describe('POST /api/books with a book already in the catalogue', () => {
  it('reuses a live catalogue book with the same ISBN-13 for another member', async () => {
    const tag = await addTag('Classics');
    const owners = await addBook({
      title: 'Dune',
      isbn13: '9780441013593',
      status: 'reading',
      rating: 4,
      tagIds: [tag.id],
      formats: [{ format: 'physical', pageCount: 412 }],
    });
    const jo = env.addMember({ name: 'Jo' });
    const joTag = (await jo.request<Tag>('POST', '/api/tags', { name: 'Classics' })).body;
    const res = await jo.request<BookDetail>('POST', '/api/books', {
      id: '12121212-1212-4212-8212-121212121212',
      title: 'Dune (another edition title)',
      isbn10: '0441013597',
      status: 'finished',
      tagIds: [joTag.id],
      formats: [
        { format: 'physical', pageCount: 500 },
        { format: 'audiobook', audioDurationSeconds: 75_600 },
      ],
    });
    expect(res.status).toBe(201);
    // The existing book (its id, not the client's), with Jo's own shelf fields.
    expect(res.body).toMatchObject({
      id: owners.id,
      title: 'Dune',
      status: 'finished',
      rating: null,
      tagIds: [joTag.id],
    });
    expect(res.body.reads).toEqual([expect.objectContaining({ outcome: 'finished', number: 1 })]);
    // Only the missing kind of format was added; the physical one is shared as it was.
    expect(res.body.formats.map((f) => [f.format, f.pageCount])).toEqual([
      ['physical', 412],
      ['audiobook', null],
    ]);
    const mine = (await env.request<BookDetail>('GET', `/api/books/${owners.id}`)).body;
    expect(mine).toMatchObject({ status: 'reading', rating: 4, tagIds: [tag.id] });
    expect(mine.formats).toHaveLength(2);
    expect(
      (await env.request('GET', '/api/books/12121212-1212-4212-8212-121212121212')).status,
    ).toBe(404);

    // Already on the shelf: 409.
    const again = await jo.request('POST', '/api/books', {
      title: 'Dune',
      isbn13: '9780441013593',
    });
    expectError(again, 409, 'conflict');
    expect(errorResponseSchema.parse(again.body).error.message).toBe(
      'This book is already on your shelf',
    );

    // Removed from the shelf, it can be added again (a fresh shelf entry, new read).
    expect((await jo.request('DELETE', `/api/books/${owners.id}`)).status).toBe(204);
    const back = await jo.request<BookDetail>('POST', '/api/books', {
      title: 'Dune',
      isbn13: '9780441013593',
      status: 'to_read',
    });
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ id: owners.id, status: 'to_read', reads: [], tagIds: [] });
  });

  it('refuses the member’s own duplicate and ignores deleted catalogue books', async () => {
    const book = await addBook({ isbn13: '9780441013593' });
    expectError(
      await env.request('POST', '/api/books', { title: 'Dune', isbn13: '9780441013593' }),
      409,
      'conflict',
    );
    expect((await env.request('DELETE', `/api/books/${book.id}`)).status).toBe(204);
    const fresh = await addBook({ isbn13: '9780441013593' });
    expect(fresh.id).not.toBe(book.id);
  });
});

describe('GET /api/books', () => {
  it('lists live books by title with filters', async () => {
    const tag = await addTag('Favourites');
    await addBook({ title: 'Neuromancer', authors: ['William Gibson'], status: 'reading' });
    const dune = await addBook({
      title: 'Dune',
      authors: ['Frank Herbert'],
      isbn13: '9780441172719',
      tagIds: [tag.id],
    });
    const gone = await addBook({ title: 'Deleted 100%_book' });
    await env.request('DELETE', `/api/books/${gone.id}`);

    const all = await env.request<BookListItem[]>('GET', '/api/books');
    expect(bookListSchema.parse(all.body).map((b) => b.title)).toEqual(['Dune', 'Neuromancer']);

    const byStatus = await env.request<BookListItem[]>('GET', '/api/books?status=reading');
    expect(byStatus.body.map((b) => b.title)).toEqual(['Neuromancer']);

    const byTag = await env.request<BookListItem[]>('GET', `/api/books?tag=${tag.id}`);
    expect(byTag.body.map((b) => b.id)).toEqual([dune.id]);

    const byAuthor = await env.request<BookListItem[]>('GET', '/api/books?q=gibson');
    expect(byAuthor.body.map((b) => b.title)).toEqual(['Neuromancer']);

    const byIsbn = await env.request<BookListItem[]>('GET', '/api/books?q=0441172719');
    expect(byIsbn.body.map((b) => b.title)).toEqual(['Dune']);

    const literal = await env.request<BookListItem[]>('GET', '/api/books?q=100%25_');
    expect(literal.body).toEqual([]);
  });

  it('rejects invalid filters', async () => {
    expectError(await env.request('GET', '/api/books?status=lost'), 400, 'validation_error');
    expectError(await env.request('GET', '/api/books?tag=nope'), 400, 'validation_error');
  });
});

describe('GET/PATCH/DELETE /api/books/:id', () => {
  it('returns 404 for unknown and deleted books, 400 for bad ids', async () => {
    expectError(
      await env.request('GET', '/api/books/00000000-0000-4000-8000-000000000000'),
      404,
      'not_found',
    );
    expectError(await env.request('GET', '/api/books/not-a-uuid'), 400, 'validation_error');
    const book = await addBook();
    expect((await env.request('DELETE', `/api/books/${book.id}`)).status).toBe(204);
    expectError(await env.request('GET', `/api/books/${book.id}`), 404, 'not_found');
    expectError(await env.request('DELETE', `/api/books/${book.id}`), 404, 'not_found');
    expectError(
      await env.request('PATCH', `/api/books/${book.id}`, { rating: 3 }),
      404,
      'not_found',
    );
  });

  it('updates fields and stamps updatedAt', async () => {
    const book = await addBook();
    env.clock.advance(60_000);
    const res = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      rating: 4.5,
      genres: ['Science fiction'],
      isbn10: '0306406152',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rating: 4.5,
      genres: ['Science fiction'],
      isbn10: '0306406152',
      isbn13: '9780306406157',
      updatedAt: '2026-11-14T12:01:00.000Z',
      createdAt: '2026-11-14T12:00:00.000Z',
    });
    expectError(
      await env.request('PATCH', `/api/books/${book.id}`, { rating: 4.2 }),
      400,
      'validation_error',
    );
    expectError(await env.request('PATCH', `/api/books/${book.id}`, {}), 400, 'validation_error');
  });

  it('keeps reads in step with status changes', async () => {
    const book = await addBook();
    const reading = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      status: 'reading',
    });
    expect(reading.body.reads).toHaveLength(1);
    expect(reading.body.currentRead?.outcome).toBe('in_progress');

    env.clock.advance(86_400_000);
    const finished = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      status: 'finished',
    });
    expect(finished.body.currentRead).toMatchObject({
      outcome: 'finished',
      finishedAt: '2026-11-15T12:00:00.000Z',
    });

    // Setting finished again, or back to to_read, does not create reads.
    await env.request('PATCH', `/api/books/${book.id}`, { status: 'to_read' });
    const again = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      status: 'dnf',
    });
    expect(again.body.reads).toHaveLength(1);
    expect(again.body.reads[0]?.outcome).toBe('finished');

    const dnf = await addBook({ status: 'reading' });
    const abandoned = await env.request<BookDetail>('PATCH', `/api/books/${dnf.id}`, {
      status: 'dnf',
    });
    expect(abandoned.body.currentRead?.outcome).toBe('dnf');
  });

  it('pauses a book keeping its read open, and resumes the same read', async () => {
    const book = await addBook({ status: 'reading' });
    const readId = book.currentRead?.id;
    const paused = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      status: 'paused',
    });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');
    expect(paused.body.reads).toHaveLength(1);
    expect(paused.body.currentRead).toMatchObject({ id: readId, outcome: 'in_progress' });

    const resumed = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      status: 'reading',
    });
    expect(resumed.body.reads).toHaveLength(1);
    expect(resumed.body.currentRead?.id).toBe(readId);

    // Pausing a book that has no read leaves it without one.
    const unread = await addBook({ title: 'Unread', status: 'paused' });
    expect(unread.reads).toHaveLength(0);
    const listed = await env.request<BookListItem[]>('GET', '/api/books?status=paused');
    expect(listed.body.map((b) => b.title)).toEqual(['Unread']);

    // Finishing a paused book closes the open read.
    await env.request('PATCH', `/api/books/${book.id}`, { status: 'paused' });
    const finished = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      status: 'finished',
    });
    expect(finished.body.currentRead).toMatchObject({ id: readId, outcome: 'finished' });
  });

  it('re-caches the cover when its URL changes and clears it when removed', async () => {
    env.fetchMock.on('https://covers.example.org/a', () => image());
    env.fetchMock.on('https://covers.example.org/b', () => image(PNG_BYTES, 'image/jpeg'));
    const book = await addBook({ coverUrl: 'https://covers.example.org/a' });
    expect(existsSync(join(env.ctx.config.coversDir, `${book.id}.png`))).toBe(true);

    const changed = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      coverUrl: 'https://covers.example.org/b',
    });
    expect(changed.body.coverPath).toBe(`${book.id}.jpg`);
    expect(existsSync(join(env.ctx.config.coversDir, `${book.id}.png`))).toBe(false);
    // A new cover gets a new URL, so the browser and service worker caches
    // (keyed by URL) never keep showing the old image.
    expect(changed.body.coverSrc).toMatch(coverSrcPattern(book.id));
    expect(changed.body.coverSrc).not.toBe(book.coverSrc);
    const untouched = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      title: 'Dune Messiah',
    });
    expect(untouched.body.coverSrc).toBe(changed.body.coverSrc);

    const cleared = await env.request<BookDetail>('PATCH', `/api/books/${book.id}`, {
      coverUrl: null,
    });
    expect(cleared.body.coverPath).toBeNull();
    expect(cleared.body.coverSrc).toBeNull();
    expect(existsSync(join(env.ctx.config.coversDir, `${book.id}.jpg`))).toBe(false);
  });

  it('soft-deletes the book with its formats, reads, sessions, notes and timer', async () => {
    const book = await addBook({ status: 'reading', formats: [{ format: 'kindle' }] });
    const formatId = book.formats[0]?.id as string;
    await env.request('POST', '/api/sessions', {
      bookId: book.id,
      formatId,
      startedAt: '2026-11-14T09:00:00Z',
      endedAt: '2026-11-14T10:00:00Z',
      progressUnit: 'percent',
      endValue: 10,
    });
    await env.request('POST', `/api/books/${book.id}/notes`, { kind: 'note', text: 'Spice' });
    await env.request('PUT', '/api/timer', { action: 'start', bookId: book.id, formatId });
    await env.request('DELETE', `/api/books/${book.id}`);

    const deletedAt = (table: string) =>
      env.ctx.db
        .prepare(`SELECT deleted_at FROM ${table} WHERE book_id = ?`)
        .all(book.id)
        .map((r) => r['deleted_at']);
    for (const table of ['book_formats', 'reads', 'sessions', 'book_notes']) {
      expect(deletedAt(table)).toEqual(['2026-11-14T12:00:00.000Z']);
    }
    expect((await env.request<{ timer: unknown }>('GET', '/api/timer')).body.timer).toBeNull();
    expect((await env.request<unknown[]>('GET', '/api/sessions')).body).toEqual([]);
  });
});

describe('formats', () => {
  it('creates, updates and deletes formats', async () => {
    const book = await addBook();
    const created = await env.request<BookFormat>('POST', `/api/books/${book.id}/formats`, {
      format: 'physical',
      pageCount: 300,
      isbn: '9780306406157',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ bookId: book.id, format: 'physical', pageCount: 300 });

    const updated = await env.request<BookFormat>(
      'PATCH',
      `/api/books/${book.id}/formats/${created.body.id}`,
      { pageCount: 320 },
    );
    expect(updated.body.pageCount).toBe(320);

    expect(
      (await env.request('DELETE', `/api/books/${book.id}/formats/${created.body.id}`)).status,
    ).toBe(204);
    const detail = await env.request<BookDetail>('GET', `/api/books/${book.id}`);
    expect(detail.body.formats).toEqual([]);
  });

  it('validates formats and their ownership', async () => {
    const book = await addBook({ formats: [{ format: 'physical', pageCount: 100 }] });
    const other = await addBook({ title: 'Other' });
    const formatId = book.formats[0]?.id as string;
    expectError(
      await env.request('POST', `/api/books/${book.id}/formats`, {
        format: 'kindle',
        audioDurationSeconds: 10,
      }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('POST', `/api/books/${book.id}/formats`, {
        id: formatId,
        format: 'kindle',
      }),
      409,
      'conflict',
    );
    expectError(
      await env.request('POST', '/api/books/00000000-0000-4000-8000-000000000000/formats', {
        format: 'kindle',
      }),
      404,
      'not_found',
    );
    expectError(
      await env.request('PATCH', `/api/books/${other.id}/formats/${formatId}`, { pageCount: 5 }),
      404,
      'not_found',
    );
    expectError(
      await env.request('PATCH', `/api/books/${book.id}/formats/${formatId}`, {
        format: 'audiobook',
      }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('DELETE', `/api/books/${other.id}/formats/${formatId}`),
      404,
      'not_found',
    );
  });

  it('re-derives session percents when the page count changes', async () => {
    const book = await addBook({ formats: [{ format: 'physical', pageCount: 200 }] });
    const formatId = book.formats[0]?.id as string;
    const session = await env.request<{ id: string; endPercent: number }>('POST', '/api/sessions', {
      bookId: book.id,
      formatId,
      startedAt: '2026-11-14T09:00:00Z',
      endedAt: '2026-11-14T10:00:00Z',
      progressUnit: 'pages',
      startValue: 0,
      endValue: 50,
    });
    expect(session.body.endPercent).toBe(25);
    await env.request('PATCH', `/api/books/${book.id}/formats/${formatId}`, { pageCount: 100 });
    const sessions = await env.request<{ endPercent: number }[]>(
      'GET',
      `/api/sessions?bookId=${book.id}`,
    );
    expect(sessions.body[0]?.endPercent).toBe(50);
    // Changing the type to kindle keeps page-based sessions valid.
    const kindle = await env.request('PATCH', `/api/books/${book.id}/formats/${formatId}`, {
      format: 'kindle',
    });
    expect(kindle.status).toBe(200);
  });

  it('discards a timer on a deleted format', async () => {
    const book = await addBook({ formats: [{ format: 'kindle' }] });
    const formatId = book.formats[0]?.id as string;
    await env.request('PUT', '/api/timer', { action: 'start', bookId: book.id, formatId });
    await env.request('DELETE', `/api/books/${book.id}/formats/${formatId}`);
    expect((await env.request<{ timer: unknown }>('GET', '/api/timer')).body.timer).toBeNull();
  });
});

describe('POST /api/books/:id/reads', () => {
  it('starts a reread after finishing and refuses while one is in progress', async () => {
    const book = await addBook({ status: 'finished' });
    const reread = await env.request<Read>('POST', `/api/books/${book.id}/reads`);
    expect(reread.status).toBe(201);
    expect(reread.body).toMatchObject({ number: 2, outcome: 'in_progress', finishedAt: null });
    const detail = await env.request<BookDetail>('GET', `/api/books/${book.id}`);
    expect(detail.body.status).toBe('reading');
    expect(detail.body.currentRead?.id).toBe(reread.body.id);
    expectError(await env.request('POST', `/api/books/${book.id}/reads`), 409, 'conflict');
  });

  it('accepts a client id and start time', async () => {
    const book = await addBook();
    const id = '3f0e4b6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    const read = await env.request<Read>('POST', `/api/books/${book.id}/reads`, {
      id,
      startedAt: '2026-11-01T08:00:00Z',
    });
    expect(read.body).toMatchObject({ id, number: 1, startedAt: '2026-11-01T08:00:00.000Z' });
    await env.request('PATCH', `/api/books/${book.id}`, { status: 'finished' });
    expectError(await env.request('POST', `/api/books/${book.id}/reads`, { id }), 409, 'conflict');
  });
});

describe('PUT /api/books/:id/tags', () => {
  it('replaces tags and hides deleted ones', async () => {
    const a = await addTag('Alpha');
    const b = await addTag('beta');
    const book = await addBook({ tagIds: [a.id] });
    env.clock.advance(1000);
    const res = await env.request<BookDetail>('PUT', `/api/books/${book.id}/tags`, {
      tagIds: [b.id, a.id, a.id],
    });
    expect(res.body.tagIds).toEqual([a.id, b.id]);
    expect(res.body.updatedAt).toBe('2026-11-14T12:00:01.000Z');
    await env.request('DELETE', `/api/tags/${a.id}`);
    const after = await env.request<BookDetail>('GET', `/api/books/${book.id}`);
    expect(after.body.tagIds).toEqual([b.id]);
    expectError(
      await env.request('PUT', `/api/books/${book.id}/tags`, { tagIds: [a.id] }),
      400,
      'validation_error',
    );
  });
});

describe('notes', () => {
  it('creates, lists, updates and deletes notes and quotes', async () => {
    const book = await addBook();
    const quote = await env.request<BookNote>('POST', `/api/books/${book.id}/notes`, {
      kind: 'quote',
      text: 'Fear is the mind-killer.',
      location: 'p. 8',
    });
    expect(quote.status).toBe(201);
    env.clock.advance(1000);
    await env.request('POST', `/api/books/${book.id}/notes`, {
      kind: 'note',
      text: 'Re-read chapter 3',
    });
    const list = await env.request<BookNote[]>('GET', `/api/books/${book.id}/notes`);
    expect(list.body.map((n) => n.kind)).toEqual(['quote', 'note']);

    const updated = await env.request<BookNote>(
      'PATCH',
      `/api/books/${book.id}/notes/${quote.body.id}`,
      {
        location: 'p. 9',
      },
    );
    expect(updated.body.location).toBe('p. 9');

    expect(
      (await env.request('DELETE', `/api/books/${book.id}/notes/${quote.body.id}`)).status,
    ).toBe(204);
    expect((await env.request<BookNote[]>('GET', `/api/books/${book.id}/notes`)).body).toHaveLength(
      1,
    );
  });

  it('validates notes and ownership', async () => {
    const book = await addBook();
    const other = await addBook({ title: 'Other' });
    const note = await env.request<BookNote>('POST', `/api/books/${book.id}/notes`, {
      kind: 'note',
      text: 'x',
    });
    expectError(
      await env.request('POST', `/api/books/${book.id}/notes`, { kind: 'idea', text: 'x' }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('POST', `/api/books/${book.id}/notes`, {
        id: note.body.id,
        kind: 'note',
        text: 'y',
      }),
      409,
      'conflict',
    );
    expectError(
      await env.request('PATCH', `/api/books/${other.id}/notes/${note.body.id}`, { text: 'y' }),
      404,
      'not_found',
    );
    expectError(
      await env.request('DELETE', `/api/books/${other.id}/notes/${note.body.id}`),
      404,
      'not_found',
    );
    expectError(
      await env.request('GET', '/api/books/00000000-0000-4000-8000-000000000000/notes'),
      404,
      'not_found',
    );
  });
});

describe('GET /api/covers/:bookId', () => {
  it('serves the cached file', async () => {
    env.fetchMock.on('https://covers.example.org/', () => image());
    const book = await addBook({ coverUrl: 'https://covers.example.org/c.png' });
    const res = await env.app.request(book.coverSrc as string, { headers: env.authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('re-downloads a missing cached file, else redirects to the remote URL', async () => {
    let available = false;
    env.fetchMock.on('https://covers.example.org/', () =>
      available ? image() : new Response('down', { status: 503 }),
    );
    const book = await addBook({ coverUrl: 'https://covers.example.org/c.png' });
    expect(book.coverPath).toBeNull();

    const redirect = await env.app.request(`/api/covers/${book.id}`, {
      headers: env.authHeaders(),
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://covers.example.org/c.png');

    available = true;
    const healed = await env.app.request(`/api/covers/${book.id}`, { headers: env.authHeaders() });
    expect(healed.status).toBe(200);
    expect(healed.headers.get('content-type')).toBe('image/png');
  });

  it('serves unknown cached extensions as octet-stream', async () => {
    const book = await addBook();
    writeFileSync(join(env.ctx.config.coversDir, `${book.id}.bin`), 'x');
    env.ctx.db
      .prepare('UPDATE books SET cover_path = ? WHERE id = ?')
      .run(`${book.id}.bin`, book.id);
    const res = await env.app.request(`/api/covers/${book.id}`, { headers: env.authHeaders() });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('404s for books without covers and unknown books', async () => {
    const book = await addBook();
    expectError(await env.request('GET', `/api/covers/${book.id}`), 404, 'not_found');
    const res = await env.request<ErrorResponse>(
      'GET',
      '/api/covers/00000000-0000-4000-8000-000000000000',
    );
    expect(res.body.error.message).toBe('Book not found');
  });
});
