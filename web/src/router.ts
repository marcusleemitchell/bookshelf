/**
 * Hand-written hash router (SPEC §2: no router dependency). Hash routes work
 * from the Home Screen and with the server's SPA fallback alike.
 *
 * | Hash                         | Screen                                   |
 * | ---------------------------- | ---------------------------------------- |
 * | `#/`                         | Today                                    |
 * | `#/library`                  | Library                                  |
 * | `#/add`                      | Add book                                 |
 * | `#/books/:id`                | Book detail                              |
 * | `#/books/:id/edit`           | Edit details (parents and admins)        |
 * | `#/log?book=:id&timer=1`     | Log session (optionally from the timer)  |
 * | `#/calendar?month=YYYY-MM`   | Calendar                                 |
 * | `#/stats`                    | Stats                                    |
 * | `#/settings`                 | Settings                                 |
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'today' }
  | { name: 'library' }
  | { name: 'add' }
  | { name: 'book'; id: string }
  | { name: 'editBook'; id: string }
  | { name: 'log'; bookId: string | null; fromTimer: boolean }
  | { name: 'calendar'; month: string | null }
  | { name: 'stats' }
  | { name: 'settings' }
  | { name: 'notFound'; path: string };

export type TabName = 'today' | 'library' | 'calendar' | 'stats' | 'settings';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parses `location.hash` (with or without the leading `#`). */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', search = ''] = raw.split('?', 2);
  const path = pathPart === '' ? '/' : pathPart.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(search);
  if (path === '/') return { name: 'today' };
  if (path === '/library') return { name: 'library' };
  if (path === '/add') return { name: 'add' };
  if (path === '/stats') return { name: 'stats' };
  if (path === '/settings') return { name: 'settings' };
  if (path === '/calendar') {
    const month = params.get('month');
    return { name: 'calendar', month: month && MONTH_RE.test(month) ? month : null };
  }
  if (path === '/log') {
    return { name: 'log', bookId: params.get('book'), fromTimer: params.get('timer') === '1' };
  }
  const book = /^\/books\/([^/]+)$/.exec(path);
  if (book?.[1]) return { name: 'book', id: decodeURIComponent(book[1]) };
  const edit = /^\/books\/([^/]+)\/edit$/.exec(path);
  if (edit?.[1]) return { name: 'editBook', id: decodeURIComponent(edit[1]) };
  return { name: 'notFound', path };
}

/** The tab highlighted for a route. */
export function tabFor(route: Route): TabName | null {
  switch (route.name) {
    case 'today':
    case 'log':
      return 'today';
    case 'library':
    case 'add':
    case 'book':
    case 'editBook':
      return 'library';
    case 'calendar':
      return 'calendar';
    case 'stats':
      return 'stats';
    case 'settings':
      return 'settings';
    case 'notFound':
      return null;
  }
}

/** Path builders, so links are typed in one place. */
export const paths = {
  today: () => '/',
  library: () => '/library',
  add: () => '/add',
  book: (id: string) => `/books/${encodeURIComponent(id)}`,
  editBook: (id: string) => `/books/${encodeURIComponent(id)}/edit`,
  log: (options: { bookId?: string; fromTimer?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.bookId) params.set('book', options.bookId);
    if (options.fromTimer) params.set('timer', '1');
    const search = params.toString();
    return search ? `/log?${search}` : '/log';
  },
  calendar: (month?: string) => (month ? `/calendar?month=${month}` : '/calendar'),
  stats: () => '/stats',
  settings: () => '/settings',
};

export function href(path: string): string {
  return `#${path}`;
}

/** Navigates to an app path (e.g. `paths.book(id)`). */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = href(path);
  if (options.replace) {
    window.location.replace(target);
  } else {
    window.location.hash = target;
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

function currentHash(): string {
  return window.location.hash;
}

/** The current route, updated on `hashchange`. */
export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, currentHash, () => ''));
}
