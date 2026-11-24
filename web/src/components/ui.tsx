/**
 * Small shared UI pieces: screen header, cover, progress bar, loading and
 * error states, and the resource gate that renders cached data offline.
 */
import { useState, type ReactNode } from 'react';
import { errorMessage, isOfflineError } from '../api/client.ts';
import type { Resource } from '../app/hooks.ts';
import { formatPercent } from '../lib/labels.ts';
import { href } from '../router.ts';
import { BackIcon } from './Icons.tsx';

export function ScreenHeader({
  title,
  back,
  actions,
}: {
  title: string;
  /** App path for the back button. */
  back?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="screen-header">
      {back !== undefined && (
        <a className="icon-btn" href={href(back)} aria-label="Back">
          <BackIcon />
        </a>
      )}
      <h1 tabIndex={-1} data-screen-title>
        {title}
      </h1>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word))
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export type CoverSize = 'xs' | 'sm' | 'md' | 'lg' | 'fill';

/**
 * A book cover from `coverSrc` (`/api/covers/:id`), or a typographic
 * placeholder when there is none or it fails to load. Decorative: the title
 * is always shown or announced next to it.
 */
export function Cover({
  src,
  title,
  size = 'md',
}: {
  src: string | null;
  title: string;
  size?: CoverSize;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const className = `cover cover-${size}`;
  if (!src || failed === src) {
    return (
      <span className={`${className} cover-placeholder`} aria-hidden="true">
        {size === 'xs' ? '' : size === 'sm' ? initials(title) : title}
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => {
        setFailed(src);
      }}
    />
  );
}

export function ProgressBar({
  percent,
  label,
  large = false,
}: {
  percent: number | null;
  label: string;
  large?: boolean;
}) {
  const value = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      className={large ? 'progress progress-large' : 'progress'}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(value)}
      aria-valuetext={percent === null ? 'Progress unknown' : formatPercent(value)}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="empty" role="status">
      {label}
    </p>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const offline = isOfflineError(error);
  return (
    <div className="empty" role="alert">
      <p>
        {offline
          ? 'This hasn’t been saved on this device yet, and the server can’t be reached.'
          : errorMessage(error)}
      </p>
      {onRetry && (
        <p>
          <button type="button" className="btn btn-ghost" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Renders a resource: its data (fresh or cached), else loading, else error.
 */
export function ResourceView<T>({
  resource,
  children,
  loadingLabel,
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error !== undefined && !resource.loading)
    return <ErrorState error={resource.error} />;
  return <Loading {...(loadingLabel ? { label: loadingLabel } : {})} />;
}

/** Inline error message for a failed action (role="alert"). */
export function ActionError({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p className="error-text" role="alert">
      {isOfflineError(error)
        ? 'This needs a connection to the server. Try again when you’re back online.'
        : errorMessage(error)}
    </p>
  );
}

/** A numeric PIN input (digits only, at most 8; SPEC §5 sign-in). */
export function PinField({
  id,
  label,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (pin: string) => void;
  autoComplete: 'current-password' | 'new-password';
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={8}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => {
          onChange(event.target.value.replace(/\D/g, ''));
        }}
      />
    </div>
  );
}
