/**
 * Family members and their sign-in sessions (ADR 0010). Neither is synced;
 * backups hold members' profiles (never PIN state) but no sessions.
 */
import type { MemberRole } from '../../shared/index.ts';
import { all, run, type Db, type SqlValue } from '../db/database.ts';

export interface MemberRow {
  id: string;
  name: string;
  role: MemberRole;
  /** Admins see and change every member's data except private notes (ADR 0010). */
  isAdmin: boolean;
  pinHash: string | null;
  failedPinAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

const MEMBER_COLUMNS = `id, name, role, is_admin AS isAdmin, pin_hash AS pinHash,
  failed_pin_attempts AS failedPinAttempts, locked_until AS lockedUntil,
  created_at AS createdAt, updated_at AS updatedAt`;

/** Members matching `where`, oldest first (SQLite stores the admin flag as 0/1). */
function selectMembers(db: Db, where: string, params: readonly SqlValue[] = []): MemberRow[] {
  return all<Omit<MemberRow, 'isAdmin'> & { isAdmin: number }>(
    db,
    `SELECT ${MEMBER_COLUMNS} FROM members WHERE ${where} ORDER BY created_at, id`,
    params,
  ).map((row) => ({ ...row, isAdmin: row.isAdmin === 1 }));
}

/** Live members, oldest first (the owner leads the profile picker). */
export function listMembers(db: Db): MemberRow[] {
  return selectMembers(db, 'deleted_at IS NULL');
}

export function findMember(db: Db, id: string): MemberRow | null {
  return selectMembers(db, 'id = ? AND deleted_at IS NULL', [id])[0] ?? null;
}

/**
 * The owner: the oldest live admin (migration 0006 made the member created
 * by migration 0005 the admin). Backups from before family profiles restore
 * into the owner, the Notion mirror shows the owner's reading, and the
 * Bookpine CLI imports into the owner by default.
 */
export function findOwner(db: Db): MemberRow | null {
  return selectMembers(db, 'is_admin = 1 AND deleted_at IS NULL')[0] ?? null;
}

/** A member in a backup: profile fields and timestamps, never PIN state or sessions. */
export interface MemberRecord {
  id: string;
  name: string;
  role: MemberRole;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Every member, including removed ones, oldest first (for backups). */
export function listMemberRecords(db: Db): MemberRecord[] {
  return all<Omit<MemberRecord, 'isAdmin'> & { isAdmin: number }>(
    db,
    `SELECT id, name, role, is_admin AS isAdmin, created_at AS createdAt,
       updated_at AS updatedAt, deleted_at AS deletedAt
     FROM members ORDER BY created_at, id`,
  ).map((row) => ({ ...row, isAdmin: row.isAdmin === 1 }));
}

/**
 * Restores a member from a backup: inserts it without a PIN, or updates the
 * profile fields of an existing member while keeping its PIN hash, failed
 * attempts, lock and sign-in sessions.
 */
export function upsertMemberRecord(db: Db, member: MemberRecord): void {
  run(
    db,
    `INSERT INTO members (id, name, role, is_admin, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role,
       is_admin = excluded.is_admin, created_at = excluded.created_at,
       updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    [
      member.id,
      member.name,
      member.role,
      member.isAdmin ? 1 : 0,
      member.createdAt,
      member.updatedAt,
      member.deletedAt,
    ],
  );
}

/** True when at least one live member is an admin. */
export function hasLiveAdmin(db: Db): boolean {
  return (
    all(db, 'SELECT 1 FROM members WHERE is_admin = 1 AND deleted_at IS NULL LIMIT 1').length > 0
  );
}

/** True once any live parent has a PIN; until then the app is in first-run setup. */
export function parentHasPin(db: Db): boolean {
  return (
    all(
      db,
      `SELECT 1 FROM members
       WHERE role = 'parent' AND pin_hash IS NOT NULL AND deleted_at IS NULL LIMIT 1`,
    ).length > 0
  );
}

export function setMemberName(db: Db, id: string, name: string, at: string): void {
  run(db, 'UPDATE members SET name = ?, updated_at = ? WHERE id = ?', [name, at, id]);
}

/** Stores a new PIN hash and clears any failed attempts or lock. */
export function setMemberPin(db: Db, id: string, pinHash: string, at: string): void {
  run(
    db,
    `UPDATE members
     SET pin_hash = ?, failed_pin_attempts = 0, locked_until = NULL, updated_at = ?
     WHERE id = ?`,
    [pinHash, at, id],
  );
}

/** Counts one more wrong PIN and returns the new consecutive count. */
export function addPinFailure(db: Db, id: string): number {
  run(db, 'UPDATE members SET failed_pin_attempts = failed_pin_attempts + 1 WHERE id = ?', [id]);
  const row = all<{ attempts: number }>(
    db,
    'SELECT failed_pin_attempts AS attempts FROM members WHERE id = ?',
    [id],
  )[0];
  return row?.attempts ?? 0;
}

/** Locks the member until `until` and starts counting failures afresh. */
export function lockMember(db: Db, id: string, until: string): void {
  run(db, 'UPDATE members SET failed_pin_attempts = 0, locked_until = ? WHERE id = ?', [until, id]);
}

export function clearPinFailures(db: Db, id: string): void {
  run(db, 'UPDATE members SET failed_pin_attempts = 0, locked_until = NULL WHERE id = ?', [id]);
}

export interface AuthSessionRow {
  tokenHash: string;
  memberId: string;
  renewedAt: string;
  expiresAt: string;
}

export function insertAuthSession(db: Db, session: AuthSessionRow & { createdAt: string }): void {
  run(
    db,
    `INSERT INTO auth_sessions (token_hash, member_id, created_at, renewed_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [session.tokenHash, session.memberId, session.createdAt, session.renewedAt, session.expiresAt],
  );
}

export function findAuthSession(db: Db, tokenHash: string): AuthSessionRow | null {
  return (
    all<AuthSessionRow>(
      db,
      `SELECT token_hash AS tokenHash, member_id AS memberId, renewed_at AS renewedAt,
         expires_at AS expiresAt
       FROM auth_sessions WHERE token_hash = ?`,
      [tokenHash],
    )[0] ?? null
  );
}

export function renewAuthSession(
  db: Db,
  tokenHash: string,
  renewedAt: string,
  expiresAt: string,
): void {
  run(db, 'UPDATE auth_sessions SET renewed_at = ?, expires_at = ? WHERE token_hash = ?', [
    renewedAt,
    expiresAt,
    tokenHash,
  ]);
}

export function deleteAuthSession(db: Db, tokenHash: string): void {
  run(db, 'DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
}

/** Signs the member out everywhere except the session `keepTokenHash`. */
export function deleteOtherAuthSessions(db: Db, memberId: string, keepTokenHash: string): void {
  run(db, 'DELETE FROM auth_sessions WHERE member_id = ? AND token_hash <> ?', [
    memberId,
    keepTokenHash,
  ]);
}

export function deleteExpiredAuthSessions(db: Db, now: string): void {
  run(db, 'DELETE FROM auth_sessions WHERE expires_at <= ?', [now]);
}
