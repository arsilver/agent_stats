# Cursor usage contract

Agent Stats must match **Cursor Settings → Plan & Usage**, not `cursor.com/dashboard/spending`.

The spending dashboard is a different UI. It often stays on an old snapshot (for example Cursor Models 2% or 9%, Other Models 14% or 42%, “Cancels on”) while Plan & Usage already shows **Total 15%**, **First-party 9%**, **API 42%**, **Resets on**.

## Source of truth

`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`

Headers:

- `Authorization: Bearer <IDE access token>` **or** the cursor.com session cookie (`credentials: 'include'` inside managed Chrome)
- `Content-Type: application/json`
- `Connect-Protocol-Version: 1`
- body `{}`

The IDE token is read from Cursor’s `state.vscdb` key `cursorAuth/accessToken`. **Never log the token.** On Windows, open that SQLite file with a **plain readonly path**. `file:?mode=ro` URIs fail under Electron’s better-sqlite3.

Field mapping (this is the card):

| API field | Card |
|-----------|------|
| `planUsage.totalPercentUsed` | Headline **N / 100 TOTAL USED** (`totalPercent`) |
| `planUsage.autoPercentUsed` | Model pool **Cursor Models** (First-party) |
| `planUsage.apiPercentUsed` | Model pool **Other Models** (API) |
| `billingCycleEnd` | Footer date |
| `cancelAtPeriodEnd` / `cursorAuth/stripeSubscriptionStatus` | Renews vs Ends |

Total is a **weighted** blend. `9 + 42 ≠ 15`. Never invent Total from the two pools. Never headline Cursor Models as Total.

On-demand copy such as “includes at least $400 of API usage” is an allowance, not spend. Do not scrape it as a bar.

## Fetch path (what the running app actually does)

Cursor is **not** a special persist path. It uses the same scrape loop as Grok:

1. `usageFetcher.fetchServiceUsage` → `getScraper('cursor').scrape()`
2. `CursorScraper.scrape()` calls `GetCurrentPeriodUsage` inside managed Chrome (`fetchCursorUsageFromWeb`, dashboard `https://cursor.com/dashboard`)
3. If Chrome is locked, signed out, or the page has no `totalPercentUsed`, it falls back to the same RPC with the IDE token (`fetchCursorUsageFromIde`)
4. `commitSuccessfulScrape` → `cacheSet` only if official `totalPercent` is present
5. Logs must show `[cursor] wrote Total=… cursorModels=… other=…`

Spending-page DOM is never persisted. `extractUsageData` returns `null` on purpose.

A Cursor `status: ok` row **without** official `totalPercent` is rejected by `validateAndReconcileUsage` and `cacheSet`. It cannot hit disk. On load, that shape is skipped. A cache row without `totalPercent` is never “fresh”. Forced Refresh must not reuse an in-flight non-force warm-up.

If both web and IDE miss, keep the last **complete** cache. If that row is still within cadence, `keepFreshCacheOnTransientMiss` must **not** set `isStale` / “Refresh failed” (same rule as Qwen). A miss after the row is already stale can show refresh failed. Do not look like a successful same-number refresh when Total never wrote.

**Refresh must change `totalPercent` in `%APPDATA%/agent-stats/usage-cache.json` or it failed.** A working write has `"totalPercent"` equal to `"percentUsed"`, pools from `autoPercentUsed` / `apiPercentUsed`, and `"renewalKind": "renewing"` when Stripe is `active`.

Disconnect is not required to fix numbers. If Disconnect hits `EPERM` on `%APPDATA%/agent-stats/managed-chrome/cursor`, an orphan Chrome is holding the profile. Kill **only** `chrome.exe` whose command line matches `managed-chrome\cursor`, then Refresh. Do not toast Disconnect as failed if the folder stays locked. `reapOrphanManagedChromes('cursor')` must return 0 while a tracked Cursor Chrome is already up — do not kill GPU/renderer children of the live session.

## UI

Same headline pattern as Grok:

- `15 / 100 TOTAL USED` plus `15%`
- Caption: `9% First-party models and 42% API used`
- Then **Model Pools**: Cursor Models `9% used`, Other Models `42% used`
- Footer: **Renews Sep 12** when Stripe is `active` (not Ends)

`cursorOfficialTotalPercent()` returns null unless `totalPercent` (or metric `cursor:total`) is present. A 9% primary that clones Cursor Models must not become the headline.

A Cursor row without official Total must not look **Connected**. The card shows **Incomplete / no Total** and “Click refresh to load it from cursor.com.” History fallback must not overlay 4/42 pools when Total is missing.

## Live probe (no secrets)

```bat
python tmp\cursor-ide-probe.py
```

```bat
set ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe tmp\cursor-ide-electron-probe.js
```

```bat
set ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe tmp\cursor-live-validate.js
```

These print only percentages (and the live-validate script also writes a complete cache row). If they show Total ~15 / auto ~9 / api ~42 and the card still shows Incomplete or 9/42 with no Total, the running **main process** is stale — fully quit Agent Stats and start again with `run.bat` (not `scripts/launch.bat`). Renderer hot-reload cannot pick up scraper or fetcher changes.

Orphan Chrome kill (do **not** nest `$_` inside `powershell -Command` — the outer shell strips `$`):

```bat
powershell -NoProfile -File tmp\kill-cursor-orphans.ps1
```

## Tests that lock this

- `npm run test:usage-parsers` — live JSON fixture and API overlay on stale 2% / 14% DOM
- `npm run test:cursor-contract` — headline helper refuses 2% as Total; 4/42 cache is not Connected; fetcher must call `scraper.scrape()` (no `fetchCursorUsageIdeOnly`)
- `npm run test:usage-integrity` — 4/42 with no Total is rejected
- `npm run test:usage-freshness` — incomplete Cursor is not fresh
- `npm run test:usage-normalizer` — `cursor:total` metric

When Plan & Usage copy or JSON field names drift, update `parseCursorPeriodUsageJson` / `parseCursorUsageText` first, add a fixture, then the card.

---

## Why this took so long (read before “fixing” Cursor again)

This card was wrong for many iterations even though **the API was always fine**. Live `GetCurrentPeriodUsage` on this machine kept returning the real Plan & Usage numbers (Total moved ~11 → ~15, First-party ~4 → ~9, API stayed 42, Stripe `active`). The app was saving a different row and calling that a successful refresh.

### What we kept getting wrong

1. **We special-cased Cursor out of the scrape loop.**  
   `usageFetcher` had `if (serviceId === 'cursor') return fetchCursorUsageIdeOnly(...)`. Every other card goes through `scraper.scrape()` → `commitSuccessfulScrape` → `cacheSet`. The Cursor-only path missed, threw, or wrote a partial row, and Chrome never ran as a real fallback. “Fetch from the IDE API” sounded correct and still skipped the path that actually persists usage.

2. **Spending-page DOM was accepted as `status: 'ok'`.**  
   `cursor.com/dashboard/spending` is not Plan & Usage. It produced 2/14, then 4/42, then 9/42, **no `totalPercent`**, often `renewalKind: "cancelled"`. `cacheSet` used to persist that. The card then looked Connected with the wrong headline. Disconnect “fixed” it only because it wiped the parked managed-Chrome profile, not because Disconnect is part of the fetch.

3. **We treated unit tests as proof the GUI worked.**  
   Parser, integrity, and headline tests can be green while `%APPDATA%/agent-stats/usage-cache.json` `services.cursor` still has no `"totalPercent"`. The only proof a refresh worked is that file (or the log line `[cursor] wrote Total=…`) after the **running** main process fetched.

4. **The running Electron main was stale.**  
   Scraper and fetcher live in the main process. Vite HMR updates the renderer only. `scripts/launch.bat` starts packaged `dist/win-unpacked` (also old). After a source fix, Refresh kept writing the old 4/42 or 9/42 shape. We then added a “Needs restart” chip — after the user *did* restart, the card still had no Total because the persist path was still wrong. Restart is required for main-process changes; it is not a substitute for a live write.

5. **We claimed done without doing the live write ourselves.**  
   Telling the user to quit + `run.bat` + Refresh is not validation. The session that finally worked: live-fetched Plan & Usage, parsed with `parseCursorPeriodUsageJson`, wrote a complete cache row (`totalPercent` = `percentUsed` = 15, pools 9/42, `renewing`), quit the old Agent Stats process, started `run.bat`, and confirmed the new main **loaded** that row instead of skipping it.

6. **Orphan Chrome looked like a product bug.**  
   `%APPDATA%/agent-stats/managed-chrome/cursor` held by leftover `chrome.exe` → Disconnect `EPERM`, web scrape cannot launch. Kill by PID only when the command line matches `managed-chrome\cursor`. Nested PowerShell `$_` gets stripped by the outer shell (`$_.Name` → `.Name`) and kills nothing.

### What actually made it work

| Change | Why it mattered |
|--------|-----------------|
| Delete the Cursor-only early return in `usageFetcher` | Refresh uses the same persist path as Grok |
| `CursorScraper.scrape()` = web `GetCurrentPeriodUsage`, then IDE token | Same RPC the website uses; Chrome lock no longer means “no numbers” |
| `cacheSet` + integrity reject `ok` without official Total | 4/42 and 9/42 cannot be saved as success again |
| `commitSuccessfulScrape` copies `totalPercent` and logs the write | Disk and Logs agree with Plan & Usage |
| Card hides Connected / pool success when Total is missing | Incomplete 4/42 cannot look like a working card |
| Prove it on disk, then restart the **old** main ourselves | The GUI finally showed 15 / 9 / 42 / Renews |

The trick was not a new API. It was: **stop special-casing Cursor, refuse incomplete rows, and do not call it fixed until `usage-cache.json` has `"totalPercent"` from a live fetch and the running main is the build that wrote it.**
