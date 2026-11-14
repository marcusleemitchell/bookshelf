import { describe, expect, it } from 'vitest';
import { bookListSchema, timerResponseSchema } from '../../../shared/index.ts';
import { createClock } from '../test/services.ts';
import { library } from '../test/fixtures.ts';
import { ReadModelCache, cacheKeys } from './cache.ts';
import { openLocalDb } from './db.ts';

function setup() {
  const clock = createClock('2026-11-14T10:00:00.000Z');
  const db = openLocalDb(`cache-test-${String(Math.random())}`);
  return { cache: new ReadModelCache(db, clock.now), clock, db };
}

describe('ReadModelCache', () => {
  it('stores and returns values that still match their schema', async () => {
    const { cache } = setup();
    await cache.put(cacheKeys.books, library());
    const books = await cache.get(cacheKeys.books, bookListSchema);
    expect(books).toHaveLength(3);
  });

  it('ignores missing keys and values that no longer fit the schema', async () => {
    const { cache } = setup();
    expect(await cache.get('nothing', bookListSchema)).toBeUndefined();
    await cache.put(cacheKeys.timer, { legacy: true });
    expect(await cache.get(cacheKeys.timer, timerResponseSchema)).toBeUndefined();
  });

  it('updates a cached value in place and skips absent ones', async () => {
    const { cache } = setup();
    await cache.update(cacheKeys.books, bookListSchema, () => []);
    expect(await cache.get(cacheKeys.books, bookListSchema)).toBeUndefined();
    await cache.put(cacheKeys.books, library());
    await cache.update(cacheKeys.books, bookListSchema, (books) => books.slice(0, 1));
    expect(await cache.get(cacheKeys.books, bookListSchema)).toHaveLength(1);
  });

  it('prunes entries older than the maximum age', async () => {
    const { cache, clock } = setup();
    await cache.put('old', 1);
    clock.set('2027-03-01T10:00:00.000Z');
    await cache.put('new', 2);
    expect(await cache.prune()).toBe(1);
  });

  it('builds distinct keys per resource', () => {
    expect(cacheKeys.book('a')).toBe('book:a');
    expect(cacheKeys.statsSummary(undefined, undefined)).toBe('stats:summary::');
    expect(cacheKeys.statsDaily('2026-11-01', '2026-11-14')).toBe(
      'stats:daily:2026-11-01:2026-11-14',
    );
    expect(cacheKeys.yearInReview(2026)).toBe('stats:year:2026');
  });
});
