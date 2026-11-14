# 0009. Bookpine import: untimed sessions, merged editions and provenance

- Status: accepted
- Date: 14/11/2026

## Context

The user's reading history lives in Bookpine, whose CSV export records books (one row per edition), shelves, ratings and "readings". In practice the user marked every reading day as a separate 100 % "finished" reading, so the export holds the days a book was read but never how long; some books exist as several editions; Goodreads data imported into Bookpine sits as text blobs in the notes. Bookshelf's model is time-based (sessions with a duration), has one book per work with several formats, and had no record of where a row came from. The import must be repeatable as the user keeps both apps for a while, and must never damage data entered in Bookshelf.

## Decision

- **Untimed sessions.** Each Bookpine reading day becomes a session with `duration_seconds = NULL` and `source = 'bookpine'` (migration 0003). Such sessions count for the calendar, streaks and session counts, and never for time totals, minutes, the daily goal, reading speed or finish estimates. The UI labels them "Time unknown · imported" and lets the user add a duration later, after which they count like any session. Inventing a duration (e.g. a fixed 30 minutes) was rejected: it would silently distort every time-based statistic.
- **Reads from reading days.** A deterministic sweep groups a book's dated entries into reads (a gap of more than 180 days, or a completed read-through, starts a new one); real progress entries (pages, minutes) carry their progress; undated finished readings become historical reads dated from the Goodreads "Date Read" when one exists. The exact rules are in SPEC §8.1 and in the pure module `server/import/plan.ts`.
- **Merged editions.** Editions with the same normalised main title and first author (and compatible subtitles) become one book with one format per type; the status follows a fixed precedence (reading > paused > finished > dnf > to read). The preview lists every merge so the user can check it.
- **Paused status** (migration 0002) because Bookpine has a Paused shelf and a set-aside book should keep its read open without appearing as currently reading.
- **Provenance table** `import_links` (migration 0004) maps each source record — book slug, or anchor slug plus a suffix for formats, reads, sessions and notes — to its local row and stores the values the import wrote. Re-imports update only fields that still hold those values (three-way merge), never re-create rows the user deleted, never touch durations, and match never-imported existing books by ISBN or title instead of duplicating them. Provenance is part of the JSON backup.
- **Safety.** A dry-run preview applies the plan inside a transaction that is always rolled back, so the preview is exactly what the import would do. The real import looks books up first (network, outside any transaction), writes a pre-import snapshot, then applies everything in one transaction.

## Consequences

- Statistics stay honest: imported history shows when the user read, not invented durations. Time-based figures for imported periods stay empty until durations are added by hand.
- `duration_seconds` is nullable everywhere (schemas, sync, backups, derivations); older backups and clients still work because a missing `source` means `app`.
- The grouping and merge rules are heuristics fitted to the observed export; they are deterministic, tested with fictional fixtures that reproduce every observed pattern, and documented, but an unusual export could group reads differently than the user intends. Re-imports keep the user's corrections.
- Merging by title can join different books that share a main title and author (or keep apart true duplicates with differently spelled authors); the preview lists merges and near-misses as warnings.
- Removing a book or session in Bookshelf is permanent with respect to the import; to re-import it the provenance would have to be cleared (not offered).
