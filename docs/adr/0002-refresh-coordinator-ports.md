# ADR 0002: Refresh Coordinator behind injected ports

- Status: accepted
- Date: 2026-08-29

## Context

`usageFetcher.ts` grew to ~2,500 lines holding the refresh decision tree, the persist funnel, cache I/O, IPC handlers, polling glue, and five single-use API fetchers. Its top-level imports (electron, better-sqlite3, scraper registry, credential manager, managed Chrome) made the orchestration untestable through any interface — the smoke suite resorted to asserting on the file's source text with regexes (`tests/refresh-coordinator-smoke.js`). Every documented failure mode (parked SPA, transient-miss stale flip, incomplete-row persistence, clone bars) lived in this orchestration.

## Decision

The decision tree and commit funnel moved to `src/main/refreshCoordinator.ts` (electron-free, better-sqlite3-free) with all side effects behind two injected ports: `ScraperSource` (scraper lookup + API routing) and `UsageSink` (cache rows, SQLite snapshots, health records, broadcasts). `usageFetcher.ts` keeps module state, cache file I/O, IPC handlers, and polling timers, and wires the coordinator with one factory call. The five API fetchers moved to `src/main/apiFetchers.ts`. The regex test was replaced by `tests/refresh-coordinator-behavior-smoke.js`, which drives the coordinator with fake ports and asserts the shared scrape rules as behavior.

## Consequences

- The shared scrape rules (transient-miss keep, incomplete-row refusal, timeout hygiene, warm-up coalesce) are now asserted by a behavior test that fails when a rule breaks — verified by a break-and-restore proof.
- New pipeline policy (e.g. a new skip rule) goes in the coordinator and gets a behavior assertion; do not re-introduce source-regex tests.
- `usageFetcher.ts` should stay boring glue; if a change needs the decision tree, it belongs in the coordinator.
