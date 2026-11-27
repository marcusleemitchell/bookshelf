# 0011. Alternative covers and synopses for editing a book

- Status: accepted
- Date: 27/11/2026

## Context

The cover and synopsis a book gets when it is added are whatever the lookup picked first (ADR 0005, ADR 0008): the ISBN lookup merges the Open Library data API, edition record, work record and Google Books into one candidate, keeping the first non-empty value. Parents and admins could already change any catalogue field through `PATCH /api/books/:id` (ADR 0010), but the app had no screen for it, and nothing could offer a _different_ cover or synopsis: the lookup only returns the winner.

Covers were also always addressed as `/api/covers/:id`, which the service worker caches CacheFirst for 60 days and the server marks `max-age=86400`, so a changed cover kept showing the old image.

## Decision

- **Versioned cover URLs.** `coverSrc` (and the calendar's `coverUrl`) is `/api/covers/:id?v=<token>`, the token being the first 12 hex digits of the SHA-256 of the cover URL (or of the cached file name when there is no URL). It changes exactly when the cover is replaced, so URL-keyed caches fetch the new image and unchanged covers stay cached. The route ignores the query.
- **A read-only alternatives endpoint**, `GET /api/books/:id/alternatives`, for parents and admins, returns every cover and synopsis it can find instead of one winner:
  - Open Library edition record (by the book's edition id, else by ISBN) → "This edition" covers and description; the work record (by work id, the edition's work, or a title + first-author search with the same main title) → the work description and the covers of every edition, which the work record lists in one request. Per-edition records (`/works/<id>/editions.json`) were not used: edition descriptions are rare and the work's cover list already holds every edition's covers.
  - Google Books only when `GOOGLE_BOOKS_API_KEY` is set (keyless requests are refused, ADR 0008), searching by title and author and keeping volumes with the same main title.
  - Options are de-duplicated and capped (24 covers, 10 synopses); a source that fails is reported in `unavailable` while the others' options are still returned; `502` only when nothing was found and every source asked failed.
- **Choosing is an ordinary edit.** The Edit details screen saves through the existing `PATCH /api/books/:id`, which re-downloads the cover into the cache. A cover can also be any pasted image URL. Catalogue edits stay online-only (ADR 0010).

## Consequences

- Finding alternatives costs one to four Open Library requests (edition, work, or ISBN-10/13 and a search) plus one Google Books request with a key, and only runs when the user asks for it.
- The cover picker loads previews straight from Open Library and Google Books, like search results in Add book; saved covers are still served from our cache.
- Without a Google Books key there are at most two synopses (edition and work), often one; a key is the way to more choice.
- The server fetches any `http(s)` cover URL a parent or admin pastes, including private addresses. This was already true of `coverUrl` in `POST`/`PATCH /api/books`; it is accepted because the server is reachable only on the tailnet and only family members can sign in (ADR 0002, ADR 0010).
- Cover cache entries under old unversioned URLs simply expire (60 days, at most 1000 entries).
