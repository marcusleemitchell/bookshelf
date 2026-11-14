/**
 * Bookpine CSV export → typed rows (SPEC §8). Pure: no database, no clock.
 *
 * The export has 18 columns (order does not matter, extra columns are
 * ignored with a warning). Multi-value cells use their own mini-formats:
 *
 * - `authors`, `shelves`, `lists`: comma-separated.
 * - `readings`: entries separated by `||`, each `key=value` pairs separated
 *   by `;` (`started_at`, `finished_at`, `status`, `format`, `length`,
 *   `length_type`, `progress`).
 * - `notes`: entries separated by `||` before `date=`, each
 *   `date=YYYY-MM-DD;content=<free text>`. Content that starts with
 *   `Book Id:` is a Goodreads import blob of `Key: value` lines.
 */
import {
  isDateKey,
  isValidIsbn10,
  isValidIsbn13,
  type DateKey,
  type ImportWarning,
} from '../../shared/index.ts';
import { CsvError, parseCsv } from './csv.ts';

export const BOOKPINE_COLUMNS = [
  'slug',
  'title',
  'private',
  'authors',
  'isbn_10',
  'isbn_13',
  'publication_date',
  'language',
  'format',
  'pages_minutes',
  'shelves',
  'owned',
  'lists',
  'rating',
  'review',
  'notes',
  'readings',
  'transactions',
] as const;

type Column = (typeof BOOKPINE_COLUMNS)[number];

/** The export is not a Bookpine CSV (or is unreadable). */
export class BookpineFormatError extends Error {
  override readonly name = 'BookpineFormatError';
}

export type { ImportWarning };

export type LengthType = 'percent' | 'page' | 'minute';

export interface BookpineReading {
  /** 0-based position within the row's readings. */
  index: number;
  startedAt: DateKey | null;
  finishedAt: DateKey | null;
  /** `finished`, `in-progress`, `paused` (others kept as given, lower-cased). */
  status: string;
  /** Per-reading format as given (often contradicts the book; see SPEC §8). */
  format: string | null;
  length: number | null;
  lengthType: LengthType | null;
  progress: number | null;
}

export interface GoodreadsData {
  pages: number | null;
  dateRead: DateKey | null;
  /** True when the blob's "My Review" or "Private Notes" had text (not imported). */
  hasText: boolean;
}

export interface BookpineNote {
  date: DateKey | null;
  content: string;
  /** Parsed fields when the note is a Goodreads import blob, else null. */
  goodreads: GoodreadsData | null;
}

export interface BookpineRow {
  line: number;
  slug: string;
  title: string;
  private: boolean;
  authors: string[];
  isbn10: string | null;
  isbn13: string | null;
  publicationDate: string | null;
  language: string | null;
  format: string;
  pagesMinutes: number | null;
  shelves: string[];
  owned: boolean;
  lists: string[];
  rating: number | null;
  review: string | null;
  notes: BookpineNote[];
  readings: BookpineReading[];
  transactions: string | null;
}

export interface ParsedExport {
  rows: BookpineRow[];
  warnings: ImportWarning[];
}

const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'ph.d.']);

/** Splits a comma-separated author list, keeping suffixes such as "Jr." with their name. */
export function splitAuthors(raw: string): string[] {
  const names: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (NAME_SUFFIXES.has(name.toLowerCase()) && names.length > 0) {
      names[names.length - 1] = `${names[names.length - 1] as string}, ${name}`;
    } else {
      names.push(name);
    }
  }
  return names;
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function text(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function number(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

function flag(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** A `YYYY-MM-DD` cell: the date, or null when empty; `invalid` when present but malformed. */
function dateKey(raw: string | undefined): { key: DateKey | null; invalid: boolean } {
  const value = raw?.trim() ?? '';
  if (value === '') return { key: null, invalid: false };
  return isDateKey(value) ? { key: value, invalid: false } : { key: null, invalid: true };
}

function isbn(
  raw: string,
  valid: (value: string) => boolean,
  label: string,
  slug: string,
  warnings: ImportWarning[],
): string | null {
  const value = raw.replace(/[\s-]/g, '').toUpperCase();
  if (value === '') return null;
  if (valid(value)) return value;
  warnings.push({ slug, message: `Ignored the invalid ${label} "${raw.trim()}"` });
  return null;
}

/** Parses the `readings` cell. */
export function parseReadings(
  raw: string,
  slug: string,
  warnings: ImportWarning[],
): BookpineReading[] {
  if (raw.trim() === '') return [];
  return raw.split('||').map((entry, index) => {
    const pairs = new Map<string, string>();
    for (const part of entry.split(';')) {
      const at = part.indexOf('=');
      if (at <= 0) continue;
      pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    const dates = (['started_at', 'finished_at'] as const).map((key) => {
      const value = dateKey(pairs.get(key));
      if (value.invalid) {
        warnings.push({
          slug,
          message: `Reading ${index + 1}: ignored the invalid date ${key}="${pairs.get(key) ?? ''}"`,
        });
      }
      return value.key;
    });
    const lengthType = pairs.get('length_type')?.toLowerCase() ?? '';
    return {
      index,
      startedAt: dates[0] ?? null,
      finishedAt: dates[1] ?? null,
      status: (pairs.get('status') ?? '').toLowerCase(),
      format: text(pairs.get('format') ?? ''),
      length: number(pairs.get('length')),
      lengthType:
        lengthType === 'percent' || lengthType === 'page' || lengthType === 'minute'
          ? lengthType
          : null,
      progress: number(pairs.get('progress')),
    };
  });
}

const GOODREADS_EMPTY = new Set(['', '-']);

/** Parses a Goodreads import blob ("Key: value" lines). */
export function parseGoodreads(content: string): GoodreadsData {
  const fields = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const pages = number(fields.get('number of pages'));
  const read = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(fields.get('date read') ?? '');
  const dateRead = read ? `${read[1]}-${read[2]}-${read[3]}` : null;
  return {
    pages: pages !== null && Number.isInteger(pages) && pages > 0 ? pages : null,
    dateRead: dateRead && isDateKey(dateRead) ? dateRead : null,
    hasText: ['my review', 'private notes'].some(
      (key) => !GOODREADS_EMPTY.has(fields.get(key) ?? ''),
    ),
  };
}

/** Parses the `notes` cell. */
export function parseNotes(raw: string): BookpineNote[] {
  if (raw.trim() === '') return [];
  return raw.split(/\|\|(?=date=)/).flatMap((entry): BookpineNote[] => {
    const match = /^date=([^;]*);content=([\s\S]*)$/.exec(entry);
    const date = match ? dateKey(match[1]).key : null;
    const content = (match ? (match[2] as string) : entry).trim();
    if (content === '') return [];
    return [
      {
        date,
        content,
        goodreads: content.startsWith('Book Id:') ? parseGoodreads(content) : null,
      },
    ];
  });
}

function parseRating(raw: string, slug: string, warnings: ImportWarning[]): number | null {
  const value = number(raw);
  if (value === null || value === 0) return null;
  if (value >= 0.5 && value <= 5 && Number.isInteger(value * 2)) return value;
  warnings.push({ slug, message: `Ignored the rating "${raw.trim()}" (not 0.5–5 in half steps)` });
  return null;
}

/** Parses a Bookpine CSV export. Throws {@link BookpineFormatError} when it is not one. */
export function parseBookpineCsv(input: string): ParsedExport {
  let records;
  try {
    records = parseCsv(input);
  } catch (error) {
    if (error instanceof CsvError) {
      throw new BookpineFormatError(`The file is not valid CSV: ${error.message}`);
    }
    throw error;
  }
  const [header, ...body] = records;
  if (!header) throw new BookpineFormatError('The file is empty');
  const names = header.fields.map((name) => name.trim().toLowerCase());
  const missing = BOOKPINE_COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    throw new BookpineFormatError(
      `This is not a Bookpine export: missing column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`,
    );
  }
  const warnings: ImportWarning[] = [];
  const extra = names.filter((name) => !(BOOKPINE_COLUMNS as readonly string[]).includes(name));
  if (extra.length > 0) {
    warnings.push({ slug: null, message: `Ignored unknown columns: ${extra.join(', ')}` });
  }
  const indexOf = new Map(names.map((name, index) => [name, index]));
  const seen = new Set<string>();
  const rows: BookpineRow[] = [];
  for (const record of body) {
    const cell = (column: Column) => record.fields[indexOf.get(column) as number] ?? '';
    const slug = cell('slug').trim();
    const title = cell('title').trim().replace(/\s+/g, ' ');
    if (!slug) {
      warnings.push({ slug: null, message: `Skipped the row on line ${record.line}: no slug` });
      continue;
    }
    if (seen.has(slug)) {
      warnings.push({
        slug,
        message: `Skipped a second row with the same slug (line ${record.line})`,
      });
      continue;
    }
    if (!title) {
      warnings.push({ slug, message: 'Skipped: the row has no title' });
      continue;
    }
    seen.add(slug);
    const pagesMinutes = number(cell('pages_minutes'));
    rows.push({
      line: record.line,
      slug,
      title,
      private: flag(cell('private')),
      authors: splitAuthors(cell('authors')),
      isbn10: isbn(cell('isbn_10'), isValidIsbn10, 'ISBN-10', slug, warnings),
      isbn13: isbn(cell('isbn_13'), isValidIsbn13, 'ISBN-13', slug, warnings),
      publicationDate: text(cell('publication_date')),
      language: text(cell('language'))?.toLowerCase() ?? null,
      format: cell('format').trim().toLowerCase(),
      pagesMinutes:
        pagesMinutes !== null && Number.isInteger(pagesMinutes) && pagesMinutes > 0
          ? pagesMinutes
          : null,
      shelves: splitList(cell('shelves')),
      owned: flag(cell('owned')),
      lists: splitList(cell('lists')),
      rating: parseRating(cell('rating'), slug, warnings),
      review: text(cell('review')),
      notes: parseNotes(cell('notes')),
      readings: parseReadings(cell('readings'), slug, warnings),
      transactions: text(cell('transactions')),
    });
  }
  return { rows, warnings };
}
