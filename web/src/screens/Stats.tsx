/**
 * Stats (SPEC §6.7): range picker (week / month / year / all time), daily
 * minutes, pages and percent trends, breakdowns by format / genre / tag /
 * author, reading speed, goals progress and the year in review. Every chart
 * has a text summary and a data table.
 */
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import {
  addDays,
  formatDate,
  formatDuration,
  goalListSchema,
  statsDailySchema,
  statsSummarySchema,
  yearInReviewSchema,
  type GoalWithProgress,
  type StatsDaily,
  type StatsSummary,
  type YearInReview,
} from '../../../shared/index.ts';
import { useResource, useServices } from '../app/hooks.ts';
import { ChartFigure, DataTable, chartColours } from '../components/charts.tsx';
import { Cover, ProgressBar, ResourceView, ScreenHeader } from '../components/ui.tsx';
import { lastDays, monthLabel, shortMonth, todayKey } from '../lib/dates.ts';
import {
  FORMAT_LABELS,
  GOAL_LABELS,
  formatPercent,
  plural,
  ratingLabel,
  ratingStars,
} from '../lib/labels.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, paths } from '../router.ts';

export type RangeName = 'week' | 'month' | 'year' | 'all';

const RANGE_LABELS: Record<RangeName, string> = {
  week: 'Week',
  month: 'Month',
  year: 'Year',
  all: 'All time',
};

/** `stats/daily` accepts at most this many days. */
const MAX_DAILY_DAYS = 3660;

export interface RangeBounds {
  /** Summary bounds (undefined = all time). */
  from: string | undefined;
  to: string | undefined;
  /** Daily series bounds. */
  dailyFrom: string;
  dailyTo: string;
  /** Group the daily series by month for long ranges. */
  byMonth: boolean;
}

/** Week = last 7 days, month = last 30 days, year = this calendar year so far. */
export function rangeBounds(range: RangeName, today: string): RangeBounds {
  switch (range) {
    case 'week': {
      const { from, to } = lastDays(today, 7);
      return { from, to, dailyFrom: from, dailyTo: to, byMonth: false };
    }
    case 'month': {
      const { from, to } = lastDays(today, 30);
      return { from, to, dailyFrom: from, dailyTo: to, byMonth: false };
    }
    case 'year': {
      const from = `${today.slice(0, 4)}-01-01`;
      return { from, to: today, dailyFrom: from, dailyTo: today, byMonth: true };
    }
    case 'all':
      return {
        from: undefined,
        to: undefined,
        dailyFrom: addDays(today, -(MAX_DAILY_DAYS - 1)),
        dailyTo: today,
        byMonth: true,
      };
  }
}

export interface SeriesPoint {
  key: string;
  label: string;
  minutes: number;
  pages: number;
  percent: number;
}

/** Daily stats as chart points, optionally grouped by month (leading empty months dropped). */
export function toSeries(daily: StatsDaily, byMonth: boolean, timeZone: string): SeriesPoint[] {
  if (!byMonth) {
    return daily.days.map((day) => ({
      key: day.date,
      label: formatDate(day.date, timeZone).slice(0, 5),
      minutes: day.minutes,
      pages: day.pages,
      percent: Math.round(day.percent * 10) / 10,
    }));
  }
  const months = new Map<string, SeriesPoint>();
  for (const day of daily.days) {
    const month = day.date.slice(0, 7);
    const point = months.get(month) ?? {
      key: month,
      label: `${shortMonth(month)} ${month.slice(2, 4)}`,
      minutes: 0,
      pages: 0,
      percent: 0,
    };
    point.minutes += day.minutes;
    point.pages += day.pages;
    point.percent += day.percent;
    months.set(month, point);
  }
  // Round once per month, not per day, so rounding errors don't accumulate.
  const points = [...months.values()].map((p) => ({
    ...p,
    percent: Math.round(p.percent * 10) / 10,
  }));
  const firstActive = points.findIndex((p) => p.minutes > 0 || p.pages > 0);
  return firstActive === -1 ? points.slice(-1) : points.slice(firstActive);
}

export function Stats() {
  const services = useServices();
  const today = todayKey(services.now(), services.timeZone);
  const [range, setRange] = useState<RangeName>('month');
  const bounds = rangeBounds(range, today);
  const summary = useResource(
    cacheKeys.statsSummary(bounds.from, bounds.to),
    statsSummarySchema,
    (api) => api.statsSummary({ from: bounds.from, to: bounds.to }),
  );
  const daily = useResource(
    cacheKeys.statsDaily(bounds.dailyFrom, bounds.dailyTo),
    statsDailySchema,
    (api) => api.statsDaily({ from: bounds.dailyFrom, to: bounds.dailyTo }),
  );
  const goals = useResource(cacheKeys.goals, goalListSchema, (api) => api.listGoals());

  return (
    <>
      <ScreenHeader title="Stats" />
      <div className="stack">
        <div className="segmented" role="group" aria-label="Range">
          {(Object.keys(RANGE_LABELS) as RangeName[]).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={range === name}
              onClick={() => {
                setRange(name);
              }}
            >
              {RANGE_LABELS[name]}
            </button>
          ))}
        </div>

        <ResourceView resource={summary} loadingLabel="Loading stats…">
          {(data) => <Totals summary={data} />}
        </ResourceView>

        <ResourceView resource={daily} loadingLabel="Loading the daily chart…">
          {(data) => (
            <Trends
              series={toSeries(data, bounds.byMonth, services.timeZone)}
              byMonth={bounds.byMonth}
            />
          )}
        </ResourceView>

        {summary.data && <Breakdowns summary={summary.data} />}
        {summary.data && <Speeds summary={summary.data} />}

        <section className="section" aria-labelledby="goals-heading">
          <div className="section-title">
            <h2 id="goals-heading">Goals</h2>
            <a className="small" href={href(paths.settings())}>
              Edit goals
            </a>
          </div>
          <ResourceView resource={goals} loadingLabel="Loading goals…">
            {(list) => <GoalsProgress goals={list} />}
          </ResourceView>
        </section>

        <YearInReviewSection currentYear={Number(today.slice(0, 4))} />
      </div>
    </>
  );
}

function Totals({ summary }: { summary: StatsSummary }) {
  const { totals } = summary;
  return (
    <>
      <section aria-label="Totals" className="stat-grid">
        <div className="stat">
          <div className="label">Reading time</div>
          <div className="value">{formatDuration(totals.seconds)}</div>
        </div>
        <div className="stat">
          <div className="label">Sessions</div>
          <div className="value">{totals.sessions}</div>
        </div>
        <div className="stat">
          <div className="label">Pages</div>
          <div className="value">{totals.pages}</div>
        </div>
        <div className="stat">
          <div className="label">Books finished</div>
          <div className="value">{totals.booksFinished}</div>
        </div>
      </section>
      {totals.untimedSessions > 0 && (
        <p className="small muted">
          {plural(totals.untimedSessions, 'session')} with unknown time (imported) count as sessions
          but not towards reading time, minutes or speed.
        </p>
      )}
    </>
  );
}

function SeriesBarChart({
  series,
  dataKey,
  unit,
  colour,
}: {
  series: SeriesPoint[];
  dataKey: 'minutes' | 'pages' | 'percent';
  unit: string;
  colour: string;
}) {
  return (
    <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
      <CartesianGrid stroke={chartColours.grid} strokeDasharray="3 3" vertical={false} />
      <XAxis
        dataKey="label"
        tick={{ fill: chartColours.text, fontSize: 11 }}
        interval="preserveStartEnd"
      />
      <YAxis tick={{ fill: chartColours.text, fontSize: 11 }} allowDecimals={false} />
      <Tooltip formatter={(value) => [`${String(value)} ${unit}`, '']} />
      <Bar dataKey={dataKey} fill={colour} radius={[4, 4, 0, 0]} maxBarSize={28} />
    </BarChart>
  );
}

function Trends({ series, byMonth }: { series: SeriesPoint[]; byMonth: boolean }) {
  const per = byMonth ? 'month' : 'day';
  const totalMinutes = series.reduce((sum, p) => sum + p.minutes, 0);
  const totalPages = series.reduce((sum, p) => sum + p.pages, 0);
  const totalPercent = series.reduce((sum, p) => sum + p.percent, 0);
  const active = series.filter((p) => p.minutes > 0).length;
  const best = series.reduce<SeriesPoint | null>(
    (top, p) => (top === null || p.minutes > top.minutes ? p : top),
    null,
  );
  const table = (
    <DataTable
      caption={`Reading per ${per}`}
      columns={[byMonth ? 'Month' : 'Day', 'Minutes', 'Pages', 'Percent']}
      rows={series.map((p) => [p.label, p.minutes, p.pages, formatPercent(p.percent)])}
    />
  );
  return (
    <section className="section" aria-labelledby="trends-heading">
      <h2 id="trends-heading">Minutes per {per}</h2>
      <div className="card">
        <ChartFigure
          label={`Minutes read per ${per}`}
          summary={
            totalMinutes === 0
              ? 'No reading in this range.'
              : `${formatDuration(totalMinutes * 60)} over ${plural(active, per)} with reading${best && best.minutes > 0 ? `; most on ${best.label} (${best.minutes} min)` : ''}.`
          }
          table={table}
        >
          <SeriesBarChart
            series={series}
            dataKey="minutes"
            unit="min"
            colour={chartColours.primary}
          />
        </ChartFigure>
      </div>
      <h2>Pages per {per}</h2>
      <div className="card">
        <ChartFigure
          label={`Pages read per ${per}`}
          summary={
            totalPages === 0
              ? 'No pages recorded in this range.'
              : `${plural(totalPages, 'page')} in this range.`
          }
        >
          <SeriesBarChart
            series={series}
            dataKey="pages"
            unit="pages"
            colour={chartColours.secondary}
          />
        </ChartFigure>
      </div>
      <h2>Progress per {per}</h2>
      <div className="card">
        <ChartFigure
          label={`Percent progressed per ${per}`}
          summary={
            totalPercent === 0
              ? 'No percent progress recorded in this range.'
              : `${formatPercent(totalPercent)} of books progressed in total (across all books).`
          }
        >
          <SeriesBarChart
            series={series}
            dataKey="percent"
            unit="%"
            colour={chartColours.primary}
          />
        </ChartFigure>
      </div>
    </section>
  );
}

const TOP_N = 8;

function BarList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { label: string; seconds: number }[];
  empty: string;
}) {
  const top = [...rows].sort((a, b) => b.seconds - a.seconds).slice(0, TOP_N);
  const max = top[0]?.seconds ?? 0;
  return (
    <div className="card stack-sm">
      <h3>{title}</h3>
      {top.length === 0 ? (
        <p className="small muted">{empty}</p>
      ) : (
        <ul className="list stack-sm" aria-label={title}>
          {top.map((row) => (
            <li key={row.label} className="bar-row" style={{ border: 'none' }}>
              <span className="label" title={row.label}>
                {row.label}
              </span>
              <ProgressBar
                percent={max > 0 ? (row.seconds / max) * 100 : 0}
                label={`${row.label} share`}
              />
              <span className="tabular small">{formatDuration(row.seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Breakdowns({ summary }: { summary: StatsSummary }) {
  return (
    <section className="section" aria-labelledby="breakdown-heading">
      <h2 id="breakdown-heading">Breakdown</h2>
      <BarList
        title="By format"
        rows={summary.byFormat.map((r) => ({ label: FORMAT_LABELS[r.format], seconds: r.seconds }))}
        empty="No sessions yet."
      />
      <BarList
        title="By genre"
        rows={summary.byGenre.map((r) => ({ label: r.genre, seconds: r.seconds }))}
        empty="No genres recorded."
      />
      <BarList
        title="By tag"
        rows={summary.byTag.map((r) => ({ label: r.name, seconds: r.seconds }))}
        empty="No tagged books read in this range."
      />
      <BarList
        title="By author"
        rows={summary.byAuthor.map((r) => ({ label: r.author, seconds: r.seconds }))}
        empty="No authors recorded."
      />
    </section>
  );
}

function Speeds({ summary }: { summary: StatsSummary }) {
  return (
    <section className="section" aria-labelledby="speed-heading">
      <h2 id="speed-heading">Reading speed</h2>
      <p className="small muted">Over the last 30 days of the range.</p>
      {summary.readingSpeed.length === 0 ? (
        <p className="muted">Not enough recent sessions.</p>
      ) : (
        <ul className="list card">
          {summary.readingSpeed.map((speed) => {
            const parts = [
              speed.pagesPerHour !== null
                ? `${Math.round(speed.pagesPerHour)} pages an hour`
                : null,
              speed.percentPerHour !== null
                ? `${formatPercent(speed.percentPerHour)} an hour`
                : null,
              speed.listeningRatio !== null
                ? `${speed.listeningRatio.toFixed(2)}× listening speed`
                : null,
            ].filter(Boolean);
            return (
              <li key={speed.format} className="list-item">
                <div className="grow">
                  <strong>{FORMAT_LABELS[speed.format]}</strong>
                  <p className="small">
                    {parts.length > 0 ? parts.join(' · ') : 'No progress recorded'}
                  </p>
                  <p className="small muted">
                    {plural(speed.sessions, 'session')} · {formatDuration(speed.seconds)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function GoalsProgress({ goals }: { goals: GoalWithProgress[] }) {
  if (goals.length === 0) {
    return (
      <p className="muted">
        No goals set. <a href={href(paths.settings())}>Set one in Settings</a>.
      </p>
    );
  }
  return (
    <ul className="list card">
      {goals.map((goal) => {
        const percent = Math.min(100, (goal.current / goal.target) * 100);
        const label =
          goal.kind === 'minutes_per_day'
            ? GOAL_LABELS[goal.kind]
            : GOAL_LABELS[goal.kind].replace('this year', `in ${String(goal.year)}`);
        return (
          <li key={goal.id} className="list-item">
            <div className="grow stack-sm">
              <div className="row-between">
                <strong>{label}</strong>
                <span className="tabular">
                  {Math.round(goal.current)} / {goal.target}
                </span>
              </div>
              <ProgressBar percent={percent} label={`${label} progress`} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function YearInReviewSection({ currentYear }: { currentYear: number }) {
  const [year, setYear] = useState(currentYear);
  const review = useResource(cacheKeys.yearInReview(year), yearInReviewSchema, (api) =>
    api.yearInReview(year),
  );
  const years = Array.from({ length: 10 }, (_, index) => currentYear - index);
  return (
    <section className="section" aria-labelledby="year-heading">
      <div className="section-title">
        <h2 id="year-heading">Year in review</h2>
        <label className="sr-only" htmlFor="review-year">
          Year
        </label>
        <select
          id="review-year"
          style={{ width: 'auto' }}
          value={year}
          onChange={(event) => {
            setYear(Number(event.target.value));
          }}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <ResourceView resource={review} loadingLabel="Loading the year…">
        {(data) => <YearReview review={data} />}
      </ResourceView>
    </section>
  );
}

function YearReview({ review }: { review: YearInReview }) {
  const { timeZone } = useServices();
  const { totals } = review;
  const months = review.byMonth.map((m) => ({
    label: shortMonth(m.month),
    minutes: Math.round(m.seconds / 60),
    month: m.month,
  }));
  const busiest = review.byMonth.reduce<YearInReview['byMonth'][number] | null>(
    (top, m) => (top === null || m.seconds > top.seconds ? m : top),
    null,
  );
  return (
    <div className="stack">
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Books finished</div>
          <div className="value">{totals.booksFinished}</div>
        </div>
        <div className="stat">
          <div className="label">Reading time</div>
          <div className="value">{formatDuration(totals.seconds)}</div>
        </div>
        <div className="stat">
          <div className="label">Days read</div>
          <div className="value">{totals.daysRead}</div>
        </div>
        <div className="stat">
          <div className="label">Longest streak</div>
          <div className="value">{plural(review.longestStreak, 'day')}</div>
        </div>
      </div>

      <div className="card">
        <ChartFigure
          label={`Minutes read per month in ${String(review.year)}`}
          summary={
            totals.seconds === 0
              ? `No reading recorded in ${String(review.year)}.`
              : `${formatDuration(totals.seconds)} across ${plural(totals.sessions, 'session')}; busiest month ${busiest ? monthLabel(busiest.month) : ''}.`
          }
          table={
            <DataTable
              caption="Reading by month"
              columns={['Month', 'Minutes', 'Pages', 'Books finished']}
              rows={review.byMonth.map((m) => [
                monthLabel(m.month),
                Math.round(m.seconds / 60),
                m.pages,
                m.booksFinished,
              ])}
            />
          }
        >
          <BarChart data={months} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={chartColours.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: chartColours.text, fontSize: 11 }} />
            <YAxis tick={{ fill: chartColours.text, fontSize: 11 }} allowDecimals={false} />
            <Tooltip formatter={(value) => [`${String(value)} min`, '']} />
            <Bar
              dataKey="minutes"
              fill={chartColours.primary}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
            />
          </BarChart>
        </ChartFigure>
      </div>

      {review.booksFinished.length > 0 && (
        <div className="stack-sm">
          <h3>Finished in {review.year}</h3>
          <ul className="book-grid">
            {review.booksFinished.map((book) => (
              <li key={`${book.bookId}-${book.finishedAt}`}>
                <a className="book-tile" href={href(paths.book(book.bookId))}>
                  <Cover src={book.coverSrc} title={book.title} size="fill" />
                  <span className="title">{book.title}</span>
                  <span className="author">{formatDate(book.finishedAt, timeZone)}</span>
                  {book.rating !== null && (
                    <span
                      className="author rating-stars"
                      role="img"
                      aria-label={`Rated ${ratingLabel(book.rating)}`}
                    >
                      {ratingStars(book.rating)}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="stack">
        <BarList
          title="Top authors"
          rows={review.topAuthors.map((a) => ({ label: a.author, seconds: a.seconds }))}
          empty="None yet."
        />
        <BarList
          title="Top genres"
          rows={review.topGenres.map((g) => ({ label: g.genre, seconds: g.seconds }))}
          empty="None yet."
        />
      </div>
      {review.longestSession && (
        <p className="small muted">
          Longest session: {formatDuration(review.longestSession.seconds)} on{' '}
          {formatDate(review.longestSession.date, timeZone)}.
        </p>
      )}
    </div>
  );
}
