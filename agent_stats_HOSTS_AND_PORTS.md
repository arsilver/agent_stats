# Agent Stats — AI Usage Monitor — Hosts & Ports

## Services

| Service | Host | Port | Protocol | Description |
|---------|------|------|----------|-------------|
| **Renderer (Vite dev)** | `localhost` | `5173` | HTTP | React SPA dev server (Electron renderer) |
| **Electron Main Process** | N/A | N/A | IPC | Main process — credentials, OAuth, scrapers, SQLite |
| **OAuth Callback** | N/A | N/A | Custom Protocol | `agent-stats://oauth/callback` deep link |

## Managed Chrome (CDP) — 43211–43219

Each scraper that needs a real Chrome TLS fingerprint drives its own offscreen
Chrome with its own profile under `%APPDATA%/agent-stats/managed-chrome/<id>/`.
The `port` in each `ManagedChromeConfig` reserves the slot; the processes are
actually spawned with `--remote-debugging-pipe`, so **nothing listens on these
ports** — they will not appear in `netstat`, and they cannot be attached to from
outside the Electron process.

| Port | Service | Config location |
|------|---------|-----------------|
| `43211` | ChatGPT Codex | `src/main/scrapers/chatgptScraper.ts` |
| `43212` | Claude | `src/main/scrapers/claudeScraper.ts` |
| `43213` | MiniMax | `src/main/scrapers/minimaxScraper.ts` |
| `43214` | fal.ai | `src/main/scrapers/falaiScraper.ts` |
| `43215` | Grok | `src/main/scrapers/grokScraper.ts` |
| `43216` | Cursor | `src/main/scrapers/cursorScraper.ts` |
| `43217` | Kimi Code | `src/main/scrapers/kimiScraper.ts` |
| `43218` | Gemini | `src/main/scrapers/geminiScraper.ts` |
| `43219` | Qwen Code | `src/main/scrapers/qwenScraper.ts` |

Next free slot: **43220**. Keep the inline `NOTE:` comment in each scraper's
config in sync when claiming one. Ports are reservation IDs only — Chrome is
spawned with `--remote-debugging-pipe`. `reapOrphanManagedChromes` must not
kill a service that already has a tracked pipe/port browser.

## Network Topology

```
Electron App
  │
  ├── http://localhost:5173  ──► Vite dev server (renderer process, dev mode only)
  │
  ├── IPC (contextBridge)    ──► Electron main process
  │     ├── credentialManager  (encrypted store + OS keychain)
  │     ├── oauthManager       (token exchange, refresh)
  │     ├── usageFetcher       (API calls + web scraping)
  │     └── usageHistory       (SQLite read/write)
  │
  ├── HTTPS outbound          ──► AI service APIs (usage polling)
  │     ├── api.openai.com
  │     ├── api.anthropic.com
  │     ├── generativelanguage.googleapis.com
  │     ├── api.moonshot.cn
  │     ├── api.minimax.chat
  │     ├── api.runwayml.com
  │     └── fal.run
  │
  └── HTTPS outbound (scrapers) ──► Service dashboards (managed Chrome / hidden window)
        ├── chatgpt.com/codex/cloud/settings/analytics
        ├── claude.ai/new#settings/usage
        ├── gemini.google.com/u/1/usage
        ├── www.kimi.ai/membership/subscription?tab=quota
        ├── platform.minimax.io/user-center/payment/token-plan
        ├── cursor.com/dashboard  (+ api2.cursor.sh GetCurrentPeriodUsage)
        ├── grok.com/?_s=usage
        ├── home.qwencloud.com/billing/subscription/token-plan-individual
        ├── app.runwayml.com/account/billing
        └── fal.ai/dashboard/usage-billing
```

## Configuration Sources

| Setting | Location | Value |
|---------|----------|-------|
| Vite port | `electron.vite.config.ts` (default) | `5173` (auto-increments if busy: 5174, 5175...) |
| Electron main | `package.json` → `main` | `./out/main/index.js` |
| Preload script | `src/main/index.ts` → `webPreferences.preload` | `../preload/index.js` |
| Custom protocol | `src/main/oauthManager.ts` | `agent-stats://` |
| Encrypted store | `electron-store` (auto) | `%APPDATA%\agent-stats\agent-stats-credentials.json` |
| OAuth token store | `electron-store` (auto) | `%APPDATA%\agent-stats\agent-stats-oauth-tokens.json` |
| SQLite DB | `src/main/usageHistory.ts` | `%APPDATA%\agent-stats\usage-history.db` |
| OS keychain entry | `src/main/credentialManager.ts` | Service: `AgentStats`, Account: `master-encryption-key` |

## Port Conflict Notes

- Vite dev server uses `5173` by default but **auto-increments** if the port is taken (5174, 5175, etc.)
- No backend server is exposed — all logic runs inside Electron's main process via IPC
- No Docker containers — everything is a single desktop process
- The only local port used is the Vite dev server; in production builds, no ports are used at all

## Startup / Shutdown

| Action | Command |
|--------|---------|
| Dev mode | `run.bat` (repo root) or `npm run dev` |
| Build production | `npm run build` |
| Build Windows installer | `npm run build:win` |
