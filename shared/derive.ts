/**
 * Pure derivations from SPEC §4: percent, current progress, pages read,
 * reading speed, estimated finish and streaks; plus merging lookup candidates.
 */
import type { BookCandidate, FormatType, ProgressUnit } from './schemas.ts';
import { addDays, diffDays, localDateKey, type DateKey } from './time.ts';

/** The length fields of a book format that percent derivation needs. */
export interface FormatLength {
  format: FormatType;
  pageCount: number | null;
  audioDurationSeconds: number | null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Checks that a progress unit can be used with a format: `pages` needs a
 * physical/kindle format, `audio_seconds` an audiobook; `percent` fits all.
 * Returns an error message, or null when compatible.
 */
export function progressUnitError(unit: ProgressUnit, format: FormatType): string | null {
  if (unit === 'pages' && format === 'audiobook') {
    return 'Audiobooks track progress in audio_seconds or percent, not pages';
  }
  if (unit === 'audio_seconds' && format !== 'audiobook') {
    return 'audio_seconds progress is only valid for audiobook formats';
  }
  return null;
}

/**
 * Checks that a format's length fields match its type: page counts belong to
 * physical/kindle formats, audio durations to audiobooks. Returns an error
 * message, or null when consistent.
 */
export function formatLengthError(length: FormatLength): string | null {
  if (length.format === 'audiobook' && length.pageCount !== null) {
    return 'Audiobook formats cannot have a page count';
  }
  if (length.format !== 'audiobook' && length.audioDurationSeconds !== null) {
    return 'Only audiobook formats can have an audio duration';
  }
  return null;
}

/**
 * Percent (0–100, 2 dp) for a progress value in `unit` against `format`'s length.
 * Null when the value is null or the needed length is unknown.
 */
export function computePercent(
  unit: ProgressUnit,
  value: number | null,
  format: FormatLength,
): number | null {
  if (value === null) return null;
  switch (unit) {
    case 'percent':
      return round2(clampPercent(value));
    case 'pages':
      return format.pageCount ? round2(clampPercent((value / format.pageCount) * 100)) : null;
    case 'audio_seconds':
      return format.audioDurationSeconds
        ? round2(clampPercent((value / format.audioDurationSeconds) * 100))
        : null;
  }
}

/**
 * Inverse of {@link computePercent}: the value in `unit` for `percent`
 * (pages and seconds rounded to whole numbers). Null when unknown.
 */
export function percentToUnit(
  unit: ProgressUnit,
  percent: number | null,
  format: FormatLength,
): number | null {
  if (percent === null) return null;
  switch (unit) {
    case 'percent':
      return round2(percent);
    case 'pages':
      return format.pageCount ? Math.round((percent / 100) * format.pageCount) : null;
    case 'audio_seconds':
      return format.audioDurationSeconds
        ? Math.round((percent / 100) * format.audioDurationSeconds)
        : null;
  }
}

/** Minimal session shape used by the progress derivations. */
export interface ProgressSession {
  startedAt: string;
  endedAt: string;
  endPercent: number | null;
}

/**
 * Current progress of a read: the end percent of its latest session (by
 * start time, then end time) that has a known percent. Null when none.
 */
export function currentProgress(sessions: readonly ProgressSession[]): number | null {
  let latest: ProgressSession | null = null;
  for (const session of sessions) {
    if (session.endPercent === null) continue;
    if (
      latest === null ||
      session.startedAt > latest.startedAt ||
      (session.startedAt === latest.startedAt && session.endedAt > latest.endedAt)
    ) {
      latest = session;
    }
  }
  return latest?.endPercent ?? null;
}

/** Session fields needed to work out pages read and speed. */
export interface MeasuredSession {
  startedAt: string;
  durationSeconds: number;
  progressUnit: ProgressUnit;
  startValue: number | null;
  endValue: number | null;
  startPercent: number | null;
  endPercent: number | null;
}

/** Progress made in a session in percent points (never negative); null when unknown. */
export function sessionPercentDelta(session: MeasuredSession): number | null {
  if (session.startPercent === null || session.endPercent === null) return null;
  return Math.max(0, session.endPercent - session.startPercent);
}

/**
 * Pages read in a session (never negative). Page-unit sessions use their raw
 * values; other units convert the percent delta via the format's page count.
 * Zero when it cannot be determined (e.g. audiobooks).
 */
export function sessionPages(session: MeasuredSession, format: FormatLength): number {
  if (
    session.progressUnit === 'pages' &&
    session.startValue !== null &&
    session.endValue !== null
  ) {
    return Math.max(0, session.endValue - session.startValue);
  }
  const delta = sessionPercentDelta(session);
  if (delta === null || !format.pageCount || format.format === 'audiobook') return 0;
  return Math.round((delta / 100) * format.pageCount);
}

/** Audio seconds progressed in an audiobook session (never negative); null when unknown. */
export function sessionAudioSeconds(session: MeasuredSession, format: FormatLength): number | null {
  if (format.format !== 'audiobook') return null;
  if (
    session.progressUnit === 'audio_seconds' &&
    session.startValue !== null &&
    session.endValue !== null
  ) {
    return Math.max(0, session.endValue - session.startValue);
  }
  const delta = sessionPercentDelta(session);
  if (delta === null || !format.audioDurationSeconds) return null;
  return (delta / 100) * format.audioDurationSeconds;
}

export interface ReadingSpeed {
  format: FormatType;
  sessions: number;
  seconds: number;
  /** Pages per hour (physical/kindle); null when no page data. */
  pagesPerHour: number | null;
  /** Percent points per hour; null when no percent data. */
  percentPerHour: number | null;
  /** Audio seconds progressed per second listened (audiobook); e.g. 1.5 = 1.5× speed. */
  listeningRatio: number | null;
}

export interface SpeedInput {
  session: MeasuredSession;
  format: FormatLength;
}

/**
 * Reading speed per format type over sessions started within the last
 * `windowDays` days up to `now` (SPEC §4: 30 days). Formats without sessions
 * in the window are omitted. Zero-duration sessions are ignored.
 */
export function readingSpeeds(
  inputs: readonly SpeedInput[],
  now: Date,
  windowDays = 30,
): ReadingSpeed[] {
  const cutoff = now.getTime() - windowDays * 86_400_000;
  interface Accumulator {
    sessions: number;
    seconds: number;
    pages: number;
    pageSeconds: number;
    percent: number;
    percentSeconds: number;
    audio: number;
    audioSeconds: number;
  }
  const byFormat = new Map<FormatType, Accumulator>();
  for (const { session, format } of inputs) {
    const started = new Date(session.startedAt).getTime();
    if (started < cutoff || started > now.getTime() || session.durationSeconds <= 0) continue;
    let acc = byFormat.get(format.format);
    if (!acc) {
      acc = {
        sessions: 0,
        seconds: 0,
        pages: 0,
        pageSeconds: 0,
        percent: 0,
        percentSeconds: 0,
        audio: 0,
        audioSeconds: 0,
      };
      byFormat.set(format.format, acc);
    }
    acc.sessions += 1;
    acc.seconds += session.durationSeconds;
    if (format.format !== 'audiobook') {
      const hasPages =
        (session.progressUnit === 'pages' &&
          session.startValue !== null &&
          session.endValue !== null) ||
        (sessionPercentDelta(session) !== null && format.pageCount !== null);
      if (hasPages) {
        acc.pages += sessionPages(session, format);
        acc.pageSeconds += session.durationSeconds;
      }
    }
    const percentDelta = sessionPercentDelta(session);
    if (percentDelta !== null) {
      acc.percent += percentDelta;
      acc.percentSeconds += session.durationSeconds;
    }
    const audio = sessionAudioSeconds(session, format);
    if (audio !== null) {
      acc.audio += audio;
      acc.audioSeconds += session.durationSeconds;
    }
  }
  const order: FormatType[] = ['physical', 'kindle', 'audiobook'];
  return order.flatMap((formatType) => {
    const acc = byFormat.get(formatType);
    if (!acc) return [];
    return [
      {
        format: formatType,
        sessions: acc.sessions,
        seconds: acc.seconds,
        pagesPerHour: acc.pageSeconds > 0 ? round2(acc.pages / (acc.pageSeconds / 3600)) : null,
        percentPerHour:
          acc.percentSeconds > 0 ? round2(acc.percent / (acc.percentSeconds / 3600)) : null,
        listeningRatio: acc.audioSeconds > 0 ? round2(acc.audio / acc.audioSeconds) : null,
      },
    ];
  });
}

export interface FinishEstimate {
  /** Average percent points per day across the window. */
  percentPerDay: number;
  /** Whole days until finishing at that rate (0 = today). */
  daysRemaining: number;
  /** Estimated local finish date. */
  date: DateKey;
}

/**
 * Estimated finish (SPEC §4): remaining percent ÷ recent percent-per-day,
 * where the rate is the progress made by sessions started in the last
 * `windowDays` local days (including today) divided by `windowDays`.
 * Null when progress is unknown, already complete, or there is no recent progress.
 */
export function estimateFinish(options: {
  currentPercent: number | null;
  sessions: readonly MeasuredSession[];
  now: Date;
  timeZone: string;
  windowDays?: number;
}): FinishEstimate | null {
  const { currentPercent, sessions, now, timeZone, windowDays = 14 } = options;
  if (currentPercent === null || currentPercent >= 100) return null;
  const today = localDateKey(now, timeZone);
  const windowStart = addDays(today, -(windowDays - 1));
  let progressed = 0;
  for (const session of sessions) {
    const day = localDateKey(session.startedAt, timeZone);
    if (day < windowStart || day > today) continue;
    progressed += sessionPercentDelta(session) ?? 0;
  }
  if (progressed <= 0) return null;
  const percentPerDay = progressed / windowDays;
  const daysRemaining = Math.ceil((100 - currentPercent) / percentPerDay);
  return {
    percentPerDay: round2(percentPerDay),
    daysRemaining,
    date: addDays(today, daysRemaining),
  };
}

export interface Streaks {
  /** Consecutive days ending today (or yesterday, if today has no session yet). */
  current: number;
  longest: number;
  lastReadDate: DateKey | null;
}

/**
 * Streaks over local date keys that had at least one session (any order,
 * duplicates allowed). `today` is the current local date.
 */
export function computeStreaks(days: readonly DateKey[], today: DateKey): Streaks {
  const unique = [...new Set(days)].filter((day) => day <= today).sort();
  if (unique.length === 0) return { current: 0, longest: 0, lastReadDate: null };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < unique.length; i += 1) {
    run = diffDays(unique[i - 1] as DateKey, unique[i] as DateKey) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const lastReadDate = unique[unique.length - 1] as DateKey;
  const gap = diffDays(lastReadDate, today);
  return { current: gap <= 1 ? run : 0, longest, lastReadDate };
}

/** Timer fields needed to work out elapsed time (SPEC §4 ActiveTimer). */
export interface TimerTimes {
  resumedAt: string;
  /** Null while running. */
  pausedAt: string | null;
  accumulatedSeconds: number;
}

/**
 * Seconds elapsed on a timer at `now`: earlier segments plus, while running,
 * the whole seconds since `resumedAt` (never negative). Derived from stored
 * timestamps only, so it stays correct across app restarts.
 */
export function timerElapsedSeconds(timer: TimerTimes, now: Date): number {
  const running =
    timer.pausedAt === null ? Math.max(0, now.getTime() - Date.parse(timer.resumedAt)) : 0;
  return timer.accumulatedSeconds + Math.floor(running / 1000);
}

/** Fills gaps in `base` from `extra` (synopsis, cover, page count and other empty fields). */
export function mergeCandidates(base: BookCandidate, extra: BookCandidate): BookCandidate {
  return {
    ...base,
    subtitle: base.subtitle ?? extra.subtitle,
    authors: base.authors.length > 0 ? base.authors : extra.authors,
    publisher: base.publisher ?? extra.publisher,
    publishedDate: base.publishedDate ?? extra.publishedDate,
    language: base.language ?? extra.language,
    synopsis: base.synopsis ?? extra.synopsis,
    coverUrl: base.coverUrl ?? extra.coverUrl,
    isbn10: base.isbn10 ?? extra.isbn10,
    isbn13: base.isbn13 ?? extra.isbn13,
    genres: base.genres.length > 0 ? base.genres : extra.genres,
    pageCount: base.pageCount ?? extra.pageCount,
  };
}
