import { afterEach, describe, expect, it } from 'vitest';
import {
  bookAlternativesSchema,
  errorResponseSchema,
  type BookAlternatives,
  type BookDetail,
} from '../../shared/index.ts';
import { MAX_COVER_OPTIONS } from '../services/alternatives.ts';
import {
  GOOGLE_ALTERNATIVES_FOX,
  OL_EDITION_PRIDE,
  OL_EDITION_RECORD_FOX,
  OL_SEARCH_EMPTY,
  OL_TITLE_SEARCH_FOX,
  OL_WORK_RECORD_FOX,
} from '../test/fixtures/lookup.ts';
import { createTestEnv, json, type TestEnv } from '../test/helpers.ts';

const OL = 'https://openlibrary.org';
const GOOGLE = 'https://www.googleapis.com/books/v1/volumes';
const FOX_ISBN = '9780140328721';
const FOX_WORK_SYNOPSIS =
  'The main character of Fantastic Mr. Fox is an extremely clever anthropomorphized fox named Mr. Fox. He lives with his wife and four little foxes.\n\nFinally tired of being constantly outwitted by Mr. Fox, the farmers attempt to capture and kill him.';

const olCover = (id: number) => ({
  url: `https://covers.openlibrary.org/b/id/${id}-L.jpg`,
  previewUrl: `https://covers.openlibrary.org/b/id/${id}-M.jpg`,
  source: 'openlibrary',
});

let env: TestEnv;

afterEach(() => {
  env.cleanup();
});

async function addBook(body: Record<string, unknown>): Promise<BookDetail> {
  const res = await env.request<BookDetail>('POST', '/api/books', body);
  expect(res.status).toBe(201);
  return res.body;
}

async function alternatives(bookId: string): Promise<BookAlternatives> {
  const res = await env.request<BookAlternatives>('GET', `/api/books/${bookId}/alternatives`);
  expect(res.status).toBe(200);
  return bookAlternativesSchema.parse(res.body);
}

function expectError(res: { status: number; body: unknown }, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = errorResponseSchema.parse(res.body);
  expect(body.error.code).toBe(code);
  return body;
}

/** A Fantastic Mr Fox entered by hand with its ISBN, as the import or a manual entry would. */
async function addFox(extra: Record<string, unknown> = {}): Promise<BookDetail> {
  return addBook({
    title: 'Fantastic Mr Fox',
    authors: ['Roald Dahl'],
    isbn13: FOX_ISBN,
    ...extra,
  });
}

describe('GET /api/books/:id/alternatives', () => {
  it('finds the edition by ISBN, then the work: edition covers first, de-duplicated', async () => {
    env = createTestEnv();
    const book = await addFox();
    env.fetchMock.on(`${OL}/isbn/${FOX_ISBN}.json`, () => json(OL_EDITION_RECORD_FOX));
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () => json(OL_WORK_RECORD_FOX));

    expect(await alternatives(book.id)).toEqual({
      covers: [
        { ...olCover(8739161), label: 'This edition' },
        // -1 is Open Library's placeholder; 8739161 was already listed.
        { ...olCover(6498519), label: 'Open Library' },
        { ...olCover(8904777), label: 'Open Library' },
        { ...olCover(108274), label: 'Open Library' },
      ],
      synopses: [{ text: FOX_WORK_SYNOPSIS, source: 'openlibrary', label: 'Open Library work' }],
      unavailable: [],
    });
    // No Google Books key: Google is not asked (the fetch mock throws on unexpected calls).
    expect(env.fetchMock.calls.map((call) => call.url)).toEqual([
      `${OL}/isbn/${FOX_ISBN}.json`,
      `${OL}/works/OL45804W.json`,
    ]);
  });

  it('uses the Open Library edition id first, with its description as "This edition"', async () => {
    env = createTestEnv();
    const book = await addBook({
      title: 'Pride and Prejudice',
      authors: ['Jane Austen'],
      source: 'openlibrary',
      sourceId: 'OL37076991M',
      isbn13: '9780141439518',
    });
    env.fetchMock.on(`${OL}/books/OL37076991M.json`, () =>
      json({ ...OL_EDITION_PRIDE, covers: [12645114] }),
    );
    env.fetchMock.on(`${OL}/works/OL66554W.json`, () =>
      json({
        description: 'A work-level description of Pride and Prejudice.',
        covers: [12645114, 14348537],
      }),
    );

    const result = await alternatives(book.id);
    expect(result.synopses).toEqual([
      {
        text: 'When Elizabeth Bennet first meets eligible bachelor Fitzwilliam Darcy, she thinks him arrogant and conceited. In the sparkling comedy of manners that follows, Jane Austen shows the folly of judging by first impressions.',
        source: 'openlibrary',
        label: 'This edition',
      },
      {
        text: 'A work-level description of Pride and Prejudice.',
        source: 'openlibrary',
        label: 'Open Library work',
      },
    ]);
    expect(result.covers.map((cover) => cover.label)).toEqual(['This edition', 'Open Library']);
    expect(env.fetchMock.calls.map((call) => call.url)).toEqual([
      `${OL}/books/OL37076991M.json`,
      `${OL}/works/OL66554W.json`,
    ]);
  });

  it('goes straight to the work for a book from an Open Library search result', async () => {
    env = createTestEnv();
    const book = await addFox({ source: 'openlibrary', sourceId: 'OL45804W' });
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () => json(OL_WORK_RECORD_FOX));

    const result = await alternatives(book.id);
    expect(result.covers).toHaveLength(4);
    expect(result.synopses).toHaveLength(1);
    expect(env.fetchMock.calls).toHaveLength(1);
  });

  it('finds the work by title and author when the book has no ISBN or Open Library id', async () => {
    env = createTestEnv();
    const book = await addBook({ title: 'Fantastic Mr Fox', authors: ['Roald Dahl'] });
    env.fetchMock.on(`${OL}/search.json`, () => json(OL_TITLE_SEARCH_FOX));
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () => json(OL_WORK_RECORD_FOX));

    const result = await alternatives(book.id);
    expect(result.synopses[0]?.label).toBe('Open Library work');
    const search = new URL(env.fetchMock.calls[0]?.url ?? '');
    expect(search.searchParams.get('title')).toBe('Fantastic Mr Fox');
    expect(search.searchParams.get('author')).toBe('Roald Dahl');
    expect(search.searchParams.get('fields')).toBe('key,title');
    // "The Fox and the Hound" (first result) has a different main title.
    expect(env.fetchMock.calls[1]?.url).toBe(`${OL}/works/OL45804W.json`);
  });

  it('falls back to the title search when Open Library does not know the ISBN', async () => {
    env = createTestEnv();
    const book = await addFox();
    env.fetchMock.on(`${OL}/isbn/`, () => json({ error: 'notfound' }, 404));
    env.fetchMock.on(`${OL}/search.json`, () => json(OL_TITLE_SEARCH_FOX));
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () => json(OL_WORK_RECORD_FOX));

    const result = await alternatives(book.id);
    expect(result.unavailable).toEqual([]);
    expect(result.covers.map((cover) => cover.label)).not.toContain('This edition');
    expect(env.fetchMock.calls.map((call) => new URL(call.url).pathname)).toEqual([
      `/isbn/${FOX_ISBN}.json`,
      '/isbn/0140328726.json',
      '/search.json',
      '/works/OL45804W.json',
    ]);
  });

  it('answers with nothing when no source knows the book', async () => {
    env = createTestEnv();
    const book = await addBook({ title: 'A Family Recipe Book' });
    env.fetchMock.on(`${OL}/search.json`, () => json(OL_SEARCH_EMPTY));

    expect(await alternatives(book.id)).toEqual({ covers: [], synopses: [], unavailable: [] });
    const search = new URL(env.fetchMock.calls[0]?.url ?? '');
    expect(search.searchParams.has('author')).toBe(false);
  });

  it('adds Google Books volumes with the same title when a key is set', async () => {
    env = createTestEnv({ googleBooksApiKey: 'gb-secret-key' });
    const book = await addFox();
    env.fetchMock.on(`${OL}/isbn/${FOX_ISBN}.json`, () => json(OL_EDITION_RECORD_FOX));
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () => json(OL_WORK_RECORD_FOX));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_ALTERNATIVES_FOX));

    const result = await alternatives(book.id);
    expect(result.synopses).toEqual([
      { text: FOX_WORK_SYNOPSIS, source: 'openlibrary', label: 'Open Library work' },
      // HTML becomes text; the colour edition's identical text is dropped;
      // the study guide has a different title.
      {
        text: 'Boggis, Bunce and Bean are the meanest farmers around.\n\nAnd they hate Mr Fox!',
        source: 'googlebooks',
        label: 'Google Books · Penguin UK, 2016',
      },
    ]);
    expect(result.covers.at(-1)).toEqual({
      url: 'https://books.google.com/books/content?id=yTDjAwAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api',
      previewUrl:
        'https://books.google.com/books/content?id=yTDjAwAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api',
      source: 'googlebooks',
      label: 'Google Books · Penguin UK, 2016',
    });
    expect(result.covers).toHaveLength(5);

    const google = new URL(env.fetchMock.calls[2]?.url ?? '');
    expect(google.searchParams.get('q')).toBe('intitle:"Fantastic Mr Fox" inauthor:"Roald Dahl"');
    expect(google.searchParams.get('maxResults')).toBe('20');
    expect(google.searchParams.get('key')).toBe('gb-secret-key');
    expect(JSON.stringify(env.logs)).not.toContain('gb-secret-key');
  });

  it('labels Google Books volumes without publisher details plainly', async () => {
    env = createTestEnv({ googleBooksApiKey: 'gb-secret-key' });
    const book = await addBook({ title: 'Fantastic Mr Fox: A Story', authors: [] });
    env.fetchMock.on(`${OL}/search.json`, () => json(OL_SEARCH_EMPTY));
    env.fetchMock.on(GOOGLE, () =>
      json({
        items: [{ id: 'g1', volumeInfo: { title: 'Fantastic Mr Fox', description: 'Plain.' } }],
      }),
    );

    expect((await alternatives(book.id)).synopses).toEqual([
      { text: 'Plain.', source: 'googlebooks', label: 'Google Books' },
    ]);
    const google = new URL(env.fetchMock.calls[1]?.url ?? '');
    expect(google.searchParams.get('q')).toBe('intitle:"Fantastic Mr Fox"');
  });

  it('keeps what one source found and lists the source that failed', async () => {
    env = createTestEnv({ googleBooksApiKey: 'gb-secret-key' });
    const book = await addFox();
    env.fetchMock.on(`${OL}/isbn/${FOX_ISBN}.json`, () => json(OL_EDITION_RECORD_FOX));
    env.fetchMock.on(`${OL}/works/`, () => new Response('busy', { status: 503 }));
    env.fetchMock.on(GOOGLE, () => json({ error: { code: 429 } }, 429));

    const result = await alternatives(book.id);
    expect(result.covers).toEqual([{ ...olCover(8739161), label: 'This edition' }]);
    expect(result.synopses).toEqual([]);
    expect(result.unavailable).toEqual(['openlibrary', 'googlebooks']);
    expect(env.logs.filter((log) => log['msg'] === 'Lookup source failed')).toHaveLength(2);
  });

  it('502s when nothing was found because every source failed', async () => {
    env = createTestEnv({ googleBooksApiKey: 'gb-secret-key' });
    const book = await addFox();
    env.fetchMock.on(OL, () => new Response('down', { status: 500 }));
    env.fetchMock.on(GOOGLE, () => {
      throw new TypeError('fetch failed');
    });

    const res = await env.request('GET', `/api/books/${book.id}/alternatives`);
    expectError(res, 502, 'upstream_error');
  });

  it('drops unusable upstream values and caps the number of covers', async () => {
    env = createTestEnv();
    const book = await addFox({ source: 'openlibrary', sourceId: 'OL45804W' });
    const covers = Array.from({ length: 40 }, (_, i) => 1000 + i);
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () =>
      json({ description: 'x'.repeat(20_001), covers: [0, 1.5, ...covers] }),
    );

    const result = await alternatives(book.id);
    expect(result.synopses).toEqual([]);
    expect(result.covers).toHaveLength(MAX_COVER_OPTIONS);
    expect(result.covers[0]?.url).toBe('https://covers.openlibrary.org/b/id/1000-L.jpg');
  });

  it('treats a malformed record as a failed source', async () => {
    env = createTestEnv();
    const book = await addFox({ source: 'openlibrary', sourceId: 'OL45804W' });
    env.fetchMock.on(`${OL}/works/OL45804W.json`, () => json({ covers: 'not a list' }));

    expectError(
      await env.request('GET', `/api/books/${book.id}/alternatives`),
      502,
      'upstream_error',
    );
  });

  it('is for parents and admins: 403 for a child, 404 for a book not on the shelf', async () => {
    env = createTestEnv();
    const book = await addFox();
    const child = env.addMember({ name: 'Kit', role: 'child' });
    // The child adds the same edition: the catalogue book is shared.
    const shared = await child.request<BookDetail>('POST', '/api/books', {
      title: 'Fantastic Mr Fox',
      isbn13: FOX_ISBN,
    });
    expect(shared.body.id).toBe(book.id);

    const forbidden = expectError(
      await child.request('GET', `/api/books/${book.id}/alternatives`),
      403,
      'forbidden',
    );
    expect(forbidden.error.message).toBe('Ask a parent to change the details of a book');

    const parent = env.addMember({ name: 'Jo', role: 'parent' });
    expectError(
      await parent.request('GET', `/api/books/${book.id}/alternatives`),
      404,
      'not_found',
    );
    expect(env.fetchMock.calls).toHaveLength(0);
  });
});
