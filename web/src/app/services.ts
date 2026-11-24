/**
 * The app's long-lived services, created once and shared through React
 * context: API client, local database, read-model cache, outbox, and small
 * stores for connectivity, sign-in, data invalidation and toasts. Tests create
 * their own with a mocked `fetch`, a fresh database name and a fixed clock.
 */
import type { AuthState, MemberProfile } from '../../../shared/index.ts';
import { createApiClient, type ApiClient } from '../api/client.ts';
import { newId } from '../lib/ids.ts';
import { ReadModelCache } from '../offline/cache.ts';
import { DEFAULT_DB_NAME, openLocalDb, type LocalDb } from '../offline/db.ts';
import { Outbox } from '../offline/outbox.ts';
import { Store } from './store.ts';

/**
 * Who is using the app (ADR 0010). `checking` until the server answers;
 * `unverified` when it could not be asked (offline, or a server error). In
 * both the app runs as usual (from the read model when offline). `signedOut`
 * shows sign-in, with the profiles to pick from once they are loaded.
 */
export type AuthStatus =
  | { status: 'checking' }
  | { status: 'unverified' }
  | { status: 'signedIn'; me: MemberProfile }
  | { status: 'signedOut'; state: AuthState | null };

export interface Services {
  api: ApiClient;
  db: LocalDb;
  cache: ReadModelCache;
  outbox: Outbox;
  /** Server reachability: true/false once known, null before the first request. */
  connectivity: Store<boolean | null>;
  auth: Store<AuthStatus>;
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
  const auth = new Store<AuthStatus>({ status: 'checking' });
  const api = createApiClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onReachability: (reachable) => {
      connectivity.set(reachable);
    },
    onUnauthorised: () => {
      if (auth.get().status !== 'signedOut') auth.set({ status: 'signedOut', state: null });
    },
  });
  const db = openLocalDb(options.dbName ?? DEFAULT_DB_NAME);
  return {
    api,
    db,
    cache: new ReadModelCache(db, now),
    outbox: new Outbox(db, api, now),
    connectivity,
    auth,
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

/**
 * Asks the server who is signed in. When it can't answer, a device that has
 * not been told it is signed out keeps running from its read model.
 */
export async function refreshAuth(services: Services): Promise<void> {
  try {
    const state = await services.api.authState();
    services.auth.set(
      state.me ? { status: 'signedIn', me: state.me } : { status: 'signedOut', state },
    );
  } catch {
    if (services.auth.get().status === 'checking') services.auth.set({ status: 'unverified' });
  }
}

/** Marks `me` as signed in, then refreshes data and sends any queued changes. */
export function signedIn(services: Services, me: MemberProfile): void {
  services.auth.set({ status: 'signedIn', me });
  invalidate(services);
  void syncNow(services);
}

/**
 * Signs out on the server and forgets the cached read model, so the next
 * person on this device can't read it offline. Queued changes stay and sync
 * after the next sign-in.
 */
export async function signOut(services: Services): Promise<void> {
  await services.api.signOut();
  await services.cache.clear();
  services.auth.set({ status: 'signedOut', state: null });
}

export function showToast(services: Services, message: string): void {
  services.toast.set(message);
}

/**
 * Replays the outbox and refreshes data when anything was applied. Safe to
 * call at any time (replays are single-flight and never throw when offline);
 * does nothing while signed out.
 */
export async function syncNow(services: Services): Promise<void> {
  if (services.auth.get().status === 'signedOut') return;
  const counts = await services.outbox.counts();
  if (counts.pending === 0) return;
  const outcome = await services.outbox.replay();
  if (outcome.done > 0 || outcome.failed > 0) invalidate(services);
}
