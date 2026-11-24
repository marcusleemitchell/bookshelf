/**
 * Sign-in routes (ADR 0010): first-run setup, sign in and out, change PIN,
 * and the auth state the profile picker reads.
 */
import { Hono, type Context } from 'hono';
import {
  authSetupSchema,
  authStateSchema,
  pinChangeSchema,
  signInResponseSchema,
  signInSchema,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { clearSessionCookie, sessionToken, setSessionCookie, type AuthEnv } from '../http/auth.ts';
import { readJson, respond } from '../http/validate.ts';
import {
  authState,
  changePin,
  resolveSession,
  setUp,
  signIn,
  signOut,
  toProfile,
  type SignedIn,
} from '../services/auth.ts';

export function authRoutes(ctx: AppContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/auth/state', (c) => {
    const token = sessionToken(c);
    const session = token ? resolveSession(ctx, token) : null;
    if (token && session?.renewed) setSessionCookie(c, token);
    return respond(c, authStateSchema, authState(ctx, session?.member ?? null));
  });

  const signedIn = (c: Context, result: SignedIn) => {
    setSessionCookie(c, result.token);
    return respond(c, signInResponseSchema, { member: toProfile(result.member) });
  };

  app.post('/auth/setup', async (c) =>
    signedIn(c, await setUp(ctx, await readJson(c, authSetupSchema))),
  );
  app.post('/auth/sign-in', async (c) =>
    signedIn(c, await signIn(ctx, await readJson(c, signInSchema))),
  );
  app.post('/auth/sign-out', (c) => {
    const token = sessionToken(c);
    if (token) signOut(ctx, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.put('/auth/pin', async (c) => {
    const input = await readJson(c, pinChangeSchema);
    await changePin(ctx, c.get('member'), c.get('sessionToken'), input);
    return c.body(null, 204);
  });

  return app;
}
