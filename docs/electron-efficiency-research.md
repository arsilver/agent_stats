# Electron 40 efficiency and packaging — primary-source notes

Researched 2026-08-13 against official docs and first-party source. Scope: an Electron 40 desktop app that (1) spawns Google Chrome with `--remote-debugging-port` / CDP, (2) uses hidden `BrowserWindow`s, (3) packages with **electron-builder 26**, (4) uses `better-sqlite3` and `keytar`, (5) bundles a React renderer with Vite / electron-vite.

Every factual claim has a source URL. This is not a product recommendation.

---

## 1. Memory, renderer count, one window vs many

### Process model

Electron inherits Chromium’s multi-process architecture. The app has one **main** (browser) process. Each `BrowserWindow` loads a page in a **separate renderer**. Destroying the window terminates that renderer.

- https://www.electronjs.org/docs/latest/tutorial/process-model

A renderer is also created for web embeds such as `BrowserView`.

- https://www.electronjs.org/docs/latest/tutorial/process-model

Chromium’s own design: each new tab will *likely* get a new renderer; plugins/extensions may add more processes. Shared DLLs exist, but **JS VM heaps, caches, and internal structures are replicated per renderer**. Closing a tab can flush that tab’s resources; a single-process model cannot.

- https://www.chromium.org/developers/memory-usage-backgrounder/
- https://www.chromium.org/developers/design-documents/multi-process-architecture/

Site Isolation (desktop) puts different sites in different sandboxed renderers. Extra processes increase memory; Chromium documents this as an explicit tradeoff.

- https://www.chromium.org/developers/design-documents/site-isolation/
- https://www.chromium.org/Home/chromium-security/site-isolation/

Electron’s process-model guide states the historical single-process browser had **less overhead per tab**, but a crash/hang affected the whole app — the reason Chromium moved to one process per tab.

- https://www.electronjs.org/docs/latest/tutorial/process-model

There is **no** Electron or Chromium page that says “reuse one `BrowserWindow` for scraping” or “always spawn one window per job.” What the docs do state:

| Fact | Source |
|---|---|
| One `BrowserWindow` ⇒ one renderer; destroy ⇒ renderer exits | https://www.electronjs.org/docs/latest/tutorial/process-model |
| Extra renderers duplicate JS heaps / caches | https://www.chromium.org/developers/memory-usage-backgrounder/ |
| Closing a tab/window is how Chromium reclaims that memory | https://www.chromium.org/developers/memory-usage-backgrounder/ |
| Hidden / unused tabs are deprioritized (working set hint) | https://www.chromium.org/developers/design-documents/multi-process-architecture/ |

### Hidden windows are still renderers

`show: false` is a documented `BrowserWindow` option. `paintWhenInitiallyHidden` defaults to **true**: the renderer is active even when the window is created hidden. Set it `false` if you need `document.visibilityState` to be hidden on first load (that also prevents `ready-to-show`).

- https://www.electronjs.org/docs/latest/api/browser-window

`webPreferences.backgroundThrottling` defaults to **true**: animations and timers are throttled when the page is backgrounded; this also affects the Page Visibility API.

- https://www.electronjs.org/docs/latest/api/browser-window

`--disable-renderer-backgrounding` “prevents Chromium from lowering the priority of **invisible** pages’ renderer processes.” That switch exists because invisible renderers *are* deprioritized by default.

- https://www.electronjs.org/docs/latest/api/command-line-switches

Implication from those pages only: a hidden `BrowserWindow` still costs a renderer process; it is not free. Keeping many of them alive keeps many heaps alive. Destroying unused windows is the documented way those processes end.

### Official performance checklist (Electron)

Electron’s performance tutorial: measure with Chrome DevTools / Chrome Tracing; do not treat a checklist as exhaustive. Relevant items:

1. **Carelessly including modules** — `require()` of a fat dependency can parse huge JSON at load.
2. **Loading code too soon** — defer expensive `require()`; Windows `require()` is called out as expensive.
3. **Do not block the main process** — it is the UI thread / control tower; prefer async I/O; for CPU work use worker threads, a `BrowserWindow`, or a dedicated process.
4. **Do not block the renderer** — `requestIdleCallback` / Web Workers.
5. **Bundle your code** — “we heavily recommend that you bundle all your code into one single file” so `require()` overhead is paid once. (This is the *main-process* `require()` story; renderer bundling is separate — see §4–5.)

- https://www.electronjs.org/docs/latest/tutorial/performance

### Measuring memory (Electron APIs)

- `app.getAppMetrics()` — array of `ProcessMetric` for **all** processes (Browser, Tab, GPU, Utility, …), each with `memory`.
  - https://www.electronjs.org/docs/latest/api/app
  - https://www.electronjs.org/docs/latest/api/structures/process-metric
- `MemoryInfo`: `workingSetSize`, `peakWorkingSetSize`, `privateBytes` (Windows); values in KB.
  - https://www.electronjs.org/docs/latest/api/structures/memory-info
- `process.getProcessMemoryInfo()` — current process; call after `app` ready. On macOS Chromium does not provide `residentSet`; use `private`.
  - https://www.electronjs.org/docs/latest/api/process
- `process.getBlinkMemoryInfo()` — allocated/total Blink memory (KB), for DOM/render debugging.
  - https://www.electronjs.org/docs/latest/api/process
- `webFrame.getResourceUsage()` / `webFrame.clearCache()` — Blink cache stats; `clearCache` “attempts to free memory that is no longer being used (like images from a previous navigation).” Blindly calling it can make the app slower because caches refill.
  - https://www.electronjs.org/docs/latest/api/web-frame

---

## 2. CDP / `--remote-debugging-port`

### One Chrome instance, many tabs/targets

If Chrome is started with a remote-debugging port, these HTTP endpoints exist on that port:

| Endpoint | Role |
|---|---|
| `GET /json` or `/json/list` | List of **all** inspectable websocket targets (example is an array of `page` targets) |
| `PUT /json/new?{url}` | Opens a **new tab**; returns that tab’s target data |
| `GET /json/activate/{targetId}` | Foregrounds a tab |
| `GET /json/close/{targetId}` | Closes a target |
| `GET /json/version` | Browser metadata + `webSocketDebuggerUrl` (**browser** target, not a page) |
| `WS /devtools/page/{targetId}` | Per-page protocol |

- https://chromedevtools.github.io/devtools-protocol/

CDP **Target** domain: `Target.getTargets` returns `targetInfos`; `Target.createTarget` “creates a new page” (`newWindow` optional; default is a tab, not a new window); `Target.createBrowserContext` is “similar to an incognito profile but you can have more than one”; `Target.setAutoAttach` attaches to related targets (iframes, workers) over one connection.

- https://chromedevtools.github.io/devtools-protocol/tot/Target/

Chrome DevTools for a second local Chrome instance: run it with `--remote-debugging-port=PORT`, then discover targets (including **the tab you want**).

- https://developer.chrome.com/docs/devtools/remote-debugging/local-server

Chrome 63+: **multiple simultaneous protocol clients** on the same tab (Puppeteer + DevTools, two WebSocket clients, multiple `chrome.debugger` extensions).

- https://developer.chrome.com/blog/new-in-devtools-63
- https://chromedevtools.github.io/devtools-protocol/ (FAQ: “Does the protocol support multiple simultaneous clients?”)

Electron can speak CDP without spawning Chrome: `webContents.debugger` is “an alternate transport for Chrome's remote debugging protocol.” `sendCommand` takes an optional `sessionId` from `Target.attachToTarget`.

- https://www.electronjs.org/docs/latest/api/debugger

Electron also documents `--remote-debugging-port=port`: “Enables remote debugging over HTTP on the specified port.”

- https://www.electronjs.org/docs/latest/api/command-line-switches

electron-vite’s `--remoteDebuggingPort` is “used for debugging with IDEs” (dev CLI, not a production packaging feature).

- https://electron-vite.org/guide/cli

### Security warnings (official)

**Chrome 136+ (applies to spawned Google Chrome, not to Electron’s embedded Chromium unless you launch Chrome):** `--remote-debugging-port` and `--remote-debugging-pipe` are **ignored** on the **default** Chrome user-data directory. They must be paired with `--user-data-dir` pointing at a **non-standard** directory. Motive: attackers used remote debugging to steal cookies after App-Bound Encryption. Chrome for Testing keeps the previous behavior for automation.

- https://developer.chrome.com/blog/remote-debugging-port
- https://developer.chrome.com/blog/chrome-for-testing/

Chromium source comment on `--remote-debugging-address`: the server binds loopback by default; the switch overrides that. **“The remote debugging protocol does not perform any authentication, so exposing it too widely can be a security risk.”**

- https://chromium.googlesource.com/chromium/src/+/refs/tags/124.0.6367.172/headless/lib/switches.cc

DevTools docs for connecting to a local CDP port still use `http://localhost:9222/json` (loopback).

- https://developer.chrome.com/docs/devtools/remote-debugging/

Electron `--inspect` / Node inspector defaults to `127.0.0.1:9229` (separate from Chromium remote debugging).

- https://www.electronjs.org/docs/latest/api/command-line-switches
- https://www.electronjs.org/docs/latest/tutorial/debugging-main-process

---

## 3. electron-builder 26: `files`, `asarUnpack`, native modules

electron-builder **26** still uses top-level `asarUnpack`. **v27** nests it as `asar.unpack` and removes the flat key. This note is for v26.

- https://www.electron.build/docs/migration/v27-breaking-changes/
- https://www.electron.build/docs/contents

### What gets packed

Default include: `**/*` from the app directory, minus a fixed ignore list. **Always applied**, even with custom `files`:

- **devDependencies are never copied**
- `node_modules` test/example dirs, `*.d.ts`, `node_modules/.bin`
- `!**/*.{iml,o,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,xproj}` — note **`.o` is ignored; `.c` is not**
- VCS/tooling metadata, lockfiles, etc.

`package.json` and `**/node_modules/**/*` (**production deps only**) are **always** added to custom `files` patterns.

If any include pattern does **not** start with `!`, default `**/*` is **not** prepended — you must add it yourself.

- https://www.electron.build/docs/contents

To drop unused bulk: extra `!` globs (`!node_modules/**/*.md`, `!**/*.map`, `!src/**`, `!**/*.ts`). Debug with `DEBUG=electron-builder`.

- https://www.electron.build/docs/contents
- https://www.electron.build/docs/troubleshooting/

### ASAR and native addons

ASAR is on by default. Native `.node` files, executables, and some large binaries cannot live *inside* the archive. Electron documents that `process.dlopen` (used by `require` of native modules) unpacks to a temp file if the `.node` is inside ASAR; `--unpack *.node` leaves them in `app.asar.unpacked`.

- https://www.electronjs.org/docs/latest/tutorial/asar-archives

electron-builder:

- `smartUnpack` default **true** — auto-detects executables/native modules.
- “Node modules that must be unpacked will be detected automatically, you don’t need to explicitly set `asarUnpack` — please file an issue if this doesn’t work.”
- If a native module still crashes (“Module did not self-register”) or works in dev but not packaged, unpack the tree:

```yaml
asarUnpack:
  - "node_modules/better-sqlite3/**"
  - "node_modules/your-module/**"
  - "**/*.node"
```

- https://www.electron.build/docs/contents
- https://www.electron.build/docs/troubleshooting/

### Rebuild ABI

Electron’s ABI ≠ Node’s. Native modules must be rebuilt for Electron or you get `NODE_MODULE_VERSION` mismatch. Official paths: `@electron/rebuild`, npm env vars (`npm_config_runtime=electron`, Electron headers URL), or `node-gyp rebuild --target=… --dist-url=https://electronjs.org/headers`.

- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules

electron-builder: add `"postinstall": "electron-builder install-app-deps"` so native deps match the Electron version. It rebuilds natives for the target Electron during the package build.

- https://www.electron.build/docs/
- https://www.electron.build/docs/troubleshooting/

**keytar** is a native addon (Keychain / Secret Service / Credential Vault) with **prebuilt binaries for actively supported Node and Electron versions**.

- https://www.npmjs.com/package/keytar
- https://github.com/atom/node-keytar/blob/master/README.md

**better-sqlite3** is a native addon (`prebuild-install || node-gyp rebuild`). It vendors the SQLite amalgamation; custom builds require `sqlite3.c` and `sqlite3.h` in the amalgamation directory.

- https://www.npmjs.com/package/better-sqlite3
- https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md
- https://www.sqlite.org/amalgamation.html

Published npm `files` for better-sqlite3 include `"deps/**"`, which is the amalgamation tree (including `deps/sqlite3/sqlite3.c`). electron-builder’s default ignore list does **not** exclude `.c` sources. There is no first-party electron-builder rule named “strip sqlite3.c”; exclusion is a `files` glob you add, e.g. `!**/node_modules/better-sqlite3/deps/**` (keep the built `.node`; do not delete sources you still need to *compile*).

- https://www.electron.build/docs/contents (default ignore list; `files` negation)
- better-sqlite3 `package.json` `"files"`: https://github.com/WiseLibs/better-sqlite3/blob/master/package.json

electron-vite: Node addons **cannot** be fully bundled; keep them external via `build.rollupOptions.external` (example in their docs is `sqlite3`).

- https://electron-vite.org/guide/dependency-handling

---

## 4. electron-vite / Vite code-splitting in the renderer

### What electron-vite actually documents

Production: run `electron-vite build` first. Default output `out/{main,preload,renderer}`. “Place all bundled code in a single directory … easier to exclude source code when packaging … reducing the package size.”

Chunking: `build.rollupOptions.output.manualChunks` (Rollup). “An effective chunking strategy is crucial for optimizing the performance of an Electron app.”

- https://electron-vite.org/guide/build.html

Renderer `build.target` is `chrome*` matching the Electron Chromium (not a generic browserslist). `build.modulePreload.polyfill` is **false** — “no need to polyfill Module Preload for the Electron renderers.”

- https://electron-vite.org/config/

Multi-window apps: multiple HTML / preload **entries** via `build.rollupOptions.input` (not `React.lazy`).

- https://electron-vite.org/guide/dev.html

Packaged renderer routing: Electron “does not manage browser history”; **only a hash router works properly in production**. For `react-router-dom`, use `HashRouter` not `BrowserRouter`. You can pass `{ hash: 'home' }` to `BrowserWindow.loadFile`.

- https://electron-vite.org/guide/troubleshooting

Renderer must not use Node APIs; electron-vite **does not support `nodeIntegration`**. Load npm packages into the renderer with a bundler.

- https://electron-vite.org/guide/dev.html
- https://www.electronjs.org/docs/latest/tutorial/process-model
- https://www.electronjs.org/docs/latest/tutorial/esm (renderer uses Chromium’s ESM loader; `import` of `node:fs` in a page script will not work; “use a bundler such as webpack or Vite”)

### Vite + `React.lazy`

Vite production builds emit native ESM + **dynamic `import()`**. Glob imports are lazy-loaded and split into chunks unless `{ eager: true }`. CSS for an async chunk is extracted and loaded before the chunk runs.

- https://vitejs.dev/guide/features.html
- https://vitejs.dev/guide/build.html

`React.lazy(() => import('./X'))` requires a dynamic `import()` that resolves to a **default** export; wrap in `<Suspense>`. React does not mention Electron; the pattern is the web one. Declare `lazy()` at module top level, not inside a component.

- https://react.dev/reference/react/lazy

That is the official composition: **Vite splits on `import()`; React.lazy is the React API that consumes those splits.** electron-vite does not add a separate `React.lazy` recipe; it exposes Rollup `manualChunks` and treats the renderer as a Vite app with `chrome*` target.

Relative asset URLs: Vite `"base": "./"` (or `""`) makes generated URLs relative to each file — relevant when the renderer is loaded from `file:` rather than `http://`.

- https://vitejs.dev/guide/build.html

electron-vite’s own example of loading packaged HTML uses `loadFile` + hash, not `file:///` with an absolute web `base`.

- https://electron-vite.org/guide/troubleshooting

---

## 5. Should production apps ship `react` / `react-dom` in `node_modules`?

**No extra copy is required for the renderer if Vite already bundled them.** Official split:

| Process | electron-vite default | Why |
|---|---|---|
| Main & preload | `dependencies` are **external** (not bundled) | “These dependencies will still be included when packaging the app (for example, via electron-builder).” |
| Renderer | `dependencies` are **bundled** | “Bundling dependencies reduces the number of chunks, which helps maintain fast renderer performance.” |

**“Dependencies used in the renderer process should preferably be installed as `devDependencies` to help keep the final package size smaller.”**

Packaging tools **exclude `devDependencies`**.

- https://electron-vite.org/guide/dependency-handling
- https://www.electron.build/docs/contents
- https://electron-vite.org/guide/troubleshooting (“Cannot find module” after pack: if it’s needed at runtime *unbundled*, it must be in `dependencies`)

Vite **library** mode is the opposite: you *externalize* `react` so consumers provide it. An Electron **app** renderer is not library mode.

- https://vitejs.dev/guide/build.html

If `react` / `react-dom` stay in `dependencies`, electron-builder will still copy `node_modules/react/**` even though the renderer bundle already inlines them — duplicate weight, unused at runtime for the UI. Native addons (`better-sqlite3`, `keytar`) must remain **production** `dependencies` and **external**; they cannot be Vite-bundled.

- https://electron-vite.org/guide/dependency-handling
- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules

---

## 6. electron-store v11 vs a custom JSON file

electron-store is a third-party module (sindresorhus), not an Electron API. Electron has **no** built-in settings store; the module writes JSON under `app.getPath('userData')` (file name default `config.json`).

- https://www.npmjs.com/package/electron-store
- https://www.electronjs.org/docs/latest/api/app#appgetpathname (path API referenced by that README)

### v11 notes from the package README (v11.0.2)

- **Requires Electron 30 or later.**
- **Native ESM only** — no CommonJS export. CJS apps must convert. Points at Electron’s ESM tutorial.
- Writes are atomic (crash during write should not corrupt the existing file).
- **Not a database.** “It simply uses a JSON file that is read/written on every change. Prefer using it for smaller amounts of data like user settings, value caching, state, etc.” Large blobs: write a file yourself; store the path.
- `Store.size` is **item count**, not byte size of the file.

- https://www.npmjs.com/package/electron-store
- https://www.electronjs.org/docs/latest/tutorial/esm

Electron ESM (main): ESM is async; use `await` before `app` `ready` for APIs that must run first. Dynamic `import()` of setup code can lose the race with `ready`.

- https://www.electronjs.org/docs/latest/tutorial/esm

electron-vite: ESM in Electron from Electron 28 / electron-vite 2; `"type": "module"` or `output.format: 'es'`. Source-code protection currently **CJS-only**.

- https://electron-vite.org/guide/dev.html

A custom JSON file in `userData` is the same persistence model electron-store documents (JSON on disk). electron-store adds schema (ajv), atomic write, optional `encryptionKey` (**“not intended for security”** — key is inside the app), migrations (explicitly unsupported by the maintainer), and renderer IPC (`Store.initRenderer()`). None of those are Electron platform features.

---

## Cross-cutting facts for this app shape

1. **N hidden `BrowserWindow`s ⇒ N renderer processes** until destroyed. Hidden ≠ no process. Throttling is default; it is not the same as teardown.
   - https://www.electronjs.org/docs/latest/tutorial/process-model
   - https://www.electronjs.org/docs/latest/api/browser-window

2. **One Chrome + `--remote-debugging-port` can host many tabs** (`/json/list`, `Target.createTarget`). Chrome 136+ requires a **non-default** `--user-data-dir`. The protocol has **no authentication**.
   - https://chromedevtools.github.io/devtools-protocol/
   - https://developer.chrome.com/blog/remote-debugging-port

3. **electron-builder 26** always ships production `node_modules`; put renderer-only libs in `devDependencies` if Vite bundled them. Unpack native addons; rebuild with `install-app-deps`. Default ignores do not strip `better-sqlite3`’s `deps/sqlite3.c`.
   - https://www.electron.build/docs/contents
   - https://electron-vite.org/guide/dependency-handling

4. **`React.lazy` + `import()`** is the documented Vite/React split. electron-vite adds `manualChunks` and requires `HashRouter` for packaged `loadFile`.
   - https://react.dev/reference/react/lazy
   - https://vitejs.dev/guide/features.html
   - https://electron-vite.org/guide/troubleshooting
)
