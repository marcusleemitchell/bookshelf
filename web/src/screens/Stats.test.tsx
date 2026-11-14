import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IDS, TIME_ZONE, TODAY, daily, makeGoal, summary } from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { ok, type MockRequest } from '../test/server.ts';
import { rangeBounds, toSeries } from './Stats.tsx';

describe('rangeBounds', () => {
  it('maps ranges to inclusive local dates', () => {
    expect(rangeBounds('week', '2026-11-14')).toMatchObject({
      from: '2026-11-08',
      to: '2026-11-14',
      byMonth: false,
    });
    expect(rangeBounds('month', '2026-11-14')).toMatchObject({
      from: '2026-10-16',
      dailyFrom: '2026-10-16',
    });
    expect(rangeBounds('year', '2026-11-14')).toMatchObject({ from: '2026-01-01', byMonth: true });
    expect(rangeBounds('all', '2026-11-14')).toMatchObject({
      from: undefined,
      to: undefined,
      dailyFrom: '2016-11-07',
    });
  });
});

describe('toSeries', () => {
  it('labels days DD/MM and groups long ranges by month, dropping empty leading months', () => {
    const data = daily([
      { date: '2026-09-30', minutes: 0 },
      { date: '2026-10-01', minutes: 30, pages: 20, percent: 5.5 },
      { date: '2026-11-02', minutes: 15, pages: 5, percent: 1.25 },
      { date: '2026-11-03', minutes: 10, pages: 5, percent: 1.25 },
    ]);
    expect(toSeries(data, false, TIME_ZONE)[1]).toEqual({
      key: '2026-10-01',
      label: '01/10',
      minutes: 30,
      pages: 20,
      percent: 5.5,
    });
    expect(toSeries(data, true, TIME_ZONE)).toEqual([
      { key: '2026-10', label: 'Oct 26', minutes: 30, pages: 20, percent: 5.5 },
      { key: '2026-11', label: 'Nov 26', minutes: 25, pages: 10, percent: 2.5 },
    ]);
    expect(toSeries(daily([{ date: '2026-11-01', minutes: 0 }]), true, TIME_ZONE)).toHaveLength(1);
  });
});

describe('Stats', () => {
  it('shows totals, charts with text summaries, breakdowns, speed, goals and the year in review', async () => {
    renderApp({
      hash: '#/stats',
      routes: {
        'GET /api/goals': ok([
          makeGoal(),
          makeGoal({
            id: IDS.goalBooks,
            kind: 'books_per_year',
            year: 2026,
            target: 24,
            current: 18,
          }),
        ]),
      },
    });
    const totals = await screen.findByRole('region', { name: 'Totals' });
    expect(within(totals).getByText('12h 30m')).toBeInTheDocument();
    expect(within(totals).getByText('412')).toBeInTheDocument();
    expect(await screen.findByRole('figure', { name: 'Minutes read per day' })).toHaveTextContent(
      '20m over 1 day with reading; most on 14/11 (20 min).',
    );
    expect(screen.getByRole('list', { name: 'By author' })).toHaveTextContent(
      'Ursula K. Le Guin8h 20m',
    );
    expect(screen.getByText('49 pages an hour · 16.2% an hour')).toBeInTheDocument();
    expect(screen.getByText('20% an hour · 1.50× listening speed')).toBeInTheDocument();
    expect(screen.getByText('18 / 24')).toBeInTheDocument();
    expect(screen.getByText('Books in 2026')).toBeInTheDocument();
    expect(await screen.findByText('Longest session: 2h 30m on 12/09/2026.')).toBeInTheDocument();
    expect(
      screen.getByRole('figure', { name: 'Minutes read per month in 2026' }),
    ).toHaveTextContent('busiest month October 2026');
    // The rating has its own line in the narrow tile so it is never cut off.
    expect(screen.getByText('02/10/2026')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Rated 4½ stars' })).toHaveTextContent('★★★★½');
  });

  it('explains that sessions with unknown time are not in the time totals', async () => {
    renderApp({
      hash: '#/stats',
      routes: {
        'GET /api/stats/summary': ok(
          summary({
            totals: {
              seconds: 45_000,
              sessions: 24,
              pages: 412,
              booksFinished: 2,
              untimedSessions: 3,
            },
          }),
        ),
      },
    });
    expect(
      await screen.findByText(
        '3 sessions with unknown time (imported) count as sessions but not towards reading time, minutes or speed.',
      ),
    ).toBeInTheDocument();
  });

  it('summarises a minutes chart whose reading has no known time', async () => {
    const untimedDaily = (req: MockRequest) => {
      const data = daily(
        [{ date: req.query.get('to') ?? TODAY, minutes: 0 }],
        req.query.get('from') ?? TODAY,
        req.query.get('to') ?? TODAY,
      );
      return {
        body: {
          ...data,
          days: data.days.map((d, i) => (i === 0 ? { ...d, sessions: 2, untimedSessions: 2 } : d)),
        },
      };
    };
    renderApp({ hash: '#/stats', routes: { 'GET /api/stats/daily': untimedDaily } });
    expect(
      await screen.findByText(
        'No timed reading in this range. 2 sessions with time unknown not shown.',
      ),
    ).toBeInTheDocument();
  });

  it('refetches when the range or year changes', async () => {
    const { user, server } = renderApp({ hash: '#/stats' });
    await screen.findByRole('region', { name: 'Totals' });
    await user.click(screen.getByRole('button', { name: 'Week' }));
    await user.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => {
      expect(server.callsTo('GET', '/api/stats/summary').map((c) => c.query.toString())).toEqual([
        'from=2026-10-16&to=2026-11-14',
        'from=2026-11-08&to=2026-11-14',
        '',
      ]);
    });
    await user.selectOptions(screen.getByLabelText('Year'), '2025');
    await waitFor(() => {
      expect(server.callsTo('GET', '/api/stats/year/2025')).toHaveLength(1);
    });
  });

  it('invites setting goals when there are none', async () => {
    renderApp({ hash: '#/stats', routes: { 'GET /api/goals': ok([]) } });
    expect(await screen.findByText(/No goals set/)).toBeInTheDocument();
  });
});
