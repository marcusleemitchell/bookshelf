/**
 * The app shell: offline banner, the current screen (hash router), toasts and
 * the bottom tab bar, or the sign-in screen while no one is signed in. Also
 * owns the sync triggers that replay the outbox (on start, reconnect, return
 * to the app and on an interval) and the sign-in check (ADR 0010).
 */
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { useOutboxCounts, useReachable, useServices, useStore } from './app/hooks.ts';
import { ServicesContext } from './app/hooks.ts';
import {
  createServices,
  invalidate,
  refreshAuth,
  syncNow,
  type AuthStatus,
  type Services,
} from './app/services.ts';
import {
  CalendarIcon,
  LibraryIcon,
  SettingsIcon,
  StatsIcon,
  TodayIcon,
} from './components/Icons.tsx';
import { plural } from './lib/labels.ts';
import { href, paths, tabFor, useRoute, type Route, type TabName } from './router.ts';
import { AddBook } from './screens/AddBook.tsx';
import { CalendarScreen } from './screens/Calendar.tsx';
import { Library } from './screens/Library.tsx';
import { LogSession } from './screens/LogSession.tsx';
import { NotFound } from './screens/NotFound.tsx';
import { Settings } from './screens/Settings.tsx';
import { SignIn } from './screens/SignIn.tsx';
import { Today } from './screens/Today.tsx';
import { Loading } from './components/ui.tsx';

// Screens with charts pull in Recharts; load them on demand (the service
// worker precaches every chunk, so this still works offline).
const BookDetailScreen = lazy(async () => ({
  default: (await import('./screens/BookDetail.tsx')).BookDetailScreen,
}));
const Stats = lazy(async () => ({ default: (await import('./screens/Stats.tsx')).Stats }));

/** How often pending outbox ops are retried while the app is open. */
export const SYNC_INTERVAL_MS = 30_000;
/** How long a toast stays visible. */
export const TOAST_MS = 4_000;

export function App({ services }: { services?: Services }) {
  const [value] = useState(() => services ?? createServices());
  return (
    <ServicesContext value={value}>
      <Shell />
    </ServicesContext>
  );
}

const TABS: readonly { name: TabName; label: string; path: string; icon: ReactNode }[] = [
  { name: 'today', label: 'Today', path: paths.today(), icon: <TodayIcon /> },
  { name: 'library', label: 'Library', path: paths.library(), icon: <LibraryIcon /> },
  { name: 'calendar', label: 'Calendar', path: paths.calendar(), icon: <CalendarIcon /> },
  { name: 'stats', label: 'Stats', path: paths.stats(), icon: <StatsIcon /> },
  { name: 'settings', label: 'Settings', path: paths.settings(), icon: <SettingsIcon /> },
];

function TabBar({ active }: { active: TabName | null }) {
  return (
    <nav className="tabbar" aria-label="Main">
      <ul>
        {TABS.map((tab) => (
          <li key={tab.name}>
            <a href={href(tab.path)} aria-current={tab.name === active ? 'page' : undefined}>
              {tab.icon}
              <span>{tab.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function OfflineBanner() {
  const reachable = useReachable();
  const { pending, failed } = useOutboxCounts();
  if (reachable && failed === 0) return null;
  return (
    <div className="banner" role="status">
      {!reachable && (
        <span>
          <strong>Offline.</strong> Changes are saved on this device and sync when the server is
          reachable.
        </span>
      )}
      {pending > 0 && <span>{plural(pending, 'change')} waiting to sync.</span>}
      {failed > 0 && (
        <span>
          {plural(failed, 'change')} couldn’t sync. <a href={href(paths.settings())}>Review</a>
        </span>
      )}
    </div>
  );
}

function Toast() {
  const services = useServices();
  const message = useStore(services.toast);
  useEffect(() => {
    if (message === null) return;
    const id = setTimeout(() => {
      services.toast.set(null);
    }, TOAST_MS);
    return () => {
      clearTimeout(id);
    };
  }, [message, services]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && <div className="toast">{message}</div>}
    </div>
  );
}

/** Replays the outbox on start, reconnect, return to the app and every 30 seconds. */
function useSyncTriggers(): void {
  const services = useServices();
  useEffect(() => {
    void services.cache.prune();
    void syncNow(services);
    let wasReachable = services.connectivity.get();
    const onOnline = () => {
      void syncNow(services);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      invalidate(services);
      void syncNow(services);
    };
    const unsubscribe = services.connectivity.subscribe(() => {
      const reachable = services.connectivity.get();
      if (reachable === true && wasReachable === false) void syncNow(services);
      wasReachable = reachable;
    });
    const interval = setInterval(() => {
      void syncNow(services);
    }, SYNC_INTERVAL_MS);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [services]);
}

/**
 * Asks the server who is signed in on start, loads the profiles when a
 * session ends, and asks again once an unanswered check can reach the server.
 */
function useAuthGate(): AuthStatus {
  const services = useServices();
  const auth = useStore(services.auth);
  const needsCheck = auth.status === 'unverified' || (auth.status === 'signedOut' && !auth.state);
  useEffect(() => {
    void refreshAuth(services);
  }, [services]);
  useEffect(() => {
    if (auth.status === 'signedOut' && auth.state === null) void refreshAuth(services);
  }, [auth, services]);
  useEffect(() => {
    if (!needsCheck) return;
    return services.connectivity.subscribe(() => {
      if (services.connectivity.get() === true) void refreshAuth(services);
    });
  }, [needsCheck, services]);
  return auth;
}

function routeKey(route: Route): string {
  return route.name === 'book' ? `book:${route.id}` : route.name;
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'today':
      return <Today />;
    case 'library':
      return <Library />;
    case 'add':
      return <AddBook />;
    case 'book':
      return <BookDetailScreen bookId={route.id} />;
    case 'log':
      return <LogSession bookId={route.bookId} fromTimer={route.fromTimer} />;
    case 'calendar':
      return <CalendarScreen month={route.month} />;
    case 'stats':
      return <Stats />;
    case 'settings':
      return <Settings />;
    case 'notFound':
      return <NotFound path={route.path} />;
  }
}

function Shell() {
  const route = useRoute();
  const key = routeKey(route);
  const previousKey = useRef<string | null>(null);
  const auth = useAuthGate();
  useSyncTriggers();

  // Move focus to the new screen's heading on navigation (not on first load).
  useEffect(() => {
    if (previousKey.current !== null && previousKey.current !== key) {
      window.scrollTo(0, 0);
      document.querySelector<HTMLElement>('[data-screen-title]')?.focus();
    }
    previousKey.current = key;
  }, [key]);

  // The app renders while the check runs, so start-up never waits for the
  // network; it gives way to sign-in once the server says no one is signed in.
  const signedOut = auth.status === 'signedOut';
  return (
    <div className="app">
      <OfflineBanner />
      <main className="main" id="main">
        {signedOut ? (
          <SignIn state={auth.state} />
        ) : (
          <Suspense fallback={<Loading />}>
            <Screen key={key} route={route} />
          </Suspense>
        )}
      </main>
      <Toast />
      {!signedOut && <TabBar active={tabFor(route)} />}
    </div>
  );
}
