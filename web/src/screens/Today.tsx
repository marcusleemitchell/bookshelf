/**
 * Today (SPEC §6.1): the active timer (start / pause / resume / stop → log),
 * books currently being read with progress and estimated finish, today's
 * minutes against the daily goal, and the reading streak.
 */
import { useState } from 'react';
import {
  bookDetailSchema,
  bookListSchema,
  formatAudioPosition,
  formatDate,
  formatDuration,
  goalListSchema,
  statsDailySchema,
  streaksSchema,
  timerElapsedSeconds,
  timerResponseSchema,
  type ActiveTimer,
  type BookListItem,
  type TimerResponse,
} from '../../../shared/index.ts';
import { discardTimer, pauseTimer, resumeTimer, startTimer } from '../app/actions.ts';
import { useAction, useNow, useResource, useServices } from '../app/hooks.ts';
import { PlusIcon } from '../components/Icons.tsx';
import { ActionError, Cover, ProgressBar, ScreenHeader } from '../components/ui.tsx';
import { todayKey } from '../lib/dates.ts';
import { FORMAT_LABELS, formatPercent, plural } from '../lib/labels.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, navigate, paths } from '../router.ts';

export function Today() {
  const services = useServices();
  const today = todayKey(services.now(), services.timeZone);
  const timer = useResource(cacheKeys.timer, timerResponseSchema, (api) => api.getTimer());
  const books = useResource(cacheKeys.books, bookListSchema, (api) => api.listBooks());
  const goals = useResource(cacheKeys.goals, goalListSchema, (api) => api.listGoals());
  const streaks = useResource(cacheKeys.streaks, streaksSchema, (api) => api.streaks());
  const daily = useResource(cacheKeys.statsDaily(today, today), statsDailySchema, (api) =>
    api.statsDaily({ from: today, to: today }),
  );

  const allBooks = books.data ?? [];
  const reading = allBooks.filter((book) => book.status === 'reading');
  const minutesToday = daily.data?.days.find((day) => day.date === today)?.minutes ?? 0;
  const dailyGoal = goals.data?.find((goal) => goal.kind === 'minutes_per_day') ?? null;

  return (
    <>
      <ScreenHeader
        title="Today"
        actions={
          <a className="icon-btn" href={href(paths.add())} aria-label="Add book">
            <PlusIcon />
          </a>
        }
      />

      <section className="section" aria-labelledby="timer-heading">
        <h2 id="timer-heading">Timer</h2>
        {timer.data ? (
          <TimerCard response={timer.data} books={allBooks} reading={reading} />
        ) : (
          <p className="muted" role="status">
            {timer.loading ? 'Checking the timer…' : 'The timer is unavailable offline.'}
          </p>
        )}
      </section>

      <section className="section" aria-labelledby="goal-heading">
        <h2 id="goal-heading">Reading today</h2>
        <div className="card stack-sm">
          <div className="row-between">
            <p>
              <span className="big-number">{minutesToday}</span>{' '}
              <span className="muted">
                {dailyGoal ? `of ${dailyGoal.target} minutes` : 'minutes'}
              </span>
            </p>
            {streaks.data && (
              <p
                className="small"
                aria-label={`Current streak ${plural(streaks.data.current, 'day')}`}
              >
                <strong>{plural(streaks.data.current, 'day')}</strong> streak
                <span className="muted"> · best {streaks.data.longest}</span>
              </p>
            )}
          </div>
          {dailyGoal ? (
            <ProgressBar
              percent={Math.min(100, (minutesToday / dailyGoal.target) * 100)}
              label="Daily goal progress"
            />
          ) : (
            <p className="small muted">
              <a href={href(paths.settings())}>Set a daily goal</a> to track minutes.
            </p>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="reading-heading">
        <div className="section-title">
          <h2 id="reading-heading">Currently reading</h2>
          <a className="small" href={href(paths.library())}>
            Library
          </a>
        </div>
        {books.data === undefined && books.loading && <p className="muted">Loading…</p>}
        {books.data !== undefined && reading.length === 0 && (
          <div className="card empty">
            <p>Nothing on the go.</p>
            <p>
              <a href={href(paths.library())}>Pick something from your library</a> or{' '}
              <a href={href(paths.add())}>add a book</a>.
            </p>
          </div>
        )}
        <ul className="list card" hidden={reading.length === 0}>
          {reading.map((book) => (
            <li key={book.id}>
              <ReadingBook book={book} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** A book being read, with its detail (for the estimated finish) loaded on demand. */
function ReadingBook({ book }: { book: BookListItem }) {
  const { timeZone } = useServices();
  const detail = useResource(cacheKeys.book(book.id), bookDetailSchema, (api) =>
    api.getBook(book.id),
  );
  const current = detail.data ?? book;
  const estimate = detail.data?.estimatedFinish ?? null;
  return (
    <div className="list-item">
      <a href={href(paths.book(book.id))} tabIndex={-1} aria-hidden="true">
        <Cover src={current.coverSrc} title={current.title} size="sm" />
      </a>
      <div className="grow stack-sm">
        <a className="book-title-link" href={href(paths.book(book.id))}>
          {current.title}
        </a>
        <p className="small muted">{current.authors.join(', ')}</p>
        <ProgressBar percent={current.progressPercent} label={`${current.title} progress`} />
        <p className="small muted">
          {current.progressPercent === null
            ? 'Progress not recorded yet'
            : `${formatPercent(current.progressPercent)} read`}
          {estimate && ` · finish by ${formatDate(estimate.date, timeZone)}`}
        </p>
      </div>
      <a className="btn btn-small" href={href(paths.log({ bookId: book.id }))}>
        Log
      </a>
    </div>
  );
}

function TimerCard({
  response,
  books,
  reading,
}: {
  response: TimerResponse;
  books: BookListItem[];
  reading: BookListItem[];
}) {
  if (response.timer) {
    return <RunningTimer timer={response.timer} books={books} />;
  }
  return <StartTimer books={reading.length > 0 ? reading : books} />;
}

function RunningTimer({ timer, books }: { timer: ActiveTimer; books: BookListItem[] }) {
  const services = useServices();
  const now = useNow(1000);
  const { busy, error, run } = useAction();
  const book = books.find((b) => b.id === timer.bookId);
  const format = book?.formats.find((f) => f.id === timer.formatId);
  // Elapsed time is derived from the stored timestamps, never counted locally,
  // so it stays right after the app is closed and reopened.
  const elapsed = timerElapsedSeconds(timer, now);
  const paused = timer.pausedAt !== null;
  return (
    <div className="card timer-card stack-sm">
      <div className="row">
        {book && <Cover src={book.coverSrc} title={book.title} size="sm" />}
        <div className="grow stack-sm" style={{ flex: 1, minWidth: 0 }}>
          <p>
            <strong>{book?.title ?? 'Unknown book'}</strong>
          </p>
          <p className="small muted">
            {format ? FORMAT_LABELS[format.format] : ''}
            {paused ? ' · paused' : ' · running'}
          </p>
        </div>
      </div>
      <p className="timer-display" aria-label={`Elapsed ${formatDuration(elapsed)}`}>
        <span aria-hidden="true">{formatAudioPosition(elapsed)}</span>
      </p>
      <div className="row">
        {paused ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              run(() => resumeTimer(services, timer));
            }}
          >
            Resume
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              run(() => pauseTimer(services, timer));
            }}
          >
            Pause
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            navigate(paths.log({ bookId: timer.bookId, fromTimer: true }));
          }}
        >
          Stop &amp; log
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Discard this timer without logging a session?')) {
              run(() => discardTimer(services, timer));
            }
          }}
        >
          Discard
        </button>
      </div>
      <ActionError error={error} />
    </div>
  );
}

function StartTimer({ books }: { books: BookListItem[] }) {
  const services = useServices();
  const { busy, error, run } = useAction();
  const withFormats = books.filter((book) => book.formats.length > 0);
  const [bookId, setBookId] = useState(withFormats[0]?.id ?? '');
  const book = withFormats.find((b) => b.id === bookId) ?? withFormats[0];
  const [formatChoice, setFormatChoice] = useState<string | null>(null);
  const formatId =
    book?.formats.find((f) => f.id === formatChoice)?.id ?? book?.formats[0]?.id ?? '';

  if (!book) {
    return (
      <p className="card muted">
        Add a book with a format to start timing your reading.{' '}
        <a href={href(paths.add())}>Add a book</a>
      </p>
    );
  }
  return (
    <form
      className="card stack-sm"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => startTimer(services, book, formatId));
      }}
    >
      <p className="muted">No timer running.</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="timer-book">Book</label>
          <select
            id="timer-book"
            value={book.id}
            onChange={(event) => {
              setBookId(event.target.value);
              setFormatChoice(null);
            }}
          >
            {withFormats.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="timer-format">Format</label>
          <select
            id="timer-format"
            value={formatId}
            onChange={(event) => {
              setFormatChoice(event.target.value);
            }}
          >
            {book.formats.map((f) => (
              <option key={f.id} value={f.id}>
                {FORMAT_LABELS[f.format]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        Start timer
      </button>
      <ActionError error={error} />
    </form>
  );
}
