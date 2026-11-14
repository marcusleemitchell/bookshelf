import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isConstraintError, openDatabase, rollbackOnly, transaction, type Db } from './database.ts';
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

/** A directory holding copies of the first `count` shipped migrations. */
function shippedMigrationsUpTo(count: number): string {
  const target = mkdtempSync(join(dir, 'shipped-'));
  for (const file of readdirSync(MIGRATIONS_DIR).sort().slice(0, count)) {
    copyFileSync(join(MIGRATIONS_DIR, file), join(target, file));
  }
  return target;
}

const T = '2026-11-01T10:00:00.000Z';

/** Inserts a book with a format, read, session, tag, note and timer at schema version 1. */
function seedVersion1(): void {
  db.exec(`INSERT INTO books (id, title, authors, genres, source, status, rating, created_at, updated_at)
      VALUES ('b1', 'Kindred', '["Octavia E. Butler"]', '[]', 'manual', 'reading', 4.5, '${T}', '${T}');
    INSERT INTO book_formats (id, book_id, format, page_count, created_at, updated_at)
      VALUES ('f1', 'b1', 'physical', 264, '${T}', '${T}');
    INSERT INTO reads (id, book_id, number, started_at, outcome, created_at, updated_at)
      VALUES ('r1', 'b1', 1, '${T}', 'in_progress', '${T}', '${T}');
    INSERT INTO sessions (id, read_id, book_id, format_id, started_at, ended_at, duration_seconds,
        progress_unit, start_value, end_value, start_percent, end_percent, created_at, updated_at)
      VALUES ('s1', 'r1', 'b1', 'f1', '${T}', '${T}', 1800, 'pages', 0, 26, 0, 9.85, '${T}', '${T}');
    INSERT INTO tags (id, name, name_key, created_at, updated_at) VALUES ('t1', 'Classics', 'classics', '${T}', '${T}');
    INSERT INTO book_tags (book_id, tag_id, created_at) VALUES ('b1', 't1', '${T}');
    INSERT INTO book_notes (id, book_id, kind, text, created_at, updated_at)
      VALUES ('n1', 'b1', 'quote', 'Quoted line', '${T}', '${T}');
    INSERT INTO active_timer (id, book_id, format_id, started_at, resumed_at, created_at, updated_at)
      VALUES ('timer', 'b1', 'f1', '${T}', '${T}', '${T}', '${T}');`);
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
    expect(result).toEqual({
      applied: ['0001_initial', '0002_paused_status', '0003_untimed_sessions', '0004_import_links'],
      version: 4,
    });
    expect(tables()).toEqual([
      'active_timer',
      'book_formats',
      'book_notes',
      'book_tags',
      'books',
      'goals',
      'import_links',
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
      { version: 2, name: 'paused_status', applied_at: '2026-11-14T12:00:00.000Z' },
      { version: 3, name: 'untimed_sessions', applied_at: '2026-11-14T12:00:00.000Z' },
      { version: 4, name: 'import_links', applied_at: '2026-11-14T12:00:00.000Z' },
    ]);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('upgrades a version 1 database without losing or changing rows', () => {
    migrate(db, shippedMigrationsUpTo(1));
    seedVersion1();
    const before = db.prepare('SELECT * FROM books').all();
    const sessionsBefore = db.prepare('SELECT * FROM sessions').all();
    expect(migrate(db).applied).toEqual(
      expect.arrayContaining(['0002_paused_status', '0003_untimed_sessions']),
    );
    expect(db.prepare('SELECT * FROM books').all()).toEqual(before);
    // Sessions keep every value and are marked as logged in the app.
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual(
      sessionsBefore.map((row) => ({ ...row, source: 'app' })),
    );
    db.exec("UPDATE sessions SET duration_seconds = NULL WHERE id = 's1'");
    expect(() => {
      db.exec("UPDATE sessions SET source = 'kindle' WHERE id = 's1'");
    }).toThrow(/CHECK/);
    expect(db.prepare('SELECT book_id FROM book_tags').all()).toEqual([{ book_id: 'b1' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'books'")
        .all()
        .map((row) => row['name'])
        .sort(),
    ).toEqual(['books_isbn13_idx', 'books_status_idx', 'sqlite_autoindex_books_1']);
    // The new status is accepted; unknown ones are still refused.
    db.exec("UPDATE books SET status = 'paused' WHERE id = 'b1'");
    expect(() => {
      db.exec("UPDATE books SET status = 'shelved' WHERE id = 'b1'");
    }).toThrow(/CHECK/);
    // Child rows still reference the rebuilt table.
    expect(() => {
      db.exec(
        `INSERT INTO book_formats (id, book_id, format, created_at, updated_at) VALUES ('f2', 'missing', 'kindle', '${T}', '${T}')`,
      );
    }).toThrow(/FOREIGN KEY/);
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

  it('rolls back a dry run whatever happens, and refuses to nest one', () => {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const count = rollbackOnly(db, () => {
      db.prepare("INSERT INTO t VALUES ('a')").run();
      return db.prepare('SELECT COUNT(*) AS n FROM t').get();
    });
    expect(count).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    expect(() =>
      rollbackOnly(db, () => {
        db.prepare("INSERT INTO t VALUES ('b')").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    expect(() => transaction(db, () => rollbackOnly(db, () => 1))).toThrow(
      /cannot run inside another transaction/,
    );
    expect(db.isTransaction).toBe(false);
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
