/**
 * Member isolation (ADR 0010): an admin (the owner), a second parent and two
 * children each have their own shelf, reads, sessions, notes, tags, goals
 * and timer, with one catalogue book on two shelves. No route or sync op
 * may show or change another member's rows, and children may not edit the
 * shared catalogue or use household-wide features.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BookDetail,
  BookListItem,
  CalendarResponse,
  GoalWithProgress,
  Session,
  StatsDaily,
  StatsSummary,
  StreaksResponse,
  SyncOp,
  SyncResponse,
  Tag,
  TimerResponse,
  YearInReview,
} from '../../shared/index.ts';
import { all } from '../db/database.ts';
import { createTestEnv, type RequestFn, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

interface Seeded {
  name: string;
  request: RequestFn;
  bookId: string;
  formatId: string;
  readId: string;
  sessionId: string;
  noteId: string;
  tagId: string;
  goalId: string;
  timerId: string;
}

const SHARED_ISBN = '9780141439518';

let admin: Seeded;
let parent: Seeded;
let kit: Seeded;
let ash: Seeded;
let everyone: Seeded[];

/** Puts a book on the member's shelf and gives them one of every personal record. */
async function seedMember(
  name: string,
  request: RequestFn,
  book: { title: string; isbn13: string },
  minutes: number,
): Promise<Seeded> {
  const tag = await request<Tag>('POST', '/api/tags', { name: 'Favourites' });
  expect(tag.status).toBe(201);
  const created = await request<BookDetail>('POST', '/api/books', {
    ...book,
    status: 'reading',
    tagIds: [tag.body.id],
    formats: [{ format: 'physical', pageCount: 300 }],
  });
  expect(created.status).toBe(201);
  const detail = created.body;
  const formatId = detail.formats[0]?.id as string;
  const session = await request<Session>('POST', '/api/sessions', {
    bookId: detail.id,
    formatId,
    startedAt: '2026-11-13T19:00:00.000Z',
    endedAt: new Date(Date.parse('2026-11-13T19:00:00.000Z') + minutes * 60_000).toISOString(),
    progressUnit: 'pages',
    startValue: 0,
    endValue: minutes,
  });
  expect(session.status).toBe(201);
  const note = await request<{ id: string }>('POST', `/api/books/${detail.id}/notes`, {
    kind: 'note',
    text: `${name}’s private note`,
  });
  const goalId = randomUUID();
  const goal = await request('PUT', `/api/goals/${goalId}`, {
    kind: 'books_per_year',
    year: 2026,
    target: 10,
  });
  expect(goal.status).toBe(201);
  const timer = await request<TimerResponse>('PUT', '/api/timer', {
    action: 'start',
    bookId: detail.id,
    formatId,
  });
  expect(timer.status).toBe(200);
  return {
    name,
    request,
    bookId: detail.id,
    formatId,
    readId: session.body.readId,
    sessionId: session.body.id,
    noteId: note.body.id,
    tagId: tag.body.id,
    goalId,
    timerId: timer.body.timer?.id as string,
  };
}

beforeEach(async () => {
  env = createTestEnv();
  const jo = env.addMember({ name: 'Jo', role: 'parent' });
  const kitMember = env.addMember({ name: 'Kit', role: 'child' });
  const ashMember = env.addMember({ name: 'Ash', role: 'child' });
  admin = await seedMember('Owner', env.request, { title: 'Emma', isbn13: SHARED_ISBN }, 30);
  parent = await seedMember('Jo', jo.request, { title: 'Beloved', isbn13: '9780099760115' }, 40);
  // Kit adds the same edition as the owner: the catalogue book is shared.
  kit = await seedMember('Kit', kitMember.request, { title: 'Emma', isbn13: SHARED_ISBN }, 50);
  ash = await seedMember('Ash', ashMember.request, { title: 'Holes', isbn13: '9780747544470' }, 60);
  everyone = [admin, parent, kit, ash];
});

afterEach(() => {
  env.cleanup();
});

function others(member: Seeded): Seeded[] {
  return everyone.filter((other) => other !== member);
}

/** True when `other`'s book is not also on `member`'s shelf. */
function foreignBook(member: Seeded, other: Seeded): boolean {
  return other.bookId !== member.bookId;
}

describe('member isolation over REST', () => {
  it('shares the catalogue book between two shelves', () => {
    expect(kit.bookId).toBe(admin.bookId);
    expect(kit.formatId).toBe(admin.formatId);
    expect(kit.readId).not.toBe(admin.readId);
    expect(all(env.ctx.db, 'SELECT id FROM books')).toHaveLength(3);
  });

  it('lists only the member’s own books, sessions, tags, goals and timer', async () => {
    for (const member of everyone) {
      const books = (await member.request<BookListItem[]>('GET', '/api/books')).body;
      expect(books.map((b) => b.id)).toEqual([member.bookId]);
      expect(books[0]?.tagIds).toEqual([member.tagId]);
      expect(books[0]?.currentRead?.id).toBe(member.readId);
      const detail = (await member.request<BookDetail>('GET', `/api/books/${member.bookId}`)).body;
      expect(detail.reads.map((r) => r.id)).toEqual([member.readId]);
      expect(detail.reads[0]?.number).toBe(1);
      const sessions = (await member.request<Session[]>('GET', '/api/sessions')).body;
      expect(sessions.map((s) => s.id)).toEqual([member.sessionId]);
      expect(sessions[0]).not.toHaveProperty('memberId');
      const notes = (
        await member.request<{ id: string }[]>('GET', `/api/books/${member.bookId}/notes`)
      ).body;
      expect(notes.map((n) => n.id)).toEqual([member.noteId]);
      const tags = (await member.request<Tag[]>('GET', '/api/tags')).body;
      expect(tags.map((t) => t.id)).toEqual([member.tagId]);
      const goals = (await member.request<GoalWithProgress[]>('GET', '/api/goals')).body;
      expect(goals.map((g) => g.id)).toEqual([member.goalId]);
      const timer = (await member.request<TimerResponse>('GET', '/api/timer')).body;
      expect(timer.timer?.id).toBe(member.timerId);
      expect(
        (await member.request<BookListItem[]>('GET', `/api/books?tag=${others(member)[0]?.tagId}`))
          .body,
      ).toEqual([]);
    }
  });

  it('returns 404 for every other member’s book and row, and changes nothing', async () => {
    for (const member of everyone) {
      for (const other of others(member)) {
        const notFound: [string, string, unknown?][] = [
          ['PATCH', `/api/sessions/${other.sessionId}`, { note: 'mine now' }],
          ['DELETE', `/api/sessions/${other.sessionId}`],
          ['PATCH', `/api/tags/${other.tagId}`, { name: 'Taken' }],
          ['DELETE', `/api/tags/${other.tagId}`],
          ['PUT', `/api/goals/${other.goalId}`, { kind: 'pages_per_year', year: 2026, target: 1 }],
          ['DELETE', `/api/goals/${other.goalId}`],
          ['PATCH', `/api/books/${other.bookId}/notes/${other.noteId}`, { text: 'Changed' }],
          ['DELETE', `/api/books/${other.bookId}/notes/${other.noteId}`],
        ];
        if (foreignBook(member, other)) {
          notFound.push(
            ['GET', `/api/books/${other.bookId}`],
            ['PATCH', `/api/books/${other.bookId}`, { rating: 1 }],
            ['DELETE', `/api/books/${other.bookId}`],
            ['PUT', `/api/books/${other.bookId}/tags`, { tagIds: [] }],
            ['POST', `/api/books/${other.bookId}/reads`, {}],
            ['GET', `/api/books/${other.bookId}/notes`],
            ['POST', `/api/books/${other.bookId}/notes`, { kind: 'note', text: 'Hi' }],
            ['POST', `/api/books/${other.bookId}/formats`, { format: 'kindle' }],
            ['PATCH', `/api/books/${other.bookId}/formats/${other.formatId}`, { pageCount: 1 }],
            ['DELETE', `/api/books/${other.bookId}/formats/${other.formatId}`],
          );
        }
        for (const [method, path, body] of notFound) {
          const res = await member.request<{ error: { code: string } }>(method, path, body);
          expect([member.name, method, path, res.status]).toEqual([member.name, method, path, 404]);
          expect(res.body.error.code).toBe('not_found');
        }
        // References to another member's rows in request bodies are refused.
        const refused: [string, string, unknown][] = [
          ['PUT', `/api/books/${member.bookId}/tags`, { tagIds: [other.tagId] }],
          [
            'POST',
            '/api/sessions',
            {
              bookId: member.bookId,
              formatId: member.formatId,
              readId: other.readId,
              startedAt: '2026-11-14T08:00:00Z',
              endedAt: '2026-11-14T08:10:00Z',
              progressUnit: 'pages',
              endValue: 5,
            },
          ],
        ];
        if (foreignBook(member, other)) {
          refused.push(
            [
              'POST',
              '/api/sessions',
              {
                bookId: other.bookId,
                formatId: other.formatId,
                startedAt: '2026-11-14T08:00:00Z',
                endedAt: '2026-11-14T08:10:00Z',
                progressUnit: 'pages',
                endValue: 5,
              },
            ],
            ['POST', '/api/books', { title: 'Copy', tagIds: [other.tagId] }],
          );
        }
        for (const [method, path, body] of refused) {
          const res = await member.request(method, path, body);
          expect([member.name, method, path, res.status]).toEqual([member.name, method, path, 400]);
        }
      }
    }
    // Every member still has exactly their own records, unchanged.
    for (const member of everyone) {
      const detail = (await member.request<BookDetail>('GET', `/api/books/${member.bookId}`)).body;
      expect(detail).toMatchObject({ status: 'reading', rating: null, tagIds: [member.tagId] });
      const sessions = (await member.request<Session[]>('GET', '/api/sessions')).body;
      expect(sessions.map((s) => [s.id, s.note])).toEqual([[member.sessionId, null]]);
      const tags = (await member.request<Tag[]>('GET', '/api/tags')).body;
      expect(tags.map((t) => t.name)).toEqual(['Favourites']);
      const goals = (await member.request<GoalWithProgress[]>('GET', '/api/goals')).body;
      expect(goals.map((g) => g.kind)).toEqual(['books_per_year']);
    }
  });

  it('keeps timers apart: starting, pausing and discarding touch only the member’s own', async () => {
    const start = await kit.request('PUT', '/api/timer', {
      action: 'start',
      bookId: kit.bookId,
      formatId: kit.formatId,
    });
    expect(start.status).toBe(409);
    expect((await kit.request('PUT', '/api/timer', { action: 'pause' })).status).toBe(200);
    expect((await kit.request('DELETE', '/api/timer')).status).toBe(204);
    expect((await kit.request<TimerResponse>('GET', '/api/timer')).body.timer).toBeNull();
    for (const member of [admin, parent, ash]) {
      const timer = (await member.request<TimerResponse>('GET', '/api/timer')).body.timer;
      expect(timer).toMatchObject({ id: member.timerId, pausedAt: null });
    }
    // Another member's timer id cannot be reused to start one.
    const reused = await kit.request('PUT', '/api/timer', {
      action: 'start',
      id: admin.timerId,
      bookId: kit.bookId,
      formatId: kit.formatId,
    });
    expect(reused.status).toBe(409);
  });

  it('computes stats, streaks, calendar, year in review and goals per member', async () => {
    const minutes = new Map([
      [admin, 30],
      [parent, 40],
      [kit, 50],
      [ash, 60],
    ]);
    for (const member of everyone) {
      const own = minutes.get(member) as number;
      const summary = (await member.request<StatsSummary>('GET', '/api/stats/summary')).body;
      expect(summary.totals).toMatchObject({ seconds: own * 60, sessions: 1, pages: own });
      expect(summary.byTag.map((t) => t.tagId)).toEqual([member.tagId]);
      const daily = (
        await member.request<StatsDaily>('GET', '/api/stats/daily?from=2026-11-13&to=2026-11-13')
      ).body;
      expect(daily.days[0]?.minutes).toBe(own);
      const streaks = (await member.request<StreaksResponse>('GET', '/api/stats/streaks')).body;
      expect(streaks.longest).toBe(1);
      const calendar = (
        await member.request<CalendarResponse>('GET', '/api/calendar?month=2026-11')
      ).body;
      expect(calendar.days.flatMap((d) => d.entries.map((e) => [e.bookId, e.minutes]))).toEqual([
        [member.bookId, own],
      ]);
      const year = (await member.request<YearInReview>('GET', '/api/stats/year/2026')).body;
      expect(year.totals.seconds).toBe(own * 60);
      expect(year.booksFinished).toEqual([]);
    }
    // Finishing the shared book counts for Kit only, with Kit's rating.
    await kit.request('PATCH', `/api/books/${kit.bookId}`, { status: 'finished', rating: 3 });
    const kitYear = (await kit.request<YearInReview>('GET', '/api/stats/year/2026')).body;
    expect(kitYear.booksFinished.map((b) => [b.bookId, b.rating])).toEqual([[kit.bookId, 3]]);
    const adminYear = (await admin.request<YearInReview>('GET', '/api/stats/year/2026')).body;
    expect(adminYear.booksFinished).toEqual([]);
    const goals = (await kit.request<GoalWithProgress[]>('GET', '/api/goals')).body;
    expect(goals[0]?.current).toBe(1);
    expect((await admin.request<GoalWithProgress[]>('GET', '/api/goals')).body[0]?.current).toBe(0);
    const adminBook = (await admin.request<BookDetail>('GET', `/api/books/${admin.bookId}`)).body;
    expect(adminBook).toMatchObject({ status: 'reading', rating: null });
  });

  it('removing a shared book from one shelf leaves the other member’s shelf intact', async () => {
    expect((await kit.request('DELETE', `/api/books/${kit.bookId}`)).status).toBe(204);
    expect((await kit.request('GET', `/api/books/${kit.bookId}`)).status).toBe(404);
    expect((await kit.request<Session[]>('GET', '/api/sessions')).body).toEqual([]);
    expect((await kit.request<TimerResponse>('GET', '/api/timer')).body.timer).toBeNull();
    const detail = await admin.request<BookDetail>('GET', `/api/books/${admin.bookId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.reads.map((r) => r.id)).toEqual([admin.readId]);
    expect(detail.body.formats.map((f) => f.id)).toEqual([admin.formatId]);
    expect(detail.body.tagIds).toEqual([admin.tagId]);
    expect((await admin.request<Session[]>('GET', '/api/sessions')).body).toHaveLength(1);
    expect((await admin.request<TimerResponse>('GET', '/api/timer')).body.timer?.id).toBe(
      admin.timerId,
    );
    // Kit's tag survives (only its link to the book went); the catalogue row is still live.
    expect((await kit.request<Tag[]>('GET', '/api/tags')).body).toHaveLength(1);
    expect(all(env.ctx.db, 'SELECT deleted_at FROM books WHERE id = ?', [kit.bookId])).toEqual([
      { deleted_at: null },
    ]);

    // When the last shelf lets go, the catalogue book and its formats go too.
    expect((await admin.request('DELETE', `/api/books/${admin.bookId}`)).status).toBe(204);
    expect(
      all<{ deleted_at: string | null }>(env.ctx.db, 'SELECT deleted_at FROM books WHERE id = ?', [
        admin.bookId,
      ])[0]?.deleted_at,
    ).not.toBeNull();
    expect(
      all<{ deleted_at: string | null }>(
        env.ctx.db,
        'SELECT deleted_at FROM book_formats WHERE id = ?',
        [admin.formatId],
      )[0]?.deleted_at,
    ).not.toBeNull();

    // Kit can put it back by ISBN: a new catalogue book, as the old one is gone.
    const again = await kit.request<BookDetail>('POST', '/api/books', {
      title: 'Emma',
      isbn13: SHARED_ISBN,
    });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(kit.bookId);
  });
});

describe('children and the shared catalogue', () => {
  it('lets a child change their own shelf but not catalogue books or formats', async () => {
    const title = await kit.request<{ error: { code: string } }>(
      'PATCH',
      `/api/books/${kit.bookId}`,
      { title: 'Emma (abridged)', rating: 5 },
    );
    expect(title.status).toBe(403);
    expect(title.body.error.code).toBe('forbidden');
    const status = await kit.request<BookDetail>('PATCH', `/api/books/${kit.bookId}`, {
      status: 'paused',
      rating: 5,
    });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ title: 'Emma', status: 'paused', rating: 5 });
    expect(
      (await admin.request<BookDetail>('GET', `/api/books/${admin.bookId}`)).body,
    ).toMatchObject({ status: 'reading', rating: null });

    const formatPath = `/api/books/${kit.bookId}/formats/${kit.formatId}`;
    expect((await kit.request('PATCH', formatPath, { pageCount: 280 })).status).toBe(403);
    expect((await kit.request('DELETE', formatPath)).status).toBe(403);
    const added = await kit.request<{ format: string }>(
      'POST',
      `/api/books/${kit.bookId}/formats`,
      { format: 'audiobook', audioDurationSeconds: 36_000 },
    );
    expect(added.status).toBe(201);

    // Parents (and admins) may edit the catalogue; everyone sees the change.
    const renamed = await parent.request<BookDetail>('PATCH', `/api/books/${parent.bookId}`, {
      subtitle: 'A Novel',
    });
    expect(renamed.status).toBe(200);
    expect((await admin.request('PATCH', formatPath, { pageCount: 280 })).status).toBe(200);
    const seen = (await kit.request<BookDetail>('GET', `/api/books/${kit.bookId}`)).body;
    expect(seen.formats.map((f) => [f.format, f.pageCount])).toEqual([
      ['physical', 280],
      ['audiobook', null],
    ]);
    // Children may remove a book from their own shelf.
    expect((await ash.request('DELETE', `/api/books/${ash.bookId}`)).status).toBe(204);
  });

  it('keeps backups, Bookpine imports and Notion for parents and admins', async () => {
    const forbidden: [string, string, unknown?][] = [
      ['GET', '/api/backup/export'],
      ['POST', '/api/backup/import', {}],
      ['POST', '/api/backup/notion'],
      ['GET', '/api/backup/notion/status'],
      ['POST', '/api/import/bookpine/preview', 'title\n'],
      ['POST', '/api/import/bookpine', 'title\n'],
    ];
    for (const child of [kit, ash]) {
      for (const [method, path, body] of forbidden) {
        const res = await child.request<{ error: { code: string } }>(method, path, body);
        expect([child.name, path, res.status, res.body.error.code]).toEqual([
          child.name,
          path,
          403,
          'forbidden',
        ]);
      }
    }
    for (const adult of [admin, parent]) {
      expect((await adult.request('GET', '/api/backup/export')).status).toBe(200);
      expect((await adult.request('GET', '/api/backup/notion/status')).status).toBe(200);
    }
  });
});

describe('member isolation over sync', () => {
  function op(
    entity: SyncOp['entity'],
    payload: unknown,
    action: SyncOp['action'] = 'upsert',
  ): SyncOp {
    return {
      opId: randomUUID(),
      entity,
      action,
      payload,
      clientUpdatedAt: '2026-11-14T13:00:00.000Z',
    };
  }

  async function sync(member: Seeded, ...ops: SyncOp[]) {
    const res = await member.request<SyncResponse>('POST', '/api/sync', { ops });
    expect(res.status).toBe(200);
    return res.body.results.map((r) => r.error?.code ?? r.status);
  }

  it('rejects ops on another member’s rows with forbidden, and unknown shelves with not_found', async () => {
    const session = {
      id: admin.sessionId,
      readId: kit.readId,
      bookId: kit.bookId,
      formatId: kit.formatId,
      startedAt: '2026-11-14T08:00:00.000Z',
      endedAt: '2026-11-14T08:10:00.000Z',
      durationSeconds: 600,
      progressUnit: 'pages',
      startValue: 0,
      endValue: 5,
      note: null,
    };
    const read = {
      id: admin.readId,
      bookId: kit.bookId,
      number: 2,
      startedAt: '2026-11-14T08:00:00.000Z',
      finishedAt: null,
      outcome: 'in_progress',
    };
    const results = await sync(
      kit,
      op('read', read),
      op('session', session),
      op('session', { ...session, id: randomUUID(), readId: admin.readId }),
      op('tag', { id: admin.tagId, name: 'Stolen', colour: null }),
      op('note', {
        id: admin.noteId,
        bookId: kit.bookId,
        kind: 'note',
        text: 'Mine',
        location: null,
      }),
      op('goal', { id: admin.goalId, kind: 'books_per_year', year: 2026, target: 1 }),
      op('timer', {
        id: admin.timerId,
        bookId: kit.bookId,
        formatId: kit.formatId,
        startedAt: '2026-11-14T08:00:00.000Z',
        resumedAt: '2026-11-14T08:00:00.000Z',
        pausedAt: null,
        accumulatedSeconds: 0,
      }),
      op('read', { id: admin.readId }, 'delete'),
      op('session', { id: admin.sessionId }, 'delete'),
      op('tag', { id: admin.tagId }, 'delete'),
      op('note', { id: admin.noteId }, 'delete'),
      op('goal', { id: admin.goalId }, 'delete'),
      op('timer', { id: admin.timerId }, 'delete'),
      // Parent Jo's book was never on Kit's shelf.
      op('read', { ...read, id: randomUUID(), bookId: parent.bookId }),
      op('note', {
        id: randomUUID(),
        bookId: parent.bookId,
        kind: 'note',
        text: 'Hi',
        location: null,
      }),
      op('format', {
        id: randomUUID(),
        bookId: parent.bookId,
        format: 'kindle',
        pageCount: null,
        audioDurationSeconds: null,
        isbn: null,
      }),
    );
    expect(results).toEqual([
      ...Array<string>(13).fill('forbidden'),
      'not_found',
      'not_found',
      'not_found',
    ]);
    // Nothing of the owner's changed.
    const detail = (await admin.request<BookDetail>('GET', `/api/books/${admin.bookId}`)).body;
    expect(detail.reads.map((r) => [r.id, r.number])).toEqual([[admin.readId, 1]]);
    expect((await admin.request<Tag[]>('GET', '/api/tags')).body[0]?.name).toBe('Favourites');
    expect((await admin.request<TimerResponse>('GET', '/api/timer')).body.timer?.id).toBe(
      admin.timerId,
    );
    expect((await admin.request<Session[]>('GET', '/api/sessions')).body).toHaveLength(1);
  });

  it('applies book ops to the member’s own shelf entry only', async () => {
    const book = (await kit.request<BookDetail>('GET', `/api/books/${kit.bookId}`)).body;
    const payload = {
      id: book.id,
      title: 'Renamed by a child',
      subtitle: null,
      authors: book.authors,
      publisher: null,
      publishedDate: null,
      language: null,
      synopsis: null,
      coverUrl: null,
      isbn10: book.isbn10,
      isbn13: book.isbn13,
      genres: [],
      source: 'manual',
      sourceId: null,
      status: 'finished',
      rating: 2,
      tagIds: [admin.tagId, kit.tagId],
    };
    expect(await sync(kit, op('book', payload))).toEqual(['applied']);
    const kitView = (await kit.request<BookDetail>('GET', `/api/books/${kit.bookId}`)).body;
    expect(kitView).toMatchObject({
      title: 'Emma',
      status: 'finished',
      rating: 2,
      tagIds: [kit.tagId],
    });
    const adminView = (await admin.request<BookDetail>('GET', `/api/books/${admin.bookId}`)).body;
    expect(adminView).toMatchObject({ status: 'reading', rating: null, tagIds: [admin.tagId] });

    // Deleting the book only takes it off Kit's shelf.
    expect(await sync(kit, op('book', { id: kit.bookId }, 'delete'))).toEqual(['applied']);
    expect((await kit.request('GET', `/api/books/${kit.bookId}`)).status).toBe(404);
    expect((await admin.request('GET', `/api/books/${admin.bookId}`)).status).toBe(200);
  });

  it('lets a child add a format but not change or delete one', async () => {
    const existing = {
      id: kit.formatId,
      bookId: kit.bookId,
      format: 'physical',
      pageCount: 300,
      audioDurationSeconds: null,
      isbn: null,
    };
    const added = { ...existing, id: randomUUID(), format: 'kindle', pageCount: null };
    expect(
      await sync(
        kit,
        op('format', existing),
        op('format', { ...existing, pageCount: 1 }),
        op('format', added),
        op('format', { id: kit.formatId }, 'delete'),
      ),
    ).toEqual(['applied', 'forbidden', 'applied', 'forbidden']);
    expect(await sync(parent, op('format', { ...existing, pageCount: 310 }))).toEqual([
      'not_found',
    ]);
    expect(await sync(admin, op('format', { ...existing, pageCount: 310 }))).toEqual(['applied']);
    const formats = (await kit.request<BookDetail>('GET', `/api/books/${kit.bookId}`)).body.formats;
    expect(formats.map((f) => [f.format, f.pageCount])).toEqual([
      ['physical', 310],
      ['kindle', null],
    ]);
  });
});
