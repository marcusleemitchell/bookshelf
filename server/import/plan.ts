/**
 * Bookpine rows → an import plan (SPEC §8): merged books with their formats,
 * reads, sessions, notes and tags. Pure and deterministic: the same rows and
 * timezone always give the same plan. Applying it to the database
 * (provenance, updates, enrichment) is `server/services/bookpine.ts`.
 *
 * Planned records carry a key *suffix* (e.g. `read:1`, `day:2026-03-02`);
 * the importer prefixes it with the book's anchor slug to get the
 * provenance key, so the same reading always maps to the same row.
 */
import {
  diffDays,
  zonedTimeToUtc,
  type BookStatus,
  type DateKey,
  type FormatType,
  type ProgressUnit,
  type ReadOutcome,
} from '../../shared/index.ts';
import type { BookpineReading, BookpineRow, ImportWarning, ParsedExport } from './bookpine.ts';

/** A gap longer than this between reading days starts a new read (SPEC §8). */
export const READ_GAP_DAYS = 180;
/** Longest tag name Bookshelf accepts. */
const MAX_TAG_LENGTH = 50;
/** Longest note Bookshelf accepts. */
const MAX_NOTE_LENGTH = 20_000;

export interface PlannedFormat {
  type: FormatType;
  pageCount: number | null;
  audioDurationSeconds: number | null;
  isbn: string | null;
}

export interface PlannedSession {
  suffix: string;
  format: FormatType;
  day: DateKey;
  startedAt: string;
  endedAt: string;
  progressUnit: ProgressUnit;
  startValue: number | null;
  endValue: number | null;
}

export interface PlannedRead {
  suffix: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: ReadOutcome;
  sessions: PlannedSession[];
}

export interface PlannedNote {
  suffix: string;
  text: string;
}

export interface PlannedBook {
  /** Every edition's slug, in file order. */
  slugs: string[];
  /** The smallest slug: the default prefix of provenance keys. */
  anchor: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  publishedDate: string | null;
  language: string | null;
  isbn10: string | null;
  isbn13: string | null;
  status: BookStatus;
  rating: number | null;
  tags: string[];
  formats: PlannedFormat[];
  reads: PlannedRead[];
  notes: PlannedNote[];
  /** Every edition's ISBN-13s and ISBN-10s, for matching existing books. */
  isbns: string[];
}

export interface PlannedMerge {
  title: string;
  slugs: string[];
}

export interface ImportPlan {
  rows: number;
  books: PlannedBook[];
  merges: PlannedMerge[];
  warnings: ImportWarning[];
}

// --- Normalisation -------------------------------------------------------------

/**
 * Comparison key for titles and names: Unicode-decomposed, accents removed,
 * lower-cased, `&` read as "and", punctuation and spacing collapsed. Letters
 * of every script are kept (a Chinese title keeps its characters).
 */
export function normaliseKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function stripDecorations(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/,[^,]*\bedition\s*$/i, ' ');
}

/**
 * Title keys used to find duplicate editions (SPEC §8): the main title
 * (before the first `:`) without bracketed parts such as "(Movie Tie-In)" or
 * a transliteration in `[…]`, and without a trailing ", … Edition" clause;
 * and the subtitle, compared separately.
 */
export function titleKeys(raw: string): { main: string; subtitle: string } {
  const at = raw.indexOf(':');
  const mainRaw = at >= 0 ? raw.slice(0, at) : raw;
  const subtitleRaw = at >= 0 ? raw.slice(at + 1) : '';
  const main = normaliseKey(stripDecorations(mainRaw)) || normaliseKey(raw);
  return { main, subtitle: normaliseKey(stripDecorations(subtitleRaw)) };
}

/** Splits a stored title at the first ": " into title and subtitle. */
export function splitTitle(raw: string): { title: string; subtitle: string | null } {
  const at = raw.indexOf(':');
  if (at <= 0) return { title: raw, subtitle: null };
  const title = raw.slice(0, at).trim();
  const subtitle = raw.slice(at + 1).trim();
  return title ? { title, subtitle: subtitle || null } : { title: raw, subtitle: null };
}

// --- Mapping -------------------------------------------------------------------

const AUDIO_FORMATS = new Set(['audiobook', 'audio', 'audio cd', 'audio_cd', 'audible', 'mp3']);
const EBOOK_FORMATS = new Set(['kindle', 'ebook', 'e-book', 'epub', 'pdf', 'digital']);
const PHYSICAL_FORMATS = new Set([
  'paperback',
  'hardcover',
  'hardback',
  'mass market paperback',
  'mass-market paperback',
  'trade paperback',
  'board book',
  'spiral-bound',
  'leather bound',
  'library binding',
  'physical',
]);

/** Book-level Bookpine format → Bookshelf format type (unknown → physical, flagged). */
export function bookFormatType(raw: string): { type: FormatType; known: boolean } {
  const value = raw.trim().toLowerCase();
  if (AUDIO_FORMATS.has(value)) return { type: 'audiobook', known: true };
  if (EBOOK_FORMATS.has(value)) return { type: 'kindle', known: true };
  return { type: 'physical', known: PHYSICAL_FORMATS.has(value) };
}

const SHELF_STATUS = new Map<string, BookStatus>([
  ['read', 'finished'],
  ['currently reading', 'reading'],
  ['currently-reading', 'reading'],
  ['want to read', 'to_read'],
  ['to-read', 'to_read'],
  ['paused', 'paused'],
  ['did not finish', 'dnf'],
  ['dnf', 'dnf'],
]);

/**
 * Merged status precedence (SPEC §8): an active state on any edition wins
 * (reading, then paused), then finished (the work was completed), then did
 * not finish, and to read last (a wish-list copy of a book already read).
 */
export const STATUS_PRECEDENCE: readonly BookStatus[] = [
  'reading',
  'paused',
  'finished',
  'dnf',
  'to_read',
];

function noonOf(day: DateKey, timeZone: string): string {
  return zonedTimeToUtc(day, 12, 0, timeZone).toISOString();
}

function maxDay(a: DateKey, b: DateKey): DateKey {
  return a > b ? a : b;
}

// --- Editions ------------------------------------------------------------------

interface Edition {
  row: BookpineRow;
  status: BookStatus;
  type: FormatType;
  extraTags: string[];
  goodreadsDateRead: DateKey | null;
}

function toEdition(row: BookpineRow, warnings: ImportWarning[]): Edition {
  let status: BookStatus | null = null;
  const extraTags: string[] = [];
  for (const shelf of row.shelves) {
    const mapped = SHELF_STATUS.get(shelf.toLowerCase());
    if (!mapped) {
      extraTags.push(shelf);
    } else if (status === null) {
      status = mapped;
    } else if (mapped !== status) {
      warnings.push({
        slug: row.slug,
        message: `Shelved as both "${row.shelves.find((s) => SHELF_STATUS.get(s.toLowerCase()) === status) ?? ''}" and "${shelf}"; used the first`,
      });
    }
  }
  if (status === null) {
    warnings.push({ slug: row.slug, message: 'No status shelf; imported as To read' });
    status = 'to_read';
  }
  extraTags.push(...row.lists);
  const format = bookFormatType(row.format);
  if (!format.known) {
    warnings.push({
      slug: row.slug,
      message: `Unknown format "${row.format}"; imported as a physical book`,
    });
  }
  if (row.transactions !== null) {
    warnings.push({ slug: row.slug, message: 'Transactions are not imported' });
  }
  const goodreads = row.notes.find((note) => note.goodreads !== null)?.goodreads ?? null;
  if (goodreads?.hasText) {
    warnings.push({
      slug: row.slug,
      message: 'The Goodreads note has review or private-note text, which is not imported',
    });
  }
  return {
    row,
    status,
    type: format.type,
    extraTags,
    goodreadsDateRead: goodreads?.dateRead ?? null,
  };
}

/** True when one subtitle key equals the other or starts it at a word boundary. */
export function subtitlesCompatible(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long === short || long.startsWith(`${short} `);
}

/**
 * Clusters the non-empty subtitle keys of same-title editions: shortest
 * first, each joins the first cluster whose members are all compatible
 * with it ("Songs from the Estuary" and "Songs from the Estuary — The
 * Bestselling Memoir" merge; "First Contact" and "The Long Silence" do not).
 */
export function subtitleClusters(subtitles: readonly string[]): Set<string>[] {
  const distinct = [...new Set(subtitles.filter(Boolean))].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  const clusters: Set<string>[] = [];
  for (const subtitle of distinct) {
    const home = clusters.find((cluster) =>
      [...cluster].every((member) => subtitlesCompatible(member, subtitle)),
    );
    if (home) home.add(subtitle);
    else clusters.push(new Set([subtitle]));
  }
  return clusters;
}

function groupEditions(editions: Edition[], warnings: ImportWarning[]): Edition[][] {
  const byKey = new Map<string, Edition[]>();
  const byTitle = new Map<string, Set<string>>();
  for (const edition of editions) {
    const { main } = titleKeys(edition.row.title);
    const author = normaliseKey(edition.row.authors[0] ?? '');
    const key = `${main}\u0000${author}`;
    byKey.set(key, [...(byKey.get(key) ?? []), edition]);
    byTitle.set(main, (byTitle.get(main) ?? new Set()).add(author));
  }
  for (const [main, authors] of byTitle) {
    if (authors.size < 2) continue;
    const slugs = editions
      .filter((e) => titleKeys(e.row.title).main === main)
      .map((e) => e.row.slug);
    warnings.push({
      slug: null,
      message: `Not merged (same title, different first author): ${slugs.join(', ')}`,
    });
  }
  const groups: Edition[][] = [];
  for (const group of byKey.values()) {
    const clusters = subtitleClusters(group.map((e) => titleKeys(e.row.title).subtitle));
    if (clusters.length <= 1) {
      groups.push(group);
      continue;
    }
    // Conflicting subtitles (e.g. a sequel): merge only compatible subtitles;
    // editions without a subtitle stay separate because the match is ambiguous.
    warnings.push({
      slug: null,
      message: `Not merged (same title, different subtitles): ${group.map((e) => e.row.slug).join(', ')}`,
    });
    for (const cluster of clusters) {
      groups.push(group.filter((e) => cluster.has(titleKeys(e.row.title).subtitle)));
    }
    for (const edition of group.filter((e) => !titleKeys(e.row.title).subtitle)) {
      groups.push([edition]);
    }
  }
  // Keep file order: a group sits where its first edition is.
  return groups.sort((a, b) => (a[0]?.row.line ?? 0) - (b[0]?.row.line ?? 0));
}

// --- Formats -------------------------------------------------------------------

function maxLength(readings: BookpineReading[], type: 'page' | 'minute'): number | null {
  const lengths = readings
    .filter((r) => r.lengthType === type && r.length !== null && r.length > 0)
    .map((r) => Math.round(r.length as number));
  return lengths.length > 0 ? Math.max(...lengths) : null;
}

function planFormats(editions: Edition[]): PlannedFormat[] {
  const formats = new Map<FormatType, PlannedFormat>();
  const add = (candidate: PlannedFormat) => {
    const existing = formats.get(candidate.type);
    if (!existing) {
      formats.set(candidate.type, candidate);
      return;
    }
    existing.pageCount ??= candidate.pageCount;
    existing.audioDurationSeconds ??= candidate.audioDurationSeconds;
    existing.isbn ??= candidate.isbn;
  };
  for (const { row, type } of editions) {
    const isbn = row.isbn13 ?? row.isbn10;
    const goodreadsPages =
      row.notes.find((note) => note.goodreads?.pages)?.goodreads?.pages ?? null;
    const minutes = maxLength(row.readings, 'minute');
    if (type === 'audiobook') {
      const total = row.pagesMinutes ?? minutes;
      add({
        type,
        pageCount: null,
        audioDurationSeconds: total === null ? null : total * 60,
        isbn,
      });
    } else {
      add({
        type,
        pageCount: row.pagesMinutes ?? maxLength(row.readings, 'page') ?? goodreadsPages,
        audioDurationSeconds: null,
        isbn,
      });
      // A reading measured in minutes was listened to: add an audiobook format.
      if (minutes !== null) {
        add({ type: 'audiobook', pageCount: null, audioDurationSeconds: minutes * 60, isbn: null });
      }
    }
  }
  const order: FormatType[] = ['physical', 'kindle', 'audiobook'];
  return order.flatMap((type) => {
    const format = formats.get(type);
    return format ? [format] : [];
  });
}

// --- Reads ---------------------------------------------------------------------

type EntryKind = 'day' | 'progress';

interface DatedEntry {
  kind: EntryKind;
  edition: Edition;
  reading: BookpineReading;
  /** First day: started (or finished when there is no start). */
  day: DateKey;
  /** Last known day of the entry. */
  lastDay: DateKey;
  /** Day the entry's span ends; null while an in-progress entry is open. */
  end: DateKey | null;
  finished: boolean;
  format: FormatType;
}

interface Group {
  entries: DatedEntry[];
  firstDay: DateKey;
  lastDay: DateKey;
  end: DateKey | null;
  /** False once the group holds a finished progress entry (a complete read-through). */
  chainable: boolean;
}

function sessionFormat(edition: Edition, reading: BookpineReading): FormatType {
  return reading.lengthType === 'minute' ? 'audiobook' : edition.type;
}

/**
 * Classifies a reading (SPEC §8): a dated 100/100 % finished entry is a
 * reading *day*; any other dated entry is a *progress* entry; undated
 * entries are returned as null (handled as historical reads or status hints).
 */
function datedEntry(edition: Edition, reading: BookpineReading): DatedEntry | null {
  const day = reading.startedAt ?? reading.finishedAt;
  if (day === null) return null;
  const finished = reading.status === 'finished';
  const isDay =
    finished &&
    reading.lengthType === 'percent' &&
    reading.length === 100 &&
    (reading.progress ?? 0) >= 100;
  if (isDay) {
    return {
      kind: 'day',
      edition,
      reading,
      day,
      lastDay: day,
      end: day,
      finished: true,
      format: sessionFormat(edition, reading),
    };
  }
  const lastDay = reading.finishedAt ? maxDay(day, reading.finishedAt) : day;
  return {
    kind: 'progress',
    edition,
    reading,
    day,
    lastDay,
    end: reading.finishedAt || finished ? lastDay : null,
    finished,
    format: sessionFormat(edition, reading),
  };
}

/**
 * An entry belongs to the current read when it starts within the read's
 * span (an open in-progress entry spans everything after it), or — while
 * the read has no finished read-through — no more than READ_GAP_DAYS after
 * its last day.
 */
function joins(group: Group, entry: DatedEntry): boolean {
  if (group.end === null || entry.day <= group.end) return true;
  return group.chainable && diffDays(group.lastDay, entry.day) <= READ_GAP_DAYS;
}

function groupEntries(entries: DatedEntry[]): Group[] {
  const sorted = [...entries].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      (a.kind === b.kind ? 0 : a.kind === 'day' ? -1 : 1) ||
      a.edition.row.slug.localeCompare(b.edition.row.slug) ||
      a.reading.index - b.reading.index,
  );
  const groups: Group[] = [];
  for (const entry of sorted) {
    const group = groups.at(-1);
    if (group && joins(group, entry)) {
      group.entries.push(entry);
      group.lastDay = maxDay(group.lastDay, entry.lastDay);
      group.end = group.end === null || entry.end === null ? null : maxDay(group.end, entry.end);
      group.chainable &&= !(entry.kind === 'progress' && entry.finished);
      continue;
    }
    groups.push({
      entries: [entry],
      firstDay: entry.day,
      lastDay: entry.lastDay,
      end: entry.end,
      chainable: !(entry.kind === 'progress' && entry.finished),
    });
  }
  return groups;
}

function progressSession(
  entry: DatedEntry,
  previousEnd: Map<string, number>,
  timeZone: string,
  suffix: string,
): PlannedSession | null {
  const { reading } = entry;
  const progress = reading.progress ?? 0;
  if (progress <= 0) return null;
  let unit: ProgressUnit;
  let endValue: number;
  if (reading.lengthType === 'minute') {
    unit = 'audio_seconds';
    endValue = Math.round(progress * 60);
  } else if (reading.lengthType === 'page' && entry.format !== 'audiobook') {
    unit = 'pages';
    endValue = progress;
  } else if (reading.lengthType === 'percent') {
    unit = 'percent';
    endValue = Math.min(100, progress);
  } else if (reading.length) {
    unit = 'percent';
    endValue = Math.min(100, Math.round((progress / reading.length) * 10_000) / 100);
  } else {
    return null;
  }
  const key = `${entry.format}:${unit}`;
  const startValue = Math.min(previousEnd.get(key) ?? 0, endValue);
  previousEnd.set(key, endValue);
  // Finished entries record their progress on the finish day, others on their start day.
  const day = entry.finished ? entry.lastDay : entry.day;
  const at = noonOf(day, timeZone);
  return {
    suffix,
    format: entry.format,
    day,
    startedAt: at,
    endedAt: at,
    progressUnit: unit,
    startValue,
    endValue,
  };
}

interface DraftRead {
  firstDay: DateKey;
  lastDay: DateKey;
  outcome: ReadOutcome | 'auto';
  hasFinished: boolean;
  sessions: PlannedSession[];
}

function planReads(
  editions: Edition[],
  status: BookStatus,
  formats: PlannedFormat[],
  timeZone: string,
  anchor: string,
  warnings: ImportWarning[],
): PlannedRead[] {
  const dated: DatedEntry[] = [];
  const historical: { edition: Edition; reading: BookpineReading }[] = [];
  for (const edition of editions) {
    for (const reading of edition.row.readings) {
      const entry = datedEntry(edition, reading);
      if (entry) {
        dated.push(entry);
      } else if (reading.status === 'finished') {
        historical.push({ edition, reading });
      } else if ((reading.progress ?? 0) > 0) {
        warnings.push({
          slug: edition.row.slug,
          message: `Reading ${reading.index + 1} has progress but no dates; it only informs the status`,
        });
      }
    }
  }

  const usedDays = new Set<DateKey>();
  const progressKeys = new Map<string, number>();
  const drafts: DraftRead[] = groupEntries(dated).map((group) => {
    const sessions: PlannedSession[] = [];
    const previousEnd = new Map<string, number>();
    for (const entry of group.entries) {
      if (entry.kind === 'day') {
        // At most one imported day session per book and day (duplicate editions).
        if (usedDays.has(entry.day)) continue;
        usedDays.add(entry.day);
        const at = noonOf(entry.day, timeZone);
        sessions.push({
          suffix: `day:${entry.day}`,
          format: entry.format,
          day: entry.day,
          startedAt: at,
          endedAt: at,
          progressUnit: 'percent',
          startValue: null,
          endValue: null,
        });
        continue;
      }
      const base = `progress:${entry.edition.row.slug}:${entry.reading.startedAt ?? `-:${entry.reading.finishedAt ?? ''}`}`;
      const seen = (progressKeys.get(base) ?? 0) + 1;
      progressKeys.set(base, seen);
      const session = progressSession(
        entry,
        previousEnd,
        timeZone,
        seen === 1 ? base : `${base}#${seen}`,
      );
      if (session) sessions.push(session);
    }
    sessions.sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.suffix.localeCompare(b.suffix),
    );
    return {
      firstDay: group.firstDay,
      lastDay: group.lastDay,
      outcome: 'auto',
      hasFinished: group.entries.some((e) => e.finished),
      sessions,
    };
  });

  // Undated finished readings: a historical read on the Goodreads "Date Read"
  // unless that day falls within (±1 day of) a dated read, in which case the
  // reading is the same read-through and only supplies its length.
  const datedRanges = drafts.map((d) => ({ from: d.firstDay, to: d.lastDay }));
  const historicalDays = new Set<DateKey>();
  let undated = 0;
  for (const { edition } of historical) {
    const date = edition.goodreadsDateRead;
    if (date === null) {
      undated += 1;
      continue;
    }
    const overlaps = datedRanges.some(
      (range) => diffDays(range.from, date) >= -1 && diffDays(date, range.to) >= -1,
    );
    if (overlaps || historicalDays.has(date)) continue;
    historicalDays.add(date);
    drafts.push({
      firstDay: date,
      lastDay: date,
      outcome: 'finished',
      hasFinished: true,
      sessions: [],
    });
  }
  if (undated > 0 && drafts.length === 0) {
    warnings.push({
      slug: editions[0]?.row.slug ?? null,
      message:
        'Finished, but Bookpine has no dates for the reading: shelved as Finished without a read',
    });
  }

  drafts.sort((a, b) => a.firstDay.localeCompare(b.firstDay) || a.lastDay.localeCompare(b.lastDay));
  return drafts.map((draft, index): PlannedRead => {
    const last = index === drafts.length - 1;
    let outcome: ReadOutcome;
    if (draft.outcome !== 'auto') {
      outcome = draft.outcome;
    } else if (!last) {
      outcome = draft.hasFinished ? 'finished' : 'dnf';
    } else if (status === 'finished' || status === 'dnf') {
      outcome = status;
    } else if (status === 'reading' || status === 'paused') {
      outcome = 'in_progress';
    } else {
      outcome = draft.hasFinished ? 'finished' : 'in_progress';
      warnings.push({
        slug: anchor,
        message: 'Shelved as Want To Read but has dated readings; kept on To read',
      });
    }
    return {
      suffix: `read:${index + 1}`,
      startedAt: noonOf(draft.firstDay, timeZone),
      finishedAt: outcome === 'in_progress' ? null : noonOf(draft.lastDay, timeZone),
      outcome,
      sessions: draft.sessions,
    };
  });
}

// --- Books ---------------------------------------------------------------------

function uniqueTags(names: string[], slug: string, warnings: ImportWarning[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    let name = raw.trim();
    if (!name) continue;
    if (name.length > MAX_TAG_LENGTH) {
      warnings.push({
        slug,
        message: `Shortened the tag "${name}" to ${MAX_TAG_LENGTH} characters`,
      });
      name = name.slice(0, MAX_TAG_LENGTH).trim();
    }
    const key = name.normalize('NFKC').toLocaleLowerCase('en-GB');
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

function noteText(raw: string, slug: string, warnings: ImportWarning[]): string {
  if (raw.length <= MAX_NOTE_LENGTH) return raw;
  warnings.push({ slug, message: `Shortened a note to ${MAX_NOTE_LENGTH} characters` });
  return raw.slice(0, MAX_NOTE_LENGTH);
}

function planBook(editions: Edition[], timeZone: string, warnings: ImportWarning[]): PlannedBook {
  const status =
    STATUS_PRECEDENCE.find((candidate) => editions.some((e) => e.status === candidate)) ??
    'to_read';
  // The status came from one of the editions, so this always finds one.
  const primary = editions.find((e) => e.status === status);
  if (!primary) throw new Error('A book group has no editions');
  const slugs = editions.map((e) => e.row.slug);
  const anchor = [...slugs].sort()[0] as string;
  const { title, subtitle } = splitTitle(primary.row.title);
  const firstWith = <T>(pick: (row: BookpineRow) => T | null): T | null =>
    pick(primary.row) ?? editions.map((e) => pick(e.row)).find((value) => value !== null) ?? null;
  const ratings = editions.map((e) => e.row.rating).filter((r): r is number => r !== null);
  const tags = uniqueTags(
    [
      ...editions.flatMap((e) => e.extraTags),
      ...(editions.some((e) => e.row.owned) ? ['owned'] : []),
      ...(editions.some((e) => e.row.private) ? ['private'] : []),
    ],
    anchor,
    warnings,
  );
  const notes: PlannedNote[] = [];
  for (const { row } of editions) {
    if (row.review) {
      notes.push({ suffix: `review:${row.slug}`, text: noteText(row.review, row.slug, warnings) });
    }
    row.notes
      .filter((note) => note.goodreads === null)
      .forEach((note, index) => {
        notes.push({
          suffix: `note:${row.slug}:${index + 1}`,
          text: noteText(note.content, row.slug, warnings),
        });
      });
  }
  const formats = planFormats(editions);
  return {
    slugs,
    anchor,
    title,
    subtitle,
    authors: primary.row.authors,
    publishedDate: primary.row.publicationDate,
    language: primary.row.language,
    isbn13: firstWith((row) => row.isbn13),
    isbn10: firstWith((row) => row.isbn10),
    status,
    rating: ratings.length > 0 ? Math.max(...ratings) : null,
    tags,
    formats,
    reads: planReads(editions, status, formats, timeZone, anchor, warnings),
    notes,
    isbns: [
      ...new Set(editions.flatMap((e) => [e.row.isbn13, e.row.isbn10]).filter((v) => v !== null)),
    ] as string[],
  };
}

/** Plans the import of a parsed Bookpine export, bucketing days in `timeZone`. */
export function planImport(parsed: ParsedExport, timeZone: string): ImportPlan {
  const warnings = [...parsed.warnings];
  const editions = parsed.rows.map((row) => toEdition(row, warnings));
  const groups = groupEditions(editions, warnings);
  const books = groups.map((group) => planBook(group, timeZone, warnings));
  const merges = books
    .filter((book) => book.slugs.length > 1)
    .map((book) => ({ title: book.title, slugs: book.slugs }));
  return { rows: parsed.rows.length, books, merges, warnings };
}
