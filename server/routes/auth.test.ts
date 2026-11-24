import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authStateSchema,
  errorResponseSchema,
  signInResponseSchema,
  type AuthState,
} from '../../shared/index.ts';
import { SESSION_COOKIE } from '../http/auth.ts';
import {
  hashPin,
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MS,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
  verifyPin,
} from '../services/auth.ts';
import { createTestEnv, type ApiResponse, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv({ signedIn: false });
});

afterEach(() => {
  env.cleanup();
});

function expectError(res: ApiResponse, status: number, code: string): string {
  expect(res.status).toBe(status);
  const { error } = errorResponseSchema.parse(res.body);
  expect(error.code).toBe(code);
  return error.message;
}

/** The session cookie a response set, as a `Cookie` header value. */
function cookieFrom(res: ApiResponse): string {
  const header = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header);
  if (!match?.[1]) throw new Error(`No session cookie in "${header}"`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

async function state(): Promise<AuthState> {
  const res = await env.request('GET', '/api/auth/state');
  expect(res.status).toBe(200);
  return authStateSchema.parse(res.body);
}

async function setUpOwner(pin = '2468'): Promise<string> {
  const res = await env.request('POST', '/api/auth/setup', { name: 'Sam', pin });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

function signIn(pin: string, memberId = env.owner.id) {
  return env.request('POST', '/api/auth/sign-in', { memberId, pin });
}

describe('the sign-in gate', () => {
  it('refuses API routes without a session but keeps health and sign-in public', async () => {
    const message = expectError(await env.request('GET', '/api/books'), 401, 'unauthorised');
    expect(message).toBe('Sign in to continue');
    expectError(await env.request('GET', '/api/nothing'), 401, 'unauthorised');
    expect((await env.request('GET', '/api/health')).status).toBe(200);
    expect((await env.request('GET', '/api/auth/state')).status).toBe(200);
  });

  it('refuses unknown, expired and deleted members’ sessions', async () => {
    env.cookie = `${SESSION_COOKIE}=not-a-session`;
    expectError(await env.request('GET', '/api/books'), 401, 'unauthorised');

    env.cookie = await setUpOwner();
    expect((await env.request('GET', '/api/books')).status).toBe(200);
    env.clock.advance(SESSION_TTL_MS);
    expectError(await env.request('GET', '/api/books'), 401, 'unauthorised');
    expect(env.ctx.db.prepare('SELECT * FROM auth_sessions').all()).toEqual([]);

    env.cookie = cookieFrom(await signIn('2468'));
    env.ctx.db
      .prepare('UPDATE members SET deleted_at = ?')
      .run(new Date(env.clock.ms()).toISOString());
    expectError(await env.request('GET', '/api/books'), 401, 'unauthorised');
  });

  it('renews a session in use at most once a day, re-sending the cookie', async () => {
    env.cookie = await setUpOwner();
    const stored = () =>
      env.ctx.db.prepare('SELECT renewed_at, expires_at FROM auth_sessions').get();
    const first = stored();

    env.clock.advance(SESSION_RENEW_AFTER_MS - 1);
    const quiet = await env.request('GET', '/api/books');
    expect(quiet.headers.get('set-cookie')).toBeNull();
    expect(stored()).toEqual(first);

    env.clock.advance(1);
    const renewed = await env.request('GET', '/api/books');
    expect(cookieFrom(renewed)).toBe(env.cookie);
    const now = env.clock.ms();
    expect(stored()).toEqual({
      renewed_at: new Date(now).toISOString(),
      expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    });

    env.clock.advance(SESSION_RENEW_AFTER_MS);
    expect(cookieFrom(await env.request('GET', '/api/auth/state'))).toBe(env.cookie);
  });
});

describe('GET /api/auth/state', () => {
  it('asks for setup until a parent has a PIN, listing profiles without secrets', async () => {
    expect(await state()).toEqual({
      setupRequired: true,
      members: [{ id: env.owner.id, name: 'Owner', role: 'parent', hasPin: false }],
      me: null,
    });
    env.cookie = await setUpOwner();
    const after = await state();
    expect(after.setupRequired).toBe(false);
    expect(after.me).toEqual({ id: env.owner.id, name: 'Sam', role: 'parent', hasPin: true });
    expect(JSON.stringify(after)).not.toMatch(/scrypt|pin_hash|pinHash/);
  });
});

describe('POST /api/auth/setup', () => {
  it('names the owner, sets the PIN and signs in with a strict, long-lived cookie', async () => {
    const res = await env.request('POST', '/api/auth/setup', { name: '  Sam  ', pin: '2468' });
    expect(res.status).toBe(200);
    expect(signInResponseSchema.parse(res.body)).toEqual({
      member: { id: env.owner.id, name: 'Sam', role: 'parent', hasPin: true },
    });
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/api');
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    env.cookie = cookieFrom(res);
    expect((await env.request('GET', '/api/books')).status).toBe(200);
    // Only the token's hash is stored.
    const token = env.cookie.split('=')[1] ?? '';
    const rows = env.ctx.db.prepare('SELECT token_hash FROM auth_sessions').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('works once only and validates the name and PIN', async () => {
    expectError(
      await env.request('POST', '/api/auth/setup', { name: 'Sam', pin: '12' }),
      400,
      'validation_error',
    );
    expectError(
      await env.request('POST', '/api/auth/setup', { name: ' ', pin: '1234' }),
      400,
      'validation_error',
    );
    await setUpOwner();
    const message = expectError(
      await env.request('POST', '/api/auth/setup', { name: 'Mallory', pin: '1111' }),
      409,
      'conflict',
    );
    expect(message).toBe('Bookshelf is already set up: sign in instead');
    expect((await state()).members[0]?.name).toBe('Sam');
  });

  it('fails cleanly when there is no owner to set up', async () => {
    env.ctx.db.prepare('UPDATE members SET deleted_at = ?').run('2026-11-14T12:00:00.000Z');
    expectError(
      await env.request('POST', '/api/auth/setup', { name: 'Sam', pin: '2468' }),
      500,
      'internal_error',
    );
  });
});

describe('POST /api/auth/sign-in', () => {
  beforeEach(async () => {
    await setUpOwner();
  });

  it('signs in with the right PIN and refuses a wrong one', async () => {
    expect(expectError(await signIn('1357'), 401, 'unauthorised')).toBe('Wrong PIN');
    const res = await signIn('2468');
    expect(res.status).toBe(200);
    expect(signInResponseSchema.parse(res.body).member.id).toBe(env.owner.id);
    env.cookie = cookieFrom(res);
    expect((await env.request('GET', '/api/books')).status).toBe(200);
    expect(env.ctx.db.prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 2 });
  });

  it('404s for an unknown member and refuses a profile without a PIN', async () => {
    expectError(await signIn('2468', '00000000-0000-4000-8000-000000000000'), 404, 'not_found');
    env.ctx.db.prepare('UPDATE members SET pin_hash = NULL').run();
    expect(expectError(await signIn('2468'), 409, 'conflict')).toBe('This profile has no PIN yet');
  });

  it('locks a profile after repeated wrong PINs, then lets the right PIN in', async () => {
    for (let attempt = 1; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      expectError(await signIn('0000'), 401, 'unauthorised');
    }
    expect(expectError(await signIn('0000'), 429, 'too_many_attempts')).toBe(
      'Too many wrong PINs. Try again in 15 minutes.',
    );
    // While locked even the right PIN is refused, and the remaining time counts down.
    env.clock.advance(PIN_LOCKOUT_MS - 60_000);
    expect(expectError(await signIn('2468'), 429, 'too_many_attempts')).toBe(
      'Too many wrong PINs. Try again in 1 minute.',
    );
    expect(env.logs.some((l) => l['msg'] === 'Member locked after wrong PINs')).toBe(true);

    env.clock.advance(60_000);
    expect((await signIn('2468')).status).toBe(200);
    expect(
      env.ctx.db.prepare('SELECT failed_pin_attempts, locked_until FROM members').get(),
    ).toEqual({ failed_pin_attempts: 0, locked_until: null });
  });

  it('only counts consecutive wrong PINs', async () => {
    for (let attempt = 1; attempt < MAX_PIN_ATTEMPTS; attempt += 1) await signIn('0000');
    expect((await signIn('2468')).status).toBe(200);
    for (let attempt = 1; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      expectError(await signIn('0000'), 401, 'unauthorised');
    }
  });

  it('never logs a PIN', async () => {
    await signIn('1357');
    await signIn('2468');
    expect(JSON.stringify(env.logs)).not.toMatch(/1357|2468/);
  });
});

describe('POST /api/auth/sign-out', () => {
  it('ends the session and clears the cookie, and is harmless without one', async () => {
    env.cookie = await setUpOwner();
    const res = await env.request('POST', '/api/auth/sign-out');
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`));
    expectError(await env.request('GET', '/api/books'), 401, 'unauthorised');
    expect(env.ctx.db.prepare('SELECT * FROM auth_sessions').all()).toEqual([]);

    env.cookie = null;
    expect((await env.request('POST', '/api/auth/sign-out')).status).toBe(204);
  });
});

describe('PUT /api/auth/pin', () => {
  it('changes the PIN after checking the current one and signs out other devices', async () => {
    env.cookie = await setUpOwner();
    const otherDevice = cookieFrom(await signIn('2468'));

    expect(
      expectError(
        await env.request('PUT', '/api/auth/pin', { currentPin: '1111', newPin: '9753' }),
        401,
        'unauthorised',
      ),
    ).toBe('Wrong PIN');
    expectError(
      await env.request('PUT', '/api/auth/pin', { currentPin: '2468', newPin: 'abcd' }),
      400,
      'validation_error',
    );

    const res = await env.request('PUT', '/api/auth/pin', { currentPin: '2468', newPin: '9753' });
    expect(res.status).toBe(204);
    expect((await env.request('GET', '/api/books')).status).toBe(200);
    expectError(
      await env.request('GET', '/api/books', undefined, { cookie: otherDevice }),
      401,
      'unauthorised',
    );
    expectError(await signIn('2468'), 401, 'unauthorised');
    expect((await signIn('9753')).status).toBe(200);
  });

  it('needs a session', async () => {
    expectError(
      await env.request('PUT', '/api/auth/pin', { currentPin: '2468', newPin: '9753' }),
      401,
      'unauthorised',
    );
  });
});

describe('PIN hashes', () => {
  it('are salted scrypt hashes that verify only the same PIN', async () => {
    const first = await hashPin('2468');
    const second = await hashPin('2468');
    expect(first).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(first).not.toBe(second);
    expect(await verifyPin('2468', first)).toBe(true);
    expect(await verifyPin('2469', first)).toBe(false);
  });

  it('never match a malformed hash', async () => {
    expect(await verifyPin('2468', 'plain-2468')).toBe(false);
    expect(await verifyPin('2468', 'scrypt$16384$8$1$c2FsdA==')).toBe(false);
  });
});
