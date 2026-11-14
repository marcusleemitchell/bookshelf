import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { timerPutSchema, type ActiveTimer } from '../../../shared/index.ts';
import { App } from '../App.tsx';
import { IDS, NOW, leGuin, makeSession, makeTimer, timerResponse } from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { ok, type MockRequest } from '../test/server.ts';

/** Timer routes backed by a mutable server-side timer, like the real API. */
function timerRoutes(initial: ActiveTimer | null, now: () => string = () => NOW) {
  let timer = initial;
  return {
    get current() {
      return timer;
    },
    routes: {
      'GET /api/timer': () => ({ body: timerResponse(timer, now()) }),
      'PUT /api/timer': (req: MockRequest) => {
        const body = timerPutSchema.parse(req.body);
        const at = now();
        if (body.action === 'start') {
          timer = makeTimer({
            id: body.id ?? IDS.timer,
            bookId: body.bookId,
            formatId: body.formatId,
            startedAt: at,
            resumedAt: at,
            createdAt: at,
            updatedAt: at,
          });
        } else if (timer && body.action === 'pause') {
          timer = {
            ...timer,
            pausedAt: at,
            accumulatedSeconds: timerResponse(timer, at).elapsedSeconds,
          };
        } else if (timer) {
          timer = { ...timer, pausedAt: null, resumedAt: at };
        }
        return { body: timerResponse(timer, at) };
      },
      'DELETE /api/timer': () => {
        timer = null;
        return { status: 204 };
      },
    },
  };
}

describe('Today', () => {
  it('shows what is being read, the daily goal and the streak', async () => {
    renderApp({ routes: { 'GET /api/books/:id': ok(leGuin()) } });
    expect(
      await screen.findByRole('link', { name: 'The Left Hand of Darkness' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/finish by 29\/11\/2026/)).toBeInTheDocument();
    expect(screen.getByText('40% read', { exact: false })).toBeInTheDocument();
    expect(await screen.findByText('of 30 minutes')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(await screen.findByLabelText('Current streak 5 days')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Daily goal progress' })).toHaveAttribute(
      'aria-valuenow',
      '67',
    );
  });

  it('starts a timer for a book being read', async () => {
    const timer = timerRoutes(null);
    const { user, server } = renderApp({
      routes: { ...timer.routes, 'GET /api/books/:id': ok(leGuin()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Start timer' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(server.callsTo('PUT', '/api/timer')[0]?.body).toEqual({
      action: 'start',
      id: '00000000-0000-4000-8000-0000000003e8',
      bookId: IDS.leGuin,
      formatId: IDS.leGuinPhysical,
    });
    expect(screen.getByText('0:00:00')).toBeInTheDocument();
  });

  it('pauses and resumes the running timer', async () => {
    const timer = timerRoutes(makeTimer());
    const { user, server } = renderApp({
      routes: { ...timer.routes, 'GET /api/books/:id': ok(leGuin()) },
    });
    expect(await screen.findByText('0:30:00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(server.callsTo('PUT', '/api/timer').map((c) => c.body)).toEqual([
      { action: 'pause' },
      { action: 'resume' },
    ]);
  });

  it('derives elapsed time from timestamps after the app is closed and reopened offline', async () => {
    const timer = timerRoutes(makeTimer());
    const harness = renderApp({ routes: { ...timer.routes, 'GET /api/books/:id': ok(leGuin()) } });
    expect(await screen.findByText('0:30:00')).toBeInTheDocument();
    harness.unmount();

    // 70 minutes later, the Mac is asleep: the cached timer still counts correctly.
    harness.clock.set('2026-11-14T11:10:00.000Z');
    harness.server.offline = true;
    render(<App services={harness.services} />);
    expect(await screen.findByText('1:40:00')).toBeInTheDocument();
    expect(await screen.findByText(/Offline\./)).toBeInTheDocument();
  });

  it('discards the timer after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const timer = timerRoutes(makeTimer());
    const { user, server } = renderApp({
      routes: { ...timer.routes, 'GET /api/books/:id': ok(leGuin()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('button', { name: 'Start timer' })).toBeInTheDocument();
    expect(server.callsTo('DELETE', '/api/timer')).toHaveLength(1);
  });

  it('stops the timer into a prefilled session, then discards the timer', async () => {
    const timer = timerRoutes(makeTimer());
    const { user, server } = renderApp({
      routes: {
        ...timer.routes,
        'GET /api/books/:id': ok(leGuin()),
        'GET /api/sessions': ok([makeSession()]),
        'GET /api/books/:id/notes': ok([]),
        'POST /api/sessions': (req) => ({
          status: 201,
          body: makeSession({ id: IDS.session2, ...(req.body as object) }),
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Stop & log' }));
    expect(window.location.hash).toBe(`#/log?book=${IDS.leGuin}&timer=1`);
    expect(await screen.findByText('From the timer')).toBeInTheDocument();
    expect(screen.getByLabelText('Reading time (minutes)')).toHaveValue(30);
    expect(screen.getByLabelText('Started')).toHaveValue('2026-11-14T09:30');
    expect(screen.getByLabelText('From (page)')).toHaveValue('122');
    await user.type(screen.getByLabelText('To (page)'), '150');
    await user.click(screen.getByRole('button', { name: 'Save session' }));

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/books/${IDS.leGuin}`);
    });
    expect(server.callsTo('POST', '/api/sessions')[0]?.body).toMatchObject({
      bookId: IDS.leGuin,
      formatId: IDS.leGuinPhysical,
      startedAt: '2026-11-14T09:30:00.000Z',
      endedAt: NOW,
      durationSeconds: 1800,
      progressUnit: 'pages',
      startValue: 122,
      endValue: 150,
    });
    expect(server.callsTo('DELETE', '/api/timer')).toHaveLength(1);
    expect(timer.current).toBeNull();
  });

  it('queues timer changes offline and shows them from the cache', async () => {
    const timer = timerRoutes(null);
    const { user, server, services } = renderApp({
      routes: { ...timer.routes, 'GET /api/books/:id': ok(leGuin()) },
    });
    await user.click(await screen.findByRole('button', { name: 'Start timer' }));
    await screen.findByRole('button', { name: 'Pause' });
    server.offline = true;
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    const ops = await services.outbox.list();
    expect(ops.map((op) => [op.entity, op.action, op.label])).toEqual([
      ['timer', 'upsert', 'Pause timer'],
    ]);
    expect(ops[0]?.payload).toMatchObject({ pausedAt: NOW, accumulatedSeconds: 0 });
    expect(await screen.findByText(/Saved on this device/)).toBeInTheDocument();
    const banner = screen.getAllByRole('status').find((el) => el.classList.contains('banner'));
    expect(banner && within(banner).getByText('1 change waiting to sync.')).toBeInTheDocument();
  });

  it('explains when there is nothing to time', async () => {
    renderApp({ routes: { 'GET /api/books': ok([]) } });
    expect(await screen.findByText(/Add a book with a format/)).toBeInTheDocument();
    expect(screen.getByText('Nothing on the go.')).toBeInTheDocument();
  });
});
