# 0010. Family profiles: shared catalogue, personal shelves, light PIN sign-in

- Status: proposed
- Date: 23/11/2026
- Amends: ADR 0002 (the tailnet is no longer the only boundary), ADR 0004 (last-write-wins now only applies to rows one member owns)

## Context

Bookshelf is single-user with no accounts (SPEC §1); ADR 0002 makes the tailnet the security boundary and says this must be revisited if the tailnet is ever shared. The user now wants the family to use it: parents and children on their own devices, sharing the Mac server.

- Family devices will join the user's tailnet. HTTPS (needed for the PWA's service worker) only exists through `tailscale serve`, so exposing the server on the LAN is not an option, and the loopback-only bind stays.
- Devices are not people: a child's iPad may be signed in to Tailscale as a parent, and one iPad may be shared. Tailscale identity headers therefore cannot say who is reading.
- A family usually owns one copy of a book, but each person has their own status, rating, reads, sessions and notes.

## Decision

**Members and roles.** A `members` table (id, name, role `parent`|`child`, PIN hash, colour, timestamps, `deleted_at`). The migration creates an owner parent and assigns every existing row to it, so the current library becomes the owner's shelf unchanged. Parents manage members (add, rename, reset a PIN, remove).

**Light sign-in.** The app opens on a profile picker; choosing a profile asks for its PIN. Parents must have a PIN; for a child it is the parent's choice. PINs are hashed with scrypt from `node:crypto` (no new dependency); five wrong attempts lock that profile for 15 minutes, timed with the injected clock. A successful sign-in sets a random 32-byte token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/api`, valid for 180 days and renewed on use; only its SHA-256 hash is stored (`auth_sessions`), one per device. Middleware requires a session for every `/api/*` route except `/api/health` and the sign-in endpoints; the static web app stays public. New error codes `unauthorised` (401) and `forbidden` (403). On first start after the migration the owner is asked to set a PIN.

**Shared catalogue, personal shelves.**

- Shared by the family: `books` (bibliographic data and genres), `book_formats`, the cover cache.
- Per member (`member_id`): a new `shelf_entries` table (member, book, status, rating) that takes over `status` and `rating` from `books`, plus `reads`, `sessions`, `book_notes`, `tags`/`book_tags`, `goals`, `active_timer` and `import_links`. The timer singleton becomes one per member; tag names and goal periods become unique per member.
- A book is on a member's shelf when they have a live shelf entry; the library screen shows the member's shelf, and adding a book that is already in the catalogue only adds the shelf entry.

**Permissions.**

| Action                                                     | Parent                      | Child                       |
| ---------------------------------------------------------- | --------------------------- | --------------------------- |
| Own shelf, reads, sessions, timer, notes, tags, goals      | yes                         | yes                         |
| Add a book or a new format to the catalogue                | yes                         | yes                         |
| Edit or delete a catalogue book or format                  | yes                         | no (removes it from shelf)  |
| See a child's shelf, reads, sessions, goals and statistics | yes, read-only              | —                           |
| See another member's notes and quotes                      | only notes shared with them | only notes shared with them |
| Members, backup and restore, Bookpine import, Notion       | yes                         | no                          |

Notes and quotes are private by default; a per-note `shared` flag (default false) lets a child share a note with the parents. Parents' reading is not visible to children.

**Enforcement.** Routes resolve the signed-in member once; services and repositories take it as a parameter and scope every personal query to it, so no route builds its own `member_id` filter. A dedicated test suite seeds two members of each role and asserts that no endpoint returns or changes another member's rows beyond the table above.

**Sync and offline.** `POST /api/sync` takes the member from the session, never from the payload, and rejects ops on another member's rows with `forbidden`. Offline writes on books become writes to the member's shelf entry (status and rating), so catalogue rows are edited online only and last-write-wins (ADR 0004) only ever resolves edits by one person. The client keeps one IndexedDB database per member (outbox and read model, ADR 0007); switching profile replays the current member's outbox first. A 401 during replay keeps the queued ops, asks for the PIN and replays after sign-in; it is never treated as "server unreachable".

**Data around the edges.** JSON backups export the whole family (`members`, `shelf_entries`, `member_id` columns; no PIN hashes or sessions), and a backup from before this change restores into the owner. The Bookpine import (API and CLI `--member`) targets one member's shelf. The Notion mirror stays the owner's data only.

## Consequences

- The tailnet still decides who can reach the server; the app now decides who is using it. A shared tailnet without sign-in would expose every member's data, so the sign-in middleware is part of the security boundary and is covered by the isolation tests. The loopback bind and its test are unchanged.
- A 4-digit PIN is weak on its own; it is acceptable only behind the tailnet and with the lockout.
- Moving `status` and `rating` out of `books` needs a table rebuild migration. It moves data rather than dropping it, but it rewrites the most important table, so it runs only with explicit approval and after a backup; the pre-migration backup must restore into the new schema.
- Nearly every service, route, screen and test gains a member parameter. The work is split into steps that each ship working: (1) members and sign-in with all data still the owner's; (2) per-member data, shelf entries, the child role and isolation tests; (3) per-member offline storage and profile switching; (4) parents' views of children's reading and family statistics.
- SPEC.md changes land with each step, not with this ADR.
- Open questions, to settle before the step that needs them: whether a child's shared notes are also visible to siblings; whether a child may correct catalogue data (e.g. a wrong page count) on a book they added; whether parents can see each other's reading.
