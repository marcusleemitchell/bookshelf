import { describe, expect, it } from 'vitest';
import { noteListSchema, timerResponseSchema, type SyncOp } from '../../../shared/index.ts';
import { cacheKeys } from '../offline/cache.ts';
import { IDS, NOW, leGuin, makeNote, makeTimer, timerResponse } from '../test/fixtures.ts';
import { createTestServices } from '../test/services.ts';
import { apiError, createMockServer, type MockRequest } from '../test/server.ts';
import {
  QUEUED_MESSAGE,
  deleteNote,
  discardTimer,
  logSession,
  resumeTimer,
  saveNote,
  startTimer,
} from './actions.ts';

const applyAll = (req: MockRequest) => ({
  body: {
    results: (req.body as { ops: SyncOp[] }).ops.map((op) => ({
      opId: op.opId,
      status: 'applied',
      duplicate: false,
    })),
  },
});

function offlineServices() {
  const server = createMockServer();
  server.offline = true;
  return { ...createTestServices({ server }), server };
}

describe('offline-capable actions', () => {
  it('queues timer start, resume and discard with full records', async () => {
    const { services } = offlineServices();
    const start = await startTimer(
      services,
      { id: IDS.leGuin, title: 'The Left Hand of Darkness' },
      IDS.leGuinPhysical,
    );
    expect(start.queued).toBe(true);
    expect(services.toast.get()).toBe(QUEUED_MESSAGE);
    const cached = await services.cache.get(cacheKeys.timer, timerResponseSchema);
    expect(cached?.timer).toMatchObject({ bookId: IDS.leGuin, startedAt: NOW, pausedAt: null });

    await resumeTimer(
      services,
      makeTimer({ pausedAt: '2026-11-14T09:45:00.000Z', accumulatedSeconds: 900 }),
    );
    await discardTimer(services, makeTimer());
    const ops = await services.outbox.list();
    expect(ops.map((op) => [op.entity, op.action, op.label])).toEqual([
      ['timer', 'upsert', 'Start timer: The Left Hand of Darkness'],
      ['timer', 'upsert', 'Resume timer'],
      ['timer', 'delete', 'Discard timer'],
    ]);
    expect(ops[1]?.payload).toMatchObject({
      pausedAt: null,
      resumedAt: NOW,
      accumulatedSeconds: 900,
    });
    expect((await services.cache.get(cacheKeys.timer, timerResponseSchema))?.timer).toBeNull();
  });

  it('queues a session and the discard of the timer it came from, in order', async () => {
    const { services } = offlineServices();
    const book = leGuin();
    const format = book.formats[0];
    if (!format) throw new Error('fixture');
    const result = await logSession(services, {
      detail: book,
      format,
      timer: makeTimer(),
      input: {
        id: IDS.session2,
        formatId: format.id,
        startedAt: '2026-11-14T09:30:00.000Z',
        endedAt: NOW,
        durationSeconds: 1800,
        progressUnit: 'pages',
        startValue: 122,
        endValue: 150,
        note: null,
      },
    });
    expect(result.queued).toBe(true);
    expect((await services.outbox.list()).map((op) => op.entity)).toEqual(['session', 'timer']);
  });

  it('queues new notes and deletions, updating the cached list', async () => {
    const { services } = offlineServices();
    await services.cache.put(cacheKeys.notes(IDS.leGuin), [makeNote()]);
    const book = { id: IDS.leGuin, title: 'The Left Hand of Darkness' };
    await saveNote(services, book, { kind: 'note', text: 'Kemmer.', location: null });
    let notes = await services.cache.get(cacheKeys.notes(IDS.leGuin), noteListSchema);
    expect(notes?.map((n) => n.text)).toEqual(['Light is the left hand of darkness.', 'Kemmer.']);
    await deleteNote(services, book, makeNote());
    notes = await services.cache.get(cacheKeys.notes(IDS.leGuin), noteListSchema);
    expect(notes?.map((n) => n.text)).toEqual(['Kemmer.']);
    expect((await services.outbox.list()).map((op) => op.label)).toEqual([
      'Note: The Left Hand of Darkness',
      'Delete quote: The Left Hand of Darkness',
    ]);
  });

  it('replays pending ops before an online write, and ignores an already-gone timer', async () => {
    const server = createMockServer({
      'POST /api/sync': applyAll,
      'DELETE /api/timer': () => apiError(404, 'not_found', 'Timer not found'),
      'GET /api/timer': () => ({ body: timerResponse(null) }),
    });
    const { services } = createTestServices({ server });
    await services.outbox.enqueue([
      { entity: 'note', action: 'delete', payload: { id: IDS.note }, label: 'Delete note' },
    ]);
    const result = await discardTimer(services, makeTimer());
    expect(result.queued).toBe(false);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/sync',
      'DELETE /api/timer',
    ]);
    expect(await services.outbox.counts()).toEqual({ pending: 0, failed: 0 });
  });

  it('surfaces non-connectivity errors instead of queueing', async () => {
    const server = createMockServer({
      'PUT /api/timer': () => apiError(409, 'conflict', 'A timer is already active'),
    });
    const { services } = createTestServices({ server });
    await expect(
      startTimer(services, { id: IDS.leGuin, title: 'x' }, IDS.leGuinPhysical),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await services.outbox.list()).toEqual([]);
  });
});
