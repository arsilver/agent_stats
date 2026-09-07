# Agent Stats

Desktop dashboard for AI usage, limits, and reset countdowns across ChatGPT Codex, Claude, Kimi Code, MiniMax, RunwayML, fal.ai, OpenRouter, Cursor, Gemini, Higgsfield, Grok, and Qwen Code.

Windows is the supported platform today. Google Chrome is required for most live cards.

## Your accounts stay on your machine

This repository is source code only. It does **not** contain anyone's logins, cookies, API keys, or usage history.

| What | Where it lives |
|------|----------------|
| Web sessions / managed Chrome profiles | `%APPDATA%\agent-stats\` on **your** PC |
| Encrypted API keys | OS keychain + `%APPDATA%\agent-stats\` |
| Usage cache and SQLite history | `%APPDATA%\agent-stats\` |
| Optional local API keys | a git-ignored `.env` you create yourself |

After you clone and run the app, every service starts **disconnected**. Sign in with **your** accounts:

1. Open a card → **Connect** / **Open Browser** / **Reconnect**
2. Complete login in the window that opens
3. Refresh — that session stays in your local app data, not in git

Cursor may also read a token from a Cursor IDE install on the same machine. That is the local Cursor user, never a token from this repo.

Do not copy `.env`, `%APPDATA%\agent-stats\`, or anything under `tmp/` into git or a zip you share.

## Quick start (Windows)

```bat
git clone https://github.com/arsilver/agent_stats.git
cd agent_stats
npm install
run.bat
```

`run.bat` focuses an already-open Agent Stats window, or starts `npm run dev`. Use that, not `scripts/launch.bat` (that launches a packaged build under `dist/`, which is empty until you package).

Optional API-key fallback:

```bat
copy .env.example .env
```

Then fill only the keys you want. Most people can skip this and use web login instead.

## Scripts

| Command | What it does |
|---------|----------------|
| `run.bat` / `npm run dev` | Dev app (Electron + Vite) |
| `npm run build` | Production build + smoke tests |
| `npm run typecheck` | TypeScript project build check |
| `npm run build:win` | Windows NSIS installer |

## How data is collected

- **Managed Chrome** — most live cards spawn a real Chrome and read the usage dashboard (Cloudflare-safe)
- **Hidden Electron window** — a few remaining scrapers
- **API key** — optional fallback when you add a key in Settings
- **Local cache** — JSON + SQLite so the dashboard still works offline

Nothing is uploaded to a backend. Usage never leaves the machine.

## Repo layout

```
src/main/          Electron main: scrapers, credentials, polling
src/preload/       contextBridge APIs
src/renderer/      React dashboard, charts, settings, aiGotchi
src/shared/        Shared usage types and card gates
docs/              Service contracts (Cursor, Qwen, …)
tests/             Smoke tests (`npm run build` runs the suite)
```

Contributor / agent notes: [`AGENTS.md`](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
