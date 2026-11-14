/**
 * Calendar-day helpers. A "date key" is a local calendar date formatted
 * `YYYY-MM-DD`. Instants are ISO 8601 UTC strings or `Date` objects.
 *
 * Sessions are bucketed into the local day (in the configured IANA timezone)
 * on which they *started* (SPEC §3).
 */

export type DateKey = string;

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `timeZone` is an IANA zone known to the runtime. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function toDate(instant: string | Date): Date {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid instant: ${String(instant)}`);
  }
  return date;
}

/** Wall-clock components of `instant` in `timeZone`. */
export function localParts(instant: string | Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(toDate(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return Number(part?.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** The local calendar date of `instant` in `timeZone`. */
export function localDateKey(instant: string | Date, timeZone: string): DateKey {
  const p = localParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isDateKey(value: string): boolean {
  const match = DATE_KEY_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function dateKeyToUtcMs(key: DateKey): number {
  if (!isDateKey(key)) {
    throw new RangeError(`Invalid date key: ${key}`);
  }
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcMsToDateKey(ms: number): DateKey {
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `key` shifted by `days` calendar days. */
export function addDays(key: DateKey, days: number): DateKey {
  return utcMsToDateKey(dateKeyToUtcMs(key) + days * MS_PER_DAY);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: DateKey, to: DateKey): number {
  return Math.round((dateKeyToUtcMs(to) - dateKeyToUtcMs(from)) / MS_PER_DAY);
}

/** Every date key from `from` to `to` inclusive (empty when `to` < `from`). */
export function eachDay(from: DateKey, to: DateKey): DateKey[] {
  const days: DateKey[] = [];
  const count = diffDays(from, to);
  for (let i = 0; i <= count; i += 1) {
    days.push(addDays(from, i));
  }
  return days;
}

/** Offset (ms) of `timeZone` from UTC at `instantMs`: local wall time minus UTC. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(new Date(instantMs), timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time on `key` in `timeZone`.
 * A time inside a DST gap is shifted forward by the gap length (02:30 on a
 * spring-forward night in New York becomes 03:30 EDT). An ambiguous time on a
 * fall-back night resolves to one of its two valid instants. Bookshelf only
 * converts local midnights, which are unambiguous in practice.
 */
export function zonedTimeToUtc(key: DateKey, hour: number, minute: number, timeZone: string): Date {
  const wallMs = dateKeyToUtcMs(key) + (hour * 60 + minute) * 60_000;
  const firstGuess = wallMs - zoneOffsetMs(wallMs, timeZone);
  const secondGuess = wallMs - zoneOffsetMs(firstGuess, timeZone);
  return new Date(Math.max(firstGuess, secondGuess));
}

/** The UTC instant at which local day `key` starts in `timeZone`. */
export function startOfLocalDay(key: DateKey, timeZone: string): Date {
  return zonedTimeToUtc(key, 0, 0, timeZone);
}

/** `YYYY-MM` month key of a date key. */
export function monthKey(key: DateKey): string {
  return key.slice(0, 7);
}

/** First and last date keys of a `YYYY-MM` month. */
export function monthRange(month: string): { from: DateKey; to: DateKey } {
  const from = `${month}-01`;
  if (!isDateKey(from)) {
    throw new RangeError(`Invalid month: ${month}`);
  }
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${month}-${pad(last)}` };
}
