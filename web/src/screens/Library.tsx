/**
 * Library (SPEC §6.2): shelves (Reading, To read, Finished, Did not finish),
 * tag filter and search, and the way into Add book. The full list is loaded
 * once (and cached for offline use) and filtered on the device.
 */
import { useState } from 'react';
import {
  bookListSchema,
  tagListSchema,
  type BookListItem,
  type BookStatus,
} from '../../../shared/index.ts';
import { useResource } from '../app/hooks.ts';
import { PlusIcon } from '../components/Icons.tsx';
import { Cover, ProgressBar, ResourceView, ScreenHeader } from '../components/ui.tsx';
import { STATUS_LABELS, STATUS_ORDER, formatPercent, plural } from '../lib/labels.ts';
import { cacheKeys } from '../offline/cache.ts';
import { href, paths } from '../router.ts';

/** Case- and accent-insensitive match on title, subtitle, authors and ISBNs. */
export function matchesSearch(book: BookListItem, query: string): boolean {
  const fold = (value: string) =>
    value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-GB');
  const needle = fold(query.trim());
  if (needle === '') return true;
  const haystack = [
    book.title,
    book.subtitle ?? '',
    ...book.authors,
    book.isbn10 ?? '',
    book.isbn13 ?? '',
  ]
    .map(fold)
    .join('\n');
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

export function Library() {
  const books = useResource(cacheKeys.books, bookListSchema, (api) => api.listBooks());
  const tags = useResource(cacheKeys.tags, tagListSchema, (api) => api.listTags());
  const [shelf, setShelf] = useState<BookStatus>('reading');
  const [tagId, setTagId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  return (
    <>
      <ScreenHeader
        title="Library"
        actions={
          <a className="btn btn-primary btn-small" href={href(paths.add())}>
            <PlusIcon /> Add book
          </a>
        }
      />
      <div className="stack">
        <div className="field">
          <label htmlFor="library-search" className="sr-only">
            Search your library
          </label>
          <input
            id="library-search"
            type="search"
            placeholder="Search title, author or ISBN"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>

        <ResourceView resource={books} loadingLabel="Loading your library…">
          {(all) => {
            const filtered = all.filter(
              (book) =>
                (tagId === null || book.tagIds.includes(tagId)) && matchesSearch(book, query),
            );
            const counts = Object.fromEntries(
              STATUS_ORDER.map((status) => [
                status,
                filtered.filter((b) => b.status === status).length,
              ]),
            ) as Record<BookStatus, number>;
            const searching = query.trim() !== '';
            const shown = searching ? filtered : filtered.filter((book) => book.status === shelf);
            return (
              <>
                {!searching && (
                  <div className="segmented segmented-grid" role="tablist" aria-label="Shelves">
                    {STATUS_ORDER.map((status) => (
                      <button
                        key={status}
                        type="button"
                        role="tab"
                        aria-selected={shelf === status}
                        aria-controls="shelf-books"
                        onClick={() => {
                          setShelf(status);
                        }}
                      >
                        {STATUS_LABELS[status]} ({counts[status]})
                      </button>
                    ))}
                  </div>
                )}
                {tags.data && tags.data.length > 0 && (
                  <div className="chips" role="group" aria-label="Filter by tag">
                    {tags.data.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className="chip"
                        aria-pressed={tagId === tag.id}
                        onClick={() => {
                          setTagId(tagId === tag.id ? null : tag.id);
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
                )}
                <div id="shelf-books" role={searching ? undefined : 'tabpanel'}>
                  {searching && (
                    <p className="small muted" role="status">
                      {plural(shown.length, 'book')} found
                    </p>
                  )}
                  {shown.length === 0 ? (
                    <EmptyShelf hasBooks={all.length > 0} />
                  ) : (
                    <ul className="book-grid">
                      {shown.map((book) => (
                        <li key={book.id}>
                          <BookTile book={book} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            );
          }}
        </ResourceView>
      </div>
    </>
  );
}

function EmptyShelf({ hasBooks }: { hasBooks: boolean }) {
  return (
    <div className="empty">
      {hasBooks ? (
        <p>No books here.</p>
      ) : (
        <>
          <p>Your library is empty.</p>
          <p>
            <a href={href(paths.add())}>Add your first book</a> by scanning its barcode, typing its
            ISBN or searching.
          </p>
        </>
      )}
    </div>
  );
}

function BookTile({ book }: { book: BookListItem }) {
  return (
    <a className="book-tile" href={href(paths.book(book.id))}>
      <Cover src={book.coverSrc} title={book.title} size="fill" />
      <span className="title">{book.title}</span>
      <span className="author">{book.authors.join(', ')}</span>
      {book.status === 'reading' && (
        <>
          <ProgressBar percent={book.progressPercent} label={`${book.title} progress`} />
          <span className="sr-only">
            {book.progressPercent === null
              ? 'Progress unknown'
              : `${formatPercent(book.progressPercent)} read`}
          </span>
        </>
      )}
    </a>
  );
}
