import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  backupEnvelopeSchema,
  tagListSchema,
  type NotionRunResult,
} from '../../../shared/index.ts';
import { cacheKeys } from '../offline/cache.ts';
import { readFileText } from '../lib/files.ts';
import {
  IDS,
  NOW,
  authState,
  owner,
  hailMary,
  leGuin,
  makeGoal,
  bookpineReport,
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
  it('shows who is signed in and changes the PIN', async () => {
    const { user, server, services } = renderApp({
      hash: '#/settings',
      routes: {
        'PUT /api/auth/pin': (req) =>
          (req.body as { currentPin: string }).currentPin === '2468'
            ? { status: 204 }
            : apiError(401, 'unauthorised', 'Wrong PIN'),
      },
    });
    const profile = await screen.findByRole('heading', { name: 'Profile' });
    expect(profile.closest('section')).toHaveTextContent('Signed in as Alex · Parent');
    const panel = within(section('Profile'));
    const change = panel.getByRole('button', { name: 'Change PIN' });

    await user.type(panel.getByLabelText('Current PIN'), '2468');
    await user.type(panel.getByLabelText('New PIN'), '135');
    await user.type(panel.getByLabelText('Confirm new PIN'), '135');
    await user.click(change);
    expect(panel.getByRole('alert')).toHaveTextContent('A PIN is 4 to 8 digits.');
    await user.type(panel.getByLabelText('New PIN'), '7');
    await user.type(panel.getByLabelText('Confirm new PIN'), '8');
    await user.click(change);
    expect(panel.getByRole('alert')).toHaveTextContent('The two PINs don’t match.');
    expect(server.callsTo('PUT', '/api/auth/pin')).toHaveLength(0);

    // A wrong current PIN is an error on the form, not the end of the session.
    await user.clear(panel.getByLabelText('Current PIN'));
    await user.type(panel.getByLabelText('Current PIN'), '1111');
    await user.clear(panel.getByLabelText('Confirm new PIN'));
    await user.type(panel.getByLabelText('Confirm new PIN'), '1357');
    await user.click(change);
    expect(await panel.findByText('Wrong PIN')).toBeInTheDocument();
    expect(services.auth.get().status).toBe('signedIn');

    await user.clear(panel.getByLabelText('Current PIN'));
    await user.type(panel.getByLabelText('Current PIN'), '2468');
    await user.click(change);
    expect(
      await screen.findByText('PIN changed. Other devices have been signed out.'),
    ).toBeInTheDocument();
    expect(server.callsTo('PUT', '/api/auth/pin').at(-1)?.body).toEqual({
      currentPin: '2468',
      newPin: '1357',
    });
    expect(panel.getByLabelText('Current PIN')).toHaveValue('');
  });

  it('signs out, forgetting cached data but keeping queued changes', async () => {
    let signedIn = true;
    const { user, server, services } = renderApp({
      hash: '#/settings',
      routes: {
        'GET /api/auth/state': () => ({
          body: signedIn ? authState() : authState({ members: [owner], me: null }),
        }),
        'POST /api/auth/sign-out': () => {
          signedIn = false;
          return { status: 204 };
        },
      },
    });
    expect(await screen.findByLabelText('Name of tag Book club')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await services.cache.get(cacheKeys.tags, tagListSchema)).toHaveLength(2);
    });
    await services.outbox.enqueue([
      { entity: 'note', action: 'delete', payload: { id: IDS.note }, label: 'Note' },
    ]);
    expect(
      await screen.findByText('1 change waiting to sync will be sent after the next sign-in.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Hello, Alex' })).toBeVisible();
    expect(server.callsTo('POST', '/api/auth/sign-out')).toHaveLength(1);
    expect(await services.cache.get(cacheKeys.tags, tagListSchema)).toBeUndefined();
    expect(await services.outbox.counts()).toEqual({ pending: 1, failed: 0 });
  });

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

  it('previews a Bookpine export, then imports it after confirmation', async () => {
    const csv = 'slug,title\nx,"A, B"\n';
    let finish: (reply: { body: unknown }) => void = () => undefined;
    const { user, server } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/import/bookpine/preview': ok(bookpineReport()),
        'POST /api/import/bookpine': () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    const input = await screen.findByLabelText('Bookpine export (CSV)');
    await user.upload(input, new File([csv], 'export.csv', { type: 'text/csv' }));
    const preview = await screen.findByRole('group', { name: 'Import preview' });
    expect(server.callsTo('POST', '/api/import/bookpine/preview')[0]?.body).toBe(csv);
    expect(
      within(preview).getByText('20 rows in the export, with 1 book in several editions merged.'),
    ).toBeInTheDocument();
    expect(
      within(preview).getByText(
        'Books: 15 to add, 0 to update, 0 unchanged · 1 linked to books already in your library',
      ),
    ).toBeInTheDocument();
    expect(
      within(preview).getByText(
        'Reading days (sessions): 29 to add, 0 to update, 0 unchanged · 29 with time unknown',
      ),
    ).toBeInTheDocument();
    expect(within(preview).getByText('New tags: favorites, owned')).toBeInTheDocument();
    expect(
      within(preview).getByText('Covers and details will be looked up for 40 books (about 2 min)'),
    ).toBeInTheDocument();
    expect(within(preview).getByText('Orchard at Dusk (2 editions)')).toBeInTheDocument();
    expect(within(preview).getByText('Warnings (2)')).toBeInTheDocument();
    expect(within(preview).getByText('copper-and-thyme-1019')).toBeInTheDocument();
    expect(server.callsTo('POST', '/api/import/bookpine')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Importing — looking up covers/)).toBeInTheDocument();
    expect(server.callsTo('POST', '/api/import/bookpine')[0]?.body).toBe(csv);
    finish({
      body: bookpineReport({
        dryRun: false,
        books: { created: 0, updated: 2, unchanged: 13, skipped: 1, matched: 0 },
        keptEdits: 3,
        enrichment: { pending: 0, found: 30, notFound: 8, failed: 2 },
        covers: { cached: 28, failed: 2 },
        warnings: [],
        merges: [],
        tags: { created: 0, names: [] },
        snapshot: 'bookshelf-pre-import-2026-11-14T10-00-00-000Z.json',
      }),
    });
    const result = await screen.findByRole('group', { name: 'Import result' });
    expect(
      within(result).getByText(
        'Books: 0 added, 2 updated, 13 unchanged, 1 skipped (deleted in Bookshelf)',
      ),
    ).toBeInTheDocument();
    expect(
      within(result).getByText('3 fields you changed in Bookshelf kept as they are'),
    ).toBeInTheDocument();
    expect(within(result).getByText('No new tags')).toBeInTheDocument();
    expect(
      within(result).getByText('Looked up: 30 found, 8 not found, 2 failed · 28 covers saved'),
    ).toBeInTheDocument();
    expect(
      within(result).getByText(
        'Safety snapshot: bookshelf-pre-import-2026-11-14T10-00-00-000Z.json',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('lets a Bookpine preview be cancelled and shows preview errors', async () => {
    const { user, server } = renderApp({
      hash: '#/settings',
      routes: {
        'POST /api/import/bookpine/preview': ok(
          bookpineReport({
            merges: [],
            warnings: [],
            enrichment: { pending: 0, found: 0, notFound: 0, failed: 0 },
          }),
        ),
      },
    });
    const input = await screen.findByLabelText('Bookpine export (CSV)');
    await user.upload(input, new File(['x'], 'export.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('group', { name: 'Import preview' })).toBeInTheDocument();
    expect(screen.queryByText(/will be looked up/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Import preview' })).not.toBeInTheDocument();

    server.on('POST /api/import/bookpine/preview', () =>
      apiError(400, 'validation_error', 'This is not a Bookpine export: missing column slug'),
    );
    await user.upload(input, new File(['title\nDune\n'], 'other.csv', { type: 'text/csv' }));
    expect(
      await screen.findByText('This is not a Bookpine export: missing column slug'),
    ).toBeInTheDocument();
  });

  it('says when the picked Bookpine file cannot be read', async () => {
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('error'));
    });
    const { user, server } = renderApp({ hash: '#/settings' });
    await user.upload(
      await screen.findByLabelText('Bookpine export (CSV)'),
      new File(['x'], 'export.csv', { type: 'text/csv' }),
    );
    expect(await screen.findByText('That file couldn’t be read.')).toBeInTheDocument();
    expect(server.callsTo('POST', '/api/import/bookpine/preview')).toHaveLength(0);
    vi.restoreAllMocks();
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
