# Agent Stats — AI Agent Usage Monitor

## Project Overview

Agent Stats is a cross-platform desktop application that tracks usage across multiple AI services including ChatGPT Codex, Claude, Kimi Code, MiniMax, RunwayML, fal.ai, OpenRouter, Cursor, Gemini, Higgsfield, Grok, and **Qwen Code**. It displays real-time usage statistics, limits, reset countdowns, historical analytics, and a gamified character view in a unified dashboard.

GitHub: [arsilver/agent_stats](https://github.com/arsilver/agent_stats). Sessions, cookies, `.env`, and `%APPDATA%/agent-stats/` stay on each machine — never commit them.

The application uses a hybrid data collection strategy:
1. **Web scraping via hidden BrowserWindow**: Loads service dashboards in headless Electron windows and extracts usage data via DOM evaluation
2. **Managed Chrome**: Most live cards (Qwen, Cursor, Grok, Claude, ChatGPT, Gemini, …) spawn a real Chrome instance and control it via Chrome DevTools Protocol (CDP). Cursor then calls `GetCurrentPeriodUsage` in that session. Also used for Cloudflare-protected flows
3. **API fallback**: Supports API key-based fetching when credentials are configured (currently limited use)
4. **Local caching**: Persists usage data to disk (JSON cache) and SQLite (usage history) for offline viewing and analytics

## Technology Stack

| Layer | Technology |
|-------|------------|
| Framework | Electron 40 with Vite 7 |
| Frontend | React 19 + React Router DOM 7 |
| Language | TypeScript 5.9 |
| Build Tool | electron-vite 4.0 |
| Styling | CSS custom properties (dark theme) |
| Database | better-sqlite3 (usage history) |
| Credentials | keytar (OS keychain) + AES-256-GCM encryption |
| Bundling | electron-builder 26 |

## Project Structure

```
agent-stats/
├── package.json                 # Dependencies and build scripts
├── electron.vite.config.ts      # Vite config for main/preload/renderer
├── tsconfig.json                # Root TypeScript config (project references)
├── tsconfig.node.json           # Main + preload process config
├── tsconfig.web.json            # Renderer process config
├── .env                         # Local dev API keys (git-ignored)
├── docs/
│   ├── cursor-usage.md          # Cursor Plan & Usage contract + postmortem
│   └── qwen-usage.md            # Qwen 7d / optional 5h contract + postmortem
├── src/
│   ├── main/                    # Main process (Node.js)
│   │   ├── index.ts             # Entry point: window mgmt, IPC registration, polling
│   ├── windowLifecycle.ts   # Last-window quit + reveal-window policy
│   │   ├── authProfiles.ts      # Service configurations (URLs, auth types)
│   │   ├── credentialManager.ts # Encrypted credential storage with OS keychain
│   │   ├── usageFetcher.ts      # Glue: cache file I/O, IPC handlers, polling timers (delegates to refreshCoordinator)
│   │   ├── refreshCoordinator.ts # Refresh decision tree + commit funnel behind injected ports (electron-free)
│   │   ├── apiFetchers.ts       # Official API fetchers + fetchViaAPI routing (electron-free)
│   │   ├── usageNormalizer.ts   # Metrics shape (primary/weekly units; Qwen windows)
│   │   ├── usageIntegrity.ts    # Cache integrity / reconcile (Cursor Total required)
│   │   ├── usageFreshness.ts    # Stale / cadence helpers
│   │   ├── serviceContracts/    # Per-service row rules (isComplete/reconcile/freshness) behind getServiceContract registry
│   │   ├── usageHistory.ts      # SQLite persistence with downsampled queries
│   │   ├── logManager.ts        # Circular log buffer (300 entries), console override
│   │   ├── managedChrome.ts     # CDP-based managed Chrome control
│   │   └── scrapers/            # Web scraping implementations
│   │       ├── baseScraper.ts   # Abstract base (anti-fingerprint, cookie mgmt, extraction)
│   │       ├── managedChromeScraper.ts # Base for the 9 managed-Chrome scrapers (shared skeleton, evaluate wrapper, forceReload flag)
│   │       ├── usageTextParsers.ts # Shared DOM-text parsing (incl. parseQwenSubscriptionText)
│   │       ├── chatgptScraper.ts
│   │       ├── claudeScraper.ts
│   │       ├── kimiScraper.ts
│   │       ├── minimaxScraper.ts
│   │       ├── runwaymlScraper.ts
│   │       ├── falaiScraper.ts
│   │       ├── openrouterScraper.ts
│   │       ├── cursorIdeUsage.ts # Cursor Plan & Usage API (GetCurrentPeriodUsage, IDE token fallback)
│   │       ├── cursorScraper.ts # Cursor: same scrape loop as Grok; web RPC then IDE token
│   │       ├── geminiScraper.ts
│   │       ├── higgsfieldScraper.ts
│   │       ├── grokScraper.ts
│   │       ├── qwenScraper.ts   # Qwen Code (forceReload SPA; 7d, optional 5h)
│   │       └── index.ts         # Scraper registry
│   ├── preload/                 # Preload scripts (contextBridge)
│   │   ├── index.ts             # API exposure via contextBridge
│   │   └── index.d.ts           # TypeScript declarations for window APIs
│   └── renderer/                # Renderer process (React app)
│       ├── index.html           # HTML entry point
│       ├── public/              # Static assets (logos/, self-hosted fonts/)
│       └── src/
│           ├── main.tsx         # React root render
│           ├── App.tsx          # Layout + routing with collapsible sidebar
│           ├── styles/
│           │   └── global.css   # Shared CSS variables and layout
│           │   └── charts.css   # Analytics page styles (lazy with Charts)
│           │   └── aigotchi.css # aiGotchi game page styles
│           │   └── aigotchi-character.css # Character sprite styles
│           ├── components/
│           │   ├── UsageCard.tsx  # Dual-window meters (MiniMax + Qwen)
│           │   ├── Toast.tsx    # Toast notification system
│           │   ├── AmbientCanvas.tsx # aiGotchi ambient particle canvas
│           │   └── AiGotchiCharacter.tsx # Animated character component
│           └── pages/
│               ├── Dashboard.tsx
│               ├── Charts.tsx   # Analytics with sparklines, line/bar/multi-line charts
│               ├── Logs.tsx     # Real-time log viewer with filtering
│               ├── AiGotchi.tsx # Gamified animated characters
│               └── Settings.tsx
├── tests/                         # Smoke tests + debug helpers
│   ├── test_usage_text_parsers.js # Qwen dual-window + other text parsers
│   ├── usage-normalizer-smoke.js
│   └── ...                      # IPC, integrity, managed-chrome, live probes
├── run.bat                        # **Primary Windows dev launch** → scripts/dev-launch.ps1
├── scripts/
│   ├── dev-launch.ps1           # Focus existing window / replace headless leftover / npm run dev
│   └── launch.bat               # Packaged app (dist/win-unpacked)
└── out/                         # Build output (git-ignored)
```

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                              │
│  ┌──────────────────┐  IPC  ┌────────────────────────────────┐  │
│  │  Renderer        │◄─────►│  Main Process                  │  │
│  │  (React + Vite)  │       │                                │  │
│  │                  │       │  ┌──────────────────────────┐  │  │
│  │  - Dashboard     │       │  │ credentialManager.ts     │  │  │
│  │  - Settings      │       │  │  - keytar (OS keychain)  │  │  │
│  │  - Usage cards   │       │  │  - AES-256-GCM store     │  │  │
│  │  - Charts/Logs   │       │  └──────────────────────────┘  │  │
│  │  - aiGotchi      │       │                                │  │
│  └──────────────────┘       │  ┌──────────────────────────┐  │  │
│         ▲                   │  │ usageFetcher.ts          │  │  │
│         │ contextBridge     │  │  - API calls (fetch)     │  │  │
│    credentialAPI            │  │  - Scraper fallback      │  │  │
│    usageAPI                 │  │  - 10-min polling loop   │  │  │
│    logsAPI                  │  └──────────────────────────┘  │  │
│                             │                                │  │
│                             │  ┌──────────────────────────┐  │  │
│                             │  │ scrapers/*.ts            │  │  │
│                             │  │  - Hidden BrowserWindow  │  │  │
│                             │  │  - Anti-fingerprint CDP  │  │  │
│                             │  │  - DOM extraction        │  │  │
│                             │  └──────────────────────────┘  │  │
│                             │                                │  │
│                             │  ┌──────────────────────────┐  │  │
│                             │  │ managedChrome.ts         │  │  │
│                             │  │  - Spawns real Chrome    │  │  │
│                             │  │  - CDP WebSocket control │  │  │
│                             │  │  - Cookie injection      │  │  │
│                             │  └──────────────────────────┘  │  │
│                             │                                │  │
│                             │  ┌──────────────────────────┐  │  │
│                             │  │ usageHistory.ts          │  │  │
│                             │  │  - better-sqlite3        │  │  │
│                             │  │  - usage_snapshots table │  │  │
│                             │  └──────────────────────────┘  │  │
│                             │                                │  │
│                             │  ┌──────────────────────────┐  │  │
│                             │  │ logManager.ts            │  │  │
│                             │  │  - Circular buffer (300) │  │  │
│                             │  │  - Console override      │  │  │
│                             │  └──────────────────────────┘  │  │
│                             └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Startup**: Main process loads cached usage from disk (`usage-cache.json`) → shows immediately → triggers background warm-up
2. **Warm-up**: Imports Chrome cookies (where possible) → scrapes all services sequentially → saves to cache + SQLite
3. **Scraping**: `usageFetcher.ts` checks scraper login state → opens hidden BrowserWindow → navigates dashboard → extracts usage via `executeJavaScript`
4. **Managed Chrome**: For Cloudflare-protected flows, `managedChrome.ts` launches a real Chrome with `--remote-debugging-port` and evaluates scripts via CDP
5. **Polling**: 10-minute interval refreshes all services in background; also triggers on window show/restore and system resume
6. **Persistence**: Each successful fetch saves to SQLite (history) and JSON cache (fast retrieval). A transient CDP/extract miss on a still-fresh `ok` row keeps that row Connected (`keepFreshCacheOnTransientMiss`). Older failures can fall back to the last good snapshot without looking like a new success.

### Security Model

- **Context Isolation**: Enabled (`contextIsolation: true`, `nodeIntegration: false`)
- **Main Window Sandbox**: Disabled (`sandbox: false`) to allow preload functionality
- **IPC Communication**: All main↔renderer communication via `contextBridge` only
- **Credentials**: Master key stored in OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service)
- **Encryption**: AES-256-GCM for credential file at `%APPDATA%/agent-stats/agent-stats-credentials.json`
- **Scraper Anti-Fingerprint**: CDP `Page.addScriptToEvaluateOnNewDocument` patches `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, and `Permissions.query` before page scripts run
- **CSP**: Strict Content-Security-Policy in production builds
- **Managed Chrome**: Background polls skip cold-launch when last status is `login_required` / `cookies_expired`. Concurrent Chrome spawns are capped at 2. Idle close is 30 minutes in the foreground and 5 minutes while the app is hidden or minimized. Scrapes pause when `net.isOnline()` is false (and on system suspend); Settings → **Close browsers** kills running managed Chromes without quitting the app. `reapOrphanManagedChromes(serviceId)` is a no-op while that service already has a tracked Chrome — killing child GPU/renderer processes used to time out CDP and stamp a good Qwen row stale.

## Supported Services

All services currently use `authType: 'web_session'`:

| Service | ID | Plan Tier | Dashboard URL | Unit |
|---------|----|-----------|---------------|------|
| ChatGPT Codex | `chatgpt` | Pro | chatgpt.com/codex/cloud/settings/analytics | % remaining (**weekly on top + 5h when the page still shows it**, managed Chrome port **43211**) |
| Claude | `claude` | Max 200 | claude.ai/new#settings/usage | messages |
| Kimi Code | `kimi-code` | Vivace (fallback; live page wins) | www.kimi.ai/membership/subscription?tab=quota | % used |
| MiniMax | `minimax` | Plus | platform.minimax.io/user-center/payment/token-plan | tokens (dual 5h + weekly) |
| RunwayML | `runwayml` | Subscription | app.runwayml.com/account/billing | credits |
| fal.ai / Kling | `fal-ai` | Subscription | fal.ai/dashboard/usage-billing | $ spend |
| OpenRouter | `openrouter` | Pay-As-You-Go | openrouter.ai/credits | $ spend |
| Cursor | `cursor` | Pro | cursor.com/dashboard | % (**Total + Cursor Models + Other Models**, managed Chrome port **43216**) |
| Gemini | `gemini` | Pro (fallback; usage chip wins) | gemini.google.com/u/1/usage | % current / weekly |
| Higgsfield | `higgsfield` | Subscription | higgsfield.ai/profile | credits |
| Grok | `grok` | SuperGrok | grok.com/?_s=usage | weekly used (**SuperGrok Heavy on grok.com**; **Grok Bot** weekly overlay from Cursor `GetSandUsageStatus`, managed Chrome port **43215**) |
| **Qwen Code** | `qwen` | Individual (live Standard scraped) | home.qwencloud.com/billing/subscription/token-plan-individual | credits (**7d; 5h when the page still shows it**, managed Chrome port **43219**) |

### Shared scrape rules (Cursor + Qwen lessons)

Do not treat a card as fixed until `%APPDATA%/agent-stats/usage-cache.json` matches a **live** fetch and the **running** Electron main is the build that wrote it. Renderer HMR does not reload scrapers. Use repo-root `run.bat`, not `scripts/launch.bat`.

- Same persist path for every service: `scraper.scrape()` → `commitSuccessfulScrape` → `cacheSet`. Do not add a service-only early return in `fetchServiceUsage`.
- Parked SPAs lie. Reload (`forceReload`) when the dashboard is a client-rendered page. Disconnect is not a refresh.
- Refuse incomplete `ok` rows (Cursor without official `totalPercent`; Qwen 7d-only while a 5h header is still on the page).
- Do not reap a **live** managed Chrome. `reapOrphanManagedChromes` skips a tracked session; scrapers must not reap at scrape start.
- A CDP timeout after a recent success must not paint Stale (`keepFreshCacheOnTransientMiss`).
- Unit tests are not GUI proof. Logs + `usage-cache.json` after a live write are.

### Dual-window services (MiniMax + Qwen + ChatGPT Codex)

`UsageCard` → `DualWindowUsageDisplay` via `hasDualWindowBars`. **Longer window on top** (weekly / 7-day), **5-hour underneath**. MiniMax always uses two meters when `weeklyPercentUsed` is set. Qwen uses the same dual UI **only** when a distinct 7-day pool is present. A live Individual page can be **7-day only** (`usageUnit: "7d credits"`, weekly null) — that is a single bar, not a failed dual. ChatGPT Codex uses the same dual UI when the analytics page has both **5 hour usage limit** and **Weekly usage limit** (remaining % inverted to used). Weekly-only Codex (no 5-hour block) is a single bar — do not invent a 5-hour reading from the weekly figure. Cursor is **not** dual-window — it uses Grok-style **Model Pools** bars for Cursor Models + Other Models.

#### ChatGPT Codex (critical parse notes)

| Piece | Location / behavior |
|-------|---------------------|
| Scraper | `ChatGPTScraper.scrape()` in the **normal** `usageFetcher` loop. Managed Chrome port **43211**; **always `forceReload`**. Wait for 5h **and** weekly remaining when the 5-hour header exists. Do **not** reap orphans at scrape start |
| Structured parse | `parseChatgptUsageText` in `usageTextParsers.ts` |
| Live shape | Analytics can be **weekly-only** or **5h + weekly**. Dual when both `% remaining` blocks exist. Do **not** persist weekly as a fake 5-hour reading |
| Primary fields | 5-hour remaining (`usageUnit: "% 5-hour limit"`, `isRemainingTracker: true`) when both windows exist |
| Weekly | `weeklyUsage` / `weeklyPercentUsed` / `weeklyResetsAt`, `weeklyBarLabel: "Weekly Limit"` |
| UI | Dual: **Weekly Limit on top**, **5-Hour Limit below**. Remaining % inverted to used. Weekly-only: one `% weekly limit` bar |
| Normalizer | Weekly metric unit is `% weekly limit`, **not** `"% 5-hour limit"` |
| Lesson | DualWindow was MiniMax/Qwen-only, so a live 5h+weekly Codex row rendered 5-hour as the headline and hid a proper 5-hour window. `hasDualWindowBars` must include `chatgpt` |

#### Qwen Code (critical parse notes)

Full contract: [`docs/qwen-usage.md`](docs/qwen-usage.md).

| Piece | Location / behavior |
|-------|---------------------|
| Scraper | `QwenScraper.scrape()` in the **normal** `usageFetcher` loop. Managed Chrome; **always `forceReload`**. Do **not** reap orphans at scrape start |
| Structured parse | `parseQwenSubscriptionText` / `parseQwenUsageJson` / `qwenStructuredParseIsIncomplete` in `usageTextParsers.ts` |
| Live shape | After reload, Individual · Standard may be **7-day only** (`has5=false`). That is valid. Dual 5h+7d still applies when both headers exist |
| Primary | 5-hour when both windows are distinct; otherwise the only real pool (often `7d credits`) |
| Weekly = 7d | `weeklyUsage` / `weeklyLimit` / `weeklyPercentUsed` / `weeklyResetsAt`, `weeklyBarLabel: "7-day"` — only when a second distinct window exists |
| Metered windows | Page shows **Remaining N%** of **Total**; card shows **used** → invert remaining |
| Uncapped 5h | `usageUnit: "5h lifted"`, `usageLimit: null`, used 0. Accept **both** live wordings: `Temporarily Lifted` + Remaining ∞, and `Temporarily Removed` + Remaining `-` |
| Clone / incomplete | Collapse identical dual pools. If the page still has a 5h header, refuse a 7d-only parse — do not persist it as `ok` |
| Readiness | Wait for both headers when they exist. Do **not** early-exit on the first `Remaining N%`. Single-window only after the wait, when the page has no 5h header |
| Fresh miss | `keepFreshCacheOnTransientMiss`: CDP timeout after a recent `ok` must **not** set `isStale` / “Refresh failed” |
| JSON | Optional overlay from `/tokenplan/personal/api/v2/usage` (and captured `cs-data.qwencloud.com` bodies). In-page fetch must abort in ~2.5s |
| Normalizer | Weekly metric unit must stay `credits` (or similar), **not** inherit period-specific primary units like `"5h lifted"` |
| UI labels | Dual: “7-Day Credits” on top + “5-Hour Credits” below. 7d-only: one `7d credits` bar. Logs: `7d=` when primary is 7-day — never mislabel it `5h=` |
| Lesson | Parked SPA + reap-during-scrape caused “Stale / refresh failed” on a row that just succeeded. See [`docs/qwen-usage.md`](docs/qwen-usage.md) |

When Qwen page copy drifts, update `parseQwenWindow` / `parseQwenUsageJson` / readiness markers first; add a fixture in `tests/test_usage_text_parsers.js` (flat + multiline).

#### Cursor (critical parse notes)

Full contract: [`docs/cursor-usage.md`](docs/cursor-usage.md).

| Piece | Location / behavior |
|-------|---------------------|
| Scraper | `CursorScraper.scrape()` in the **normal** `usageFetcher` loop (same as Grok). Web `GetCurrentPeriodUsage` in managed Chrome, then IDE token if Chrome misses. **Do not** add a Cursor-only early return in `fetchServiceUsage`. Spending-page DOM must never call `cacheSet(..., ok)` |
| Structured parse | `parseCursorUsageText` + `parseCursorPeriodUsageJson` / `mergeCursorDomWithApi` in `usageTextParsers.ts` |
| API wins | `planUsage.autoPercentUsed` / `apiPercentUsed` / `totalPercentUsed`. Spending DOM can stay on 2% / 14% + Cancels while Plan & Usage shows 15% / 9% / 42% |
| Primary | Official **Total** (`totalPercentUsed`) headlines the card. Named split with **no** Total is incomplete — do not persist it |
| Weekly = Other Models | `weeklyUsage` / `weeklyLimit: 100` / `weeklyPercentUsed` / `weeklyBarLabel: "Other Models"` (alias: **API**) |
| Summary line wins | `N% First-party models and M% API used` is authoritative over leftover Other Models 0% |
| No fake Total | Do **not** treat “Included in Ultra/Pro” as Total. Do **not** headline Cursor Models. Do **not** invent Total from 2+14 |
| On-demand | Do **not** scrape “includes at least $400 of API usage” or Disabled |
| Readiness | Numbers come from `GetCurrentPeriodUsage`, not spending-page Chrome readiness |
| Renewal | Stripe `active` / `Resets on` → renewing; `Cancels on` → cancelled |
| UI | **N / 100 TOTAL USED** from `totalPercent`, caption `N% First-party models and M% API used`, then Model Pools as `N% used`. Helper: `cursorOfficialTotalPercent` |
| Refuse | `validateAndReconcileUsage` + `cacheSet` reject Cursor `ok` without official `totalPercent`. Incomplete 4/42 cache is skipped on load. Forced Refresh does not reuse a non-force warm-up. Disconnect is not required |
| Lesson | Why this took so many tries: [`docs/cursor-usage.md`](docs/cursor-usage.md) § “Why this took so long”. Do not call Cursor fixed until `usage-cache.json` has `"totalPercent"` from a live fetch and the running main is that build |

When Cursor page copy or JSON fields drift, update `parseCursorPeriodUsageJson` / `parseCursorUsageText` first; add a fixture (live JSON + stale 2/14 overlay) in `tests/test_usage_text_parsers.js` and `tests/cursor-usage-contract-smoke.js`.

#### Grok Bot (on the SuperGrok Heavy card)

CaptainGrok **Weekly usage** is a **separate Cursor-account Sand pool**, not grok.com Chat/Build/Voice. Ultra and SuperGrok Heavy can both grant it; they do not stack into two Bot meters. Fetch `GetSandUsageStatus` with the existing Cursor IDE token during the Grok scrape (`parseGrokBotSandJson`). Persist `grokBotPercentUsed` / `grokBotResetsAt` — never `weekly*` and never a SuperGrok product `subModel`. Hide when `hasNonZeroIncludedLimit` is false. A Sand miss must not drop a good SuperGrok row. Card: dedicated **Grok Bot** bar below the weekly SuperGrok meter, outside collapsed Model Pools. Live probe: `tmp/grok-bot-sand-probe.js`.

## Build Commands

```bash
# Primary Windows launch (repo root) — same as double-clicking run.bat
run.bat
# equivalent:
npm run dev

# Production build (+ postbuild smokes)
npm run build

# Preview production build
npm run preview

# Package installers
npm run build:win      # Windows NSIS installer
npm run build:mac      # macOS DMG
npm run build:linux    # Linux AppImage
```

Notes:
- The `dev` script deletes `ELECTRON_RUN_AS_NODE` before `electron-vite dev` (required on Windows).
- **`run.bat`** is at the **repo root**. It focuses an already-open Agent Stats window, replaces a headless leftover, or starts `npm run dev`. `scripts/launch.bat` starts the **packaged** `dist/win-unpacked` binary (stale until you re-package).
- Main-process TypeScript (including scrapers) is compiled by electron-vite. A **syntax error in any scraper breaks `run.bat` / app start** — verify with `npm run build` or `npx electron-vite build` after scraper edits.

## Development Workflow

### Local Development Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure API keys (optional)**:
   Edit `.env` file with your API keys for local development fallback:
   ```
   CHATGPT_API_KEY=sk-...
   CLAUDE_API_KEY=sk-ant-...
   KIMI_CODE_API_KEY=...
   MINIMAX_API_KEY=...
   RUNWAYML_API_KEY=...
   FAL_AI_API_KEY=...
   ```
   Note: In production, credentials are stored in the encrypted store, not `.env`.

3. **Run in dev mode** (preferred on this machine):
   ```bash
   run.bat
   # or: npm run dev
   ```

### Adding a New Service

To add support for a new AI service:

1. **Add auth profile** in `src/main/authProfiles.ts`:
   ```typescript
   {
     id: 'new-service',
     displayName: 'New Service',
     planTier: 'Pro',
     authType: 'web_session',  // or 'api_key' / 'bearer'
     baseUrl: 'https://api.newservice.com',
     usageUrl: null,  // null if web_session
     dashboardUrl: 'https://newservice.com/settings/usage',
     usageUnit: 'credits',
     iconColor: '#ff6600'
   }
   ```

2. **Create scraper** (if `authType: 'web_session'`):
   Create `src/main/scrapers/newServiceScraper.ts`:
   ```typescript
   import { BaseScraper, ScrapedUsageData } from './baseScraper'
   import { BrowserWindow } from 'electron'

   export class NewServiceScraper extends BaseScraper {
     constructor() {
       super('new-service', 'https://newservice.com/settings/usage')
     }

     protected getExtraCookieDomains(): string[] {
       return ['newservice.com', 'auth.newservice.com']
     }

     protected getPageReadyCheck(): string {
       return `document.readyState === 'complete' && document.body.innerText.includes('usage')`
     }

     protected async extractUsageData(win: BrowserWindow): Promise<ScrapedUsageData | null> {
       return await win.webContents.executeJavaScript(`
         (function() {
           const text = document.body.innerText;
           // Parse usage from DOM/text...
           return { currentUsage: ..., usageLimit: ..., ... };
         })()
       `)
     }
   }
   ```

3. **Register scraper** in `src/main/scrapers/index.ts`:
   ```typescript
   import { NewServiceScraper } from './newServiceScraper'
   
   const scrapers: Record<string, BaseScraper> = {
     // ... existing scrapers
     'new-service': new NewServiceScraper()
   }
   ```

4. **Add to Settings UI**:
   Edit `src/renderer/src/pages/Settings.tsx` and add to the `SERVICES` array.

5. **Add API parser** (if using API key auth):
   Edit `src/main/apiFetchers.ts` and add a case to the `fetchViaAPI()` switch.

## Code Style Guidelines

- **TypeScript**: Strict mode enabled; all functions should have explicit return types
- **IPC Channels**: Use `kebab-case` for channel names (`'usage:fetch'`, `'credentials:get'`, `'logs:log'`)
- **Naming**:
  - Files: `camelCase.ts` for implementation, `PascalCase.ts` for classes
  - IPC handlers: `registerXxxHandlers()` pattern
- **Comments**: Use `// ─── Section Name ───` for visual section breaks
- **Error Handling**: Always log errors to console with `[serviceId]` prefix; never throw unhandled in IPC handlers
- **CSS**: Use CSS variables from `:root`; inline styles are used sparingly for dynamic values

## Testing

### Smoke tests

`npm run build` runs `postbuild`, which executes the full smoke suite (not just seven). Key scripts:

```bash
npm run test:ipc                # IPC channel contract (preload ↔ main)
npm run test:webauthn           # WebAuthn guard in scraper windows
npm run test:usage-contract     # Usage data shape contract
npm run test:usage-normalizer   # usageNormalizer (incl. Qwen weekly unit ≠ "5h lifted", ChatGPT weekly ≠ "% 5-hour limit", Cursor model scope)
npm run test:usage-integrity    # Cache integrity reconcile
npm run test:usage-freshness    # Staleness / freshness helpers
npm run test:usage-history      # SQLite history schema
npm run test:usage-api          # API fetcher parsers
npm run test:service-registry   # Scraper registry parity with authProfiles
npm run test:usage-parsers      # Text parsers — Qwen dual / 7d-only / lifted + Cursor Total / pools + ChatGPT 5h+weekly fixtures
npm run test:cursor-contract    # Cursor headline: official Total only (never 2% as Total)
npm run test:dual-window        # Dual-window: ChatGPT included; weekly/7-day on top, 5-hour below
npm run test:managed-login      # Managed-Chrome scrapers declare login path
npm run test:managed-teardown   # Managed Chrome teardown hygiene
npm run test:refresh-coordinator # Refresh coordinator BEHAVIOR (TTL, transient-miss keep, Cursor gate, timeout cancel, commit funnel, warm-up coalesce, backoff/login/offline skips, 2-wide pool)
npm run test:window-lifecycle   # Close last window quits; run.bat must show a window
```

All of the above should pass before shipping. Live probes live under `tmp/` (`tmp/qwen-live-validate.js`, `tmp/cursor-live-validate.js`, `tmp/chatgpt-live-validate.js`, `tmp/kimi-live-validate.js`, `tmp/qwen-probe.js`) against managed Chrome + real userData. Do not set `ELECTRON_RUN_AS_NODE` for those Electron probes.

### Manual testing workflow

1. **Credential flow**: Settings → Add API key → Verify masked display → Delete → Verify removal
2. **Scraper flow**: Dashboard → Click Connect/Open Browser → Complete auth → Verify usage fetch
3. **Cookie import**: Close app → Delete `%APPDATA%/agent-stats/` → Restart → Verify Chrome cookies imported
4. **Offline mode**: Disconnect internet → Verify cached data still displays
5. **Logs page**: Open Logs → Verify real-time console capture → Test filter/search/clear
6. **Analytics page**: Open Charts → Verify sparklines and chart rendering
7. **aiGotchi page**: Open aiGotchi → Verify characters animate and react to usage changes
8. **Qwen bars**: After Refresh, `Last updated` must move. If the page has 5h+7d, show both (∞ if Temporarily Lifted/Removed). If reload shows 7d only, one `7d credits` bar is correct. Never two identical clone bars. A just-written success must not flip to Stale on the next poll. Live probe: `tmp/qwen-live-validate.js`
9. **Cursor card**: Headlines official **Total** (`N / 100 TOTAL USED`) plus “N% First-party models and M% API used”, then Model Pools as `N% used`; API 42% must not stay at 14 or 0; $400 included API allowance is not on-demand spend; official Cursor mark (not letter C); **Renews** when Stripe is `active`. Proof is `"totalPercent"` in `usage-cache.json`. Main-process change → full quit + `run.bat`
10. **ChatGPT Codex bars**: After Refresh, if analytics has both 5h and weekly remaining, the card shows **Weekly Limit on top** and **5-Hour Limit below** (used %, not remaining). Weekly-only is one bar labelled weekly — never a fake 5-hour clone. Proof: `"weeklyPercentUsed"` plus `"usageUnit": "% 5-hour limit"` in `usage-cache.json`, and DualWindow on the running renderer. Live probe: `tmp/chatgpt-live-validate.js`
11. **Grok Bot bar**: After Refresh on the Grok card, SuperGrok Heavy weekly stays the headline. A **Grok Bot** bar below it should match CaptainGrok (~15%, weekly reset — not grok.com's reset and not Cursor Sep 12). Proof: `"grokBotPercentUsed"` in `usage-cache.json` `services.grok`. Sand miss must not flip the card Stale. Live probe: `tmp/grok-bot-sand-probe.js`

## Key Files Reference

| File | Purpose |
|------|---------|
| `run.bat` | **Primary Windows dev entry** → focus existing window or `npm run dev` |
| `src/main/index.ts` | App lifecycle, window creation, IPC registration, polling loop |
| `src/main/authProfiles.ts` | Service configurations — **edit this to add services** |
| `src/main/usageFetcher.ts` | Glue: module state, usage-cache.json I/O, IPC handlers, polling timers; wires the coordinator ports via one `createRefreshCoordinator` call |
| `src/main/refreshCoordinator.ts` | Per-service refresh decision tree, retry/timeout/failure shaping (`keepFreshCacheOnTransientMiss`), commit funnel (Qwen clone drop, Cursor gates), warm-up pool — electron-free, driven by injected `ScraperSource` / `UsageSink` ports |
| `src/main/apiFetchers.ts` | Official API fetchers (runwayml/fal-ai/openrouter/chatgpt/claude) + `fetchViaAPI` / `isPrimaryOfficialAPIService` |
| `src/main/usageNormalizer.ts` | Metrics normalization (primary vs weekly units) |
| `src/main/credentialManager.ts` | Encrypted storage with OS keychain integration |
| `src/main/logManager.ts` | Console override, circular log buffer, log IPC handlers |
| `src/main/managedChrome.ts` | CDP Chrome; `reapOrphanManagedChromes` skips a live tracked session |
| `src/main/usageHistory.ts` | SQLite schema, snapshots, downsampled history queries |
| `src/main/scrapers/geminiScraper.ts` | Gemini card: `gemini.google.com` usage panel (not Antigravity) |
| `src/main/scrapers/cursorIdeUsage.ts` | Cursor Plan & Usage API (`GetCurrentPeriodUsage`) + Grok Bot Sand (`GetSandUsageStatus`) |
| `src/main/scrapers/cursorScraper.ts` | Cursor scrape: same loop as Grok; web RPC then IDE token |
| `docs/cursor-usage.md` | Cursor Total / pool contract, postmortem, probes |
| `docs/qwen-usage.md` | Qwen 7d / optional 5h contract, parked-SPA + reap postmortem |
| `src/main/scrapers/qwenScraper.ts` | Qwen scrape: `forceReload`, dual-or-7d-only, no scrape-time reap |
| `src/main/scrapers/usageTextParsers.ts` | Shared text parsers including `parseQwenSubscriptionText` / `parseCursorUsageText` / `parseGrokBotSandJson` |
| `src/preload/index.ts` | All IPC APIs exposed to renderer |
| `src/preload/index.d.ts` | TypeScript types for window APIs |
| `src/shared/dualWindowUsage.ts` | Dual-window gate + labels (weekly/7-day on top, 5h below; includes ChatGPT) |
| `src/shared/qwenUsage.ts` | Canonical Qwen clone-weekly predicate used by main (cache load + commit) and the renderer gate |
| `src/main/serviceContracts/` | Per-service row rules (Cursor/Qwen/Grok/ChatGPT) behind the `getServiceContract` registry — pipeline consults it instead of inline service-id branches |
| `src/main/scrapers/managedChromeScraper.ts` | Base class for the 9 managed-Chrome scrapers: shared skeleton, `evaluateManaged` wrapper, `forceReloadOnScrape` flag, null-result classifier |
| `src/renderer/src/components/UsageCard.tsx` | Cards + dual-window display (MiniMax / Qwen / ChatGPT / Cursor) |
| `src/renderer/src/pages/Dashboard.tsx` | Main dashboard UI with refresh timer |
| `src/renderer/src/pages/Charts.tsx` | Analytics with sparklines, line/bar/multi-line charts |
| `src/renderer/src/pages/Logs.tsx` | Real-time log viewer with level filtering and search |
| `src/renderer/src/pages/AiGotchi.tsx` | Gamified animated character page |
| `src/renderer/src/pages/Settings.tsx` | API key management and web login UI |
| `src/renderer/src/styles/global.css` | Shared styles and CSS variables |
| `src/renderer/src/styles/charts.css` | Analytics page styles (lazy-loaded with Charts) |

## Security Considerations

1. **Never commit `.env`** — It contains API keys for local dev
2. **Never log credentials** — The credential manager masks values (`sk-abc...xyz`). Never log the Cursor IDE `cursorAuth/accessToken`
3. **Sandbox disabled for main window and scrapers** — Required for preload functionality and CDP debugger attachment; scrapers use isolated partitions (`persist:scraper-{serviceId}`)
4. **Anti-fingerprint patches** — CDP is used to patch `navigator.webdriver` and other automation signals before page scripts execute
5. **Chrome cookie access** — Chrome v20+ uses App-Bound Encryption; the app no longer decrypts cookies from files. Instead it uses CDP to read cookies from a running Chrome instance or launches a temporary headless Chrome with the user profile
6. **Master key** — Stored in OS keychain, never in source code or config files

## Platform Notes

- **Windows**: Chrome cookie access via CDP; credential storage via Windows Credential Manager; managed Chrome looks for Chrome at standard install paths
- **macOS**: Keychain for credentials; Chrome paths and managed Chrome spawning would need adjustment
- **Linux**: Secret Service API for credentials; Chrome paths would need adjustment

Currently optimized for Windows. macOS/Linux adaptations would require path changes in `managedChrome.ts` (Chrome executable paths) and testing for `keytar` integration.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `NODE_MODULE_VERSION` mismatch | Native modules compiled for wrong Electron version | Run `npm run postinstall` |
| Blank white screen | Renderer build failed | Check `out/renderer/` exists; run `npm run build` |
| **`run.bat` / `npm run dev` dies; no window** | Main-process transform/build error (often **syntax error in a scraper**) | Run `npx electron-vite build` or `npm run build`; fix the reported file/line; do not claim the app is up until Electron main is running with a window title |
| **`run.bat` does nothing / no window** | A previous Electron stayed alive after the window was closed and held the single-instance lock | `run.bat` now focuses a visible window or kills that leftover and starts fresh. Closing the last window quits the app on Windows |
| "Login required" for all services | Chrome cookies not importing / session expired | Check Chrome is installed; use Open Browser to sign in; for Cloudflare-protected services, sign in in Chrome then click Import Cookies |
| Credentials not persisting | keytar not working | Check Windows Credential Manager access; run as normal user (not admin) |
| Usage shows 0/null | Page structure changed | Update scraper regex in respective `*Scraper.ts` / `usageTextParsers.ts` |
| **Kimi Cookies expired / WeChat +86 login** | Reconnect opened China `kimi.com` instead of international `kimi.ai` | Quota URL is `www.kimi.ai/membership/subscription?tab=quota`. Full quit + `run.bat`, then Reconnect and Google SSO. Live probe: `tmp/kimi-live-validate.js` |
| **Codex 5h missing / 5h on top of weekly** | DualWindow was MiniMax/Qwen-only, or parked analytics SPA | `hasDualWindowBars` must include `chatgpt`. Weekly Limit on top, 5-Hour Limit below. `chatgptScraper` must `forceReload`. Live probe: `tmp/chatgpt-live-validate.js` |
| **Gemini frozen / Antigravity numbers** | Card was reading local IDE protobuf, not the website | Source is `gemini.google.com/u/1/usage`. The Antigravity fixture reader is test-only and lives in `tests/antigravityQuotaReader.ts` |
| **Qwen stuck on old % until Disconnect** | Parked SPA not reloaded (`Last updated` frozen) | `qwenScraper` must `forceReload: true`. Do not persist a 7d-only row when the page still has a 5h header. Live probe: `tmp/qwen-live-validate.js` |
| **Qwen Stale / refresh failed right after a good write** | Reap killed live Chrome children, or a CDP timeout overwrote a fresh `ok` | Do not reap while the session is tracked. `keepFreshCacheOnTransientMiss` must keep the last good row Connected. See `docs/qwen-usage.md` |
| **Qwen single 7d bar only** | 5h window not recognized, readiness exited too early, or page truly dropped 5h | If page text has both headers, refuse the scrape. If only 7d exists after reload, a single `7d credits` bar is honest. Re-run `npm run test:usage-parsers` + live probe |
| **Cursor Other Models missing / On-demand 400** | Parser still on First-party/API, or `$400` included allowance matched as spend | Extend `parseCursorUsageText` for Cursor Models / Other Models; ignore “at least $N of API usage”; re-run `npm run test:usage-parsers` |
| **Cursor Other Models 0 / Ends date while site shows API N% / Resets** | Spending-page DOM is stale vs IDE Plan & Usage (`GetCurrentPeriodUsage`) | Capture/merge `autoPercentUsed` + `apiPercentUsed`; API overlays DOM 0% / Cancels; re-run `npm run test:usage-parsers` |
| **Cursor shows 2/100 or 9/42 with no Total while Plan & Usage is 15 / 9 / 42** | Spending DOM was saved as `ok`, or Cursor was special-cased out of `scraper.scrape()`, or main is stale | Official Total is required. Check `usage-cache.json` for `"totalPercent"`. Quit + `run.bat` (not `scripts/launch.bat`). See `docs/cursor-usage.md` postmortem |
| **Cursor Incomplete / Disconnect EPERM** | Orphan Chrome holds `%APPDATA%/agent-stats/managed-chrome/cursor` | `powershell -NoProfile -File tmp/kill-cursor-orphans.ps1`, then Refresh. Disconnect must not toast failure if the folder stays locked. Do not Disconnect to “fix” numbers |
| **Qwen login_required / managed_browser_inactive** | Managed Chrome session dead or orphan Chrome holds profile | Settings → Open Browser / reconnect; Settings → **Close browsers**; kill **by PID** only orphans under `%APPDATA%/agent-stats/managed-chrome/qwen` |
| Zombie scraper windows | Scraping hangs | 90-second fail-safe timer force-destroys windows; concurrency limited to 2 windows max |
| Network adapter feels stuck / nothing loads | Managed Chromes holding connections | Settings → **Close browsers**, or restart the adapter; scrapes auto-pause when offline |
| Managed Chrome not launching | Chrome not found / debugger port stuck | Ensure Google Chrome is installed at a standard path; free the service debug port; kill orphan managed Chrome **by PID** |

## Environment Details

- **Node.js**: Compatible with latest LTS
- **Electron**: v40.6.0
- **electron-vite**: v4.0.0
- **Vite**: v7.3.1
- **Vite Dev Server**: Port 5173 (auto-increments if busy)
- **Output Directory**: `./out/`
- **User Data**: `%APPDATA%/agent-stats/` (Windows)
- **Scraper Debug Mode**: Set `AGENT_STATS_SCRAPER_DEBUG=1` to enable debug snapshots

---

*This file should be updated when adding new services, changing scraper/parse contracts (especially Qwen 7d / optional 5h, Cursor official Total, MiniMax dual-window), changing the security model, or modifying build/launch processes (`run.bat` / postbuild).*
