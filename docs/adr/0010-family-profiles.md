# 0010. Family profiles: shared catalogue, personal shelves, light PIN sign-in

- Status: accepted (steps 1–2a implemented: members and PIN sign-in, migration 0005; per-member data on the server with the admin flag, shelf entries and isolation tests, migrations 0006–0007)
- Date: 23/11/2026; amended 24/11/2026 (admin, view as, profile switching, comparisons)
- Amends: ADR 0002 (the tailnet is no longer the only boundary), ADR 0004 (last-write-wins now only applies to rows one member owns)

## Context

Bookshelf is single-user with no accounts (SPEC §1); ADR 0002 makes the tailnet the security boundary and says this must be revisited if the tailnet is ever shared. The user now wants the family to use it: parents and children on their own devices, sharing the Mac server.

- Family devices will join the user's tailnet. HTTPS (needed for the PWA's service worker) only exists through `tailscale serve`, so exposing the server on the LAN is not an option, and the loopback-only bind stays.
- Devices are not people: a child's iPad may be signed in to Tailscale as a parent, and one iPad may be shared. Tailscale identity headers therefore cannot say who is reading.
- A family usually owns one copy of a book, but each person has their own status, rating, reads, sessions and notes.

## Decision

**Members and roles.** A `members` table (id, name, role `parent`|`child`, PIN hash, colour, timestamps, `deleted_at`). The migration creates an owner parent and assigns every existing row to it, so the current library becomes the owner's shelf unchanged. Parents manage members (add, rename, reset a PIN, remove).

**Admin.** A parent can also be an admin (`members.is_admin`, added with `ALTER TABLE … ADD COLUMN`, no rebuild); the migration makes the owner the admin. An admin sees and changes every member's personal data, parents included, except notes and quotes, where an admin sees only the notes a member has shared, like any parent. Admins grant or revoke admin for other parents; there is always at least one admin, so the last one cannot be demoted, made a child or removed. Members are not told in the app that an admin can see their reading (the user's decision). Every change an admin makes to another member's data is logged as `Admin change` with the admin's id, the member's id, the entity and the action (ids only, never content).

**Light sign-in.** The app opens on a profile picker; choosing a profile asks for its PIN. Parents must have a PIN; for a child it is the parent's choice. PINs are hashed with scrypt from `node:crypto` (no new dependency); five wrong attempts lock that profile for 15 minutes, timed with the injected clock. A successful sign-in sets a random 32-byte token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/api`, valid for 180 days and renewed on use; only its SHA-256 hash is stored (`auth_sessions`), one per device. Middleware requires a session for every `/api/*` route except `/api/health` and the sign-in endpoints; the static web app stays public. New error codes `unauthorised` (401) and `forbidden` (403). On first start after the migration the owner is asked to set a PIN.

**Shared catalogue, personal shelves.**

- Shared by the family: `books` (bibliographic data and genres), `book_formats`, the cover cache.
- Per member (`member_id`): a new `shelf_entries` table (member, book, status, rating) that takes over `status` and `rating` from `books`, plus `reads`, `sessions`, `book_notes`, `tags`/`book_tags`, `goals`, `active_timer` and `import_links`. The timer singleton becomes one per member; tag names and goal periods become unique per member.
- A book is on a member's shelf when they have a live shelf entry; the library screen shows the member's shelf, and adding a book that is already in the catalogue only adds the shelf entry: `POST /api/books` reuses a live catalogue book with the same ISBN-13 (409 when it is already on the member's shelf).
- Deleting a book removes it from the member's own shelf (their shelf entry, reads, sessions, notes, tag links and timer on it); the catalogue book and its formats are soft-deleted only when no shelf has it any more. Children may do this too.

**Permissions.**

| Action                                                                | Admin                | Parent               | Child                       |
| --------------------------------------------------------------------- | -------------------- | -------------------- | --------------------------- |
| Own shelf, reads, sessions, timer, notes, tags, goals                 | yes                  | yes                  | yes                         |
| Add a book or a new format to the catalogue                           | yes                  | yes                  | yes                         |
| Edit or delete a catalogue book or format                             | yes                  | yes                  | no (removes it from shelf)  |
| See a child's shelf, reads, sessions, goals and statistics            | yes                  | yes, read-only       | —                           |
| See another parent's shelf, reads, sessions, goals and statistics     | yes                  | no                   | no                          |
| Change another member's shelf, reads, sessions, timer, tags and goals | yes (logged)         | no                   | no                          |
| See another member's notes and quotes                                 | only shared notes    | only shared notes    | only notes shared with them |
| Change another member's notes, PIN or sign-in sessions                | no (PIN: reset only) | no (PIN: reset only) | no                          |
| Compare members' reading                                              | everyone             | self and children    | —                           |
| Members, backup and restore, Bookpine import, Notion                  | yes                  | yes                  | no                          |
| Grant or revoke admin                                                 | yes                  | no                   | no                          |

Notes and quotes are private by default; a per-note `shared` flag (default false) shares a note with the parents (and so with admins). Parents' reading is not visible to children or, unless they are an admin, to other parents.

**Switching profile and viewing as.** On a shared device anyone can switch profile: Settings → Switch profile replays the current member's outbox, signs the device out and opens the picker, and the next member signs in with their PIN. An admin can also **view as** any member without that member's PIN: the session gains an acting member (`auth_sessions.acting_member_id`, `PUT /api/auth/view-as` with a member id or `null` to stop). While viewing as, every route scopes to the acting member, permission checks use the signed-in admin, private notes are left out, and the app shows a persistent "Viewing as {name}" bar with a way back. Viewing as needs a connection, and switching who is viewed replays the outbox of the member being left first, so queued changes are never applied to the wrong member.

**Comparisons.** A Family view in Stats compares the members the viewer may see (table above) over a chosen period: books finished, pages, reading time, sessions, days read, current streak and goal progress per member, a chart of reading time per week with one series per member, and the books on more than one shelf with each member's status and rating. It is served by one endpoint that returns only the members the viewer may see, built from shared derivation functions.

**Enforcement.** Routes resolve the signed-in member and the acting member once; services and repositories take them as parameters and scope every personal query to the acting member, so no route builds its own `member_id` filter. A dedicated test suite seeds an admin, a second parent and two children and asserts that no endpoint returns or changes another member's rows beyond the table above, including while viewing as.

**Sync and offline.** `POST /api/sync` takes the member from the session, never from the payload, and rejects ops on another member's rows with `forbidden`. Offline writes on books become writes to the member's shelf entry (status and rating), so catalogue rows are edited online only and last-write-wins (ADR 0004) only ever resolves edits by one person. The client keeps one IndexedDB database per member (outbox and read model, ADR 0007); switching profile replays the current member's outbox first. A 401 during replay keeps the queued ops, asks for the PIN and replays after sign-in; it is never treated as "server unreachable".

**Data around the edges.** JSON backups export the whole family (`members`, `shelf_entries`, `member_id` columns; no PIN hashes or sessions), and a backup from before this change restores into the owner. The Bookpine import (API and CLI `--member`) targets one member's shelf. The Notion mirror stays the owner's data only.

## Consequences

- The tailnet still decides who can reach the server; the app now decides who is using it. A shared tailnet without sign-in would expose every member's data, so the sign-in middleware is part of the security boundary and is covered by the isolation tests. The loopback bind and its test are unchanged.
- A 4-digit PIN is weak on its own; it is acceptable only behind the tailnet and with the lockout.
- Moving `status` and `rating` out of `books` needs a table rebuild migration. It moves data rather than dropping it, but it rewrites the most important table, so it runs only with explicit approval and after a backup; the pre-migration backup must restore into the new schema.
- Nearly every service, route, screen and test gains a member parameter. The work is split into steps that each ship working: (1) members and sign-in with all data still the owner's; (2) per-member data, shelf entries, the child role, member management, the admin flag and isolation tests; (3) per-member offline storage, profile switching, and admin view as with full edit and logging; (4) parents' and admins' views of other members' reading and the Family comparison view.
- Admin full edit means one person can change another adult's reading record without them knowing; the `Admin change` log is the only record. That is the user's explicit choice for one household.
- SPEC.md changes land with each step, not with this ADR.
- Open questions, to settle before the step that needs them: whether a child's shared notes are also visible to siblings; whether a child may correct catalogue data (e.g. a wrong page count) on a book they added. Settled 24/11/2026: parents do not see each other's reading; admins see and change everyone's except private notes.
