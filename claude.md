# Bookshelf — project rules for Claude

Project-level rules, derived from the global `~/.claude/CLAUDE.md` (the referenced template `~/.claude/claude-project-template.md` does not exist). Everything in the global file applies here unchanged; this file only adds project specifics and stricter rules. There are **no overrides that relax the global rules**.

`docs/SPEC.md` is the binding product and technical contract. Every change to behaviour, data model or API updates SPEC.md in the same commit. Architectural decisions live in `docs/adr/` (MADR-lite: context, decision, consequences).

## Stack

- Node ≥ 25 (`.nvmrc`: 25.9.0), ESM (`"type": "module"`), one root `package.json` (no workspaces).
- `server/`: Hono + `@hono/node-server`, TypeScript run directly by Node type stripping (no build step, no tsx), SQLite via built-in `node:sqlite` (ADR 0003).
- `shared/`: Zod schemas, inferred types and pure derivation/formatting functions — the API contract, imported by server and web.
- `web/`: Vite + React + TypeScript PWA (SPEC §6): typed API client (`web/src/api/client.ts`), hash router, screens, Dexie outbox + read-model cache (`web/src/offline/`, ADR 0007), one plain stylesheet. No router or CSS framework.
- `scripts/`: tooling run directly by Node with no extra packages (icon generator; launchd service `scripts/service.ts` with template `ops/com.bookshelf.server.plist`; Tailscale serve `scripts/tailscale.ts`; shared helpers in `scripts/runtime.ts`). Script logic takes injected dependencies (`run`, `fetch`, port probe, output) and is unit-tested; the entry guard is `if (import.meta.main)`.
- Tests: Vitest (projects `node` and `web`/jsdom), Testing Library, fake-indexeddb.

## Commands

| Command                     | What it does                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`               | Server with `node --watch` + Vite dev server proxying `/api`                 |
| `npm run dev:server`        | Server only, restarting on changes in `server/` and `shared/`                |
| `npm run build`             | Type-check everything, then build the web app into `web/dist`                |
| `npm start`                 | Production server on `127.0.0.1:$PORT`, serving `web/dist` if built          |
| `npm run lint`              | ESLint (strict type-checked)                                                 |
| `npm run format`            | Prettier write                                                               |
| `npm run format:check`      | Prettier check                                                               |
| `npm run typecheck`         | `tsc --noEmit` for server/shared and for web                                 |
| `npm test`                  | Vitest once                                                                  |
| `npm run test:coverage`     | Vitest with coverage; fails below 90% lines in any source folder             |
| `npm run icons`             | Regenerate the PWA icons in `web/public/` (commit the output)                |
| `npm run service:install`   | Build if needed, install + start the launchd agent (real Mac: user approval) |
| `npm run service:uninstall` | `launchctl bootout` the agent and remove its plist                           |
| `npm run service:status`    | Agent file, launchd state, `/api/health` (read-only)                         |
| `npm run service:logs`      | Tail `BOOKSHELF_DATA_DIR/logs/` (`-- -f` to follow, `-- -n 200`)             |
| `npm run tailscale:serve`   | `tailscale serve --bg $PORT`, prints the HTTPS URL (real Mac: user approval) |
| `npm run tailscale:status`  | Tailscale state, HTTPS/MagicDNS, Bookshelf URL (read-only)                   |
| `npm run tailscale:off`     | Remove the HTTPS listener serving Bookshelf (real Mac: user approval)        |
| `npm run check`             | lint + format:check + typecheck + test:coverage — the quality gate           |

`npm run check` and `npm run build` must pass before any commit. Never disable, skip or weaken a lint rule, test or coverage threshold to get there.

## Code rules

- **Erasable TypeScript only** in `server/` and `shared/`: no `enum`, `namespace` or constructor parameter properties; `import type` for type-only imports; `.ts` extensions in relative imports. `tsconfig.json` enforces this (`erasableSyntaxOnly`, `verbatimModuleSyntax`).
- Validate every request body, query, path parameter **and response** with the shared Zod schemas (`server/http/validate.ts`). Add new API shapes to `shared/schemas.ts` first.
- Errors use `AppError` (`server/http/errors.ts`) and the `{ error: { code, message } }` envelope; add new codes to `errorCodeSchema`.
- Services take an `AppContext` (`db`, `config`, `logger`, `fetch`, `now`, `sleep`). Never call global `fetch`, `Date.now()` or timers directly in services; inject them so tests stay deterministic.
- Database writes that must be atomic go through `transaction()`. `transaction()` callbacks must be synchronous.
- Schema changes: add a new `server/migrations/NNNN_name.sql` (next number, no gaps). Migrations are forward-only and must never drop or rewrite user data; no `BEGIN`/`COMMIT` inside the file. Table rebuilds (to change a `CHECK`/`NOT NULL`) start with `-- migrate:foreign-keys-off` so the runner disables foreign keys and verifies `PRAGMA foreign_key_check` before committing. Schema changes need the user's approval first (global rule).
- IDs are UUIDs, timestamps ISO 8601 UTC with milliseconds; days are bucketed in `BOOKSHELF_TZ` by session start.
- Logging: use the injected logger; never log tokens, API keys or full outbound URLs with query strings.

## Domain and language rules

- British English everywhere (UI copy, docs, comments, error messages).
- Dates shown to the user as `DD/MM/YYYY`; durations `1h 05m`; audio positions `h:mm:ss`. Use the helpers in `shared/format.ts`.
- Single user, no accounts. The server binds `127.0.0.1` only (ADR 0002); never make the bind address configurable or add `0.0.0.0`.
- Notion is a one-way mirror (ADR 0006); restore is only from JSON backups.

## Data safety

- **Never install, bootstrap or boot out the real launchd agent, or change Tailscale serve settings,** during development without the user's explicit approval. Verify the agent with `node scripts/service.ts plist --out <scratch file>` and `plutil -lint`.
- **Never touch the user's real data directory** (`~/Library/Application Support/Bookshelf`) from tests, scripts or manual runs during development. Tests use `createTestEnv()` (`server/test/helpers.ts`), which creates an OS temp directory per test. Manual runs set `BOOKSHELF_DATA_DIR` to a temporary directory.
- No external network in tests: outbound HTTP goes through the injected `fetch`, mocked with realistic fixtures (`server/test/fixtures/`). The fetch mock throws on any unexpected request.
- Never commit `.env`, databases, covers, backups or real reading data. Test data is fictional or public bibliographic metadata.
- Destructive operations on real data (imports, migrations against the live DB) need explicit approval and a backup first.

## Dependencies

Approved runtime: hono, @hono/node-server, zod, react, react-dom, recharts, dexie, zxing-wasm. Approved dev: typescript, vite, @vitejs/plugin-react, vite-plugin-pwa, vitest, @vitest/coverage-v8, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom, jsdom, fake-indexeddb, eslint, typescript-eslint, eslint-plugin-react-hooks, prettier, @types/node, @types/react, @types/react-dom. Versions are exact-pinned. Ask before adding or upgrading anything.

## Testing

- Server routes: integration tests through `app.request()` against a temp SQLite DB, covering success and error paths.
- Shared: exhaustive unit tests for derivations and formatting.
- Web: Testing Library + jsdom against a mock API (`web/src/test/server.ts`) with schema-validated fixtures (`web/src/test/fixtures.ts`), a fixed clock and fake-indexeddb; `renderApp()` renders the whole app at a hash route. Every API response the web app reads goes through `web/src/api/client.ts`; never call `fetch` elsewhere.
- Write the failing test first for regressions. Keep tests deterministic (fixed clock via `env.clock`).

## Git

Conventional Commits, small and atomic, "why" first; keep mechanical changes (formatting) separate from behavioural ones. Never push without being asked.
