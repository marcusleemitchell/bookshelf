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
