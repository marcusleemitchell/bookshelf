/**
 * Table definitions and generic row mapping. Entities are camelCase objects
 * (the shared schemas); columns are the snake_case equivalents. JSON array
 * fields are stored as TEXT.
 */
import type {
  ActiveTimer,
  BookFormat,
  BookNote,
  BookRecord,
  Goal,
  Read,
  Session,
  Tag,
} from '../../shared/index.ts';
import { all, run, type Db, type Row, type SqlValue } from '../db/database.ts';

export interface Table<T> {
  name: string;
  columns: readonly (keyof T & string)[];
  json: ReadonlySet<keyof T & string>;
  /** Extra stored columns computed from the entity (e.g. normalised keys). */
  computed: Readonly<Record<string, (entity: T) => SqlValue>>;
}

export function toColumn(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function defineTable<T>(
  name: string,
  columns: readonly (keyof T & string)[],
  options: {
    json?: readonly (keyof T & string)[];
    computed?: Record<string, (entity: T) => SqlValue>;
  } = {},
): Table<T> {
  return { name, columns, json: new Set(options.json ?? []), computed: options.computed ?? {} };
}

/** Normalised key used for case-insensitive tag-name uniqueness. */
export function tagNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('en-GB');
}

const syncTimestamps = ['createdAt', 'updatedAt', 'deletedAt'] as const;

export const booksTable = defineTable<BookRecord>(
  'books',
  [
    'id',
    'title',
    'subtitle',
    'authors',
    'publisher',
    'publishedDate',
    'language',
    'synopsis',
    'coverUrl',
    'coverPath',
    'isbn10',
    'isbn13',
    'genres',
    'source',
    'sourceId',
    'status',
    'rating',
    ...syncTimestamps,
  ],
  { json: ['authors', 'genres'] },
);

export const formatsTable = defineTable<BookFormat>('book_formats', [
  'id',
  'bookId',
  'format',
  'pageCount',
  'audioDurationSeconds',
  'isbn',
  ...syncTimestamps,
]);

export const readsTable = defineTable<Read>('reads', [
  'id',
  'bookId',
  'number',
  'startedAt',
  'finishedAt',
  'outcome',
  ...syncTimestamps,
]);

export const sessionsTable = defineTable<Session>('sessions', [
  'id',
  'readId',
  'bookId',
  'formatId',
  'startedAt',
  'endedAt',
  'durationSeconds',
  'progressUnit',
  'startValue',
  'endValue',
  'startPercent',
  'endPercent',
  'note',
  'source',
  ...syncTimestamps,
]);

export const timerTable = defineTable<ActiveTimer>('active_timer', [
  'id',
  'bookId',
  'formatId',
  'startedAt',
  'resumedAt',
  'pausedAt',
  'accumulatedSeconds',
  'createdAt',
  'updatedAt',
]);

export const tagsTable = defineTable<Tag>('tags', ['id', 'name', 'colour', ...syncTimestamps], {
  computed: { name_key: (tag) => tagNameKey(tag.name) },
});

export const notesTable = defineTable<BookNote>('book_notes', [
  'id',
  'bookId',
  'kind',
  'text',
  'location',
  ...syncTimestamps,
]);

export const goalsTable = defineTable<Goal>('goals', [
  'id',
  'kind',
  'year',
  'target',
  ...syncTimestamps,
]);

export function fromRow<T>(table: Table<T>, row: Row): T {
  const entity: Record<string, unknown> = {};
  for (const key of table.columns) {
    const value = row[toColumn(key)];
    entity[key] = table.json.has(key) && typeof value === 'string' ? JSON.parse(value) : value;
  }
  return entity as T;
}

function allColumns<T>(table: Table<T>): string[] {
  return [...table.columns.map(toColumn), ...Object.keys(table.computed)];
}

function toParams<T>(table: Table<T>, entity: T): SqlValue[] {
  const record = entity as Record<string, unknown>;
  const values = table.columns.map((key) => {
    const value = record[key];
    if (table.json.has(key)) return JSON.stringify(value);
    return value === undefined ? null : (value as SqlValue);
  });
  return [...values, ...Object.values(table.computed).map((compute) => compute(entity))];
}

/** Inserts a new row. */
export function insertRow<T>(db: Db, table: Table<T>, entity: T): void {
  const columns = allColumns(table);
  run(
    db,
    `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    toParams(table, entity),
  );
}

/** Inserts or fully replaces the row with the entity's id. */
export function upsertRow<T>(db: Db, table: Table<T>, entity: T): void {
  const columns = allColumns(table);
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  run(
    db,
    `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    toParams(table, entity),
  );
}

/** The row with `id`, including soft-deleted rows. */
export function findById<T>(db: Db, table: Table<T>, id: string): T | undefined {
  const row = all(db, `SELECT * FROM ${table.name} WHERE id = ?`, [id])[0];
  return row ? fromRow(table, row) : undefined;
}

/** Rows matching an optional SQL `where` clause (without the WHERE keyword). */
export function findMany<T>(
  db: Db,
  table: Table<T>,
  where = '1 = 1',
  params: readonly SqlValue[] = [],
  orderBy = 'created_at, rowid',
): T[] {
  return all(db, `SELECT * FROM ${table.name} WHERE ${where} ORDER BY ${orderBy}`, params).map(
    (row) => fromRow(table, row),
  );
}

export type TableName =
  'books' | 'book_formats' | 'reads' | 'sessions' | 'tags' | 'book_notes' | 'goals';

/** Sync metadata of any row (including soft-deleted ones), or undefined when absent. */
export function rowMeta(
  db: Db,
  table: TableName,
  id: string,
): { updatedAt: string; deletedAt: string | null } | undefined {
  const row = all<{ updated_at: string; deleted_at: string | null }>(
    db,
    `SELECT updated_at, deleted_at FROM ${table} WHERE id = ?`,
    [id],
  )[0];
  return row ? { updatedAt: row.updated_at, deletedAt: row.deleted_at } : undefined;
}
