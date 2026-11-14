import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { bookCreateSchema } from '../../../shared/index.ts';
import { ServicesContext } from '../app/hooks.ts';
import type { ScannerDeps } from '../components/BarcodeScanner.tsx';
import { candidate, library, piranesi } from '../test/fixtures.ts';
import { createTestServices, renderApp } from '../test/render.tsx';
import { apiError, createMockServer, ok, type MockRequest } from '../test/server.ts';
import { AddBook } from './AddBook.tsx';

const createdRoutes = {
  'POST /api/books': (req: MockRequest) => {
    const body = bookCreateSchema.parse(req.body);
    return { status: 201, body: piranesi({ id: body.id ?? piranesi().id, title: body.title }) };
  },
  'GET /api/books/:id': ok(piranesi()),
  'GET /api/sessions': ok([]),
  'GET /api/books/:id/notes': ok([]),
};

describe('Add book', () => {
  it('adds a book by ISBN: look up, confirm formats, create', async () => {
    const { user, server } = renderApp({
      hash: '#/add',
      routes: {
        'GET /api/books': ok(library().filter((b) => b.title !== 'Piranesi')),
        'GET /api/lookup/isbn/:isbn': ok(candidate()),
        ...createdRoutes,
      },
    });
    await user.click(screen.getByRole('tab', { name: 'ISBN' }));
    await user.type(screen.getByLabelText('ISBN'), '978-1-5266-2242-6');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByRole('heading', { name: 'Confirm book' })).toBeInTheDocument();
    expect(server.calls.find((c) => c.path.startsWith('/api/lookup'))?.path).toBe(
      '/api/lookup/isbn/9781526622426',
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Piranesi');
    expect(screen.getByLabelText('Page count')).toHaveValue('272');
    await user.click(screen.getByLabelText('Kindle'));
    await user.click(screen.getByRole('button', { name: 'Add to library' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/books/00000000-0000-4000-8000-0000000003e8');
    });
    expect(server.callsTo('POST', '/api/books')[0]?.body).toMatchObject({
      id: '00000000-0000-4000-8000-0000000003e8',
      title: 'Piranesi',
      authors: ['Susanna Clarke'],
      isbn13: '9781526622426',
      isbn10: '1526622424',
      source: 'openlibrary',
      sourceId: 'OL20893680W',
      coverUrl: 'https://covers.openlibrary.org/b/id/10521270-L.jpg',
      status: 'to_read',
      formats: [
        { format: 'physical', pageCount: 272, audioDurationSeconds: null },
        { format: 'kindle', pageCount: null, audioDurationSeconds: null },
      ],
    });
  });

  it('validates the ISBN and offers manual entry when nothing is found', async () => {
    const { user } = renderApp({
      hash: '#/add',
      routes: { 'GET /api/lookup/isbn/:isbn': () => apiError(404, 'not_found', 'No book') },
    });
    await user.click(screen.getByRole('tab', { name: 'ISBN' }));
    await user.type(screen.getByLabelText('ISBN'), '9781526622427');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('isn’t a valid ISBN');

    await user.clear(screen.getByLabelText('ISBN'));
    await user.type(screen.getByLabelText('ISBN'), '0441478123');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/No book found for ISBN 9780441478125/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    expect(await screen.findByLabelText('ISBN')).toHaveValue('9780441478125');
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });

  it('reports upstream failures', async () => {
    const { user } = renderApp({
      hash: '#/add',
      routes: {
        'GET /api/lookup/isbn/:isbn': () => apiError(502, 'upstream_error', 'Open Library down'),
      },
    });
    await user.click(screen.getByRole('tab', { name: 'ISBN' }));
    await user.type(screen.getByLabelText('ISBN'), '9781526622426');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/book services couldn’t be reached/)).toBeInTheDocument();
  });

  it('searches by title and pages through results', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) =>
      candidate({ sourceId: `OL${String(i)}W`, title: `Piranesi ${String(i)}`, coverUrl: null }),
    );
    const { user, server } = renderApp({
      hash: '#/add',
      routes: {
        'GET /api/lookup/search': (req) => ({
          body:
            req.query.get('page') === '1'
              ? page1
              : [candidate({ sourceId: 'OLlastW', title: 'Last one' })],
        }),
      },
    });
    await user.click(screen.getByRole('tab', { name: 'Search' }));
    await user.type(screen.getByLabelText('Title or author'), 'piranesi clarke');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Piranesi 19')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More results' }));
    expect(await screen.findByText('Last one')).toBeInTheDocument();
    expect(server.callsTo('GET', '/api/lookup/search').map((c) => c.query.get('page'))).toEqual([
      '1',
      '2',
    ]);
    await user.click(screen.getByRole('button', { name: 'Choose Last one' }));
    expect(await screen.findByLabelText('Title')).toHaveValue('Last one');
  });

  it('says when a search finds nothing', async () => {
    const { user } = renderApp({ hash: '#/add', routes: { 'GET /api/lookup/search': ok([]) } });
    await user.click(screen.getByRole('tab', { name: 'Search' }));
    await user.type(screen.getByLabelText('Title or author'), 'zzzz');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nothing found for “zzzz”/)).toBeInTheDocument();
  });

  it('adds a book manually with an audiobook length, validating input', async () => {
    const { user, server } = renderApp({ hash: '#/add', routes: createdRoutes });
    await user.click(screen.getByRole('tab', { name: 'Manual' }));
    await user.click(screen.getByRole('button', { name: 'Start manual entry' }));
    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a title.');

    await user.type(screen.getByLabelText('Title'), 'The Dispossessed');
    await user.type(screen.getByLabelText('Authors'), 'Ursula K. Le Guin, ');
    await user.click(screen.getByLabelText('Physical'));
    await user.click(screen.getByLabelText('Audiobook'));
    await user.type(screen.getByLabelText('Length (h:mm:ss)'), 'long');
    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Audiobook length must be h:mm:ss');
    await user.clear(screen.getByLabelText('Length (h:mm:ss)'));
    await user.type(screen.getByLabelText('Length (h:mm:ss)'), '11:05:00');
    await user.selectOptions(screen.getByLabelText('Shelf'), 'reading');
    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/books')).toHaveLength(1);
    });
    expect(server.callsTo('POST', '/api/books')[0]?.body).toMatchObject({
      title: 'The Dispossessed',
      authors: ['Ursula K. Le Guin'],
      source: 'manual',
      status: 'reading',
      isbn13: null,
      formats: [{ format: 'audiobook', audioDurationSeconds: 39_900, pageCount: null }],
    });
  });

  it('warns about a duplicate ISBN already in the library', async () => {
    const { user } = renderApp({
      hash: '#/add',
      routes: { 'GET /api/lookup/isbn/:isbn': ok(candidate()) },
    });
    await user.click(screen.getByRole('tab', { name: 'ISBN' }));
    await user.type(screen.getByLabelText('ISBN'), '9781526622426');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/already in your library/)).toBeInTheDocument();
  });

  it('needs a connection for lookups', async () => {
    const { user, server } = renderApp({ hash: '#/add' });
    server.offline = true;
    await user.click(screen.getByRole('tab', { name: 'ISBN' }));
    await user.type(screen.getByLabelText('ISBN'), '9781526622426');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/Looking up books needs a connection/)).toBeInTheDocument();
    // Once the server is known to be unreachable, the search tab says so up front.
    await user.click(screen.getByRole('tab', { name: 'Search' }));
    expect(screen.getByText(/Looking up books needs a connection/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Title or author')).not.toBeInTheDocument();
  });

  it('looks up a scanned barcode', async () => {
    const server = createMockServer({
      'GET /api/lookup/isbn/:isbn': ok(candidate()),
      'GET /api/books': ok([]),
    });
    const { services } = createTestServices({ server });
    const track = { stop: () => undefined };
    const deps: ScannerDeps = {
      isSecureContext: () => true,
      getUserMedia: () => Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream),
      loadDecoder: () => Promise.resolve(() => Promise.resolve(['9781526622426'])),
      captureFrame: () => ({}) as ImageData,
    };
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(
      <ServicesContext value={services}>
        <AddBook scannerDeps={deps} />
      </ServicesContext>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('heading', { name: 'Confirm book' })).toBeInTheDocument();
    expect(screen.getByLabelText('ISBN')).toHaveValue('9781526622426');
  });
});
