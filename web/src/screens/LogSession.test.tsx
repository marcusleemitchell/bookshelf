import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bookDetailSchema } from '../../../shared/index.ts';
import { cacheKeys } from '../offline/cache.ts';
import {
  IDS,
  NOW,
  hailMary,
  leGuin,
  makeFormat,
  makeRead,
  makeSession,
  piranesi,
} from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { ok, type RouteTable } from '../test/server.ts';

function routes(extra: RouteTable = {}): RouteTable {
  return {
    'GET /api/books/:id': (req) => ({
      body: [leGuin(), piranesi(), hailMary()].find((b) => b.id === req.params['id']),
    }),
    'GET /api/sessions': ok([]),
    'GET /api/books/:id/notes': ok([]),
    'POST /api/sessions': (req) => ({
      status: 201,
      body: makeSession({ ...(req.body as object) }),
    }),
    ...extra,
  };
}

describe('Log session', () => {
  it('logs a session in pages, prefilled from current progress', async () => {
    const { user, server } = renderApp({ hash: `#/log?book=${IDS.leGuin}`, routes: routes() });
    const from = await screen.findByLabelText('From (page)');
    expect(from).toHaveValue('122');
    expect(screen.getByLabelText('From (percent)')).toHaveValue('40.13');
    expect(screen.getByLabelText('Reading time (minutes)')).toHaveValue(30);
    await user.type(screen.getByLabelText('To (page)'), '152');
    expect(screen.getByLabelText('To (percent)')).toHaveValue('50');
    expect(screen.getByText('30 pages · +9.87%')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Note'), 'Into the ice.');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sessions')).toHaveLength(1);
    });
    expect(server.callsTo('POST', '/api/sessions')[0]?.body).toEqual({
      id: '00000000-0000-4000-8000-0000000003e8',
      bookId: IDS.leGuin,
      formatId: IDS.leGuinPhysical,
      startedAt: '2026-11-14T09:30:00.000Z',
      endedAt: NOW,
      durationSeconds: 1800,
      progressUnit: 'pages',
      startValue: 122,
      endValue: 152,
      note: 'Into the ice.',
    });
  });

  it('fills in pages from a typed percent and saves the percent', async () => {
    const { user, server } = renderApp({ hash: `#/log?book=${IDS.leGuin}`, routes: routes() });
    await user.type(await screen.findByLabelText('To (page)'), '152');
    await user.clear(screen.getByLabelText('To (percent)'));
    await user.type(screen.getByLabelText('To (percent)'), '55');
    expect(screen.getByLabelText('To (page)')).toHaveValue('167');
    expect(screen.getByText('45 pages · +14.87%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sessions')[0]?.body).toMatchObject({
        progressUnit: 'percent',
        startValue: 40.13,
        endValue: 55,
      });
    });
  });

  it('logs audiobook progress as h:mm:ss positions, with a duration only', async () => {
    const listening = hailMary({
      status: 'reading',
      progressPercent: 50,
      reads: [makeRead({ id: IDS.hailMaryRead, bookId: IDS.hailMary })],
    });
    const { user, server } = renderApp({
      hash: `#/log?book=${IDS.hailMary}`,
      routes: routes({ 'GET /api/books/:id': ok(listening) }),
    });
    expect(await screen.findByLabelText('From (h:mm:ss)')).toHaveValue('8:05:18');
    await user.type(screen.getByLabelText('To (h:mm:ss)'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('End: Use h:mm:ss');

    expect(screen.getByLabelText('To (percent)')).toHaveValue('');
    await user.clear(screen.getByLabelText('To (h:mm:ss)'));
    await user.type(screen.getByLabelText('To (h:mm:ss)'), '9:00:00');
    expect(screen.getByLabelText('From (percent)')).toHaveValue('50');
    expect(screen.getByLabelText('To (percent)')).toHaveValue('55.64');
    expect(screen.getByText('55m listened · +5.64%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Duration' }));
    expect(screen.queryByLabelText('Ended')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Reading time (minutes)'));
    await user.type(screen.getByLabelText('Reading time (minutes)'), '45');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sessions')[0]?.body).toMatchObject({
        progressUnit: 'audio_seconds',
        startValue: 29_118,
        endValue: 32_400,
        durationSeconds: 2700,
        startedAt: '2026-11-14T09:30:00.000Z',
        endedAt: '2026-11-14T10:15:00.000Z',
      });
    });
  });

  it('asks for one unit when the length is unknown and the rows were typed in different units', async () => {
    const { user, server } = renderApp({
      hash: `#/log?book=${IDS.piranesi}`,
      routes: routes(),
    });
    const fromPercent = await screen.findByLabelText('From (percent)');
    await user.clear(fromPercent);
    await user.type(fromPercent, '5');
    expect(screen.getByLabelText('From (page)')).toHaveValue('');
    await user.type(screen.getByLabelText('To (page)'), '30');
    expect(screen.getByLabelText('To (percent)')).toHaveValue('');
    expect(screen.queryByText(/pages · /)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End: the length isn’t known, so this can’t be converted to %. Enter From and To both in pages or both in %.',
    );

    await user.clear(screen.getByLabelText('To (page)'));
    await user.type(screen.getByLabelText('To (percent)'), '9');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sessions')[0]?.body).toMatchObject({
        progressUnit: 'percent',
        startValue: 5,
        endValue: 9,
      });
    });
  });

  it('prefills the percent alone when another format has no known length', async () => {
    const kindleId = '00000000-0000-4000-8000-0000000009a1';
    const twoFormats = leGuin({
      formats: [
        makeFormat({ id: IDS.leGuinPhysical, bookId: IDS.leGuin, pageCount: 304 }),
        makeFormat({ id: kindleId, bookId: IDS.leGuin, format: 'kindle', pageCount: null }),
      ],
    });
    const { user, server } = renderApp({
      hash: `#/log?book=${IDS.leGuin}`,
      routes: routes({ 'GET /api/books/:id': ok(twoFormats) }),
    });
    await user.type(await screen.findByLabelText('To (page)'), '152');
    await user.selectOptions(screen.getByLabelText('Format'), kindleId);
    expect(screen.getByLabelText('From (page)')).toHaveValue('');
    expect(screen.getByLabelText('From (percent)')).toHaveValue('40');
    expect(screen.getByLabelText('To (page)')).toHaveValue('');
    await user.type(screen.getByLabelText('To (percent)'), '48');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sessions')[0]?.body).toMatchObject({
        formatId: kindleId,
        progressUnit: 'percent',
        startValue: 40,
        endValue: 48,
      });
    });
  });

  it('saves in pages again once the percent box is cleared', async () => {
    const { user, server } = renderApp({ hash: `#/log?book=${IDS.leGuin}`, routes: routes() });
    const toPercent = await screen.findByLabelText('To (percent)');
    await user.type(toPercent, '50');
    expect(screen.getByLabelText('To (page)')).toHaveValue('152');
    await user.clear(toPercent);
    expect(screen.getByLabelText('To (page)')).toHaveValue('');
    await user.type(screen.getByLabelText('To (page)'), '140');
    const fromPage = screen.getByLabelText('From (page)');
    await user.clear(fromPage);
    await user.type(fromPage, 'x');
    expect(screen.getByLabelText('From (percent)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Start: Enter a number of zero or more',
    );
    await user.clear(fromPage);
    await user.type(fromPage, '120');
    expect(screen.getByLabelText('From (percent)')).toHaveValue('39.47');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sessions')[0]?.body).toMatchObject({
        progressUnit: 'pages',
        startValue: 120,
        endValue: 140,
      });
    });
  });

  it('rejects an end before the start', async () => {
    const { user } = renderApp({ hash: `#/log?book=${IDS.leGuin}`, routes: routes() });
    const ended = await screen.findByLabelText('Ended');
    await user.clear(ended);
    await user.type(ended, '2026-11-14T08:00');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The end must not be before the start.',
    );
  });

  it('picks a book when none is given and explains books without formats', async () => {
    const { user } = renderApp({
      hash: '#/log',
      routes: routes({ 'GET /api/books/:id': ok(piranesi({ formats: [] })) }),
    });
    await user.selectOptions(await screen.findByLabelText('Book'), IDS.piranesi);
    expect(await screen.findByText(/has no formats yet/)).toBeInTheDocument();
  });

  it('queues the session offline with the read it opens, and shows it from the cache', async () => {
    const { user, server, services } = renderApp({
      hash: `#/log?book=${IDS.piranesi}`,
      routes: routes(),
    });
    expect(await screen.findByLabelText('From (page)')).toHaveValue('0');
    expect(screen.getByLabelText('From (percent)')).toHaveValue('0');
    expect(screen.getByText(/length isn’t known/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('To (percent)'), '12');
    expect(screen.getByLabelText('To (page)')).toHaveValue('');
    server.offline = true;
    await user.click(screen.getByRole('button', { name: 'Save session' }));

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/books/${IDS.piranesi}`);
    });
    const ops = await services.outbox.list();
    expect(ops.map((op) => op.entity)).toEqual(['book', 'read', 'session']);
    expect(ops[0]?.payload).toMatchObject({ status: 'reading' });
    const cached = await services.cache.get(cacheKeys.book(IDS.piranesi), bookDetailSchema);
    expect(cached).toMatchObject({ status: 'reading', progressPercent: 12 });
    expect(await screen.findByText('12% read')).toBeInTheDocument();
  });
});
