/**
 * Reading routes: sessions, timer, tags and goals.
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
import { readJson, readParam, readQuery, respond } from '../http/validate.ts';
import { deleteGoal, listGoalsWithProgress, putGoal } from '../services/goals.ts';
import { createSession, deleteSession, listSessions, updateSession } from '../services/sessions.ts';
import { createTag, deleteTag, listTags, updateTag } from '../services/tags.ts';
import { discardTimer, timerState, updateTimer } from '../services/timer.ts';

export function readingRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/sessions', (c) =>
    respond(c, sessionListSchema, listSessions(ctx, readQuery(c, sessionListQuerySchema))),
  );
  app.post('/sessions', async (c) =>
    respond(c, sessionSchema, createSession(ctx, await readJson(c, sessionCreateSchema)), 201),
  );
  app.patch('/sessions/:id', async (c) => {
    const id = readParam(c, 'id');
    return respond(
      c,
      sessionSchema,
      updateSession(ctx, id, await readJson(c, sessionUpdateSchema)),
    );
  });
  app.delete('/sessions/:id', (c) => {
    deleteSession(ctx, readParam(c, 'id'));
    return c.body(null, 204);
  });

  app.get('/timer', (c) => respond(c, timerResponseSchema, timerState(ctx)));
  app.put('/timer', async (c) =>
    respond(c, timerResponseSchema, updateTimer(ctx, await readJson(c, timerPutSchema))),
  );
  app.delete('/timer', (c) => {
    discardTimer(ctx);
    return c.body(null, 204);
  });

  app.get('/tags', (c) => respond(c, tagListSchema, listTags(ctx.db)));
  app.post('/tags', async (c) =>
    respond(c, tagSchema, createTag(ctx, await readJson(c, tagCreateSchema)), 201),
  );
  app.patch('/tags/:id', async (c) => {
    const id = readParam(c, 'id');
    return respond(c, tagSchema, updateTag(ctx, id, await readJson(c, tagUpdateSchema)));
  });
  app.delete('/tags/:id', (c) => {
    deleteTag(ctx, readParam(c, 'id'));
    return c.body(null, 204);
  });

  app.get('/goals', (c) => respond(c, goalListSchema, listGoalsWithProgress(ctx)));
  app.put('/goals/:id', async (c) => {
    const id = readParam(c, 'id');
    const { goal, created } = putGoal(ctx, id, await readJson(c, goalPutSchema));
    return respond(c, goalWithProgressSchema, goal, created ? 201 : 200);
  });
  app.delete('/goals/:id', (c) => {
    deleteGoal(ctx, readParam(c, 'id'));
    return c.body(null, 204);
  });

  return app;
}
