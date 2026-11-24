/**
 * Family members and their sign-in sessions (ADR 0010). Server-internal
 * tables: neither is synced, and backups leave both out.
 */
import type { MemberRole } from '../../shared/index.ts';
import { all, run, type Db } from '../db/database.ts';

export interface MemberRow {
  id: string;
  name: string;
  role: MemberRole;
  pinHash: string | null;
  failedPinAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

const MEMBER_COLUMNS = `id, name, role, pin_hash AS pinHash,
  failed_pin_attempts AS failedPinAttempts, locked_until AS lockedUntil,
  created_at AS createdAt, updated_at AS updatedAt`;

/** Live members, oldest first (the owner leads the profile picker). */
export function listMembers(db: Db): MemberRow[] {
  return all<MemberRow>(
    db,
    `SELECT ${MEMBER_COLUMNS} FROM members WHERE deleted_at IS NULL ORDER BY created_at, id`,
  );
}

export function findMember(db: Db, id: string): MemberRow | null {
  return (
    all<MemberRow>(
      db,
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ? AND deleted_at IS NULL`,
      [id],
    )[0] ?? null
  );
}

/** The owner: the oldest live parent (created by migration 0005). */
export function findOwner(db: Db): MemberRow | null {
  return (
    all<MemberRow>(
      db,
      `SELECT ${MEMBER_COLUMNS} FROM members
       WHERE role = 'parent' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1`,
    )[0] ?? null
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
