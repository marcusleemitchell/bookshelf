/**
 * Calendar (SPEC §6.6): a hand-built Monday-first month grid; each day shows
 * tiny covers of the books read that day. Tapping a day lists its sessions.
 */
import { useState } from 'react';
import {
  calendarSchema,
  eachDay,
  formatDate,
  formatDuration,
  monthRange,
  sessionListSchema,
  type CalendarResponse,
} from '../../../shared/index.ts';
import { useResource, useServices } from '../app/hooks.ts';
import { Cover, ResourceView, ScreenHeader } from '../components/ui.tsx';
import {
  WEEKDAYS,
  addMonths,
  currentMonth,
  formatTime,
  longDayLabel,
  monthLabel,
  shortMonth,
  todayKey,
  weekdayIndex,
} from '../lib/dates.ts';
import {
  dayTimeLabel,
  formatProgressValue,
  plural,
  sessionDurationLabel,
  unknownTimeLabel,
} from '../lib/labels.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, paths } from '../router.ts';

/** Covers shown per day before "+N". */
const MAX_COVERS = 3;

type CalendarDay = CalendarResponse['days'][number];

export function CalendarScreen({ month }: { month: string | null }) {
  const services = useServices();
  const thisMonth = currentMonth(services.now(), services.timeZone);
  const shown = month ?? thisMonth;
  const calendar = useResource(cacheKeys.calendar(shown), calendarSchema, (api) =>
    api.calendar(shown),
  );
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <ScreenHeader title="Calendar" />
      <div className="stack">
        <nav className="row-between" aria-label="Month">
          <a
            className="btn btn-small"
            href={href(paths.calendar(addMonths(shown, -1)))}
            aria-label={`Previous month, ${monthLabel(addMonths(shown, -1))}`}
          >
            ‹ {shortMonth(addMonths(shown, -1))}
          </a>
          <h2>{monthLabel(shown)}</h2>
          <a
            className="btn btn-small"
            href={href(paths.calendar(addMonths(shown, 1)))}
            aria-label={`Next month, ${monthLabel(addMonths(shown, 1))}`}
          >
            {shortMonth(addMonths(shown, 1))} ›
          </a>
        </nav>
        {shown !== thisMonth && (
          <a className="small" href={href(paths.calendar())}>
            Back to this month
          </a>
        )}
        <ResourceView resource={calendar} loadingLabel="Loading the month…">
          {(data) => (
            <MonthGrid
              data={data}
              today={todayKey(services.now(), services.timeZone)}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </ResourceView>
        {selected && calendar.data && (
          <DayDetail day={selected} entry={calendar.data.days.find((d) => d.date === selected)} />
        )}
      </div>
    </>
  );
}

function MonthGrid({
  data,
  today,
  selected,
  onSelect,
}: {
  data: CalendarResponse;
  today: string;
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const { from, to } = monthRange(data.month);
  const days = eachDay(from, to);
  const byDate = new Map(data.days.map((day) => [day.date, day]));
  const leading = weekdayIndex(from);
  const totalMinutes = data.days.reduce(
    (sum, day) => sum + day.entries.reduce((s, e) => s + e.minutes, 0),
    0,
  );
  const untimed = data.days.reduce(
    (sum, day) => sum + day.entries.reduce((s, e) => s + e.untimedSessions, 0),
    0,
  );
  return (
    <>
      <p className="small muted" role="status">
        {data.days.length === 0
          ? 'No reading recorded this month.'
          : `${plural(data.days.length, 'day')} with reading · ${monthTimeLabel(totalMinutes, untimed)}`}
      </p>
      <div className="calendar-grid" aria-hidden="true">
        {WEEKDAYS.map((name) => (
          <div key={name} className="calendar-weekday">
            {name.slice(0, 3)}
          </div>
        ))}
      </div>
      <ol className="calendar-grid" aria-label={`Days of ${monthLabel(data.month)}`}>
        {Array.from({ length: leading }, (_, index) => (
          <li key={`blank-${index}`} aria-hidden="true" />
        ))}
        {days.map((day) => {
          const entry = byDate.get(day);
          return (
            <li key={day}>
              <DayCell
                day={day}
                entry={entry}
                isToday={day === today}
                pressed={selected === day}
                onSelect={() => {
                  onSelect(selected === day ? null : day);
                }}
              />
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** "1h 35m in total", "time unknown (imported)" or "25m in total, plus 3 sessions with time unknown". */
function monthTimeLabel(minutes: number, untimed: number): string {
  if (untimed === 0) return `${formatDuration(minutes * 60)} in total`;
  if (minutes === 0) return 'time unknown (imported)';
  return `${formatDuration(minutes * 60)} in total, plus ${plural(untimed, 'session')} with time unknown`;
}

function DayCell({
  day,
  entry,
  isToday,
  pressed,
  onSelect,
}: {
  day: string;
  entry: CalendarDay | undefined;
  isToday: boolean;
  pressed: boolean;
  onSelect: () => void;
}) {
  const number = Number(day.slice(8));
  const minutes = entry?.entries.reduce((sum, e) => sum + e.minutes, 0) ?? 0;
  const untimed = entry?.entries.reduce((sum, e) => sum + e.untimedSessions, 0) ?? 0;
  const classes = ['calendar-day', entry ? 'has-sessions' : '', isToday ? 'is-today' : '']
    .filter(Boolean)
    .join(' ');
  const label = entry
    ? `${longDayLabel(day)}: ${entry.entries.map((e) => e.title).join(', ')}, ${dayTimeLabel(minutes, untimed)}`
    : `${longDayLabel(day)}: no reading`;
  if (!entry) {
    return (
      <div className={classes} aria-label={label} role="img">
        <span className="day-number">{number}</span>
      </div>
    );
  }
  const extra = entry.entries.length - MAX_COVERS;
  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onSelect}
    >
      <span className="day-number">{number}</span>
      <span className="day-covers">
        {entry.entries.slice(0, MAX_COVERS).map((e) => (
          <Cover key={e.bookId} src={e.coverUrl} title={e.title} size="xs" />
        ))}
      </span>
      {extra > 0 && <span className="day-more">+{extra}</span>}
    </button>
  );
}

function DayDetail({ day, entry }: { day: string; entry: CalendarDay | undefined }) {
  const { timeZone } = useServices();
  const sessions = useResource(cacheKeys.daySessions(day), sessionListSchema, (api) =>
    api.listSessions({ from: day, to: day }),
  );
  const titles = new Map(entry?.entries.map((e) => [e.bookId, e]) ?? []);
  return (
    <section className="card stack-sm" aria-labelledby="day-heading">
      <h2 id="day-heading">{longDayLabel(day)}</h2>
      <p className="small muted">{formatDate(day, timeZone)}</p>
      <ResourceView resource={sessions} loadingLabel="Loading sessions…">
        {(list) =>
          list.length === 0 ? (
            <p className="muted">No sessions on this day.</p>
          ) : (
            <ul className="list">
              {[...list]
                .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
                .map((session) => {
                  const book = titles.get(session.bookId);
                  return (
                    <li key={session.id} className="list-item">
                      <Cover src={book?.coverUrl ?? null} title={book?.title ?? ''} size="sm" />
                      <div className="grow">
                        <a className="book-title-link" href={href(paths.book(session.bookId))}>
                          {book?.title ?? 'Book'}
                        </a>
                        <p className="small muted">
                          {session.source === 'bookpine'
                            ? unknownTimeLabel(session)
                            : `${formatTime(session.startedAt, timeZone)}–${formatTime(session.endedAt, timeZone)} · ${sessionDurationLabel(session)}`}
                        </p>
                        {session.endValue !== null && (
                          <p className="small">
                            {formatProgressValue(session.progressUnit, session.startValue)} →{' '}
                            {formatProgressValue(session.progressUnit, session.endValue)}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          )
        }
      </ResourceView>
    </section>
  );
}
