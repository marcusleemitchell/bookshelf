/**
 * The Hono application: JSON API under `/api` and, when built, the web app
 * from `web/dist` with an SPA fallback.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { except } from 'hono/combine';
import type { ErrorResponse } from '../shared/index.ts';
import type { AppContext } from './context.ts';
import { isConstraintError } from './db/database.ts';
import { AppError } from './http/errors.ts';
import { dataRoutes } from './routes/data.ts';
import { insightRoutes } from './routes/insights.ts';
import { libraryRoutes } from './routes/library.ts';
import { readingRoutes } from './routes/reading.ts';
import { createNotionMirror, type NotionMirror } from './services/notion.ts';

/**
 * Unhashed files that decide which build the client runs (SPEC §9); served
 * with `Cache-Control: no-cache`, as is every HTML response (SPA fallback).
 */
const REVALIDATED_FILES = new Set([
  '/sw.js',
  '/registerSW.js',
  '/manifest.webmanifest',
  '/index.html',
]);

/** Largest accepted JSON body for ordinary API requests. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface AppOptions {
  /** Directory with the built web app; skipped when it has no index.html. */
  staticDir?: string | null;
  notion?: NotionMirror;
}

function errorBody(
  code: ErrorResponse['error']['code'],
  message: string,
  details?: unknown,
): ErrorResponse {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Hono {
  const app = new Hono();
  const notion = options.notion ?? createNotionMirror(ctx);

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    ctx.logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.onError((error, c) => {
    if (error instanceof AppError) {
      if (error.status >= 500) ctx.logger.error('Request failed', { path: c.req.path, error });
      return c.json(errorBody(error.code, error.message, error.details), error.status);
    }
    if (isConstraintError(error)) {
      return c.json(
        errorBody('conflict', `Write violates a database constraint: ${error.message}`),
        409,
      );
    }
    ctx.logger.error('Unhandled error', { path: c.req.path, error });
    return c.json(errorBody('internal_error', 'Internal server error'), 500);
  });

  const api = new Hono();
  // Backup imports have their own, larger limit (routes/data.ts).
  api.use(
    '*',
    except(
      '/api/backup/import',
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: () => {
          throw new AppError(
            400,
            'validation_error',
            `Request body exceeds ${MAX_BODY_BYTES} bytes`,
          );
        },
      }),
    ),
  );
  api.route('/', insightRoutes(ctx));
  api.route('/', libraryRoutes(ctx));
  api.route('/', readingRoutes(ctx));
  api.route('/', dataRoutes(ctx, notion));
  api.all('*', (c) =>
    c.json(errorBody('not_found', `No API route for ${c.req.method} ${c.req.path}`), 404),
  );
  app.route('/api', api);

  const staticDir = options.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use('*', async (c, next) => {
      await next();
      if (c.req.path.startsWith('/api/') || !c.res.ok) return;
      if (c.req.path.startsWith('/assets/')) {
        // Vite content-hashes everything under /assets/.
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (
        REVALIDATED_FILES.has(c.req.path) ||
        c.res.headers.get('content-type')?.startsWith('text/html')
      ) {
        // The shell and the service worker must revalidate so a new build is picked up.
        c.header('Cache-Control', 'no-cache');
      }
    });
    app.get('*', serveStatic({ root: staticDir }));
    // SPA fallback for client routes. A missing hashed asset (an old build's
    // chunk) must 404 rather than return index.html with immutable caching.
    app.get('*', except('/assets/*', serveStatic({ root: staticDir, path: 'index.html' })));
  } else if (staticDir) {
    ctx.logger.warn('Web app not built; serving the API only', { staticDir });
  }

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
  return app;
}
