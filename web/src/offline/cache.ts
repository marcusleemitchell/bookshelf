/**
 * The cached read model (ADR 0007): the last good API response per resource
 * key, so Today, Library, Book detail and friends render without the server.
 * Cached values are re-validated with their schema when read, so a value
 * written by an older app version that no longer fits is simply ignored.
 */
import type { z } from 'zod';
import type { LocalDb } from './db.ts';

/** Cache keys, one per API resource the app reads. */
export const cacheKeys = {
  books: 'books',
  book: (id: string) => `book:${id}`,
  notes: (bookId: string) => `notes:${bookId}`,
  bookSessions: (bookId: string) => `sessions:book:${bookId}`,
  daySessions: (day: string) => `sessions:day:${day}`,
  timer: 'timer',
  tags: 'tags',
  goals: 'goals',
  streaks: 'streaks',
  calendar: (month: string) => `calendar:${month}`,
  statsSummary: (from: string | undefined, to: string | undefined) =>
    `stats:summary:${from ?? ''}:${to ?? ''}`,
  statsDaily: (from: string, to: string) => `stats:daily:${from}:${to}`,
  yearInReview: (year: number) => `stats:year:${year}`,
  health: 'health',
  notionStatus: 'notion:status',
} as const;

/** Entries untouched for this long are pruned at start-up. */
export const CACHE_MAX_AGE_MS = 90 * 86_400_000;

export class ReadModelCache {
  readonly #db: LocalDb;
  readonly #now: () => Date;

  constructor(db: LocalDb, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  /** The cached value for `key` if present and still valid for `schema`. */
  async get<S extends z.ZodType>(key: string, schema: S): Promise<z.output<S> | undefined> {
    const record = await this.#db.cache.get(key);
    if (!record) return undefined;
    const parsed = schema.safeParse(record.value);
    return parsed.success ? parsed.data : undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.#db.cache.put({ key, value, savedAt: this.#now().toISOString() });
  }

  /**
   * Applies `change` to the cached value (when there is one) and stores the
   * result. Used to reflect queued offline changes in the read model.
   */
  async update<S extends z.ZodType>(
    key: string,
    schema: S,
    change: (value: z.output<S>) => z.output<S>,
  ): Promise<void> {
    const current = await this.get(key, schema);
    if (current === undefined) return;
    await this.put(key, change(current));
  }

  /** Removes every entry (on sign-out, so the next person can't read them offline). */
  async clear(): Promise<void> {
    await this.#db.cache.clear();
  }

  /** Removes entries older than `maxAgeMs`. Returns how many were removed. */
  async prune(maxAgeMs: number = CACHE_MAX_AGE_MS): Promise<number> {
    const cutoff = new Date(this.#now().getTime() - maxAgeMs).toISOString();
    return this.#db.cache.where('savedAt').below(cutoff).delete();
  }
}
