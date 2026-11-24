import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { syncNow } from '../app/services.ts';
import { IDS, authState, owner, sibling } from '../test/fixtures.ts';
import { defaultRoutes, renderApp } from '../test/render.tsx';
import { apiError, createMockServer, ok } from '../test/server.ts';

const signedOut = (members = [owner, sibling]) => ok(authState({ members, me: null }));

/** The tab bar is only there while someone is signed in. */
const tabBar = () => screen.queryByRole('navigation', { name: 'Main' });

describe('Sign in', () => {
  it('sets up the owner on first run, checking the PIN first', async () => {
    const { user, server } = renderApp({
      routes: {
        'GET /api/auth/state': ok(
          authState({
            setupRequired: true,
            members: [{ ...owner, name: 'Owner', hasPin: false }],
            me: null,
          }),
        ),
        'POST /api/auth/setup': ok({ member: owner }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Welcome to Bookshelf' })).toBeVisible();
    expect(tabBar()).toBeNull();
    const setUp = screen.getByRole('button', { name: 'Set up' });
    expect(setUp).toBeDisabled();

    await user.type(screen.getByLabelText('Your name'), 'Alex');
    await user.type(screen.getByLabelText('PIN'), 'ab12');
    expect(screen.getByLabelText('PIN')).toHaveValue('12');
    await user.type(screen.getByLabelText('Confirm PIN'), '12');
    await user.click(setUp);
    expect(screen.getByRole('alert')).toHaveTextContent('A PIN is 4 to 8 digits.');

    await user.type(screen.getByLabelText('PIN'), '46');
    await user.type(screen.getByLabelText('Confirm PIN'), '99');
    await user.click(setUp);
    expect(screen.getByRole('alert')).toHaveTextContent('The two PINs don’t match.');
    expect(server.callsTo('POST', '/api/auth/setup')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Confirm PIN'));
    await user.type(screen.getByLabelText('Confirm PIN'), '1246');
    await user.click(setUp);
    await waitFor(() => {
      expect(tabBar()).toBeInTheDocument();
    });
    expect(server.callsTo('POST', '/api/auth/setup')[0]?.body).toEqual({
      name: 'Alex',
      pin: '1246',
    });
  });

  it('picks a profile, refuses a wrong PIN and signs in with the right one', async () => {
    const { user, server } = renderApp({
      routes: {
        'GET /api/auth/state': signedOut(),
        'POST /api/auth/sign-in': (req) =>
          (req.body as { pin: string }).pin === '2468'
            ? { body: { member: sibling } }
            : apiError(401, 'unauthorised', 'Wrong PIN'),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Who’s reading?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Jo' }));
    expect(screen.getByRole('heading', { name: 'Hello, Jo' })).toBeVisible();

    const signIn = screen.getByRole('button', { name: 'Sign in' });
    await user.type(screen.getByLabelText('PIN'), '000');
    expect(signIn).toBeDisabled();
    await user.type(screen.getByLabelText('PIN'), '0');
    await user.click(signIn);
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong PIN');
    expect(screen.getByLabelText('PIN')).toHaveValue('');
    expect(tabBar()).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Someone else' }));
    await user.click(await screen.findByRole('button', { name: 'Jo' }));
    await user.type(screen.getByLabelText('PIN'), '2468');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(tabBar()).toBeInTheDocument();
    });
    expect(server.callsTo('POST', '/api/auth/sign-in').at(-1)?.body).toEqual({
      memberId: IDS.sibling,
      pin: '2468',
    });
  });

  it('goes straight to the PIN of the only profile and shows a lockout', async () => {
    const { user } = renderApp({
      routes: {
        'GET /api/auth/state': signedOut([owner]),
        'POST /api/auth/sign-in': () =>
          apiError(429, 'too_many_attempts', 'Too many wrong PINs. Try again in 15 minutes.'),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Hello, Alex' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Someone else' })).toBeNull();
    await user.type(screen.getByLabelText('PIN'), '0000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many wrong PINs. Try again in 15 minutes.',
    );
  });

  it('returns to sign-in when the session ends', async () => {
    let signedIn = true;
    renderApp({
      hash: '#/library',
      routes: {
        'GET /api/auth/state': () => ({
          body: signedIn ? authState() : authState({ members: [owner], me: null }),
        }),
        'GET /api/books': () => {
          signedIn = false;
          return apiError(401, 'unauthorised', 'Sign in to continue');
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Hello, Alex' })).toBeVisible();
    expect(tabBar()).toBeNull();
  });

  it('runs from the device when the check fails, and checks again once the server is back', async () => {
    const server = createMockServer({
      ...defaultRoutes(),
      'GET /api/auth/state': signedOut([owner]),
    });
    server.offline = true;
    const { services } = renderApp({ server });
    await waitFor(() => {
      expect(services.auth.get()).toEqual({ status: 'unverified' });
    });
    expect(tabBar()).toBeInTheDocument();

    server.offline = false;
    act(() => {
      services.connectivity.set(true);
    });
    expect(await screen.findByRole('heading', { name: 'Hello, Alex' })).toBeVisible();
  });

  it('explains when the profiles can’t be loaded and tries again', async () => {
    const { user, services, server } = renderApp();
    await waitFor(() => {
      expect(services.auth.get().status).toBe('signedIn');
    });
    server.offline = true;
    server.on('GET /api/auth/state', signedOut([owner]));
    act(() => {
      services.connectivity.set(false);
      services.auth.set({ status: 'signedOut', state: null });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server can’t be reached. Sign in when you’re back online.',
    );
    server.offline = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Hello, Alex' })).toBeVisible();
  });

  it('holds queued changes while signed out and sends them after signing in', async () => {
    const { user, services, server } = renderApp({
      routes: {
        'GET /api/auth/state': signedOut([owner]),
        'POST /api/auth/sign-in': ok({ member: owner }),
        'POST /api/sync': (req) => ({
          body: {
            results: (req.body as { ops: { opId: string }[] }).ops.map((op) => ({
              opId: op.opId,
              status: 'applied',
              duplicate: false,
            })),
          },
        }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Hello, Alex' })).toBeVisible();
    await services.outbox.enqueue([
      { entity: 'note', action: 'delete', payload: { id: IDS.note }, label: 'Note' },
    ]);
    await syncNow(services);
    expect(server.callsTo('POST', '/api/sync')).toHaveLength(0);

    await user.type(screen.getByLabelText('PIN'), '2468');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/sync')).toHaveLength(1);
    });
  });
});
