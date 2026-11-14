/**
 * User-facing labels and progress-unit helpers (British English, SPEC §3:
 * pages, percent and audio positions as `h:mm:ss`).
 */
import {
  formatAudioPosition,
  parseAudioPosition,
  type BookFormat,
  type BookStatus,
  type FormatType,
  type GoalKind,
  type ProgressUnit,
  type ReadOutcome,
} from '../../../shared/index.ts';

export const STATUS_LABELS: Record<BookStatus, string> = {
  reading: 'Reading',
  paused: 'Paused',
  to_read: 'To read',
  finished: 'Finished',
  dnf: 'Did not finish',
};

export const STATUS_ORDER: readonly BookStatus[] = [
  'reading',
  'paused',
  'to_read',
  'finished',
  'dnf',
];

export const FORMAT_LABELS: Record<FormatType, string> = {
  physical: 'Physical',
  kindle: 'Kindle',
  audiobook: 'Audiobook',
};

export const OUTCOME_LABELS: Record<ReadOutcome, string> = {
  in_progress: 'In progress',
  finished: 'Finished',
  dnf: 'Did not finish',
};

export const GOAL_LABELS: Record<GoalKind, string> = {
  books_per_year: 'Books this year',
  pages_per_year: 'Pages this year',
  minutes_per_day: 'Minutes a day',
};

export const UNIT_LABELS: Record<ProgressUnit, string> = {
  pages: 'Page',
  percent: 'Percent',
  audio_seconds: 'Position (h:mm:ss)',
};

/** The format's natural progress unit (SPEC §6: pages / % / h:mm:ss). */
export function naturalUnit(format: FormatType): ProgressUnit {
  return format === 'audiobook' ? 'audio_seconds' : 'pages';
}

/** "Physical · 320 pages", "Audiobook · 11h 05m" or "Kindle · length unknown". */
export function formatSummary(format: BookFormat): string {
  const label = FORMAT_LABELS[format.format];
  if (format.format === 'audiobook') {
    return format.audioDurationSeconds
      ? `${label} · ${formatAudioPosition(format.audioDurationSeconds)}`
      : `${label} · length unknown`;
  }
  return format.pageCount ? `${label} · ${format.pageCount} pages` : `${label} · length unknown`;
}

/** Shows a progress value in its unit: "p. 42", "34%", "1:02:10". */
export function formatProgressValue(unit: ProgressUnit, value: number | null): string {
  if (value === null) return '—';
  switch (unit) {
    case 'pages':
      return `p. ${Math.round(value)}`;
    case 'percent':
      return formatPercent(value);
    case 'audio_seconds':
      return formatAudioPosition(value);
  }
}

/** "34%", "33.5%". */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** A progress value as text for an input (pages/percent as numbers, audio as `h:mm:ss`). */
export function progressInputValue(unit: ProgressUnit, value: number | null): string {
  if (value === null) return '';
  return unit === 'audio_seconds' ? formatAudioPosition(value) : String(value);
}

export type ParsedProgress = { ok: true; value: number | null } | { ok: false; error: string };

/** Parses a progress input; blank means "not recorded". */
export function parseProgressInput(unit: ProgressUnit, text: string): ParsedProgress {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (unit === 'audio_seconds') {
    const seconds = parseAudioPosition(trimmed);
    return seconds === null
      ? { ok: false, error: 'Use h:mm:ss, for example 1:02:10' }
      : { ok: true, value: seconds };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'Enter a number of zero or more' };
  }
  if (unit === 'percent' && value > 100) {
    return { ok: false, error: 'Percent must be between 0 and 100' };
  }
  return { ok: true, value };
}

/** "★★★½☆" for a 0.5–5 rating. */
export function ratingStars(rating: number): string {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - (half ? 1 : 0));
}

/** "3½ stars", "1 star". */
export function ratingLabel(rating: number): string {
  const whole = Math.floor(rating);
  const text = rating - whole >= 0.5 ? `${whole === 0 ? '' : whole}½` : String(whole);
  return `${text} ${rating === 1 ? 'star' : 'stars'}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
