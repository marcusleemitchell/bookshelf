/**
 * The browser-side IndexedDB database (Dexie): the offline outbox and the
 * cached read model (ADR 0004, ADR 0007).
 */
import { Dexie, type EntityTable } from 'dexie';
import type { ErrorCode, SyncEntity } from '../../../shared/index.ts';

export type OutboxState = 'pending' | 'failed';

/** One queued mutation, replayed to `POST /api/sync` in `seq` order. */
export interface OutboxRecord {
  /** Auto-increment insertion order (assigned by IndexedDB). */
  seq?: number;
  opId: string;
  entity: SyncEntity;
  action: 'upsert' | 'delete';
  /** Full upsert record (`syncPayloadSchemas`) or `{ id }` for deletes. */
  payload: unknown;
  clientUpdatedAt: string;
  /** Human description shown in the outbox list, e.g. "Session: Dune". */
  label: string;
  createdAt: string;
  /** Replay attempts that ended in an error result. */
  attempts: number;
  /** Consecutive non-retryable errors (anything except `not_found`). */
  failures: number;
  /** `failed` ops are no longer sent until the user retries or discards them. */
  state: OutboxState;
  lastError: { code: ErrorCode; message: string } | null;
}

/** A cached API response (the last good copy), keyed by resource. */
export interface CacheRecord {
  key: string;
  value: unknown;
  savedAt: string;
}

export type LocalDb = Dexie & {
  outbox: EntityTable<OutboxRecord, 'seq'>;
  cache: EntityTable<CacheRecord, 'key'>;
};

export const DEFAULT_DB_NAME = 'bookshelf';

export function openLocalDb(name: string = DEFAULT_DB_NAME): LocalDb {
  const db = new Dexie(name) as LocalDb;
  db.version(1).stores({
    outbox: '++seq, state',
    cache: 'key, savedAt',
  });
  return db;
}
