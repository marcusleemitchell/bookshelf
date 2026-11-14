# 0007. Offline read model in IndexedDB and client-side read bookkeeping

- Status: accepted
- Date: 14/11/2026

## Context

ADR 0004 queues offline writes in an outbox, but the app also has to _show_ data while the Mac is unreachable (Today, Library, Book detail at least), and some offline writes have side effects the server normally applies: logging a session opens a read and moves a `to_read` book to `reading`; changing status opens or closes reads. `POST /api/sync` replicates rows and deliberately does not repeat those side effects (SPEC §5.1).

Options for the read model:

1. Service worker runtime caching of `/api/*` GET responses (Workbox `NetworkFirst`).
2. The client stores the last good parsed response per resource in IndexedDB (Dexie), next to the outbox.

## Decision

- **Read model in IndexedDB (option 2).** A `cache` table keyed by resource (`books`, `book:<id>`, `notes:<id>`, `timer`, `goals`, `calendar:<month>`, …) holds the last good response. The resource hook shows the cached copy immediately, refreshes from the network, and falls back to the cache when the server is unreachable. Cached values are re-validated with their Zod schema when read, so data written by an older app version that no longer fits is ignored rather than crashing the UI. Entries untouched for 90 days are pruned at start-up.
- The service worker precaches only the app shell (including the barcode-scanner wasm) and runtime-caches cover images; it never caches API JSON.
- **Client-side bookkeeping.** Offline writes are built by pure functions (`web/src/offline/records.ts`) that mirror the REST rules in SPEC §4: an offline session uses the in-progress read or creates one (number = highest + 1), moves the read's start back for a retrospective session and re-shelves a `to_read` book; an offline status change opens/closes reads like `PATCH /api/books/:id`. Every changed row is queued as a full record in dependency order (book → read → session; timer and note ops on their own). The same functions return the projected read model, which is written to the cache so the change is visible straight away.
- Only session logging, timer actions, book status/rating and notes work offline. Everything else (adding books, lookups, formats, tags, goals, backups, Notion) needs the server and says so.

## Consequences

- One place (Dexie) holds both offline queues and offline data; the outbox and cache are testable with fake-indexeddb, and the service worker stays a simple precache.
- Responses are validated before they are cached and again when read, so the cache can never feed the UI shapes the contract does not allow.
- The client duplicates a small part of the server's read bookkeeping. Both follow SPEC §4; the client copy is covered by unit tests, and a mismatch only affects rows created offline (the server's LWW rules still apply on replay).
- The cache only knows resources the device has loaded before; a book never opened online shows "not saved on this device" offline.
- Projected offline progress is approximate (for example, the estimated finish is cleared until the next online refresh).
