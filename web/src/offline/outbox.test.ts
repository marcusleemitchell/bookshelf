import { describe, expect, it, vi } from 'vitest';
import type { SyncOp, SyncOpResult, SyncResponse } from '../../../shared/index.ts';
import { ApiError, OfflineError } from '../api/client.ts';
import { createClock } from '../test/services.ts';
import { openLocalDb } from './db.ts';
import { MAX_FAILURES, Outbox, SYNC_BATCH_SIZE, type NewOp } from './outbox.ts';

type Responder = (ops: SyncOp[]) => SyncOpResult['status'] | SyncOpResult | Promise<SyncResponse>;

function setup(respond: Responder = () => 'applied') {
  const sync = vi.fn((ops: SyncOp[]): Promise<SyncResponse> => {
    const answer = respond(ops);
    if (answer instanceof Promise) return answer;
    return Promise.resolve({
      results: ops.map((op) =>
        typeof answer === 'string'
          ? { opId: op.opId, status: answer, duplicate: false }
          : { ...answer, opId: op.opId },
      ),
    });
  });
  const db = openLocalDb(`outbox-test-${String(Math.random())}`);
  const outbox = new Outbox(db, { sync }, createClock().now);
  return { outbox, sync };
}

const op = (label: string): NewOp => ({
  entity: 'note',
  action: 'delete',
  payload: { id: '00000000-0000-4000-8000-000000000001' },
  label,
});

describe('Outbox', () => {
  it('queues ops in order with a client timestamp and notifies subscribers', async () => {
    const { outbox } = setup();
    const listener = vi.fn();
    const unsubscribe = outbox.subscribe(listener);
    await outbox.enqueue([op('first'), op('second')]);
    await outbox.enqueue([]);
    const list = await outbox.list();
    expect(list.map((r) => r.label)).toEqual(['first', 'second']);
    expect(list[0]).toMatchObject({
      clientUpdatedAt: '2026-11-14T10:00:00.000Z',
      state: 'pending',
      attempts: 0,
    });
    expect(await outbox.counts()).toEqual({ pending: 2, failed: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('removes applied and stale ops after replay, sending them in order', async () => {
    let call = 0;
    const { outbox, sync } = setup(() => (call++ === 0 ? 'applied' : 'stale'));
    await outbox.enqueue([op('a'), op('b')]);
    const outcome = await outbox.replay();
    expect(outcome).toEqual({ sent: 2, done: 2, retrying: 0, failed: 0, offline: false });
    expect(sync.mock.calls[0]?.[0].map((o) => o.entity)).toEqual(['note', 'note']);
    expect(await outbox.list()).toEqual([]);
    expect(outbox.lastReplayAt).toBe('2026-11-14T10:00:00.000Z');
  });

  it('keeps ops and reports offline when the server is unreachable', async () => {
    const { outbox } = setup(() => Promise.reject(new OfflineError()));
    await outbox.enqueue([op('a')]);
    const outcome = await outbox.replay();
    expect(outcome.offline).toBe(true);
    expect(outcome.sent).toBe(0);
    expect((await outbox.list())[0]).toMatchObject({ attempts: 0, state: 'pending' });
  });

  it('retries not_found indefinitely without counting failures', async () => {
    const { outbox } = setup(() => ({
      opId: '',
      status: 'error',
      duplicate: false,
      error: { code: 'not_found', message: 'Unknown readId' },
    }));
    await outbox.enqueue([op('session')]);
    for (let i = 0; i < MAX_FAILURES + 1; i += 1) await outbox.replay();
    const [record] = await outbox.list();
    expect(record).toMatchObject({ state: 'pending', failures: 0, attempts: MAX_FAILURES + 1 });
    expect(record?.lastError?.code).toBe('not_found');
  });

  it('marks ops that keep failing validation as failed and stops sending them', async () => {
    const { outbox, sync } = setup(() => ({
      opId: '',
      status: 'error',
      duplicate: false,
      error: { code: 'validation_error', message: 'Invalid payload: title' },
    }));
    await outbox.enqueue([op('book')]);
    const outcomes = [];
    for (let i = 0; i < MAX_FAILURES; i += 1) outcomes.push(await outbox.replay());
    expect(outcomes.map((o) => o.retrying)).toEqual([1, 1, 0]);
    expect(outcomes[MAX_FAILURES - 1]?.failed).toBe(1);
    expect(await outbox.counts()).toEqual({ pending: 0, failed: 1 });
    await outbox.replay();
    expect(sync).toHaveBeenCalledTimes(MAX_FAILURES);

    const [failed] = await outbox.list();
    await outbox.retry(failed?.seq ?? -1);
    expect(await outbox.counts()).toEqual({ pending: 1, failed: 0 });
    await outbox.discard(failed?.seq ?? -1);
    expect(await outbox.list()).toEqual([]);
  });

  it('counts a rejected request against every op in it', async () => {
    const { outbox } = setup(() =>
      Promise.reject(new ApiError(400, 'validation_error', 'Bad batch')),
    );
    await outbox.enqueue([op('a'), op('b')]);
    const outcome = await outbox.replay();
    expect(outcome.retrying).toBe(2);
    expect((await outbox.list()).map((r) => r.lastError?.message)).toEqual([
      'Bad batch',
      'Bad batch',
    ]);
  });

  it('treats a missing result as an error', async () => {
    const { outbox } = setup(() => Promise.resolve({ results: [] }));
    await outbox.enqueue([op('a')]);
    expect((await outbox.replay()).retrying).toBe(1);
  });

  it('sends large queues in batches of the sync limit', async () => {
    const { outbox, sync } = setup();
    await outbox.enqueue(Array.from({ length: SYNC_BATCH_SIZE + 1 }, (_, i) => op(String(i))));
    const outcome = await outbox.replay();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[1]?.[0]).toHaveLength(1);
    expect(outcome.done).toBe(SYNC_BATCH_SIZE + 1);
  });

  it('shares one replay between concurrent callers', async () => {
    const { outbox, sync } = setup();
    await outbox.enqueue([op('a')]);
    const [first, second] = await Promise.all([outbox.replay(), outbox.replay()]);
    expect(first).toBe(second);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
