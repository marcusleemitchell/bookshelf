import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SyncOp } from '../../shared/index.ts';
import { IDS, NOW, leGuin, makeNote } from './test/fixtures.ts';
import { renderApp } from './test/render.tsx';
import { ok, type MockRequest } from './test/server.ts';

const applyAll = (req: MockRequest) => ({
  body: {
    results: (req.body as { ops: SyncOp[] }).ops.map((op) => ({
      opId: op.opId,
      status: 'applied',
      duplicate: false,
    })),
  },
});

const noteOp = {
  entity: 'note' as const,
  action: 'upsert' as const,
  payload: {
    id: IDS.note,
    bookId: IDS.leGuin,
    kind: 'note',
    text: 'Offline thought',
    location: null,
  },
  label: 'Note: The Left Hand of Darkness',
};

describe('App shell', () => {
  it('navigates with the tab bar and marks the current tab', async () => {
    const { user } = renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.querySelector('[aria-current="page"]')).toHaveTextContent('Today');
    await user.click(within(nav).getByRole('link', { name: 'Library' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toHaveFocus();
    expect(nav.querySelector('[aria-current="page"]')).toHaveTextContent('Library');
    await user.click(within(nav).getByRole('link', { name: 'Stats' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Stats' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Calendar' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it('shows a not-found screen for unknown routes', async () => {
    renderApp({ hash: '#/shelves/42' });
    expect(await screen.findByText('There’s nothing at /shelves/42.')).toBeInTheDocument();
  });

  it('shows the offline banner with the pending count, then replays when the server is back', async () => {
    const { services, server } = renderApp({ routes: { 'POST /api/sync': applyAll } });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    server.offline = true;
    await act(async () => {
      await services.outbox.enqueue([noteOp]);
      await services.outbox.replay();
      services.connectivity.set(false);
    });
    expect(await screen.findByText('1 change waiting to sync.')).toBeInTheDocument();
    expect(screen.getByText(/Offline\./)).toBeInTheDocument();

    server.offline = false;
    act(() => {
      services.connectivity.set(true);
    });
    await waitFor(async () => {
      expect(await services.outbox.counts()).toEqual({ pending: 0, failed: 0 });
    });
    const [sync] = server.callsTo('POST', '/api/sync');
    expect((sync?.body as { ops: SyncOp[] }).ops[0]).toMatchObject({
      entity: 'note',
      clientUpdatedAt: NOW,
    });
    await waitFor(() => {
      expect(screen.queryByText(/waiting to sync/)).not.toBeInTheDocument();
    });
  });

  it('replays on the online event and when the app becomes visible', async () => {
    const { services, server } = renderApp({ routes: { 'POST /api/sync': applyAll } });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    await act(async () => {
      await services.outbox.enqueue([noteOp]);
    });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sync')).toHaveLength(1);
    });
    await act(async () => {
      await services.outbox.enqueue([{ ...noteOp, label: 'second' }]);
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sync')).toHaveLength(2);
    });
  });

  it('links failed changes to Settings from the banner', async () => {
    const { services, user } = renderApp({
      routes: {
        'POST /api/sync': (req) => ({
          body: {
            results: (req.body as { ops: SyncOp[] }).ops.map((op) => ({
              opId: op.opId,
              status: 'error',
              duplicate: false,
              error: { code: 'conflict', message: 'Duplicate' },
            })),
          },
        }),
        'GET /api/books/:id': ok(leGuin()),
        'GET /api/books/:id/notes': ok([makeNote()]),
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    await act(async () => {
      await services.outbox.enqueue([noteOp]);
      for (let i = 0; i < 3; i += 1) await services.outbox.replay();
    });
    await user.click(await screen.findByRole('link', { name: 'Review' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });
});
