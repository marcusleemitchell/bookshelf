import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IDS, makeSession } from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { ok } from '../test/server.ts';

describe('Calendar', () => {
  it('draws the month Monday-first with covers on days with reading', async () => {
    renderApp({ hash: '#/calendar' });
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    expect(await screen.findByText('2 days with reading · 1h 35m in total')).toBeInTheDocument();
    const days = screen.getByRole('list', { name: 'Days of November 2026' });
    // 1 November 2026 is a Sunday: six blank cells before it in a Monday-first grid.
    expect(days.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(6);
    const busy = within(days).getByRole('button', {
      name: 'Friday 13 November 2026: The Left Hand of Darkness, Project Hail Mary, 1h 05m',
    });
    expect(busy.querySelectorAll('.cover')).toHaveLength(2);
    expect(
      within(days).getByRole('img', { name: 'Saturday 14 November 2026: no reading' }),
    ).toHaveClass('is-today');
  });

  it('lists a day’s sessions when it is tapped', async () => {
    const { user, server } = renderApp({
      hash: '#/calendar',
      routes: {
        'GET /api/sessions': ok([
          makeSession(),
          makeSession({
            id: IDS.session2,
            bookId: IDS.hailMary,
            startedAt: '2026-11-13T07:00:00.000Z',
            endedAt: '2026-11-13T07:20:00.000Z',
            durationSeconds: 1200,
            progressUnit: 'audio_seconds',
            startValue: 0,
            endValue: 1200,
            readId: IDS.hailMaryRead,
            formatId: IDS.hailMaryAudio,
          }),
        ]),
      },
    });
    await user.click(await screen.findByRole('button', { name: /Friday 13 November 2026/ }));
    const panel = await screen.findByRole('region', { name: 'Friday 13 November 2026' });
    expect(within(panel).getByText('13/11/2026')).toBeInTheDocument();
    expect(await within(panel).findByText('07:00–07:20 · 20m')).toBeInTheDocument();
    expect(within(panel).getByText('20:00–20:45 · 45m')).toBeInTheDocument();
    expect(within(panel).getByText('0:00:00 → 0:20:00')).toBeInTheDocument();
    expect(server.callsTo('GET', '/api/sessions')[0]?.query.toString()).toBe(
      'from=2026-11-13&to=2026-11-13',
    );
  });

  it('moves between months', async () => {
    const { user, server } = renderApp({ hash: '#/calendar' });
    await user.click(await screen.findByRole('link', { name: 'Previous month, October 2026' }));
    expect(await screen.findByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(server.callsTo('GET', '/api/calendar').map((c) => c.query.get('month'))).toContain(
      '2026-10',
    );
    expect(screen.getByRole('link', { name: 'Back to this month' })).toBeInTheDocument();
  });

  it('says when a month has no reading', async () => {
    renderApp({
      hash: '#/calendar?month=2026-01',
      routes: { 'GET /api/calendar': ok({ month: '2026-01', days: [] }) },
    });
    expect(await screen.findByText('No reading recorded this month.')).toBeInTheDocument();
  });
});
