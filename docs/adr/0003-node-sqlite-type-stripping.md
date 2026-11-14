# 0003. node:sqlite and Node type stripping (no native or compile dependencies)

- Status: accepted
- Date: 14/11/2026

## Context

Native SQLite drivers (e.g. better-sqlite3) need compiling against each Node version, and running TypeScript usually needs a build step or a loader such as tsx. Both add upgrade friction and moving parts to a server that should keep running for years with little care.

## Decision

Require Node ≥ 25. Use the built-in `node:sqlite` module (`DatabaseSync`) and run the server's TypeScript directly with Node's native type stripping. Server and shared code use only erasable syntax (no enums, namespaces or parameter properties; `import type` for types; `.ts` extensions in relative imports), enforced by `erasableSyntaxOnly` and `verbatimModuleSyntax` in `tsconfig.json`. `tsc` runs with `noEmit` purely as a type checker.

## Consequences

- No native modules, no build step for the server and no loader dependency; `npm start` runs `node server/index.ts`.
- Upgrading Node is the only way to upgrade SQLite. `node:sqlite` is newer than better-sqlite3 and its API may still change between Node majors; `.nvmrc` and `engines` pin the expectation.
- The synchronous API keeps transactions simple, but long queries block the event loop. Data volumes for one reader are small enough that this is acceptable.
