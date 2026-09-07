# Agent Stats - Project Anatomy

This document outlines the architecture, core mechanisms, and technical details of the **Agent Stats** application. It serves as a comprehensive guide to understanding how the application functions, particularly its sophisticated data fetching and UI rendering pipelines.

## 1. High-Level Architecture

Agent Stats is built on the **Electron** framework, utilizing a two-process architecture for security and performance:
- **Main Process (Node.js)**: Handles system-level operations, secure credential storage, background polling, local database management (SQLite), and the core scraping engine.
- **Renderer Process (React + Vite)**: Manages the user interface, rendering the premium dark-mode dashboard, handling user interactions, and communicating with the Main Process via IPC (Inter-Process Communication).

## 2. The Data Pipeline: Fetching & Scraping

The application aggregates usage data across multiple AI service providers. Most cards are **managed Chrome scrapes** (CDP). A few still use a hidden Electron `BrowserWindow`. API-key fetching exists but is rarely the live path.

Canonical contracts: **`AGENTS.md`**, [`docs/cursor-usage.md`](docs/cursor-usage.md), [`docs/qwen-usage.md`](docs/qwen-usage.md).

### Mechanism Overview
The `usageFetcher.ts` module is the orchestrator. The main loop polls about every **10 minutes** (plus show/restore/resume). Per-service cadence lives in the fetcher (MiniMax is 5 hours). For each configured service:
1. **Cache Check**: Skip if the last `ok` row is still within that service's cadence.
2. **Scrape**: `getScraper(id).scrape()` → `commitSuccessfulScrape` → `cacheSet`. Same path for Cursor, Qwen, Grok, and the rest. Do not add a service-only persist fork.
3. **Managed Chrome**: Cloudflare / SPA dashboards spawn a real Chrome (`managedChrome.ts`) and evaluate via CDP. Qwen always `forceReload`s. Cursor calls `GetCurrentPeriodUsage` inside Chrome, then the IDE token if Chrome misses.
4. **Transient miss**: If CDP times out but the last success is still fresh, `keepFreshCacheOnTransientMiss` keeps the row Connected (no false Stale).

### Supported Services & URLs
The application currently supports many platforms defined in `authProfiles.ts` (full table: **`AGENTS.md` → Supported Services**). Highlights:

*   **Claude (`claude.ai`)**
    *   **Dashboard URL**: `https://claude.ai/new#settings/usage`
    *   **Logic**: Managed Chrome / scrape for session and weekly limits.
*   **ChatGPT Codex (`chatgpt.com`)**
    *   **Dashboard URL**: Codex analytics / usage settings (see `authProfiles.ts`)
    *   **Logic**: Managed Chrome port **43211**, `forceReload`. Dual 5h + weekly remaining when both blocks exist (weekly on top). Weekly-only is a single bar — never invent 5-hour from the weekly figure.
*   **Kimi Code (`kimi.com`)**
    *   **Dashboard URL**: Membership / quota tab
    *   **Logic**: Membership scrape for multi-window % usage.
*   **MiniMax (`minimax.io`)**
    *   **Dashboard URL**: Token plan / coding payment pages
    *   **Logic**: Dual-window 5-hour + weekly tokens on the dashboard card.
*   **Qwen Code (`qwen` / QwenCloud)**
    *   **Dashboard URL**: `https://home.qwencloud.com/billing/subscription/token-plan-individual`
    *   **Logic**: See [`docs/qwen-usage.md`](docs/qwen-usage.md). Managed Chrome port **43219**, always `forceReload`. Live Individual can be **7-day only** (`7d credits`). Dual 5h+7d when both headers exist. Remaining % inverted to used. Refuse 7d-only if a 5h header is still on the page. Do not reap Chrome at scrape start.
*   **Cursor (`cursor`)**
    *   **Dashboard URL**: `https://cursor.com/dashboard` (not `/spending`)
    *   **Logic**: See [`docs/cursor-usage.md`](docs/cursor-usage.md). Same scrape loop as Grok. Official source is `GetCurrentPeriodUsage` (`totalPercentUsed` + pools). Spending-page DOM is never `ok`.
*   **Gemini (`gemini`)**
    *   **Dashboard URL**: `https://gemini.google.com/u/1/usage?pageId=none`
    *   **Logic**: Managed Chrome port **43218**. Antigravity local protobuf is a test-only fixture, not the card.
*   **RunwayML / fal.ai / OpenRouter / Higgsfield / Grok**
    *   See `AGENTS.md` and `authProfiles.ts` for current URLs and units.

**Dual-window cards:** MiniMax always (weekly on top, 5h below). Qwen only when a distinct second window exists (7-day on top). ChatGPT Codex when both 5h and weekly remaining exist (weekly on top). Cursor uses Grok-style **Model Pools**, not dual-window.

### The Scraping Engine Deep-Dive
The scrapers (extending `BaseScraper.ts`) are highly resilient but operate in fundamentally hostile environments (constantly changing UIs).

1.  **Authentication**: Scrapers rely on the user's active session cookies. First-time setup requires opening an interactive `BrowserWindow` for the user to log in manually. Subsequent background polls silently utilize these cookies.
2.  **DOM Execution**: The Main Process silently boots the target URL and injects JavaScript (`webContents.executeJavaScript('document.body.innerText')`) to extract the raw text content of the page, bypassing complex HTML query selectors which break frequently when companies update their React components.
3.  **Regex Parsing**: The extracted massive text string is run through custom Regular Expressions to hunt down keywords (e.g., `Resets in`, `% used`) and extract the adjacent numbers and dates.

---

## 3. Case Study: The Claude Weekly Timer Challenge

The development of the Claude scraper exposed significant challenges in raw text parsing against modern responsive web applications. We encountered a persistent bug where the Weekly Reset timer consistently defaulted to displaying "7 days", regardless of the actual time remaining. 

### The Investigation
1.  **Initial Theory**: We assumed the date math logic was failing when calculating "Same Day" rollovers (e.g., parsing "Mon 2:00 PM" when today is currently Monday). While we fixed a minor bug here, the UI still read "7d".
2.  **Regex Cleaving**: We discovered `.matchAll(/Resets\s+(.+?)(?:\n|\.|$)/gi)` was failing because resizing the Claude browser window caused a visual line wrap, breaking `Mon 2:00 PM` into `Mon 2:00 \n PM`. The newline severed the regex capture.
3.  **The Invisible UI Artifacts**: We attempted to strictly match `([a-zA-Z]{3} \d{1,2}:\d{2} AM|PM)`. This failed entirely. A raw string dump from the compiled application revealed that Anthropic injects invisible zero-width HTML characters (like `\u200B` or Non-Breaking Spaces `\xA0`) between the elements to enforce responsive UI wrapping rules. Standard regex space identifiers (`\s`) could not bridge these invisible gaps.
4.  **The Final Breakthrough**: We wrote a brute-force regex to snag the 6 adjacent words. However, the parser *still* evaluated it as 7-days away. **The true culprit was structural.** Anthropic added a new "Monthly Billing Cycle" timer at the very bottom of the page (e.g., `Mar 1`). Our code was naively instructed to grab the *last* `Resets` string on the page, assuming it belonged to the Weekly limit. It snagged `Mar 1`, fed it to the math engine, and the engine correctly deduced that March 1st was roughly 7 days away.
    *   **The Scraper wasn't failing; it was faithfully reporting the wrong timer.**

### The Solution Strategy
To build a bulletproof scraper immune to invisible characters and layout additions:
1.  **Aggressive Sanitization**: The raw DOM text must first be scrubbed of all zero-width characters and normalized into single spaces: `.replace(/[\n\r\u200B\u200C\u200D\uFEFF]/g, ' ')`.
2.  **Explicit Anchoring**: Regex matches must trace backward to the explicit sub-header context. Instead of searching globally for `Resets`, the regex must strictly look behind for the `Weekly limits` section header: `/(?:Weekly\s+limits|All\s+models)[\s\S]{0,200}?Resets\s+([a-zA-Z0-9:]+(?:\s+[a-zA-Z0-9:]+){0,5})/i`.
3.  **Brute Force Extraction**: Instead of predicting exact formatting syntax, blindly drag the next segment of text out of the DOM, trailing characters and all, and sanitize it post-extraction.

This ensures the string `Mon 2:00 PM` is cleanly snagged from the correct UI section, regardless of layout changes or invisible spacing tricks.

---

## 4. Case Study: Electron Zombie Processes & Cache Corruption

During development, the core web scraping engine experienced severe, recurring `net\disk_cache\cache_util_win.cc:25 Access is denied (0x5)` and `Chrome is locking 1 cookie databases` errors. This corruption brought the entire application to a halt.

### The Investigation
1. **The Symptom**: Upon restarting the local dev server, the new Main Process would throw SQLite database lock exceptions for every configured scraping service (Claude, Kimi, etc.) when initializing the background `BrowserWindow`.
2. **The Cause**: When a scraper encountered an unexpected error (e.g., a regex failing on an unexpected marketer page redirect), the script crashed asynchronously *before* it could reach the `win.close()` teardown command.
3. **The Zombie Problem**: Because the hidden Chromium `win` object was never explicitly destroyed, the Node.js process would leave an invisible `electron.exe` Chromium instance running infinitely in the OS background. 
4. **The Lockfile**: Each of these "zombie" processes maintained a hard lock on the Electron `Session` partition cache. When the developer restarted the app, the new instance was denied access to the locked partitions.

### The Solution Strategy
To build an indestructible scraping loop that absolutely guarantees process teardown:
1. **Aggressive Timeout Failsafes**: A rigid `setTimeout(..., 45000)` countdown must be deployed *outside* the `try/catch` block. If the browser script hangs or hits an infinite loading screen, this timer acts as a supreme kill switch.
2. **Brutal Process Destruction**: Using `win.close()` allows the window to fire `beforeunload` events, which can be hijacked or stalled by the webpage. The failsafe timer must explicitly use `win.destroy()` to brutally force the OS to terminate the process and instantly release the cache locks.
3. **Strict `finally` Blocks**: All asynchronous scraping logic must be encapsulated in a `try/finally` block that calls `#destroy()` (if not already destroyed), definitively guaranteeing the window closure regardless of synchronous or asynchronous errors thrown during string extraction.

---

## 5. Security & Network Integrity (Spam Prevention)

Agent Stats operates in the background, autonomously authenticating with and scraping third-party AI provider dashboards. To ensure the integrity of the user's accounts and prevent abuse, the application is built on several core safety principles:

### Zero-Trust Execution
The headless Electron `BrowserWindow` instances used for scraping are aggressively sandboxed:
- `nodeIntegration: false` and `contextIsolation: true` prevent any malicious code on a scraped webpage (or compromised provider dashboard) from escaping the browser context and accessing the user's underlying Node.js system or local file system.

### Data Privacy & Local-Only Footprint
The application does not use a central proxy server.
- All requests are dispatched directly from the user's local Windows machine to the AI providers.
- Authentication cookies are extracted dynamically from the user's local Google Chrome profile and stored exclusively within the local `.electron` isolated partition cache.
- Usage data is cached purely locally in `usage-cache.json` and a local SQLite database for historical charts. **No credentials or usage data ever leave the user's machine.**

### Network Integrity (per-service cadence)
`usageFetcher.ts` skips a service whose last `ok` row is still within cadence.
- Default `CACHE_TTL` is **10 minutes** (`10 * 60 * 1000`). MiniMax uses a 5-hour interval. Forced Refresh bypasses the skip.
- Countdowns are computed in-memory from the cached reset timestamps.
- A CDP timeout on a still-fresh row does not rewrite that row as Stale (`keepFreshCacheOnTransientMiss`).

---

## 6. UI Rendering & Animations
The frontend leverages a modern, neo-cyber dark aesthetic.
- **State Management**: React components rely on IPC listeners that hook into the Main Process. When `usageFetcher` completes a cycle, it broadcasts an event. The UI triggers `window.api.getUsageCached()` to instantly update the React state.
- **Visual Feedback**: The interface relies on pure CSS transitions and SVG styling. Progress Bars utilize linear color interpolation and dynamic SVG masking to prevent overlapping `glow` filters from clipping outside their containers. Thumbnails employ inner `box-shadow` layering to simulate depth without relying on expensive image blending modes.

