import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isConstraintError, openDatabase, transaction, type Db } from './database.ts';
import {
  currentSchemaVersion,
  FOREIGN_KEYS_OFF_DIRECTIVE,
  loadMigrations,
  migrate,
  MigrationError,
  MIGRATIONS_DIR,
} from './migrate.ts';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookshelf-migrate-'));
  db = openDatabase(join(dir, 'test.db'));
});

afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function migrationsDir(files: Record<string, string>): string {
  const target = mkdtempSync(join(dir, 'migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(target, name), sql);
  return target;
}

function tables(): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row['name'] as string);
}

describe('migrate', () => {
  it('applies the shipped migrations to a fresh database', () => {
    const result = migrate(db, MIGRATIONS_DIR, () => new Date('2026-11-14T12:00:00.000Z'));
    expect(result).toEqual({ applied: ['0001_initial'], version: 1 });
    expect(tables()).toEqual([
      'active_timer',
      'book_formats',
      'book_notes',
      'book_tags',
      'books',
      'goals',
      'notion_pages',
      'reads',
      'schema_migrations',
      'sessions',
      'settings',
      'sync_ops',
      'tags',
    ]);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual([
      { version: 1, name: 'initial', applied_at: '2026-11-14T12:00:00.000Z' },
    ]);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('is idempotent and applies only new migrations', () => {
    const migrations = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    expect(migrate(db, migrations).applied).toEqual(['0001_a']);
    expect(migrate(db, migrations).applied).toEqual([]);
    writeFileSync(join(migrations, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');
    expect(migrate(db, migrations)).toEqual({ applied: ['0002_b'], version: 2 });
    expect(currentSchemaVersion(db)).toBe(2);
  });

  it('rolls back a failing migration', () => {
    const migrations = migrationsDir({
      '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
      '0002_bad.sql': 'CREATE TABLE b (id INTEGER); INSERT INTO missing VALUES (1);',
    });
    expect(() => migrate(db, migrations)).toThrow(/no such table: missing/);
    expect(tables()).not.toContain('b');
    expect(currentSchemaVersion(db)).toBe(1);
  });

  it('rejects misnamed files and gaps', () => {
    expect(() => loadMigrations(migrationsDir({ '1_initial.sql': '' }))).toThrow(MigrationError);
    expect(() => loadMigrations(migrationsDir({ '0001_a.sql': '', '0003_c.sql': '' }))).toThrow(
      /expected 0002 but found 0003_c/,
    );
    expect(
      loadMigrations(migrationsDir({ 'README.md': 'ignored', '0001_a.sql': 'SELECT 1;' })),
    ).toHaveLength(1);
  });

  it('rebuilds a referenced table with foreign keys off when the directive is present', () => {
    const migrations = migrationsDir({
      '0001_a.sql': `CREATE TABLE parent (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('x')));
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent (id));
        INSERT INTO parent VALUES ('p1', 'x');
        INSERT INTO child VALUES ('c1', 'p1');`,
      '0002_rebuild.sql': `${FOREIGN_KEYS_OFF_DIRECTIVE}
        CREATE TABLE parent_new (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('x', 'y')));
        INSERT INTO parent_new (id, kind) SELECT id, kind FROM parent;
        DROP TABLE parent;
        ALTER TABLE parent_new RENAME TO parent;`,
    });
    expect(loadMigrations(migrations).map((m) => m.foreignKeysOff)).toEqual([false, true]);
    expect(migrate(db, migrations).applied).toEqual(['0001_a', '0002_rebuild']);
    db.prepare("INSERT INTO parent VALUES ('p2', 'y')").run();
    expect(db.prepare('SELECT parent_id FROM child').all()).toEqual([{ parent_id: 'p1' }]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // Enforcement is back on: an orphan child is refused.
    expect(() => db.prepare("INSERT INTO child VALUES ('c2', 'missing')").run()).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('refuses a foreign-keys-off migration that leaves violations, and re-enables enforcement', () => {
    const migrations = migrationsDir({
      '0001_a.sql': `CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent (id));
        INSERT INTO parent VALUES ('p1');
        INSERT INTO child VALUES ('c1', 'p1');`,
      '0002_lossy.sql': `${FOREIGN_KEYS_OFF_DIRECTIVE}
        DELETE FROM parent;`,
    });
    expect(() => migrate(db, migrations)).toThrow(
      /0002_lossy left 1 foreign key violation\(s\), e\.g\. child → parent/,
    );
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.prepare('SELECT id FROM parent').all()).toEqual([{ id: 'p1' }]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('refuses a database newer than the code', () => {
    const migrations = migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' });
    migrate(db, migrations);
    db.prepare(
      "INSERT INTO schema_migrations VALUES (2, 'future', '2030-01-01T00:00:00.000Z')",
    ).run();
    expect(() => migrate(db, migrations)).toThrow(/newer than this build/);
  });
});

describe('database helpers', () => {
  it('commits, rolls back and joins nested transactions', () => {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    transaction(db, () => {
      db.prepare("INSERT INTO t VALUES ('a')").run();
      transaction(db, () => db.prepare("INSERT INTO t VALUES ('b')").run());
    });
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO t VALUES ('c')").run();
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(
      db
        .prepare('SELECT id FROM t ORDER BY id')
        .all()
        .map((r) => r['id']),
    ).toEqual(['a', 'b']);
  });

  it('recognises constraint errors', () => {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.prepare("INSERT INTO t VALUES ('a')").run();
    let caught: unknown;
    try {
      db.prepare("INSERT INTO t VALUES ('a')").run();
    } catch (error) {
      caught = error;
    }
    expect(isConstraintError(caught)).toBe(true);
    expect(isConstraintError(new Error('x'))).toBe(false);
    expect(isConstraintError('x')).toBe(false);
  });
});
