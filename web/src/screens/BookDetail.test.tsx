import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { noteCreateSchema } from '../../../shared/index.ts';
import { IDS, hailMary, leGuin, makeFormat, makeNote, makeSession } from '../test/fixtures.ts';
import { defaultRoutes, renderApp } from '../test/render.tsx';
import { createMockServer, ok, type MockRequest, type RouteTable } from '../test/server.ts';

function bookRoutes(extra: RouteTable = {}): RouteTable {
  return {
    'GET /api/books/:id': ok(leGuin()),
    'GET /api/sessions': ok([
      makeSession(),
      makeSession({
        id: IDS.session2,
        startedAt: '2026-11-10T20:00:00.000Z',
        endedAt: '2026-11-10T20:30:00.000Z',
        startValue: 60,
        endValue: 90,
        startPercent: 19.74,
        endPercent: 29.61,
        note: null,
      }),
    ]),
    'GET /api/books/:id/notes': ok([makeNote()]),
    'PATCH /api/books/:id': (req: MockRequest) => ({ body: leGuin(req.body as object) }),
    ...extra,
  };
}

const hash = `#/books/${IDS.leGuin}`;

describe('Book detail', () => {
  it('shows the book, progress, chart summary, sessions, notes, tags, reads and metadata', async () => {
    renderApp({ hash, routes: bookRoutes() });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'The Left Hand of Darkness' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/finish by 29\/11\/2026 \(15 days\)/)).toBeInTheDocument();
    expect(
      await screen.findByText(
        /From 29.6% on 10\/11\/2026 to 40.1% on 13\/11\/2026, over 2 sessions/,
      ),
    ).toBeInTheDocument();
    const sessions = screen.getByRole('heading', { name: 'Sessions' }).parentElement;
    expect(sessions && within(sessions).getByText('13/11/2026')).toBeInTheDocument();
    expect(sessions && within(sessions).getByText('p. 90 → p. 122 (40.1%)')).toBeInTheDocument();
    expect(await screen.findByText('“Light is the left hand of darkness.”')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Science fiction' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('First read')).toBeInTheDocument();
    expect(screen.getByText('9780441478125')).toBeInTheDocument();
    expect(screen.getByText('Open Library')).toBeInTheDocument();
  });

  it('shows the publication date as DD/MM/YYYY and the language by name', async () => {
    renderApp({
      hash,
      routes: bookRoutes({
        'GET /api/books/:id': ok(leGuin({ publishedDate: '2019-09-03', language: 'eng' })),
      }),
    });
    const about = (await screen.findByRole('heading', { name: 'About' })).parentElement;
    expect(about && within(about).getByText('03/09/2019')).toBeInTheDocument();
    expect(about && within(about).getByText('English')).toBeInTheDocument();
  });

  it('changes status and rating through the API', async () => {
    const { user, server } = renderApp({ hash, routes: bookRoutes() });
    await user.selectOptions(await screen.findByLabelText('Shelf'), 'finished');
    await waitFor(() => {
      expect(server.callsTo('PATCH', `/api/books/${IDS.leGuin}`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Rating')).toBeEnabled();
    });
    await user.selectOptions(screen.getByLabelText('Rating'), '4');
    await waitFor(() => {
      expect(server.callsTo('PATCH', `/api/books/${IDS.leGuin}`).map((c) => c.body)).toEqual([
        { status: 'finished' },
        { rating: 4 },
      ]);
    });
  });

  it('queues a rating offline and shows it straight away', async () => {
    const { user, server, services } = renderApp({ hash, routes: bookRoutes() });
    await screen.findByLabelText('Rating');
    await screen.findByText('“Light is the left hand of darkness.”');
    server.offline = true;
    await user.selectOptions(screen.getByLabelText('Rating'), '3.5');
    expect(await screen.findByLabelText('Rated 3½ stars')).toBeInTheDocument();
    const ops = await services.outbox.list();
    expect(ops.map((o) => o.entity)).toEqual(['book']);
    expect(ops[0]?.payload).toMatchObject({ id: IDS.leGuin, rating: 3.5, status: 'reading' });
  });

  it('adds, edits and deletes notes, offline too', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, server, services } = renderApp({
      hash,
      routes: bookRoutes({
        'POST /api/books/:id/notes': (req) => ({
          status: 201,
          body: makeNote({ ...noteCreateSchema.parse(req.body), id: IDS.session2 }),
        }),
        'PATCH /api/books/:id/notes/:noteId': (req) => ({ body: makeNote(req.body as object) }),
        'DELETE /api/books/:id/notes/:noteId': () => ({ status: 204 }),
      }),
    });
    await user.click(await screen.findByText('Add a note or quote'));
    await user.type(
      screen.getByLabelText('Note', { selector: '#note-new-text' }),
      'Shifgrethor matters.',
    );
    await user.type(
      screen.getByLabelText('Location', { selector: '#note-new-location' }),
      'p. 120',
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(server.callsTo('POST', `/api/books/${IDS.leGuin}/notes`)[0]?.body).toEqual({
        id: '00000000-0000-4000-8000-0000000003e8',
        kind: 'note',
        text: 'Shifgrethor matters.',
        location: 'p. 120',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const text = screen.getByLabelText('Quote', { selector: `#note-${IDS.note}-text` });
    await user.clear(text);
    await user.type(
      text,
      'Light is the left hand of darkness, and darkness the right hand of light.',
    );
    await user.click(
      within(text.closest('form') ?? document.body).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => {
      expect(server.callsTo('PATCH', `/api/books/${IDS.leGuin}/notes/${IDS.note}`)).toHaveLength(1);
    });

    server.offline = true;
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(async () => {
      expect((await services.outbox.list()).map((o) => [o.entity, o.action])).toEqual([
        ['note', 'delete'],
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Light is the left hand/)).not.toBeInTheDocument();
    });
  });

  it('toggles tags, edits formats and deletes sessions online', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, server } = renderApp({
      hash,
      routes: bookRoutes({
        'PUT /api/books/:id/tags': (req) => ({ body: leGuin(req.body as object) }),
        'PATCH /api/books/:id/formats/:formatId': (req) => ({
          body: makeFormat({ id: IDS.leGuinPhysical, bookId: IDS.leGuin, ...(req.body as object) }),
        }),
        'POST /api/books/:id/formats': (req) => ({
          status: 201,
          body: makeFormat({ bookId: IDS.leGuin, ...(req.body as object) }),
        }),
        'DELETE /api/sessions/:id': () => ({ status: 204 }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Book club' }));
    await waitFor(() => {
      expect(server.callsTo('PUT', `/api/books/${IDS.leGuin}/tags`)[0]?.body).toEqual({
        tagIds: [IDS.tagSciFi, IDS.tagBookClub],
      });
    });

    const length = screen.getByLabelText('Physical page count');
    await user.clear(length);
    await user.type(length, 'many');
    await user.click(
      within(length.closest('form') ?? document.body).getByRole('button', { name: 'Save' }),
    );
    expect(
      await screen.findByText('The page count must be a whole number above zero.'),
    ).toBeInTheDocument();
    await user.clear(length);
    await user.type(length, '320');
    await user.click(
      within(length.closest('form') ?? document.body).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => {
      expect(
        server.callsTo('PATCH', `/api/books/${IDS.leGuin}/formats/${IDS.leGuinPhysical}`)[0]?.body,
      ).toEqual({
        pageCount: 320,
        audioDurationSeconds: null,
      });
    });

    await user.selectOptions(screen.getByLabelText('Format'), 'audiobook');
    await user.type(screen.getByLabelText('Length (h:mm:ss)'), '9:47:00');
    await user.click(screen.getByRole('button', { name: 'Add format' }));
    await waitFor(() => {
      expect(server.callsTo('POST', `/api/books/${IDS.leGuin}/formats`)[0]?.body).toMatchObject({
        format: 'audiobook',
        audioDurationSeconds: 35_220,
        pageCount: null,
      });
    });

    await user.click(screen.getByRole('button', { name: 'Delete session on 13/11/2026' }));
    await waitFor(() => {
      expect(server.callsTo('DELETE', `/api/sessions/${IDS.session1}`)).toHaveLength(1);
    });
  });

  it('starts a reread of a finished book', async () => {
    const { user, server } = renderApp({
      hash: `#/books/${IDS.hailMary}`,
      routes: bookRoutes({
        'GET /api/books/:id': ok(hailMary()),
        'GET /api/sessions': ok([]),
        'GET /api/books/:id/notes': ok([]),
        'POST /api/books/:id/reads': (req) => ({
          status: 201,
          body: {
            ...hailMary().reads[0],
            ...(req.body as object),
            number: 2,
            outcome: 'in_progress',
            finishedAt: null,
          },
        }),
      }),
    });
    expect(await screen.findByLabelText('Rated 4½ stars')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start a reread' }));
    await waitFor(() => {
      expect(server.callsTo('POST', `/api/books/${IDS.hailMary}/reads`)).toHaveLength(1);
    });
    expect(screen.getByText('No sessions yet.')).toBeInTheDocument();
  });

  it('starts the timer from the book and goes to Today', async () => {
    const { user, server } = renderApp({
      hash,
      routes: bookRoutes({
        'PUT /api/timer': (req) => ({
          body: {
            timer: null,
            elapsedSeconds: 0,
            serverTime: '2026-11-14T10:00:00.000Z',
            echo: req.body,
          },
        }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Start timer' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/');
    });
    expect(server.callsTo('PUT', '/api/timer')[0]?.body).toMatchObject({
      action: 'start',
      bookId: IDS.leGuin,
    });
  });

  it('deletes the book after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, server } = renderApp({
      hash,
      routes: bookRoutes({ 'DELETE /api/books/:id': () => ({ status: 204 }) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete book' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/library');
    });
    expect(server.callsTo('DELETE', `/api/books/${IDS.leGuin}`)).toHaveLength(1);
  });

  it('explains online-only edits made offline', async () => {
    const { user, server } = renderApp({ hash, routes: bookRoutes() });
    await screen.findByRole('button', { name: 'Book club' });
    server.offline = true;
    await user.click(screen.getByRole('button', { name: 'Book club' }));
    expect(await screen.findByText(/needs a connection to the server/)).toBeInTheDocument();
  });

  it('says when a book is not available offline', async () => {
    const server = createMockServer(defaultRoutes());
    server.offline = true;
    renderApp({ hash: '#/books/00000000-0000-4000-8000-000000009999', server });
    expect(await screen.findByText(/hasn’t been saved on this device/)).toBeInTheDocument();
  });
});
