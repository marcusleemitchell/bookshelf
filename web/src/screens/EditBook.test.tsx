import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bookUpdateSchema } from '../../../shared/index.ts';
import { IDS, alternatives, authState, leGuin, owner } from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { apiError, ok, type MockRequest, type RouteTable } from '../test/server.ts';
import { buildPatch, draftFrom, foundText } from './EditBook.tsx';

const child = { ...owner, role: 'child' as const, isAdmin: false };
const editHash = `#/books/${IDS.leGuin}/edit`;
const bookPath = `/api/books/${IDS.leGuin}`;

/** Routes for the book screens; the book remembers saved changes like the server. */
function editRoutes(extra: RouteTable = {}): RouteTable {
  let book = leGuin();
  return {
    'GET /api/books/:id': () => ({ body: book }),
    'GET /api/books/:id/alternatives': ok(alternatives()),
    'PATCH /api/books/:id': (req: MockRequest) => {
      book = leGuin({ ...(req.body as object), updatedAt: '2026-11-14T10:05:00.000Z' });
      return { body: book };
    },
    'GET /api/sessions': ok([]),
    'GET /api/books/:id/notes': ok([]),
    ...extra,
  };
}

async function findForm() {
  return screen.findByRole('textbox', { name: 'Title' });
}

describe('Edit details', () => {
  it('is offered on the book for parents and admins, and opens the edit screen', async () => {
    const { user } = renderApp({ hash: `#/books/${IDS.leGuin}`, routes: editRoutes() });
    const link = await screen.findByRole('link', { name: 'Edit details' });
    expect(link).toHaveAttribute('href', `#/books/${IDS.leGuin}/edit`);
    await user.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit details' })).toBeVisible();
    expect(await findForm()).toHaveValue('The Left Hand of Darkness');
  });

  it('is not offered to a child, and the edit screen says to ask a parent', async () => {
    const routes = editRoutes({ 'GET /api/auth/state': ok(authState({ me: child })) });
    const first = renderApp({ hash: `#/books/${IDS.leGuin}`, routes });
    expect(await screen.findByRole('heading', { name: 'About' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Edit details' })).not.toBeInTheDocument();
    first.unmount();

    const { server } = renderApp({ hash: editHash, routes });
    expect(
      await screen.findByText('Ask a parent to change the details of a book.'),
    ).toBeInTheDocument();
    expect(server.callsTo('GET', bookPath)).toHaveLength(0);
  });

  it('says editing needs the server when it cannot tell who is signed in', async () => {
    renderApp({
      hash: editHash,
      routes: editRoutes({ 'GET /api/auth/state': () => ({ status: 502, body: 'Bad gateway' }) }),
    });
    expect(
      await screen.findByText('Changing the details of a book needs a connection to the server.'),
    ).toBeInTheDocument();
  });

  it('prefills the details and goes back without saving when nothing changed', async () => {
    const { user, server } = renderApp({ hash: editHash, routes: editRoutes() });
    await findForm();
    expect(screen.getByRole('textbox', { name: 'Authors' })).toHaveValue('Ursula K. Le Guin');
    expect(screen.getByRole('textbox', { name: 'ISBN' })).toHaveValue('9780441478125');
    expect(screen.getByRole('textbox', { name: 'Synopsis' })).toHaveValue(
      'A lone human emissary is sent to Winter, an alien world.',
    );
    expect(screen.getByRole('textbox', { name: 'Cover image address' })).toHaveValue(
      'https://covers.openlibrary.org/b/id/8231856-L.jpg',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/books/${IDS.leGuin}`);
    });
    expect(server.callsTo('PATCH', bookPath)).toHaveLength(0);
  });

  it('finds covers and synopses, and saves the chosen ones', async () => {
    const { user, server } = renderApp({ hash: editHash, routes: editRoutes() });
    await findForm();
    await user.click(screen.getByRole('button', { name: 'Find covers and synopses' }));
    expect(await screen.findByText('Found 2 covers and 2 synopses.')).toBeInTheDocument();
    expect(server.callsTo('GET', `${bookPath}/alternatives`)).toHaveLength(1);

    const covers = within(screen.getByRole('list', { name: 'Covers found' }));
    const current = covers.getByRole('button', { name: 'Cover 1: This edition' });
    expect(current).toHaveAttribute('aria-pressed', 'true');
    await user.click(covers.getByRole('button', { name: 'Cover 2: Open Library' }));
    expect(covers.getByRole('button', { name: 'Cover 2: Open Library' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(current).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('textbox', { name: 'Cover image address' })).toHaveValue(
      'https://covers.openlibrary.org/b/id/12882637-L.jpg',
    );
    // The preview shows the chosen cover's smaller image.
    const coverSection = screen.getByRole('heading', { name: 'Cover' }).parentElement;
    expect(coverSection?.querySelector('.book-hero img')).toHaveAttribute(
      'src',
      'https://covers.openlibrary.org/b/id/12882637-M.jpg',
    );

    await user.click(
      screen.getByRole('button', { name: 'Use this synopsis (Google Books · Ace, 2000)' }),
    );
    expect(screen.getByRole('textbox', { name: 'Synopsis' })).toHaveValue(
      'Genly Ai is sent to the planet Gethen to persuade it to join the Ekumen.',
    );
    expect(
      screen.getByRole('button', { name: 'In use (Google Books · Ace, 2000)' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/books/${IDS.leGuin}`);
    });
    const [patch] = server.callsTo('PATCH', bookPath);
    expect(bookUpdateSchema.parse(patch?.body)).toEqual({
      coverUrl: 'https://covers.openlibrary.org/b/id/12882637-L.jpg',
      synopsis: 'Genly Ai is sent to the planet Gethen to persuade it to join the Ekumen.',
    });
    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Genly Ai is sent to the planet Gethen to persuade it to join the Ekumen.',
      ),
    ).toBeInTheDocument();
  });

  it('says which sources could not be reached, and when nothing was found', async () => {
    const { user } = renderApp({
      hash: editHash,
      routes: editRoutes({
        'GET /api/books/:id/alternatives': ok(
          alternatives({ covers: [], synopses: [], unavailable: ['googlebooks'] }),
        ),
      }),
    });
    await findForm();
    await user.click(screen.getByRole('button', { name: 'Find covers and synopses' }));
    expect(
      await screen.findByText(
        'No covers or synopses found. Google Books couldn’t be reached, so some may be missing.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Covers found' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Look again' })).toBeEnabled();
  });

  it('shows a lookup failure without losing the form', async () => {
    const { user } = renderApp({
      hash: editHash,
      routes: editRoutes({
        'GET /api/books/:id/alternatives': () =>
          apiError(502, 'upstream_error', 'Book lookup services are unavailable; try again later'),
      }),
    });
    await user.type(await findForm(), ' (draft)');
    await user.click(screen.getByRole('button', { name: 'Find covers and synopses' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Book lookup services are unavailable; try again later',
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'The Left Hand of Darkness (draft)',
    );
  });

  it('saves only the changed details, a pasted cover and a removed one', async () => {
    const { user, server } = renderApp({ hash: editHash, routes: editRoutes() });
    const title = await findForm();
    await user.clear(title);
    await user.type(title, 'The Left Hand of Darkness: 50th Anniversary Edition');
    await user.clear(screen.getByRole('textbox', { name: 'ISBN' }));
    await user.type(screen.getByRole('textbox', { name: 'ISBN' }), '0-441-47812-3');
    await user.type(screen.getByRole('textbox', { name: 'Authors' }), ', Charlie Jane Anders');
    await user.type(screen.getByRole('textbox', { name: 'Genres' }), ', Classics');
    await user.clear(screen.getByRole('textbox', { name: 'Publisher' }));
    const cover = screen.getByRole('textbox', { name: 'Cover image address' });
    await user.clear(cover);
    await user.type(cover, 'https://images.example.org/lefthand.jpg');
    const coverSection = screen.getByRole('heading', { name: 'Cover' }).parentElement;
    expect(coverSection?.querySelector('.book-hero img')).toHaveAttribute(
      'src',
      'https://images.example.org/lefthand.jpg',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(server.callsTo('PATCH', bookPath)).toHaveLength(1);
    });
    expect(server.callsTo('PATCH', bookPath)[0]?.body).toEqual({
      title: 'The Left Hand of Darkness: 50th Anniversary Edition',
      publisher: null,
      authors: ['Ursula K. Le Guin', 'Charlie Jane Anders'],
      genres: ['Science fiction', 'Classics'],
      isbn13: '9780441478125',
      isbn10: '0441478123',
      coverUrl: 'https://images.example.org/lefthand.jpg',
    });
  });

  it('explains what to fix instead of saving', async () => {
    const { user, server } = renderApp({ hash: editHash, routes: editRoutes() });
    const title = await findForm();
    const save = screen.getByRole('button', { name: 'Save' });

    await user.clear(title);
    await user.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a title.');

    await user.type(title, 'The Left Hand of Darkness');
    await user.clear(screen.getByRole('textbox', { name: 'ISBN' }));
    await user.type(screen.getByRole('textbox', { name: 'ISBN' }), '12345');
    await user.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent('That isn’t a valid ISBN-10 or ISBN-13.');

    await user.clear(screen.getByRole('textbox', { name: 'ISBN' }));
    const cover = screen.getByRole('textbox', { name: 'Cover image address' });
    await user.clear(cover);
    await user.type(cover, 'lefthand.jpg');
    await user.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the full address of the cover image, starting with https://.',
    );
    expect(server.callsTo('PATCH', bookPath)).toHaveLength(0);
  });

  it('shows a refused save', async () => {
    const { user } = renderApp({
      hash: editHash,
      routes: editRoutes({
        'PATCH /api/books/:id': () =>
          apiError(403, 'forbidden', 'Ask a parent to change the details of a book'),
      }),
    });
    await user.type(await findForm(), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ask a parent to change the details of a book',
    );
    expect(window.location.hash).toBe(editHash);
  });
});

describe('buildPatch', () => {
  const book = leGuin({ subtitle: null, isbn13: null, isbn10: '0441478123', coverUrl: null });

  it('compares trimmed text, treating empty as none', () => {
    const draft = { ...draftFrom(book), subtitle: '  ', language: ' en ', synopsis: '' };
    expect(draft.isbn).toBe('0441478123');
    expect(buildPatch(book, draft)).toEqual({ synopsis: null });
  });

  it('clears both ISBN forms when the field is emptied', () => {
    expect(buildPatch(book, { ...draftFrom(book), isbn: '' })).toEqual({
      isbn13: null,
      isbn10: null,
    });
  });

  it('refuses a synopsis longer than the catalogue accepts', () => {
    expect(buildPatch(book, { ...draftFrom(book), synopsis: 'x'.repeat(20_001) })).toBe(
      'The synopsis is too long: at most 20,000 characters.',
    );
  });
});

describe('foundText', () => {
  it('counts what was found in British English', () => {
    expect(foundText(alternatives({ covers: alternatives().covers.slice(0, 1) }))).toBe(
      'Found 1 cover and 2 synopses.',
    );
    expect(
      foundText(
        alternatives({
          synopses: alternatives().synopses.slice(0, 1),
          unavailable: ['openlibrary', 'googlebooks'],
        }),
      ),
    ).toBe(
      'Found 2 covers and 1 synopsis. Open Library and Google Books couldn’t be reached, so some may be missing.',
    );
  });
});
