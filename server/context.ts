/**
 * Dependencies shared by services and routes. Injected so tests can supply
 * a temp database, a mocked `fetch` and a fixed clock.
 */
import type { Config } from './config.ts';
import type { Db } from './db/database.ts';
import type { Logger } from './logger.ts';

export interface AppContext {
  db: Db;
  config: Config;
  logger: Logger;
  fetch: typeof fetch;
  now: () => Date;
  /** Waits `ms` milliseconds (stubbed in tests to avoid real delays). */
  sleep: (ms: number) => Promise<void>;
}

export function nowIso(ctx: Pick<AppContext, 'now'>): string {
  return ctx.now().toISOString();
}
