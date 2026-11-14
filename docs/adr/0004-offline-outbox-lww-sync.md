# 0004. Offline outbox with last-write-wins sync

- Status: accepted
- Date: 14/11/2026

## Context

The iPhone may lose its connection to the Mac (Mac asleep, no signal, Tailscale reconnecting). Logging a session should still work then. There is one user and usually one active device, so concurrent conflicting edits are rare.

## Decision

Clients generate UUIDs for new records. Mutations made while the server is unreachable go into a Dexie (IndexedDB) outbox as ordered ops `{ opId, entity, action, payload, clientUpdatedAt }` and are replayed to `POST /api/sync`. The server applies each op in its own transaction, records applied and stale ops in `sync_ops` so replays are idempotent, and resolves conflicts per row by last-write-wins on `updated_at` (stored rows take the op's `clientUpdatedAt`). Sync replicates whole rows and does not repeat REST side effects; the full rules are in SPEC §5.1.

## Consequences

- Retrying a batch is always safe; a lost response cannot double-apply an op.
- Simple to reason about, but a later edit to any field of a row overwrites an earlier offline edit to a different field of the same row. Accepted for a single user.
- LWW depends on device clocks being roughly right; iOS and macOS keep them synced.
- Rejected ops are not recorded, so the client must surface or drop ops that keep failing with `validation_error`.
- Clients must send every row they change (e.g. the read they opened as well as the session).
