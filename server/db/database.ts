/**
 * SQLite access via the built-in `node:sqlite` driver (SPEC §2): WAL mode,
 * foreign keys on, synchronous API. All writes that must be atomic go
 * through {@link transaction}.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Db = DatabaseSync;
export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

const statementCache = new WeakMap<Db, Map<string, StatementSync>>();

/** A cached prepared statement for `sql`. */
export function statement(db: Db, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export function all<T = Row>(db: Db, sql: string, params: readonly SqlValue[] = []): T[] {
  return statement(db, sql).all(...params) as T[];
}

export function run(db: Db, sql: string, params: readonly SqlValue[] = []): number {
  return Number(statement(db, sql).run(...params).changes);
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws.
 * Nested calls join the outer transaction. `fn` must be synchronous.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** True when `error` is a SQLite constraint violation (UNIQUE, FOREIGN KEY, CHECK, NOT NULL). */
export function isConstraintError(error: unknown): error is Error & { errstr: string } {
  return (
    error instanceof Error &&
    'errstr' in error &&
    (error as { errstr: unknown }).errstr === 'constraint failed'
  );
}
