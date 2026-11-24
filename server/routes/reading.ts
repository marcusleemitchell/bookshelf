/**
 * Reading routes: the signed-in member's sessions, timer, tags and goals.
 */
import { Hono } from 'hono';
import {
  goalListSchema,
  goalPutSchema,
  goalWithProgressSchema,
  sessionCreateSchema,
  sessionListQuerySchema,
  sessionListSchema,
  sessionSchema,
  sessionUpdateSchema,
  tagCreateSchema,
  tagListSchema,
  tagSchema,
  tagUpdateSchema,
  timerPutSchema,
  timerResponseSchema,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import type { AuthEnv } from '../http/auth.ts';
import { readJson, readParam, readQuery, respond } from '../http/validate.ts';
import { deleteGoal, listGoalsWithProgress, putGoal } from '../services/goals.ts';
import { createSession, deleteSession, listSessions, updateSession } from '../services/sessions.ts';
import { createTag, deleteTag, listTags, updateTag } from '../services/tags.ts';
import { requestScope as scope } from '../services/scope.ts';
import { discardTimer, timerState, updateTimer } from '../services/timer.ts';

export function readingRoutes(ctx: AppContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/sessions', (c) =>
    respond(
      c,
      sessionListSchema,
      listSessions(ctx, scope(c), readQuery(c, sessionListQuerySchema)),
    ),
  );
  app.post('/sessions', async (c) =>
    respond(
      c,
      sessionSchema,
      createSession(ctx, scope(c), await readJson(c, sessionCreateSchema)),
      201,
    ),
  );
  app.patch('/sessions/:id', async (c) => {
    const id = readParam(c, 'id');
    return respond(
      c,
      sessionSchema,
      updateSession(ctx, scope(c), id, await readJson(c, sessionUpdateSchema)),
    );
  });
  app.delete('/sessions/:id', (c) => {
    deleteSession(ctx, scope(c), readParam(c, 'id'));
    return c.body(null, 204);
  });

  app.get('/timer', (c) => respond(c, timerResponseSchema, timerState(ctx, scope(c))));
  app.put('/timer', async (c) =>
    respond(c, timerResponseSchema, updateTimer(ctx, scope(c), await readJson(c, timerPutSchema))),
  );
  app.delete('/timer', (c) => {
    discardTimer(ctx, scope(c));
    return c.body(null, 204);
  });

  app.get('/tags', (c) => respond(c, tagListSchema, listTags(ctx, scope(c))));
  app.post('/tags', async (c) =>
    respond(c, tagSchema, createTag(ctx, scope(c), await readJson(c, tagCreateSchema)), 201),
  );
  app.patch('/tags/:id', async (c) => {
    const id = readParam(c, 'id');
    return respond(c, tagSchema, updateTag(ctx, scope(c), id, await readJson(c, tagUpdateSchema)));
  });
  app.delete('/tags/:id', (c) => {
    deleteTag(ctx, scope(c), readParam(c, 'id'));
    return c.body(null, 204);
  });

  app.get('/goals', (c) => respond(c, goalListSchema, listGoalsWithProgress(ctx, scope(c))));
  app.put('/goals/:id', async (c) => {
    const id = readParam(c, 'id');
    const { goal, created } = putGoal(ctx, scope(c), id, await readJson(c, goalPutSchema));
    return respond(c, goalWithProgressSchema, goal, created ? 201 : 200);
  });
  app.delete('/goals/:id', (c) => {
    deleteGoal(ctx, scope(c), readParam(c, 'id'));
    return c.body(null, 204);
  });

  return app;
}
