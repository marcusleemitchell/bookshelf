/**
 * Pure builders for offline changes (ADR 0007). Sync replicates rows and does
 * not repeat REST side effects (SPEC §5.1), so when the server is unreachable
 * the client applies the same read bookkeeping as the REST API itself
 * (SPEC §4) and queues every row it changed, in dependency order
 * (book → read → session). Each builder also returns the projected read model
 * so the UI reflects the queued change straight away.
 */
import type { z } from 'zod';
import {
  bookListItemSchema,
  computePercent,
  timerElapsedSeconds,
  type ActiveTimer,
  type BookDetail,
  type BookFormat,
  type BookListItem,
  type BookNote,
  type BookStatus,
  type ProgressUnit,
  type Read,
  type Session,
  type TimerResponse,
  type syncPayloadSchemas,
} from '../../../shared/index.ts';
import type { NewOp } from './outbox.ts';

export type BookPayload = z.input<typeof syncPayloadSchemas.book>;
export type ReadPayload = z.input<typeof syncPayloadSchemas.read>;
export type SessionPayload = z.input<typeof syncPayloadSchemas.session>;
export type TimerPayload = z.input<typeof syncPayloadSchemas.timer>;
export type NotePayload = z.input<typeof syncPayloadSchemas.note>;

/** The full syncable record of a book (its tag links are left unchanged). */
export function bookPayload(book: BookListItem): BookPayload {
  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle,
    authors: book.authors,
    publisher: book.publisher,
    publishedDate: book.publishedDate,
    language: book.language,
    synopsis: book.synopsis,
    coverUrl: book.coverUrl,
    isbn10: book.isbn10,
    isbn13: book.isbn13,
    genres: book.genres,
    source: book.source,
    sourceId: book.sourceId,
    status: book.status,
    rating: book.rating,
  };
}

export function readPayload(read: Read): ReadPayload {
  return {
    id: read.id,
    bookId: read.bookId,
    number: read.number,
    startedAt: read.startedAt,
    finishedAt: read.finishedAt,
    outcome: read.outcome,
  };
}

export function timerPayload(timer: ActiveTimer): TimerPayload {
  return {
    id: timer.id,
    bookId: timer.bookId,
    formatId: timer.formatId,
    startedAt: timer.startedAt,
    resumedAt: timer.resumedAt,
    pausedAt: timer.pausedAt,
    accumulatedSeconds: timer.accumulatedSeconds,
  };
}

export function notePayload(note: BookNote): NotePayload {
  return {
    id: note.id,
    bookId: note.bookId,
    kind: note.kind,
    text: note.text,
    location: note.location,
  };
}

/** The book's in-progress read with the highest number, if any. */
export function inProgressRead(reads: readonly Read[]): Read | null {
  let found: Read | null = null;
  for (const read of reads) {
    if (read.outcome === 'in_progress' && (found === null || read.number > found.number)) {
      found = read;
    }
  }
  return found;
}

/** The current read (SPEC §4): the live read with the highest number. */
export function latestRead(reads: readonly Read[]): Read | null {
  let found: Read | null = null;
  for (const read of reads) {
    if (found === null || read.number > found.number) found = read;
  }
  return found;
}

function nextReadNumber(reads: readonly Read[]): number {
  return reads.reduce((max, read) => Math.max(max, read.number), 0) + 1;
}

function newRead(
  bookId: string,
  reads: readonly Read[],
  fields: Pick<Read, 'id' | 'startedAt' | 'finishedAt' | 'outcome'>,
  at: string,
): Read {
  return {
    ...fields,
    bookId,
    number: nextReadNumber(reads),
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

function replaceRead(reads: readonly Read[], read: Read): Read[] {
  const others = reads.filter((r) => r.id !== read.id);
  return [...others, read].sort((a, b) => a.number - b.number);
}

/** A detail with its derived `currentRead` brought in line with `reads`. */
function withReads(detail: BookDetail, reads: Read[]): BookDetail {
  const currentRead = latestRead(reads);
  const sameRead = currentRead?.id === detail.currentRead?.id;
  return {
    ...detail,
    reads,
    currentRead,
    progressPercent: sameRead ? detail.progressPercent : null,
    estimatedFinish:
      sameRead && currentRead?.outcome === 'in_progress' ? detail.estimatedFinish : null,
  };
}

export interface OfflinePlan {
  ops: NewOp[];
  detail: BookDetail;
}

/**
 * Read bookkeeping for a status change, mirroring the REST API (SPEC §4):
 * `reading` opens a read if none is in progress; `finished`/`dnf` close the
 * in-progress read, or record a closed read when the book has none;
 * `to_read` and `paused` leave reads alone (paused keeps the read open).
 */
function statusReadChanges(
  detail: BookDetail,
  status: BookStatus,
  at: string,
  makeId: () => string,
): Read[] {
  const current = inProgressRead(detail.reads);
  if (status === 'reading') {
    if (current) return [];
    return [
      newRead(
        detail.id,
        detail.reads,
        { id: makeId(), startedAt: at, finishedAt: null, outcome: 'in_progress' },
        at,
      ),
    ];
  }
  if (status === 'finished' || status === 'dnf') {
    if (current) return [{ ...current, outcome: status, finishedAt: at, updatedAt: at }];
    if (detail.reads.length === 0) {
      return [
        newRead(
          detail.id,
          detail.reads,
          { id: makeId(), startedAt: at, finishedAt: at, outcome: status },
          at,
        ),
      ];
    }
  }
  return [];
}

/** Offline edit of a book's status and/or rating. */
export function planBookPatch(
  detail: BookDetail,
  patch: { status?: BookStatus; rating?: number | null },
  at: string,
  makeId: () => string,
): OfflinePlan {
  const updated: BookDetail = { ...detail, ...patch, updatedAt: at };
  const readChanges =
    patch.status !== undefined && patch.status !== detail.status
      ? statusReadChanges(detail, patch.status, at, makeId)
      : [];
  const ops: NewOp[] = [
    {
      entity: 'book',
      action: 'upsert',
      payload: bookPayload(updated),
      label: `Book: ${detail.title}`,
    },
    ...readChanges.map((read): NewOp => ({
      entity: 'read',
      action: 'upsert',
      payload: readPayload(read),
      label: `Read ${read.number}: ${detail.title}`,
    })),
  ];
  const reads = readChanges.reduce<Read[]>((all, read) => replaceRead(all, read), detail.reads);
  return { ops, detail: readChanges.length > 0 ? withReads(updated, reads) : updated };
}

/** The session fields the Log session form provides. */
export interface SessionInput {
  id: string;
  formatId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  progressUnit: ProgressUnit;
  startValue: number | null;
  endValue: number | null;
  note: string | null;
}

export interface OfflineSessionPlan extends OfflinePlan {
  session: Session;
}

/**
 * Offline session logging, mirroring `POST /api/sessions` (SPEC §4): uses the
 * in-progress read, opening one when there is none (sync never opens reads);
 * moves the read's start back for a retrospective session; and moves a
 * `to_read` or `paused` book to `reading`.
 */
export function planSession(
  detail: BookDetail,
  format: BookFormat,
  input: SessionInput,
  at: string,
  makeId: () => string,
): OfflineSessionPlan {
  const ops: NewOp[] = [];
  let book = detail;
  if (detail.status === 'to_read' || detail.status === 'paused') {
    book = { ...detail, status: 'reading', updatedAt: at };
    ops.push({
      entity: 'book',
      action: 'upsert',
      payload: bookPayload(book),
      label: `Book: ${detail.title}`,
    });
  }
  let read = inProgressRead(detail.reads);
  if (!read) {
    read = newRead(
      detail.id,
      detail.reads,
      { id: makeId(), startedAt: input.startedAt, finishedAt: null, outcome: 'in_progress' },
      at,
    );
  } else if (input.startedAt < read.startedAt) {
    read = { ...read, startedAt: input.startedAt, updatedAt: at };
  }
  const existing = detail.reads.find((r) => r.id === read.id);
  if (existing !== read) {
    ops.push({
      entity: 'read',
      action: 'upsert',
      payload: readPayload(read),
      label: `Read ${read.number}: ${detail.title}`,
    });
  }
  const payload: SessionPayload = {
    id: input.id,
    readId: read.id,
    bookId: detail.id,
    formatId: format.id,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSeconds: input.durationSeconds,
    progressUnit: input.progressUnit,
    startValue: input.startValue,
    endValue: input.endValue,
    note: input.note,
    source: 'app',
  };
  ops.push({ entity: 'session', action: 'upsert', payload, label: `Session: ${detail.title}` });

  const session: Session = {
    ...payload,
    source: 'app',
    startPercent: computePercent(input.progressUnit, input.startValue, format),
    endPercent: computePercent(input.progressUnit, input.endValue, format),
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  const projected = withReads(book, replaceRead(book.reads, read));
  const isCurrent = projected.currentRead?.id === read.id;
  return {
    ops,
    session,
    detail: {
      ...projected,
      progressPercent:
        isCurrent && session.endPercent !== null ? session.endPercent : projected.progressPercent,
    },
  };
}

/** Projects a detail change onto a library list item. */
export function toListItem(detail: BookDetail): BookListItem {
  return bookListItemSchema.parse(detail);
}

export class TimerTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimerTransitionError';
  }
}

/** A new running timer. */
export function startedTimer(
  id: string,
  bookId: string,
  formatId: string,
  at: string,
): ActiveTimer {
  return {
    id,
    bookId,
    formatId,
    startedAt: at,
    resumedAt: at,
    pausedAt: null,
    accumulatedSeconds: 0,
    createdAt: at,
    updatedAt: at,
  };
}

/** Pauses a running timer at `at`, folding the running segment into the total. */
export function pausedTimer(timer: ActiveTimer, at: string): ActiveTimer {
  if (timer.pausedAt !== null) throw new TimerTransitionError('The timer is already paused');
  return {
    ...timer,
    accumulatedSeconds: timerElapsedSeconds(timer, new Date(at)),
    pausedAt: at,
    updatedAt: at,
  };
}

/** Resumes a paused timer at `at`. */
export function resumedTimer(timer: ActiveTimer, at: string): ActiveTimer {
  if (timer.pausedAt === null) throw new TimerTransitionError('The timer is already running');
  if (Date.parse(at) < Date.parse(timer.pausedAt)) {
    throw new TimerTransitionError('Cannot resume before the time it was paused');
  }
  return { ...timer, pausedAt: null, resumedAt: at, updatedAt: at };
}

/** A `GET /api/timer`-shaped response computed locally at `now`. */
export function timerResponse(timer: ActiveTimer | null, now: Date): TimerResponse {
  return {
    timer,
    elapsedSeconds: timer ? timerElapsedSeconds(timer, now) : 0,
    serverTime: now.toISOString(),
  };
}
