import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('App', () => {
  it('shows the server version when the health check succeeds', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(jsonResponse({ ok: true, version: '0.1.0', dbPath: '/tmp/bookshelf.db' }));
    render(<App fetchImpl={fetchImpl} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking server…');
    expect(await screen.findByText('Server online (version 0.1.0).')).toBeInTheDocument();
  });

  it('reports an HTTP failure', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(jsonResponse({ error: { code: 'internal_error', message: 'x' } }, 500));
    render(<App fetchImpl={fetchImpl} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Server unreachable: Server responded with HTTP 500',
    );
  });

  it('reports a network failure', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<App fetchImpl={fetchImpl} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  it('reports a malformed health payload', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse({ ok: 'yes' }));
    render(<App fetchImpl={fetchImpl} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
