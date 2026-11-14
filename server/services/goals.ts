/**
 * Reading goals (SPEC §4) with progress: books finished or pages read in
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
import { findById, goalsTable, upsertRow } from '../repositories/tables.ts';
import { loadFinishedReads, loadStatSessions, today } from './stats.ts';

export function goalProgress(ctx: AppContext, goal: Goal): number {
  if (goal.kind === 'minutes_per_day') {
    const day = today(ctx);
    const seconds = loadStatSessions(ctx, { from: day, to: day }).reduce(
      (sum, item) => sum + (item.session.durationSeconds ?? 0),
      0,
    );
    return Math.round(seconds / 60);
  }
  const range = { from: `${goal.year}-01-01`, to: `${goal.year}-12-31` };
  if (goal.kind === 'books_per_year') return loadFinishedReads(ctx, range).length;
  return loadStatSessions(ctx, range).reduce(
    (sum, item) => sum + sessionPages(item.session, item.format),
    0,
  );
}

export function listGoalsWithProgress(ctx: AppContext): GoalWithProgress[] {
  return listGoals(ctx.db).map((goal) => ({ ...goal, current: goalProgress(ctx, goal) }));
}

/** `PUT /api/goals/:id`: creates or replaces a goal. Returns it and whether it was created. */
export function putGoal(
  ctx: AppContext,
  id: string,
  input: z.output<typeof goalPutSchema>,
): { goal: GoalWithProgress; created: boolean } {
  const at = nowIso(ctx);
  return transaction(ctx.db, () => {
    const existing = findById(ctx.db, goalsTable, id);
    if (findGoalByKindYear(ctx.db, input.kind, input.year, id)) {
      throw conflict(
        input.year === null
          ? `A ${input.kind} goal already exists`
          : `A ${input.kind} goal for ${input.year} already exists`,
      );
    }
    const goal: Goal = {
      id,
      kind: input.kind,
      year: input.year,
      target: input.target,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      deletedAt: null,
    };
    upsertRow(ctx.db, goalsTable, goal);
    return {
      goal: { ...goal, current: goalProgress(ctx, goal) },
      created: !existing || existing.deletedAt !== null,
    };
  });
}

export function deleteGoal(ctx: AppContext, id: string): void {
  if (!findGoal(ctx.db, id)) throw notFound('Goal');
  softDelete(ctx.db, 'goals', id, nowIso(ctx));
}
