/**
 * Each member's active reading timer, at most one (SPEC §4). It survives app closure; the
 * client stops it by logging a session prefilled from it and then
 * discarding it with `DELETE /api/timer`.
 */
import { randomUUID } from 'node:crypto';
import {
  timerElapsedSeconds,
  type ActiveTimer,
  type TimerPut,
  type TimerResponse,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound, validationError } from '../http/errors.ts';
import { findBook } from '../repositories/books.ts';
import { deleteTimer, findFormat, findTimer, saveTimer } from '../repositories/records.ts';
import { assertNewId } from './library.ts';
import type { MemberScope } from './scope.ts';

/** Seconds elapsed on `timer` at `now` (never negative). */
export function elapsedSeconds(timer: ActiveTimer, now: Date): number {
  return timerElapsedSeconds(timer, now);
}

export function timerState(ctx: AppContext, scope: MemberScope): TimerResponse {
  const timer = findTimer(ctx.db, scope.member.id) ?? null;
  const now = ctx.now();
  return {
    timer,
    elapsedSeconds: timer ? elapsedSeconds(timer, now) : 0,
    serverTime: now.toISOString(),
  };
}

/** `PUT /api/timer`: start, pause or resume. */
export function updateTimer(ctx: AppContext, scope: MemberScope, body: TimerPut): TimerResponse {
  const updatedAt = nowIso(ctx);
  const at = body.at ?? updatedAt;
  const memberId = scope.member.id;
  transaction(ctx.db, () => {
    const existing = findTimer(ctx.db, memberId);
    if (body.action === 'start') {
      if (existing) throw conflict('A timer is already active; stop or discard it first');
      if (body.id) assertNewId(ctx, 'active_timer', body.id);
      const book = findBook(ctx.db, memberId, body.bookId);
      if (!book) throw validationError('Unknown bookId');
      const format = findFormat(ctx.db, body.formatId);
      if (format?.bookId !== book.id)
        throw validationError('formatId does not belong to this book');
      saveTimer(ctx.db, {
        id: body.id ?? randomUUID(),
        memberId,
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
  return timerState(ctx, scope);
}

/** `DELETE /api/timer`: discards the member's timer. */
export function discardTimer(ctx: AppContext, scope: MemberScope): void {
  if (!findTimer(ctx.db, scope.member.id)) throw notFound('Timer');
  deleteTimer(ctx.db, scope.member.id);
}
