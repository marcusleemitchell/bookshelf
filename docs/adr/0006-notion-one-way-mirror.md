# 0006. Notion as a one-way mirror, written by the server

- Status: accepted
- Date: 14/11/2026

## Context

The user wants their reading data visible in Notion alongside other notes. Two-way sync with Notion would need conflict handling against a schema the user can edit freely, and Notion is not a reliable backup format.

## Decision

The server pushes books, sessions and notes to three Notion databases it creates under `NOTION_PARENT_PAGE_ID`, using an internal integration token (`NOTION_TOKEN`) that never leaves the server. Notion is write-only from Bookshelf's side: pages are upserted by a `Bookshelf ID` property, unchanged rows are skipped by content hash, and deleted rows are archived. The `Notion-Version` header is pinned to `2022-06-28`; requests are throttled to about three per second and retried on 429 (honouring `Retry-After`) and 5xx. Restore is always from the JSON backup, never from Notion.

## Consequences

- Edits made in Notion are overwritten on the next push of that row and never flow back.
- The token is only ever on the Mac; clients only trigger a run.
- Pinning the API version insulates Bookshelf from Notion's breaking changes (such as the 2025 data-source model); moving to a newer version is a deliberate future change with its own ADR.
- A large first run takes a while because of the rate limit; the request waits for the run to finish.
