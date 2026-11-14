import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ImportWarning } from '../../shared/index.ts';
import {
  BOOKPINE_COLUMNS,
  BookpineFormatError,
  parseBookpineCsv,
  parseGoodreads,
  parseNotes,
  parseReadings,
  splitAuthors,
} from './bookpine.ts';

const FIXTURE = readFileSync(
  new URL('../test/fixtures/bookpine-export.csv', import.meta.url),
  'utf8',
);
const HEADER = BOOKPINE_COLUMNS.join(',');

/** A one-row export with the given cells (others empty). */
function csv(cells: Partial<Record<(typeof BOOKPINE_COLUMNS)[number], string>>): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return `${HEADER}\n${BOOKPINE_COLUMNS.map((column) => quote(cells[column] ?? '')).join(',')}\n`;
}

describe('splitAuthors', () => {
  it('splits on commas, keeping suffixes with their name', () => {
    expect(splitAuthors('Ada Whitlock, Wei  Chen')).toEqual(['Ada Whitlock', 'Wei Chen']);
    expect(splitAuthors('Martin Gale, Jr., Ruth Gale')).toEqual(['Martin Gale, Jr.', 'Ruth Gale']);
    expect(splitAuthors('Jr., Someone')).toEqual(['Jr.', 'Someone']);
    expect(splitAuthors(' , ')).toEqual([]);
  });
});

describe('parseReadings', () => {
  it('parses `||`-separated entries of `key=value` pairs', () => {
    const warnings: ImportWarning[] = [];
    const readings = parseReadings(
      'started_at=2026-03-02;finished_at=2026-03-03;status=finished;format=spiral-bound;length=100;length_type=percent;progress=100||started_at=;finished_at=;status=In-Progress;format=paperback;length=368;length_type=page;progress=21',
      'slug',
      warnings,
    );
    expect(readings).toEqual([
      {
        index: 0,
        startedAt: '2026-03-02',
        finishedAt: '2026-03-03',
        status: 'finished',
        format: 'spiral-bound',
        length: 100,
        lengthType: 'percent',
        progress: 100,
      },
      {
        index: 1,
        startedAt: null,
        finishedAt: null,
        status: 'in-progress',
        format: 'paperback',
        length: 368,
        lengthType: 'page',
        progress: 21,
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it('tolerates junk: bad dates (warned), unknown length types, missing values', () => {
    const warnings: ImportWarning[] = [];
    const [reading] = parseReadings(
      'started_at=12/03/2026;finished_at=2026-02-30;status=;length=abc;length_type=chapter;noise;=x',
      'slug',
      warnings,
    );
    expect(reading).toEqual({
      index: 0,
      startedAt: null,
      finishedAt: null,
      status: '',
      format: null,
      length: null,
      lengthType: null,
      progress: null,
    });
    expect(warnings.map((w) => w.message)).toEqual([
      'Reading 1: ignored the invalid date started_at="12/03/2026"',
      'Reading 1: ignored the invalid date finished_at="2026-02-30"',
    ]);
    expect(parseReadings('  ', 'slug', warnings)).toEqual([]);
  });
});

describe('notes and Goodreads blobs', () => {
  it('splits notes on `||` before `date=` and detects Goodreads blobs', () => {
    const notes = parseNotes(
      'date=2026-09-01;content=Lent to Sam || still lent||date=2026-10-11;content=Book Id: -\nNumber of Pages: 300\nDate Read: 2026/09/01\nMy Review: -\nPrivate Notes: -',
    );
    expect(notes).toEqual([
      { date: '2026-09-01', content: 'Lent to Sam || still lent', goodreads: null },
      {
        date: '2026-10-11',
        content:
          'Book Id: -\nNumber of Pages: 300\nDate Read: 2026/09/01\nMy Review: -\nPrivate Notes: -',
        goodreads: { pages: 300, dateRead: '2026-09-01', hasText: false },
      },
    ]);
  });

  it('keeps unstructured notes whole and drops empty ones', () => {
    expect(parseNotes('just a thought')).toEqual([
      { date: null, content: 'just a thought', goodreads: null },
    ]);
    expect(parseNotes('date=bad;content=x')).toEqual([
      { date: null, content: 'x', goodreads: null },
    ]);
    expect(parseNotes('date=2026-01-01;content=   ')).toEqual([]);
    expect(parseNotes('')).toEqual([]);
  });

  it('reads Goodreads page counts, read dates and review text defensively', () => {
    expect(parseGoodreads('Book Id: -\r\nNumber of Pages: -\r\nDate Read: -')).toEqual({
      pages: null,
      dateRead: null,
      hasText: false,
    });
    expect(
      parseGoodreads(
        'Book Id: 1\nNumber of Pages: 0\nDate Read: 2026/02/30\nMy Review: Great: really',
      ),
    ).toEqual({ pages: null, dateRead: null, hasText: true });
    expect(parseGoodreads('Number of Pages: 12.5\nPrivate Notes: shelf B')).toEqual({
      pages: null,
      dateRead: null,
      hasText: true,
    });
  });
});

describe('parseBookpineCsv', () => {
  it('parses the fixture export, every row and cell type', () => {
    const { rows, warnings } = parseBookpineCsv(FIXTURE);
    expect(rows).toHaveLength(20);
    const lantern = rows[0];
    expect(lantern).toMatchObject({
      line: 2,
      slug: 'the-lantern-keeper-1001',
      title: 'The Lantern Keeper',
      private: false,
      authors: ['Ada Whitlock'],
      isbn10: '1800000014',
      isbn13: '9781800000018',
      publicationDate: '2015-01-01',
      language: 'en',
      format: 'paperback',
      pagesMinutes: null,
      shelves: ['Read'],
      owned: false,
      lists: [],
      rating: 3,
      review: null,
      transactions: null,
    });
    expect(lantern?.notes[0]?.goodreads).toEqual({
      pages: 412,
      dateRead: '2026-10-11',
      hasText: false,
    });
    const chinese = rows.find((r) => r.language === 'zh');
    expect(chinese?.title).toBe('盐之路 [Yan zhi lu]');
    const harbour = rows.find((r) => r.slug === 'paper-harbour-1015');
    expect(harbour).toMatchObject({ private: true, owned: true, isbn10: null, isbn13: null });
    const crown = rows.find((r) => r.slug === 'the-hollow-crown-1017');
    expect(crown).toMatchObject({ shelves: ['Want To Read', 'wishlist'], lists: ['Book club'] });
    const reeds = rows.find((r) => r.slug === 'voices-in-the-reeds-1020');
    expect(reeds).toMatchObject({ format: 'audiobook', pagesMinutes: 600 });
    const review = rows.find((r) => r.slug === 'small-gods-of-the-hearth-1018');
    expect(review?.review).toBe('Loved the ending.\nWould reread, "slowly".');
    expect(warnings).toEqual([
      { slug: 'copper-and-thyme-1019', message: 'Ignored the invalid ISBN-13 "9780000000000"' },
    ]);
  });

  it('accepts columns in any order, ignoring unknown ones with a warning', () => {
    const reordered = `extra,${[...BOOKPINE_COLUMNS].reverse().join(',')}\nx,${[...BOOKPINE_COLUMNS]
      .reverse()
      .map((column) => (column === 'slug' ? 's-1' : column === 'title' ? 'T' : ''))
      .join(',')}\n`;
    const { rows, warnings } = parseBookpineCsv(reordered);
    expect(rows.map((r) => [r.slug, r.title])).toEqual([['s-1', 'T']]);
    expect(warnings).toEqual([{ slug: null, message: 'Ignored unknown columns: extra' }]);
  });

  it('skips rows without a slug or title and duplicate slugs, with warnings', () => {
    const text = `${HEADER}\n,No slug${','.repeat(16)}\ns-1,${','.repeat(16)}\ns-2,First${','.repeat(16)}\ns-2,Again${','.repeat(16)}\n`;
    const { rows, warnings } = parseBookpineCsv(text);
    expect(rows.map((r) => r.title)).toEqual(['First']);
    expect(warnings).toEqual([
      { slug: null, message: 'Skipped the row on line 2: no slug' },
      { slug: 's-1', message: 'Skipped: the row has no title' },
      { slug: 's-2', message: 'Skipped a second row with the same slug (line 5)' },
    ]);
  });

  it('normalises flags, ratings, numbers and ISBNs', () => {
    const { rows, warnings } = parseBookpineCsv(
      csv({
        slug: 's',
        title: 'T',
        private: 'true',
        owned: 'yes',
        rating: '0.00',
        pages_minutes: '-3',
        isbn_10: '1-80000-001-4',
        language: 'EN',
        format: ' Hardcover ',
        transactions: 'sold',
      }),
    );
    expect(rows[0]).toMatchObject({
      private: true,
      owned: true,
      rating: null,
      pagesMinutes: null,
      isbn10: '1800000014',
      language: 'en',
      format: 'hardcover',
      transactions: 'sold',
    });
    expect(warnings).toEqual([]);
    const bad = parseBookpineCsv(csv({ slug: 's', title: 'T', rating: '3.25' }));
    expect(bad.rows[0]?.rating).toBeNull();
    expect(bad.warnings).toEqual([
      { slug: 's', message: 'Ignored the rating "3.25" (not 0.5–5 in half steps)' },
    ]);
  });

  it('refuses files that are not Bookpine exports', () => {
    expect(() => parseBookpineCsv('')).toThrow(new BookpineFormatError('The file is empty'));
    expect(() => parseBookpineCsv('slug,title\n')).toThrow(
      /^This is not a Bookpine export: missing columns private, authors/,
    );
    expect(() => parseBookpineCsv(HEADER.replace(',transactions', ''))).toThrow(
      'This is not a Bookpine export: missing column transactions',
    );
    expect(() => parseBookpineCsv(`${HEADER}\n"oops`)).toThrow(
      /^The file is not valid CSV: Unterminated quoted field \(line 2\)$/,
    );
  });
});
