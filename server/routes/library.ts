/**
 * Library routes: books, formats, reads, book tags, notes and covers. Every
 * route works on the signed-in member's shelf (ADR 0010).
 */
import { Hono } from 'hono';
import {
  bookCreateSchema,
  bookDetailSchema,
  bookFormatSchema,
  bookListQuerySchema,
  bookListSchema,
  bookNoteSchema,
  bookTagsPutSchema,
  bookUpdateSchema,
  formatCreateSchema,
  formatUpdateSchema,
  noteCreateSchema,
  noteListSchema,
  noteUpdateSchema,
  readCreateSchema,
  readSchema,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import type { AuthEnv } from '../http/auth.ts';
import { notFound } from '../http/errors.ts';
import { readJson, readParam, readQuery, respond } from '../http/validate.ts';
import { findCatalogueBook } from '../repositories/books.ts';
import { resolveCover } from '../services/covers.ts';
import {
  createBook,
  createFormat,
  deleteBook,
  deleteFormat,
  getBookDetail,
  listBookItems,
  setBookTags,
  startReread,
  updateBook,
  updateFormat,
} from '../services/library.ts';
import { createNote, deleteNote, listNotes, updateNote } from '../services/notes.ts';
import { requestScope as scope } from '../services/scope.ts';

export function libraryRoutes(ctx: AppContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get('/books', (c) =>
    respond(c, bookListSchema, listBookItems(ctx, scope(c), readQuery(c, bookListQuerySchema))),
  );
  app.post('/books', async (c) =>
    respond(
      c,
      bookDetailSchema,
      await createBook(ctx, scope(c), await readJson(c, bookCreateSchema)),
      201,
    ),
  );
  app.get('/books/:id', (c) =>
    respond(c, bookDetailSchema, getBookDetail(ctx, scope(c), readParam(c, 'id'))),
  );
  app.patch('/books/:id', async (c) => {
    const id = readParam(c, 'id');
    return respond(
      c,
      bookDetailSchema,
      await updateBook(ctx, scope(c), id, await readJson(c, bookUpdateSchema)),
    );
  });
  app.delete('/books/:id', (c) => {
    deleteBook(ctx, scope(c), readParam(c, 'id'));
    return c.body(null, 204);
  });

  app.post('/books/:id/formats', async (c) => {
    const id = readParam(c, 'id');
    return respond(
      c,
      bookFormatSchema,
      createFormat(ctx, scope(c), id, await readJson(c, formatCreateSchema)),
      201,
    );
  });
  app.patch('/books/:id/formats/:formatId', async (c) => {
    const id = readParam(c, 'id');
    const formatId = readParam(c, 'formatId');
    const patch = await readJson(c, formatUpdateSchema);
    return respond(c, bookFormatSchema, updateFormat(ctx, scope(c), id, formatId, patch));
  });
  app.delete('/books/:id/formats/:formatId', (c) => {
    deleteFormat(ctx, scope(c), readParam(c, 'id'), readParam(c, 'formatId'));
    return c.body(null, 204);
  });

  app.post('/books/:id/reads', async (c) => {
    const id = readParam(c, 'id');
    return respond(
      c,
      readSchema,
      startReread(ctx, scope(c), id, await readJson(c, readCreateSchema)),
      201,
    );
  });

  app.put('/books/:id/tags', async (c) => {
    const id = readParam(c, 'id');
    const { tagIds } = await readJson(c, bookTagsPutSchema);
    return respond(c, bookDetailSchema, setBookTags(ctx, scope(c), id, tagIds));
  });

  app.get('/books/:id/notes', (c) =>
    respond(c, noteListSchema, listNotes(ctx, scope(c), readParam(c, 'id'))),
  );
  app.post('/books/:id/notes', async (c) => {
    const id = readParam(c, 'id');
    return respond(
      c,
      bookNoteSchema,
      createNote(ctx, scope(c), id, await readJson(c, noteCreateSchema)),
      201,
    );
  });
  app.patch('/books/:id/notes/:noteId', async (c) => {
    const id = readParam(c, 'id');
    const noteId = readParam(c, 'noteId');
    return respond(
      c,
      bookNoteSchema,
      updateNote(ctx, scope(c), id, noteId, await readJson(c, noteUpdateSchema)),
    );
  });
  app.delete('/books/:id/notes/:noteId', (c) => {
    deleteNote(ctx, scope(c), readParam(c, 'id'), readParam(c, 'noteId'));
    return c.body(null, 204);
  });

  app.get('/covers/:bookId', async (c) => {
    // Covers belong to the shared catalogue.
    const book = findCatalogueBook(ctx.db, readParam(c, 'bookId'));
    if (!book || book.deletedAt !== null) throw notFound('Book');
    const cover = await resolveCover(ctx, book);
    if (cover.kind === 'none') throw notFound('Cover');
    if (cover.kind === 'redirect') return c.redirect(cover.url, 302);
    return c.body(new Uint8Array(cover.bytes), 200, {
      'Content-Type': cover.contentType,
      'Cache-Control': 'private, max-age=86400',
    });
  });

  return app;
}
