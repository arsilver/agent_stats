# Qwen Code usage contract

Agent Stats must match **home.qwencloud.com → Billing → Subscription → Token Plan Individual**, not a parked Chrome tab.

The page is a SPA. A tab left open can freeze on `Last updated 04:27` while live usage moves (0.3% → 16.5%). Disconnect “fixes” that only because it tears down the session. Refresh must reload the page.

## What the card shows

Personal Token Plan is **credits**. Windows depend on what the live page actually renders after a reload:

| Page | Card |
|------|------|
| 5-hour + 7-day, distinct pools | Dual meters: **5-Hour Credits** + **7-Day Credits** |
| 5-hour Temporarily Lifted/Removed + 7-day | 5h **∞ / Temporarily lifted** + 7-day used/total/% |
| 7-day only (no 5-hour header) | Single bar, `usageUnit: "7d credits"` — honest, not a dual clone |
| Identical 5h and 7d numbers | Collapse to one bar — never invent two identical meters |

Observed 2026-08-15 on Individual · Standard after a real reload: **no 5-hour card**, 7-day Remaining inverted to used (e.g. 1650 / 10000 @ 16.5%), reset `2026-08-21T20:09:00.000Z`, renews 2026-09-06.

Page polarity is **Remaining N% of Total**. The card shows **used**.

## Fetch path

1. `usageFetcher.fetchServiceUsage` → `QwenScraper.scrape()` (same loop as Grok / Cursor)
2. Managed Chrome on port **43219**, URL `https://home.qwencloud.com/billing/subscription/token-plan-individual`
3. **`forceReload: true`** every scrape — do not read a parked SPA
4. Wait for both `5 hours` and `7 days` headers when they exist. Do not early-exit on the first `Remaining N%`
5. Parse `document.body.innerText` with `parseQwenSubscriptionText`. Also accept JSON from `/tokenplan/personal/api/v2/usage` (and captured `cs-data.qwencloud.com` gateway bodies) via `parseQwenUsageJson`
6. If the page text still has a 5-hour header and the parse is 7-day-only, **refuse** (`qwenStructuredParseIsIncomplete`) — do not persist that as `ok`
7. In-page `fetch` of those APIs must time out quickly (~2.5s). Hanging gateway calls caused `CDP Runtime.evaluate` 15s timeouts

Logs for a good 7-day-only write look like:

`[qwen] structured: 7d=1650/10000 (16.5%) … lastUpdated=22:15:58 has5=false has7=true`

Do not log `5h=` when the primary pool is the 7-day window.

## Do not stamp a good row stale

A successful write, then an immediate second scrape, used to:

1. Call `reapOrphanManagedChromes('qwen')` while Chrome was still tracked
2. Match **child** GPU/renderer processes (`user-data-dir=.../managed-chrome/qwen`)
3. Kill them → `CDP Page.enable: timed out`
4. `cacheSet` the 2-minute-old success as `isStale: true` / “Refresh failed”

Rules:

- `reapOrphanManagedChromes(serviceId)` returns 0 if that service already has a tracked pipe/port browser
- `QwenScraper.scrape()` must **not** reap at the start of every scrape (`ensureChrome` reaps only when launching)
- `keepFreshCacheOnTransientMiss` in `usageFetcher`: if last success is still within cadence, a CDP timeout / extract miss keeps the row **Connected** (no yellow Stale / refresh failed)

Disconnect is not required to refresh numbers. Do not toast Disconnect as failed if the profile folder stays locked.

## Live probe (no secrets)

```bat
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe tmp\qwen-live-validate.js
```

Writes `tmp/qwen-page-text.txt` and `tmp/qwen-live-result.json`. Proof is `ok: true`, a current `lastUpdated`, and `%APPDATA%/agent-stats/usage-cache.json` `services.qwen` matching the parse (`percentUsed`, `usageUnit`, `isStale: false`).

Older helper: `tmp/qwen-probe.js`.

## Tests

- `npm run test:usage-parsers` — dual 5h+7d, lifted/removed, 7d-only live 2026-08-15 shape, incomplete dual refused, JSON dual, scraper `forceReload`, no scrape-time reap, `keepFreshCacheOnTransientMiss` present
- `npm run test:usage-normalizer` — weekly unit stays `credits`, not `"5h lifted"`

When page copy or JSON fields drift, update `parseQwenWindow` / `parseQwenUsageJson` first, add a fixture (flat + multiline), then the card.

## Why this looked like Cursor

| Mistake | What happened |
|---------|----------------|
| Trust a parked tab | `Last updated` frozen all day; Disconnect was the only “refresh” |
| Persist 7d-only while 5h was on the page | Dual collapsed to one bar |
| Reap orphans during a live scrape | Killed the session that just succeeded; card went Stale |
| Treat unit tests as a working GUI | Cache still had the old % until a live reload wrote a new row |

Same bar as Cursor: **reload the real source, refuse incomplete rows, do not call it fixed until `usage-cache.json` matches a live fetch and the running main is that build.**
