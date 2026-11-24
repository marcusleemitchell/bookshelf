/**
 * Tags (SPEC §4): each member's own; names are unique case-insensitively
 * among the member's live tags.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Tag, TagUpdate, tagCreateSchema } from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound } from '../http/errors.ts';
import {
  findTag,
  findTagByName,
  listTags as listMemberTags,
  softDeleteTag,
} from '../repositories/records.ts';
import { findById, insertRow, tagsTable, upsertRow, type Owned } from '../repositories/tables.ts';
import type { MemberScope } from './scope.ts';

export function listTags(ctx: AppContext, scope: MemberScope): Tag[] {
  return listMemberTags(ctx.db, scope.member.id);
}

function assertUniqueName(
  ctx: AppContext,
  scope: MemberScope,
  name: string,
  exceptId?: string,
): void {
  if (findTagByName(ctx.db, scope.member.id, name, exceptId)) {
    throw conflict(`A tag named "${name}" already exists`);
  }
}

export function createTag(
  ctx: AppContext,
  scope: MemberScope,
  input: z.output<typeof tagCreateSchema>,
): Tag {
  const at = nowIso(ctx);
  const tag: Owned<Tag> = {
    id: input.id ?? randomUUID(),
    memberId: scope.member.id,
    name: input.name,
    colour: input.colour,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  transaction(ctx.db, () => {
    if (findById(ctx.db, tagsTable, tag.id))
      throw conflict(`A record with id ${tag.id} already exists`);
    assertUniqueName(ctx, scope, tag.name);
    insertRow(ctx.db, tagsTable, tag);
  });
  return tag;
}

function requireTag(ctx: AppContext, scope: MemberScope, id: string): Owned<Tag> {
  const tag = findTag(ctx.db, scope.member.id, id);
  if (!tag) throw notFound('Tag');
  return tag;
}

export function updateTag(ctx: AppContext, scope: MemberScope, id: string, patch: TagUpdate): Tag {
  const tag: Owned<Tag> = { ...requireTag(ctx, scope, id), ...patch, updatedAt: nowIso(ctx) };
  transaction(ctx.db, () => {
    assertUniqueName(ctx, scope, tag.name, id);
    upsertRow(ctx.db, tagsTable, tag);
  });
  return tag;
}

/** Soft-deletes the tag and unlinks it from every book. */
export function deleteTag(ctx: AppContext, scope: MemberScope, id: string): void {
  requireTag(ctx, scope, id);
  transaction(ctx.db, () => {
    softDeleteTag(ctx.db, id, nowIso(ctx));
  });
}
