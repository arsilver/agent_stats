# Agent Stats — Deep Analysis & Improvement Report

**Date:** 2026-07-17 · **Scope:** scraping pipeline, token tracking, Kimi integration, UI/design, aiGotchi room, efficiency
**Method:** 6 parallel read-only analysts → 5 parallel implementation engineers → full typecheck + build + 8 smoke tests (all green)

---

## 1. What was broken and why

### 1.1 The Kimi card (your priority item)

Three independent defects compounded:

| # | Defect | Evidence |
|---|--------|----------|
| D0 | **Service disabled** — `kimi-code` missing from `enabledServices` in `app-settings.json`; the Dashboard hides disabled cards entirely | `app-settings.json`, `Dashboard.tsx:451`, zero kimi lines in `launch-log.txt` |
| D1 | **kimi.com switched to a Chinese UI** — the console now renders `本周用量`, `频限明细`, `N 小时后重置`; every scraper regex was English-only, so extraction always failed | live fetch of `kimi.com/code/console` + `kimi.com/agent` |
| D2–D4 | **Ready-check + timeout blowout** — `getPageReadyCheck` only required `innerText.length > 100` (passes instantly on placeholder pages); one window then loaded console + agent page (15s badge poll) + 4 guessed renewal URLs with fixed 3s sleeps → routinely exceeded the 90s window fail-safe → force-kill → recorded failures → exponential backoff hid the service up to 1h at a time | `tmp/dev-reconnect-test.log` (dozens of `Scrape exceeded 90s fail-safe timeout` kills), `service_health` row |
| D6 | **Bogus historical values** — the unanchored `Weekly usage[\s\S]*?(\d+)%` regex grabbed an unrelated `100%` element; last "good" snapshots are a constant `weekly=100` | SQLite `usage_snapshots`, 2026-05-02 |

**The pipeline itself was fully wired** (scraper → normalizer → cache → IPC → generic card) — no missing mapping. It was purely data + settings.

### 1.2 Token usage — what existed vs. what was captured

The app modeled usage as a generic scalar quota (%, messages, credits, $). Real token data was available but ignored:

| Service | Token data available | Was captured? |
|---|---|---|
| MiniMax | Weekly token totals on the token-plan page | **No** — parser stranded in a dead code path |
| OpenRouter | Per-model token counts on `/activity` | **No** — parser explicitly `break`ed at the Tokens section (`openrouterScraper.ts:195`) |
| ChatGPT | Per-model carve-out block (e.g. `GPT-5.3-Codex-Spark`) | **No** — deliberately truncated away (`chatgptScraper.ts:320`) |
| Claude | Per-model weekly buckets (Sonnet/Opus only) | **No** — only "All models" matched |
| Gemini (Antigravity) | Per-model quota % via local protobuf | Yes (only service with per-model data) |
| fal.ai | Per-model $ spend | Yes |
| Kimi | "Agent N left" badge (request credits, not LLM tokens) | Partially |

### 1.3 Efficiency / server-politeness findings (the spam audit)

- **TTL ≡ poll interval**: cache TTL = 10 min, poll = 10 min → every poll re-scraped all 11 services; the TTL never suppressed anything.
- **`refreshIntervalMs` was dead config**: MiniMax declared 5h but was scraped 6×/hour (144 scrapes/day instead of ~5).
- **5 managed Chrome processes resident for app lifetime** (1–2.5 GB RAM), never idle-closed; **Grok & MiniMax shared debug port 43213** (collision in port-fallback mode).
- **Retries hammered deterministic failures**: `page_not_ready`/`extract_failed` (site changed — retrying is pointless) retried after a flat 500ms.
- **Logged-out ≠ unhealthy**: `login_required` accrued service-health failures, tripping backoff; backoff was then reset on every app start anyway.
- **Write amplification**: full JSON cache rewrite per service per cycle (22 file ops/cycle); SQLite inserts every 10 min/service with **no retention, ever** (~1,600+ rows/day, unbounded).
- **Event storms**: window show/restore/power-resume each fired a full 11-service scrape with no minimum interval.
- **Renderer churn**: aiGotchi re-rendered the entire React tree **60×/s** (physics in React state); Dashboard + 11 cards + Logs page each ran 1s intervals (~13 state updates/sec idle baseline); scraper windows loaded full pages (images/fonts/media/analytics) with no request filtering.

### 1.4 Design findings

- Dated "2021 Web3 dashboard" aesthetic: violet accent, animated cyber grid, radial glow blobs, gradient text, shimmer sweeps — everything glowed, so nothing was emphasized.
- **Three competing color systems** (CSS tokens vs component constants vs Logs palette) — "healthy" rendered as three different greens.
- **Actual rendering bugs**: `var(--bg-tertiary)`, `var(--border-color)`, `var(--panel-bg)`, `var(--bg)` referenced but never defined → the API-key modal rendered **transparent**.
- Countdowns (the app's core value prop) were 10px 40%-opacity gray text, duplicated 3× per card.
- **aiGotchi's biggest latent asset**: ~900 lines of fully-designed mascot SVG/CSS (Codex knot orb, morphing Kimi avatar, MiniMax SD-card, runway/fal/openrouter art) were **unreachable dead code** — every non-Claude character rendered as a circular logo `<img>`.
- `window.*API` typings were invisible to the renderer (preload `.d.ts` not in `tsconfig.web.json`) → ~25 suppressed type errors.

---

## 2. What was changed (all implemented, typecheck + build + 8 smoke tests green)

### 2.1 Kimi repaired end-to-end
- **Bilingual parsing** (`kimiScraper.ts`): section-anchored EN/中文 regexes for `本周用量|Weekly usage`, `频限明细|Rate limit`, `N 小时/分钟/天 后重置|Resets in …`, and Agent badge (`剩余 N`, `N 次`, `N left`). Placeholder `-` values are rejected; missing data returns **null** (card shows `—`) instead of fake 0%.
- **Ready-check** now requires console identity + at least one *hydrated* percentage.
- **Login/wrong-page detection** with Chinese markers (`登录`, `扫码登录`, `手机号登录`, `验证码`, `微信登录`) → correctly classified as `login_required`, not `extract_failed`.
- **Time budget ~20–30s typical** (was 60–100s+): badge poll 15s→6s, renewal probe 4 URLs → console text + 2 URLs, and renewal only re-probed once per 24h (persisted to `kimi-renewal-state.json`).
- `authProfiles.ts`: kimi `usageUnit` `rmb` → `% used`; stale dashboard URLs synced to what scrapers actually use (chatgpt analytics, claude usage, openrouter `/credits`, runwayml org-agnostic — **your personal org UUID removed**).
- `usageNormalizer.ts`: "Agent Tokens" metric polarity → `remaining`.
- **Your settings updated**: `kimi-code` added to `enabledServices`; stale backoff/error cleared from `service_health`. → Restart the app and Kimi appears in the grid.

### 2.2 Real per-model token tracking added
- **OpenRouter**: parses the per-model **Tokens** section on `/activity` into `<model> · tokens (<period>)` sub-models (K/M/B suffixes handled; period-aware; skips cleanly if undetectable).
- **MiniMax**: weekly token scraping ported into the live managed-Chrome path (Weekly-tab click + parse + restore), 6h staleness cap on the disk snapshot, and `resetsAt` now a real absolute timestamp (was conflating window length with time-until-reset).
- **ChatGPT**: the per-model carve-out block is captured as sub-models instead of truncated; `tryApiScrape` no longer does a pointless double page load.
- **Claude**: per-model weekly buckets (Sonnet/Opus only) parsed into sub-models; greedy `Resets` regex rewritten to line-anchored (cleanup hack deleted); duplicate auth probe halved.
- **Grok**: port collision fixed (43213→43215); **stops fabricating data** (fake `now+7d` resets → null; invented "Product N" labels removed); extra credits surfaced via `agentCredits`.
- **usageTextParsers**: Higgsfield `'Credits used'` copy-paste bug fixed, `isRemainingTracker` set correctly, positional RPM/TPM/RPD mislabeling fixed.

### 2.3 Efficiency & politeness (main process)
- **Per-service cadence honored**: `refreshIntervalMs` now drives the TTL gate with deterministic per-service jitter — MiniMax drops from 144 scrapes/day to ~5; services no longer burst-fire together.
- **Event-poll debounce**: window show/restore/resume polls skipped if last poll < 5 min ago.
- **Smarter retries**: 3 attempts, 1s→4s exponential + jitter; deterministic parse failures never retried.
- **Auth ≠ health**: `login_required`/`cookies_expired` no longer feed backoff; backoff survives restarts for chronically failing services (≥6 failures).
- **Cache writes**: in-memory map authoritative; one debounced atomic write per cycle (was 22 full-file sync rewrites).
- **SQLite**: dedupe on unchanged values + 7-day retention job (startup + daily) — database is now bounded.
- **Scraper windows**: subresource filter blocks images/fonts/media/stylesheets/trackers per scrape (~50–80% bandwidth cut, less bot-detectable); 4s blind settle skipped when page already complete.
- **Managed Chrome fleet**: 30-min idle timeout closes unused instances (relaunch on demand verified); background polls can't cold-launch Chrome for services that never worked.
- **Logs**: push-based delivery (`logs:entries`, throttled 4/s) replaces the renderer's 1s full-buffer poll.

### 2.4 "Warm Instrument" redesign (renderer)
- **Full retokenization**: warm charcoal surfaces (`#0d0c0a`→`#2b2620`), one honey-amber accent `#e2a04a`, sage/amber/terracotta semantics, 16 legacy aliases — the transparent-modal bug is fixed as a side effect.
- **Killed**: animated cyber grid, glow blobs, gradient text, shimmer sweeps, all colored glows, bouncy easing, backdrop-blur.
- **New primitives**: solid `.meter` fills, `.num` tabular figures everywhere, one `.chip` status component, first-class **countdown chips** (`↻ 4h 12m`, warn <1h, danger <10m, one per bar), pill toggles, `.empty-state`, `.notice-bar`.
- **Dashboard**: summary strip (Connected x/y · Next reset · Updated), unified page headers, 1s→5s refresh countdown; card ring 1s→10s.
- **Nav**: real SVG stroke icons; sidebar defaults expanded. **Charts**: de-glowed, honest demo-data banner, RunwayML ÷10 shown in legend. **A11y**: `:focus-visible` + `prefers-reduced-motion` globally; 11px text floor.

### 2.5 aiGotchi — living diorama at *lower* CPU cost
- **Phase 0**: physics moved out of React state into refs with direct `translate3d` DOM writes — **60 React renders/sec → a few per minute**; per-render `Math.random()` animation restarts eliminated; dead Kimi morph interval removed; all paint-heavy CSS converted to transform/opacity; `prefers-reduced-motion` everywhere (loop drops to 4fps, canvas unmounts).
- **Phase 1**: 4-layer **parallax room** (sky window / wall / workzone / floor) with pointer parallax; **real day/night cycle** — sun/moon arc, crossfading sky, 20 twinkling stars, clickable warm lamp.
- **Phase 2**: facing-direction flips, walk cycles with dust puffs, proper sleeping on sofa cushions, click-to-pet 2.0 (squish + hearts), **drag & throw** (flings into the existing gravity/bounce/land-squash physics), and **all the dead mascots resurrected** — Codex knot orb, morphing Kimi, MiniMax SD-card are back, plus newly authored runwayml/fal-ai/openrouter SVG art.
- **Phase 3**: `AmbientCanvas` — 35 dust motes (fireflies at night), data rain in the workzone when a service is actively being used, and a pooled `burst()` particle API (crumbs/hearts/confetti/steam), 30fps, DPR-capped.
- **Phase 4**: usage-driven world events — **PAYDAY** confetti + all-hop when a quota resets, **SCAN** sweep on data refresh, overworked (≥75%) characters' monitors overheat with steam, and all-idle nights → sofa cuddle cluster with one night-watch character.

---

## 3. Verification

| Check | Result |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` | **0 errors** (also fixed pre-existing `oauthManager`/`geminiScraper` strictness errors) |
| `tsc --noEmit -p tsconfig.web.json` | **0 errors** (renderer now typechecked against real `window.*API` contracts for the first time) |
| `npm run build` | ✅ builds; **all 8 postbuild smoke tests pass** (IPC, WebAuthn, usage contract, normalizer, history schema, API fetchers, service registry, text parsers) |
| Kimi regex harness (standalone) | Chinese hydrated page → correct % + reset; placeholder page → nulls; chat homepage → `login_required` |

## 4. What you should do / watch

1. **Restart the app** (`npm run dev` or the packaged build) — Kimi Code will appear; you may need to sign in once via the card's connect flow (Chinese login pages are now detected correctly).
2. First Kimi scrape takes ~20–30s; watch the Logs page if it says `login_required` — that's now truthful, not a parse failure.
3. RAM: managed Chromes now close after 30 idle minutes — expect a much smaller footprint between polls.

## 5. Recommended next steps (not yet done)

1. **API-denominated tokens**: OpenAI `/v1/organization/usage` and Anthropic usage reports alongside the existing cost calls (needs org admin keys) — exact per-model token counts, no scraping.
2. **Delete ~800 lines of provably dead scraper code** (fal.ai/minimax legacy Electron paths, chatgpt `parseUsageText`) — left in place this round for safety.
3. **Scraper window pooling** (reuse one hidden window per partition) — bigger refactor, ~50–150MB process churn per scrape.
4. Extract remaining inline styles → CSS classes (unlocks theming); self-host the two fonts (app currently hits Google Fonts at runtime); re-encode the 700–800KB logo JPGs.
5. `AGENTS.md` service table is stale (7 vs 11 services) — worth a doc pass; also `AIGOTCHI_OVERVIEW.md` line counts/mood table drifted.
6. Visually verify the null-percent `—` rendering on the Kimi card and the resurrected mascots (codex/kimi/minimax art was unreachable for months — worth an eyeball).
