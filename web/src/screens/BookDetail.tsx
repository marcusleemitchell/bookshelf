/**
 * Book detail (SPEC §6.4): cover, synopsis and metadata, formats, a progress
 * chart over time, the sessions list, notes & quotes, tags, rating, status
 * and rereads. Status, rating and notes work offline (outbox); the other
 * edits need the server.
 */
import { useState } from 'react';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import {
  bookDetailSchema,
  bookStatusSchema,
  formatAudioPosition,
  formatDate,
  formatDuration,
  formatPublishedDate,
  formatTypeSchema,
  languageName,
  noteListSchema,
  parseAudioPosition,
  sessionListSchema,
  tagListSchema,
  timerResponseSchema,
  type BookDetail,
  type BookFormat,
  type BookNote,
  type FormatType,
  type NoteKind,
  type Session,
  type Tag,
} from '../../../shared/index.ts';
import {
  deleteNote,
  saveNote,
  startTimer,
  storeDetail,
  updateBookProgress,
} from '../app/actions.ts';
import { useAction, useResource, useServices } from '../app/hooks.ts';
import { invalidate } from '../app/services.ts';
import { ChartFigure, DataTable, chartColours } from '../components/charts.tsx';
import { ActionError, Cover, ProgressBar, ResourceView, ScreenHeader } from '../components/ui.tsx';
import { formatTime } from '../lib/dates.ts';
import {
  FORMAT_LABELS,
  OUTCOME_LABELS,
  STATUS_LABELS,
  STATUS_ORDER,
  formatPercent,
  formatProgressValue,
  formatSummary,
  plural,
  ratingLabel,
  ratingStars,
} from '../lib/labels.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, navigate, paths } from '../router.ts';

export function BookDetailScreen({ bookId }: { bookId: string }) {
  const detail = useResource(cacheKeys.book(bookId), bookDetailSchema, (api) =>
    api.getBook(bookId),
  );
  return (
    <>
      <ScreenHeader title={detail.data?.title ?? 'Book'} back={paths.library()} />
      <ResourceView resource={detail} loadingLabel="Loading the book…">
        {(book) => <BookBody book={book} />}
      </ResourceView>
    </>
  );
}

const RATING_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

function BookBody({ book }: { book: BookDetail }) {
  const services = useServices();
  const { timeZone } = services;
  const sessions = useResource(cacheKeys.bookSessions(book.id), sessionListSchema, (api) =>
    api.listSessions({ bookId: book.id }),
  );
  const progressAction = useAction();
  const estimate = book.estimatedFinish;

  return (
    <div className="stack">
      <div className="book-hero">
        <Cover src={book.coverSrc} title={book.title} size="lg" />
        <div className="info">
          <h2>{book.title}</h2>
          {book.subtitle && <p className="muted">{book.subtitle}</p>}
          <p>{book.authors.join(', ') || 'Unknown author'}</p>
          {book.rating !== null && (
            <p className="rating-stars" aria-label={`Rated ${ratingLabel(book.rating)}`}>
              {ratingStars(book.rating)}
            </p>
          )}
          <p className="small muted">
            {book.formats.map((f) => FORMAT_LABELS[f.format]).join(' · ')}
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="book-status-select">Shelf</label>
          <select
            id="book-status-select"
            value={book.status}
            disabled={progressAction.busy}
            onChange={(event) => {
              const status = bookStatusSchema.parse(event.target.value);
              progressAction.run(() => updateBookProgress(services, book, { status }));
            }}
          >
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="book-rating-select">Rating</label>
          <select
            id="book-rating-select"
            value={book.rating === null ? '' : String(book.rating)}
            disabled={progressAction.busy}
            onChange={(event) => {
              const rating = event.target.value === '' ? null : Number(event.target.value);
              progressAction.run(() => updateBookProgress(services, book, { rating }));
            }}
          >
            <option value="">No rating</option>
            {RATING_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {ratingStars(value)} ({ratingLabel(value)})
              </option>
            ))}
          </select>
        </div>
      </div>
      <ActionError error={progressAction.error} />

      <section className="card stack-sm" aria-labelledby="progress-heading">
        <h2 id="progress-heading">Progress</h2>
        <ProgressBar percent={book.progressPercent} label="Reading progress" large />
        <p>
          {book.progressPercent === null
            ? 'No progress recorded for this read yet.'
            : `${formatPercent(book.progressPercent)} read`}
          {book.currentRead && book.currentRead.number > 1 && ` · read ${book.currentRead.number}`}
        </p>
        {estimate && (
          <p className="small muted">
            At {formatPercent(estimate.percentPerDay)} a day you’ll finish by{' '}
            {formatDate(estimate.date, timeZone)} ({plural(estimate.daysRemaining, 'day')}).
          </p>
        )}
        <div className="row">
          <a className="btn btn-primary" href={href(paths.log({ bookId: book.id }))}>
            Log session
          </a>
          <TimerButton book={book} />
          <RereadButton book={book} />
        </div>
      </section>

      <ResourceView resource={sessions} loadingLabel="Loading sessions…">
        {(list) => (
          <>
            <ProgressChart book={book} sessions={list} />
            <SessionsList book={book} sessions={list} />
          </>
        )}
      </ResourceView>

      <NotesSection book={book} />
      <TagsSection book={book} />
      <FormatsSection book={book} />
      <ReadsSection book={book} />
      <AboutSection book={book} />
      <DeleteBook book={book} />
    </div>
  );
}

function TimerButton({ book }: { book: BookDetail }) {
  const services = useServices();
  const timer = useResource(cacheKeys.timer, timerResponseSchema, (api) => api.getTimer());
  const { busy, error, run } = useAction();
  const format = book.formats[0];
  if (!format || !timer.data || timer.data.timer) return null;
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          run(async () => {
            await startTimer(services, book, format.id);
            navigate(paths.today());
          });
        }}
      >
        Start timer
      </button>
      <ActionError error={error} />
    </>
  );
}

function RereadButton({ book }: { book: BookDetail }) {
  const services = useServices();
  const { busy, error, run } = useAction();
  const inProgress = book.reads.some((read) => read.outcome === 'in_progress');
  if (inProgress || book.reads.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          run(async () => {
            await services.api.startReread(book.id, { id: services.newId() });
            await storeDetail(services, await services.api.getBook(book.id));
          });
        }}
      >
        Start a reread
      </button>
      <ActionError error={error} />
    </>
  );
}

function ProgressChart({ book, sessions }: { book: BookDetail; sessions: Session[] }) {
  const { timeZone } = useServices();
  const readId = book.currentRead?.id;
  const points = sessions
    .filter((s) => s.readId === readId && s.endPercent !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((s) => ({
      date: formatDate(s.startedAt, timeZone),
      percent: s.endPercent ?? 0,
    }));
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <section className="card" aria-labelledby="chart-heading">
      <h2 id="chart-heading">Progress over time</h2>
      <ChartFigure
        label="Progress over time"
        summary={`From ${formatPercent(first?.percent ?? 0)} on ${first?.date ?? ''} to ${formatPercent(last?.percent ?? 0)} on ${last?.date ?? ''}, over ${plural(points.length, 'session')}.`}
        table={
          <DataTable
            caption="Progress by session"
            columns={['Date', 'Progress']}
            rows={points.map((p) => [p.date, formatPercent(p.percent)])}
          />
        }
      >
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={chartColours.grid} strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fill: chartColours.text, fontSize: 11 }} />
          <YAxis domain={[0, 100]} tick={{ fill: chartColours.text, fontSize: 11 }} unit="%" />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="percent"
            stroke={chartColours.primary}
            strokeWidth={2}
            dot
          />
        </LineChart>
      </ChartFigure>
    </section>
  );
}

function SessionsList({ book, sessions }: { book: BookDetail; sessions: Session[] }) {
  const services = useServices();
  const { busy, error, run } = useAction();
  const formatOf = (id: string) => book.formats.find((f) => f.id === id);
  return (
    <section className="section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>
      {sessions.length === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <ul className="list card">
          {sessions.map((session) => {
            const format = formatOf(session.formatId);
            return (
              <li key={session.id} className="list-item">
                <div className="grow stack-sm">
                  <p>
                    <strong>{formatDate(session.startedAt, services.timeZone)}</strong>{' '}
                    <span className="muted small">
                      {formatTime(session.startedAt, services.timeZone)} ·{' '}
                      {formatDuration(session.durationSeconds)}
                      {format && ` · ${FORMAT_LABELS[format.format]}`}
                    </span>
                  </p>
                  <p className="small">
                    {formatProgressValue(session.progressUnit, session.startValue)} →{' '}
                    {formatProgressValue(session.progressUnit, session.endValue)}
                    {session.endPercent !== null && ` (${formatPercent(session.endPercent)})`}
                  </p>
                  {session.note && <p className="small muted">{session.note}</p>}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={busy}
                  aria-label={`Delete session on ${formatDate(session.startedAt, services.timeZone)}`}
                  onClick={() => {
                    if (!window.confirm('Delete this session?')) return;
                    run(async () => {
                      await services.api.deleteSession(session.id);
                      invalidate(services);
                    });
                  }}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ActionError error={error} />
    </section>
  );
}

function NotesSection({ book }: { book: BookDetail }) {
  const notes = useResource(cacheKeys.notes(book.id), noteListSchema, (api) =>
    api.listNotes(book.id),
  );
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section className="section" aria-labelledby="notes-heading">
      <h2 id="notes-heading">Notes &amp; quotes</h2>
      <ResourceView resource={notes} loadingLabel="Loading notes…">
        {(list) => (
          <>
            {list.length > 0 && (
              <ul className="list card">
                {list.map((note) => (
                  <li key={note.id} className="list-item">
                    {editing === note.id ? (
                      <NoteForm
                        book={book}
                        existing={note}
                        onDone={() => {
                          setEditing(null);
                        }}
                      />
                    ) : (
                      <NoteItem
                        book={book}
                        note={note}
                        onEdit={() => {
                          setEditing(note.id);
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <details className="card">
              <summary>Add a note or quote</summary>
              <NoteForm book={book} onDone={() => undefined} />
            </details>
          </>
        )}
      </ResourceView>
    </section>
  );
}

function NoteItem({
  book,
  note,
  onEdit,
}: {
  book: BookDetail;
  note: BookNote;
  onEdit: () => void;
}) {
  const services = useServices();
  const { busy, error, run } = useAction();
  return (
    <div className="grow stack-sm">
      {note.kind === 'quote' ? (
        <blockquote style={{ margin: 0, fontFamily: 'var(--font-serif)' }}>
          “{note.text}”
        </blockquote>
      ) : (
        <p style={{ whiteSpace: 'pre-line' }}>{note.text}</p>
      )}
      <div className="row-between">
        <span className="small muted">
          {note.kind === 'quote' ? 'Quote' : 'Note'}
          {note.location && ` · ${note.location}`}
        </span>
        <span className="row">
          <button type="button" className="btn btn-ghost btn-small" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete this ${note.kind}?`))
                run(() => deleteNote(services, book, note));
            }}
          >
            Delete
          </button>
        </span>
      </div>
      <ActionError error={error} />
    </div>
  );
}

function NoteForm({
  book,
  existing,
  onDone,
}: {
  book: BookDetail;
  existing?: BookNote;
  onDone: () => void;
}) {
  const services = useServices();
  const prefix = existing ? `note-${existing.id}` : 'note-new';
  const [kind, setKind] = useState<NoteKind>(existing?.kind ?? 'note');
  const [text, setText] = useState(existing?.text ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const { busy, error, run } = useAction();
  return (
    <form
      className="stack-sm grow"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === '') return;
        run(async () => {
          await saveNote(
            services,
            book,
            { kind, text: text.trim(), location: location.trim() || null },
            existing,
          );
          if (!existing) {
            setText('');
            setLocation('');
          }
          onDone();
        });
      }}
    >
      <div className="segmented" role="group" aria-label="Kind">
        {(['note', 'quote'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => {
              setKind(k);
            }}
          >
            {k === 'note' ? 'Note' : 'Quote'}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-text`}>{kind === 'quote' ? 'Quote' : 'Note'}</label>
        <textarea
          id={`${prefix}-text`}
          value={text}
          required
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-location`}>Location</label>
        <input
          id={`${prefix}-location`}
          placeholder="p. 42, 34% or 1:02:10"
          value={location}
          onChange={(event) => {
            setLocation(event.target.value);
          }}
        />
      </div>
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary btn-small"
          disabled={busy || text.trim() === ''}
        >
          {existing ? 'Save' : 'Add'}
        </button>
        {existing && (
          <button type="button" className="btn btn-ghost btn-small" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
      <ActionError error={error} />
    </form>
  );
}

function TagsSection({ book }: { book: BookDetail }) {
  const services = useServices();
  const tags = useResource(cacheKeys.tags, tagListSchema, (api) => api.listTags());
  const { busy, error, run } = useAction();
  const toggle = (tag: Tag) => {
    const next = book.tagIds.includes(tag.id)
      ? book.tagIds.filter((id) => id !== tag.id)
      : [...book.tagIds, tag.id];
    run(async () => {
      await storeDetail(services, await services.api.setBookTags(book.id, next));
    });
  };
  return (
    <section className="section" aria-labelledby="tags-heading">
      <h2 id="tags-heading">Tags</h2>
      {tags.data && tags.data.length > 0 ? (
        <div className="chips" role="group" aria-label="Tags">
          {tags.data.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="chip"
              aria-pressed={book.tagIds.includes(tag.id)}
              disabled={busy}
              onClick={() => {
                toggle(tag);
              }}
            >
              <span
                className="tag-dot"
                style={tag.colour ? { background: tag.colour } : undefined}
                aria-hidden="true"
              />
              {tag.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="small muted">
          No tags yet. <a href={href(paths.settings())}>Create tags in Settings</a>.
        </p>
      )}
      <ActionError error={error} />
    </section>
  );
}

function lengthText(format: BookFormat): string {
  if (format.format === 'audiobook') {
    return format.audioDurationSeconds ? formatAudioPosition(format.audioDurationSeconds) : '';
  }
  return format.pageCount ? String(format.pageCount) : '';
}

/** Parses a length input for a format type; null = unknown; string = error. */
function parseLength(
  format: FormatType,
  text: string,
): { pageCount: number | null; audioDurationSeconds: number | null } | string {
  const trimmed = text.trim();
  if (format === 'audiobook') {
    if (trimmed === '') return { pageCount: null, audioDurationSeconds: null };
    const seconds = parseAudioPosition(trimmed);
    if (seconds === null || seconds <= 0) return 'Use h:mm:ss for the audiobook length.';
    return { pageCount: null, audioDurationSeconds: seconds };
  }
  if (trimmed === '') return { pageCount: null, audioDurationSeconds: null };
  const pages = Number(trimmed);
  if (!Number.isInteger(pages) || pages <= 0)
    return 'The page count must be a whole number above zero.';
  return { pageCount: pages, audioDurationSeconds: null };
}

function FormatsSection({ book }: { book: BookDetail }) {
  const services = useServices();
  const { busy, error, run } = useAction();
  const [validation, setValidation] = useState<string | null>(null);
  const missing = formatTypeSchema.options.filter(
    (f) => !book.formats.some((bf) => bf.format === f),
  );
  const [newFormat, setNewFormat] = useState<FormatType | ''>('');
  const [newLength, setNewLength] = useState('');
  const refresh = async () => {
    await storeDetail(services, await services.api.getBook(book.id));
  };
  return (
    <section className="section" aria-labelledby="formats-heading">
      <h2 id="formats-heading">Formats</h2>
      {book.formats.length > 0 && (
        <ul className="list card">
          {book.formats.map((format) => (
            <li key={format.id} className="list-item">
              <FormatRow
                format={format}
                busy={busy}
                onSave={(text) => {
                  const parsed = parseLength(format.format, text);
                  if (typeof parsed === 'string') {
                    setValidation(parsed);
                    return;
                  }
                  setValidation(null);
                  run(async () => {
                    await services.api.updateFormat(book.id, format.id, parsed);
                    await refresh();
                  });
                }}
                onDelete={() => {
                  if (
                    !window.confirm(
                      `Remove the ${FORMAT_LABELS[format.format].toLowerCase()} format?`,
                    )
                  )
                    return;
                  run(async () => {
                    await services.api.deleteFormat(book.id, format.id);
                    await refresh();
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <form
          className="card stack-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (newFormat === '') return;
            const parsed = parseLength(newFormat, newLength);
            if (typeof parsed === 'string') {
              setValidation(parsed);
              return;
            }
            setValidation(null);
            run(async () => {
              await services.api.createFormat(book.id, {
                id: services.newId(),
                format: newFormat,
                ...parsed,
              });
              setNewFormat('');
              setNewLength('');
              await refresh();
            });
          }}
        >
          <h3>Add a format</h3>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="new-format">Format</label>
              <select
                id="new-format"
                value={newFormat}
                onChange={(event) => {
                  const value = event.target.value;
                  setNewFormat(value === '' ? '' : formatTypeSchema.parse(value));
                }}
              >
                <option value="">Choose…</option>
                {missing.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="new-format-length">
                {newFormat === 'audiobook' ? 'Length (h:mm:ss)' : 'Page count'}
              </label>
              <input
                id="new-format-length"
                value={newLength}
                onChange={(event) => {
                  setNewLength(event.target.value);
                }}
              />
            </div>
          </div>
          <button type="submit" className="btn btn-small" disabled={busy || newFormat === ''}>
            Add format
          </button>
        </form>
      )}
      {validation && (
        <p className="error-text" role="alert">
          {validation}
        </p>
      )}
      <ActionError error={error} />
    </section>
  );
}

function FormatRow({
  format,
  busy,
  onSave,
  onDelete,
}: {
  format: BookFormat;
  busy: boolean;
  onSave: (lengthText: string) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(lengthText(format));
  const id = `format-length-${format.id}`;
  return (
    <form
      className="grow stack-sm"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text);
      }}
    >
      <p>
        <strong>{FORMAT_LABELS[format.format]}</strong>{' '}
        <span className="small muted">{formatSummary(format).split(' · ')[1]}</span>
      </p>
      <div className="row">
        <label htmlFor={id} className="sr-only">
          {FORMAT_LABELS[format.format]}{' '}
          {format.format === 'audiobook' ? 'length (h:mm:ss)' : 'page count'}
        </label>
        <input
          id={id}
          style={{ flex: 1, minWidth: '6rem' }}
          placeholder={format.format === 'audiobook' ? 'h:mm:ss' : 'Pages'}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <button type="submit" className="btn btn-small" disabled={busy}>
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={busy}
          onClick={onDelete}
        >
          Remove
        </button>
      </div>
    </form>
  );
}

function ReadsSection({ book }: { book: BookDetail }) {
  const { timeZone } = useServices();
  if (book.reads.length === 0) return null;
  return (
    <section className="section" aria-labelledby="reads-heading">
      <h2 id="reads-heading">Reads</h2>
      <ul className="list card">
        {[...book.reads]
          .sort((a, b) => b.number - a.number)
          .map((read) => (
            <li key={read.id} className="list-item">
              <div className="grow">
                <strong>{read.number === 1 ? 'First read' : `Reread ${read.number - 1}`}</strong>
                <p className="small muted">
                  {formatDate(read.startedAt, timeZone)}
                  {read.finishedAt && ` – ${formatDate(read.finishedAt, timeZone)}`} ·{' '}
                  {OUTCOME_LABELS[read.outcome]}
                </p>
              </div>
            </li>
          ))}
      </ul>
    </section>
  );
}

function AboutSection({ book }: { book: BookDetail }) {
  const rows: [string, string | null][] = [
    ['Publisher', book.publisher],
    ['Published', book.publishedDate && formatPublishedDate(book.publishedDate)],
    ['ISBN-13', book.isbn13],
    ['ISBN-10', book.isbn10],
    ['Language', book.language && languageName(book.language)],
    ['Genres', book.genres.length > 0 ? book.genres.join(', ') : null],
    [
      'Source',
      book.source === 'openlibrary'
        ? 'Open Library'
        : book.source === 'googlebooks'
          ? 'Google Books'
          : 'Entered manually',
    ],
  ];
  return (
    <section className="section" aria-labelledby="about-heading">
      <h2 id="about-heading">About</h2>
      {book.synopsis && <p className="synopsis">{book.synopsis}</p>}
      <dl
        className="card"
        style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px' }}
      >
        {rows
          .filter((row): row is [string, string] => row[1] !== null)
          .map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt className="muted small">{label}</dt>
              <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

function DeleteBook({ book }: { book: BookDetail }) {
  const services = useServices();
  const { busy, error, run } = useAction();
  return (
    <section className="section">
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(`Delete “${book.title}” and all its sessions and notes?`)) return;
          run(async () => {
            await services.api.deleteBook(book.id);
            invalidate(services);
            navigate(paths.library(), { replace: true });
          });
        }}
      >
        Delete book
      </button>
      <ActionError error={error} />
    </section>
  );
}
