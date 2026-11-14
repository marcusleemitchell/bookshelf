import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  eachDay,
  isDateKey,
  isValidTimeZone,
  localDateKey,
  localParts,
  monthKey,
  monthRange,
  startOfLocalDay,
  zonedTimeToUtc,
} from './time.ts';

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('localParts / localDateKey', () => {
  it('returns wall-clock parts in the zone', () => {
    expect(localParts('2026-07-01T23:15:42.000Z', 'Europe/London')).toEqual({
      year: 2026,
      month: 7,
      day: 2,
      hour: 0,
      minute: 15,
      second: 42,
    });
  });

  it('buckets an instant into the local day', () => {
    // 23:30 UTC in winter is still the same day in London (GMT).
    expect(localDateKey('2026-01-10T23:30:00.000Z', 'Europe/London')).toBe('2026-01-10');
    // In summer (BST, UTC+1) it is already the next day.
    expect(localDateKey('2026-07-10T23:30:00.000Z', 'Europe/London')).toBe('2026-07-11');
    expect(localDateKey(new Date('2026-07-10T23:30:00.000Z'), 'America/New_York')).toBe(
      '2026-07-10',
    );
  });

  it('throws on an invalid instant', () => {
    expect(() => localDateKey('not a date', 'UTC')).toThrow(RangeError);
  });
});

describe('date key arithmetic', () => {
  it('validates date keys', () => {
    expect(isDateKey('2026-02-28')).toBe(true);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2026-02-29')).toBe(false);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('2026-1-01')).toBe(false);
    expect(isDateKey('yesterday')).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('diffs days', () => {
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
    expect(diffDays('2026-01-05', '2026-01-01')).toBe(-4);
  });

  it('lists each day inclusively', () => {
    expect(eachDay('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(eachDay('2026-03-02', '2026-03-01')).toEqual([]);
  });

  it('throws on invalid date keys', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
  });

  it('derives month keys and ranges', () => {
    expect(monthKey('2026-11-14')).toBe('2026-11');
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(() => monthRange('2026-13')).toThrow(RangeError);
  });
});

describe('zonedTimeToUtc / startOfLocalDay', () => {
  it('converts local midnight to UTC', () => {
    expect(startOfLocalDay('2026-01-10', 'Europe/London').toISOString()).toBe(
      '2026-01-10T00:00:00.000Z',
    );
    expect(startOfLocalDay('2026-07-10', 'Europe/London').toISOString()).toBe(
      '2026-07-09T23:00:00.000Z',
    );
    expect(startOfLocalDay('2026-07-10', 'Asia/Kolkata').toISOString()).toBe(
      '2026-07-09T18:30:00.000Z',
    );
    expect(startOfLocalDay('2026-07-10', 'America/Los_Angeles').toISOString()).toBe(
      '2026-07-10T07:00:00.000Z',
    );
  });

  it('handles the days DST changes', () => {
    // London springs forward at 01:00 UTC on 29/03/2026; midnight is still GMT.
    expect(startOfLocalDay('2026-03-29', 'Europe/London').toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    );
    expect(startOfLocalDay('2026-03-30', 'Europe/London').toISOString()).toBe(
      '2026-03-29T23:00:00.000Z',
    );
    expect(startOfLocalDay('2026-10-26', 'Europe/London').toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
  });

  it('shifts a time inside a DST gap forward', () => {
    // 02:30 does not exist in New York on 08/03/2026; it becomes 03:30 EDT.
    expect(zonedTimeToUtc('2026-03-08', 2, 30, 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('converts a normal wall time', () => {
    expect(zonedTimeToUtc('2026-11-14', 3, 0, 'Europe/London').toISOString()).toBe(
      '2026-11-14T03:00:00.000Z',
    );
  });
});
