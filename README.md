# Bookshelf

A personal, self-hosted reading tracker. Log reading sessions (time and progress) across physical books, Kindle ebooks and audiobooks; build a library by ISBN or title search; see statistics, a reading calendar, streaks and goals; and keep everything backed up locally (with an optional one-way mirror to Notion).

It runs as a small Node server on your Mac with a SQLite database as the single source of truth. The main client is an iPhone browser (installed to the Home Screen); a Mac browser works too. Family members sign in with a PIN; for now there is one profile, yours ([ADR 0010](docs/adr/0010-family-profiles.md) plans the rest).

> Status: complete for daily use — server and API, backups, Notion mirror, the installable web app (offline support, barcode scanning), a launchd service and HTTPS access through Tailscale. It also imports your Bookpine history (see [Importing from Bookpine](#importing-from-bookpine)). Importing from Notion is not planned: it would hold the same data, and Notion stays a one-way mirror.

In short: [set up](#setup) → [run it as a service](#running-as-a-service-start-at-login) → [publish it with Tailscale](#remote-access-with-tailscale-https-for-the-iphone) → [install it on the iPhone](#installing-on-the-iphone-home-screen) → [use it](#using-the-app).

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

## Running as a service (start at login)

Bookshelf can run as a launchd agent so it starts when you log in and restarts itself if it crashes:

```sh
npm run service:install     # builds the web app if missing or out of date, installs and starts the agent
npm run service:status      # installed? running? answering on 127.0.0.1:<PORT>?
npm run service:logs        # last 50 log lines; `npm run service:logs -- -f` to follow
npm run service:uninstall   # stop and remove the agent (your data and logs are kept)
```

`service:install` writes `~/Library/LaunchAgents/com.bookshelf.server.plist` (rendered from `ops/com.bookshelf.server.plist`) and loads it with `launchctl bootstrap`. The agent:

- runs this checkout's `server/index.ts` with the Node you installed it with (an absolute path, so it does not depend on your shell or nvm), from the repo directory;
- starts at login, restarts after a crash or error exit (at most once every 30 seconds), and stays stopped after a clean shutdown;
- logs to `BOOKSHELF_DATA_DIR/logs/bookshelf.log` (JSON lines) and `bookshelf.err.log` (startup failures);
- reads `.env` like `npm start` does, with `BOOKSHELF_TZ` fixed to the Mac's timezone at install time unless `.env` sets it — so your reading days don't shift if the Mac's clock changes zone while travelling.

Install refuses, with an explanation, if the port is already taken — for example by a Bookshelf you started with `npm start` (stop it first) or by another program (change `PORT` in `.env`). Running it again replaces the installed agent; do that after `git pull`, changing `.env`, moving the repo, or switching Node installations. It rebuilds the web app first when anything it is built from (`web/`, `shared/`, `package.json`, `package-lock.json`) is newer than `web/dist`, so the server never serves an app older than itself. When replacing the agent it waits for launchd to finish removing the old one before starting the new one (launchd otherwise answers `Bootstrap failed: 5: Input/output error`). `launchctl kickstart -k gui/$(id -u)/com.bookshelf.server` also restarts the server, but does not rebuild the web app.

To preview the agent without installing it: `node scripts/service.ts plist`.

## Remote access with Tailscale (HTTPS for the iPhone)

The server only listens on `127.0.0.1`, so nothing on your network can reach it directly. [Tailscale](https://tailscale.com) gives your own devices a private network (a _tailnet_) and `tailscale serve` publishes the server on it over HTTPS, with a certificate Tailscale manages. HTTPS is what lets the iPhone install the app and use the camera.

> The tailnet is the outer wall: only devices in it can reach Bookshelf, and inside it Bookshelf asks for a PIN. Invite only your household to the tailnet — not a work or shared one — and never use `tailscale funnel`, which would publish it to the internet.

One-off set-up:

1. **Install Tailscale on the Mac**: `brew install --cask tailscale-app`, or from the Mac App Store, or <https://tailscale.com/download/mac>. Open it and sign in.
2. **Install Tailscale on the iPhone** from the App Store and sign in with the **same account**, so both are in the same tailnet. Leave the VPN switched on.
3. **Enable MagicDNS and HTTPS certificates** in the Tailscale admin console at <https://login.tailscale.com/admin/dns>: turn on **MagicDNS** (on by default for new tailnets), then under **HTTPS Certificates** choose **Enable HTTPS**.
4. **Start Bookshelf** as a service (`npm run service:install`, above) so it is always running.
5. **Publish it on the tailnet**:

   ```sh
   npm run tailscale:serve
   ```

   This checks that Tailscale is signed in with HTTPS enabled (and tells you what to fix if not), runs `tailscale serve --bg <PORT>`, and prints the address, e.g. `https://my-mac.tail1234.ts.net/`. The setting survives restarts of the Mac and of Tailscale; you only run it once.

6. **Install the app on the iPhone** (next section).

Other commands:

```sh
npm run tailscale:status   # signed in? HTTPS enabled? the Bookshelf address, and whether the server answers
npm run tailscale:off      # stop publishing Bookshelf on the tailnet (the server keeps running locally)
```

The scripts use `tailscale` from your PATH, or the CLI inside `/Applications/Tailscale.app`. If Tailscale isn't installed they say how to install it.

### Keep the Mac reachable

- The Mac must be **awake** for the iPhone to reach it (the app still opens offline and queues changes, see [Offline](#offline)). On a laptop: **System Settings → Battery → Options → Prevent automatic sleeping on power adapter when the display is off**; on a desktop Mac: **System Settings → Energy → Prevent automatic sleeping when the display is off**. The display can still turn off, and the Mac can stay locked.
- Keep the **Mac and iPhone in the same timezone** (both set automatically is simplest). Days in the calendar, streaks and goals are counted in `BOOKSHELF_TZ` on the server — fixed to the Mac's timezone when the service was installed — while the iPhone shows times in its own zone.

## Installing on the iPhone Home Screen

The app is a PWA. Installing it needs HTTPS, which comes from `tailscale serve` (see [Remote access with Tailscale](#remote-access-with-tailscale-https-for-the-iphone)):

1. On the iPhone, with Tailscale connected, open the address `npm run tailscale:serve` printed (`https://<mac-name>.<tailnet>.ts.net/`) in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch **Bookshelf** from the Home Screen: it opens full screen, without Safari's toolbars.

The Home Screen app talks to the same server as the Mac, so everything you log on one shows on the other.

On the Mac itself, just open <http://127.0.0.1:4380> (or your `PORT`) in any browser.

## Using the app

Open Bookshelf from the Home Screen (or <http://127.0.0.1:4380> on the Mac). The first time, it asks for your name and a PIN (4–8 digits); after that each device signs in once with the PIN and stays signed in (for 180 days after you last used it). Five wrong PINs in a row lock sign-in for 15 minutes. **Settings → Profile** changes the PIN (which signs out your other devices) or signs this device out, which also removes the data it keeps for offline use.

The tab bar has five screens:

- **Today** — the reading timer (start, pause, resume, then **Stop & log** to turn it into a session), the books you're reading with progress and an estimated finish date, today's minutes against your daily goal, and your streak. The timer keeps running while the app is closed.
- **Library** — shelves (Reading, Paused, To read, Finished, Did not finish), tag filter and search. Pausing a book keeps its current read open (it leaves Today's list); logging a session or choosing Reading again resumes it. **Add book** (also on Today) finds books by scanning the barcode, typing the ISBN, or searching by title/author, then lets you pick your formats (physical, Kindle, audiobook) and their lengths. Anything the services don't know can be entered manually.
- **Book detail** (tap a book) — shelf, rating, progress chart, sessions, notes and quotes, tags, formats and lengths, rereads, and the book's metadata.
- **Log session** — from a book or the timer: format, when you read, and progress as pages (or audiobook position, `h:mm:ss`) and percent side by side. Type either and the other fills in from the book's length; the session is saved in whichever you typed, and the form shows the pages and percent gained.
- **Calendar** — each day shows the covers of what you read; tap a day for its sessions.
- **Stats** — week / month / year / all time: reading time, pages and progress charts, breakdowns by format, genre, tag and author, reading speed, goals and a year in review.
- **Settings** — profile (PIN, sign out), goals, tags, backup export/import, Bookpine import, Notion sync, server status and offline changes.

A typical day: tap **Start timer** on Today when you sit down to read (or put the audiobook on), **Stop & log** when you finish and enter where you got to — the page, the percentage Kindle shows, or the audiobook position. Forgot the timer? **Log** on a book records a session after the fact. Adding a book takes a barcode scan or a search; Open Library supplies the cover, synopsis and page count, which you can correct before saving.

Dates are shown as `DD/MM/YYYY`; durations as `1h 05m`; audiobook positions as `h:mm:ss`. Days (calendar, streaks, daily goal) are counted in `BOOKSHELF_TZ` on the server, so keep the iPhone in the same timezone as the Mac.

### Offline

If the Mac is asleep or unreachable, the app still opens (the service worker caches the app itself) and shows what it last loaded: Today, your library, books you've opened, notes, calendar months and stats you've viewed. A banner says you're offline and how many changes are waiting.

While offline you can log sessions, use the timer, change a book's shelf or rating, and add, edit or delete notes and quotes. These are saved on the device and sent to the server automatically when it is reachable again (on reconnect, when you return to the app, and every 30 seconds). Adding books, lookups, tags, formats, goals, backups and Notion need the server and say so.

If a change keeps being rejected (for example because it conflicts with something changed elsewhere), it is marked as failed: **Settings → Offline changes** shows the reason and lets you retry or discard it.

### Barcode scanning

**Add book → Scan** uses the rear camera to read the EAN-13 barcode on the back of a book (ISBNs starting 978 or 979). It needs:

- a **secure context**: HTTPS (the Tailscale address) or `http://127.0.0.1` / `localhost` on the Mac — plain `http://` to another host cannot use the camera;
- camera permission for the site (iPhone: **Settings → Apps → Safari → Camera**).

When the camera can't be used the app explains why; type the ISBN instead. The barcode decoder (zxing-wasm) is served by the app itself, so scanning works offline and sends nothing to third parties (looking the ISBN up still needs the server).

### Updating Bookshelf

```sh
git pull
npm install
npm run service:install   # rebuilds the web app if the code changed, then restarts the service
```

The installed app picks up the new version by itself: the next launch (or the one after) loads it. Database migrations run automatically when the server starts. For a belt-and-braces update, export a backup first (see below).

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

## Importing from Bookpine

Bookshelf can import a Bookpine CSV export (Bookpine → Settings → Export). In the app: **Settings → Import from Bookpine**, pick the CSV, check the preview (what would be added, updated and merged, plus any warnings), then **Import**. The same is available over HTTP. The full rules are in [SPEC §8.1](docs/SPEC.md#81-bookpine-csv-import-adr-0009); in short:

- **Preview first**: `POST /api/import/bookpine/preview` shows what would happen — books new, updated and merged (duplicate editions such as a paperback and a "(Movie Tie-In)" edition become one book with several formats), reads, sessions, tags and warnings — without changing anything:

  ```sh
  curl -X POST -H 'Content-Type: text/csv' --data-binary @bookpine-export.csv \
    http://127.0.0.1:4380/api/import/bookpine/preview
  ```

- **From the terminal**: `npm run import:bookpine -- ~/Downloads/bookpine-export.csv --dry-run` previews, the same without `--dry-run` imports (into the `BOOKSHELF_DATA_DIR` from `.env`; `--json` prints the full report). It works while the server is running.
- **Import**: `POST /api/import/bookpine` (same body) looks each book up for a cover, synopsis, genres and page count (about a second per book), saves a safety snapshot (`backups/bookshelf-pre-import-<timestamp>.json`) and imports everything in one go — if anything fails, nothing changes. Restore the snapshot (see [Backups and restore](#backups-and-restore)) to undo an import.
- **Reading days have no time**: Bookpine records the days you read, not for how long, so imported sessions show as "Time unknown · imported". They appear in the calendar and count for your streak, but not for reading time, minutes, the daily goal, reading speed or finish estimates. Add a duration from the book's page (**Add time**) and the session counts fully.
- **Re-importing is safe**: importing a newer export updates what changed in Bookpine and adds new readings, without duplicating anything. Changes you made in Bookshelf (a corrected title, a deleted session, an added duration, a removed tag) are kept. Books already in your library are linked rather than added twice.
- Shelves become statuses (Read, Currently Reading, Want To Read, Paused); other shelves and lists become tags, as do `owned` and `private`. Reviews and your own notes become notes; the Goodreads data Bookpine keeps in notes is only used to fill in page counts and finish dates.

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

## Troubleshooting

Start with the two status commands — they say what is wrong and what to do:

```sh
npm run service:status     # is the server installed, running and answering?
npm run tailscale:status   # is Tailscale signed in, is HTTPS on, is Bookshelf published?
```

- **The service will not start or keeps restarting.** Look at `npm run service:logs` (startup errors such as an invalid `.env` value are in `bookshelf.err.log`). launchd retries at most every 30 seconds. Fix the cause, then run `npm run service:install` again.
- **`service:status` warns that the agent's Node no longer exists** (after removing a Node version or reinstalling Node elsewhere): run `npm run service:install` again from a shell where `node --version` is 25 or later.
- **"Port 4380 is already in use".** Stop the program named in the message — often a Bookshelf you started with `npm start` — or set another `PORT` in `.env` and run `npm run tailscale:serve` again afterwards so Tailscale forwards to the new port.
- **The iPhone cannot reach Bookshelf.** Check that Tailscale is connected on the iPhone (VPN on) and the Mac, that the Mac is awake, and that `npm run tailscale:status` shows the address. The app still opens offline and queues your changes.
- **`tailscale:serve` says HTTPS certificates are not enabled.** Enable them in the admin console (<https://login.tailscale.com/admin/dns> → HTTPS Certificates) and run it again. To clear every Tailscale serve setting on the Mac (not only Bookshelf's): `tailscale serve reset`.
- **The app still shows an old version.** Close it fully (swipe it away) and reopen it; a new version is picked up on the next launch or the one after.
- **Days look off by one** (a late-night session on the wrong day, a broken streak): the Mac's `BOOKSHELF_TZ` and the iPhone's timezone differ. Set `BOOKSHELF_TZ` in `.env` and run `npm run service:install`.
- **Looked-up books have no synopsis.** Open Library has no description for that edition; type one in, or set `GOOGLE_BOOKS_API_KEY` so Google Books can fill it (keyless Google Books requests are refused).
- **The camera does not start.** Use the HTTPS address (not plain `http://` to the Mac's name) and allow camera access for Safari (**Settings → Apps → Safari → Camera**).
- **Forgot the PIN.** There is no reset in the app yet. Stop the server, back up `bookshelf.db`, then clear the PIN so the app asks for setup again: `sqlite3 "<data dir>/bookshelf.db" "UPDATE members SET pin_hash = NULL, failed_pin_attempts = 0, locked_until = NULL; DELETE FROM auth_sessions;"`, and start the server.
- **A change is marked as failed** in the offline banner: **Settings → Offline changes** shows why, with Retry and Discard.
- **The log files are getting large.** They are plain append-only files; empty them at any time with `: > "<data dir>/logs/bookshelf.log"` (the path is shown by `service:status`).

## Configuration

Settings are environment variables, read from `.env` in the repo root if present (variables already set in the environment win). `.env` is gitignored; `.env.example` lists everything. Invalid values stop the server at startup with a clear message.

| Variable                | Default                                   | Purpose                                                                                                      |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`                  | `4380`                                    | Server port. The server always binds to `127.0.0.1` (loopback only).                                         |
| `BOOKSHELF_DATA_DIR`    | `~/Library/Application Support/Bookshelf` | Database, cover cache and backups. `~` is expanded.                                                          |
| `BOOKSHELF_TZ`          | system timezone                           | IANA timezone (e.g. `Europe/London`) used to group sessions into days.                                       |
| `LOG_LEVEL`             | `info`                                    | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout.                                           |
| `GOOGLE_BOOKS_API_KEY`  | unset                                     | Optional. Google Books refuses keyless requests, so without a key lookups use Open Library only (see below). |
| `NOTION_TOKEN`          | unset                                     | Notion internal integration secret. Set together with the next variable.                                     |
| `NOTION_PARENT_PAGE_ID` | unset                                     | Notion page (ID or page URL) under which Bookshelf creates its databases.                                    |

Secrets are never written to the logs.

## Data location

Everything lives in `BOOKSHELF_DATA_DIR`:

```
Bookshelf/
├── bookshelf.db      SQLite database (WAL mode, so also bookshelf.db-wal / -shm)
├── covers/           cached cover images, one per book (<book id>.jpg/png/webp)
├── backups/          automatic and pre-import JSON snapshots
└── logs/             server logs when running as a service (bookshelf.log, bookshelf.err.log)
```

## Commands

| Command                     | What it does                                                                |
| --------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`               | Server (restarts on changes) plus the Vite dev server with an `/api` proxy  |
| `npm run dev:server`        | Server only, watching `server/` and `shared/`                               |
| `npm run build`             | Type-check everything and build the web app into `web/dist`                 |
| `npm start`                 | Production server on `127.0.0.1:$PORT`, serving `web/dist` when it is built |
| `npm run lint`              | ESLint                                                                      |
| `npm run format`            | Format with Prettier                                                        |
| `npm run format:check`      | Check formatting                                                            |
| `npm run typecheck`         | TypeScript checks for server, shared and web                                |
| `npm test`                  | Run the test suite once                                                     |
| `npm run test:coverage`     | Tests with coverage (fails below 90% lines in server, shared, scripts, web) |
| `npm run check`             | Lint, format check, type-check and tests with coverage — the quality gate   |
| `npm run icons`             | Regenerate the app icons in `web/public/` (commit the result)               |
| `npm run service:install`   | Install and start the launchd agent (see above)                             |
| `npm run service:uninstall` | Stop and remove the launchd agent                                           |
| `npm run service:status`    | Show whether the agent is installed, running and answering                  |
| `npm run service:logs`      | Show the server logs (`-- -f` to follow, `-- -n 200` for more lines)        |
| `npm run tailscale:serve`   | Publish Bookshelf on your tailnet over HTTPS and print the address          |
| `npm run tailscale:status`  | Show Tailscale's state and the Bookshelf address                            |
| `npm run tailscale:off`     | Stop publishing Bookshelf on your tailnet                                   |
| `npm run import:bookpine`   | Import a Bookpine CSV export (`-- export.csv`, add `--dry-run` to preview)  |

During development, point the server at a throwaway data directory so you never touch your real library, for example `BOOKSHELF_DATA_DIR=/tmp/bookshelf-dev npm run dev`.

## Architecture

```
iPhone / Mac browser ──HTTPS──> tailscale serve ──HTTP──> 127.0.0.1:4380 Node server (Hono)
                                                           ├─ /api/* JSON API (Zod-validated)
                                                           ├─ web/dist (built web app, SPA fallback)
                                                           ├─ SQLite via node:sqlite (source of truth)
                                                           ├─ cover cache and JSON snapshots
                                                           └─ outbound: Open Library, Google Books, Notion
```

- `server/` — Hono app (`app.ts`), entry point (`index.ts`), configuration, logging, SQLite access and migrations (`db/`, `migrations/`), repositories, services (library, sessions, timer, lookup, stats, sync, backup, snapshots, Notion, Bookpine import) and routes; `server/import/` parses and plans Bookpine exports.
- `shared/` — the API contract (Zod schemas and types for every entity, request and response) and pure helpers: ISBN normalisation, timezone day bucketing, percent/progress/speed/estimated-finish/streak derivations, and `DD/MM/YYYY`/duration formatting.
- `web/` — Vite + React PWA: a typed API client (every response parsed with the shared schemas), a hand-written hash router, the SPEC §6 screens, Recharts charts, the zxing-wasm barcode scanner, and the offline layer (Dexie outbox plus a cached read model). One plain stylesheet (`web/src/styles.css`) with light and dark palettes.
- `scripts/` and `ops/` — tooling run directly by Node with no extra packages: the icon generator (`npm run icons`), the launchd service (`scripts/service.ts`, template `ops/com.bookshelf.server.plist`) and Tailscale serve (`scripts/tailscale.ts`), sharing `scripts/runtime.ts`.

The full contract is [docs/SPEC.md](docs/SPEC.md). Key decisions:

- [ADR 0001](docs/adr/0001-self-hosted-mac-server-sqlite.md) — self-hosted Mac server with SQLite as the source of truth
- [ADR 0002](docs/adr/0002-tailscale-loopback-bind.md) — Tailscale for HTTPS and remote access; loopback-only bind
- [ADR 0003](docs/adr/0003-node-sqlite-type-stripping.md) — `node:sqlite` and Node type stripping
- [ADR 0004](docs/adr/0004-offline-outbox-lww-sync.md) — offline outbox with last-write-wins sync
- [ADR 0005](docs/adr/0005-open-library-primary-google-fallback.md) — Open Library first, Google Books fallback
- [ADR 0006](docs/adr/0006-notion-one-way-mirror.md) — Notion as a one-way mirror
- [ADR 0007](docs/adr/0007-offline-read-model-and-client-bookkeeping.md) — offline read model in IndexedDB and client-side read bookkeeping
- [ADR 0008](docs/adr/0008-open-library-records-for-synopsis.md) — Open Library edition and work records supply synopsis and language
- [ADR 0009](docs/adr/0009-bookpine-import.md) — Bookpine import: untimed sessions, merged editions and provenance
- [ADR 0010](docs/adr/0010-family-profiles.md) — family profiles with a shared catalogue, personal shelves and light PIN sign-in (step 1 of 4 built)

## Roadmap

- **Development-only `npm audit` advisories** (tracked): 12 advisories (2 low, 10 moderate), all in development tooling, none in the production dependency tree (`npm audit --omit=dev` reports 0). They come from three upstream issues — `minimatch` ReDoS ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)) via `typescript-eslint`, `glob` ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)) and `deepmerge` ([GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)) via `vite-plugin-pwa`'s `workbox-build`. The suggested `npm audit fix --force` would downgrade those packages (breaking changes), so the fix is to upgrade them when patched releases are out; re-check with `npm audit` when upgrading dependencies.
- **Log rotation** for the service logs (currently cleared by hand, see Troubleshooting).
- **Search language**: title search prefers English editions (ADR 0008); make it configurable if needed.
