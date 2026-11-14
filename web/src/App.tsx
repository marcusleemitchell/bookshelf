import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '../../shared/index.ts';

type ServerState =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

/**
 * Phase 1 shell: reports whether the Bookshelf server is reachable.
 * The real screens (SPEC §6) replace this in phase 2.
 */
export function App({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [state, setState] = useState<ServerState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchImpl('/api/health', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Server responded with HTTP ${res.status}`);
        }
        const health = healthResponseSchema.parse(await res.json());
        setState({ kind: 'ok', health });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => {
      controller.abort();
    };
  }, [fetchImpl]);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
      <h1>Bookshelf</h1>
      {state.kind === 'loading' && <p role="status">Checking server…</p>}
      {state.kind === 'ok' && <p role="status">Server online (version {state.health.version}).</p>}
      {state.kind === 'error' && <p role="alert">Server unreachable: {state.message}</p>}
    </main>
  );
}
