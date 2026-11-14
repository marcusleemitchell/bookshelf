import { afterEach, describe, expect, it } from 'vitest';
import {
  bookCandidateListSchema,
  bookCandidateSchema,
  type BookCandidate,
} from '../../shared/index.ts';
import {
  cleanDescription,
  cleanGenres,
  htmlToText,
  normalisePublishedDate,
} from '../services/lookup.ts';
import {
  GOOGLE_EMPTY_RESPONSE,
  GOOGLE_ISBN_RESPONSE,
  GOOGLE_SEARCH_RESPONSE,
  OL_EDITION_FOX,
  OL_EDITION_PRIDE,
  OL_ISBN_PRIDE,
  OL_ISBN_RESPONSE,
  OL_SEARCH_EDITIONS_RESPONSE,
  OL_SEARCH_EMPTY,
  OL_SEARCH_RESPONSE,
  OL_WORK_FOX,
} from '../test/fixtures/lookup.ts';
import { createTestEnv, json, type TestEnv } from '../test/helpers.ts';

const OL_BOOKS = 'https://openlibrary.org/api/books';
const OL_SEARCH = 'https://openlibrary.org/search.json';
const OL_EDITION = (id: string) => `https://openlibrary.org/books/${id}.json`;
const OL_WORK = (id: string) => `https://openlibrary.org/works/${id}.json`;
const GOOGLE = 'https://www.googleapis.com/books/v1/volumes';

let env: TestEnv;

function setup(options: Parameters<typeof createTestEnv>[0] = {}) {
  env = createTestEnv(options);
  return env;
}

afterEach(() => {
  env.cleanup();
});

describe('GET /api/lookup/isbn/:isbn', () => {
  it('normalises the ISBN, uses Open Library and fills gaps from Google Books', async () => {
    setup({ googleBooksApiKey: 'gb-secret-key' });
    env.fetchMock.on(OL_BOOKS, () => json(OL_ISBN_RESPONSE));
    // The edition has a language but neither it nor a work has a description.
    env.fetchMock.on(OL_EDITION('OL7353617M'), () => json({ ...OL_EDITION_FOX, works: undefined }));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_ISBN_RESPONSE));

    const res = await env.request<BookCandidate>('GET', '/api/lookup/isbn/0-14-032872-6');
    expect(res.status).toBe(200);
    expect(bookCandidateSchema.parse(res.body)).toEqual({
      source: 'openlibrary',
      sourceId: 'OL7353617M',
      title: 'Fantastic Mr. Fox',
      subtitle: null,
      authors: ['Roald Dahl'],
      publisher: 'Puffin',
      publishedDate: '1988-10-01',
      language: 'eng',
      synopsis:
        'The Boggis, Bunce and Bean are three very nasty farmers.\n\nMr Fox outwits them & survives.\nThe end.',
      coverUrl: 'https://covers.openlibrary.org/b/id/8739161-L.jpg',
      isbn10: '0140328726',
      isbn13: '9780140328721',
      genres: ['Animals', 'Foxes'],
      pageCount: 96,
    });

    const [olCall, editionCall, googleCall] = env.fetchMock.calls;
    expect(olCall?.url).toContain('bibkeys=ISBN%3A9780140328721%2CISBN%3A0140328726');
    expect(editionCall?.url).toBe(OL_EDITION('OL7353617M'));
    expect(olCall?.url).toContain('jscmd=data');
    expect(googleCall?.url).toContain('q=isbn%3A9780140328721');
    expect(googleCall?.url).toContain('key=gb-secret-key');
    // The API key never reaches the logs.
    expect(JSON.stringify(env.logs)).not.toContain('gb-secret-key');
  });

  it('takes the synopsis and language from the Open Library edition (no key needed)', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => json(OL_ISBN_PRIDE));
    env.fetchMock.on(OL_EDITION('OL37076991M'), () => json(OL_EDITION_PRIDE));
    const res = await env.request<BookCandidate>('GET', '/api/lookup/isbn/9780141439518');
    expect(res.status).toBe(200);
    expect(bookCandidateSchema.parse(res.body)).toMatchObject({
      source: 'openlibrary',
      sourceId: 'OL37076991M',
      title: 'Pride and Prejudice',
      publishedDate: '2003',
      language: 'eng',
      synopsis:
        'When Elizabeth Bennet first meets eligible bachelor Fitzwilliam Darcy, she thinks him arrogant and conceited. In the sparkling comedy of manners that follows, Jane Austen shows the folly of judging by first impressions.',
      pageCount: 435,
      coverUrl: 'https://covers.openlibrary.org/b/id/12645114-L.jpg',
    });
    // Nothing left to fill, so neither the work nor Google Books is asked.
    expect(env.fetchMock.calls.map((c) => c.url.split('?')[0])).toEqual([
      OL_BOOKS,
      OL_EDITION('OL37076991M'),
    ]);
  });

  it('falls back to the Open Library work description', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => json(OL_ISBN_RESPONSE));
    env.fetchMock.on(OL_EDITION('OL7353617M'), () => json(OL_EDITION_FOX));
    env.fetchMock.on(OL_WORK('OL45804W'), () => json(OL_WORK_FOX));
    const res = await env.request<BookCandidate>('GET', '/api/lookup/isbn/9780140328721');
    expect(res.body.synopsis).toBe(
      'The main character of Fantastic Mr. Fox is an extremely clever anthropomorphized fox named Mr. Fox. He lives with his wife and four little foxes.\n\nFinally tired of being constantly outwitted by Mr. Fox, the farmers attempt to capture and kill him.',
    );
    expect(res.body.language).toBe('eng');
    expect(env.fetchMock.calls).toHaveLength(3);
  });

  it('keeps the Open Library record when its edition or work cannot be read', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => json(OL_ISBN_RESPONSE));
    env.fetchMock.on(OL_EDITION('OL7353617M'), () => new Response('', { status: 503 }));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_EMPTY_RESPONSE));
    const res = await env.request<BookCandidate>('GET', '/api/lookup/isbn/9780140328721');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Fantastic Mr. Fox', synopsis: null, language: null });
    expect(
      env.logs.some((l) => l['msg'] === 'Lookup source failed' && l['source'] === 'openlibrary'),
    ).toBe(true);

    env.fetchMock.on(OL_EDITION('OL7353617M'), () => json(OL_EDITION_FOX));
    env.fetchMock.on(OL_WORK('OL45804W'), () => json({ key: '/works/OL45804W', description: 7 }));
    const malformedWork = await env.request<BookCandidate>('GET', '/api/lookup/isbn/9780140328721');
    expect(malformedWork.body).toMatchObject({ synopsis: null, language: 'eng' });
  });

  it('falls back to Google Books when Open Library has no record', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => json({}));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_ISBN_RESPONSE));
    const res = await env.request<BookCandidate>('GET', '/api/lookup/isbn/9780140328721');
    expect(res.body).toMatchObject({
      source: 'googlebooks',
      sourceId: 'wrOQLV6xB-wC',
      title: 'Fantastic Mr Fox',
      publisher: 'Penguin UK',
      pageCount: 112,
      genres: ['Juvenile Fiction', 'Animals', 'General'],
      coverUrl:
        'https://books.google.com/books/content?id=wrOQLV6xB-wC&printsec=frontcover&img=1&zoom=1&source=gbs_api',
    });
  });

  it('falls back to Google Books when Open Library is down', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => new Response('Bad gateway', { status: 502 }));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_ISBN_RESPONSE));
    const res = await env.request<BookCandidate>('GET', '/api/lookup/isbn/9780140328721');
    expect(res.body.source).toBe('googlebooks');
    expect(
      env.logs.some((l) => l['msg'] === 'Lookup source failed' && l['source'] === 'openlibrary'),
    ).toBe(true);
  });

  it('returns 404 when neither source knows the ISBN', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => json({}));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_EMPTY_RESPONSE));
    const res = await env.request<{ error: { code: string; message: string } }>(
      'GET',
      '/api/lookup/isbn/9780306406157',
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'not_found',
      message: 'No book found for ISBN 9780306406157',
    });
  });

  it('returns 502 when a source failed and nothing was found', async () => {
    setup();
    env.fetchMock.on(OL_BOOKS, () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_EMPTY_RESPONSE));
    const res = await env.request<{ error: { code: string } }>(
      'GET',
      '/api/lookup/isbn/9780306406157',
    );
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('upstream_error');

    env.fetchMock.on(OL_BOOKS, () => json({}));
    env.fetchMock.on(GOOGLE, () => new Response('{"error":"quota"}', { status: 429 }));
    expect((await env.request('GET', '/api/lookup/isbn/9780306406157')).status).toBe(502);

    env.fetchMock.on(OL_BOOKS, () => json(['unexpected']));
    env.fetchMock.on(GOOGLE, () => new Response('not json', { status: 200 }));
    expect((await env.request('GET', '/api/lookup/isbn/9780306406157')).status).toBe(502);
  });

  it('rejects invalid ISBNs without calling out', async () => {
    setup();
    const res = await env.request<{ error: { code: string } }>('GET', '/api/lookup/isbn/12345');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(env.fetchMock.calls).toEqual([]);
  });
});

describe('GET /api/lookup/search', () => {
  it('returns Open Library results normalised into candidates', async () => {
    setup();
    env.fetchMock.on(OL_SEARCH, () => json(OL_SEARCH_RESPONSE));
    const res = await env.request<BookCandidate[]>('GET', '/api/lookup/search?q=dune&page=2');
    expect(res.status).toBe(200);
    expect(bookCandidateListSchema.parse(res.body)).toEqual([
      {
        source: 'openlibrary',
        sourceId: 'OL893415W',
        title: 'Dune',
        subtitle: null,
        authors: ['Frank Herbert'],
        publisher: 'Ace Books',
        publishedDate: '1965',
        // Several languages across editions and no best edition: unknown.
        language: null,
        synopsis: null,
        coverUrl: 'https://covers.openlibrary.org/b/id/11481354-L.jpg',
        isbn10: '0441172717',
        isbn13: '9780441172719',
        genres: ['Science fiction', 'Dune (Imaginary place)', 'Fiction, science fiction, general'],
        pageCount: 604,
      },
      {
        source: 'openlibrary',
        sourceId: 'OL893416W',
        title: 'Dune Messiah',
        subtitle: 'Book two',
        authors: ['Frank Herbert'],
        publisher: null,
        publishedDate: null,
        language: null,
        synopsis: null,
        coverUrl: null,
        isbn10: null,
        isbn13: null,
        genres: [],
        pageCount: null,
      },
    ]);
    const url = new URL(env.fetchMock.calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('dune');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('fields')).toContain('editions.isbn');
  });

  it("describes Open Library's best edition rather than an arbitrary one", async () => {
    setup();
    env.fetchMock.on(OL_SEARCH, () => json(OL_SEARCH_EDITIONS_RESPONSE));
    const res = await env.request<BookCandidate[]>('GET', '/api/lookup/search?q=osman');
    expect(bookCandidateListSchema.parse(res.body)).toMatchObject([
      {
        sourceId: 'OL28804417W',
        title: 'The Last Devil to Die',
        isbn13: '9780241512449',
        isbn10: '0241512441',
        language: 'eng',
        publisher: 'Penguin Books, Limited',
        publishedDate: '2023',
        coverUrl: 'https://covers.openlibrary.org/b/id/14421360-L.jpg',
        pageCount: 422,
      },
      {
        sourceId: 'OL66554W',
        title: 'Pride and Prejudice',
        // The best edition has no ISBN; another edition's ISBN would be wrong.
        isbn13: null,
        isbn10: null,
        language: 'eng',
        publisher: 'LibriVox',
        publishedDate: '2007-11-26',
        coverUrl: 'https://covers.openlibrary.org/b/id/8090214-L.jpg',
      },
    ]);
  });

  it('falls back to Google Books when Open Library finds nothing', async () => {
    setup();
    env.fetchMock.on(OL_SEARCH, () => json(OL_SEARCH_EMPTY));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_SEARCH_RESPONSE));
    const res = await env.request<BookCandidate[]>('GET', '/api/lookup/search?q=left+hand&page=3');
    expect(res.body.map((c) => [c.source, c.title, c.isbn13])).toEqual([
      ['googlebooks', 'The Left Hand of Darkness', '9780441478125'],
    ]);
    const url = new URL(env.fetchMock.calls[1]?.url ?? '');
    expect(url.searchParams.get('startIndex')).toBe('40');
    expect(url.searchParams.get('maxResults')).toBe('20');
  });

  it('returns an empty list when both sources find nothing', async () => {
    setup();
    env.fetchMock.on(OL_SEARCH, () => json(OL_SEARCH_EMPTY));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_EMPTY_RESPONSE));
    expect((await env.request('GET', '/api/lookup/search?q=zzzz')).body).toEqual([]);
  });

  it('uses Google when Open Library fails, and 502s when both fail', async () => {
    setup();
    env.fetchMock.on(OL_SEARCH, () => new Response('', { status: 503 }));
    env.fetchMock.on(GOOGLE, () => json(GOOGLE_EMPTY_RESPONSE));
    expect((await env.request('GET', '/api/lookup/search?q=dune')).body).toEqual([]);
    env.fetchMock.on(GOOGLE, () => new Response('', { status: 500 }));
    expect((await env.request('GET', '/api/lookup/search?q=dune')).status).toBe(502);
  });

  it('returns [] when Open Library is empty and Google fails', async () => {
    setup();
    env.fetchMock.on(OL_SEARCH, () => json(OL_SEARCH_EMPTY));
    env.fetchMock.on(GOOGLE, () => new Response('', { status: 500 }));
    expect((await env.request('GET', '/api/lookup/search?q=dune')).body).toEqual([]);
  });

  it('validates the query', async () => {
    setup();
    expect((await env.request('GET', '/api/lookup/search')).status).toBe(400);
    expect((await env.request('GET', '/api/lookup/search?q=dune&page=0')).status).toBe(400);
  });
});

describe('lookup helpers', () => {
  it('normalises published dates to YYYY, YYYY-MM or YYYY-MM-DD when recognisable', () => {
    const cases: [string | undefined, string | null][] = [
      [undefined, null],
      ['  ', null],
      ['2003', '2003'],
      ['2015-04-30', '2015-04-30'],
      ['2015-04', '2015-04'],
      ['May 04, 2021', '2021-05-04'],
      ['October 1, 1988', '1988-10-01'],
      ['Sept. 3, 2019', '2019-09-03'],
      ['4 May 2021', '2021-05-04'],
      ['April 2015', '2015-04'],
      ['Apr 2015', '2015-04'],
      ['c1995', '1995'],
      ['[2003]', '2003'],
      ['2003.', '2003'],
      ['February 30, 2020', 'February 30, 2020'],
      ['2015-13-01', '2015-13-01'],
      ['1990s', '1990s'],
      ['between 1920 and 1925', 'between 1920 and 1925'],
    ];
    for (const [raw, expected] of cases) {
      expect(normalisePublishedDate(raw), String(raw)).toBe(expected);
    }
  });

  it('cleans Open Library descriptions', () => {
    expect(cleanDescription('A tale.\r\n\r\nThe end.\r\n')).toBe('A tale.\n\nThe end.');
    expect(cleanDescription('Blurb text.\n--back cover')).toBe('Blurb text.');
    expect(cleanDescription('Blurb text. --')).toBe('Blurb text.');
    expect(
      cleanDescription(
        'A novel ([source][1])\n\n[1]: https://en.wikipedia.org/wiki/Novel\n\n\n\nMore.',
      ),
    ).toBe('A novel\n\nMore.');
    expect(cleanDescription('Box set.\n\n----------\n**Contains**\n\n- [Book one]')).toBe(
      'Box set.',
    );
    expect(cleanDescription('Dashes -- inside are kept.')).toBe('Dashes -- inside are kept.');
    expect(cleanDescription(' -- ')).toBeNull();
    expect(cleanDescription(undefined)).toBeNull();
  });

  it('cleans genres', () => {
    expect(
      cleanGenres([
        'Fiction / Fantasy / Epic',
        'fiction',
        'nyt:bestseller',
        '',
        'x'.repeat(61),
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
      ]),
    ).toEqual(['Fiction', 'Fantasy', 'Epic', 'A', 'B', 'C', 'D', 'E']);
  });

  it('converts HTML descriptions to text', () => {
    expect(
      htmlToText('<p>One&nbsp;&quot;two&quot;</p><p>It&#39;s &lt;3&gt;</p><br/><br/><br/>'),
    ).toBe('One "two"\n\nIt\'s <3>');
  });
});
