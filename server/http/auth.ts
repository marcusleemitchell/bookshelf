/**
 * The session cookie and the middleware that requires a signed-in member on
 * every API route except the public ones (ADR 0010).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../context.ts';
import type { MemberRow } from '../repositories/members.ts';
import { resolveSession, SESSION_TTL_MS } from '../services/auth.ts';
import { unauthorised } from './errors.ts';

export const SESSION_COOKIE = 'bookshelf_session';

/** API paths that work without signing in. */
export const PUBLIC_API_PATHS = [
  '/api/health',
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/sign-in',
  '/api/auth/sign-out',
];

/** Hono variables set by {@link requireMember}: the member and their session token. */
export interface AuthEnv {
  Variables: { member: MemberRow; sessionToken: string };
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
  path: '/api',
} as const;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL_MS / 1000 });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}

export function sessionToken(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null;
}

/** Rejects the request with 401 unless its cookie signs a member in; sets the variables. */
export function requireMember(ctx: AppContext): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = sessionToken(c);
    const session = token ? resolveSession(ctx, token) : null;
    if (!token || !session) throw unauthorised('Sign in to continue');
    if (session.renewed) setSessionCookie(c, token);
    c.set('member', session.member);
    c.set('sessionToken', token);
    await next();
  };
}
