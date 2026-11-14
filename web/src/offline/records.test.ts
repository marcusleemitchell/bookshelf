import { describe, expect, it } from 'vitest';
import { syncPayloadSchemas } from '../../../shared/index.ts';
import { IDS, hailMary, leGuin, makeRead, makeTimer, piranesi } from '../test/fixtures.ts';
import { idSequence } from '../test/services.ts';
import {
  TimerTransitionError,
  inProgressRead,
  latestRead,
  pausedTimer,
  planBookPatch,
  planSession,
  resumedTimer,
  startedTimer,
  timerResponse,
  toListItem,
  type SessionInput,
} from './records.ts';

const AT = '2026-11-14T10:00:00.000Z';

function sessionInput(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    formatId: IDS.leGuinPhysical,
    startedAt: '2026-11-14T09:00:00.000Z',
    endedAt: '2026-11-14T09:40:00.000Z',
    durationSeconds: 2400,
    progressUnit: 'pages',
    startValue: 122,
    endValue: 152,
    note: null,
    ...overrides,
  };
}

/** Every planned op must be a valid sync payload for its entity. */
function expectValidOps(ops: { entity: keyof typeof syncPayloadSchemas; payload: unknown }[]) {
  for (const op of ops)
    expect(syncPayloadSchemas[op.entity].safeParse(op.payload).success).toBe(true);
}

describe('planSession', () => {
  it('uses the in-progress read and projects the new progress', () => {
    const book = leGuin();
    const format = book.formats[0];
    if (!format) throw new Error('fixture');
    const plan = planSession(book, format, sessionInput(), AT, idSequence());
    expect(plan.ops.map((o) => o.entity)).toEqual(['session']);
    expectValidOps(plan.ops);
    expect(plan.session).toMatchObject({ readId: IDS.leGuinRead, endPercent: 50 });
    expect(plan.detail.progressPercent).toBe(50);
  });

  it('opens a read and shelves a to-read book as reading (book → read → session)', () => {
    const book = piranesi();
    const format = book.formats[0];
    if (!format) throw new Error('fixture');
    const plan = planSession(
      book,
      format,
      sessionInput({
        formatId: IDS.piranesiKindle,
        progressUnit: 'percent',
        startValue: 0,
        endValue: 12,
      }),
      AT,
      idSequence(500),
    );
    expect(plan.ops.map((o) => o.entity)).toEqual(['book', 'read', 'session']);
    expectValidOps(plan.ops);
    expect(plan.ops[1]?.payload).toMatchObject({
      number: 1,
      outcome: 'in_progress',
      startedAt: '2026-11-14T09:00:00.000Z',
    });
    expect(plan.detail.status).toBe('reading');
    expect(plan.detail.currentRead?.number).toBe(1);
    expect(plan.detail.progressPercent).toBe(12);
  });

  it('starts a new read numbered after finished ones', () => {
    const book = hailMary();
    const format = book.formats[0];
    if (!format) throw new Error('fixture');
    const plan = planSession(
      book,
      format,
      sessionInput({
        formatId: IDS.hailMaryAudio,
        progressUnit: 'audio_seconds',
        startValue: 0,
        endValue: 600,
      }),
      AT,
      idSequence(),
    );
    expect(plan.ops.map((o) => o.entity)).toEqual(['read', 'session']);
    expect(plan.ops[0]?.payload).toMatchObject({ number: 2 });
  });

  it('moves the read start back for a retrospective session', () => {
    const book = leGuin();
    const format = book.formats[0];
    if (!format) throw new Error('fixture');
    const plan = planSession(
      book,
      format,
      sessionInput({ startedAt: '2026-10-20T09:00:00.000Z' }),
      AT,
      idSequence(),
    );
    expect(plan.ops.map((o) => o.entity)).toEqual(['read', 'session']);
    expect(plan.ops[0]?.payload).toMatchObject({
      id: IDS.leGuinRead,
      startedAt: '2026-10-20T09:00:00.000Z',
    });
  });

  it('keeps progress when the session records no end value', () => {
    const book = leGuin();
    const format = book.formats[0];
    if (!format) throw new Error('fixture');
    const plan = planSession(book, format, sessionInput({ endValue: null }), AT, idSequence());
    expect(plan.detail.progressPercent).toBe(40);
  });
});

describe('planBookPatch', () => {
  it('changes the rating only', () => {
    const plan = planBookPatch(leGuin(), { rating: 4 }, AT, idSequence());
    expect(plan.ops.map((o) => o.entity)).toEqual(['book']);
    expectValidOps(plan.ops);
    expect(plan.detail.rating).toBe(4);
  });

  it('closes the in-progress read when finishing', () => {
    const plan = planBookPatch(leGuin(), { status: 'finished' }, AT, idSequence());
    expect(plan.ops.map((o) => o.entity)).toEqual(['book', 'read']);
    expect(plan.ops[1]?.payload).toMatchObject({ outcome: 'finished', finishedAt: AT });
    expect(plan.detail.currentRead?.outcome).toBe('finished');
    expect(plan.detail.estimatedFinish).toBeNull();
  });

  it('records a closed read for a book never started', () => {
    const plan = planBookPatch(piranesi(), { status: 'dnf' }, AT, idSequence(700));
    expect(plan.ops[1]?.payload).toMatchObject({
      outcome: 'dnf',
      startedAt: AT,
      finishedAt: AT,
      number: 1,
    });
  });

  it('opens a read when starting to read, but not when one is open', () => {
    const opened = planBookPatch(piranesi(), { status: 'reading' }, AT, idSequence());
    expect(opened.ops.map((o) => o.entity)).toEqual(['book', 'read']);
    expect(opened.detail.progressPercent).toBeNull();
    const already = planBookPatch(
      leGuin({ status: 'to_read' }),
      { status: 'reading' },
      AT,
      idSequence(),
    );
    expect(already.ops.map((o) => o.entity)).toEqual(['book']);
  });

  it('leaves reads alone for to_read and for finishing an already closed book', () => {
    expect(planBookPatch(leGuin(), { status: 'to_read' }, AT, idSequence()).ops).toHaveLength(1);
    expect(
      planBookPatch(hailMary({ status: 'reading' }), { status: 'finished' }, AT, idSequence()).ops,
    ).toHaveLength(1);
  });
});

describe('reads', () => {
  it('finds the in-progress and latest reads', () => {
    const reads = [
      makeRead({ id: IDS.leGuinRead, bookId: IDS.leGuin, number: 1, outcome: 'finished' }),
      makeRead({ id: IDS.hailMaryRead, bookId: IDS.leGuin, number: 2 }),
    ];
    expect(inProgressRead(reads)?.number).toBe(2);
    expect(latestRead(reads)?.number).toBe(2);
    expect(inProgressRead([])).toBeNull();
  });

  it('projects a detail onto a list item', () => {
    const item = toListItem(leGuin());
    expect(item).not.toHaveProperty('reads');
    expect(item).not.toHaveProperty('estimatedFinish');
  });
});

describe('timer transitions', () => {
  it('starts, pauses and resumes from timestamps', () => {
    const started = startedTimer(
      IDS.timer,
      IDS.leGuin,
      IDS.leGuinPhysical,
      '2026-11-14T09:00:00.000Z',
    );
    const paused = pausedTimer(started, '2026-11-14T09:25:30.000Z');
    expect(paused).toMatchObject({
      accumulatedSeconds: 1530,
      pausedAt: '2026-11-14T09:25:30.000Z',
    });
    const resumed = resumedTimer(paused, '2026-11-14T09:40:00.000Z');
    expect(resumed).toMatchObject({ pausedAt: null, resumedAt: '2026-11-14T09:40:00.000Z' });
    expect(timerResponse(resumed, new Date(AT)).elapsedSeconds).toBe(1530 + 1200);
    expect(timerResponse(null, new Date(AT))).toEqual({
      timer: null,
      elapsedSeconds: 0,
      serverTime: AT,
    });
  });

  it('rejects invalid transitions', () => {
    const running = makeTimer();
    expect(() => resumedTimer(running, AT)).toThrow(TimerTransitionError);
    const paused = pausedTimer(running, AT);
    expect(() => pausedTimer(paused, AT)).toThrow('already paused');
    expect(() => resumedTimer(paused, '2026-11-14T09:00:00.000Z')).toThrow('before');
  });
});
