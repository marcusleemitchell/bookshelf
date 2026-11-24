/**
 * Light sign-in for family members (ADR 0010): a PIN per member, hashed
 * with scrypt, a lockout after repeated wrong PINs, and long-lived session
 * tokens of which only the SHA-256 hash is stored.
 */
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import type { AuthSetup, AuthState, MemberProfile, PinChange, SignIn } from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { AppError, conflict, notFound, unauthorised } from '../http/errors.ts';
import {
  addPinFailure,
  clearPinFailures,
  deleteAuthSession,
  deleteExpiredAuthSessions,
  deleteOtherAuthSessions,
  findAuthSession,
  findMember,
  findOwner,
  insertAuthSession,
  listMembers,
  lockMember,
  parentHasPin,
  renewAuthSession,
  setMemberName,
  setMemberPin,
  type MemberRow,
} from '../repositories/members.ts';

/** A session lasts 180 days from its last renewal. */
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** A session in use is renewed (and its cookie re-sent) at most once a day. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** Consecutive wrong PINs that lock a member. */
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEY_LENGTH = 32;

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Hashes a PIN as `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const key = await scrypt(pin, salt, SCRYPT_KEY_LENGTH, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Checks a PIN against a stored hash in constant time; false for a malformed hash. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pin, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toProfile(member: MemberRow): MemberProfile {
  return { id: member.id, name: member.name, role: member.role, hasPin: member.pinHash !== null };
}

export function authState(ctx: AppContext, me: MemberRow | null): AuthState {
  return {
    setupRequired: !parentHasPin(ctx.db),
    members: listMembers(ctx.db).map(toProfile),
    me: me ? toProfile(me) : null,
  };
}

export interface SignedIn {
  member: MemberRow;
  /** The cookie value; only its hash is stored. */
  token: string;
}

function startSession(ctx: AppContext, member: MemberRow): SignedIn {
  const now = ctx.now();
  const token = randomBytes(32).toString('base64url');
  transaction(ctx.db, () => {
    deleteExpiredAuthSessions(ctx.db, now.toISOString());
    insertAuthSession(ctx.db, {
      tokenHash: hashToken(token),
      memberId: member.id,
      createdAt: now.toISOString(),
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    });
  });
  ctx.logger.info('Signed in', { memberId: member.id });
  return { member, token };
}

function reload(ctx: AppContext, id: string): MemberRow {
  const member = findMember(ctx.db, id);
  if (!member) throw notFound('Member');
  return member;
}

const setupDone = () => conflict('Bookshelf is already set up: sign in instead');

/** First run: names the owner, sets their PIN and signs them in. */
export async function setUp(ctx: AppContext, input: AuthSetup): Promise<SignedIn> {
  if (parentHasPin(ctx.db)) throw setupDone();
  const pinHash = await hashPin(input.pin);
  const owner = transaction(ctx.db, () => {
    // Checked again: another device may have finished setup while hashing.
    if (parentHasPin(ctx.db)) throw setupDone();
    const found = findOwner(ctx.db);
    if (!found) throw new AppError(500, 'internal_error', 'No owner member exists');
    const at = nowIso(ctx);
    setMemberName(ctx.db, found.id, input.name, at);
    setMemberPin(ctx.db, found.id, pinHash, at);
    return found.id;
  });
  return startSession(ctx, reload(ctx, owner));
}

function lockedMessage(lockedUntil: string, now: Date): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(lockedUntil) - now.getTime()) / 60_000));
  return `Too many wrong PINs. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * Checks `pin` for `member`, counting a wrong PIN towards the lockout.
 * Throws 429 while locked and 401 for a wrong PIN.
 */
async function checkPin(ctx: AppContext, member: MemberRow, pin: string): Promise<void> {
  const now = ctx.now();
  if (member.lockedUntil !== null && member.lockedUntil > now.toISOString()) {
    throw new AppError(429, 'too_many_attempts', lockedMessage(member.lockedUntil, now));
  }
  if (member.pinHash === null) throw conflict('This profile has no PIN yet');
  if (await verifyPin(pin, member.pinHash)) {
    clearPinFailures(ctx.db, member.id);
    return;
  }
  const locked = transaction(ctx.db, () => {
    if (addPinFailure(ctx.db, member.id) < MAX_PIN_ATTEMPTS) return null;
    const until = new Date(now.getTime() + PIN_LOCKOUT_MS).toISOString();
    lockMember(ctx.db, member.id, until);
    return until;
  });
  if (locked) {
    ctx.logger.warn('Member locked after wrong PINs', { memberId: member.id });
    throw new AppError(429, 'too_many_attempts', lockedMessage(locked, now));
  }
  throw unauthorised('Wrong PIN');
}

export async function signIn(ctx: AppContext, input: SignIn): Promise<SignedIn> {
  const member = reload(ctx, input.memberId);
  await checkPin(ctx, member, input.pin);
  return startSession(ctx, member);
}

export function signOut(ctx: AppContext, token: string): void {
  deleteAuthSession(ctx.db, hashToken(token));
}

/** Changes the member's PIN and signs them out on every other device. */
export async function changePin(
  ctx: AppContext,
  member: MemberRow,
  token: string,
  input: PinChange,
): Promise<void> {
  await checkPin(ctx, member, input.currentPin);
  const pinHash = await hashPin(input.newPin);
  transaction(ctx.db, () => {
    setMemberPin(ctx.db, member.id, pinHash, nowIso(ctx));
    deleteOtherAuthSessions(ctx.db, member.id, hashToken(token));
  });
}

export interface ResolvedSession {
  member: MemberRow;
  /** True when the session was just renewed, so its cookie should be re-sent. */
  renewed: boolean;
}

/** The member a session token signs in, or null when it is unknown, expired or theirs is gone. */
export function resolveSession(ctx: AppContext, token: string): ResolvedSession | null {
  const tokenHash = hashToken(token);
  const session = findAuthSession(ctx.db, tokenHash);
  if (!session) return null;
  const now = ctx.now();
  if (session.expiresAt <= now.toISOString()) {
    deleteAuthSession(ctx.db, tokenHash);
    return null;
  }
  const member = findMember(ctx.db, session.memberId);
  if (!member) return null;
  if (now.getTime() - Date.parse(session.renewedAt) < SESSION_RENEW_AFTER_MS) {
    return { member, renewed: false };
  }
  renewAuthSession(
    ctx.db,
    tokenHash,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  );
  return { member, renewed: true };
}
