/**
 * Renders the whole app against a mock API with a fixed clock, a fresh
 * IndexedDB (fake-indexeddb) and deterministic IDs (see ./services.ts).
 */
import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.tsx';
import type { Services } from '../app/services.ts';
import {
  authState,
  calendar,
  daily,
  health,
  library,
  makeGoal,
  notionStatus,
  streaks,
  summary,
  tags,
  timerResponse,
  yearReview,
  TODAY,
} from './fixtures.ts';
import { createMockServer, ok, type MockServer, type RouteTable } from './server.ts';
import { createTestServices, type TestClock } from './services.ts';

export { createClock, createTestServices, idSequence, type TestClock } from './services.ts';

/** Routes most screens read, with sensible defaults. */
export function defaultRoutes(): RouteTable {
  return {
    'GET /api/books': ok(library()),
    'GET /api/timer': ok(timerResponse(null)),
    'GET /api/goals': ok([makeGoal()]),
    'GET /api/stats/streaks': ok(streaks()),
    'GET /api/stats/daily': (req) => ({
      body: daily(
        [{ date: req.query.get('to') ?? TODAY, minutes: 20, pages: 12, percent: 4 }],
        req.query.get('from') ?? TODAY,
        req.query.get('to') ?? TODAY,
      ),
    }),
    'GET /api/stats/summary': ok(summary()),
    'GET /api/stats/year/:year': (req) => ({ body: yearReview(Number(req.params['year'])) }),
    'GET /api/tags': ok(tags()),
    'GET /api/calendar': (req) => ({ body: calendar(req.query.get('month') ?? '2026-11') }),
    'GET /api/health': ok(health),
    'GET /api/auth/state': ok(authState()),
    'GET /api/backup/notion/status': ok(notionStatus),
  };
}

export interface AppHarness extends RenderResult {
  services: Services;
  server: MockServer;
  clock: TestClock;
  user: ReturnType<typeof userEvent.setup>;
}

export function renderApp(
  options: { hash?: string; routes?: RouteTable; server?: MockServer; clock?: TestClock } = {},
): AppHarness {
  const server = options.server ?? createMockServer({ ...defaultRoutes(), ...options.routes });
  const { services, clock } = createTestServices({
    server,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  window.location.hash = options.hash ?? '#/';
  const user = userEvent.setup();
  const result = render(<App services={services} />);
  return { ...result, services, server, clock, user };
}
