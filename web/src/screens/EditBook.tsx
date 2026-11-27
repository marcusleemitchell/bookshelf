/**
 * Edit details (SPEC §6.4, ADR 0011): a parent or admin changes a catalogue
 * book's details, picks a cover or synopsis from the alternatives the server
 * finds (`GET /api/books/:id/alternatives`), or pastes a cover image address.
 * Saving sends only the changed fields (`PATCH /api/books/:id`); catalogue
 * edits need the server (ADR 0010).
 */
import { useState } from 'react';
import {
  bookDetailSchema,
  httpUrlSchema,
  normaliseIsbn,
  type BookAlternatives,
  type BookDetail,
  type BookUpdate,
  type LookupSource,
} from '../../../shared/index.ts';
import { storeDetail } from '../app/actions.ts';
import {
  useAction,
  useCanEditCatalogue,
  useResource,
  useServices,
  useStore,
} from '../app/hooks.ts';
import { showToast } from '../app/services.ts';
import { ActionError, Cover, Loading, ResourceView, ScreenHeader } from '../components/ui.tsx';
import { plural } from '../lib/labels.ts';
import { splitList } from '../lib/text.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, navigate, paths } from '../router.ts';

/** Longest synopsis the catalogue accepts (`catalogueFields.synopsis`). */
const MAX_SYNOPSIS_LENGTH = 20_000;

const SOURCE_NAMES: Record<LookupSource, string> = {
  openlibrary: 'Open Library',
  googlebooks: 'Google Books',
};

export function EditBook({ bookId }: { bookId: string }) {
  const services = useServices();
  const auth = useStore(services.auth);
  const canEdit = useCanEditCatalogue();
  const detail = useResource(canEdit ? cacheKeys.book(bookId) : null, bookDetailSchema, (api) =>
    api.getBook(bookId),
  );
  let body;
  if (auth.status === 'checking') {
    body = <Loading />;
  } else if (!canEdit) {
    body = (
      <p className="card" role="note">
        {auth.status === 'signedIn'
          ? 'Ask a parent to change the details of a book.'
          : 'Changing the details of a book needs a connection to the server.'}
      </p>
    );
  } else {
    body = (
      <ResourceView resource={detail} loadingLabel="Loading the book…">
        {/* A newer version of the book (someone else saved) starts the form afresh. */}
        {(book) => <EditForm key={book.updatedAt} book={book} />}
      </ResourceView>
    );
  }
  return (
    <>
      <ScreenHeader title="Edit details" back={paths.book(bookId)} />
      {body}
    </>
  );
}

/** The form's text fields; list fields are comma-separated. */
export interface DetailsDraft {
  title: string;
  subtitle: string;
  authors: string;
  publisher: string;
  publishedDate: string;
  language: string;
  isbn: string;
  genres: string;
  coverUrl: string;
  synopsis: string;
}

export function draftFrom(book: BookDetail): DetailsDraft {
  return {
    title: book.title,
    subtitle: book.subtitle ?? '',
    authors: book.authors.join(', '),
    publisher: book.publisher ?? '',
    publishedDate: book.publishedDate ?? '',
    language: book.language ?? '',
    isbn: book.isbn13 ?? book.isbn10 ?? '',
    genres: book.genres.join(', '),
    coverUrl: book.coverUrl ?? '',
    synopsis: book.synopsis ?? '',
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The catalogue fields that differ from `book`, or a message saying what to
 * fix. An unchanged ISBN field is left alone; a changed one sets both forms.
 */
export function buildPatch(book: BookDetail, draft: DetailsDraft): BookUpdate | string {
  const title = draft.title.trim();
  if (!title) return 'Enter a title.';
  const isbnText = draft.isbn.trim();
  const isbn = isbnText ? normaliseIsbn(isbnText) : null;
  if (isbnText && !isbn) return 'That isn’t a valid ISBN-10 or ISBN-13.';
  const coverUrl = draft.coverUrl.trim() || null;
  if (coverUrl && !httpUrlSchema.safeParse(coverUrl).success) {
    return 'Enter the full address of the cover image, starting with https://.';
  }
  const synopsis = draft.synopsis.trim() || null;
  if (synopsis && synopsis.length > MAX_SYNOPSIS_LENGTH) {
    return 'The synopsis is too long: at most 20,000 characters.';
  }

  const patch: BookUpdate = {};
  if (title !== book.title) patch.title = title;
  const texts = {
    subtitle: draft.subtitle,
    publisher: draft.publisher,
    publishedDate: draft.publishedDate,
    language: draft.language,
  } as const;
  for (const [field, value] of Object.entries(texts) as [keyof typeof texts, string][]) {
    const next = value.trim() || null;
    if (next !== book[field]) patch[field] = next;
  }
  const authors = splitList(draft.authors);
  if (!sameList(authors, book.authors)) patch.authors = authors;
  const genres = splitList(draft.genres);
  if (!sameList(genres, book.genres)) patch.genres = genres;
  if (isbnText !== draftFrom(book).isbn) {
    patch.isbn13 = isbn?.isbn13 ?? null;
    patch.isbn10 = isbn?.isbn10 ?? null;
  }
  if (coverUrl !== book.coverUrl) patch.coverUrl = coverUrl;
  if (synopsis !== book.synopsis) patch.synopsis = synopsis;
  return patch;
}

/** "Found 3 covers and 1 synopsis.", plus which sources couldn't be reached. */
export function foundText({ covers, synopses, unavailable }: BookAlternatives): string {
  const found =
    covers.length + synopses.length === 0
      ? 'No covers or synopses found.'
      : `Found ${plural(covers.length, 'cover')} and ${plural(synopses.length, 'synopsis', 'synopses')}.`;
  if (unavailable.length === 0) return found;
  const names = unavailable.map((source) => SOURCE_NAMES[source]).join(' and ');
  return `${found} ${names} couldn’t be reached, so some may be missing.`;
}

function EditForm({ book }: { book: BookDetail }) {
  const services = useServices();
  const [draft, setDraft] = useState<DetailsDraft>(() => draftFrom(book));
  const [alternatives, setAlternatives] = useState<BookAlternatives | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const finding = useAction();
  const saving = useAction();

  const set = (field: keyof DetailsDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const coverText = draft.coverUrl.trim();
  const coverPreview =
    coverText === (book.coverUrl ?? '')
      ? book.coverSrc
      : (alternatives?.covers.find((option) => option.url === coverText)?.previewUrl ??
        (httpUrlSchema.safeParse(coverText).success ? coverText : null));

  const submit = () => {
    setValidation(null);
    const patch = buildPatch(book, draft);
    if (typeof patch === 'string') {
      setValidation(patch);
      return;
    }
    if (Object.keys(patch).length === 0) {
      navigate(paths.book(book.id), { replace: true });
      return;
    }
    saving.run(async () => {
      const updated = await services.api.updateBook(book.id, patch);
      await storeDetail(services, updated);
      showToast(services, 'Details saved.');
      navigate(paths.book(book.id), { replace: true });
    });
  };

  const textField = (field: keyof DetailsDraft, label: string, hint?: string) => {
    const id = `edit-${field}`;
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={draft[field]}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => {
            set(field, event.target.value);
          }}
        />
        {hint && (
          <span className="field-hint" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </div>
    );
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
      <section className="card stack-sm" aria-labelledby="find-heading">
        <h2 id="find-heading">Covers and synopses</h2>
        <p className="small muted">
          Look up other covers and synopses for this book on Open Library and Google Books.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={finding.busy}
            onClick={() => {
              finding.run(async () => {
                setAlternatives(await services.api.bookAlternatives(book.id));
              });
            }}
          >
            {finding.busy ? 'Looking…' : alternatives ? 'Look again' : 'Find covers and synopses'}
          </button>
        </div>
        <ActionError error={finding.error} />
        {alternatives && (
          <p className="small" role="status">
            {foundText(alternatives)}
          </p>
        )}
      </section>

      <section className="section stack-sm" aria-labelledby="cover-heading">
        <h2 id="cover-heading">Cover</h2>
        <div className="book-hero">
          <Cover src={coverPreview} title={draft.title || book.title} size="lg" />
        </div>
        {alternatives && alternatives.covers.length > 0 && (
          <ul className="cover-options" aria-label="Covers found">
            {alternatives.covers.map((option, i) => (
              <li key={option.url}>
                <button
                  type="button"
                  className="cover-option"
                  aria-pressed={coverText === option.url}
                  aria-label={`Cover ${i + 1}: ${option.label}`}
                  title={option.label}
                  onClick={() => {
                    set('coverUrl', option.url);
                  }}
                >
                  <img src={option.previewUrl} alt="" loading="lazy" decoding="async" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="field">
          <label htmlFor="edit-coverUrl">Cover image address</label>
          <input
            id="edit-coverUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={draft.coverUrl}
            aria-describedby="edit-coverUrl-hint"
            onChange={(event) => {
              set('coverUrl', event.target.value);
            }}
          />
          <span className="field-hint" id="edit-coverUrl-hint">
            Choose a cover above or paste the address of an image. Leave it empty for no cover.
          </span>
        </div>
      </section>

      <section className="section stack-sm" aria-labelledby="synopsis-heading">
        <h2 id="synopsis-heading">Synopsis</h2>
        <div className="field">
          <label htmlFor="edit-synopsis">Synopsis</label>
          <textarea
            id="edit-synopsis"
            rows={8}
            value={draft.synopsis}
            onChange={(event) => {
              set('synopsis', event.target.value);
            }}
          />
        </div>
        {alternatives && alternatives.synopses.length > 0 && (
          <ul className="list stack-sm" aria-label="Synopses found">
            {alternatives.synopses.map((option) => {
              const inUse = draft.synopsis.trim() === option.text;
              return (
                <li key={option.text} className="card stack-sm">
                  <p className="small muted">{option.label}</p>
                  <p className="synopsis synopsis-option">{option.text}</p>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={inUse}
                      aria-label={
                        inUse ? `In use (${option.label})` : `Use this synopsis (${option.label})`
                      }
                      onClick={() => {
                        set('synopsis', option.text);
                      }}
                    >
                      {inUse ? 'In use' : 'Use this synopsis'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="section stack-sm" aria-labelledby="details-heading">
        <h2 id="details-heading">Details</h2>
        {textField('title', 'Title')}
        {textField('subtitle', 'Subtitle')}
        {textField('authors', 'Authors', 'Separate several authors with commas.')}
        <div className="grid-2">
          {textField('isbn', 'ISBN')}
          {textField('publishedDate', 'Published')}
        </div>
        {textField('publisher', 'Publisher')}
        {textField('language', 'Language', 'A language code, for example en.')}
        {textField('genres', 'Genres', 'Separate several genres with commas.')}
      </section>

      {validation && (
        <p className="error-text" role="alert">
          {validation}
        </p>
      )}
      <ActionError error={saving.error} />
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={saving.busy}>
          {saving.busy ? 'Saving…' : 'Save'}
        </button>
        <a className="btn btn-ghost" href={href(paths.book(book.id))}>
          Cancel
        </a>
      </div>
    </form>
  );
}
