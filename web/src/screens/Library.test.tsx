import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App.tsx';
import { IDS, leGuin, toListItem } from '../test/fixtures.ts';
import { renderApp } from '../test/render.tsx';
import { ok } from '../test/server.ts';
import { matchesSearch } from './Library.tsx';

describe('Library', () => {
  it('shows shelves with counts and switches between them', async () => {
    const { user } = renderApp({ hash: '#/library' });
    expect(await screen.findByRole('tab', { name: 'Reading (1)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByText('The Left Hand of Darkness', { selector: '.title' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Finished (1)' }));
    expect(screen.getByText('Project Hail Mary', { selector: '.title' })).toBeInTheDocument();
    expect(
      screen.queryByText('The Left Hand of Darkness', { selector: '.title' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Did not finish (0)' }));
    expect(screen.getByText('No books here.')).toBeInTheDocument();
  });

  it('filters by tag and searches across shelves', async () => {
    const { user } = renderApp({ hash: '#/library' });
    await user.click(await screen.findByRole('button', { name: 'Book club' }));
    expect(screen.getByRole('tab', { name: 'To read (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Reading (0)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Book club' }));
    await user.type(screen.getByLabelText('Search your library'), 'weir');
    expect(screen.getByText('1 book found')).toBeInTheDocument();
    expect(screen.getByText('Project Hail Mary', { selector: '.title' })).toBeInTheDocument();
  });

  it('invites adding a first book when empty', async () => {
    renderApp({ hash: '#/library', routes: { 'GET /api/books': ok([]), 'GET /api/tags': ok([]) } });
    expect(await screen.findByText('Your library is empty.')).toBeInTheDocument();
  });

  it('renders from the cache when the server is unreachable', async () => {
    const harness = renderApp({ hash: '#/library' });
    await screen.findByText('The Left Hand of Darkness');
    harness.unmount();
    harness.server.offline = true;
    render(<App services={harness.services} />);
    expect(await screen.findByText('The Left Hand of Darkness')).toBeInTheDocument();
  });

  it('matches search terms ignoring case and accents', () => {
    const book = toListItem(leGuin({ id: IDS.leGuin, title: 'Les Misérables' }));
    expect(matchesSearch(book, 'miserables')).toBe(true);
    expect(matchesSearch(book, 'le guin')).toBe(true);
    expect(matchesSearch(book, '9780441478125')).toBe(true);
    expect(matchesSearch(book, 'tolstoy')).toBe(false);
    expect(matchesSearch(book, '  ')).toBe(true);
  });
});
