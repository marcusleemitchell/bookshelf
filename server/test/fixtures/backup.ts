/**
 * A schema-version-1 backup exactly as the phase 1–3 server exported it
 * (no session `source`, no import provenance), with fictional data. Used to
 * prove that older backups still restore after later migrations.
 */
const T = '2026-11-01T10:00:00.000Z';

export const BACKUP_V1 = {
  app: 'bookshelf',
  schemaVersion: 1,
  exportedAt: '2026-11-02T03:00:00.000Z',
  data: {
    books: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Kindred',
        subtitle: null,
        authors: ['Octavia E. Butler'],
        publisher: null,
        publishedDate: '1979',
        language: 'en',
        synopsis: null,
        coverUrl: null,
        coverPath: null,
        isbn10: null,
        isbn13: null,
        genres: ['Fiction'],
        source: 'manual',
        sourceId: null,
        status: 'reading',
        rating: 4.5,
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
        tagIds: [],
      },
    ],
    formats: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        bookId: '11111111-1111-4111-8111-111111111111',
        format: 'physical',
        pageCount: 264,
        audioDurationSeconds: null,
        isbn: null,
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
      },
    ],
    reads: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        bookId: '11111111-1111-4111-8111-111111111111',
        number: 1,
        startedAt: T,
        finishedAt: null,
        outcome: 'in_progress',
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
      },
    ],
    sessions: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        readId: '33333333-3333-4333-8333-333333333333',
        bookId: '11111111-1111-4111-8111-111111111111',
        formatId: '22222222-2222-4222-8222-222222222222',
        startedAt: T,
        endedAt: '2026-11-01T10:30:00.000Z',
        durationSeconds: 1800,
        progressUnit: 'pages',
        startValue: 0,
        endValue: 26,
        startPercent: 0,
        endPercent: 9.85,
        note: null,
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
      },
    ],
    tags: [],
    notes: [],
    goals: [],
    timer: null,
  },
} as const;

const KINDRED = '11111111-1111-4111-8111-111111111111';
const PHYSICAL = '22222222-2222-4222-8222-222222222222';
const TAG = '66666666-6666-4666-8666-666666666666';

/**
 * A schema-version-5 backup as the server exported it just before family
 * profiles (ADR 0010): status, rating and tag links on the books, one timer,
 * import provenance, no members. Fictional data. It must restore into the
 * owner.
 */
export const BACKUP_V5 = {
  app: 'bookshelf',
  schemaVersion: 5,
  exportedAt: '2026-11-20T03:00:00.000Z',
  data: {
    books: [
      { ...BACKUP_V1.data.books[0], status: 'paused', rating: 4, tagIds: [TAG] },
      {
        ...BACKUP_V1.data.books[0],
        id: '77777777-7777-4777-8777-777777777777',
        title: 'Parable of the Sower',
        status: 'finished',
        rating: null,
        deletedAt: '2026-11-03T10:00:00.000Z',
        tagIds: [],
      },
    ],
    formats: BACKUP_V1.data.formats,
    reads: BACKUP_V1.data.reads,
    sessions: [{ ...BACKUP_V1.data.sessions[0], durationSeconds: null, source: 'bookpine' }],
    tags: [
      {
        id: TAG,
        name: 'Classics',
        colour: '#112233',
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
      },
    ],
    notes: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        bookId: KINDRED,
        kind: 'quote',
        text: 'A fictional quoted line.',
        location: 'p. 9',
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
      },
    ],
    goals: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        kind: 'books_per_year',
        year: 2026,
        target: 12,
        createdAt: T,
        updatedAt: T,
        deletedAt: null,
      },
    ],
    timer: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      bookId: KINDRED,
      formatId: PHYSICAL,
      startedAt: T,
      resumedAt: T,
      pausedAt: null,
      accumulatedSeconds: 0,
      createdAt: T,
      updatedAt: T,
    },
    importLinks: [
      {
        source: 'bookpine',
        entity: 'book',
        externalId: 'kindred',
        localId: KINDRED,
        imported: { title: 'Kindred' },
        importedAt: T,
      },
    ],
  },
} as const;
