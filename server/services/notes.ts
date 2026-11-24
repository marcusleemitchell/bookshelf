/**
 * Book notes and quotes (SPEC §4): each member's own, on books on their
 * shelf. Private by default (ADR 0010); sharing comes with member management.
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { BookNote, NoteUpdate, noteCreateSchema } from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound } from '../http/errors.ts';
import { bookNotes, findNote, softDelete } from '../repositories/records.ts';
import { findById, insertRow, notesTable, upsertRow, type Owned } from '../repositories/tables.ts';
import { requireBook } from './library.ts';
import type { MemberScope } from './scope.ts';

export function listNotes(ctx: AppContext, scope: MemberScope, bookId: string): BookNote[] {
  requireBook(ctx, scope, bookId);
  return bookNotes(ctx.db, scope.member.id, bookId);
}

export function createNote(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  input: z.output<typeof noteCreateSchema>,
): BookNote {
  requireBook(ctx, scope, bookId);
  const at = nowIso(ctx);
  const note: Owned<BookNote> = {
    id: input.id ?? randomUUID(),
    memberId: scope.member.id,
    bookId,
    kind: input.kind,
    text: input.text,
    location: input.location,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  transaction(ctx.db, () => {
    if (findById(ctx.db, notesTable, note.id))
      throw conflict(`A record with id ${note.id} already exists`);
    insertRow(ctx.db, notesTable, note);
  });
  return note;
}

function requireNote(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  noteId: string,
): Owned<BookNote> {
  requireBook(ctx, scope, bookId);
  const note = findNote(ctx.db, scope.member.id, noteId);
  if (note?.bookId !== bookId) throw notFound('Note');
  return note;
}

export function updateNote(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  noteId: string,
  patch: NoteUpdate,
): BookNote {
  const note: Owned<BookNote> = {
    ...requireNote(ctx, scope, bookId, noteId),
    ...patch,
    updatedAt: nowIso(ctx),
  };
  upsertRow(ctx.db, notesTable, note);
  return note;
}

export function deleteNote(
  ctx: AppContext,
  scope: MemberScope,
  bookId: string,
  noteId: string,
): void {
  requireNote(ctx, scope, bookId, noteId);
  softDelete(ctx.db, 'book_notes', noteId, nowIso(ctx));
}
