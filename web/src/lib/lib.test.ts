import { describe, expect, it, vi } from 'vitest';
import { makeFormat, uuid } from '../test/fixtures.ts';
import {
  addMonths,
  currentMonth,
  formatTime,
  fromLocalInput,
  lastDays,
  longDayLabel,
  monthLabel,
  shortMonth,
  toLocalInput,
  todayKey,
  weekdayIndex,
} from './dates.ts';
import { readFileText, saveTextFile } from './files.ts';
import { newId, testing } from './ids.ts';
import {
  formatPercent,
  formatProgressValue,
  formatSummary,
  naturalUnit,
  parseProgressInput,
  plural,
  progressInputValue,
  ratingLabel,
  ratingStars,
  dayTimeLabel,
  sessionDurationLabel,
  unknownTimeLabel,
} from './labels.ts';
import { splitList } from './text.ts';

const TZ = 'Europe/London';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('dates', () => {
  it('works out local days and months', () => {
    const now = new Date('2026-11-14T23:30:00.000Z');
    expect(todayKey(now, TZ)).toBe('2026-11-14');
    expect(todayKey(now, 'Asia/Tokyo')).toBe('2026-11-15');
    expect(currentMonth(now, TZ)).toBe('2026-11');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2026-11')).toBe('November 2026');
    expect(shortMonth('2026-02')).toBe('Feb');
    expect(lastDays('2026-11-14', 7)).toEqual({ from: '2026-11-08', to: '2026-11-14' });
  });

  it('labels days Monday-first', () => {
    expect(weekdayIndex('2026-11-16')).toBe(0);
    expect(weekdayIndex('2026-11-15')).toBe(6);
    expect(longDayLabel('2026-11-14')).toBe('Saturday 14 November 2026');
  });

  it('converts datetime-local values in the given timezone (including BST)', () => {
    expect(toLocalInput('2026-07-01T08:05:00.000Z', TZ)).toBe('2026-07-01T09:05');
    expect(fromLocalInput('2026-07-01T09:05', TZ)).toBe('2026-07-01T08:05:00.000Z');
    expect(fromLocalInput('2026-11-14T10:00', TZ)).toBe('2026-11-14T10:00:00.000Z');
    expect(fromLocalInput('garbage', TZ)).toBeNull();
    expect(fromLocalInput('2026-02-31T10:00', TZ)).toBeNull();
    expect(formatTime('2026-07-01T08:05:00.000Z', TZ)).toBe('09:05');
  });
});

describe('labels', () => {
  it('labels unknown session times and day totals', () => {
    expect(unknownTimeLabel({ source: 'bookpine' })).toBe('Time unknown · imported');
    expect(unknownTimeLabel({ source: 'app' })).toBe('Time unknown');
    expect(sessionDurationLabel({ durationSeconds: 2700, source: 'bookpine' })).toBe('45m');
    expect(sessionDurationLabel({ durationSeconds: null, source: 'bookpine' })).toBe(
      'Time unknown · imported',
    );
    expect(dayTimeLabel(65, 0)).toBe('1h 05m');
    expect(dayTimeLabel(0, 0)).toBe('0m');
    expect(dayTimeLabel(0, 2)).toBe('time unknown');
    expect(dayTimeLabel(25, 1)).toBe('25m + time unknown');
  });

  it('formats progress values per unit', () => {
    expect(formatProgressValue('pages', 42)).toBe('p. 42');
    expect(formatProgressValue('percent', 33.46)).toBe('33.5%');
    expect(formatProgressValue('audio_seconds', 3730)).toBe('1:02:10');
    expect(formatProgressValue('pages', null)).toBe('—');
    expect(formatPercent(40)).toBe('40%');
    expect(progressInputValue('audio_seconds', 65)).toBe('0:01:05');
    expect(progressInputValue('pages', null)).toBe('');
    expect(progressInputValue('pages', 12)).toBe('12');
  });

  it('parses progress inputs', () => {
    expect(parseProgressInput('pages', ' ')).toEqual({ ok: true, value: null });
    expect(parseProgressInput('pages', '120')).toEqual({ ok: true, value: 120 });
    expect(parseProgressInput('pages', '-1')).toMatchObject({ ok: false });
    expect(parseProgressInput('percent', '101')).toMatchObject({ ok: false });
    expect(parseProgressInput('audio_seconds', '1:02:10')).toEqual({ ok: true, value: 3730 });
    expect(parseProgressInput('audio_seconds', '1:99:10')).toMatchObject({ ok: false });
  });

  it('describes formats, ratings and counts', () => {
    expect(naturalUnit('audiobook')).toBe('audio_seconds');
    expect(naturalUnit('kindle')).toBe('pages');
    const bookId = uuid(1);
    expect(formatSummary(makeFormat({ bookId, pageCount: 320 }))).toBe('Physical · 320 pages');
    expect(formatSummary(makeFormat({ bookId, format: 'kindle', pageCount: null }))).toBe(
      'Kindle · length unknown',
    );
    expect(
      formatSummary(
        makeFormat({ bookId, format: 'audiobook', pageCount: null, audioDurationSeconds: 39_900 }),
      ),
    ).toBe('Audiobook · 11:05:00');
    expect(
      formatSummary(
        makeFormat({ bookId, format: 'audiobook', pageCount: null, audioDurationSeconds: null }),
      ),
    ).toBe('Audiobook · length unknown');
    expect(ratingStars(3.5)).toBe('★★★½☆');
    expect(ratingStars(5)).toBe('★★★★★');
    expect(ratingLabel(0.5)).toBe('½ stars');
    expect(ratingLabel(1)).toBe('1 star');
    expect(ratingLabel(4.5)).toBe('4½ stars');
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(3, 'day')).toBe('3 days');
  });
});

describe('ids', () => {
  it('generates UUID v4s with or without crypto.randomUUID', () => {
    expect(newId()).toMatch(UUID_RE);
    expect(testing.fromRandomBytes()).toMatch(UUID_RE);
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(newId()).toMatch(UUID_RE);
    } finally {
      if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(crypto, 'randomUUID');
    }
  });
});

describe('files', () => {
  it('downloads when files cannot be shared', async () => {
    const createObjectURL = vi.fn(() => 'blob:backup');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await expect(saveTextFile('backup.json', '{}')).resolves.toBe('downloaded');
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');
  });

  it('uses the share sheet when available, reporting cancellation', async () => {
    const share = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DOMException('x', 'AbortError'));
    Object.assign(navigator, { canShare: () => true, share });
    try {
      await expect(saveTextFile('backup.json', '{}')).resolves.toBe('shared');
      await expect(saveTextFile('backup.json', '{}')).resolves.toBe('cancelled');
    } finally {
      Reflect.deleteProperty(navigator, 'canShare');
      Reflect.deleteProperty(navigator, 'share');
    }
  });

  it('reads picked files as text', async () => {
    await expect(readFileText(new Blob(['{"a":1}']))).resolves.toBe('{"a":1}');
  });
});

describe('text', () => {
  it('splits comma-separated fields into trimmed, non-empty parts', () => {
    expect(splitList(' Ann Leckie,  Ursula K. Le Guin ,, ')).toEqual([
      'Ann Leckie',
      'Ursula K. Le Guin',
    ]);
    expect(splitList('')).toEqual([]);
  });
});
