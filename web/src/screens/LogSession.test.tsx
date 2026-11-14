import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bookDetailSchema } from '../../../shared/index.ts';
import { cacheKeys } from '../offline/cache.ts';
import { IDS, NOW, hailMary, leGuin, makeRead, makeSession, piranesi } from '../test/fixtures.ts';
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
    expect(screen.getByLabelText('Reading time (minutes)')).toHaveValue(30);
    await user.type(screen.getByLabelText('To (page)'), '152');
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

  it('switches to percent, converting the values', async () => {
    const { user, server } = renderApp({ hash: `#/log?book=${IDS.leGuin}`, routes: routes() });
    await user.type(await screen.findByLabelText('To (page)'), '152');
    await user.click(screen.getByRole('button', { name: '%' }));
    expect(screen.getByLabelText('From (percent)')).toHaveValue('40.13');
    expect(screen.getByLabelText('To (percent)')).toHaveValue('50');
    await user.clear(screen.getByLabelText('To (percent)'));
    await user.type(screen.getByLabelText('To (percent)'), '55');
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
    expect(await screen.findByLabelText('From (position (h:mm:ss))')).toHaveValue('8:05:18');
    await user.type(screen.getByLabelText('To (position (h:mm:ss))'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('End: Use h:mm:ss');

    await user.clear(screen.getByLabelText('To (position (h:mm:ss))'));
    await user.type(screen.getByLabelText('To (position (h:mm:ss))'), '9:00:00');
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
    expect(screen.getByText(/length isn’t known/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '%' }));
    await user.type(screen.getByLabelText('To (percent)'), '12');
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
