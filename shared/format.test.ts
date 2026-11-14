import { describe, expect, it } from 'vitest';
import { formatAudioPosition, formatDate, formatDuration, parseAudioPosition } from './format.ts';

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [29, '0m'],
    [30, '1m'],
    [45 * 60, '45m'],
    [59 * 60 + 29, '59m'],
    [59 * 60 + 30, '1h 00m'],
    [65 * 60, '1h 05m'],
    [10 * 3600 + 59 * 60, '10h 59m'],
    [-100, '0m'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('formatAudioPosition', () => {
  it.each([
    [0, '0:00:00'],
    [245, '0:04:05'],
    [3730, '1:02:10'],
    [36000, '10:00:00'],
    [59.9, '0:00:59'],
    [-5, '0:00:00'],
  ])('formats %d as %s', (seconds, expected) => {
    expect(formatAudioPosition(seconds)).toBe(expected);
  });
});

describe('parseAudioPosition', () => {
  it.each([
    ['1:02:10', 3730],
    ['0:04:05', 245],
    ['62:10', 3730],
    ['4:05', 245],
    ['3730', 3730],
    [' 1:00:00 ', 3600],
  ])('parses %s', (input, expected) => {
    expect(parseAudioPosition(input)).toBe(expected);
  });

  it.each(['', 'abc', '1:2:3', '1:60:00', '0:00:60', '1:02:10:00', '-5'])('rejects %j', (input) => {
    expect(parseAudioPosition(input)).toBeNull();
  });
});

describe('formatDate', () => {
  it('formats a date key as DD/MM/YYYY', () => {
    expect(formatDate('2026-11-04', 'Europe/London')).toBe('04/11/2026');
  });

  it('formats an instant in the given timezone', () => {
    expect(formatDate('2026-11-14T23:30:00.000Z', 'Europe/London')).toBe('14/11/2026');
    expect(formatDate('2026-11-14T23:30:00.000Z', 'Asia/Tokyo')).toBe('15/11/2026');
    expect(formatDate('2026-11-14T03:30:00.000Z', 'America/Los_Angeles')).toBe('13/11/2026');
  });
});
