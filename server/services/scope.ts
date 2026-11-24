/**
 * Whose data a request reads and writes, and who is asking (ADR 0010).
 *
 * `member` is the member whose personal data (shelf, reads, sessions, notes,
 * tags, goals, timer, import links) is read and written; every personal
 * query filters by `member.id`. `actor` is the signed-in member, used for
 * permission checks. They are the same member until an admin can "view as"
 * someone else (ADR 0010 step 3), which only changes how routes build the
 * scope.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../http/auth.ts';
import { forbidden } from '../http/errors.ts';
import type { MemberRow } from '../repositories/members.ts';

export interface MemberScope {
  /** The signed-in member: whose permissions apply. */
  actor: MemberRow;
  /** The member whose data is read and written. */
  member: MemberRow;
}

/** A scope in which `member` acts on their own data. */
export function selfScope(member: MemberRow): MemberScope {
  return { actor: member, member };
}

/** The scope of an authenticated request: the signed-in member, on their own data. */
export function requestScope(c: Context<AuthEnv>): MemberScope {
  return selfScope(c.get('member'));
}

/** Parents and admins may edit or delete catalogue books and formats; children may not. */
export function canEditCatalogue(scope: MemberScope): boolean {
  return scope.actor.role === 'parent' || scope.actor.isAdmin;
}

/** Throws 403 unless the actor may edit the shared catalogue. */
export function requireCatalogueEditor(scope: MemberScope, action: string): void {
  if (!canEditCatalogue(scope)) throw forbidden(`Ask a parent to ${action}`);
}

/**
 * Throws 403 unless the actor is a parent or an admin: household-wide data
 * (backups and restore, Bookpine import, the Notion mirror).
 */
export function requireParent(scope: MemberScope, action: string): void {
  if (scope.actor.role !== 'parent' && !scope.actor.isAdmin) {
    throw forbidden(`Only a parent can ${action}`);
  }
}

/** Middleware that answers 403 unless the signed-in member is a parent or an admin. */
export function parentsOnly(action: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    requireParent(requestScope(c), action);
    await next();
  };
}
