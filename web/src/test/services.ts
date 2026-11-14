/**
 * Test services: a mock API, a fixed clock, a fresh IndexedDB (fake-indexeddb)
 * and deterministic IDs.
 */
import { createServices, type Services } from '../app/services.ts';
import { NOW, TIME_ZONE, uuid } from './fixtures.ts';
import { createMockServer, type MockServer } from './server.ts';

let dbCounter = 0;

export interface TestClock {
  now: () => Date;
  set: (iso: string) => void;
}

export function createClock(start = NOW): TestClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso);
    },
  };
}

/** Deterministic UUIDs starting at 1000. */
export function idSequence(start = 1000): () => string {
  let next = start;
  return () => uuid(next++);
}

export interface TestServicesOptions {
  server?: MockServer;
  clock?: TestClock;
}

export function createTestServices(options: TestServicesOptions = {}): {
  services: Services;
  server: MockServer;
  clock: TestClock;
} {
  const server = options.server ?? createMockServer();
  const clock = options.clock ?? createClock();
  dbCounter += 1;
  const services = createServices({
    fetch: server.fetch,
    dbName: `bookshelf-test-${String(dbCounter)}-${String(Math.random()).slice(2)}`,
    now: clock.now,
    timeZone: TIME_ZONE,
    newId: idSequence(),
  });
  return { services, server, clock };
}
