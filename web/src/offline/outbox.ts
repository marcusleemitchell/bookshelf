/**
 * The offline outbox (SPEC §5.1, ADR 0004). Mutations made while the server
 * is unreachable are queued here as full records, in dependency order, and
 * replayed to `POST /api/sync`.
 *
 * Result handling per op:
 * - `applied` / `stale`: done, removed from the queue (stale means the server
 *   already has a newer version of the row — last-write-wins).
 * - `error` with `not_found`: a referenced row is missing (e.g. its parent op
 *   has not been applied yet); kept and retried on the next replay.
 * - any other error (`validation_error`, `conflict`, `internal_error`):
 *   retried until it has failed {@link MAX_FAILURES} times in a row, then
 *   marked `failed` and surfaced so the user can retry or discard it.
 */
import type { SyncEntity, SyncOp, SyncOpResult } from '../../../shared/index.ts';
import { isOfflineError, type ApiClient } from '../api/client.ts';
import { newId } from '../lib/ids.ts';
import type { LocalDb, OutboxRecord } from './db.ts';

/** Consecutive non-retryable errors after which an op stops being sent. */
export const MAX_FAILURES = 3;
/** `POST /api/sync` accepts at most this many ops per request. */
export const SYNC_BATCH_SIZE = 500;

/** A mutation to queue. */
export interface NewOp {
  entity: SyncEntity;
  action: 'upsert' | 'delete';
  payload: unknown;
  label: string;
}

export interface OutboxCounts {
  pending: number;
  failed: number;
}

export interface ReplayOutcome {
  /** Ops sent to the server in this replay. */
  sent: number;
  /** Ops the server applied or ignored as stale (removed from the queue). */
  done: number;
  /** Ops that errored and stay queued for another attempt. */
  retrying: number;
  /** Ops newly marked as failed. */
  failed: number;
  /** True when the server could not be reached. */
  offline: boolean;
}

type Listener = () => void;

export class Outbox {
  readonly #db: LocalDb;
  readonly #api: Pick<ApiClient, 'sync'>;
  readonly #now: () => Date;
  readonly #listeners = new Set<Listener>();
  #replaying: Promise<ReplayOutcome> | null = null;
  #lastReplayAt: string | null = null;

  constructor(db: LocalDb, api: Pick<ApiClient, 'sync'>, now: () => Date) {
    this.#db = db;
    this.#api = api;
    this.#now = now;
  }

  /** Subscribes to queue changes; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  /** When the last replay that reached the server finished (ISO), or null. */
  get lastReplayAt(): string | null {
    return this.#lastReplayAt;
  }

  /** Queues ops atomically, in the given order, stamped with the current time. */
  async enqueue(ops: readonly NewOp[]): Promise<void> {
    if (ops.length === 0) return;
    const at = this.#now().toISOString();
    const records: OutboxRecord[] = ops.map((op) => ({
      opId: newId(),
      entity: op.entity,
      action: op.action,
      payload: op.payload,
      label: op.label,
      clientUpdatedAt: at,
      createdAt: at,
      attempts: 0,
      failures: 0,
      state: 'pending',
      lastError: null,
    }));
    await this.#db.transaction('rw', this.#db.outbox, async () => {
      await this.#db.outbox.bulkAdd(records);
    });
    this.#notify();
  }

  /** Every queued op in replay order. */
  async list(): Promise<OutboxRecord[]> {
    return this.#db.outbox.orderBy('seq').toArray();
  }

  async counts(): Promise<OutboxCounts> {
    const [pending, failed] = await Promise.all([
      this.#db.outbox.where('state').equals('pending').count(),
      this.#db.outbox.where('state').equals('failed').count(),
    ]);
    return { pending, failed };
  }

  /** Drops an op for good. */
  async discard(seq: number): Promise<void> {
    await this.#db.outbox.delete(seq);
    this.#notify();
  }

  /** Puts a failed op back in the queue with a clean failure count. */
  async retry(seq: number): Promise<void> {
    await this.#db.outbox.update(seq, { state: 'pending', failures: 0 });
    this.#notify();
  }

  /**
   * Sends pending ops to the server. Concurrent calls share one replay.
   * Never throws for connectivity problems; the outcome says what happened.
   */
  replay(): Promise<ReplayOutcome> {
    this.#replaying ??= this.#runReplay().finally(() => {
      this.#replaying = null;
    });
    return this.#replaying;
  }

  async #runReplay(): Promise<ReplayOutcome> {
    const outcome: ReplayOutcome = { sent: 0, done: 0, retrying: 0, failed: 0, offline: false };
    const pending = await this.#db.outbox.where('state').equals('pending').sortBy('seq');
    for (let start = 0; start < pending.length; start += SYNC_BATCH_SIZE) {
      const batch = pending.slice(start, start + SYNC_BATCH_SIZE);
      const ops: SyncOp[] = batch.map((record) => ({
        opId: record.opId,
        entity: record.entity,
        action: record.action,
        payload: record.payload,
        clientUpdatedAt: record.clientUpdatedAt,
      }));
      let results: SyncOpResult[];
      try {
        results = (await this.#api.sync(ops)).results;
      } catch (error) {
        if (isOfflineError(error)) {
          outcome.offline = true;
          break;
        }
        // The whole request was rejected: count it against every op in it.
        const message = error instanceof Error ? error.message : 'Sync request failed';
        results = batch.map((record) => ({
          opId: record.opId,
          status: 'error',
          duplicate: false,
          error: { code: 'internal_error', message },
        }));
      }
      outcome.sent += batch.length;
      await this.#applyResults(batch, results, outcome);
      this.#lastReplayAt = this.#now().toISOString();
    }
    if (outcome.sent > 0) this.#notify();
    return outcome;
  }

  async #applyResults(
    batch: readonly OutboxRecord[],
    results: readonly SyncOpResult[],
    outcome: ReplayOutcome,
  ): Promise<void> {
    const byOpId = new Map(results.map((result) => [result.opId, result]));
    await this.#db.transaction('rw', this.#db.outbox, async () => {
      for (const record of batch) {
        const seq = record.seq;
        if (seq === undefined) continue;
        const result = byOpId.get(record.opId);
        if (result && result.status !== 'error') {
          await this.#db.outbox.delete(seq);
          outcome.done += 1;
          continue;
        }
        const error = result?.error ?? {
          code: 'internal_error' as const,
          message: 'The server did not return a result for this change',
        };
        const retryable = error.code === 'not_found';
        const failures = retryable ? record.failures : record.failures + 1;
        const failed = failures >= MAX_FAILURES;
        await this.#db.outbox.update(seq, {
          attempts: record.attempts + 1,
          failures,
          lastError: error,
          state: failed ? 'failed' : 'pending',
        });
        if (failed) outcome.failed += 1;
        else outcome.retrying += 1;
      }
    });
  }
}
