import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { backupEnvelopeSchema, type NotionRunResult } from '../../../shared/index.ts';
import { readFileText } from '../lib/files.ts';
import {
  IDS,
  NOW,
  hailMary,
  leGuin,
  makeGoal,
  makeSession,
  notionStatus,
  tags,
} from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { apiError, ok, type MockRequest } from '../test/server.ts';

const envelope = backupEnvelopeSchema.parse({
  app: 'bookshelf',
  schemaVersion: 1,
  exportedAt: NOW,
  data: {
    books: [leGuin(), hailMary()],
    formats: [...leGuin().formats, ...hailMary().formats],
    reads: [...leGuin().reads, ...hailMary().reads],
    sessions: [makeSession()],
    tags: tags(),
    notes: [],
    goals: [makeGoal()],
    timer: null,
  },
});

const counts = {
  books: 2,
  formats: 2,
  reads: 2,
  sessions: 1,
  tags: 2,
  notes: 0,
  goals: 1,
  timer: 0,
};

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const parent = heading.closest('section');
  if (!parent) throw new Error(`No section for ${name}`);
  return parent;
}

describe('Settings', () => {
  it('updates an existing goal (200) and creates a new one (201)', async () => {
    const { user, server } = renderApp({
      hash: '#/settings',
      routes: {
        'PUT /api/goals/:id': (req: MockRequest) => ({
          status: req.params['id'] === IDS.goalMinutes ? 200 : 201,
          body: makeGoal({ id: req.params['id'] ?? '', ...(req.body as object), current: 0 }),
        }),
      },
    });
    const minutes = await screen.findByLabelText('Minutes a day');
    expect(minutes).toHaveValue(30);
    await user.clear(minutes);
    await user.type(minutes, '45');
    await user.click(
      within(minutes.closest('form') ?? document.body).getByRole('button', { name: 'Save' }),
    );
    expect(await screen.findByText('Goal updated.')).toBeInTheDocument();

    const books = screen.getByLabelText('Books in 2026');
    await user.type(books, '24');
    await user.click(
      within(books.closest('form') ?? document.body).getByRole('button', { name: 'Save' }),
    );
    expect(await screen.findByText('Goal set.')).toBeInTheDocument();
    expect(server.callsTo('PUT', `/api/goals/${IDS.goalMinutes}`)[0]?.body).toEqual({
      kind: 'minutes_per_day',
      year: null,
      target: 45,
    });
    expect(server.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContainEqual({
      kind: 'books_per_year',
      year: 2026,
      target: 24,
    });
  });

  it('removes a goal', async () => {
    const { user, server } = renderApp({
      hash: '#/settings',
      routes: { 'DELETE /api/goals/:id': () => ({ status: 204 }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(server.callsTo('DELETE', `/api/goals/${IDS.goalMinutes}`)).toHaveLength(1);
    });
  });

  it('adds, renames and deletes tags', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, server } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/tags': (req) => ({
          status: 201,
          body: { ...tags()[0], ...(req.body as object) },
        }),
        'PATCH /api/tags/:id': (req) => ({ body: { ...tags()[0], ...(req.body as object) } }),
        'DELETE /api/tags/:id': () => ({ status: 204 }),
      },
    });
    await user.type(await screen.findByLabelText('Tag name'), 'Comfort reads');
    await user.click(within(section('Tags')).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/tags')[0]?.body).toMatchObject({
        name: 'Comfort reads',
        colour: '#2f5d50',
      });
    });
    const name = screen.getByLabelText('Name of tag Book club');
    await user.clear(name);
    await user.type(name, 'Book group');
    await user.click(
      within(name.closest('form') ?? document.body).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => {
      expect(server.callsTo('PATCH', `/api/tags/${IDS.tagBookClub}`)[0]?.body).toEqual({
        name: 'Book group',
        colour: '#8a6421',
      });
    });
    await user.click(
      within(name.closest('form') ?? document.body).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => {
      expect(server.callsTo('DELETE', `/api/tags/${IDS.tagBookClub}`)).toHaveLength(1);
    });
  });

  it('shows tag errors such as duplicate names', async () => {
    const { user } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/tags': () => apiError(409, 'conflict', 'A tag named "Book club" already exists'),
      },
    });
    await user.type(await screen.findByLabelText('Tag name'), 'Book club');
    await user.click(within(section('Tags')).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('A tag named "Book club" already exists')).toBeInTheDocument();
  });

  it('exports a backup file', async () => {
    const createObjectURL = vi.fn((_file: Blob) => 'blob:backup');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { user } = renderApp({
      hash: '#/settings',
      routes: { 'GET /api/backup/export': ok(envelope) },
    });
    await user.click(await screen.findByRole('button', { name: 'Export backup (JSON)' }));
    expect(
      await screen.findByText(
        'Exported 2 books, 1 session and 0 notes as bookshelf-backup-2026-11-14.json.',
      ),
    ).toBeInTheDocument();
    const file = createObjectURL.mock.calls[0]?.[0] as File;
    expect(file.name).toBe('bookshelf-backup-2026-11-14.json');
    expect(
      backupEnvelopeSchema.parse(JSON.parse(await readFileText(file))).data.books,
    ).toHaveLength(2);
  });

  it('imports a backup after confirmation and rejects other files', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, server } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/backup/import': ok({
          imported: counts,
          snapshot: 'bookshelf-pre-import-2026-11-14T10-00-00.json',
        }),
      },
    });
    const input = await screen.findByLabelText('Restore from a backup file');
    await user.upload(input, new File(['not json'], 'notes.txt', { type: 'application/json' }));
    expect(await screen.findByText('That file isn’t valid JSON.')).toBeInTheDocument();
    await user.upload(
      input,
      new File(['{"app":"other"}'], 'other.json', { type: 'application/json' }),
    );
    expect(await screen.findByText('That file isn’t a Bookshelf backup.')).toBeInTheDocument();

    await user.upload(
      input,
      new File([JSON.stringify(envelope)], 'backup.json', { type: 'application/json' }),
    );
    expect(
      await screen.findByText(
        /Restored 2 books, 1 session and 0 notes\. Safety snapshot: bookshelf-pre-import/,
      ),
    ).toBeInTheDocument();
    expect(confirm.mock.calls[0]?.[0]).toContain(
      'from 14/11/2026 (2 books, 1 session and 0 notes)',
    );
    expect(
      backupEnvelopeSchema.parse(server.callsTo('POST', '/api/backup/import')[0]?.body).data
        .sessions,
    ).toHaveLength(1);
  });

  it('runs a Notion sync with a progress state', async () => {
    let finish: (result: NotionRunResult) => void = () => undefined;
    const result: NotionRunResult = {
      books: { created: 1, updated: 2, archived: 0, unchanged: 5 },
      sessions: { created: 3, updated: 0, archived: 1, unchanged: 40 },
      notes: { created: 0, updated: 0, archived: 0, unchanged: 2 },
      startedAt: NOW,
      finishedAt: NOW,
    };
    const { user } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/backup/notion': () =>
          new Promise((resolve) => {
            finish = (body) => {
              resolve({ body });
            };
          }),
      },
    });
    expect(await screen.findByText('Last synced 13/11/2026.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sync to Notion now' }));
    const busy = await screen.findByRole('button', { name: 'Syncing to Notion…' });
    expect(busy).toBeDisabled();
    expect(screen.getByText(/can take a few minutes/)).toBeInTheDocument();
    finish(result);
    expect(
      await screen.findByText(/Done\. Books: 1 new, 2 updated, 0 archived, 5 unchanged/),
    ).toBeInTheDocument();
  });

  it('explains Notion errors and an unconfigured mirror', async () => {
    const { user } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/backup/notion': () =>
          apiError(409, 'notion_busy', 'A Notion sync is already running'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sync to Notion now' }));
    expect(await screen.findByText('A Notion sync is already running')).toBeInTheDocument();
  });

  it('tells when Notion is not configured', async () => {
    renderApp({
      hash: '#/settings',
      routes: { 'GET /api/backup/notion/status': ok({ ...notionStatus, configured: false }) },
    });
    expect(await screen.findByText(/Notion isn’t set up/)).toBeInTheDocument();
  });

  it('shows server status', async () => {
    renderApp({ hash: '#/settings' });
    const server = section('Server');
    expect(await within(server).findByText('Connected.')).toBeInTheDocument();
    expect(within(server).getByText('0.1.0')).toBeInTheDocument();
  });

  it('lists queued changes, syncs them and lets failed ones be retried or discarded', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, services, server } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/sync': (req) => ({
          body: {
            results: (req.body as { ops: { opId: string }[] }).ops.map((op) => ({
              opId: op.opId,
              status: 'error',
              duplicate: false,
              error: { code: 'validation_error', message: 'Invalid payload: title' },
            })),
          },
        }),
      },
    });
    await services.outbox.enqueue([
      { entity: 'book', action: 'upsert', payload: { id: IDS.leGuin }, label: 'Book: Broken' },
    ]);
    expect(await within(section('Offline changes')).findByText('Book: Broken')).toBeInTheDocument();
    for (let i = 0; i < 3; i += 1) {
      await user.click(await screen.findByRole('button', { name: 'Sync now' }));
      await waitFor(() => {
        expect(server.callsTo('POST', '/api/sync')).toHaveLength(i + 1);
      });
    }
    expect(await screen.findByText('1 change couldn’t sync')).toBeInTheDocument();
    expect(screen.getByText('Invalid payload: title')).toBeInTheDocument();
    expect(screen.getByText(/couldn’t sync\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 change waiting to sync')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Everything is synced.')).toBeInTheDocument();
  });
});
