/**
 * Forward-only SQL migration runner (SPEC §2). Migrations live in
 * `server/migrations/NNNN_name.sql`, are applied in order inside a
 * transaction each, and are recorded in `schema_migrations`.
 * Migration files must not contain their own BEGIN/COMMIT.
 *
 * A migration whose first line is {@link FOREIGN_KEYS_OFF_DIRECTIVE} runs
 * with foreign-key enforcement switched off, which SQLite requires for
 * rebuilding a table that other tables reference (create new → copy → drop
 * old → rename). `PRAGMA foreign_key_check` must then report no violations
 * before the transaction commits; enforcement is always switched back on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, run, transaction, type Db } from './database.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** First line that makes a migration run with foreign keys off (table rebuilds). */
export const FOREIGN_KEYS_OFF_DIRECTIVE = '-- migrate:foreign-keys-off';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** True when the file starts with {@link FOREIGN_KEYS_OFF_DIRECTIVE}. */
  foreignKeysOff: boolean;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/** Reads and validates the migration files in `dir` (contiguous versions from 1). */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations = files.map((file) => {
    const match = FILE_RE.exec(file);
    if (!match) {
      throw new MigrationError(`Migration file "${file}" must be named NNNN_name.sql`);
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    return {
      version: Number(match[1]),
      name: match[2] as string,
      sql,
      foreignKeysOff: sql.split('\n', 1)[0]?.trim() === FOREIGN_KEYS_OFF_DIRECTIVE,
    };
  });
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 0001; expected ${String(index + 1).padStart(4, '0')} but found ${String(migration.version).padStart(4, '0')}_${migration.name}`,
      );
    }
  });
  return migrations;
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

/** Highest applied migration version (0 for a fresh database). */
export function currentSchemaVersion(db: Db): number {
  ensureMigrationsTable(db);
  const row = all<{ version: number | null }>(
    db,
    'SELECT MAX(version) AS version FROM schema_migrations',
  )[0];
  return row?.version ?? 0;
}

function assertNoForeignKeyViolations(db: Db, label: string): void {
  const violations = all<{ table: string; parent: string }>(db, 'PRAGMA foreign_key_check');
  if (violations.length > 0) {
    const first = violations[0] as { table: string; parent: string };
    throw new MigrationError(
      `Migration ${label} left ${violations.length} foreign key violation(s), e.g. ${first.table} → ${first.parent}`,
    );
  }
}

export interface MigrationResult {
  applied: string[];
  version: number;
}

/** Applies pending migrations. Refuses to run against a database newer than the code. */
export function migrate(
  db: Db,
  dir: string = MIGRATIONS_DIR,
  now: () => Date = () => new Date(),
): MigrationResult {
  const migrations = loadMigrations(dir);
  ensureMigrationsTable(db);
  const appliedVersions = new Set(
    all<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((row) => row.version),
  );
  const latest = migrations.length;
  for (const version of appliedVersions) {
    if (version > latest) {
      throw new MigrationError(
        `Database schema version ${version} is newer than this build (latest ${latest}); upgrade Bookshelf`,
      );
    }
  }
  const applied: string[] = [];
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    const label = `${String(migration.version).padStart(4, '0')}_${migration.name}`;
    // PRAGMA foreign_keys is a no-op inside a transaction, so switch it first.
    if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(migration.sql);
        if (migration.foreignKeysOff) assertNoForeignKeyViolations(db, label);
        run(db, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          now().toISOString(),
        ]);
      });
    } finally {
      if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
    applied.push(label);
  }
  return { applied, version: currentSchemaVersion(db) };
}
