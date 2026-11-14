/**
 * Tags (SPEC §4): names are unique case-insensitively among live tags.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Tag, TagUpdate, tagCreateSchema } from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound } from '../http/errors.ts';
import { findTag, findTagByName, listTags, softDeleteTag } from '../repositories/records.ts';
import { findById, insertRow, tagsTable, upsertRow } from '../repositories/tables.ts';

export { listTags };

function assertUniqueName(ctx: AppContext, name: string, exceptId?: string): void {
  if (findTagByName(ctx.db, name, exceptId)) throw conflict(`A tag named "${name}" already exists`);
}

export function createTag(ctx: AppContext, input: z.output<typeof tagCreateSchema>): Tag {
  const at = nowIso(ctx);
  const tag: Tag = {
    id: input.id ?? randomUUID(),
    name: input.name,
    colour: input.colour,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  transaction(ctx.db, () => {
    if (findById(ctx.db, tagsTable, tag.id))
      throw conflict(`A record with id ${tag.id} already exists`);
    assertUniqueName(ctx, tag.name);
    insertRow(ctx.db, tagsTable, tag);
  });
  return tag;
}

function requireTag(ctx: AppContext, id: string): Tag {
  const tag = findTag(ctx.db, id);
  if (!tag) throw notFound('Tag');
  return tag;
}

export function updateTag(ctx: AppContext, id: string, patch: TagUpdate): Tag {
  const tag: Tag = { ...requireTag(ctx, id), ...patch, updatedAt: nowIso(ctx) };
  transaction(ctx.db, () => {
    assertUniqueName(ctx, tag.name, id);
    upsertRow(ctx.db, tagsTable, tag);
  });
  return tag;
}

/** Soft-deletes the tag and unlinks it from every book. */
export function deleteTag(ctx: AppContext, id: string): void {
  requireTag(ctx, id);
  transaction(ctx.db, () => {
    softDeleteTag(ctx.db, id, nowIso(ctx));
  });
}
