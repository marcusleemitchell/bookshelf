/**
 * Date helpers for the UI. Dates are shown `DD/MM/YYYY` (shared
 * `formatDate`); these add local-day maths, `datetime-local` conversion and
 * readable labels, all in an explicit IANA timezone.
 */
import {
  addDays,
  localDateKey,
  localParts,
  monthKey,
  zonedTimeToUtc,
  type DateKey,
} from '../../../shared/index.ts';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Monday-first weekday names (British calendars start on Monday). */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function todayKey(now: Date, timeZone: string): DateKey {
  return localDateKey(now, timeZone);
}

export function currentMonth(now: Date, timeZone: string): string {
  return monthKey(localDateKey(now, timeZone));
}

/** `YYYY-MM` shifted by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${pad((index % 12) + 1)}`;
}

/** "November 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? ''} ${y}`;
}

/** Short month name, e.g. "Nov". */
export function shortMonth(month: string): string {
  const m = Number(month.split('-')[1]);
  return (MONTHS[m - 1] ?? '').slice(0, 3);
}

/** Monday-based weekday index (0 = Monday) of a date key. */
export function weekdayIndex(key: DateKey): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const sundayBased = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (sundayBased + 6) % 7;
}

/** "Saturday 14 November 2026" (for headings and accessible labels). */
export function longDayLabel(key: DateKey): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[weekdayIndex(key)] ?? ''} ${d} ${MONTHS[m - 1] ?? ''} ${y}`;
}

/** 24-hour local time `HH:mm` of an instant. */
export function formatTime(instant: string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** An instant as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`) in `timeZone`. */
export function toLocalInput(instant: string | Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Parses a `datetime-local` value in `timeZone` to an ISO instant; null when invalid. */
export function fromLocalInput(value: string, timeZone: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, day = '', hour = '', minute = ''] = match;
  try {
    return zonedTimeToUtc(day, Number(hour), Number(minute), timeZone).toISOString();
  } catch {
    return null;
  }
}

/** Inclusive `{ from, to }` covering the last `days` local days ending `today`. */
export function lastDays(today: DateKey, days: number): { from: DateKey; to: DateKey } {
  return { from: addDays(today, -(days - 1)), to: today };
}
