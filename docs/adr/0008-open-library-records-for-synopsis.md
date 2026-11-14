# 0008. Open Library edition and work records supply synopsis and language

- Status: accepted (amends ADR 0005)
- Date: 14/11/2026

## Context

ADR 0005 relied on Google Books to fill the synopsis that Open Library's data API (`/api/books?jscmd=data`) lacks, assuming that "a key only raises the Google quota". A real smoke test on 14/11/2026 showed that keyless Google Books requests are now refused with HTTP 429 because the shared anonymous quota is zero (`quota_limit_value: "0"`). Without `GOOGLE_BOOKS_API_KEY`, every looked-up book therefore had no synopsis and no language.

The same test showed that Open Library search results describe the whole work: `isbn` and `language` list every edition in no useful order, so a result could carry a Spanish edition's ISBN and `ger` as the language of an English novel.

## Decision

- After the data API, when the synopsis or language is missing, read the Open Library edition record (`/books/<OLID>.json`) for `description` and `languages`, and if there is still no synopsis, the work record (`/works/<OLID>.json`). Descriptions are tidied (CRLF, markdown source links, "Contains" appendices, trailing `--back cover`). Failures are logged and ignored. Google Books still fills whatever remains and is the fallback when Open Library has no record.
- Search requests Open Library's best-matching edition per work (`editions.*` fields, `lang=en`) and takes ISBN, language, publisher, publication date and cover from it. Without an edition, the work-level ISBN list is used as before but a language only when there is exactly one. An edition without an ISBN yields no ISBN rather than another edition's.
- Upstream publication dates are normalised to `YYYY`, `YYYY-MM` or `YYYY-MM-DD` when recognisable, and shown as `YYYY`, `MM/YYYY` or `DD/MM/YYYY`. Language codes (`en` or `eng`) are shown as names.
- Picking a search result that has an ISBN-13 but no synopsis runs the ISBN lookup for that edition and uses it, keeping the search result's values for anything the lookup lacks (or the search result alone if the lookup fails).

## Consequences

- Synopses work with no API keys. A Google Books key is still useful (and documented as such) for books Open Library lacks or has no description for.
- An ISBN lookup now makes two to four outbound requests (data API, edition, work, Google Books), all with timeouts; picking a search result adds one ISBN lookup.
- Searches prefer English editions; a reader who mainly reads other languages would want this configurable.
