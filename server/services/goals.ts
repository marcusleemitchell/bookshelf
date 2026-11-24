/**
 * Each member's reading goals (SPEC §4) with progress from their reading: books finished or pages read in
 * the goal's year, or minutes read today for the daily goal (sessions with
 * an unknown duration add no minutes).
 */
import type { z } from 'zod';
import {
  sessionPages,
  type Goal,
  type GoalWithProgress,
  type goalPutSchema,
} from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound } from '../http/errors.ts';
import { findGoal, findGoalByKindYear, listGoals, softDelete } from '../repositories/records.ts';
import { findById, goalsTable, upsertRow, type Owned } from '../repositories/tables.ts';
import type { MemberScope } from './scope.ts';
import { loadFinishedReads, loadStatSessions, today } from './stats.ts';

export function goalProgress(ctx: AppContext, memberId: string, goal: Goal): number {
  if (goal.kind === 'minutes_per_day') {
    const day = today(ctx);
    const seconds = loadStatSessions(ctx, memberId, { from: day, to: day }).reduce(
      (sum, item) => sum + (item.session.durationSeconds ?? 0),
      0,
    );
    return Math.round(seconds / 60);
  }
  const range = { from: `${goal.year}-01-01`, to: `${goal.year}-12-31` };
  if (goal.kind === 'books_per_year') return loadFinishedReads(ctx, memberId, range).length;
  return loadStatSessions(ctx, memberId, range).reduce(
    (sum, item) => sum + sessionPages(item.session, item.format),
    0,
  );
}

export function listGoalsWithProgress(ctx: AppContext, scope: MemberScope): GoalWithProgress[] {
  const memberId = scope.member.id;
  return listGoals(ctx.db, memberId).map((goal) => ({
    ...goal,
    current: goalProgress(ctx, memberId, goal),
  }));
}

/**
 * `PUT /api/goals/:id`: creates or replaces one of the member's goals.
 * Returns it and whether it was created. Another member's goal id is a 404.
 */
export function putGoal(
  ctx: AppContext,
  scope: MemberScope,
  id: string,
  input: z.output<typeof goalPutSchema>,
): { goal: GoalWithProgress; created: boolean } {
  const at = nowIso(ctx);
  const memberId = scope.member.id;
  return transaction(ctx.db, () => {
    const existing = findById(ctx.db, goalsTable, id);
    if (existing && existing.memberId !== memberId) throw notFound('Goal');
    if (findGoalByKindYear(ctx.db, memberId, input.kind, input.year, id)) {
      throw conflict(
        input.year === null
          ? `A ${input.kind} goal already exists`
          : `A ${input.kind} goal for ${input.year} already exists`,
      );
    }
    const goal: Owned<Goal> = {
      id,
      memberId,
      kind: input.kind,
      year: input.year,
      target: input.target,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      deletedAt: null,
    };
    upsertRow(ctx.db, goalsTable, goal);
    return {
      goal: { ...goal, current: goalProgress(ctx, memberId, goal) },
      created: !existing || existing.deletedAt !== null,
    };
  });
}

export function deleteGoal(ctx: AppContext, scope: MemberScope, id: string): void {
  if (!findGoal(ctx.db, scope.member.id, id)) throw notFound('Goal');
  softDelete(ctx.db, 'goals', id, nowIso(ctx));
}
