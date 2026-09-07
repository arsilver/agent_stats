# ADR 0003: ManagedChromeScraper base class

- Status: accepted
- Date: 2026-08-29

## Context

`BaseScraper`'s hidden-BrowserWindow machinery (window slots, request filter, anti-fingerprint, Electron login window, `scrape()` template) was genuinely used by only 3 of 12 scrapers (runwayml, openrouter, higgsfield). The 9 managed-Chrome scrapers bypassed it entirely: wholesale `scrape()` overrides, null `extractUsageData` stubs, `isLoggedIn() → true`, plus ~30 lines of identical boilerplate each, copy-pasted in-page helpers (`bodyText`, `clickTab`, `tryJson`), and `forceReload` held by docs convention only (set by 3 scrapers, absent in 6 — intent or drift was unknowable).

## Decision

`src/main/scrapers/managedChromeScraper.ts` provides `ManagedChromeScraper extends BaseScraper`: the managed-session boilerplate, an `evaluateManaged` wrapper that applies a declared `forceReloadOnScrape` floor (per-call `true` still wins; the flag never lowers), a shared null-result classifier, and shared in-page helper constants. Scrapers keep their service-specific `scrape()` bodies (qwen dual-header wait, grok fallbacks, minimax tab clicks, claude cookie injection, kimi renewal cache, cursor RPC). `BaseScraper`'s window template remains for the 3 hidden-window scrapers.

## Consequences

- `forceReload` is now code, not convention: SPA scrapers declare `forceReloadOnScrape = true`.
- The skeleton (evaluate → classify → parse) has one home; service scrapers carry only what is genuinely service-specific.
- Drifted helper copies were deliberately NOT merged (chatgpt's 48-char clickByLabel, grok's 40-char billing clickTab, kimi/gemini/falai custom classification) — merging them would change behavior. Re-unify only with evidence the drift is accidental.
