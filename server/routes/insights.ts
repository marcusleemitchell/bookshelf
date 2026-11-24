/**
 * Read-only insight routes: health, lookup, and the signed-in member's stats
 * and calendar.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  bookCandidateListSchema,
  bookCandidateSchema,
  calendarQuerySchema,
  calendarSchema,
  healthResponseSchema,
  lookupSearchQuerySchema,
  statsDailySchema,
  statsRangeQuerySchema,
  statsSummarySchema,
  streaksSchema,
  yearInReviewSchema,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import type { AuthEnv } from '../http/auth.ts';
import { readParam, readQuery, respond } from '../http/validate.ts';
import { lookupIsbn, searchBooks } from '../services/lookup.ts';
import { requestScope as scope } from '../services/scope.ts';
import {
  calendarMonth,
  statsDaily,
  statsStreaks,
  statsSummary,
  yearInReview,
} from '../services/stats.ts';

const yearParamSchema = z.coerce.number().int().min(1900).max(9999);
const isbnParamSchema = z.string().min(1).max(40);

export function insightRoutes(ctx: AppContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/health', (c) =>
    respond(c, healthResponseSchema, {
      ok: true,
      version: ctx.config.version,
      dbPath: ctx.config.dbPath,
    }),
  );

  app.get('/lookup/isbn/:isbn', async (c) =>
    respond(c, bookCandidateSchema, await lookupIsbn(ctx, readParam(c, 'isbn', isbnParamSchema))),
  );
  app.get('/lookup/search', async (c) => {
    const { q, page } = readQuery(c, lookupSearchQuerySchema);
    return respond(c, bookCandidateListSchema, await searchBooks(ctx, q, page));
  });

  app.get('/stats/summary', (c) =>
    respond(
      c,
      statsSummarySchema,
      statsSummary(ctx, scope(c), readQuery(c, statsRangeQuerySchema)),
    ),
  );
  app.get('/stats/daily', (c) =>
    respond(c, statsDailySchema, statsDaily(ctx, scope(c), readQuery(c, statsRangeQuerySchema))),
  );
  app.get('/stats/streaks', (c) => respond(c, streaksSchema, statsStreaks(ctx, scope(c))));
  app.get('/stats/year/:year', (c) =>
    respond(
      c,
      yearInReviewSchema,
      yearInReview(ctx, scope(c), readParam(c, 'year', yearParamSchema)),
    ),
  );

  app.get('/calendar', (c) =>
    respond(
      c,
      calendarSchema,
      calendarMonth(ctx, scope(c), readQuery(c, calendarQuerySchema).month),
    ),
  );

  return app;
}
