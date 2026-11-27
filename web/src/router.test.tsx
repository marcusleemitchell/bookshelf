import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { href, navigate, parseRoute, paths, tabFor, useRoute } from './router.ts';

describe('parseRoute', () => {
  it.each([
    ['', { name: 'today' }],
    ['#/', { name: 'today' }],
    ['#/library/', { name: 'library' }],
    ['#/add', { name: 'add' }],
    ['#/stats', { name: 'stats' }],
    ['#/settings', { name: 'settings' }],
    ['#/books/abc%20d', { name: 'book', id: 'abc d' }],
    ['#/books/abc%20d/edit', { name: 'editBook', id: 'abc d' }],
    ['#/log', { name: 'log', bookId: null, fromTimer: false }],
    ['#/log?book=b1&timer=1', { name: 'log', bookId: 'b1', fromTimer: true }],
    ['#/calendar', { name: 'calendar', month: null }],
    ['#/calendar?month=2026-02', { name: 'calendar', month: '2026-02' }],
    ['#/calendar?month=2026-13', { name: 'calendar', month: null }],
    ['#/nope', { name: 'notFound', path: '/nope' }],
    ['#/books/a/b', { name: 'notFound', path: '/books/a/b' }],
  ])('parses %s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe('paths and tabs', () => {
  it('builds paths that parse back', () => {
    expect(parseRoute(href(paths.book('x y')))).toEqual({ name: 'book', id: 'x y' });
    expect(parseRoute(href(paths.editBook('x y')))).toEqual({ name: 'editBook', id: 'x y' });
    expect(paths.log()).toBe('/log');
    expect(paths.log({ bookId: 'b', fromTimer: true })).toBe('/log?book=b&timer=1');
    expect(paths.calendar('2026-11')).toBe('/calendar?month=2026-11');
    expect([paths.today(), paths.library(), paths.add(), paths.stats(), paths.settings()]).toEqual([
      '/',
      '/library',
      '/add',
      '/stats',
      '/settings',
    ]);
  });

  it('highlights the owning tab', () => {
    expect(tabFor({ name: 'log', bookId: null, fromTimer: false })).toBe('today');
    expect(tabFor({ name: 'book', id: 'x' })).toBe('library');
    expect(tabFor({ name: 'editBook', id: 'x' })).toBe('library');
    expect(tabFor({ name: 'add' })).toBe('library');
    expect(tabFor({ name: 'calendar', month: null })).toBe('calendar');
    expect(tabFor({ name: 'stats' })).toBe('stats');
    expect(tabFor({ name: 'settings' })).toBe('settings');
    expect(tabFor({ name: 'notFound', path: '/x' })).toBeNull();
  });
});

function RouteName() {
  return <p>{useRoute().name}</p>;
}

describe('useRoute and navigate', () => {
  it('follows hash changes', async () => {
    render(<RouteName />);
    expect(screen.getByText('today')).toBeInTheDocument();
    act(() => {
      navigate(paths.stats());
    });
    expect(await screen.findByText('stats')).toBeInTheDocument();
    act(() => {
      navigate(paths.library(), { replace: true });
    });
    expect(await screen.findByText('library')).toBeInTheDocument();
  });
});
