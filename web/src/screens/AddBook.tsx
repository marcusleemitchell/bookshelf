/**
 * Add book (SPEC §6.3): scan a barcode, type an ISBN or search by title /
 * author, pick a candidate, confirm formats and lengths — or enter the book
 * manually. Lookups and creating books need the server; offline the screen
 * says so instead of failing silently.
 */
import { useState } from 'react';
import {
  bookListSchema,
  bookStatusSchema,
  formatPublishedDate,
  formatTypeSchema,
  mergeCandidates,
  normaliseIsbn,
  parseAudioPosition,
  type BookCandidate,
  type BookCreate,
  type BookStatus,
  type FormatCreate,
  type FormatType,
} from '../../../shared/index.ts';
import { ApiError, isOfflineError } from '../api/client.ts';
import { invalidate } from '../app/services.ts';
import { useAction, useReachable, useResource, useServices } from '../app/hooks.ts';
import { BarcodeScanner, type ScannerDeps } from '../components/BarcodeScanner.tsx';
import { ActionError, ScreenHeader } from '../components/ui.tsx';
import { FORMAT_LABELS, STATUS_LABELS, STATUS_ORDER } from '../lib/labels.ts';
import { splitList } from '../lib/text.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, navigate, paths } from '../router.ts';

type Method = 'scan' | 'isbn' | 'search' | 'manual';

const METHOD_LABELS: Record<Method, string> = {
  scan: 'Scan',
  isbn: 'ISBN',
  search: 'Search',
  manual: 'Manual',
};

/** What the confirm form starts from: a looked-up candidate or a blank manual entry. */
export interface Draft {
  candidate: BookCandidate | null;
  isbn: string;
}

export function AddBook({ scannerDeps }: { scannerDeps?: ScannerDeps }) {
  const [method, setMethod] = useState<Method>('scan');
  const [draft, setDraft] = useState<Draft | null>(null);

  if (draft) {
    return (
      <>
        <ScreenHeader title="Confirm book" back={paths.add()} />
        <ConfirmBook
          draft={draft}
          onBack={() => {
            setDraft(null);
          }}
        />
      </>
    );
  }

  return (
    <>
      <ScreenHeader title="Add book" back={paths.library()} />
      <div className="stack">
        <div className="segmented" role="tablist" aria-label="How to find the book">
          {(Object.keys(METHOD_LABELS) as Method[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={method === m}
              aria-controls="add-method"
              onClick={() => {
                setMethod(m);
              }}
            >
              {METHOD_LABELS[m]}
            </button>
          ))}
        </div>
        <div id="add-method" role="tabpanel" className="stack">
          {method === 'manual' ? (
            <div className="stack-sm">
              <p className="muted">
                Enter the details yourself — useful for books no service knows.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setDraft({ candidate: null, isbn: '' });
                }}
              >
                Start manual entry
              </button>
            </div>
          ) : (
            <Lookup method={method} onPick={setDraft} {...(scannerDeps ? { scannerDeps } : {})} />
          )}
        </div>
      </div>
    </>
  );
}

const NEEDS_CONNECTION =
  'Looking up books needs a connection to the server. Try again when you’re back online.';

function lookupErrorMessage(error: unknown, isbn?: string): string {
  if (isOfflineError(error)) return NEEDS_CONNECTION;
  if (error instanceof ApiError && error.code === 'not_found') {
    return `No book found for ISBN ${isbn ?? ''}. Check the number, search by title, or enter it manually.`;
  }
  if (error instanceof ApiError && error.code === 'upstream_error') {
    return 'The book services couldn’t be reached. Try again in a moment, or enter the book manually.';
  }
  return error instanceof Error ? error.message : 'The lookup failed.';
}

function Lookup({
  method,
  onPick,
  scannerDeps,
}: {
  method: Exclude<Method, 'manual'>;
  onPick: (draft: Draft) => void;
  scannerDeps?: ScannerDeps;
}) {
  const services = useServices();
  const reachable = useReachable();
  const [isbnText, setIsbnText] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{
    q: string;
    page: number;
    items: BookCandidate[];
    more: boolean;
  } | null>(null);
  const [message, setMessage] = useState<{ text: string; isbn: string | null } | null>(null);
  const { busy, run } = useAction();

  const lookupIsbn = (raw: string) => {
    setMessage(null);
    const normalised = normaliseIsbn(raw);
    if (!normalised) {
      setMessage({ text: 'That isn’t a valid ISBN-10 or ISBN-13.', isbn: null });
      return;
    }
    run(async () => {
      try {
        const candidate = await services.api.lookupIsbn(normalised.isbn13);
        onPick({ candidate, isbn: normalised.isbn13 });
      } catch (error) {
        setMessage({ text: lookupErrorMessage(error, normalised.isbn13), isbn: normalised.isbn13 });
      }
    });
  };

  /**
   * Search results describe a work and carry no synopsis, so picking one with
   * an ISBN-13 fetches that edition's full record, keeping the search
   * result's values for anything the record lacks (ADR 0008). If the lookup
   * fails, the search result is used as it is.
   */
  const pickSearchResult = (picked: BookCandidate) => {
    const isbn = picked.isbn13 ?? picked.isbn10 ?? '';
    const isbn13 = picked.isbn13;
    if (picked.synopsis !== null || isbn13 === null) {
      onPick({ candidate: picked, isbn });
      return;
    }
    setMessage(null);
    run(async () => {
      let detailed = picked;
      try {
        detailed = mergeCandidates(await services.api.lookupIsbn(isbn13), picked);
      } catch {
        // The search result alone is still a good starting point.
      }
      onPick({ candidate: detailed, isbn });
    });
  };

  const search = (q: string, page: number) => {
    setMessage(null);
    run(async () => {
      try {
        const items = await services.api.searchBooks(q, page);
        setResults((prev) => ({
          q,
          page,
          items: page > 1 && prev ? [...prev.items, ...items] : items,
          more: items.length >= 20,
        }));
        if (page === 1 && items.length === 0) {
          setMessage({
            text: `Nothing found for “${q}”. Try different words, or enter it manually.`,
            isbn: null,
          });
        }
      } catch (error) {
        setMessage({ text: lookupErrorMessage(error), isbn: null });
      }
    });
  };

  if (!reachable) {
    return (
      <p className="card" role="status">
        {NEEDS_CONNECTION}
      </p>
    );
  }

  return (
    <div className="stack">
      {method === 'scan' && (
        <>
          <BarcodeScanner
            onDetected={(isbn) => {
              setIsbnText(isbn);
              lookupIsbn(isbn);
            }}
            {...(scannerDeps ? { deps: scannerDeps } : {})}
          />
          {busy && <p role="status">Looking up {isbnText}…</p>}
        </>
      )}

      {method === 'isbn' && (
        <form
          className="stack-sm"
          onSubmit={(event) => {
            event.preventDefault();
            lookupIsbn(isbnText);
          }}
        >
          <div className="field">
            <label htmlFor="add-isbn">ISBN</label>
            <input
              id="add-isbn"
              inputMode="numeric"
              autoComplete="off"
              placeholder="978…"
              value={isbnText}
              onChange={(event) => {
                setIsbnText(event.target.value);
              }}
            />
            <span className="field-hint">ISBN-10 or ISBN-13, with or without hyphens.</span>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || isbnText.trim() === ''}
          >
            {busy ? 'Looking up…' : 'Look up'}
          </button>
        </form>
      )}

      {method === 'search' && (
        <form
          className="stack-sm"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) search(query.trim(), 1);
          }}
        >
          <div className="field">
            <label htmlFor="add-search">Title or author</label>
            <input
              id="add-search"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || query.trim() === ''}>
            {busy && !results ? 'Searching…' : 'Search'}
          </button>
        </form>
      )}

      {message && (
        <div className="card stack-sm" role="alert">
          <p>{message.text}</p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              onPick({ candidate: null, isbn: message.isbn ?? '' });
            }}
          >
            Enter manually
          </button>
        </div>
      )}

      {method === 'search' && results && results.items.length > 0 && (
        <section aria-label="Search results" className="stack-sm">
          <ul className="list card">
            {results.items.map((candidate) => (
              <li key={`${candidate.source}:${candidate.sourceId}`}>
                <CandidateRow
                  candidate={candidate}
                  disabled={busy}
                  onPick={() => {
                    pickSearchResult(candidate);
                  }}
                />
              </li>
            ))}
          </ul>
          {results.more && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                search(results.q, results.page + 1);
              }}
            >
              {busy ? 'Loading…' : 'More results'}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function CandidateCover({ candidate, size }: { candidate: BookCandidate; size: 'sm' | 'lg' }) {
  if (!candidate.coverUrl) {
    return (
      <span className={`cover cover-${size} cover-placeholder`} aria-hidden="true">
        {size === 'sm' ? '' : candidate.title}
      </span>
    );
  }
  return (
    <img
      className={`cover cover-${size}`}
      src={candidate.coverUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

function CandidateRow({
  candidate,
  disabled,
  onPick,
}: {
  candidate: BookCandidate;
  disabled: boolean;
  onPick: () => void;
}) {
  const details = [
    candidate.authors.join(', '),
    candidate.publishedDate && formatPublishedDate(candidate.publishedDate),
    candidate.pageCount ? `${candidate.pageCount} pages` : null,
  ].filter(Boolean);
  return (
    <div className="list-item">
      <CandidateCover candidate={candidate} size="sm" />
      <div className="grow">
        <strong>{candidate.title}</strong>
        {candidate.subtitle && <span className="small">: {candidate.subtitle}</span>}
        <p className="small muted">{details.join(' · ')}</p>
      </div>
      <button
        type="button"
        className="btn btn-small"
        onClick={onPick}
        disabled={disabled}
        aria-label={`Choose ${candidate.title}`}
      >
        Choose
      </button>
    </div>
  );
}

interface FormatDraft {
  enabled: boolean;
  length: string;
}

function ConfirmBook({ draft, onBack }: { draft: Draft; onBack: () => void }) {
  const services = useServices();
  const candidate = draft.candidate;
  const library = useResource(cacheKeys.books, bookListSchema, (api) => api.listBooks());
  const [bookId] = useState(() => services.newId());
  const [title, setTitle] = useState(candidate?.title ?? '');
  const [subtitle, setSubtitle] = useState(candidate?.subtitle ?? '');
  const [authors, setAuthors] = useState(candidate?.authors.join(', ') ?? '');
  const [publisher, setPublisher] = useState(candidate?.publisher ?? '');
  const [publishedDate, setPublishedDate] = useState(candidate?.publishedDate ?? '');
  const [isbn, setIsbn] = useState(draft.isbn);
  const [genres, setGenres] = useState(candidate?.genres.join(', ') ?? '');
  const [synopsis, setSynopsis] = useState(candidate?.synopsis ?? '');
  const [status, setStatus] = useState<BookStatus>('to_read');
  const [formats, setFormats] = useState<Record<FormatType, FormatDraft>>({
    physical: { enabled: true, length: candidate?.pageCount ? String(candidate.pageCount) : '' },
    kindle: { enabled: false, length: '' },
    audiobook: { enabled: false, length: '' },
  });
  const [validation, setValidation] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const normalisedIsbn = isbn.trim() ? normaliseIsbn(isbn) : null;
  const duplicate =
    normalisedIsbn && library.data?.find((book) => book.isbn13 === normalisedIsbn.isbn13);

  const setFormat = (format: FormatType, change: Partial<FormatDraft>) => {
    setFormats((prev) => ({ ...prev, [format]: { ...prev[format], ...change } }));
  };

  const buildFormats = (): FormatCreate[] | string => {
    const result: FormatCreate[] = [];
    for (const format of formatTypeSchema.options) {
      const entry = formats[format];
      if (!entry.enabled) continue;
      const text = entry.length.trim();
      if (format === 'audiobook') {
        const seconds = text ? parseAudioPosition(text) : null;
        if (text && (seconds === null || seconds <= 0)) {
          return 'Audiobook length must be h:mm:ss, for example 11:05:00.';
        }
        result.push({ format, audioDurationSeconds: seconds, pageCount: null });
      } else {
        const pages = text ? Number(text) : null;
        if (pages !== null && (!Number.isInteger(pages) || pages <= 0)) {
          return `${FORMAT_LABELS[format]} page count must be a whole number above zero.`;
        }
        result.push({ format, pageCount: pages, audioDurationSeconds: null });
      }
    }
    return result;
  };

  const submit = () => {
    setValidation(null);
    if (title.trim() === '') {
      setValidation('Enter a title.');
      return;
    }
    if (isbn.trim() && !normalisedIsbn) {
      setValidation('That isn’t a valid ISBN-10 or ISBN-13.');
      return;
    }
    const builtFormats = buildFormats();
    if (typeof builtFormats === 'string') {
      setValidation(builtFormats);
      return;
    }
    const body: BookCreate = {
      id: bookId,
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      authors: splitList(authors),
      publisher: publisher.trim() || null,
      publishedDate: publishedDate.trim() || null,
      language: candidate?.language ?? null,
      synopsis: synopsis.trim() || null,
      coverUrl: candidate?.coverUrl ?? null,
      isbn10: normalisedIsbn?.isbn10 ?? null,
      isbn13: normalisedIsbn?.isbn13 ?? null,
      genres: splitList(genres),
      source: candidate?.source ?? 'manual',
      sourceId: candidate?.sourceId ?? null,
      status,
      formats: builtFormats,
    };
    run(async () => {
      const created = await services.api.createBook(body);
      await services.cache.put(cacheKeys.book(created.id), created);
      invalidate(services);
      navigate(paths.book(created.id), { replace: true });
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
      {candidate && (
        <div className="book-hero">
          <CandidateCover candidate={candidate} size="lg" />
          <div className="info">
            <p className="small muted">
              Found on {candidate.source === 'openlibrary' ? 'Open Library' : 'Google Books'}. Check
              the details, then choose your formats.
            </p>
          </div>
        </div>
      )}
      {duplicate && (
        <p className="card" role="note">
          This ISBN is already in your library:{' '}
          <a href={href(paths.book(duplicate.id))}>{duplicate.title}</a>.
        </p>
      )}
      <div className="field">
        <label htmlFor="book-title">Title</label>
        <input
          id="book-title"
          required
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="book-subtitle">Subtitle</label>
        <input
          id="book-subtitle"
          value={subtitle}
          onChange={(event) => {
            setSubtitle(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="book-authors">Authors</label>
        <input
          id="book-authors"
          value={authors}
          aria-describedby="book-authors-hint"
          onChange={(event) => {
            setAuthors(event.target.value);
          }}
        />
        <span className="field-hint" id="book-authors-hint">
          Separate several authors with commas.
        </span>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="book-isbn">ISBN</label>
          <input
            id="book-isbn"
            inputMode="numeric"
            value={isbn}
            onChange={(event) => {
              setIsbn(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="book-published">Published</label>
          <input
            id="book-published"
            value={publishedDate}
            onChange={(event) => {
              setPublishedDate(event.target.value);
            }}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="book-publisher">Publisher</label>
        <input
          id="book-publisher"
          value={publisher}
          onChange={(event) => {
            setPublisher(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="book-genres">Genres</label>
        <input
          id="book-genres"
          value={genres}
          onChange={(event) => {
            setGenres(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="book-synopsis">Synopsis</label>
        <textarea
          id="book-synopsis"
          value={synopsis}
          onChange={(event) => {
            setSynopsis(event.target.value);
          }}
        />
      </div>

      <fieldset className="stack-sm">
        <legend>Formats you have</legend>
        {formatTypeSchema.options.map((format) => (
          <div key={format} className="stack-sm">
            <label className="check">
              <input
                type="checkbox"
                checked={formats[format].enabled}
                onChange={(event) => {
                  setFormat(format, { enabled: event.target.checked });
                }}
              />
              {FORMAT_LABELS[format]}
            </label>
            {formats[format].enabled && (
              <div className="field">
                <label htmlFor={`length-${format}`}>
                  {format === 'audiobook' ? 'Length (h:mm:ss)' : 'Page count'}
                </label>
                <input
                  id={`length-${format}`}
                  inputMode={format === 'audiobook' ? 'text' : 'numeric'}
                  placeholder={format === 'audiobook' ? '11:05:00' : ''}
                  value={formats[format].length}
                  onChange={(event) => {
                    setFormat(format, { length: event.target.value });
                  }}
                />
              </div>
            )}
          </div>
        ))}
        <p className="field-hint">
          Lengths let Bookshelf work out percentages; you can add them later.
        </p>
      </fieldset>

      <div className="field">
        <label htmlFor="book-status">Shelf</label>
        <select
          id="book-status"
          value={status}
          onChange={(event) => {
            setStatus(bookStatusSchema.parse(event.target.value));
          }}
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {validation && (
        <p className="error-text" role="alert">
          {validation}
        </p>
      )}
      <ActionError error={error} />
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add to library'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}
