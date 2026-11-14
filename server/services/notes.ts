/**
 * Book notes and quotes (SPEC §4).
 */
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { BookNote, NoteUpdate, noteCreateSchema } from '../../shared/index.ts';
import { nowIso, type AppContext } from '../context.ts';
import { transaction } from '../db/database.ts';
import { conflict, notFound } from '../http/errors.ts';
import { bookNotes, findNote, softDelete } from '../repositories/records.ts';
import { findById, insertRow, notesTable, upsertRow } from '../repositories/tables.ts';
import { requireBook } from './library.ts';

export function listNotes(ctx: AppContext, bookId: string): BookNote[] {
  requireBook(ctx, bookId);
  return bookNotes(ctx.db, bookId);
}

export function createNote(
  ctx: AppContext,
  bookId: string,
  input: z.output<typeof noteCreateSchema>,
): BookNote {
  requireBook(ctx, bookId);
  const at = nowIso(ctx);
  const note: BookNote = {
    id: input.id ?? randomUUID(),
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

function requireNote(ctx: AppContext, bookId: string, noteId: string): BookNote {
  requireBook(ctx, bookId);
  const note = findNote(ctx.db, noteId);
  if (note?.bookId !== bookId) throw notFound('Note');
  return note;
}

export function updateNote(
  ctx: AppContext,
  bookId: string,
  noteId: string,
  patch: NoteUpdate,
): BookNote {
  const note: BookNote = { ...requireNote(ctx, bookId, noteId), ...patch, updatedAt: nowIso(ctx) };
  upsertRow(ctx.db, notesTable, note);
  return note;
}

export function deleteNote(ctx: AppContext, bookId: string, noteId: string): void {
  requireNote(ctx, bookId, noteId);
  softDelete(ctx.db, 'book_notes', noteId, nowIso(ctx));
}
