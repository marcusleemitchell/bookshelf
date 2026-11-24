import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bookpineReportSchema,
  MAX_BOOKPINE_CSV_BYTES,
  type BackupEnvelope,
  type BookDetail,
  type BookListItem,
  type BookNote,
  type BookpineReport,
  type Session,
  type Tag,
} from '../../shared/index.ts';
import { all } from '../db/database.ts';
import { importBookpine, previewBookpine } from '../services/bookpine.ts';
import { createTestEnv, image, json, type FetchCall, type TestEnv } from '../test/helpers.ts';

const FIXTURE = readFileSync(
  new URL('../test/fixtures/bookpine-export.csv', import.meta.url),
  'utf8',
);
const HEADER = FIXTURE.split('\n', 1)[0] as string;

const OL_BOOKS = 'https://openlibrary.org/api/books';
const OL_SEARCH = 'https://openlibrary.org/search.json';
const GOOGLE = 'https://www.googleapis.com/books/v1/volumes';
const COVERS = 'https://covers.openlibrary.org/';

/** Fictional Open Library records for two fixture books (by ISBN-13). */
const OL_RECORDS: Record<string, unknown> = {
  'ISBN:9781800000018': {
    key: '/books/OL101M',
    title: 'The Lantern Keeper',
    authors: [{ name: 'Ada Whitlock' }],
    number_of_pages: 410,
    publishers: [{ name: 'Fictional Press' }],
    subjects: [{ name: 'Lighthouses' }, { name: 'Fiction' }],
    identifiers: { openlibrary: ['OL101M'] },
    cover: { large: 'https://covers.openlibrary.org/b/id/101-L.jpg' },
  },
  'ISBN:9781800000117': {
    key: '/books/OL111M',
    title: 'Winter Almanac',
    authors: [{ name: 'Clara Voss' }],
    number_of_pages: 290,
    subjects: [{ name: 'Seasons' }],
    identifiers: { openlibrary: ['OL111M'] },
    cover: { large: 'https://covers.openlibrary.org/b/id/111-L.jpg' },
  },
};

let env: TestEnv;

/** Answers Open Library like the real service for the fictional fixture books. */
function fakeLookups(): void {
  env.fetchMock.on(OL_BOOKS, (call: FetchCall) => {
    const keys = new URL(call.url).searchParams.get('bibkeys')?.split(',') ?? [];
    const found = Object.fromEntries(
      keys.filter((key) => key in OL_RECORDS).map((key) => [key, OL_RECORDS[key]]),
    );
    return json(found);
  });
  env.fetchMock.on(/^https:\/\/openlibrary\.org\/books\/OL\d+M\.json$/, (call) =>
    json({
      description: `Synopsis from ${new URL(call.url).pathname}`,
      languages: [{ key: '/languages/eng' }],
    }),
  );
  env.fetchMock.on(OL_SEARCH, (call) => {
    const q = new URL(call.url).searchParams.get('q') ?? '';
    if (q.startsWith('Paper Harbour')) {
      return json({
        docs: [
          {
            key: '/works/OL1W',
            title: 'Paper Harbour',
            author_name: ['Ines Calloway'],
            subject: ['Harbours'],
            number_of_pages_median: 290,
          },
        ],
      });
    }
    return json({ docs: [] });
  });
  env.fetchMock.on(GOOGLE, () => json({ kind: 'books#volumes', totalItems: 0 }));
  env.fetchMock.on(COVERS, () => image());
}

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => {
  env.cleanup();
});

async function post(
  path: string,
  body: string | FormData,
  headers: Record<string, string> = { 'content-type': 'text/csv' },
): Promise<{ status: number; body: unknown }> {
  const res = await env.app.request(path, {
    method: 'POST',
    body,
    headers: { ...env.authHeaders(), ...headers },
  });
  const parsed: unknown = await res.json();
  return { status: res.status, body: parsed };
}

async function runImport(csv = FIXTURE): Promise<BookpineReport> {
  const res = await post('/api/import/bookpine', csv);
  expect(res.status).toBe(200);
  return bookpineReportSchema.parse(res.body);
}

function tableCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [
    'books',
    'book_formats',
    'reads',
    'sessions',
    'book_notes',
    'tags',
    'book_tags',
    'import_links',
  ]) {
    counts[table] =
      all<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? -1;
  }
  return counts;
}

async function books(): Promise<BookListItem[]> {
  return (await env.request<BookListItem[]>('GET', '/api/books')).body;
}

async function bookByTitle(title: string): Promise<BookDetail> {
  const found = (await books()).find((b) => b.title === title);
  if (!found) throw new Error(`No book "${title}"`);
  return (await env.request<BookDetail>('GET', `/api/books/${found.id}`)).body;
}

async function sessionsOf(bookId: string): Promise<Session[]> {
  return (await env.request<Session[]>('GET', `/api/sessions?bookId=${bookId}`)).body;
}

function snapshots(): string[] {
  return readdirSync(env.ctx.config.backupsDir).filter((f) => f.includes('pre-import'));
}

describe('POST /api/import/bookpine/preview', () => {
  it('reports what an import would do and writes nothing', async () => {
    const before = tableCounts();
    const res = await post('/api/import/bookpine/preview', FIXTURE);
    expect(res.status).toBe(200);
    const report = bookpineReportSchema.parse(res.body);
    expect(report).toMatchObject({
      dryRun: true,
      rows: 20,
      books: { created: 16, updated: 0, unchanged: 0, skipped: 0, matched: 0 },
      formats: { created: 18 },
      reads: { created: 12 },
      sessions: { created: 29, untimed: 29 },
      notes: { created: 2 },
      tags: { created: 5, names: ['favorites', 'owned', 'private', 'wishlist', 'Book club'] },
      enrichment: { pending: 16, found: 0, notFound: 0, failed: 0 },
      snapshot: null,
    });
    expect(report.merges).toEqual([
      {
        title: 'Orchard at Dusk',
        slugs: ['orchard-at-dusk-a-novel-1003', 'orchard-at-dusk-movie-tie-in-1004'],
      },
      {
        title: 'The Glass Cartographer, 10th Anniversary Edition',
        slugs: ['the-glass-cartographer-1005', 'the-glass-cartographer-10th-1006'],
      },
      {
        title: 'Tidewater',
        slugs: ['tidewater-songs-from-the-1007', 'tidewater-songs-from-the-1008'],
      },
      { title: 'Quiet Engines', slugs: ['quiet-engines-1013', 'quiet-engines-1014'] },
    ]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        { slug: 'copper-and-thyme-1019', message: 'Ignored the invalid ISBN-13 "9780000000000"' },
        {
          slug: null,
          message:
            'Not merged (same title, different first author): paper-harbour-1015, paper-harbour-1016',
        },
      ]),
    );
    expect(tableCounts()).toEqual(before);
    expect(snapshots()).toEqual([]);
    // No lookups or cover downloads during a preview.
    expect(env.fetchMock.calls).toEqual([]);
  });

  it('accepts a multipart upload', async () => {
    const form = new FormData();
    form.set('file', new File([FIXTURE], 'export.csv', { type: 'text/csv' }));
    const res = await post('/api/import/bookpine/preview', form, {});
    expect(res.status).toBe(200);
    expect(bookpineReportSchema.parse(res.body).rows).toBe(20);
  });

  it('rejects empty bodies, missing files, other CSVs and oversized uploads', async () => {
    const empty = await post('/api/import/bookpine/preview', '   ');
    expect(empty).toMatchObject({ status: 400, body: { error: { code: 'validation_error' } } });

    const noFile = new FormData();
    noFile.set('other', 'x');
    expect((await post('/api/import/bookpine/preview', noFile, {})).status).toBe(400);
    const textField = new FormData();
    textField.set('file', FIXTURE);
    expect((await post('/api/import/bookpine/preview', textField, {})).status).toBe(200);

    const other = await post('/api/import/bookpine/preview', 'title,author\nDune,Herbert\n');
    expect(other).toMatchObject({
      status: 400,
      body: {
        error: {
          message: expect.stringMatching(
            /^This is not a Bookpine export: missing columns slug, private/,
          ) as unknown,
        },
      },
    });
    const broken = await post('/api/import/bookpine/preview', `${HEADER}\nx,"unterminated\n`);
    expect(broken).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringContaining('not valid CSV') as unknown } },
    });
    const headerOnly = await post('/api/import/bookpine/preview', `${HEADER}\n`);
    expect(headerOnly).toMatchObject({
      status: 400,
      body: { error: { message: 'The Bookpine export has no books' } },
    });
    const huge = await post('/api/import/bookpine/preview', 'x'.repeat(MAX_BOOKPINE_CSV_BYTES + 1));
    expect(huge).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringContaining('larger than 5 MB') as unknown } },
    });
  });
});

describe('POST /api/import/bookpine', () => {
  it('snapshots first, enriches, imports everything and caches covers', async () => {
    fakeLookups();
    const report = await runImport();
    expect(report).toMatchObject({
      dryRun: false,
      books: { created: 16 },
      reads: { created: 12 },
      sessions: { created: 29, untimed: 29 },
      enrichment: { pending: 0, found: 4, notFound: 12, failed: 0 },
      covers: { cached: 2, failed: 0 },
    });
    expect(report.snapshot).toMatch(/^bookshelf-pre-import-.*\.json$/);
    expect(snapshots()).toEqual([report.snapshot]);
    // The snapshot holds the library as it was before the import (empty).
    const snapshot = JSON.parse(
      readFileSync(join(env.ctx.config.backupsDir, report.snapshot ?? ''), 'utf8'),
    ) as BackupEnvelope;
    expect(snapshot.data.books).toEqual([]);

    // Lookups are throttled: one pause between consecutive books.
    expect(env.sleeps.filter((ms) => ms === 1000)).toHaveLength(15);

    const lantern = await bookByTitle('The Lantern Keeper');
    expect(lantern).toMatchObject({
      status: 'finished',
      rating: 3,
      source: 'openlibrary',
      sourceId: 'OL101M',
      synopsis: 'Synopsis from /books/OL101M.json',
      genres: ['Lighthouses', 'Fiction'],
      publisher: 'Fictional Press',
      coverSrc: `/api/covers/${lantern.id}`,
    });
    expect(lantern.coverPath).toBe(`${lantern.id}.png`);
    // The Goodreads page count wins over the looked-up one (Bookpine data first).
    expect(lantern.formats).toMatchObject([{ format: 'physical', pageCount: 412 }]);
    expect(lantern.reads).toMatchObject([
      {
        number: 1,
        outcome: 'finished',
        startedAt: '2026-10-11T11:00:00.000Z',
        finishedAt: '2026-10-11T11:00:00.000Z',
      },
    ]);

    // Search is the last resort when there is no ISBN.
    const harbour = (await books()).find(
      (b) => b.title === 'Paper Harbour' && b.status === 'finished',
    );
    expect(harbour).toMatchObject({ genres: ['Harbours'] });
    const tags = (await env.request<Tag[]>('GET', '/api/tags')).body;
    const harbourTags = harbour?.tagIds.map((id) => tags.find((t) => t.id === id)?.name);
    expect(harbourTags?.sort()).toEqual(['owned', 'private']);

    // Unknown-duration sessions labelled as imported, bucketed on the local day.
    const orchard = await bookByTitle('Orchard at Dusk');
    const sessions = await sessionsOf(orchard.id);
    expect(sessions).toHaveLength(5);
    expect(sessions.every((s) => s.durationSeconds === null && s.source === 'bookpine')).toBe(true);
    expect(sessions.map((s) => s.startedAt).sort()[0]).toBe('2026-03-28T12:00:00.000Z');

    // Review and plain notes become notes; Goodreads blobs do not.
    const smallGods = await bookByTitle('Small Gods of the Hearth');
    const notes = (await env.request<BookNote[]>('GET', `/api/books/${smallGods.id}/notes`)).body;
    expect(notes.map((n) => [n.kind, n.text])).toEqual([
      ['note', 'Loved the ending.\nWould reread, "slowly".'],
      ['note', 'Lent to Sam; ask for it back'],
    ]);
  });

  it('is idempotent: re-importing the same file creates nothing and changes nothing', async () => {
    fakeLookups();
    await runImport();
    const counts = tableCounts();
    const exported = (await env.request<BackupEnvelope>('GET', '/api/backup/export')).body;
    env.clock.advance(60_000);
    const again = await runImport();
    expect(again).toMatchObject({
      books: { created: 0, updated: 0, unchanged: 16, skipped: 0 },
      formats: { created: 0, updated: 0, unchanged: 18 },
      reads: { created: 0, updated: 0, unchanged: 12 },
      sessions: { created: 0, updated: 0, unchanged: 29, untimed: 29 },
      notes: { created: 0, updated: 0, unchanged: 2 },
      tags: { created: 0, names: [] },
      keptEdits: 0,
    });
    expect(tableCounts()).toEqual(counts);
    const after = (await env.request<BackupEnvelope>('GET', '/api/backup/export')).body;
    expect(after.data.books).toEqual(exported.data.books);
    expect(after.data.sessions).toEqual(exported.data.sessions);
    expect(after.data.reads).toEqual(exported.data.reads);
  });

  it('updates changed fields on re-import but keeps the user’s edits and deletions', async () => {
    await runImport();
    const lantern = await bookByTitle('The Lantern Keeper');
    const ministry = await bookByTitle('The Ministry of Small Hours');
    // The user renames one book and deletes one imported session and a note.
    await env.request('PATCH', `/api/books/${lantern.id}`, { title: 'Lantern Keeper (signed)' });
    const orchard = await bookByTitle('Orchard at Dusk');
    const [firstDay] = (await sessionsOf(orchard.id)).sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
    await env.request('DELETE', `/api/sessions/${firstDay?.id ?? ''}`);
    // …and adds a duration to another, which the import must not undo.
    const [ministryDay] = await sessionsOf(ministry.id);
    await env.request('PATCH', `/api/sessions/${ministryDay?.id ?? ''}`, { durationSeconds: 1500 });

    // In Bookpine the rating changed and reading progressed.
    const changed = FIXTURE.replace(
      'The Lantern Keeper",,"Ada Whitlock",1800000014,9781800000018,2015-01-01,en,paperback,,Read,0,,3.00',
      'The Lantern Keeper",,"Ada Whitlock",1800000014,9781800000018,2015-01-01,en,paperback,,Read,0,,4.00',
    )
      .replace('The Lantern Keeper",', 'The Lantern Keeper: Revised",')
      .replace(
        'length=368;length_type=page;progress=21',
        'length=368;length_type=page;progress=60',
      );
    env.clock.advance(60_000);
    const report = await runImport(changed);
    expect(report.books.updated).toBe(1);
    expect(report.keptEdits).toBeGreaterThanOrEqual(1);
    expect(report.sessions).toMatchObject({ created: 0, updated: 1, skipped: 1, untimed: 27 });

    const renamed = (await env.request<BookDetail>('GET', `/api/books/${lantern.id}`)).body;
    expect(renamed.title).toBe('Lantern Keeper (signed)');
    expect(renamed.subtitle).toBe('Revised');
    expect(renamed.rating).toBe(4);
    expect(await sessionsOf(orchard.id)).toHaveLength(4);
    const [progressed] = await sessionsOf(ministry.id);
    expect(progressed).toMatchObject({ endValue: 60, endPercent: 16.3, durationSeconds: 1500 });
  });

  it('updates and skips formats, reads and notes at every level on re-import', async () => {
    await runImport();
    const smallGods = await bookByTitle('Small Gods of the Hearth');
    const ministry = await bookByTitle('The Ministry of Small Hours');
    const [review, lent] = (
      await env.request<BookNote[]>('GET', `/api/books/${smallGods.id}/notes`)
    ).body;
    await env.request('DELETE', `/api/books/${smallGods.id}/notes/${lent?.id ?? ''}`);
    await env.request(
      'DELETE',
      `/api/books/${smallGods.id}/formats/${smallGods.formats[0]?.id ?? ''}`,
    );
    const winter = await bookByTitle('Winter Almanac');
    await env.request('PATCH', `/api/books/${winter.id}`, { status: 'to_read' });
    const changed = FIXTURE.replace('Would reread, ""slowly"".', 'Would reread.')
      // Finished in Bookpine since the last export.
      .replace(
        'The Ministry of Small Hours",,"Priya Nandakumar",180000012X,9781800000124,2024-05-07,en,paperback,,Currently Reading',
        'The Ministry of Small Hours",,"Priya Nandakumar",180000012X,9781800000124,2024-05-07,en,paperback,368,Read',
      )
      .replace(
        'started_at=2026-11-12;finished_at=;status=in-progress;format=paperback;length=368;length_type=page;progress=21',
        'started_at=2026-11-12;finished_at=2026-11-13;status=finished;format=paperback;length=368;length_type=page;progress=368',
      );
    env.clock.advance(60_000);
    const report = await runImport(changed);
    expect(report.notes).toMatchObject({ updated: 1, skipped: 1 });
    expect(report.formats.skipped).toBe(1);
    expect(report.reads.updated).toBe(1);
    const notes = (await env.request<BookNote[]>('GET', `/api/books/${smallGods.id}/notes`)).body;
    expect(notes.map((n) => [n.id, n.text])).toEqual([
      [review?.id, 'Loved the ending.\nWould reread.'],
    ]);
    const finished = (await env.request<BookDetail>('GET', `/api/books/${ministry.id}`)).body;
    expect(finished.status).toBe('finished');
    expect(finished.currentRead).toMatchObject({
      outcome: 'finished',
      finishedAt: '2026-11-13T12:00:00.000Z',
    });
    const [session] = await sessionsOf(ministry.id);
    expect(session).toMatchObject({ endValue: 368, endPercent: 100 });
    expect(session?.startedAt).toBe('2026-11-13T12:00:00.000Z');
    // The user's status change on Winter Almanac is kept.
    expect((await env.request<BookDetail>('GET', `/api/books/${winter.id}`)).body.status).toBe(
      'to_read',
    );

    // A read deleted in Bookshelf (via sync; REST has no read deletion) stays deleted.
    const orchard = await bookByTitle('Orchard at Dusk');
    env.ctx.db
      .prepare('UPDATE reads SET deleted_at = ? WHERE book_id = ?')
      .run('2026-11-14T12:00:00.000Z', orchard.id);
    const third = await runImport(changed);
    expect(third.reads.skipped).toBe(1);
    expect(third.sessions.skipped).toBeGreaterThanOrEqual(5);
  });

  it('joins editions imported separately before once they merge', async () => {
    const apart = FIXTURE.replace(
      '"Orchard at Dusk (Movie Tie-In): A Novel"',
      '"Orchard in Winter (Movie Tie-In): A Novel"',
    );
    await runImport(apart);
    const report = await runImport();
    expect(report.warnings).toContainEqual({
      slug: 'orchard-at-dusk-a-novel-1003',
      message:
        'These editions were imported as 2 separate books before; updating the first and linking the others to it',
    });
    expect(report.books.created).toBe(0);
  });

  it('does not re-create a book the user deleted', async () => {
    await runImport();
    const lantern = await bookByTitle('The Lantern Keeper');
    await env.request('DELETE', `/api/books/${lantern.id}`);
    const report = await runImport();
    expect(report.books).toMatchObject({ created: 0, skipped: 1 });
    expect(report.warnings).toContainEqual({
      slug: 'the-lantern-keeper-1001',
      message: 'Deleted in Bookshelf after an earlier import; not imported again',
    });
    expect((await books()).some((b) => b.title === 'The Lantern Keeper')).toBe(false);
  });

  it('links a book already in the library instead of duplicating it', async () => {
    const existing = (
      await env.request<BookDetail>('POST', '/api/books', {
        title: 'The Ministry of Small Hours',
        authors: ['Priya Nandakumar'],
        isbn13: '9781800000124',
        status: 'reading',
        synopsis: 'My own synopsis',
        formats: [{ format: 'physical', pageCount: 360 }],
      })
    ).body;
    const winter = (
      await env.request<BookDetail>('POST', '/api/books', {
        title: 'Winter Almanac',
        subtitle: 'A Novel',
        authors: ['Clara Voss'],
        status: 'to_read',
      })
    ).body;
    const report = await runImport();
    expect(report.books).toMatchObject({ created: 14, matched: 2 });
    expect(report.warnings).toContainEqual({
      slug: 'the-ministry-of-small-hours-1012',
      message:
        'Linked to “The Ministry of Small Hours”, already in your library, instead of adding it again',
    });
    expect(report.warnings).toContainEqual({
      slug: 'the-ministry-of-small-hours-1012',
      message: 'Already has reading history in Bookshelf; its Bookpine readings were not imported',
    });
    const ministry = (await env.request<BookDetail>('GET', `/api/books/${existing.id}`)).body;
    expect(ministry.synopsis).toBe('My own synopsis');
    expect(ministry.formats).toMatchObject([{ format: 'physical', pageCount: 360 }]);
    expect(await sessionsOf(existing.id)).toEqual([]);
    // Matched by title + author: it had no reads, so its readings were imported;
    // its status was the user's and is kept.
    const almanac = (await env.request<BookDetail>('GET', `/api/books/${winter.id}`)).body;
    expect(almanac.status).toBe('to_read');
    expect(almanac.reads).toHaveLength(1);
    expect(almanac.formats.map((f) => f.format)).toEqual(['physical', 'audiobook']);
    // Re-importing now finds them through provenance.
    const again = await runImport();
    expect(again.books).toMatchObject({ created: 0, matched: 0, unchanged: 16 });
  });

  it('reports lookup failures without failing the import', async () => {
    env.fetchMock.on(
      () => true,
      () => new Response('down', { status: 503 }),
    );
    const report = await runImport();
    expect(report.books.created).toBe(16);
    expect(report.enrichment).toMatchObject({ found: 0, failed: 16 });
    expect(report.warnings).toContainEqual({
      slug: 'the-lantern-keeper-1001',
      message:
        'Lookup failed (Book search services are unavailable; try again later); imported without a cover or synopsis',
    });
  });

  it('falls back to search when Google Books refuses keyless ISBN lookups', async () => {
    fakeLookups();
    env.fetchMock.on(GOOGLE, () => new Response('quota', { status: 429 }));
    const report = await runImport();
    // Unknown ISBNs now give 502 (a source failed), which still moves on to the search.
    expect(report.enrichment).toEqual({ pending: 0, found: 4, notFound: 12, failed: 0 });
    expect(
      env.fetchMock.calls.filter((call) => call.url.startsWith(OL_SEARCH)).length,
    ).toBeGreaterThanOrEqual(12);
  });

  it('counts covers that could not be downloaded', async () => {
    fakeLookups();
    env.fetchMock.on(COVERS, () => new Response('gone', { status: 404 }));
    const report = await runImport();
    expect(report.covers).toEqual({ cached: 0, failed: 2 });
  });

  it('refuses a second import while one is running', async () => {
    let release: () => void = () => undefined;
    env.fetchMock.on(
      () => true,
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(json({}));
          };
        }),
    );
    const first = importBookpine(env.ctx, FIXTURE);
    await expect(previewBookpine(env.ctx, FIXTURE)).rejects.toMatchObject({
      status: 409,
      message: 'A Bookpine import is already running',
    });
    env.fetchMock.on(
      () => true,
      () => json({}),
    );
    release();
    await first;
    expect((await previewBookpine(env.ctx, FIXTURE)).books.unchanged).toBe(16);
  });

  it('keeps provenance in backups so a restored library re-imports without duplicates', async () => {
    await runImport();
    const backup = (await env.request<BackupEnvelope>('GET', '/api/backup/export')).body;
    expect(backup.data.importLinks.length).toBeGreaterThan(0);
    expect((await env.request('POST', '/api/backup/import', backup)).status).toBe(200);
    const again = await runImport();
    expect(again.books).toMatchObject({ created: 0, unchanged: 16 });
  });
});
