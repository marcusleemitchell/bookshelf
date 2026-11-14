/**
 * Offline-capable writes (SPEC §2 "Offline", ADR 0004/0007): session logging,
 * timer actions, book status/rating edits and notes. Each tries the REST API
 * first; when the server is unreachable it queues the full records in the
 * outbox and updates the cached read model so the change shows immediately.
 * Every other write is online-only and simply throws {@link OfflineError}.
 *
 * Before an online write, any pending outbox ops are replayed so changes
 * reach the server in the order they were made.
 */
import {
  bookListSchema,
  noteListSchema,
  sessionListSchema,
  type ActiveTimer,
  type BookDetail,
  type BookFormat,
  type BookNote,
  type BookStatus,
  type NoteKind,
} from '../../../shared/index.ts';
import { ApiError, isOfflineError } from '../api/client.ts';
import { cacheKeys } from '../offline/cache.ts';
import {
  notePayload,
  pausedTimer,
  planBookPatch,
  planSession,
  resumedTimer,
  startedTimer,
  timerPayload,
  timerResponse,
  toListItem,
  type SessionInput,
} from '../offline/records.ts';
import { invalidate, showToast, type Services } from './services.ts';

export interface WriteResult {
  /** True when the change was queued for sync instead of reaching the server. */
  queued: boolean;
}

export const QUEUED_MESSAGE = 'Saved on this device. It will sync when the server is reachable.';

async function flushOutbox(services: Services): Promise<void> {
  const { pending } = await services.outbox.counts();
  if (pending > 0) await services.outbox.replay();
}

/** Runs an online write, or the offline fallback when the server is unreachable. */
async function withFallback(
  services: Services,
  online: () => Promise<void>,
  offline: () => Promise<void>,
): Promise<WriteResult> {
  await flushOutbox(services);
  try {
    await online();
    return { queued: false };
  } catch (error) {
    if (!isOfflineError(error)) throw error;
    await offline();
    return { queued: true };
  }
}

function finish(services: Services, result: WriteResult): WriteResult {
  if (result.queued) showToast(services, QUEUED_MESSAGE);
  invalidate(services);
  return result;
}

/** Stores a projected book detail in the cache (detail and library list). */
async function projectBook(services: Services, detail: BookDetail): Promise<void> {
  await services.cache.put(cacheKeys.book(detail.id), detail);
  await services.cache.update(cacheKeys.books, bookListSchema, (books) =>
    books.map((book) => (book.id === detail.id ? toListItem(detail) : book)),
  );
}

async function cacheTimer(services: Services, timer: ActiveTimer | null): Promise<void> {
  await services.cache.put(cacheKeys.timer, timerResponse(timer, services.now()));
}

export interface LogSessionArgs {
  detail: BookDetail;
  format: BookFormat;
  input: SessionInput;
  /** The timer this session was logged from; discarded once the session is saved. */
  timer?: ActiveTimer | null;
}

/** Logs a session (Log session screen), then discards the timer it came from. */
export async function logSession(services: Services, args: LogSessionArgs): Promise<WriteResult> {
  const { detail, format, input } = args;
  const result = await withFallback(
    services,
    async () => {
      await services.api.createSession({
        id: input.id,
        bookId: detail.id,
        formatId: format.id,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds: input.durationSeconds,
        progressUnit: input.progressUnit,
        startValue: input.startValue,
        endValue: input.endValue,
        note: input.note,
      });
    },
    async () => {
      const plan = planSession(detail, format, input, services.now().toISOString(), services.newId);
      await services.outbox.enqueue(plan.ops);
      await projectBook(services, plan.detail);
      await services.cache.update(cacheKeys.bookSessions(detail.id), sessionListSchema, (list) => [
        plan.session,
        ...list,
      ]);
    },
  );
  let queued = result.queued;
  if (args.timer) {
    const discarded = await discardTimerInternal(services, args.timer);
    queued ||= discarded.queued;
  }
  return finish(services, { queued });
}

async function discardTimerInternal(services: Services, timer: ActiveTimer): Promise<WriteResult> {
  return withFallback(
    services,
    async () => {
      try {
        await services.api.deleteTimer();
      } catch (error) {
        // Already gone (e.g. discarded on another device): nothing to do.
        if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
      }
      await cacheTimer(services, null);
    },
    async () => {
      await services.outbox.enqueue([
        { entity: 'timer', action: 'delete', payload: { id: timer.id }, label: 'Discard timer' },
      ]);
      await cacheTimer(services, null);
    },
  );
}

/** Discards the active timer without logging a session. */
export async function discardTimer(services: Services, timer: ActiveTimer): Promise<WriteResult> {
  return finish(services, await discardTimerInternal(services, timer));
}

/** Starts the timer for a book format. */
export async function startTimer(
  services: Services,
  book: { id: string; title: string },
  formatId: string,
): Promise<WriteResult> {
  const id = services.newId();
  const result = await withFallback(
    services,
    async () => {
      const response = await services.api.putTimer({
        action: 'start',
        id,
        bookId: book.id,
        formatId,
      });
      await services.cache.put(cacheKeys.timer, response);
    },
    async () => {
      const timer = startedTimer(id, book.id, formatId, services.now().toISOString());
      await services.outbox.enqueue([
        {
          entity: 'timer',
          action: 'upsert',
          payload: timerPayload(timer),
          label: `Start timer: ${book.title}`,
        },
      ]);
      await cacheTimer(services, timer);
    },
  );
  return finish(services, result);
}

async function changeTimer(
  services: Services,
  timer: ActiveTimer,
  action: 'pause' | 'resume',
): Promise<WriteResult> {
  const result = await withFallback(
    services,
    async () => {
      const response = await services.api.putTimer({ action });
      await services.cache.put(cacheKeys.timer, response);
    },
    async () => {
      const at = services.now().toISOString();
      const next = action === 'pause' ? pausedTimer(timer, at) : resumedTimer(timer, at);
      await services.outbox.enqueue([
        {
          entity: 'timer',
          action: 'upsert',
          payload: timerPayload(next),
          label: action === 'pause' ? 'Pause timer' : 'Resume timer',
        },
      ]);
      await cacheTimer(services, next);
    },
  );
  return finish(services, result);
}

export const pauseTimer = (services: Services, timer: ActiveTimer) =>
  changeTimer(services, timer, 'pause');
export const resumeTimer = (services: Services, timer: ActiveTimer) =>
  changeTimer(services, timer, 'resume');

/** Changes a book's status and/or rating (REST does the read bookkeeping; offline mirrors it). */
export async function updateBookProgress(
  services: Services,
  detail: BookDetail,
  patch: { status?: BookStatus; rating?: number | null },
): Promise<WriteResult> {
  const result = await withFallback(
    services,
    async () => {
      const updated = await services.api.updateBook(detail.id, patch);
      await services.cache.put(cacheKeys.book(detail.id), updated);
    },
    async () => {
      const plan = planBookPatch(detail, patch, services.now().toISOString(), services.newId);
      await services.outbox.enqueue(plan.ops);
      await projectBook(services, plan.detail);
    },
  );
  return finish(services, result);
}

export interface NoteInput {
  kind: NoteKind;
  text: string;
  location: string | null;
}

/** Creates a note/quote, or updates `existing`. */
export async function saveNote(
  services: Services,
  book: { id: string; title: string },
  input: NoteInput,
  existing?: BookNote,
): Promise<WriteResult> {
  const id = existing?.id ?? services.newId();
  const result = await withFallback(
    services,
    async () => {
      if (existing) await services.api.updateNote(book.id, id, input);
      else await services.api.createNote(book.id, { id, ...input });
    },
    async () => {
      const at = services.now().toISOString();
      const note: BookNote = {
        id,
        bookId: book.id,
        ...input,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        deletedAt: null,
      };
      await services.outbox.enqueue([
        {
          entity: 'note',
          action: 'upsert',
          payload: notePayload(note),
          label: `${input.kind === 'quote' ? 'Quote' : 'Note'}: ${book.title}`,
        },
      ]);
      await services.cache.update(cacheKeys.notes(book.id), noteListSchema, (notes) =>
        existing ? notes.map((n) => (n.id === id ? note : n)) : [...notes, note],
      );
    },
  );
  return finish(services, result);
}

export async function deleteNote(
  services: Services,
  book: { id: string; title: string },
  note: BookNote,
): Promise<WriteResult> {
  const result = await withFallback(
    services,
    async () => {
      await services.api.deleteNote(book.id, note.id);
    },
    async () => {
      await services.outbox.enqueue([
        {
          entity: 'note',
          action: 'delete',
          payload: { id: note.id },
          label: `Delete ${note.kind}: ${book.title}`,
        },
      ]);
      await services.cache.update(cacheKeys.notes(book.id), noteListSchema, (notes) =>
        notes.filter((n) => n.id !== note.id),
      );
    },
  );
  return finish(services, result);
}

/** Keeps the cached detail in line after an online-only write that returned it. */
export async function storeDetail(services: Services, detail: BookDetail): Promise<void> {
  await services.cache.put(cacheKeys.book(detail.id), detail);
  invalidate(services);
}
