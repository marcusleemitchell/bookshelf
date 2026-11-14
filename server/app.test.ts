import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorResponseSchema, healthResponseSchema } from '../shared/index.ts';
import { createApp, MAX_BODY_BYTES } from './app.ts';
import { createTestEnv, type TestEnv } from './test/helpers.ts';

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => {
  env.cleanup();
});

describe('API basics', () => {
  it('reports health', async () => {
    const res = await env.request('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.body)).toEqual({
      ok: true,
      version: '0.0.0-test',
      dbPath: env.ctx.config.dbPath,
    });
  });

  it('returns JSON 404s for unknown API routes and other paths', async () => {
    const api = await env.request('GET', '/api/nothing');
    expect(api.status).toBe(404);
    expect(errorResponseSchema.parse(api.body).error).toEqual({
      code: 'not_found',
      message: 'No API route for GET /api/nothing',
    });
    const other = await env.request('GET', '/somewhere');
    expect(other.status).toBe(404);
  });

  it('logs each request without query strings', async () => {
    await env.request('GET', '/api/books?q=secret-search');
    const entry = env.logs.find((l) => l['msg'] === 'request');
    expect(entry).toMatchObject({ method: 'GET', path: '/api/books', status: 200 });
    expect(JSON.stringify(entry)).not.toContain('secret-search');
  });

  it('rejects oversized bodies', async () => {
    const res = await env.request('POST', '/api/tags', { name: 'x'.repeat(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).error.message).toMatch(/exceeds/);
  });

  it('maps unexpected errors to 500 without leaking details', async () => {
    env.ctx.db.close();
    const res = await env.request('GET', '/api/books');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(env.logs.some((l) => l['msg'] === 'Unhandled error')).toBe(true);
  });

  it('maps database constraint violations to 409', async () => {
    env.ctx.db.exec(
      "CREATE TRIGGER block_tags BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    const res = await env.request('POST', '/api/tags', { name: 'Blocked' });
    expect(res.status).toBe(409);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('conflict');
  });

  it('refuses to send responses that break the shared contract', async () => {
    env.ctx.db
      .prepare(
        `INSERT INTO books (id, title, authors, genres, source, status, isbn13, created_at, updated_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'Bad', '[]', '[]', 'manual', 'to_read', '123', 'x', 'x')`,
      )
      .run();
    const res = await env.request('GET', '/api/books');
    expect(res.status).toBe(500);
    expect(errorResponseSchema.parse(res.body).error.message).toBe(
      'Response failed contract validation',
    );
    expect(env.logs.some((l) => l['msg'] === 'Request failed')).toBe(true);
  });
});

describe('static web app', () => {
  it('serves web/dist with an SPA fallback and cache headers', async () => {
    const dist = env.ctx.config.webDistDir;
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Bookshelf</title>');
    writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    const app = createApp(env.ctx, { staticDir: dist });

    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>Bookshelf</title>');
    expect(index.headers.get('cache-control')).toBe('no-cache');

    const asset = await app.request('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const deepLink = await app.request('/books/123');
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get('cache-control')).toBe('no-cache');
    expect(await deepLink.text()).toContain('Bookshelf');

    const api = await app.request('/api/unknown');
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
  });

  it('makes the service worker, its registration, the manifest and index.html revalidate', async () => {
    const dist = env.ctx.config.webDistDir;
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Bookshelf</title>');
    writeFileSync(join(dist, 'sw.js'), 'self.skipWaiting()');
    writeFileSync(join(dist, 'registerSW.js'), 'navigator.serviceWorker.register("/sw.js")');
    writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"Bookshelf"}');
    writeFileSync(join(dist, 'icon-192.png'), 'png');
    const app = createApp(env.ctx, { staticDir: dist });

    for (const path of ['/sw.js', '/registerSW.js', '/manifest.webmanifest', '/index.html']) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control'), path).toBe('no-cache');
    }
    const manifest = await app.request('/manifest.webmanifest');
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');

    // Other root files keep the default (heuristic) caching.
    const icon = await app.request('/icon-192.png');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBeNull();

    // A missing hashed asset (an old build's chunk) is a 404, never the SPA
    // shell cached for a year under a script URL.
    const missingAsset = await app.request('/assets/gone-123.js');
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get('cache-control')).toBeNull();
    expect(missingAsset.headers.get('content-type')).toContain('application/json');
  });

  it('serves the API only when the web app is not built', async () => {
    const app = createApp(env.ctx, { staticDir: join(env.dir, 'missing') });
    expect((await app.request('/')).status).toBe(404);
    expect(env.logs.some((l) => l['msg'] === 'Web app not built; serving the API only')).toBe(true);
  });
});
