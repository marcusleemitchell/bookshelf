/**
 * The single active reading timer (SPEC §4). It survives app closure; the
 * client stops it by logging a session prefilled from it and then
 * discarding it with `DELETE /api/timer`.
 */
import { randomUUID } from 'node:crypto';
import type { ActiveTimer, TimerPut, TimerResponse } from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound, validationError } from '../http/errors.ts';
import { findBook } from '../repositories/books.ts';
import { deleteTimer, findFormat, findTimer, saveTimer } from '../repositories/records.ts';

/** Seconds elapsed on `timer` at `now` (never negative). */
export function elapsedSeconds(timer: ActiveTimer, now: Date): number {
  const running =
    timer.pausedAt === null ? Math.max(0, now.getTime() - Date.parse(timer.resumedAt)) : 0;
  return timer.accumulatedSeconds + Math.floor(running / 1000);
}

export function timerState(ctx: AppContext): TimerResponse {
  const timer = findTimer(ctx.db) ?? null;
  const now = ctx.now();
  return {
    timer,
    elapsedSeconds: timer ? elapsedSeconds(timer, now) : 0,
    serverTime: now.toISOString(),
  };
}

/** `PUT /api/timer`: start, pause or resume. */
export function updateTimer(ctx: AppContext, body: TimerPut): TimerResponse {
  const updatedAt = nowIso(ctx);
  const at = body.at ?? updatedAt;
  transaction(ctx.db, () => {
    const existing = findTimer(ctx.db);
    if (body.action === 'start') {
      if (existing) throw conflict('A timer is already active; stop or discard it first');
      const book = findBook(ctx.db, body.bookId);
      if (!book) throw validationError('Unknown bookId');
      const format = findFormat(ctx.db, body.formatId);
      if (format?.bookId !== book.id)
        throw validationError('formatId does not belong to this book');
      saveTimer(ctx.db, {
        id: body.id ?? randomUUID(),
        bookId: book.id,
        formatId: format.id,
        startedAt: at,
        resumedAt: at,
        pausedAt: null,
        accumulatedSeconds: 0,
        createdAt: updatedAt,
        updatedAt,
      });
      return;
    }
    if (!existing) throw notFound('Timer');
    if (body.action === 'pause') {
      if (existing.pausedAt !== null) throw conflict('The timer is already paused');
      saveTimer(ctx.db, {
        ...existing,
        accumulatedSeconds: elapsedSeconds(existing, new Date(at)),
        pausedAt: at,
        updatedAt,
      });
      return;
    }
    if (existing.pausedAt === null) throw conflict('The timer is already running');
    if (Date.parse(at) < Date.parse(existing.pausedAt)) {
      throw validationError('Cannot resume before the time it was paused');
    }
    saveTimer(ctx.db, { ...existing, pausedAt: null, resumedAt: at, updatedAt });
  });
  return timerState(ctx);
}

/** `DELETE /api/timer`: discards the timer. */
export function discardTimer(ctx: AppContext): void {
  if (!findTimer(ctx.db)) throw notFound('Timer');
  deleteTimer(ctx.db);
}
