/**
 * Accessible chart wrapper (Recharts). The drawn chart is decorative for
 * assistive technology; every chart carries a text summary and an optional
 * data table, so the information never depends on seeing the graphic.
 */
import type { ReactElement, ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';

export function ChartFigure({
  label,
  summary,
  table,
  height = 200,
  children,
}: {
  /** Accessible name of the figure. */
  label: string;
  /** One-sentence text summary shown under the chart. */
  summary: ReactNode;
  /** Optional data table, shown behind "Show data". */
  table?: ReactNode;
  height?: number;
  children: ReactElement;
}) {
  return (
    <figure className="chart" aria-label={label}>
      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 320, height }}>
          {children}
        </ResponsiveContainer>
      </div>
      <figcaption>{summary}</figcaption>
      {table && (
        <details>
          <summary>Show data</summary>
          {table}
        </details>
      )}
    </figure>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number)[])[];
}) {
  return (
    <table className="data">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Chart colours from the CSS custom properties (so charts follow light/dark). */
export const chartColours = {
  primary: 'var(--chart-1)',
  secondary: 'var(--chart-2)',
  grid: 'var(--chart-grid)',
  text: 'var(--text-muted)',
} as const;
