# 0005. Open Library as primary lookup, Google Books as fallback

- Status: accepted
- Date: 14/11/2026

## Context

Adding a book should take a barcode scan or a short search. Open Library is free, open and needs no key, but its data API lacks synopses and its coverage of recent or regional editions has gaps. Google Books has good descriptions, page counts and covers but has quotas and terms of use.

## Decision

Look up ISBNs in Open Library first (`/api/books?jscmd=data`), then query Google Books to fill a missing synopsis, cover or page count, or to supply the whole record when Open Library has none. Searches use Open Library and fall back to Google Books only when Open Library returns nothing or fails. Both are normalised into one `BookCandidate` shape. `GOOGLE_BOOKS_API_KEY` is optional. Covers are downloaded into a local cache when a book is created.

## Consequences

- Works with no API keys; a key only raises the Google quota.
- An ISBN lookup usually makes two outbound requests.
- Upstream payloads are parsed defensively; malformed results are dropped rather than trusted.
- Cached covers keep the library working offline and avoid hot-linking.
