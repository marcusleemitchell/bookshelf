/**
 * Log session (SPEC §6.5): book, format, start/end or duration, progress in
 * the format's natural unit (pages / h:mm:ss) and percent side by side, and a
 * note. From the timer ("Stop & log") it is prefilled from `GET /api/timer`
 * (`elapsedSeconds`, `serverTime`) and the timer is discarded once the
 * session is saved. Works offline via the outbox.
 */
import { useState, type ReactNode } from 'react';
import {
  bookDetailSchema,
  bookListSchema,
  computePercent,
  formatDuration,
  percentToUnit,
  timerElapsedSeconds,
  timerResponseSchema,
  type BookDetail,
  type BookFormat,
  type BookListItem,
  type ProgressUnit,
  type TimerResponse,
} from '../../../shared/index.ts';
import { logSession } from '../app/actions.ts';
import { useAction, useResource, useServices } from '../app/hooks.ts';
import { ActionError, Cover, Loading, ResourceView, ScreenHeader } from '../components/ui.tsx';
import { fromLocalInput, toLocalInput } from '../lib/dates.ts';
import {
  FORMAT_LABELS,
  UNIT_LABELS,
  formatSummary,
  naturalUnit,
  parseProgressInput,
  plural,
  progressInputValue,
} from '../lib/labels.ts';

/** The unit shown in the From/To labels: `page`, `percent` or `h:mm:ss`. */
function unitHint(unit: ProgressUnit): string {
  return unit === 'audio_seconds' ? 'h:mm:ss' : UNIT_LABELS[unit].toLowerCase();
}
import { cacheKeys } from '../offline/cache.ts';
import { href, navigate, paths } from '../router.ts';

const MAX_DURATION_SECONDS = 7 * 86_400;

export function LogSession({ bookId, fromTimer }: { bookId: string | null; fromTimer: boolean }) {
  const timer = useResource(fromTimer ? cacheKeys.timer : null, timerResponseSchema, (api) =>
    api.getTimer(),
  );
  if (fromTimer) {
    // Wait for the fresh server answer (or the cached copy when offline)
    // so the form is prefilled with the final elapsed time.
    if (timer.loading)
      return (
        <Shell>
          <Loading label="Reading the timer…" />
        </Shell>
      );
    const response = timer.data;
    if (!response?.timer) {
      return (
        <Shell>
          <p className="empty">
            There is no timer running. <a href={href(paths.log())}>Log a session manually</a>.
          </p>
        </Shell>
      );
    }
    return (
      <Shell>
        <BookStep
          bookId={response.timer.bookId}
          timer={response}
          timerFromCache={timer.fromCache}
        />
      </Shell>
    );
  }
  return (
    <Shell>
      <BookStep bookId={bookId} timer={null} timerFromCache={false} />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <ScreenHeader title="Log session" back={paths.today()} />
      {children}
    </>
  );
}

function sortForPicker(books: BookListItem[]): BookListItem[] {
  const rank = { reading: 0, paused: 1, to_read: 2, finished: 3, dnf: 4 } as const;
  return [...books].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title, 'en-GB'),
  );
}

function BookStep({
  bookId,
  timer,
  timerFromCache,
}: {
  bookId: string | null;
  timer: TimerResponse | null;
  timerFromCache: boolean;
}) {
  const books = useResource(cacheKeys.books, bookListSchema, (api) => api.listBooks());
  const [selected, setSelected] = useState(bookId ?? '');
  const detail = useResource(selected ? cacheKeys.book(selected) : null, bookDetailSchema, (api) =>
    api.getBook(selected),
  );
  return (
    <div className="stack">
      {!timer && (
        <div className="field">
          <label htmlFor="log-book">Book</label>
          <select
            id="log-book"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
            }}
          >
            <option value="">Choose a book…</option>
            {sortForPicker(books.data ?? []).map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {selected && (
        <ResourceView resource={detail} loadingLabel="Loading the book…">
          {(book) => (
            <SessionForm key={book.id} book={book} timer={timer} timerFromCache={timerFromCache} />
          )}
        </ResourceView>
      )}
    </div>
  );
}

type TimingMode = 'range' | 'duration';

interface Prefill {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  formatId: string;
}

function prefill(
  book: BookDetail,
  timer: TimerResponse | null,
  timerFromCache: boolean,
  now: Date,
): Prefill {
  const firstFormat = book.formats[0]?.id ?? '';
  if (timer?.timer) {
    // Fresh answer: the server's elapsed time at serverTime. Offline: derive
    // it from the cached timestamps at the current time.
    const end = timerFromCache ? now.toISOString() : timer.serverTime;
    const elapsed = timerFromCache ? timerElapsedSeconds(timer.timer, now) : timer.elapsedSeconds;
    return {
      startedAt: timer.timer.startedAt,
      endedAt: end,
      durationSeconds: elapsed,
      formatId: book.formats.some((f) => f.id === timer.timer?.formatId)
        ? timer.timer.formatId
        : firstFormat,
    };
  }
  const end = now;
  const start = new Date(end.getTime() - 30 * 60_000);
  return {
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    durationSeconds: 30 * 60,
    formatId: firstFormat,
  };
}

/**
 * One From/To row: the natural-unit box and the percent box. `source` is the
 * box the user typed in last; the other is converted from it and the session
 * is saved in the unit that was typed.
 */
interface ProgressRow {
  natural: string;
  percent: string;
  source: 'natural' | 'percent';
}

/** `value` in `from` converted to `to`; null when the format's length is unknown. */
function convert(
  from: ProgressUnit,
  to: ProgressUnit,
  value: number,
  format: BookFormat,
): number | null {
  // The start of a book is the start in every unit, length known or not.
  if (value === 0) return 0;
  return percentToUnit(to, computePercent(from, value, format), format);
}

/** A row typed in its `source` box, with the other box converted (blank when it can't be). */
function rowFrom(source: ProgressRow['source'], text: string, format: BookFormat): ProgressRow {
  const natural = naturalUnit(format.format);
  const from: ProgressUnit = source === 'percent' ? 'percent' : natural;
  const to: ProgressUnit = source === 'percent' ? natural : 'percent';
  const parsed = parseProgressInput(from, text);
  const converted =
    parsed.ok && parsed.value !== null
      ? progressInputValue(to, convert(from, to, parsed.value, format))
      : '';
  return source === 'percent'
    ? { natural: converted, percent: text, source }
    : { natural: text, percent: converted, source };
}

/** The From row prefilled from the book's current progress (0 when there is none). */
function startRow(book: BookDetail, format: BookFormat): ProgressRow {
  const percent = book.progressPercent ?? 0;
  const unit = naturalUnit(format.format);
  const natural = convert('percent', unit, percent, format);
  return natural === null
    ? rowFrom('percent', progressInputValue('percent', percent), format)
    : rowFrom('natural', progressInputValue(unit, natural), format);
}

const EMPTY_ROW: ProgressRow = { natural: '', percent: '', source: 'natural' };

/** True when the row's typed value is a percent (a blank box doesn't count). */
function typedInPercent(row: ProgressRow): boolean {
  return row.source === 'percent' && row.percent.trim() !== '';
}

type RowValue = { ok: true; value: number | null } | { ok: false; error: string };

/** The row's value in `unit`, checking what the user typed. */
function rowValue(row: ProgressRow, unit: ProgressUnit, format: BookFormat): RowValue {
  const typedUnit = row.source === 'percent' ? 'percent' : naturalUnit(format.format);
  const typed = parseProgressInput(typedUnit, row.source === 'percent' ? row.percent : row.natural);
  if (!typed.ok || typed.value === null || typedUnit === unit) return typed;
  const value = convert(typedUnit, unit, typed.value, format);
  if (value === null) {
    const natural = format.format === 'audiobook' ? 'h:mm:ss' : 'pages';
    return {
      ok: false,
      error: `the length isn’t known, so this can’t be converted to %. Enter From and To both in ${natural} or both in %.`,
    };
  }
  return { ok: true, value };
}

/** "30 pages · +9.87%" or "54m listened · +8.2%"; null until both rows have values. */
function progressSummary(start: ProgressRow, end: ProgressRow, format: BookFormat): string | null {
  const unit = naturalUnit(format.format);
  const delta = (u: ProgressUnit, from: string, to: string): number | null => {
    const a = parseProgressInput(u, from);
    const b = parseProgressInput(u, to);
    if (!a.ok || !b.ok || a.value === null || b.value === null || b.value < a.value) return null;
    return b.value - a.value;
  };
  const parts: string[] = [];
  const natural = delta(unit, start.natural, end.natural);
  if (natural !== null) {
    parts.push(
      unit === 'audio_seconds' ? `${formatDuration(natural)} listened` : plural(natural, 'page'),
    );
  }
  const percent = delta('percent', start.percent, end.percent);
  if (percent !== null) parts.push(`+${String(Math.round(percent * 100) / 100)}%`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function SessionForm({
  book,
  timer,
  timerFromCache,
}: {
  book: BookDetail;
  timer: TimerResponse | null;
  timerFromCache: boolean;
}) {
  const services = useServices();
  const { timeZone } = services;
  const [initial] = useState(() => prefill(book, timer, timerFromCache, services.now()));
  const [sessionId] = useState(() => services.newId());
  const [formatId, setFormatId] = useState(initial.formatId);
  const format = book.formats.find((f) => f.id === formatId) ?? book.formats[0];
  const [mode, setMode] = useState<TimingMode>('range');
  const [started, setStarted] = useState(toLocalInput(initial.startedAt, timeZone));
  const [ended, setEnded] = useState(toLocalInput(initial.endedAt, timeZone));
  // Exact seconds until the user edits the minutes (keeps the timer's value).
  const [durationSeconds, setDurationSeconds] = useState(initial.durationSeconds);
  const [durationTouched, setDurationTouched] = useState(timer !== null);
  const [startProgress, setStartProgress] = useState(() =>
    format ? startRow(book, format) : EMPTY_ROW,
  );
  const [endProgress, setEndProgress] = useState(EMPTY_ROW);
  const [note, setNote] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  if (!format) {
    return (
      <div className="card empty">
        <p>
          <strong>{book.title}</strong> has no formats yet.
        </p>
        <p>
          <a href={href(paths.book(book.id))}>Add a format</a> (physical, Kindle or audiobook) to
          log sessions.
        </p>
      </div>
    );
  }

  const natural = naturalUnit(format.format);
  const summary = progressSummary(startProgress, endProgress, format);

  const recomputeDuration = (startValue: string, endValue: string) => {
    if (durationTouched) return;
    const s = fromLocalInput(startValue, timeZone);
    const e = fromLocalInput(endValue, timeZone);
    if (s && e) setDurationSeconds(Math.max(0, Math.round((Date.parse(e) - Date.parse(s)) / 1000)));
  };

  const lengthKnown =
    format.format === 'audiobook'
      ? format.audioDurationSeconds !== null
      : format.pageCount !== null;

  const submit = () => {
    setValidation(null);
    const startedAt = fromLocalInput(started, timeZone);
    if (!startedAt) {
      setValidation('Enter when the session started.');
      return;
    }
    const endedAt =
      mode === 'duration'
        ? new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString()
        : fromLocalInput(ended, timeZone);
    if (!endedAt) {
      setValidation('Enter when the session ended.');
      return;
    }
    if (Date.parse(endedAt) < Date.parse(startedAt)) {
      setValidation('The end must not be before the start.');
      return;
    }
    if (durationSeconds > MAX_DURATION_SECONDS) {
      setValidation('A session can last at most 7 days.');
      return;
    }
    // Saved in the unit the user typed: percent when either row was typed as %.
    const unit = typedInPercent(startProgress) || typedInPercent(endProgress) ? 'percent' : natural;
    const startValue = rowValue(startProgress, unit, format);
    if (!startValue.ok) {
      setValidation(`Start: ${startValue.error}`);
      return;
    }
    const endValue = rowValue(endProgress, unit, format);
    if (!endValue.ok) {
      setValidation(`End: ${endValue.error}`);
      return;
    }
    run(async () => {
      await logSession(services, {
        detail: book,
        format,
        timer: timer?.timer ?? null,
        input: {
          id: sessionId,
          formatId: format.id,
          startedAt,
          endedAt,
          durationSeconds,
          progressUnit: unit,
          startValue: startValue.value,
          endValue: endValue.value,
          note: note.trim() === '' ? null : note.trim(),
        },
      });
      navigate(paths.book(book.id));
    });
  };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="book-row card">
        <Cover src={book.coverSrc} title={book.title} size="sm" />
        <div className="info">
          <strong>{book.title}</strong>
          <span className="small muted">{book.authors.join(', ')}</span>
          {timer && <span className="small">From the timer</span>}
        </div>
      </div>

      <div className="field">
        <label htmlFor="log-format">Format</label>
        <select
          id="log-format"
          value={format.id}
          onChange={(event) => {
            const next = book.formats.find((f) => f.id === event.target.value);
            if (!next) return;
            setFormatId(next.id);
            setStartProgress(startRow(book, next));
            setEndProgress(EMPTY_ROW);
          }}
        >
          {book.formats.map((f) => (
            <option key={f.id} value={f.id}>
              {formatSummary(f)}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="stack-sm">
        <legend>When</legend>
        <div className="segmented" role="group" aria-label="How to enter the time">
          <button
            type="button"
            aria-pressed={mode === 'range'}
            onClick={() => {
              setMode('range');
            }}
          >
            Start &amp; end
          </button>
          <button
            type="button"
            aria-pressed={mode === 'duration'}
            onClick={() => {
              setMode('duration');
            }}
          >
            Duration
          </button>
        </div>
        {/* Stacked: side by side, datetime inputs are too narrow on a phone to show the time. */}
        <div className="stack">
          <div className="field">
            <label htmlFor="log-started">Started</label>
            <input
              id="log-started"
              type="datetime-local"
              value={started}
              onChange={(event) => {
                setStarted(event.target.value);
                recomputeDuration(event.target.value, ended);
              }}
            />
          </div>
          {mode === 'range' && (
            <div className="field">
              <label htmlFor="log-ended">Ended</label>
              <input
                id="log-ended"
                type="datetime-local"
                value={ended}
                onChange={(event) => {
                  setEnded(event.target.value);
                  recomputeDuration(started, event.target.value);
                }}
              />
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="log-duration">Reading time (minutes)</label>
          <input
            id="log-duration"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={Math.round(durationSeconds / 60)}
            aria-describedby="log-duration-hint"
            onChange={(event) => {
              const minutes = Number(event.target.value);
              setDurationTouched(true);
              setDurationSeconds(
                Number.isFinite(minutes) ? Math.max(0, Math.round(minutes * 60)) : 0,
              );
            }}
          />
          <span className="field-hint" id="log-duration-hint">
            {formatDuration(durationSeconds)}
            {mode === 'range' && ' — less than end minus start if you took breaks'}
          </span>
        </div>
      </fieldset>

      <fieldset className="stack-sm">
        <legend>Progress</legend>
        {/* Typing in either box of a row fills in the other from the format's length. */}
        <div className="grid-2">
          <ProgressBox
            id="log-start-value"
            label="From"
            unit={natural}
            value={startProgress.natural}
            placeholder={natural === 'audio_seconds' ? '0:00:00' : '0'}
            onChange={(text) => {
              setStartProgress(rowFrom('natural', text, format));
            }}
          />
          <ProgressBox
            id="log-start-percent"
            label="From"
            unit="percent"
            value={startProgress.percent}
            placeholder="0"
            onChange={(text) => {
              setStartProgress(rowFrom('percent', text, format));
            }}
          />
          <ProgressBox
            id="log-end-value"
            label="To"
            unit={natural}
            value={endProgress.natural}
            placeholder={natural === 'audio_seconds' ? '1:02:10' : ''}
            onChange={(text) => {
              setEndProgress(rowFrom('natural', text, format));
            }}
          />
          <ProgressBox
            id="log-end-percent"
            label="To"
            unit="percent"
            value={endProgress.percent}
            placeholder=""
            onChange={(text) => {
              setEndProgress(rowFrom('percent', text, format));
            }}
          />
        </div>
        {summary && (
          <p className="field-hint" aria-live="polite">
            {summary}
          </p>
        )}
        {!lengthKnown && (
          <p className="field-hint">
            The {FORMAT_LABELS[format.format].toLowerCase()} length isn’t known, so{' '}
            {format.format === 'audiobook' ? 'positions' : 'pages'} and % can’t be converted.{' '}
            <a href={href(paths.book(book.id))}>
              Add the {format.format === 'audiobook' ? 'duration' : 'page count'}
            </a>{' '}
            or enter From and To in the same unit.
          </p>
        )}
      </fieldset>

      <div className="field">
        <label htmlFor="log-note">Note</label>
        <textarea
          id="log-note"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </div>

      {validation && (
        <p className="error-text" role="alert">
          {validation}
        </p>
      )}
      <ActionError error={error} />
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Saving…' : 'Save session'}
      </button>
    </form>
  );
}

function ProgressBox({
  id,
  label,
  unit,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  unit: ProgressUnit;
  value: string;
  placeholder: string;
  onChange: (text: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} ({unitHint(unit)})
      </label>
      <input
        id={id}
        inputMode={unit === 'audio_seconds' ? 'text' : 'decimal'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}
