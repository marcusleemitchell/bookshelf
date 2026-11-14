# Bookshelf

A personal, self-hosted reading tracker. Log reading sessions (time and progress) across physical books, Kindle ebooks and audiobooks; build a library by ISBN or title search; see statistics, a reading calendar, streaks and goals; and keep everything backed up locally (with an optional one-way mirror to Notion).

It runs as a small Node server on your Mac with a SQLite database as the single source of truth. The main client is an iPhone browser (installed to the Home Screen); a Mac browser works too. Single user, no accounts.

> Status: phase 2 — the server, API, backups, Notion mirror and the full web app (installable PWA with offline support and barcode scanning) are complete. Next: running it as an always-on service with HTTPS via Tailscale (see [Roadmap](#roadmap)).

## Prerequisites

- macOS (the default data location is under `~/Library/Application Support`)
- Node.js **25 or later** (`.nvmrc` pins 25.9.0; with nvm: `nvm use`)
- npm 11+

No native modules or compilers are needed: SQLite is Node's built-in `node:sqlite`, and the server's TypeScript runs directly on Node.

## Setup

```sh
git clone <this repo> bookshelf
cd bookshelf
npm install
cp .env.example .env   # optional; every setting has a default
npm run build          # type-check and build the web app
npm start              # http://127.0.0.1:4380
```

Check it is running:

```sh
curl http://127.0.0.1:4380/api/health
# {"ok":true,"version":"0.1.0","dbPath":".../Bookshelf/bookshelf.db"}
```

On first start the server creates the data directory, applies database migrations and writes a startup snapshot.

## Commands

| Command                 | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `npm run dev`           | Server (restarts on changes) plus the Vite dev server with an `/api` proxy  |
| `npm run dev:server`    | Server only, watching `server/` and `shared/`                               |
| `npm run build`         | Type-check everything and build the web app into `web/dist`                 |
| `npm start`             | Production server on `127.0.0.1:$PORT`, serving `web/dist` when it is built |
| `npm run lint`          | ESLint                                                                      |
| `npm run format`        | Format with Prettier                                                        |
| `npm run format:check`  | Check formatting                                                            |
| `npm run typecheck`     | TypeScript checks for server, shared and web                                |
| `npm test`              | Run the test suite once                                                     |
| `npm run test:coverage` | Tests with coverage (fails below 90% lines in server, shared, scripts, web) |
| `npm run check`         | Lint, format check, type-check and tests with coverage — the quality gate   |
| `npm run icons`         | Regenerate the app icons in `web/public/` (commit the result)               |

During development, point the server at a throwaway data directory so you never touch your real library, for example `BOOKSHELF_DATA_DIR=/tmp/bookshelf-dev npm run dev`.

## Using the app

Open the server's address in a browser (the Mac: <http://127.0.0.1:4380>; the iPhone: the HTTPS Tailscale address, see below). The tab bar has five screens:

- **Today** — the reading timer (start, pause, resume, then **Stop & log** to turn it into a session), the books you're reading with progress and an estimated finish date, today's minutes against your daily goal, and your streak. The timer keeps running while the app is closed.
- **Library** — shelves (Reading, To read, Finished, Did not finish), tag filter and search. **Add book** (also on Today) finds books by scanning the barcode, typing the ISBN, or searching by title/author, then lets you pick your formats (physical, Kindle, audiobook) and their lengths. Anything the services don't know can be entered manually.
- **Book detail** (tap a book) — shelf, rating, progress chart, sessions, notes and quotes, tags, formats and lengths, rereads, and the book's metadata.
- **Log session** — from a book or the timer: format, when you read, and progress in pages, percent or audiobook position (`h:mm:ss`).
- **Calendar** — each day shows the covers of what you read; tap a day for its sessions.
- **Stats** — week / month / year / all time: reading time, pages and progress charts, breakdowns by format, genre, tag and author, reading speed, goals and a year in review.
- **Settings** — goals, tags, backup export/import, Notion sync, server status and offline changes.

Dates are shown as `DD/MM/YYYY` in the device's timezone; set `BOOKSHELF_TZ` to the same zone so days line up.

### Installing on the iPhone Home Screen

The app is a PWA. Installing it needs HTTPS, which comes from `tailscale serve` (set up in phase 3, see [Roadmap](#roadmap)):

1. On the iPhone, with Tailscale connected, open the Mac's `https://<mac-name>.<tailnet>.ts.net` address in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch **Bookshelf** from the Home Screen: it opens full screen, without Safari's toolbars.

Updates install themselves: after a new `npm run build`, the next launch (or the one after) picks up the new version.

### Offline

If the Mac is asleep or unreachable, the app still opens (the service worker caches the app itself) and shows what it last loaded: Today, your library, books you've opened, notes, calendar months and stats you've viewed. A banner says you're offline and how many changes are waiting.

While offline you can log sessions, use the timer, change a book's shelf or rating, and add, edit or delete notes and quotes. These are saved on the device and sent to the server automatically when it is reachable again (on reconnect, when you return to the app, and every 30 seconds). Adding books, lookups, tags, formats, goals, backups and Notion need the server and say so.

If a change keeps being rejected (for example because it conflicts with something changed elsewhere), it is marked as failed: **Settings → Offline changes** shows the reason and lets you retry or discard it.

### Barcode scanning

**Add book → Scan** uses the rear camera to read the EAN-13 barcode on the back of a book (ISBNs starting 978 or 979). It needs:

- a **secure context**: HTTPS (the Tailscale address) or `http://127.0.0.1` / `localhost` on the Mac — plain `http://` to another host cannot use the camera;
- camera permission for the site (iPhone: **Settings → Apps → Safari → Camera**).

When the camera can't be used the app explains why; type the ISBN instead. The barcode decoder (zxing-wasm) is served by the app itself, so scanning works offline and sends nothing to third parties (looking the ISBN up still needs the server).

## Configuration

Settings are environment variables, read from `.env` in the repo root if present (variables already set in the environment win). `.env` is gitignored; `.env.example` lists everything. Invalid values stop the server at startup with a clear message.

| Variable                | Default                                   | Purpose                                                                   |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `PORT`                  | `4380`                                    | Server port. The server always binds to `127.0.0.1` (loopback only).      |
| `BOOKSHELF_DATA_DIR`    | `~/Library/Application Support/Bookshelf` | Database, cover cache and backups. `~` is expanded.                       |
| `BOOKSHELF_TZ`          | system timezone                           | IANA timezone (e.g. `Europe/London`) used to group sessions into days.    |
| `LOG_LEVEL`             | `info`                                    | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout.        |
| `GOOGLE_BOOKS_API_KEY`  | unset                                     | Optional; raises the Google Books quota for lookups.                      |
| `NOTION_TOKEN`          | unset                                     | Notion internal integration secret. Set together with the next variable.  |
| `NOTION_PARENT_PAGE_ID` | unset                                     | Notion page (ID or page URL) under which Bookshelf creates its databases. |

Secrets are never written to the logs.

## Data location

Everything lives in `BOOKSHELF_DATA_DIR`:

```
Bookshelf/
├── bookshelf.db      SQLite database (WAL mode, so also bookshelf.db-wal / -shm)
├── covers/           cached cover images, one per book (<book id>.jpg/png/webp)
└── backups/          automatic and pre-import JSON snapshots
```

## Backups and restore

- **Automatic snapshots**: the server writes `backups/bookshelf-YYYY-MM-DD.json` when it starts and every day at 03:00 (in `BOOKSHELF_TZ`), keeping the newest 14.
- **Manual export**: `GET /api/backup/export` returns the full backup (all books, formats, reads, sessions, tags, notes, goals and the active timer, including deleted items):

  ```sh
  curl -o bookshelf-backup.json http://127.0.0.1:4380/api/backup/export
  ```

- **Restore**: `POST /api/backup/import` validates the file, writes a safety snapshot (`backups/bookshelf-pre-import-<timestamp>.json`) and then replaces all data in a single transaction — if anything is wrong, nothing changes:

  ```sh
  curl -X POST -H 'Content-Type: application/json' \
    --data-binary @bookshelf-backup.json \
    http://127.0.0.1:4380/api/backup/import
  ```

  Any snapshot in `backups/` can be restored the same way. Cover images are not part of the JSON; they are downloaded again when first displayed.

- For a belt-and-braces copy, include `BOOKSHELF_DATA_DIR` in Time Machine.

## Notion setup (optional)

Bookshelf can mirror your library, sessions and notes into Notion. The mirror is one-way: edits made in Notion are overwritten and never come back, and restores always use the JSON backups.

1. Go to <https://www.notion.so/profile/integrations>, choose **New integration**, pick your workspace, set the type to **Internal**, and save. Copy the **Internal Integration Secret**.
2. In Notion, create (or choose) a page to hold the Bookshelf databases. Open its **•••** menu → **Connections** → add your integration, so it can create content there.
3. Copy the page's link (**•••** → **Copy link**).
4. In `.env` set:

   ```sh
   NOTION_TOKEN=<the internal integration secret>
   NOTION_PARENT_PAGE_ID=<the page link or its 32-character ID>
   ```

5. Restart the server and run a sync:

   ```sh
   curl -X POST http://127.0.0.1:4380/api/backup/notion
   curl http://127.0.0.1:4380/api/backup/notion/status
   ```

The first run creates three databases under the page — _Bookshelf Books_, _Bookshelf Sessions_ and _Bookshelf Notes_ — and later runs update them, skipping unchanged rows and archiving deleted ones. Requests are rate-limited to about three per second, so a large first sync takes a little while. If a database is deleted in Notion, the next run recreates it. Without the two variables the status endpoint reports `"configured": false`.

## Architecture

```
iPhone / Mac browser ──HTTPS──> tailscale serve ──HTTP──> 127.0.0.1:4380 Node server (Hono)
                                                           ├─ /api/* JSON API (Zod-validated)
                                                           ├─ web/dist (built web app, SPA fallback)
                                                           ├─ SQLite via node:sqlite (source of truth)
                                                           ├─ cover cache and JSON snapshots
                                                           └─ outbound: Open Library, Google Books, Notion
```

- `server/` — Hono app (`app.ts`), entry point (`index.ts`), configuration, logging, SQLite access and migrations (`db/`, `migrations/`), repositories, services (library, sessions, timer, lookup, stats, sync, backup, snapshots, Notion) and routes.
- `shared/` — the API contract (Zod schemas and types for every entity, request and response) and pure helpers: ISBN normalisation, timezone day bucketing, percent/progress/speed/estimated-finish/streak derivations, and `DD/MM/YYYY`/duration formatting.
- `web/` — Vite + React PWA: a typed API client (every response parsed with the shared schemas), a hand-written hash router, the SPEC §6 screens, Recharts charts, the zxing-wasm barcode scanner, and the offline layer (Dexie outbox plus a cached read model). One plain stylesheet (`web/src/styles.css`) with light and dark palettes.
- `scripts/` — the dependency-free icon generator (`npm run icons`).

The full contract is [docs/SPEC.md](docs/SPEC.md). Key decisions:

- [ADR 0001](docs/adr/0001-self-hosted-mac-server-sqlite.md) — self-hosted Mac server with SQLite as the source of truth
- [ADR 0002](docs/adr/0002-tailscale-loopback-bind.md) — Tailscale for HTTPS and remote access; loopback-only bind
- [ADR 0003](docs/adr/0003-node-sqlite-type-stripping.md) — `node:sqlite` and Node type stripping
- [ADR 0004](docs/adr/0004-offline-outbox-lww-sync.md) — offline outbox with last-write-wins sync
- [ADR 0005](docs/adr/0005-open-library-primary-google-fallback.md) — Open Library first, Google Books fallback
- [ADR 0006](docs/adr/0006-notion-one-way-mirror.md) — Notion as a one-way mirror
- [ADR 0007](docs/adr/0007-offline-read-model-and-client-bookkeeping.md) — offline read model in IndexedDB and client-side read bookkeeping

## Roadmap

- **Always-on service and remote access (phase 3)**: a launchd agent to start the server at login, and `tailscale serve` set-up for HTTPS access from the iPhone.
- **Imports**: Bookpine export and Notion database import, awaiting sample files (`~/Development/bookshelf-samples/`) so the formats can be mapped.
