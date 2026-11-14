/**
 * Server entry point: loads configuration, opens and migrates the database,
 * starts snapshots and listens on 127.0.0.1 only (ADR 0002).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { configSecrets, loadConfig, loadDotEnv, systemContext, type Config } from './config.ts';
import type { AppContext } from './context.ts';
import { openDatabase, type Db } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { createLogger } from './logger.ts';
import { startSnapshotScheduler } from './services/snapshots.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

function startupFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Bookshelf failed to start: ${message}\n`);
  process.exit(1);
}

let config: Config;
try {
  loadDotEnv(repoRoot);
  config = loadConfig(process.env, systemContext(repoRoot, version));
} catch (error) {
  startupFailure(error);
}
const logger = createLogger({ level: config.logLevel, secrets: configSecrets(config) });

let db: Db;
try {
  for (const dir of [config.dataDir, config.coversDir, config.backupsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  db = openDatabase(config.dbPath);
  const migration = migrate(db);
  logger.info('Database ready', {
    dbPath: config.dbPath,
    schemaVersion: migration.version,
    applied: migration.applied,
  });
} catch (error) {
  startupFailure(error);
}

const ctx: AppContext = {
  db,
  config,
  logger,
  fetch: globalThis.fetch,
  now: () => new Date(),
  sleep: (ms) => delay(ms),
};
const app = createApp(ctx, { staticDir: config.webDistDir });
const snapshots = startSnapshotScheduler(ctx);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info('Bookshelf listening', {
    url: `http://${config.host}:${info.port}`,
    version,
    timeZone: config.timeZone,
    notion: config.notion ? 'configured' : 'not configured',
  });
});

server.on('error', (error) => {
  logger.error('Server error', { error });
  startupFailure(error);
});

function shutdown(signal: string): void {
  logger.info('Shutting down', { signal });
  snapshots.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
