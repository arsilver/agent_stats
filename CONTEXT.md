# Agent Stats — Domain Glossary

Shared vocabulary for the codebase. Use these names in code, docs, and architecture discussions. Architecture-level terms follow the `/codebase-design` vocabulary (module, interface, depth, seam, adapter, leverage, locality).

## Domain concepts

- **Usage row** — one service's usage reading (`UsageData`, `src/shared/usageTypes.ts`): current/limit/percent, reset time, status, optional weekly/pool/bot fields. The unit that crosses the IPC seam and lands in `usage-cache.json`.
- **Cache row** — a usage row as persisted in `%APPDATA%/agent-stats/usage-cache.json` (only `status: 'ok'` rows reach disk).
- **Ok row / incomplete ok row** — a `status: 'ok'` row; *incomplete* when it lacks a mandatory pool (Cursor without official **Total**, Qwen 7d-only while a 5h header exists). Incomplete ok rows are refused at the cache gate.
- **Dual-window service** — a service with two metered windows: the **longer window on top** (weekly / 7-day) and the **5-hour window** below (MiniMax, Qwen, ChatGPT Codex). Gate: `hasDualWindowBars` (`src/shared/dualWindowUsage.ts`).
- **Clone weekly** — a Qwen weekly/7d reading identical to the 5-hour primary (a page artifact, not a real second pool). Canonical predicate: `isQwenCloneWeeklyWindow` (`src/shared/qwenUsage.ts`) — the *only* formulation; cache-load, commit, and the render gate all use it.
- **Official Total** — Cursor's headline percent (`totalPercent` from `GetCurrentPeriodUsage`). A Cursor row without it is incomplete; never headline Cursor Models or a synthesized sum instead.
- **Model Pools** — Cursor's named sub-pools (Cursor Models / Other Models aka API), rendered as secondary bars.
- **Grok Bot (Sand pool)** — CaptainGrok weekly usage, a separate Cursor-account pool fetched via `GetSandUsageStatus`, shown as the Grok Bot bar. Metric id: `GROK_BOT_METRIC_ID` (defined in the grok contract).
- **Managed Chrome** — a real Chrome instance spawned per service and driven over CDP (`managedChrome.ts`); each service has a fixed debug port (chatgpt 43211 … qwen 43219).
- **Parked SPA** — a managed-Chrome tab that has been sitting on a client-rendered dashboard; it serves stale data until reloaded. Countermeasure: `forceReload` on scrape.
- **Transient miss** — a CDP/extract failure right after a successful scrape. The fresh cache row must be kept Connected (`keepFreshCacheOnTransientMiss`), never painted stale.
- **Warm-up** — the background refresh of all enabled services (`warmUpAllServices`), on a 10-minute poll, window show/restore, and system resume.

## Architecture modules (post-2026-08-29 refactor)

- **Usage Contract** (`src/main/serviceContracts/`) — one module per service owning its row rules: completeness refusal, commit/cache-load reconcile, freshness gate, integrity, model-pool scope. Pipeline code consults `getServiceContract(serviceId)` instead of branching on service ids. Default contract is a no-op.
- **Refresh Coordinator** (`src/main/refreshCoordinator.ts`) — the per-service refresh decision tree (TTL, backoff, retry, timeout, failure shaping) plus the **Commit Funnel** (`commitSuccessfulScrape` → `cacheSet`). Electron-free; all side effects go through injected ports.
- **ScraperSource / UsageSink** — the two ports the Refresh Coordinator programs against: scraper lookup + API routing, and persistence (cache, SQLite snapshots, health records, broadcasts). Production wiring is one factory call in `usageFetcher.ts`; tests bind fakes.
- **usageFetcher.ts (glue)** — module state, `usage-cache.json` I/O, IPC handlers, polling timers. Delegates decisions to the Refresh Coordinator.
- **API fetchers** (`src/main/apiFetchers.ts`) — official-API fetch path (runwayml/fal-ai/openrouter primary; chatgpt/claude supplemental) + `fetchViaAPI` routing.
- **ManagedChromeScraper** (`src/main/scrapers/managedChromeScraper.ts`) — base class for the 9 managed-Chrome scrapers: managed-session boilerplate, `evaluateManaged` wrapper, `forceReloadOnScrape` floor, null-result classifier. `BaseScraper`'s hidden-window template serves only runwayml/openrouter/higgsfield.
