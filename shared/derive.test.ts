import { describe, expect, it } from 'vitest';
import {
  computePercent,
  computeStreaks,
  currentProgress,
  estimateFinish,
  formatLengthError,
  mergeCandidates,
  percentToUnit,
  progressUnitError,
  readingSpeeds,
  sessionAudioSeconds,
  sessionPages,
  timerElapsedSeconds,
  sessionPercentDelta,
  type FormatLength,
  type MeasuredSession,
} from './derive.ts';
import type { BookCandidate } from './schemas.ts';

const paperback: FormatLength = { format: 'physical', pageCount: 400, audioDurationSeconds: null };
const kindle: FormatLength = { format: 'kindle', pageCount: null, audioDurationSeconds: null };
const audiobook: FormatLength = {
  format: 'audiobook',
  pageCount: null,
  audioDurationSeconds: 36_000,
};

function session(overrides: Partial<MeasuredSession> = {}): MeasuredSession {
  return {
    startedAt: '2026-11-10T09:00:00.000Z',
    durationSeconds: 3600,
    progressUnit: 'pages',
    startValue: 0,
    endValue: 40,
    startPercent: 0,
    endPercent: 10,
    ...overrides,
  };
}

describe('progressUnitError / formatLengthError', () => {
  it('allows compatible units', () => {
    expect(progressUnitError('pages', 'physical')).toBeNull();
    expect(progressUnitError('pages', 'kindle')).toBeNull();
    expect(progressUnitError('percent', 'audiobook')).toBeNull();
    expect(progressUnitError('audio_seconds', 'audiobook')).toBeNull();
  });

  it('rejects incompatible units', () => {
    expect(progressUnitError('pages', 'audiobook')).toMatch(/not pages/);
    expect(progressUnitError('audio_seconds', 'kindle')).toMatch(/only valid for audiobook/);
  });

  it('checks length fields against the format', () => {
    expect(formatLengthError(paperback)).toBeNull();
    expect(formatLengthError(audiobook)).toBeNull();
    expect(formatLengthError({ ...audiobook, pageCount: 10 })).toMatch(/page count/);
    expect(formatLengthError({ ...paperback, audioDurationSeconds: 10 })).toMatch(/audio/);
  });
});

describe('computePercent', () => {
  it('derives percent from pages', () => {
    expect(computePercent('pages', 100, paperback)).toBe(25);
    expect(computePercent('pages', 133, paperback)).toBe(33.25);
    expect(computePercent('pages', 1, { ...paperback, pageCount: 3 })).toBe(33.33);
  });

  it('derives percent from audio seconds', () => {
    expect(computePercent('audio_seconds', 9000, audiobook)).toBe(25);
  });

  it('passes percent through', () => {
    expect(computePercent('percent', 42.5, kindle)).toBe(42.5);
  });

  it('clamps to 0–100', () => {
    expect(computePercent('pages', 500, paperback)).toBe(100);
    expect(computePercent('percent', 140, kindle)).toBe(100);
    expect(computePercent('percent', -3, kindle)).toBe(0);
  });

  it('is null when the value or length is unknown', () => {
    expect(computePercent('pages', null, paperback)).toBeNull();
    expect(computePercent('pages', 10, kindle)).toBeNull();
    expect(computePercent('audio_seconds', 10, { ...audiobook, audioDurationSeconds: null })).toBe(
      null,
    );
  });
});

describe('percentToUnit', () => {
  it('converts percent back into each unit', () => {
    expect(percentToUnit('pages', 25, paperback)).toBe(100);
    expect(percentToUnit('audio_seconds', 50, audiobook)).toBe(18_000);
    expect(percentToUnit('percent', 12.345, kindle)).toBe(12.35);
  });

  it('is null when unknown', () => {
    expect(percentToUnit('pages', null, paperback)).toBeNull();
    expect(percentToUnit('pages', 25, kindle)).toBeNull();
    expect(percentToUnit('audio_seconds', 25, paperback)).toBeNull();
  });
});

describe('currentProgress', () => {
  it('returns the latest known end percent', () => {
    expect(
      currentProgress([
        {
          startedAt: '2026-11-01T10:00:00.000Z',
          endedAt: '2026-11-01T11:00:00.000Z',
          endPercent: 20,
        },
        {
          startedAt: '2026-11-03T10:00:00.000Z',
          endedAt: '2026-11-03T11:00:00.000Z',
          endPercent: 35,
        },
        {
          startedAt: '2026-11-02T10:00:00.000Z',
          endedAt: '2026-11-02T11:00:00.000Z',
          endPercent: 30,
        },
      ]),
    ).toBe(35);
  });

  it('breaks start-time ties by end time and skips unknown percents', () => {
    expect(
      currentProgress([
        {
          startedAt: '2026-11-01T10:00:00.000Z',
          endedAt: '2026-11-01T10:30:00.000Z',
          endPercent: 10,
        },
        {
          startedAt: '2026-11-01T10:00:00.000Z',
          endedAt: '2026-11-01T11:00:00.000Z',
          endPercent: 15,
        },
        {
          startedAt: '2026-11-05T10:00:00.000Z',
          endedAt: '2026-11-05T11:00:00.000Z',
          endPercent: null,
        },
      ]),
    ).toBe(15);
  });

  it('is null without sessions', () => {
    expect(currentProgress([])).toBeNull();
  });
});

describe('session measurements', () => {
  it('computes percent deltas, never negative', () => {
    expect(sessionPercentDelta(session())).toBe(10);
    expect(sessionPercentDelta(session({ startPercent: 30, endPercent: 20 }))).toBe(0);
    expect(sessionPercentDelta(session({ startPercent: null }))).toBeNull();
  });

  it('computes pages from page values', () => {
    expect(sessionPages(session(), paperback)).toBe(40);
    expect(sessionPages(session({ startValue: 50, endValue: 40 }), paperback)).toBe(0);
  });

  it('computes pages from percent via the page count', () => {
    expect(
      sessionPages(
        session({
          progressUnit: 'percent',
          startValue: 10,
          endValue: 20,
          startPercent: 10,
          endPercent: 20,
        }),
        paperback,
      ),
    ).toBe(40);
    expect(sessionPages(session({ progressUnit: 'percent' }), kindle)).toBe(0);
    expect(sessionPages(session({ progressUnit: 'audio_seconds' }), audiobook)).toBe(0);
    expect(sessionPages(session({ startValue: null, startPercent: null }), paperback)).toBe(0);
  });

  it('computes audio seconds for audiobooks', () => {
    expect(
      sessionAudioSeconds(
        session({ progressUnit: 'audio_seconds', startValue: 100, endValue: 4100 }),
        audiobook,
      ),
    ).toBe(4000);
    expect(
      sessionAudioSeconds(
        session({ progressUnit: 'percent', startPercent: 10, endPercent: 20 }),
        audiobook,
      ),
    ).toBe(3600);
    expect(sessionAudioSeconds(session(), paperback)).toBeNull();
    expect(
      sessionAudioSeconds(session({ progressUnit: 'percent', startPercent: null }), audiobook),
    ).toBeNull();
    expect(
      sessionAudioSeconds(session({ progressUnit: 'percent' }), {
        ...audiobook,
        audioDurationSeconds: null,
      }),
    ).toBeNull();
  });
});

describe('readingSpeeds', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');

  it('computes per-format speeds within the window', () => {
    const speeds = readingSpeeds(
      [
        { session: session({ durationSeconds: 3600 }), format: paperback },
        {
          session: session({
            durationSeconds: 1800,
            startValue: 40,
            endValue: 60,
            startPercent: 10,
            endPercent: 15,
          }),
          format: paperback,
        },
        {
          session: session({
            progressUnit: 'percent',
            startValue: 20,
            endValue: 30,
            startPercent: 20,
            endPercent: 30,
            durationSeconds: 1800,
          }),
          format: kindle,
        },
        {
          session: session({
            progressUnit: 'audio_seconds',
            startValue: 0,
            endValue: 5400,
            startPercent: 0,
            endPercent: 15,
            durationSeconds: 3600,
          }),
          format: audiobook,
        },
        // Outside the window, in the future, and zero duration: all ignored.
        { session: session({ startedAt: '2026-10-01T09:00:00.000Z' }), format: paperback },
        { session: session({ startedAt: '2026-11-15T09:00:00.000Z' }), format: paperback },
        { session: session({ durationSeconds: 0 }), format: paperback },
      ],
      now,
    );
    expect(speeds).toEqual([
      {
        format: 'physical',
        sessions: 2,
        seconds: 5400,
        pagesPerHour: 40,
        percentPerHour: 10,
        listeningRatio: null,
      },
      {
        format: 'kindle',
        sessions: 1,
        seconds: 1800,
        pagesPerHour: null,
        percentPerHour: 20,
        listeningRatio: null,
      },
      {
        format: 'audiobook',
        sessions: 1,
        seconds: 3600,
        pagesPerHour: null,
        percentPerHour: 15,
        listeningRatio: 1.5,
      },
    ]);
  });

  it('returns nulls when progress is unknown and respects a custom window', () => {
    const speeds = readingSpeeds(
      [
        {
          session: session({
            progressUnit: 'percent',
            startValue: null,
            endValue: null,
            startPercent: null,
            endPercent: null,
          }),
          format: kindle,
        },
        { session: session({ startedAt: '2026-11-01T09:00:00.000Z' }), format: paperback },
        // Unknown durations (imported days) never count towards speed.
        { session: session({ durationSeconds: null }), format: paperback },
      ],
      now,
      7,
    );
    expect(speeds).toEqual([
      {
        format: 'kindle',
        sessions: 1,
        seconds: 3600,
        pagesPerHour: null,
        percentPerHour: null,
        listeningRatio: null,
      },
    ]);
  });
});

describe('estimateFinish', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');
  const tz = 'Europe/London';

  it('projects a finish date from the 14-day rate', () => {
    const result = estimateFinish({
      currentPercent: 30,
      sessions: [
        session({ startedAt: '2026-11-13T09:00:00.000Z', startPercent: 0, endPercent: 14 }),
        session({ startedAt: '2026-11-01T09:00:00.000Z', startPercent: 14, endPercent: 28 }),
        // Before the window (window starts 01/11): ignored.
        session({ startedAt: '2026-10-31T09:00:00.000Z', startPercent: 0, endPercent: 50 }),
        // Unknown percents contribute nothing.
        session({ startedAt: '2026-11-12T09:00:00.000Z', startPercent: null, endPercent: null }),
        // Sessions with an unknown duration are left out of the rate.
        session({
          startedAt: '2026-11-11T09:00:00.000Z',
          durationSeconds: null,
          startPercent: 0,
          endPercent: 60,
        }),
      ],
      now,
      timeZone: tz,
    });
    // 28 points over 14 days = 2/day; 70 remaining = 35 days.
    expect(result).toEqual({ percentPerDay: 2, daysRemaining: 35, date: '2026-12-19' });
  });

  it('rounds days remaining up', () => {
    const result = estimateFinish({
      currentPercent: 99,
      sessions: [
        session({ startedAt: '2026-11-14T09:00:00.000Z', startPercent: 0, endPercent: 28 }),
      ],
      now,
      timeZone: tz,
    });
    expect(result).toEqual({ percentPerDay: 2, daysRemaining: 1, date: '2026-11-15' });
  });

  it('is null without progress, when complete, or with no recent sessions', () => {
    expect(estimateFinish({ currentPercent: null, sessions: [session()], now, timeZone: tz })).toBe(
      null,
    );
    expect(estimateFinish({ currentPercent: 100, sessions: [session()], now, timeZone: tz })).toBe(
      null,
    );
    expect(estimateFinish({ currentPercent: 20, sessions: [], now, timeZone: tz })).toBeNull();
    expect(
      estimateFinish({
        currentPercent: 20,
        sessions: [session({ startedAt: '2026-11-16T09:00:00.000Z' })],
        now,
        timeZone: tz,
      }),
    ).toBeNull();
  });

  it('supports a custom window', () => {
    const result = estimateFinish({
      currentPercent: 50,
      sessions: [
        session({ startedAt: '2026-11-14T09:00:00.000Z', startPercent: 40, endPercent: 50 }),
      ],
      now,
      timeZone: tz,
      windowDays: 5,
    });
    expect(result).toEqual({ percentPerDay: 2, daysRemaining: 25, date: '2026-12-09' });
  });
});

describe('computeStreaks', () => {
  it('is zero with no days', () => {
    expect(computeStreaks([], '2026-11-14')).toEqual({
      current: 0,
      longest: 0,
      lastReadDate: null,
    });
  });

  it('counts a streak that includes today', () => {
    expect(
      computeStreaks(['2026-11-12', '2026-11-14', '2026-11-13', '2026-11-13'], '2026-11-14'),
    ).toEqual({ current: 3, longest: 3, lastReadDate: '2026-11-14' });
  });

  it('keeps a streak ending yesterday current', () => {
    expect(computeStreaks(['2026-11-12', '2026-11-13'], '2026-11-14')).toEqual({
      current: 2,
      longest: 2,
      lastReadDate: '2026-11-13',
    });
  });

  it('breaks the current streak after a missed day but keeps the longest', () => {
    expect(
      computeStreaks(
        ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-10', '2026-11-12'],
        '2026-11-14',
      ),
    ).toEqual({ current: 0, longest: 4, lastReadDate: '2026-11-12' });
  });

  it('ignores future days and spans month boundaries', () => {
    expect(computeStreaks(['2026-10-31', '2026-11-01', '2026-11-20'], '2026-11-01')).toEqual({
      current: 2,
      longest: 2,
      lastReadDate: '2026-11-01',
    });
  });
});

describe('timerElapsedSeconds', () => {
  const now = new Date('2026-11-14T10:00:00.000Z');

  it('adds the running segment to earlier segments', () => {
    expect(
      timerElapsedSeconds(
        { resumedAt: '2026-11-14T09:30:00.000Z', pausedAt: null, accumulatedSeconds: 600 },
        now,
      ),
    ).toBe(600 + 1800);
  });

  it('ignores the clock while paused', () => {
    expect(
      timerElapsedSeconds(
        {
          resumedAt: '2026-11-14T09:00:00.000Z',
          pausedAt: '2026-11-14T09:10:00.000Z',
          accumulatedSeconds: 600,
        },
        now,
      ),
    ).toBe(600);
  });

  it('floors partial seconds and never goes negative', () => {
    expect(
      timerElapsedSeconds(
        { resumedAt: '2026-11-14T09:59:58.600Z', pausedAt: null, accumulatedSeconds: 0 },
        now,
      ),
    ).toBe(1);
    expect(
      timerElapsedSeconds(
        { resumedAt: '2026-11-14T10:05:00.000Z', pausedAt: null, accumulatedSeconds: 5 },
        now,
      ),
    ).toBe(5);
  });
});

describe('mergeCandidates', () => {
  it('merges candidates without overwriting known fields', () => {
    const base: BookCandidate = {
      source: 'openlibrary',
      sourceId: 'OL1M',
      title: 'Base',
      subtitle: null,
      authors: [],
      publisher: null,
      publishedDate: null,
      language: null,
      synopsis: null,
      coverUrl: null,
      isbn10: null,
      isbn13: null,
      genres: [],
      pageCount: 10,
    };
    const extra: BookCandidate = {
      ...base,
      source: 'googlebooks',
      title: 'Extra',
      subtitle: 'Sub',
      authors: ['A'],
      publisher: 'P',
      publishedDate: '2000',
      language: 'en',
      synopsis: 'S',
      coverUrl: 'https://example.org/c.jpg',
      isbn10: '0306406152',
      isbn13: '9780306406157',
      genres: ['G'],
      pageCount: 20,
    };
    expect(mergeCandidates(base, extra)).toEqual({
      ...extra,
      source: 'openlibrary',
      sourceId: 'OL1M',
      title: 'Base',
      pageCount: 10,
    });
  });
});
