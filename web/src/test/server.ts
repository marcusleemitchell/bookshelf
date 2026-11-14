/**
 * A tiny in-memory mock of the Bookshelf API for web tests: routes like
 * `GET /api/books/:id` map to handlers or static bodies. It records every
 * call, can simulate the server being unreachable, and answers unknown routes
 * with a 404 envelope while recording them in `unhandled`.
 */

export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface MockReply {
  status?: number;
  body?: unknown;
}

export type MockHandler = (request: MockRequest) => MockReply | Promise<MockReply>;
export type RouteTable = Record<string, MockHandler | { static: unknown }>;

/** Wraps a body as a static 200 route. */
export const ok = (body: unknown) => ({ static: body });

export interface MockServer {
  fetch: typeof fetch;
  calls: MockRequest[];
  unhandled: string[];
  /** When true every request fails like an unreachable server. */
  offline: boolean;
  /** Adds or replaces a route. */
  on: (route: string, handler: MockHandler | { static: unknown }) => void;
  /** Calls whose `METHOD path` matches. */
  callsTo: (method: string, path: string) => MockRequest[];
}

function match(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    })}$`,
  );
  const result = regex.exec(path);
  if (!result) return null;
  return Object.fromEntries(
    names.map((name, i) => [name, decodeURIComponent(result[i + 1] ?? '')]),
  );
}

/** JSON bodies are parsed; other text (e.g. a CSV upload) is kept as a string. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createMockServer(routes: RouteTable = {}): MockServer {
  const table = new Map(Object.entries(routes));
  const server: MockServer = {
    calls: [],
    unhandled: [],
    offline: false,
    on: (route, handler) => {
      table.set(route, handler);
    },
    callsTo: (method, path) => server.calls.filter((c) => c.method === method && c.path === path),
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        'http://localhost',
      );
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? parseBody(init.body) : undefined;
      if (server.offline) throw new TypeError('Load failed');
      for (const [route, handler] of table) {
        const [routeMethod, pattern = ''] = route.split(' ');
        if (routeMethod !== method) continue;
        const params = match(pattern, url.pathname);
        if (!params) continue;
        const request: MockRequest = {
          method,
          path: url.pathname,
          params,
          query: url.searchParams,
          body,
        };
        server.calls.push(request);
        const reply = 'static' in handler ? { body: handler.static } : await handler(request);
        const status = reply.status ?? 200;
        if (status === 204) return new Response(null, { status });
        return new Response(JSON.stringify(reply.body ?? null), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      server.unhandled.push(`${method} ${url.pathname}${url.search}`);
      return new Response(
        JSON.stringify({
          error: { code: 'not_found', message: `No mock for ${method} ${url.pathname}` },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    },
  };
  return server;
}

/** A JSON error envelope reply. */
export function apiError(status: number, code: string, message: string): MockReply {
  return { status, body: { error: { code, message } } };
}
