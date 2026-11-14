/**
 * Display formatting (SPEC §3): British English, dates `DD/MM/YYYY`,
 * durations `1h 05m`, audio positions `h:mm:ss`.
 */
import { isDateKey, localDateKey } from './time.ts';

/**
 * Formats a duration in seconds, rounded to the nearest minute:
 * `1h 05m` for an hour or more, `45m` below an hour, `0m` for under 30 seconds.
 */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.round(Math.max(0, totalSeconds) / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** Formats an audio position in seconds as `h:mm:ss` (e.g. `1:02:10`, `0:04:05`). */
export function formatAudioPosition(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Parses `h:mm:ss`, `m:ss` or a plain number of seconds into seconds.
 * Returns null for anything else (minutes/seconds components must be < 60).
 */
export function parseAudioPosition(input: string): number | null {
  const value = input.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, h = '0', m = '0', s = '0'] = match;
  const minutes = Number(m);
  const seconds = Number(s);
  if (seconds >= 60) return null;
  if (match[1] !== undefined && minutes >= 60) return null;
  return Number(h) * 3600 + minutes * 60 + seconds;
}

/**
 * Formats a date as `DD/MM/YYYY`. Accepts a date key (`YYYY-MM-DD`, shown as
 * is) or an ISO instant (converted to its local date in `timeZone`).
 */
export function formatDate(value: string, timeZone: string): string {
  const key = isDateKey(value) ? value : localDateKey(value, timeZone);
  const [y, m, d] = key.split('-') as [string, string, string];
  return `${d}/${m}/${y}`;
}
