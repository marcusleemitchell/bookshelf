# 0001. Self-hosted Mac server with SQLite as the source of truth

- Status: accepted
- Date: 14/11/2026

## Context

Bookshelf is a single-user reading tracker. The main client is an iPhone (PWA), with a Mac browser as a secondary client. Data must survive device changes, be easy to back up and stay private. There is no budget or wish to run cloud infrastructure, and the user's Mac is on most of the day.

## Decision

Run a small Node server on the user's Mac and keep all data in one SQLite database in `BOOKSHELF_DATA_DIR` (default `~/Library/Application Support/Bookshelf`). The server is the only writer; clients talk to it over the JSON API. The database uses WAL mode, foreign keys and forward-only migrations that never drop user data.

## Consequences

- One file holds everything, so backup and restore are simple (JSON export plus automatic daily snapshots; see SPEC §7).
- No hosting costs and no third party holds the data.
- The app is unavailable while the Mac is off or asleep. Clients cover short gaps with the offline outbox (ADR 0004).
- One writer means no distributed-consistency problems on the server side.
