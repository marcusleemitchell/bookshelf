/**
 * The app's long-lived services, created once and shared through React
 * context: API client, local database, read-model cache, outbox, and small
 * stores for connectivity, data invalidation and toasts. Tests create their
 * own with a mocked `fetch`, a fresh database name and a fixed clock.
 */
import { createApiClient, type ApiClient } from '../api/client.ts';
import { newId } from '../lib/ids.ts';
import { ReadModelCache } from '../offline/cache.ts';
import { DEFAULT_DB_NAME, openLocalDb, type LocalDb } from '../offline/db.ts';
import { Outbox } from '../offline/outbox.ts';
import { Store } from './store.ts';

export interface Services {
  api: ApiClient;
  db: LocalDb;
  cache: ReadModelCache;
  outbox: Outbox;
  /** Server reachability: true/false once known, null before the first request. */
  connectivity: Store<boolean | null>;
  /** Bumped after writes and syncs; resources refetch when it changes. */
  dataVersion: Store<number>;
  /** The current transient message (role="status"), or null. */
  toast: Store<string | null>;
  now: () => Date;
  /** IANA timezone used to show dates and pick "today" (the device's own). */
  timeZone: string;
  newId: () => string;
}

export interface ServiceOptions {
  fetch?: typeof fetch;
  dbName?: string;
  now?: () => Date;
  timeZone?: string;
  newId?: () => string;
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function createServices(options: ServiceOptions = {}): Services {
  const now = options.now ?? (() => new Date());
  const connectivity = new Store<boolean | null>(
    typeof navigator !== 'undefined' && !navigator.onLine ? false : null,
  );
  const api = createApiClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onReachability: (reachable) => {
      connectivity.set(reachable);
    },
  });
  const db = openLocalDb(options.dbName ?? DEFAULT_DB_NAME);
  return {
    api,
    db,
    cache: new ReadModelCache(db, now),
    outbox: new Outbox(db, api, now),
    connectivity,
    dataVersion: new Store(0),
    toast: new Store<string | null>(null),
    now,
    timeZone: options.timeZone ?? deviceTimeZone(),
    newId: options.newId ?? newId,
  };
}

/** Marks cached data as out of date so mounted resources refetch. */
export function invalidate(services: Services): void {
  services.dataVersion.set(services.dataVersion.get() + 1);
}

export function showToast(services: Services, message: string): void {
  services.toast.set(message);
}

/**
 * Replays the outbox and refreshes data when anything was applied. Safe to
 * call at any time (replays are single-flight and never throw when offline).
 */
export async function syncNow(services: Services): Promise<void> {
  const counts = await services.outbox.counts();
  if (counts.pending === 0) return;
  const outcome = await services.outbox.replay();
  if (outcome.done > 0 || outcome.failed > 0) invalidate(services);
}
