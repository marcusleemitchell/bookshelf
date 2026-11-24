/**
 * Test harness: a fresh SQLite database in an OS temp directory (never the
 * real data dir), a fixed clock, a fetch mock that fails on any unexpected
 * request (no network in tests), a captured logger and, unless disabled, a
 * signed-in owner whose session cookie `request()` sends.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp, type AppOptions } from '../app.ts';
import type { Config, NotionConfig } from '../config.ts';
import type { AppContext } from '../context.ts';
import { openDatabase } from '../db/database.ts';
import { migrate } from '../db/migrate.ts';
import { SESSION_COOKIE } from '../http/auth.ts';
import { createLogger } from '../logger.ts';
import { findOwner, insertAuthSession, type MemberRow } from '../repositories/members.ts';
import { hashToken, SESSION_TTL_MS } from '../services/auth.ts';

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

export interface FetchMock {
  fetch: typeof fetch;
  calls: FetchCall[];
  /** Registers a responder for requests whose URL matches. Later registrations win. */
  on(match: string | RegExp | ((call: FetchCall) => boolean), responder: Responder): void;
}

export function createFetchMock(): FetchMock {
  const routes: { test: (call: FetchCall) => boolean; responder: Responder }[] = [];
  const calls: FetchCall[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FetchCall = { url, method: init.method ?? 'GET', headers, body };
    calls.push(call);
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const route = routes[i];
      if (route?.test(call)) return route.responder(call);
    }
    throw new Error(`Unexpected fetch in test: ${call.method} ${url}`);
  };
  return {
    fetch: fetchImpl,
    calls,
    on(match, responder) {
      const test =
        typeof match === 'string'
          ? (call: FetchCall) => call.url.startsWith(match)
          : match instanceof RegExp
            ? (call: FetchCall) => match.test(call.url)
            : match;
      routes.push({ test, responder });
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A tiny valid 1×1 PNG. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function image(bytes: Buffer = PNG_BYTES, contentType = 'image/png'): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

export interface TestEnvOptions {
  now?: string;
  timeZone?: string;
  notion?: NotionConfig | null;
  googleBooksApiKey?: string | null;
  appOptions?: AppOptions;
  /** Sign the owner in (default true); false starts without a session cookie. */
  signedIn?: boolean;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestEnv {
  ctx: AppContext;
  app: Hono;
  dir: string;
  fetchMock: FetchMock;
  logs: Record<string, unknown>[];
  sleeps: number[];
  clock: { set(iso: string): void; advance(ms: number): void; ms(): number };
  /** The owner created by migration 0005 (as it was before the test ran). */
  owner: MemberRow;
  /** The `Cookie` header `request()` sends; null sends none. */
  cookie: string | null;
  /** Headers carrying {@link cookie}, for tests that call `app.request` directly. */
  authHeaders(): Record<string, string>;
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResponse<T>>;
  cleanup(): void;
}

export function createTestEnv(options: TestEnvOptions = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'bookshelf-test-'));
  let nowMs = Date.parse(options.now ?? '2026-11-14T12:00:00.000Z');
  const config: Config = {
    host: '127.0.0.1',
    port: 4380,
    dataDir: dir,
    dbPath: join(dir, 'bookshelf.db'),
    coversDir: join(dir, 'covers'),
    backupsDir: join(dir, 'backups'),
    timeZone: options.timeZone ?? 'Europe/London',
    logLevel: 'debug',
    googleBooksApiKey: options.googleBooksApiKey ?? null,
    notion: options.notion ?? null,
    webDistDir: join(dir, 'web-dist'),
    version: '0.0.0-test',
  };
  const db = openDatabase(config.dbPath);
  migrate(db);
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    secrets: [config.googleBooksApiKey, config.notion?.token].filter((s): s is string => !!s),
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const fetchMock = createFetchMock();
  const sleeps: number[] = [];
  const ctx: AppContext = {
    db,
    config,
    logger,
    fetch: fetchMock.fetch,
    now: () => new Date(nowMs),
    sleep: (ms) => {
      sleeps.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
  };
  mkdirSync(config.coversDir, { recursive: true });
  mkdirSync(config.backupsDir, { recursive: true });
  const app = createApp(ctx, options.appOptions ?? {});
  const owner = findOwner(db);
  if (!owner) throw new Error('Migration 0005 did not create the owner');
  let cookie: string | null = null;
  if (options.signedIn ?? true) {
    const token = 'test-session-token';
    const at = new Date(nowMs);
    insertAuthSession(db, {
      tokenHash: hashToken(token),
      memberId: owner.id,
      createdAt: at.toISOString(),
      renewedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + SESSION_TTL_MS).toISOString(),
    });
    cookie = `${SESSION_COOKIE}=${token}`;
  }
  const env: TestEnv = {
    ctx,
    app,
    dir,
    fetchMock,
    logs,
    sleeps,
    clock: {
      set: (iso) => {
        nowMs = Date.parse(iso);
      },
      advance: (ms) => {
        nowMs += ms;
      },
      ms: () => nowMs,
    },
    owner,
    cookie,
    authHeaders() {
      const headers: Record<string, string> = {};
      if (env.cookie) headers['cookie'] = env.cookie;
      return headers;
    },
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<ApiResponse<T>> {
      const init: RequestInit = { method };
      const sent = env.authHeaders();
      if (body !== undefined) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        sent['content-type'] = 'application/json';
      }
      init.headers = { ...sent, ...headers };
      const response = await app.request(path, init);
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed as T, headers: response.headers };
    },
    cleanup() {
      if (db.isOpen) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return env;
}
