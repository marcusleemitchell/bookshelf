import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBookpineCsv, type BookpineReading, type BookpineRow } from './bookpine.ts';
import {
  bookFormatType,
  normaliseKey,
  planImport,
  READ_GAP_DAYS,
  splitTitle,
  STATUS_PRECEDENCE,
  subtitleClusters,
  subtitlesCompatible,
  titleKeys,
  type PlannedBook,
} from './plan.ts';

const TZ = 'Europe/London';
let line = 1;

function row(overrides: Partial<BookpineRow> = {}): BookpineRow {
  line += 1;
  return {
    line,
    slug: `book-${line}`,
    title: 'A Quiet Book',
    private: false,
    authors: ['Ann Author'],
    isbn10: null,
    isbn13: null,
    publicationDate: null,
    language: 'en',
    format: 'paperback',
    pagesMinutes: null,
    shelves: ['Read'],
    owned: false,
    lists: [],
    rating: null,
    review: null,
    notes: [],
    readings: [],
    transactions: null,
    ...overrides,
  };
}

function reading(overrides: Partial<BookpineReading> = {}): BookpineReading {
  return {
    index: 0,
    startedAt: null,
    finishedAt: null,
    status: 'finished',
    format: 'paperback',
    length: 100,
    lengthType: 'percent',
    progress: 100,
    ...overrides,
  };
}

/** Daily 100 % "finished" markers, as Bookpine records reading days. */
function days(...dates: string[]): BookpineReading[] {
  return dates.map((date, index) =>
    reading({ index, startedAt: date, finishedAt: date, format: 'spiral-bound' }),
  );
}

function plan(...rows: BookpineRow[]) {
  return planImport({ rows, warnings: [] }, TZ);
}

function only(...rows: BookpineRow[]): PlannedBook {
  const result = plan(...rows);
  expect(result.books).toHaveLength(1);
  return result.books[0] as PlannedBook;
}

function readSummary(book: PlannedBook) {
  return book.reads.map((r) => [
    r.startedAt.slice(0, 10),
    r.finishedAt?.slice(0, 10) ?? null,
    r.outcome,
    r.sessions.length,
  ]);
}

describe('normalisation', () => {
  it('compares titles ignoring case, accents, punctuation and "&"', () => {
    expect(normaliseKey('  Café — Crème & Brûlée!  ')).toBe('cafe creme and brulee');
    expect(normaliseKey('盐之路')).toBe('盐之路');
    expect(titleKeys('Orchard at Dusk (Movie Tie-In): A Novel')).toEqual({
      main: 'orchard at dusk',
      subtitle: 'a novel',
    });
    expect(titleKeys('The Glass Cartographer, 10th Anniversary Edition')).toEqual({
      main: 'the glass cartographer',
      subtitle: '',
    });
    expect(titleKeys('盐之路 [Yan zhi lu]').main).toBe('盐之路');
    // A title that is all brackets falls back to the whole title.
    expect(titleKeys('(Untitled)').main).toBe('untitled');
  });

  it('splits stored titles at the first colon', () => {
    expect(splitTitle('Tidewater: Songs: More')).toEqual({
      title: 'Tidewater',
      subtitle: 'Songs: More',
    });
    expect(splitTitle('Plain')).toEqual({ title: 'Plain', subtitle: null });
    expect(splitTitle(': Odd')).toEqual({ title: ': Odd', subtitle: null });
    expect(splitTitle('Trailing:')).toEqual({ title: 'Trailing', subtitle: null });
  });

  it('treats a subtitle that extends another as compatible', () => {
    expect(subtitlesCompatible('tales of song', 'tales of song the memoir')).toBe(true);
    expect(subtitlesCompatible('tales of song', 'tales of songs')).toBe(false);
    expect(subtitleClusters(['b c', 'a', 'a b', '', 'a c', 'a'])).toEqual([
      new Set(['a', 'a b']),
      new Set(['a c']),
      new Set(['b c']),
    ]);
  });

  it('maps book-level formats, flagging unknown ones', () => {
    expect(bookFormatType('Paperback')).toEqual({ type: 'physical', known: true });
    expect(bookFormatType('hardcover')).toEqual({ type: 'physical', known: true });
    expect(bookFormatType('kindle')).toEqual({ type: 'kindle', known: true });
    expect(bookFormatType('ebook')).toEqual({ type: 'kindle', known: true });
    expect(bookFormatType('audio')).toEqual({ type: 'audiobook', known: true });
    expect(bookFormatType('scroll')).toEqual({ type: 'physical', known: false });
  });
});

describe('status and tags', () => {
  it('maps the first built-in shelf to the status and other shelves to tags', () => {
    const shelves: [string[], string][] = [
      [['Read', 'favorites'], 'finished'],
      [['Currently Reading'], 'reading'],
      [['Want To Read', 'wishlist'], 'to_read'],
      [['Paused'], 'paused'],
      [['Did Not Finish'], 'dnf'],
    ];
    for (const [given, status] of shelves) {
      expect(only(row({ shelves: given })).status).toBe(status);
    }
    expect(only(row({ shelves: ['Read', 'favorites'] })).tags).toEqual(['favorites']);
  });

  it('warns about a missing or conflicting status shelf', () => {
    const missing = plan(row({ slug: 'x', shelves: ['favorites'] }));
    expect(missing.books[0]?.status).toBe('to_read');
    expect(missing.warnings).toEqual([
      { slug: 'x', message: 'No status shelf; imported as To read' },
    ]);
    const both = plan(row({ slug: 'y', shelves: ['Read', 'Currently Reading', 'Read'] }));
    expect(both.books[0]?.status).toBe('finished');
    expect(both.warnings).toEqual([
      { slug: 'y', message: 'Shelved as both "Read" and "Currently Reading"; used the first' },
    ]);
  });

  it('adds lists, owned and private as tags, de-duplicated and shortened', () => {
    const long = 'x'.repeat(60);
    const result = plan(
      row({
        slug: 't',
        shelves: ['Read', 'Favourites', 'favourites'],
        lists: ['Book club', long],
        owned: true,
        private: true,
      }),
    );
    expect(result.books[0]?.tags).toEqual([
      'Favourites',
      'Book club',
      'x'.repeat(50),
      'owned',
      'private',
    ]);
    expect(result.warnings).toContainEqual({
      slug: 't',
      message: `Shortened the tag "${long}" to 50 characters`,
    });
  });

  it('reports unknown formats, transactions and Goodreads review text', () => {
    const result = plan(
      row({
        slug: 'w',
        format: 'scroll',
        transactions: 'sold',
        notes: [
          {
            date: null,
            content: 'Book Id: 1',
            goodreads: { pages: null, dateRead: null, hasText: true },
          },
        ],
      }),
    );
    expect(result.warnings.map((w) => w.message)).toEqual([
      'Unknown format "scroll"; imported as a physical book',
      'Transactions are not imported',
      'The Goodreads note has review or private-note text, which is not imported',
    ]);
  });
});

describe('merging duplicate editions', () => {
  it('merges by title and first author, keeping the highest rating and every format', () => {
    const book = only(
      row({ slug: 'b', title: 'Orchard at Dusk: A Novel', rating: 4, isbn13: '9781800000032' }),
      row({
        slug: 'a',
        title: 'Orchard at Dusk (Movie Tie-In): A Novel',
        authors: ['Ann  AUTHOR', 'Second'],
        format: 'kindle',
        rating: 4.5,
        isbn10: '1800000030',
      }),
    );
    expect(book).toMatchObject({
      slugs: ['b', 'a'],
      anchor: 'a',
      title: 'Orchard at Dusk',
      subtitle: 'A Novel',
      authors: ['Ann Author'],
      rating: 4.5,
      isbn13: '9781800000032',
      isbn10: '1800000030',
      isbns: ['9781800000032', '1800000030'],
    });
    expect(book.formats.map((f) => [f.type, f.isbn])).toEqual([
      ['physical', '9781800000032'],
      ['kindle', '1800000030'],
    ]);
  });

  it('uses the status precedence reading > paused > finished > dnf > to read', () => {
    expect(STATUS_PRECEDENCE).toEqual(['reading', 'paused', 'finished', 'dnf', 'to_read']);
    const book = only(
      row({ title: 'X', shelves: ['Want To Read'] }),
      row({ title: 'X', shelves: ['Paused'] }),
      row({ title: 'X, Deluxe Edition', shelves: ['Read'] }),
    );
    expect(book.status).toBe('paused');
    // The primary edition is the first one with the winning status.
    expect(
      only(
        row({ title: 'Y: One', shelves: ['Read'] }),
        row({ title: 'Y', shelves: ['Currently Reading'] }),
      ),
    ).toMatchObject({ status: 'reading', title: 'Y', subtitle: null });
  });

  it('does not merge different first authors or conflicting subtitles', () => {
    const result = plan(
      row({ slug: 'p1', title: 'Paper Harbour', authors: ['Ines Calloway'] }),
      row({ slug: 'p2', title: 'Paper Harbour', authors: ['Ines Caloway'] }),
      row({ slug: 'e1', title: 'Ember: First Contact' }),
      row({ slug: 'e2', title: 'Ember: The Long Silence' }),
      row({ slug: 'e3', title: 'Ember' }),
      row({ slug: 't1', title: 'Tide: Songs' }),
      row({ slug: 't2', title: 'Tide: Songs of the Estuary' }),
      row({ slug: 't3', title: 'Tide' }),
    );
    expect(result.books.map((b) => b.slugs)).toEqual([
      ['p1'],
      ['p2'],
      ['e1'],
      ['e2'],
      ['e3'],
      ['t1', 't2', 't3'],
    ]);
    expect(result.merges).toEqual([{ title: 'Tide', slugs: ['t1', 't2', 't3'] }]);
    expect(result.warnings).toEqual([
      { slug: null, message: 'Not merged (same title, different first author): p1, p2' },
      { slug: null, message: 'Not merged (same title, different subtitles): e1, e2, e3' },
    ]);
  });
});

describe('formats', () => {
  it('takes lengths from pages_minutes, then page readings, then Goodreads', () => {
    const goodreads = (pages: number) => [
      { date: null, content: 'Book Id: -', goodreads: { pages, dateRead: null, hasText: false } },
    ];
    expect(only(row({ pagesMinutes: 300, notes: goodreads(310) })).formats[0]?.pageCount).toBe(300);
    expect(
      only(
        row({
          readings: [reading({ length: 320, lengthType: 'page', progress: 320 })],
          notes: goodreads(310),
        }),
      ).formats[0]?.pageCount,
    ).toBe(320);
    expect(only(row({ notes: goodreads(310) })).formats[0]?.pageCount).toBe(310);
    expect(only(row()).formats[0]?.pageCount).toBeNull();
  });

  it('adds an audiobook format for minute readings and reads audiobook lengths in minutes', () => {
    const listened = only(
      row({
        format: 'hardcover',
        readings: [
          reading({
            startedAt: '2026-10-11',
            finishedAt: '2026-11-01',
            format: 'audiobook',
            length: 537,
            lengthType: 'minute',
            progress: 537,
          }),
        ],
      }),
    );
    expect(listened.formats).toEqual([
      { type: 'physical', pageCount: null, audioDurationSeconds: null, isbn: null },
      { type: 'audiobook', pageCount: null, audioDurationSeconds: 32_220, isbn: null },
    ]);
    expect(listened.reads[0]?.sessions[0]).toMatchObject({
      format: 'audiobook',
      day: '2026-11-01',
      progressUnit: 'audio_seconds',
      startValue: 0,
      endValue: 32_220,
    });
    expect(only(row({ format: 'audiobook', pagesMinutes: 600 })).formats).toEqual([
      { type: 'audiobook', pageCount: null, audioDurationSeconds: 36_000, isbn: null },
    ]);
    expect(only(row({ format: 'audiobook' })).formats[0]?.audioDurationSeconds).toBeNull();
  });
});

describe('reads and sessions', () => {
  it('turns consecutive reading days into one read with one untimed session per day', () => {
    const book = only(row({ readings: days('2026-03-02', '2026-03-03', '2026-03-05') }));
    expect(readSummary(book)).toEqual([['2026-03-02', '2026-03-05', 'finished', 3]]);
    expect(book.reads[0]?.sessions[0]).toEqual({
      suffix: 'day:2026-03-02',
      format: 'physical',
      day: '2026-03-02',
      startedAt: '2026-03-02T12:00:00.000Z',
      endedAt: '2026-03-02T12:00:00.000Z',
      progressUnit: 'percent',
      startValue: null,
      endValue: null,
    });
    // Summer time: local noon is 11:00 UTC.
    expect(only(row({ readings: days('2026-07-01') })).reads[0]?.startedAt).toBe(
      '2026-07-01T11:00:00.000Z',
    );
  });

  it('keeps the read open for reading and paused books; dnf closes it as dnf', () => {
    const readings = days('2026-04-26', '2026-04-27');
    expect(readSummary(only(row({ shelves: ['Currently Reading'], readings })))).toEqual([
      ['2026-04-26', null, 'in_progress', 2],
    ]);
    expect(readSummary(only(row({ shelves: ['Paused'], readings })))).toEqual([
      ['2026-04-26', null, 'in_progress', 2],
    ]);
    expect(readSummary(only(row({ shelves: ['DNF'], readings })))).toEqual([
      ['2026-04-26', '2026-04-27', 'dnf', 2],
    ]);
  });

  it(`starts a new read after a gap of more than ${READ_GAP_DAYS} days`, () => {
    const book = only(
      row({ readings: days('2025-01-01', '2025-01-02', '2025-07-01', '2026-01-01') }),
    );
    // 2025-01-02 → 2025-07-01 is 180 days (same read); → 2026-01-01 is 184 days.
    expect(readSummary(book)).toEqual([
      ['2025-01-01', '2025-07-01', 'finished', 3],
      ['2026-01-01', '2026-01-01', 'finished', 1],
    ]);
    expect(book.reads.map((r) => r.suffix)).toEqual(['read:1', 'read:2']);
  });

  it('uses the start (or the finish when there is none) as the day, ignoring stray finish dates', () => {
    const book = only(
      row({
        readings: [
          reading({ startedAt: '2026-06-04', finishedAt: null }),
          reading({ index: 1, startedAt: '2026-06-06', finishedAt: '2026-10-12' }),
          reading({ index: 2, startedAt: null, finishedAt: '2026-06-08' }),
        ],
      }),
    );
    expect(book.reads[0]?.sessions.map((s) => s.day)).toEqual([
      '2026-06-04',
      '2026-06-06',
      '2026-06-08',
    ]);
    expect(book.reads[0]?.finishedAt?.slice(0, 10)).toBe('2026-06-08');
  });

  it('records one session per day when duplicate editions logged the same day', () => {
    const book = only(
      row({ slug: 'k', format: 'kindle', readings: days('2026-08-23', '2026-08-24') }),
      row({ slug: 'h', format: 'hardcover', readings: days('2026-08-24') }),
    );
    expect(book.reads[0]?.sessions.map((s) => [s.day, s.format])).toEqual([
      ['2026-08-23', 'kindle'],
      ['2026-08-24', 'physical'],
    ]);
  });

  it('turns a page-progress entry into the current read with a session carrying the progress', () => {
    const book = only(
      row({
        shelves: ['Currently Reading'],
        readings: [
          reading({
            startedAt: '2026-11-12',
            status: 'in-progress',
            length: 368,
            lengthType: 'page',
            progress: 21,
          }),
        ],
      }),
    );
    expect(readSummary(book)).toEqual([['2026-11-12', null, 'in_progress', 1]]);
    expect(book.formats[0]?.pageCount).toBe(368);
    expect(book.reads[0]?.sessions[0]).toMatchObject({
      suffix: `progress:${book.anchor}:2026-11-12`,
      day: '2026-11-12',
      progressUnit: 'pages',
      startValue: 0,
      endValue: 21,
    });
  });

  it('chains days and progress entries; finished read-throughs stand alone', () => {
    const book = only(
      row({
        shelves: ['Currently Reading'],
        readings: [
          ...days('2026-01-05', '2026-01-06'),
          reading({
            index: 2,
            startedAt: '2026-01-10',
            finishedAt: '2026-01-20',
            length: 300,
            lengthType: 'page',
            progress: 300,
          }),
          // Within the finished entry's span: the same read-through.
          reading({ index: 3, startedAt: '2026-01-15', finishedAt: '2026-01-15' }),
          // After it: a new read, which an open in-progress entry keeps open.
          reading({
            index: 4,
            startedAt: '2026-02-01',
            status: 'in-progress',
            length: 100,
            lengthType: 'percent',
            progress: 30,
          }),
          reading({
            index: 5,
            startedAt: '2026-02-02',
            status: 'in-progress',
            length: 100,
            lengthType: 'percent',
            progress: 45,
          }),
          reading({ index: 6, startedAt: '2026-12-01', finishedAt: '2026-12-01' }),
        ],
      }),
    );
    expect(readSummary(book)).toEqual([
      ['2026-01-05', '2026-01-20', 'finished', 4],
      ['2026-02-01', null, 'in_progress', 3],
    ]);
    const progress = book.reads[1]?.sessions.filter(
      (s) => s.progressUnit === 'percent' && s.endValue !== null,
    );
    expect(progress?.map((s) => [s.startValue, s.endValue])).toEqual([
      [0, 30],
      [30, 45],
    ]);
    // The finished entry's progress is recorded on its finish day.
    expect(book.reads[0]?.sessions.find((s) => s.progressUnit === 'pages')).toMatchObject({
      day: '2026-01-20',
      startValue: 0,
      endValue: 300,
    });
  });

  it('closes an earlier read without a finished entry as did not finish', () => {
    const book = only(
      row({
        readings: [
          reading({
            startedAt: '2025-01-01',
            finishedAt: '2025-01-09',
            status: 'paused',
            length: 100,
            lengthType: 'percent',
            progress: 20,
          }),
          ...days('2026-03-01').map((r) => ({ ...r, index: 1 })),
        ],
      }),
    );
    expect(readSummary(book)).toEqual([
      ['2025-01-01', '2025-01-09', 'dnf', 1],
      ['2026-03-01', '2026-03-01', 'finished', 1],
    ]);
  });

  it('converts progress units to what the format supports', () => {
    const book = only(
      row({
        format: 'audiobook',
        shelves: ['Currently Reading'],
        readings: [
          reading({
            startedAt: '2026-05-01',
            status: 'in-progress',
            length: 400,
            lengthType: 'page',
            progress: 100,
          }),
          reading({
            index: 1,
            startedAt: '2026-05-01',
            status: 'in-progress',
            length: 400,
            lengthType: null,
            progress: 200,
          }),
          reading({
            index: 2,
            startedAt: '2026-05-03',
            status: 'in-progress',
            length: null,
            lengthType: null,
            progress: 5,
          }),
          reading({
            index: 3,
            startedAt: '2026-05-04',
            status: 'in-progress',
            length: 100,
            lengthType: 'percent',
            progress: 0,
          }),
        ],
      }),
    );
    expect(
      book.reads[0]?.sessions.map((s) => [s.suffix, s.progressUnit, s.startValue, s.endValue]),
    ).toEqual([
      [`progress:${book.anchor}:2026-05-01`, 'percent', 0, 25],
      [`progress:${book.anchor}:2026-05-01#2`, 'percent', 25, 50],
    ]);
  });

  it('ignores undated placeholders and warns about undated progress', () => {
    const result = plan(
      row({
        slug: 'u',
        shelves: ['Currently Reading'],
        readings: [
          reading({ status: 'in-progress', progress: 0 }),
          reading({ index: 1, status: 'paused', progress: 40 }),
        ],
      }),
    );
    expect(result.books[0]?.reads).toEqual([]);
    expect(result.warnings).toEqual([
      { slug: 'u', message: 'Reading 2 has progress but no dates; it only informs the status' },
    ]);
  });

  it('keeps a to-read book with dated readings on To read, with a warning', () => {
    const result = plan(
      row({ slug: 'z', shelves: ['Want To Read'], readings: days('2026-02-02') }),
    );
    expect(result.books[0]?.status).toBe('to_read');
    expect(readSummary(result.books[0] as PlannedBook)).toEqual([
      ['2026-02-02', '2026-02-02', 'finished', 1],
    ]);
    expect(result.warnings).toEqual([
      { slug: 'z', message: 'Shelved as Want To Read but has dated readings; kept on To read' },
    ]);
    // Without any finished entry the read stays open.
    const open = only(
      row({
        shelves: ['Want To Read'],
        readings: [reading({ startedAt: '2026-02-02', status: 'in-progress', progress: 10 })],
      }),
    );
    expect(open.reads[0]?.outcome).toBe('in_progress');
  });
});

describe('historical reads and Goodreads backfill', () => {
  const goodreads = (dateRead: string | null, pages: number | null = null) => [
    { date: null, content: 'Book Id: -', goodreads: { pages, dateRead, hasText: false } },
  ];
  const undated = (length = 288) => [reading({ length, lengthType: 'page', progress: length })];

  it('dates an undated finished reading from the Goodreads "Date Read"', () => {
    const book = only(row({ readings: undated(), notes: goodreads('2025-08-14', 300) }));
    expect(readSummary(book)).toEqual([['2025-08-14', '2025-08-14', 'finished', 0]]);
    expect(book.formats[0]?.pageCount).toBe(288);
  });

  it('folds an undated reading into a dated read of the same read-through', () => {
    const near = only(
      row({ slug: 'a', readings: undated(350), notes: goodreads('2026-04-05') }),
      row({ slug: 'b', readings: days('2026-03-28', '2026-04-04') }),
    );
    expect(readSummary(near)).toEqual([['2026-03-28', '2026-04-04', 'finished', 2]]);
    expect(near.formats[0]?.pageCount).toBe(350);
    const undatedToo = only(
      row({ slug: 'c', readings: undated() }),
      row({ slug: 'd', readings: days('2026-03-28') }),
    );
    expect(undatedToo.reads).toHaveLength(1);
  });

  it('keeps an earlier Goodreads read as its own read, once per date', () => {
    const book = only(
      row({ slug: 'a', readings: undated(), notes: goodreads('2020-05-01') }),
      row({ slug: 'b', readings: undated(), notes: goodreads('2020-05-01') }),
      row({ slug: 'c', readings: days('2026-03-28') }),
    );
    expect(readSummary(book)).toEqual([
      ['2020-05-01', '2020-05-01', 'finished', 0],
      ['2026-03-28', '2026-03-28', 'finished', 1],
    ]);
  });

  it('shelves a finished book without dates and without a read, with a warning', () => {
    const result = plan(row({ slug: 'cn', title: '盐之路 [Yan zhi lu]', readings: undated(301) }));
    expect(result.books[0]).toMatchObject({ status: 'finished', reads: [] });
    expect(result.books[0]?.formats[0]?.pageCount).toBe(301);
    expect(result.warnings).toEqual([
      {
        slug: 'cn',
        message:
          'Finished, but Bookpine has no dates for the reading: shelved as Finished without a read',
      },
    ]);
  });
});

describe('notes', () => {
  it('imports reviews and plain notes, never Goodreads blobs, shortening long ones', () => {
    const long = 'n'.repeat(20_050);
    const result = plan(
      row({
        slug: 's',
        review: 'Loved it',
        notes: [
          { date: '2026-09-01', content: 'Lent to Sam', goodreads: null },
          {
            date: null,
            content: 'Book Id: -',
            goodreads: { pages: null, dateRead: null, hasText: false },
          },
          { date: null, content: long, goodreads: null },
        ],
      }),
    );
    expect(result.books[0]?.notes.map((n) => [n.suffix, n.text.length])).toEqual([
      ['review:s', 8],
      ['note:s:1', 11],
      ['note:s:2', 20_000],
    ]);
    expect(result.warnings).toEqual([
      { slug: 's', message: 'Shortened a note to 20000 characters' },
    ]);
  });
});

describe('the fixture export', () => {
  const FIXTURE = readFileSync(
    new URL('../test/fixtures/bookpine-export.csv', import.meta.url),
    'utf8',
  );

  it('plans every observed pattern', () => {
    const result = planImport(parseBookpineCsv(FIXTURE), TZ);
    expect(result.rows).toBe(20);
    expect(result.books).toHaveLength(16);
    const byTitle = (title: string) => result.books.filter((b) => b.title === title);
    expect(readSummary(byTitle('Quiet Engines')[0] as PlannedBook)).toEqual([
      ['2025-03-01', '2025-03-05', 'finished', 3],
      ['2026-06-02', '2026-06-10', 'finished', 5],
    ]);
    expect(byTitle('The Glass Cartographer, 10th Anniversary Edition')[0]).toMatchObject({
      status: 'reading',
      rating: 4.5,
    });
    expect(byTitle('Copper and Thyme')[0]?.authors).toEqual(['Martin Gale, Jr.', 'Ruth Gale']);
    expect(
      result.books.reduce((n, b) => n + b.reads.reduce((m, r) => m + r.sessions.length, 0), 0),
    ).toBe(29);
  });

  it('is deterministic, whatever the order of rows and readings', () => {
    const parsed = parseBookpineCsv(FIXTURE);
    const first = planImport(parsed, TZ);
    const shuffled = {
      ...parsed,
      rows: [...parsed.rows].reverse().map((r) => ({ ...r, readings: [...r.readings].reverse() })),
    };
    const second = planImport(shuffled, TZ);
    const key = (b: PlannedBook) => b.anchor;
    const strip = (b: PlannedBook) => ({
      ...b,
      slugs: [...b.slugs].sort(),
      formats: b.formats.map((f) => f.type),
    });
    expect(second.books.map(key).sort()).toEqual(first.books.map(key).sort());
    for (const book of first.books) {
      const other = second.books.find((b) => b.anchor === book.anchor) as PlannedBook;
      expect(strip(other).reads).toEqual(strip(book).reads);
      expect(strip(other).slugs).toEqual(strip(book).slugs);
      expect(strip(other).formats).toEqual(strip(book).formats);
    }
  });
});
