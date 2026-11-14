/**
 * Automatic local snapshots (SPEC §7): one at server start and one daily
 * at 03:00 local time (BOOKSHELF_TZ). A minute-level check rather than a
 * single long timer keeps the schedule correct across Mac sleep and DST.
 */
import { localDateKey, localParts, type DateKey } from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { writeSnapshot } from './backup.ts';

export const SNAPSHOT_HOUR = 3;

export interface SnapshotScheduler {
  /** Runs the daily check now (called by the interval; exposed for tests). */
  tick(): void;
  stop(): void;
}

export function startSnapshotScheduler(
  ctx: AppContext,
  options: { intervalMs?: number } = {},
): SnapshotScheduler {
  const tz = ctx.config.timeZone;
  let lastDaily: DateKey | null = null;

  const snapshot = (reason: 'startup' | 'daily') => {
    try {
      const file = writeSnapshot(ctx, 'daily');
      ctx.logger.info('Snapshot written', { file, reason });
    } catch (error) {
      ctx.logger.error('Snapshot failed', { reason, error });
    }
  };

  const startedAt = ctx.now();
  snapshot('startup');
  // A startup snapshot taken after 03:00 counts as today's daily snapshot.
  if (localParts(startedAt, tz).hour >= SNAPSHOT_HOUR) lastDaily = localDateKey(startedAt, tz);

  const tick = () => {
    const now = ctx.now();
    const day = localDateKey(now, tz);
    if (day !== lastDaily && localParts(now, tz).hour >= SNAPSHOT_HOUR) {
      lastDaily = day;
      snapshot('daily');
    }
  };
  const interval = setInterval(tick, options.intervalMs ?? 60_000);
  interval.unref();
  return {
    tick,
    stop: () => {
      clearInterval(interval);
    },
  };
}
