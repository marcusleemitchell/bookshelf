import { describe, expect, it } from 'vitest';
import {
  backupEnvelopeSchema,
  bookCreateSchema,
  bookUpdateSchema,
  calendarQuerySchema,
  colourSchema,
  dateKeySchema,
  goalPutSchema,
  lookupSearchQuerySchema,
  ratingSchema,
  sessionCreateSchema,
  statsRangeQuerySchema,
  syncPayloadSchemas,
  syncRequestSchema,
  timeZoneSchema,
  timerPutSchema,
} from './schemas.ts';

const BOOK_ID = '6f1c2a4e-8b0d-4c3e-9f5a-1b2c3d4e5f60';
const FORMAT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('primitives', () => {
  it('validates ratings in half steps', () => {
    expect(ratingSchema.safeParse(4.5).success).toBe(true);
    expect(ratingSchema.safeParse(0.5).success).toBe(true);
    expect(ratingSchema.safeParse(4.25).success).toBe(false);
    expect(ratingSchema.safeParse(0).success).toBe(false);
    expect(ratingSchema.safeParse(5.5).success).toBe(false);
  });

  it('validates date keys, colours and timezones', () => {
    expect(dateKeySchema.safeParse('2026-11-14').success).toBe(true);
    expect(dateKeySchema.safeParse('2026-02-30').success).toBe(false);
    expect(colourSchema.safeParse('#a1B2c3').success).toBe(true);
    expect(colourSchema.safeParse('red').success).toBe(false);
    expect(timeZoneSchema.safeParse('Europe/London').success).toBe(true);
    expect(timeZoneSchema.safeParse('Nowhere/Land').success).toBe(false);
  });

  it('validates calendar months', () => {
    expect(calendarQuerySchema.safeParse({ month: '2026-11' }).success).toBe(true);
    expect(calendarQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
  });
});

describe('bookCreateSchema', () => {
  it('applies defaults for a minimal manual book', () => {
    const parsed = bookCreateSchema.parse({ title: '  The Hobbit  ' });
    expect(parsed).toEqual({
      title: 'The Hobbit',
      subtitle: null,
      authors: [],
      publisher: null,
      publishedDate: null,
      language: null,
      synopsis: null,
      coverUrl: null,
      isbn10: null,
      isbn13: null,
      genres: [],
      source: 'manual',
      sourceId: null,
      status: 'to_read',
      rating: null,
      formats: [],
      tagIds: [],
    });
  });

  it('defaults nested format lengths to null', () => {
    const parsed = bookCreateSchema.parse({ title: 'X', formats: [{ format: 'kindle' }] });
    expect(parsed.formats).toEqual([
      { format: 'kindle', pageCount: null, audioDurationSeconds: null, isbn: null },
    ]);
  });

  it('rejects bad input', () => {
    expect(bookCreateSchema.safeParse({ title: '' }).success).toBe(false);
    expect(bookCreateSchema.safeParse({ title: 'X', isbn13: '9780306406158' }).success).toBe(false);
    expect(bookCreateSchema.safeParse({ title: 'X', coverUrl: 'ftp://x/y.jpg' }).success).toBe(
      false,
    );
    expect(bookCreateSchema.safeParse({ title: 'X', status: 'abandoned' }).success).toBe(false);
  });

  it('rejects an empty update', () => {
    expect(bookUpdateSchema.safeParse({}).success).toBe(false);
    expect(bookUpdateSchema.safeParse({ rating: 3 }).success).toBe(true);
  });
});

describe('sessionCreateSchema', () => {
  it('leaves optional derivations unset', () => {
    const parsed = sessionCreateSchema.parse({
      bookId: BOOK_ID,
      formatId: FORMAT_ID,
      startedAt: '2026-11-14T09:00:00.000Z',
      endedAt: '2026-11-14T10:00:00.000Z',
      progressUnit: 'pages',
      endValue: 42,
    });
    expect(parsed.durationSeconds).toBeUndefined();
    expect(parsed.startValue).toBeUndefined();
    expect(parsed.note).toBeNull();
  });

  it('requires UTC instants', () => {
    const result = sessionCreateSchema.safeParse({
      bookId: BOOK_ID,
      formatId: FORMAT_ID,
      startedAt: '14/11/2026 09:00',
      endedAt: '2026-11-14T10:00:00.000Z',
      progressUnit: 'pages',
    });
    expect(result.success).toBe(false);
  });
});

describe('goalPutSchema', () => {
  it('requires a year for per-year goals and none for daily goals', () => {
    expect(
      goalPutSchema.safeParse({ kind: 'books_per_year', year: 2026, target: 30 }).success,
    ).toBe(true);
    expect(goalPutSchema.safeParse({ kind: 'minutes_per_day', target: 30 }).success).toBe(true);
    expect(goalPutSchema.safeParse({ kind: 'books_per_year', target: 30 }).success).toBe(false);
    expect(
      goalPutSchema.safeParse({ kind: 'minutes_per_day', year: 2026, target: 30 }).success,
    ).toBe(false);
    expect(goalPutSchema.safeParse({ kind: 'pages_per_year', year: 2026, target: 0 }).success).toBe(
      false,
    );
  });
});

describe('query schemas', () => {
  it('orders stats ranges', () => {
    expect(statsRangeQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-30' }).success).toBe(
      true,
    );
    expect(statsRangeQuerySchema.safeParse({ from: '2026-12-01', to: '2026-11-30' }).success).toBe(
      false,
    );
    expect(statsRangeQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces lookup paging', () => {
    expect(lookupSearchQuerySchema.parse({ q: 'dune' })).toEqual({ q: 'dune', page: 1 });
    expect(lookupSearchQuerySchema.parse({ q: 'dune', page: '3' })).toEqual({ q: 'dune', page: 3 });
    expect(lookupSearchQuerySchema.safeParse({ q: ' ' }).success).toBe(false);
  });
});

describe('timerPutSchema', () => {
  it('discriminates on action', () => {
    expect(timerPutSchema.parse({ action: 'pause' })).toEqual({ action: 'pause' });
    expect(
      timerPutSchema.safeParse({ action: 'start', bookId: BOOK_ID, formatId: FORMAT_ID }).success,
    ).toBe(true);
    expect(timerPutSchema.safeParse({ action: 'start' }).success).toBe(false);
    expect(timerPutSchema.safeParse({ action: 'stop' }).success).toBe(false);
  });
});

describe('sync schemas', () => {
  it('accepts an op envelope with an opaque payload', () => {
    const parsed = syncRequestSchema.parse({
      ops: [
        {
          opId: '11111111-2222-4333-8444-555555555555',
          entity: 'tag',
          action: 'upsert',
          payload: { anything: true },
          clientUpdatedAt: '2026-11-14T09:00:00.000Z',
        },
      ],
    });
    expect(parsed.ops).toHaveLength(1);
  });

  it('validates per-entity payloads', () => {
    expect(
      syncPayloadSchemas.tag.safeParse({ id: BOOK_ID, name: 'Sci-fi', colour: null }).success,
    ).toBe(true);
    expect(syncPayloadSchemas.tag.safeParse({ id: BOOK_ID }).success).toBe(false);
  });
});

describe('backupEnvelopeSchema', () => {
  it('accepts an empty backup and rejects other apps', () => {
    const empty = {
      app: 'bookshelf',
      schemaVersion: 1,
      exportedAt: '2026-11-14T09:00:00.000Z',
      data: {
        books: [],
        formats: [],
        reads: [],
        sessions: [],
        tags: [],
        notes: [],
        goals: [],
        timer: null,
      },
    };
    expect(backupEnvelopeSchema.safeParse(empty).success).toBe(true);
    expect(backupEnvelopeSchema.safeParse({ ...empty, app: 'bookpine' }).success).toBe(false);
  });
});
