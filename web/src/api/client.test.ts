import { describe, expect, it, vi } from 'vitest';
import { goalWithProgressSchema } from '../../../shared/index.ts';
import {
  IDS,
  alternatives,
  authState,
  bookpineReport,
  health,
  leGuin,
  library,
  makeGoal,
  owner,
} from '../test/fixtures.ts';
import { apiError, createMockServer, ok } from '../test/server.ts';
import { ApiError, OfflineError, createApiClient, errorMessage, isOfflineError } from './client.ts';

describe('createApiClient', () => {
  it('parses successful responses with the shared schemas and reports reachability', async () => {
    const server = createMockServer({ 'GET /api/books': ok(library()) });
    const onReachability = vi.fn();
    const api = createApiClient({ fetch: server.fetch, onReachability });
    const books = await api.listBooks({ status: 'reading' });
    expect(books.map((b) => b.title)).toContain('The Left Hand of Darkness');
    expect(server.calls[0]?.query.get('status')).toBe('reading');
    expect(onReachability).toHaveBeenCalledWith(true);
  });

  it('omits undefined query parameters', async () => {
    const server = createMockServer({
      'GET /api/stats/summary': (req) => ({ body: { q: req.query.toString() } }),
    });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.statsSummary({ from: undefined, to: undefined })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(server.calls[0]?.query.toString()).toBe('');
  });

  it('sends JSON bodies', async () => {
    const server = createMockServer({ 'PATCH /api/books/:id': ok(leGuin({ rating: 4 })) });
    const api = createApiClient({ fetch: server.fetch });
    const book = await api.updateBook(IDS.leGuin, { rating: 4 });
    expect(book.rating).toBe(4);
    expect(server.calls[0]?.body).toEqual({ rating: 4 });
    expect(server.calls[0]?.params['id']).toBe(IDS.leGuin);
  });

  it('sends a Bookpine CSV as text/csv and parses the report', async () => {
    const report = bookpineReport();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(report), { headers: { 'content-type': 'application/json' } }),
      ),
    );
    const api = createApiClient({ fetch: fetchSpy });
    expect(await api.previewBookpine('slug,title\n')).toEqual(report);
    await api.importBookpine('slug,title\n');
    expect(fetchSpy.mock.calls.map((call: unknown[]) => [call[0], call[1]])).toEqual([
      [
        '/api/import/bookpine/preview',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: 'slug,title\n',
        }),
      ],
      ['/api/import/bookpine', expect.objectContaining({ body: 'slug,title\n' })],
    ]);
  });

  it('fetches the alternative covers and synopses of a book', async () => {
    const server = createMockServer({ 'GET /api/books/:id/alternatives': ok(alternatives()) });
    const api = createApiClient({ fetch: server.fetch });
    const result = await api.bookAlternatives(IDS.leGuin);
    expect(result.covers).toHaveLength(2);
    expect(server.calls[0]?.params['id']).toBe(IDS.leGuin);
  });

  it('turns error envelopes into ApiError with code and status', async () => {
    const server = createMockServer({
      'GET /api/lookup/isbn/:isbn': () => apiError(404, 'not_found', 'No book found'),
    });
    const api = createApiClient({ fetch: server.fetch });
    const error = await api.lookupIsbn('9780441478125').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found', message: 'No book found' });
  });

  it('treats a 502 with an error envelope as an upstream error, not offline', async () => {
    const server = createMockServer({
      'GET /api/lookup/search': () => apiError(502, 'upstream_error', 'Open Library failed'),
    });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.searchBooks('dune')).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('treats a proxy 502 without an envelope as the server being unreachable', async () => {
    const onReachability = vi.fn();
    const api = createApiClient({
      fetch: () => Promise.resolve(new Response('Bad Gateway', { status: 502 })),
      onReachability,
    });
    await expect(api.health()).rejects.toBeInstanceOf(OfflineError);
    expect(onReachability).toHaveBeenCalledWith(false);
  });

  it('treats network failures as offline', async () => {
    const api = createApiClient({ fetch: () => Promise.reject(new TypeError('Load failed')) });
    const error = await api.getTimer().catch((e: unknown) => e);
    expect(isOfflineError(error)).toBe(true);
    expect(errorMessage(error)).toMatch(/offline/i);
  });

  it('rethrows aborts untouched', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const api = createApiClient({ fetch: () => Promise.reject(abort) });
    await expect(api.health(new AbortController().signal)).rejects.toBe(abort);
  });

  it('reports other non-JSON failures as internal errors', async () => {
    const api = createApiClient({
      fetch: () => Promise.resolve(new Response('<html>oops</html>', { status: 500 })),
    });
    await expect(api.health()).rejects.toMatchObject({ code: 'internal_error', status: 500 });
  });

  it('rejects responses that break the contract', async () => {
    const server = createMockServer({ 'GET /api/health': ok({ ok: 'yes' }) });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.health()).rejects.toMatchObject({
      code: 'internal_error',
      message: expect.stringMatching(/does not understand/) as unknown,
    });
  });

  it('handles 204 deletes without a body', async () => {
    const server = createMockServer({ 'DELETE /api/timer': () => ({ status: 204 }) });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.deleteTimer()).resolves.toBeUndefined();
  });

  it('tells goal creation (201) from replacement (200)', async () => {
    const goal = goalWithProgressSchema.parse(makeGoal());
    const server = createMockServer({ 'PUT /api/goals/:id': () => ({ status: 201, body: goal }) });
    const api = createApiClient({ fetch: server.fetch });
    await expect(
      api.putGoal(goal.id, { kind: 'minutes_per_day', target: 30 }),
    ).resolves.toMatchObject({
      created: true,
    });
    server.on('PUT /api/goals/:id', ok(goal));
    await expect(
      api.putGoal(goal.id, { kind: 'minutes_per_day', target: 30 }),
    ).resolves.toMatchObject({
      created: false,
    });
  });

  it('signs in, out and changes the PIN through the auth routes', async () => {
    const server = createMockServer({
      'GET /api/auth/state': ok(authState()),
      'POST /api/auth/setup': ok({ member: owner }),
      'POST /api/auth/sign-in': ok({ member: owner }),
      'POST /api/auth/sign-out': () => ({ status: 204 }),
      'PUT /api/auth/pin': () => ({ status: 204 }),
    });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.authState()).resolves.toEqual(authState());
    await expect(api.setUp({ name: 'Alex', pin: '2468' })).resolves.toEqual({ member: owner });
    await expect(api.signIn({ memberId: owner.id, pin: '2468' })).resolves.toEqual({
      member: owner,
    });
    await expect(api.changePin({ currentPin: '2468', newPin: '1357' })).resolves.toBeUndefined();
    await expect(api.signOut()).resolves.toBeUndefined();
    expect(server.callsTo('PUT', '/api/auth/pin')[0]?.body).toEqual({
      currentPin: '2468',
      newPin: '1357',
    });
  });

  it('reports an ended session, but not a wrong PIN, as signed out', async () => {
    const server = createMockServer({
      'GET /api/books': () => apiError(401, 'unauthorised', 'Sign in to continue'),
      'POST /api/auth/sign-in': () => apiError(401, 'unauthorised', 'Wrong PIN'),
    });
    const onUnauthorised = vi.fn();
    const api = createApiClient({ fetch: server.fetch, onUnauthorised });
    await expect(api.signIn({ memberId: owner.id, pin: '0000' })).rejects.toMatchObject({
      status: 401,
      code: 'unauthorised',
      message: 'Wrong PIN',
    });
    expect(onUnauthorised).not.toHaveBeenCalled();
    await expect(api.listBooks()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorised).toHaveBeenCalledTimes(1);
  });

  it('exposes every endpoint through the same request path', async () => {
    const server = createMockServer({ 'GET /api/health': ok(health) });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.health()).resolves.toEqual(health);
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('weird')).toBe('Something went wrong.');
  });
});
