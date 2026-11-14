/**
 * React glue for the services: context access, store subscriptions, the
 * cache-backed resource loader and a ticking clock.
 */
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from 'react';
import type { z } from 'zod';
import { isOfflineError, type ApiClient } from '../api/client.ts';
import type { OutboxCounts } from '../offline/outbox.ts';
import type { Services } from './services.ts';
import type { Store } from './store.ts';

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesContext>');
  return services;
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** False only when the server is known to be unreachable. */
export function useReachable(): boolean {
  return useStore(useServices().connectivity) !== false;
}

/** Live outbox counts (pending / failed). */
export function useOutboxCounts(): OutboxCounts {
  const { outbox } = useServices();
  const [counts, setCounts] = useState<OutboxCounts>({ pending: 0, failed: 0 });
  useEffect(() => {
    let active = true;
    const load = () => {
      void outbox.counts().then((next) => {
        if (active) setCounts(next);
      });
    };
    load();
    const unsubscribe = outbox.subscribe(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [outbox]);
  return counts;
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  /** A request for the current key/version is still running. */
  loading: boolean;
  /** `data` came from the local cache (the server was unreachable or is still answering). */
  fromCache: boolean;
}

interface ResourceState<T> {
  requestId: string | null;
  key: string | null;
  data: T | undefined;
  error: unknown;
  fromCache: boolean;
  settled: boolean;
}

/**
 * Loads an API resource, keeping the last good response in the read-model
 * cache. The cached copy is shown immediately while the request runs and is
 * used when the server is unreachable. Refetches when `key` changes or data
 * is invalidated. Pass `key = null` to skip loading.
 */
export function useResource<S extends z.ZodType>(
  key: string | null,
  schema: S,
  load: (api: ApiClient) => Promise<z.output<S>>,
): Resource<z.output<S>> {
  const services = useServices();
  const version = useStore(services.dataVersion);
  const requestId = key === null ? null : `${key}#${version}`;
  const [state, setState] = useState<ResourceState<z.output<S>>>({
    requestId: null,
    key: null,
    data: undefined,
    error: undefined,
    fromCache: false,
    settled: false,
  });
  const runLoad = useEffectEvent(() => load(services.api));

  useEffect(() => {
    if (key === null || requestId === null) return;
    let cancelled = false;
    let settled = false;
    void services.cache.get(key, schema).then((cached) => {
      if (cancelled || settled || cached === undefined) return;
      setState((prev) =>
        prev.requestId === requestId && prev.settled
          ? prev
          : { requestId, key, data: cached, error: undefined, fromCache: true, settled: false },
      );
    });
    runLoad().then(
      (data) => {
        settled = true;
        if (cancelled) return;
        void services.cache.put(key, data);
        setState({ requestId, key, data, error: undefined, fromCache: false, settled: true });
      },
      async (error: unknown) => {
        settled = true;
        const cached = isOfflineError(error) ? await services.cache.get(key, schema) : undefined;
        if (cancelled) return;
        setState({
          requestId,
          key,
          data: cached,
          error,
          fromCache: cached !== undefined,
          settled: true,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, requestId, schema, services.cache]);

  const sameKey = state.key === key;
  const current = state.requestId === requestId;
  return {
    data: sameKey ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: requestId !== null && (!current || !state.settled),
    fromCache: sameKey && state.fromCache,
  };
}

/** The current time from the services clock, refreshed every `intervalMs`. */
export function useNow(intervalMs = 1000): Date {
  const { now } = useServices();
  const [value, setValue] = useState(() => now());
  useEffect(() => {
    const id = setInterval(() => {
      setValue(now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [now, intervalMs]);
  return value;
}

export interface ActionState {
  busy: boolean;
  error: unknown;
  /** Runs an async action, tracking busy state and keeping its error for display. */
  run: (action: () => Promise<unknown>) => void;
  clearError: () => void;
}

/** Busy/error bookkeeping for a button or form that triggers an async write. */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .catch((caught: unknown) => {
        setError(caught);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return {
    busy,
    error,
    run,
    clearError: () => {
      setError(null);
    },
  };
}
