import { app, screen } from 'electron'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { join, resolve, sep } from 'path'
import { spawn, execSync } from 'child_process'
import type { Readable, Writable } from 'stream'
import { installWebAuthnBlockerWithCdp } from './browserPromptGuards'

interface SignInWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Centered sign-in window bounds on the user's primary display, falling back to
 * a sane default if Electron's screen API isn't ready yet (e.g. before app.whenReady).
 * Chrome's saved profile state can pin a window offscreen at -32000,-32000 from
 * earlier scraping launches; we override it with explicit CLI flags AND a CDP
 * Browser.setWindowBounds call after the page attaches.
 */
function computeCenteredSignInBounds(): SignInWindowBounds {
  const width = 1280
  const height = 900
  try {
    const display = screen.getPrimaryDisplay()
    const work = display.workArea
    const x = Math.max(work.x, work.x + Math.floor((work.width - width) / 2))
    const y = Math.max(work.y, work.y + Math.floor((work.height - height) / 2))
    return { x, y, width, height }
  } catch {
    return { x: 100, y: 100, width, height }
  }
}

export interface ManagedChromeConfig {
  serviceId: string
  port: number
  startUrl: string
  /**
   * URL substring (or pipe-separated alternatives) that indicates the user has
   * finished signing in and landed on the dashboard. Used by waitForLoginComplete.
   * If omitted, defaults to '/settings/' for backward compatibility with Claude.
   * Examples: '/settings/', '/codex/settings/', '/user-center', '/dashboard'
   */
  loggedInUrlPattern?: string
  /**
   * Optional in-page probe evaluated during waitForLoginComplete, only AFTER a
   * candidate target already passed the title-based check. Needed for services
   * whose URL and title are identical signed-out and signed-in (kimi.com quota
   * page, grok.com root), where the title heuristic alone declares "login
   * complete" the moment the window opens. Evaluated via Runtime.evaluate with
   * awaitPromise, so an async IIFE is allowed. CONTRACT: the expression must
   * never throw and must settle to a boolean within a few seconds (self-bound
   * any fetch with AbortSignal.timeout). Services that omit this keep the
   * existing title-only behavior unchanged.
   */
  loginCompleteExpression?: string
}

interface ChromeTargetInfo {
  id: string
  url: string
  title: string
  webSocketDebuggerUrl?: string
  type?: string
}

interface ChromeVersionInfo {
  webSocketDebuggerUrl?: string
}

interface EvaluationResult<T> {
  url: string
  title: string
  value: T | null
  capturedResponses?: { url: string; body: string }[]
}

interface ManagedChromeEvaluateOptions {
  timeoutMs?: number
  allowLaunch?: boolean
  allowTargetOpen?: boolean
  allowNavigate?: boolean
  /** Reload the tab even when it is already on `url`, so a stale SPA snapshot is not scraped. */
  forceReload?: boolean
  /** Capture Network response bodies whose URL contains one of these substrings (case-insensitive). */
  captureUrlIncludes?: string[]
}

interface ManagedPipeBrowser {
  child: any
  client: CDPClient
  exited: boolean
}

const managedPipeBrowsers = new Map<string, ManagedPipeBrowser>()

// Port-mode fallback instances (launchChromePort). These were never tracked, so
// closeAllManagedChrome() could not see them and every pipe-launch failure left a
// Chrome running past app quit. Keyed by serviceId; `port` is kept because
// closeManagedChrome()'s non-pipe path needs the REAL port to reach the debugger.
interface ManagedPortBrowser {
  child: any
  port: number
}
const managedPortBrowsers = new Map<string, ManagedPortBrowser>()

// ─── Managed Chrome lifecycle guards ─────────────────────────
// (1) Launch gate: background polls set per-service permission to cold-launch
//     a managed Chrome. User-triggered fetches pass force=true and are always
//     allowed. Undefined entry = allowed (safe default for direct/user paths).
// (2) Idle timeout: a pipe-mode Chrome holds 200-500MB; close a service's
//     instance after 30 minutes without scrape activity. ensureChrome()
//     re-launches on demand when the next scrape is allowed to launch.

const managedChromeLaunchAllowed = new Map<string, boolean>()

/** Max simultaneous Chrome *spawns* (Refresh All is 2-wide; scrapes reuse after launch). */
const MAX_CONCURRENT_CHROME_LAUNCHES = 2
let activeChromeLaunches = 0
const chromeLaunchQueue: Array<() => void> = []

async function acquireChromeLaunchSlot(serviceId: string): Promise<void> {
  if (activeChromeLaunches < MAX_CONCURRENT_CHROME_LAUNCHES) {
    activeChromeLaunches++
    return
  }
  console.log(
    `[managedChrome:${serviceId}] Waiting for Chrome launch slot ` +
    `(${activeChromeLaunches} launching, ${chromeLaunchQueue.length} queued)`
  )
  await new Promise<void>((resolve) => {
    chromeLaunchQueue.push(resolve)
  })
  console.log(`[managedChrome:${serviceId}] Acquired queued Chrome launch slot`)
}

function releaseChromeLaunchSlot(): void {
  activeChromeLaunches = Math.max(0, activeChromeLaunches - 1)
  const next = chromeLaunchQueue.shift()
  if (!next) return
  activeChromeLaunches++
  next()
}

/**
 * Set by usageFetcher before each scrape: whether a scrape for this service
 * may cold-launch a managed Chrome when none is running. Reconnect/openLogin
 * paths do not consult this gate (they launch via openManagedChromeWindow).
 */
export function setManagedChromeLaunchAllowed(serviceId: string, allowed: boolean): void {
  managedChromeLaunchAllowed.set(serviceId, allowed)
}

function isManagedChromeLaunchAllowed(serviceId: string): boolean {
  return managedChromeLaunchAllowed.get(serviceId) ?? true
}

const MANAGED_CHROME_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const MANAGED_CHROME_HIDDEN_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MANAGED_CHROME_IDLE_CHECK_MS = 5 * 60 * 1000
const managedChromeLastActivity = new Map<string, number>()
let managedChromeIdleTimer: NodeJS.Timeout | null = null
let appInForeground = true

export function setManagedChromeAppForeground(visible: boolean): void {
  const wasVisible = appInForeground
  appInForeground = visible
  if (wasVisible && !visible) {
    void closeIdleManagedChromes()
  }
}

function currentIdleTimeoutMs(): number {
  return appInForeground ? MANAGED_CHROME_IDLE_TIMEOUT_MS : MANAGED_CHROME_HIDDEN_IDLE_TIMEOUT_MS
}

function touchManagedChromeActivity(serviceId: string): void {
  managedChromeLastActivity.set(serviceId, Date.now())
}

function ensureManagedChromeIdleTimer(): void {
  if (managedChromeIdleTimer) return
  managedChromeIdleTimer = setInterval(() => {
    void closeIdleManagedChromes()
  }, MANAGED_CHROME_IDLE_CHECK_MS)
  // Never keep the app alive just for this timer.
  managedChromeIdleTimer.unref?.()
}

async function closeIdleManagedChromes(): Promise<void> {
  const now = Date.now()
  // Cover BOTH pipe and port maps — port-fallback instances used to skip idle close
  // and could sit resident until app quit.
  const serviceIds = new Set<string>([
    ...managedPipeBrowsers.keys(),
    ...managedPortBrowsers.keys()
  ])

  for (const serviceId of serviceIds) {
    const pipe = managedPipeBrowsers.get(serviceId)
    if (pipe?.exited) continue
    const lastActivity = managedChromeLastActivity.get(serviceId) ?? 0
    if (now - lastActivity < currentIdleTimeoutMs()) continue

    const portEntry = managedPortBrowsers.get(serviceId)
    console.log(
      `[managedChrome:${serviceId}] Idle for ${Math.round((now - lastActivity) / 60000)}m — ` +
      `closing managed Chrome (${pipe ? 'pipe' : portEntry ? `port ${portEntry.port}` : 'unknown'}) ` +
      `to free memory (relaunches on demand)`
    )
    try {
      await closeManagedChrome({
        serviceId,
        port: portEntry?.port ?? 0,
        startUrl: ''
      })
    } catch (err) {
      console.warn(`[managedChrome:${serviceId}] Idle close failed:`, err)
    }
  }
}

function getActivePipeBrowser(config: ManagedChromeConfig): ManagedPipeBrowser | null {
  const browser = managedPipeBrowsers.get(config.serviceId)
  if (!browser || browser.exited) return null
  return browser
}

function getChromeExecutable(): string {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error('Google Chrome was not found on this system.')
}

function getManagedProfileDir(serviceId: string): string {
  const dir = join(app.getPath('userData'), 'managed-chrome', serviceId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function getManagedProfileBaseDir(): string {
  const dir = join(app.getPath('userData'), 'managed-chrome')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return await response.json() as T
  } catch {
    return null
  }
}

async function getBrowserWebSocketUrl(port: number): Promise<string | null> {
  const version = await fetchJson<ChromeVersionInfo>(`http://127.0.0.1:${port}/json/version`)
  return version?.webSocketDebuggerUrl ?? null
}

async function isDebuggerReady(port: number): Promise<boolean> {
  return (await getBrowserWebSocketUrl(port)) != null
}

async function waitForDebugger(port: number, timeoutMs = 15000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isDebuggerReady(port)) return
    await sleep(250)
  }
  throw new Error(`Chrome debugger on port ${port} did not start within ${timeoutMs}ms`)
}

function getCommonChromeArgs(profileDir: string): string[] {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    // Anti-automation flags. Without these, Chrome launched with
    // --remote-debugging-pipe (or --remote-debugging-port) sets
    // `navigator.webdriver = true` and shows the "Chrome is being controlled by
    // automated test software" infobar. Cloudflare reads navigator.webdriver as
    // a hard automation signal and refuses to auto-resolve its challenge.
    '--disable-blink-features=AutomationControlled',
    // The offscreen (-32000,-32000) window counts as occluded/backgrounded, so
    // Chrome throttles its timers and rendering — SPAs (kimi.com especially)
    // then take 30s+ to hydrate their data and scrapes race the fetch budget.
    // These flags keep offscreen pages running at full speed.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    // OptimizationGuideOnDeviceModel + OptimizationGuideModelExecution gate Chrome's
    // on-device foundational LLM (Gemini Nano). With them enabled, Chrome's
    // optimization guide silently downloads a ~4GB `weights.bin` into each managed
    // profile's `OptGuideOnDeviceModel/` folder. 4GB was found in managed-chrome/claude
    // (downloaded 2026-07-11). NOTE: --disable-component-update alone does NOT stop this
    // download, and the older OptimizationGuideModelDownloading/OptimizationHintsFetching
    // flags only cover the tiny hints/prediction models, not the multi-GB on-device model.
    '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,AutofillServerCommunication,OptimizationGuideOnDeviceModel,OptimizationGuideModelExecution',
    '--disable-sync',
    '--disk-cache-size=52428800',
    '--media-cache-size=10485760',
    `--user-data-dir=${profileDir}`
  ]
}

function addChromeWindowArgs(
  args: string[],
  url: string,
  visible: boolean,
  bounds?: SignInWindowBounds
): void {
  if (visible) {
    // Explicit position/size flags override any saved profile state — without
    // them Chrome can re-use the offscreen (-32000,-32000) bounds left over
    // from a previous scraping launch on the same user-data-dir.
    if (bounds) {
      args.push(
        `--window-position=${bounds.x},${bounds.y}`,
        `--window-size=${bounds.width},${bounds.height}`
      )
    }
    args.push('--new-window', url)
    return
  }

  args.push(
    '--window-position=-32000,-32000',
    '--window-size=1920,1080',
    '--disable-extensions',
    '--disable-popup-blocking',
    url
  )
}

async function launchChromePort(
  config: ManagedChromeConfig,
  url: string,
  visible: boolean,
  bounds?: SignInWindowBounds
): Promise<void> {
  const chromePath = getChromeExecutable()
  const profileDir = getManagedProfileDir(config.serviceId)

  const args = [
    `--remote-debugging-port=${config.port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    ...getCommonChromeArgs(profileDir)
  ]

  if (visible) {
    if (bounds) {
      args.push(
        `--window-position=${bounds.x},${bounds.y}`,
        `--window-size=${bounds.width},${bounds.height}`
      )
    }
    args.push('--new-window', url)
  } else {
    // Offscreen headed Chrome: a real browser window positioned far off-screen.
    // Unlike --headless=new, this passes Cloudflare detection because it's a
    // fully-rendered headed browser — not a headless one.
    args.push(
      '--window-position=-32000,-32000',
      '--window-size=1920,1080',
      '--disable-extensions',
      '--disable-popup-blocking',
      url
    )
  }

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: !visible
  })
  child.unref()

  console.log(`[managedChrome:${config.serviceId}] Spawned Chrome (port mode) — pid=${child.pid}, port=${config.port}, visible=${visible}${bounds ? ` at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : ''}`)

  try {
    await waitForDebugger(config.port)
  } catch (err) {
    // Same orphan class as the pipe path: detached + unref'd and never tracked.
    killOrphanedChrome(config.serviceId, child, `debugger never came up on port ${config.port}`)
    throw new Error(
      `[managedChrome:${config.serviceId}] Chrome on port ${config.port} did not become ready: ${(err as any)?.message || err}`
    )
  }

  const portBrowser: ManagedPortBrowser = { child, port: config.port }
  managedPortBrowsers.set(config.serviceId, portBrowser)
  touchManagedChromeActivity(config.serviceId)
  ensureManagedChromeIdleTimer()

  child.once('exit', () => {
    if (managedPortBrowsers.get(config.serviceId) === portBrowser) {
      managedPortBrowsers.delete(config.serviceId)
    }
  })
}

async function launchChromePipe(
  config: ManagedChromeConfig,
  url: string,
  visible: boolean,
  bounds?: SignInWindowBounds
): Promise<void> {
  const chromePath = getChromeExecutable()
  const profileDir = getManagedProfileDir(config.serviceId)
  const args = [
    '--remote-debugging-pipe',
    ...getCommonChromeArgs(profileDir)
  ]

  addChromeWindowArgs(args, url, visible, bounds)

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    windowsHide: !visible
  })

  console.log(`[managedChrome:${config.serviceId}] Spawned Chrome (pipe mode) — pid=${child.pid}, visible=${visible}${bounds ? ` at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : ''}`)

  // Everything between the spawn above and the map registration below can throw
  // (missing CDP streams, connectPipe, Browser.getVersion). The child is detached
  // and about to be unref'd, so an untracked throw leaks a Chrome that NOTHING can
  // ever close — and ensureChrome() then falls back to launchChromePort(), putting a
  // SECOND Chrome on the same profile. Kill it on the way out instead.
  try {
    const write = child.stdio?.[3] as Writable | undefined
    const read = child.stdio?.[4] as Readable | undefined
    if (!read || !write) {
      throw new Error(`[managedChrome:${config.serviceId}] Chrome pipe transport did not expose CDP streams (pid=${child.pid})`)
    }

    const client = new CDPClient()
    await client.connectPipe(read, write)
    client.markPersistent()
    await client.send('Browser.getVersion')

    const browser: ManagedPipeBrowser = { child, client, exited: false }
    managedPipeBrowsers.set(config.serviceId, browser)
    touchManagedChromeActivity(config.serviceId)
    ensureManagedChromeIdleTimer()

    child.once('exit', () => {
      browser.exited = true
      client.forceClose()
      if (managedPipeBrowsers.get(config.serviceId) === browser) {
        managedPipeBrowsers.delete(config.serviceId)
      }
    })

    child.unref()
  } catch (err) {
    killOrphanedChrome(config.serviceId, child, 'pipe init failed')
    throw err
  }
}

/**
 * Force-kill a Chrome process by PID only (never image-wide).
 * Soft child.kill() is not enough on Windows — Chrome is a process tree and
 * often keeps the profile lock after a polite SIGTERM-equivalent.
 */
function forceKillChromeByPid(serviceId: string, pid: number | undefined, reason: string): void {
  if (pid == null || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      // /T = kill the process tree rooted at this PID (GPU/renderer children).
      // Still PID-scoped — never /IM chrome.exe (would hit the user's browser).
      execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: 'pipe' })
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    console.warn(`[managedChrome:${serviceId}] Force-killed Chrome pid=${pid} (${reason})`)
  } catch (err) {
    console.warn(
      `[managedChrome:${serviceId}] Force-kill failed for pid=${pid} (${reason}):`,
      (err as Error)?.message || err
    )
  }
}

/**
 * Reap a Chrome we spawned but never managed to track. Spawns are `detached` +
 * `unref()`ed, so anything we do not put in a map outlives this process forever.
 */
function killOrphanedChrome(serviceId: string, child: any, reason: string): void {
  const pid = child?.pid as number | undefined
  try {
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill()
      } catch {
        // fall through to force kill
      }
    }
  } catch (err) {
    console.warn(`[managedChrome:${serviceId}] Soft kill failed pid=${pid}:`, err)
  }
  // Always escalate — soft kill alone is how pipe-mode zombies survive.
  forceKillChromeByPid(serviceId, pid, reason)
}

/**
 * Kill every chrome.exe whose command line targets our managed profile tree
 * and is not currently tracked in this process's maps. Call at startup (maps
 * empty) and never touch the user's personal Chrome profile.
 *
 * @returns number of PIDs we attempted to kill
 */
export function reapOrphanManagedChromes(serviceId?: string): number {
  // Never kill the live session. Child GPU/renderer processes share
  // user-data-dir=.../managed-chrome/<id> and used to match the orphan
  // needle — that murdered Chrome mid-scrape and stamped a good Qwen
  // row stale ("CDP Page.enable timed out").
  if (
    serviceId &&
    (managedPipeBrowsers.has(serviceId) || managedPortBrowsers.has(serviceId))
  ) {
    return 0
  }

  const livePids = new Set<number>()
  for (const browser of managedPipeBrowsers.values()) {
    if (browser.child?.pid) livePids.add(browser.child.pid as number)
  }
  for (const browser of managedPortBrowsers.values()) {
    if (browser.child?.pid) livePids.add(browser.child.pid as number)
  }

  if (process.platform !== 'win32') {
    // Non-Windows: no portable CIM query; live maps + closeAll handle tracked ones.
    return 0
  }

  try {
    // Avoid Win32 Filter quoting pitfalls under nested shells: enumerate, then match
    // agent-stats managed-chrome profiles only (never the user's personal Chrome).
    // Use -EncodedCommand so nested quote escaping cannot break the CIM query.
    const serviceNeedle = serviceId
      ? `managed-chrome[\\\\/]+${serviceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      : 'agent-stats[\\\\/]+managed-chrome'
    const psScript =
      "$ErrorActionPreference='SilentlyContinue'; " +
      "Get-CimInstance Win32_Process | " +
      `Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '${serviceNeedle}' } | ` +
      "ForEach-Object { $_.ProcessId }"
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
    const out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000
    })
    // Strip PowerShell CLIXML progress noise; only bare integer lines are PIDs.
    const pids = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => parseInt(line, 10))
      .filter((n) => Number.isFinite(n) && n > 0)

    let killed = 0
    for (const pid of pids) {
      if (livePids.has(pid)) continue
      forceKillChromeByPid(serviceId ?? 'orphan-reaper', pid, serviceId ? `unlock ${serviceId} profile` : 'startup/orphan scan')
      killed++
    }
    return killed
  } catch (err) {
    console.warn('[managedChrome] Orphan reap scan failed:', (err as Error)?.message || err)
    return 0
  }
}

async function ensureChrome(
  config: ManagedChromeConfig,
  url: string,
  visible: boolean,
  allowLaunch = true
): Promise<boolean> {
  // Already running: reuse the tracked instance. Do NOT spawn a second Chrome
  // on the same user-data-dir (legacy dual-spawn left zombies + profile locks).
  // Callers navigate via CDP evaluate paths.
  if (getActivePipeBrowser(config)) {
    touchManagedChromeActivity(config.serviceId)
    return true
  }

  if (await isDebuggerReady(config.port)) {
    touchManagedChromeActivity(config.serviceId)
    // Ensure port-mode child is in our map if an external attach found the port.
    // (We cannot invent a child handle for a foreign process — only tracked ones.)
    return true
  }

  if (!allowLaunch || !isManagedChromeLaunchAllowed(config.serviceId)) {
    if (allowLaunch && !isManagedChromeLaunchAllowed(config.serviceId)) {
      console.log(
        `[managedChrome:${config.serviceId}] Cold launch not allowed for this background fetch ` +
        `(service has no prior success) — skipping`
      )
    }
    return false
  }

  await acquireChromeLaunchSlot(config.serviceId)
  try {
    const unlocked = reapOrphanManagedChromes(config.serviceId)
    if (unlocked > 0) {
      console.log(`[managedChrome:${config.serviceId}] Killed ${unlocked} orphan Chrome(s) holding the profile`)
      await sleep(400)
    }
    try {
      await launchChromePipe(config, url, visible)
      return true
    } catch (err) {
      console.warn(`[managedChrome:${config.serviceId}] Pipe launch failed, falling back to localhost CDP:`, err)
    }

    await launchChromePort(config, url, visible)
    return true
  } finally {
    releaseChromeLaunchSlot()
  }
}

async function listTargets(config: ManagedChromeConfig): Promise<ChromeTargetInfo[]> {
  const pipeBrowser = getActivePipeBrowser(config)
  if (pipeBrowser) {
    try {
      const result = await pipeBrowser.client.send<{ targetInfos: any[] }>('Target.getTargets')
      // CDP Target.getTargets returns `targetId`, the HTTP /json/list endpoint
      // returns `id`. Normalize so callers can read `target.id` either way —
      // without this, Target.attachToTarget gets undefined and Chrome rejects
      // the call with code -32602 (Invalid parameters).
      return (result?.targetInfos || []).map((t) => ({
        id: t.id || t.targetId,
        url: t.url,
        title: t.title,
        type: t.type,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
      }))
    } catch (err) {
      console.warn(`[managedChrome:${config.serviceId}] Failed to list pipe targets:`, err)
      return []
    }
  }

  return await fetchJson<ChromeTargetInfo[]>(`http://127.0.0.1:${config.port}/json/list`) || []
}

function isMatchingTarget(target: ChromeTargetInfo, url: string): boolean {
  return target.type === 'page' && (
    target.url.startsWith(url) ||
    target.url.includes(new URL(url).hostname)
  )
}

function isBlankPageTarget(target: ChromeTargetInfo): boolean {
  return target.type === 'page' && (
    target.url === '' ||
    target.url === 'about:blank' ||
    target.url === 'chrome://newtab/'
  )
}

async function ensureTarget(
  config: ManagedChromeConfig,
  url: string,
  allowOpen = true
): Promise<ChromeTargetInfo | null> {
  let targets = await listTargets(config)

  // First, try to find a target with EXACT URL match
  const exactTarget = targets.find((item) =>
    item.type === 'page' &&
    item.url.toLowerCase() === url.toLowerCase()
  )
  if (exactTarget) return exactTarget

  // Second, try to find a target that STARTS with the URL (for SPA navigation)
  const startTarget = targets.find((item) =>
    item.type === 'page' &&
    item.url.toLowerCase().startsWith(url.toLowerCase().split('?')[0])
  )
  if (startTarget) return startTarget

  // Third, try generic matching (hostname match)
  let target = targets.find((item) => isMatchingTarget(item, url))
  if (target) return target

  // Fourth, fallback to any page target (better than nothing)
  const fallbackTarget = targets.find((item) => item.type === 'page')
  if (fallbackTarget) {
    console.log(`[managedChrome:${config.serviceId}] No dashboard tab found, using fallback: ${fallbackTarget.url}`)
    return fallbackTarget
  }

  if (allowOpen) {
    const browserClient = await createBrowserClient(config)
    if (!browserClient) return null
    try {
      const created = await browserClient.send<{ targetId: string }>('Target.createTarget', { url })
      await sleep(500)
      const refreshed = await listTargets(config)
      return refreshed.find((item) => item.id === created.targetId) ||
        refreshed.find((item) => item.type === 'page') ||
        null
    } catch {
      return null
    } finally {
      browserClient.close()
    }
  }

  return null
}

async function installWebAuthnBlockerInPage(
  client: CDPPageClient,
  label: string
): Promise<void> {
  await installWebAuthnBlockerWithCdp(
    (method, params) => client.send(method, params),
    label
  )
}

class CDPClient {
  private ws: any
  private pipeRead: Readable | null = null
  private pipeWrite: Writable | null = null
  private pipeBuffer = ''
  private persistent = false
  private closed = false
  private id = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string; timer: NodeJS.Timeout }>()
  private eventListeners = new Map<string, Array<(params: any) => void>>()

  markPersistent(): void {
    this.persistent = true
  }

  on(method: string, handler: (params: any) => void, sessionId?: string | null): void {
    const key = this.listenerKey(method, sessionId)
    if (!this.eventListeners.has(key)) this.eventListeners.set(key, [])
    this.eventListeners.get(key)!.push(handler)
  }

  off(method: string, handler: (params: any) => void, sessionId?: string | null): void {
    const handlers = this.eventListeners.get(this.listenerKey(method, sessionId))
    if (handlers) {
      const idx = handlers.indexOf(handler)
      if (idx >= 0) handlers.splice(idx, 1)
    }
  }

  private listenerKey(method: string, sessionId?: string | null): string {
    return `${sessionId || ''}:${method}`
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private handlePayload(payload: any): void {
    if (payload.id && this.pending.has(payload.id)) {
      const request = this.pending.get(payload.id)!
      this.pending.delete(payload.id)
      clearTimeout(request.timer)
      if (payload.error) {
        const baseMsg = payload.error.message || 'CDP command failed'
        const errCode = payload.error.code != null ? ` (code ${payload.error.code})` : ''
        request.reject(new Error(`CDP ${request.method}: ${baseMsg}${errCode}`))
      } else {
        request.resolve(payload.result)
      }
      return
    }

    if (payload.method) {
      const keys = [
        this.listenerKey(payload.method, payload.sessionId),
        this.listenerKey(payload.method, null)
      ]
      for (const key of keys) {
        const handlers = this.eventListeners.get(key)
        if (handlers) {
          for (const handler of handlers) handler(payload.params)
        }
      }
    }
  }

  async connect(webSocketUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const WebSocketImpl = (globalThis as any).WebSocket
      if (!WebSocketImpl) {
        reject(new Error('WebSocket is not available in this runtime'))
        return
      }

      const ws: any = new WebSocketImpl(webSocketUrl)
      this.ws = ws

      ws.onopen = () => resolve()
      ws.onerror = (event: any) => reject(new Error(`WebSocket error: ${String(event?.message || 'unknown')}`))
      ws.onmessage = (event: any) => {
        try {
          const payload = JSON.parse(String(event.data))
          this.handlePayload(payload)
        } catch (err) {
          reject(err as Error)
        }
      }
      ws.onclose = () => {
        this.rejectPending(new Error('Chrome DevTools connection closed'))
      }
    })
  }

  async connectPipe(read: Readable, write: Writable): Promise<void> {
    this.pipeRead = read
    this.pipeWrite = write

    read.on('data', (chunk: Buffer) => {
      this.pipeBuffer += chunk.toString('utf8')
      let idx = this.pipeBuffer.indexOf('\0')
      while (idx !== -1) {
        const raw = this.pipeBuffer.slice(0, idx)
        this.pipeBuffer = this.pipeBuffer.slice(idx + 1)
        if (raw.trim()) {
          try {
            this.handlePayload(JSON.parse(raw))
          } catch (err) {
            console.warn('[managedChrome] Failed to parse CDP pipe message:', err)
          }
        }
        idx = this.pipeBuffer.indexOf('\0')
      }
    })

    read.on('error', (err) => this.rejectPending(err))
    write.on('error', (err) => this.rejectPending(err))
    read.on('close', () => {
      if (!this.closed) this.rejectPending(new Error('Chrome DevTools pipe closed'))
    })
  }

  async send<T = any>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
    timeoutMs = 15_000
  ): Promise<T> {
    const id = ++this.id
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP ${method}: timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      if (this.pipeWrite) {
        this.pipeWrite.write(`${payload}\0`, (err) => {
          if (err) {
            const pending = this.pending.get(id)
            if (pending) clearTimeout(pending.timer)
            this.pending.delete(id)
            reject(err)
          }
        })
        return
      }
      this.ws.send(payload)
    })
  }

  async evaluate<T = any>(expression: string, sessionId?: string | null): Promise<T | null> {
    const result = await this.send<any>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId)

    if (!result || !('result' in result)) return null
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed')
    }

    return result.result?.value ?? null
  }

  close(): void {
    if (this.persistent) return
    this.forceClose()
  }

  forceClose(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      // Ignore close failures.
    }
    try {
      this.pipeRead?.destroy()
      this.pipeWrite?.destroy()
    } catch {
      // Ignore pipe cleanup failures.
    }
    this.rejectPending(new Error('Chrome DevTools connection closed'))
  }
}

class CDPPageClient {
  constructor(
    private client: CDPClient,
    private sessionId: string | null,
    private ownsClient: boolean
  ) {}

  on(method: string, handler: (params: any) => void): void {
    this.client.on(method, handler, this.sessionId)
  }

  async send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId)
  }

  async evaluate<T = any>(expression: string): Promise<T | null> {
    return this.client.evaluate<T>(expression, this.sessionId)
  }

  async close(): Promise<void> {
    if (this.sessionId && !this.ownsClient) {
      try {
        await this.client.send('Target.detachFromTarget', { sessionId: this.sessionId })
      } catch {
        // Ignore detach failures; the browser-level pipe stays alive.
      }
      return
    }
    this.client.close()
  }
}

async function createBrowserClient(config: ManagedChromeConfig): Promise<CDPClient | null> {
  const pipeBrowser = getActivePipeBrowser(config)
  if (pipeBrowser) {
    return pipeBrowser.client
  }

  const webSocketUrl = await getBrowserWebSocketUrl(config.port)
  if (!webSocketUrl) {
    return null
  }

  const client = new CDPClient()
  await client.connect(webSocketUrl)
  return client
}

async function createPageClient(
  config: ManagedChromeConfig,
  target: ChromeTargetInfo
): Promise<CDPPageClient | null> {
  const pipeBrowser = getActivePipeBrowser(config)
  if (pipeBrowser) {
    const attached = await pipeBrowser.client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: target.id,
      flatten: true
    })
    return new CDPPageClient(pipeBrowser.client, attached.sessionId, false)
  }

  if (!target.webSocketDebuggerUrl) return null
  const client = new CDPClient()
  await client.connect(target.webSocketDebuggerUrl)
  return new CDPPageClient(client, null, true)
}

export async function closeManagedChrome(config: ManagedChromeConfig): Promise<void> {
  managedChromeLastActivity.delete(config.serviceId)
  const pipeBrowser = getActivePipeBrowser(config)
  if (pipeBrowser) {
    const child = pipeBrowser.child
    try {
      await pipeBrowser.client.send('Browser.close')
    } catch {
      // Ignore close failures.
    }
    pipeBrowser.client.forceClose()

    // Wait for the child process to actually exit before returning. Without
    // this, a relaunch race can hit the user-data-dir profile lock that the
    // exiting Chrome still holds, causing the new Chrome to bounce off and
    // exit silently. Up to 5s ceiling so we never hang on a stuck process —
    // then force-kill by PID so we never untrack a still-living Chrome.
    if (!pipeBrowser.exited && child && child.exitCode === null) {
      await new Promise<void>((resolveExit) => {
        let done = false
        const onExit = (): void => {
          if (done) return
          done = true
          resolveExit()
        }
        child.once('exit', onExit)
        setTimeout(() => {
          if (done) return
          done = true
          child.off('exit', onExit)
          console.warn(
            `[managedChrome:${config.serviceId}] Child did not report exit within 5s — force-killing pid=${child.pid}`
          )
          killOrphanedChrome(config.serviceId, child, 'pipe close: no exit within 5s')
          resolveExit()
        }, 5000)
      })
    }

    pipeBrowser.exited = true
    if (managedPipeBrowsers.get(config.serviceId) === pipeBrowser) {
      managedPipeBrowsers.delete(config.serviceId)
    }
    return
  }

  const portBrowser = managedPortBrowsers.get(config.serviceId)
  const forgetPortBrowser = (): void => {
    if (managedPortBrowsers.get(config.serviceId) === portBrowser) {
      managedPortBrowsers.delete(config.serviceId)
    }
  }

  const client = await createBrowserClient(config)
  if (!client) {
    // No debugger to talk to. If we still hold the child, it is wedged — reap it
    // rather than leaving a tracked-but-unclosable Chrome behind at quit.
    if (portBrowser) {
      killOrphanedChrome(config.serviceId, portBrowser.child, 'debugger unreachable at close')
      forgetPortBrowser()
    }
    return
  }

  try {
    await client.send('Browser.close')
  } catch {
    // Ignore close failures; we'll still wait for the debugger port to drop.
  } finally {
    client.close()
  }

  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (!(await isDebuggerReady(config.port))) {
      forgetPortBrowser()
      return
    }
    await sleep(200)
  }

  // Browser.close was accepted but the port is still live after 5s — force it.
  if (portBrowser) {
    killOrphanedChrome(config.serviceId, portBrowser.child, 'still listening 5s after Browser.close')
    forgetPortBrowser()
  }
}

export async function clearManagedChromeProfile(config: ManagedChromeConfig): Promise<void> {
  await closeManagedChrome(config)
  reapOrphanManagedChromes(config.serviceId)
  await sleep(400)

  const base = resolve(getManagedProfileBaseDir())
  const target = resolve(join(base, config.serviceId))
  if (target === base || !target.startsWith(`${base}${sep}`)) return
  if (!existsSync(target)) return

  const tryRemove = (): void => {
    rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }

  try {
    tryRemove()
    console.log(`[managedChrome:${config.serviceId}] Cleared managed Chrome profile`)
    return
  } catch (err) {
    console.warn(
      `[managedChrome:${config.serviceId}] Profile delete blocked, killing leftovers:`,
      (err as Error).message
    )
  }

  reapOrphanManagedChromes(config.serviceId)
  await sleep(700)
  try {
    if (existsSync(target)) tryRemove()
    console.log(`[managedChrome:${config.serviceId}] Cleared managed Chrome profile after retry`)
  } catch (err) {
    // A leftover lock must not fail Disconnect or block Refresh. Cache wipe
    // still happens in the caller.
    console.warn(
      `[managedChrome:${config.serviceId}] Profile still locked after kill — leaving folder:`,
      (err as Error).message
    )
  }
}

export async function closeAllManagedChrome(): Promise<number> {
  // Must cover BOTH maps: port-mode instances used to be invisible here, and passing
  // port: 0 for them meant closeManagedChrome()'s non-pipe path probed the wrong port
  // and gave up. Pipe entries genuinely have no port (port: 0 is correct for those).
  const configs = [
    ...Array.from(managedPipeBrowsers.keys()).map((serviceId) => ({
      serviceId,
      port: 0,
      startUrl: ''
    })),
    ...Array.from(managedPortBrowsers.entries())
      .filter(([serviceId]) => !managedPipeBrowsers.has(serviceId))
      .map(([serviceId, inst]) => ({ serviceId, port: inst.port, startUrl: '' }))
  ]
  for (const config of configs) {
    await closeManagedChrome(config)
  }
  return configs.length
}

export function listRunningManagedChrome(): string[] {
  const ids = new Set<string>()
  for (const [serviceId, browser] of managedPipeBrowsers) {
    if (!browser.exited) ids.add(serviceId)
  }
  for (const serviceId of managedPortBrowsers.keys()) {
    ids.add(serviceId)
  }
  return [...ids].sort()
}

/**
 * After a visible Chrome launch, attach to the new page target and force the
 * window to the requested onscreen bounds via CDP. Belt-and-suspenders: Chrome
 * sometimes ignores --window-position/--window-size on relaunch when the user-
 * data-dir profile has saved offscreen state from a previous scraping run.
 */
async function forceVisibleWindowOnscreen(
  config: ManagedChromeConfig,
  url: string,
  bounds: SignInWindowBounds
): Promise<void> {
  const targets = await listTargets(config)
  // Prefer the page target whose URL matches what we just opened.
  const target =
    targets.find((t) => t.type === 'page' && t.url && (t.url === url || t.url.startsWith(url))) ||
    targets.find((t) => t.type === 'page' && t.url && t.url !== 'about:blank') ||
    targets.find((t) => t.type === 'page')
  if (!target) {
    console.warn(`[managedChrome:${config.serviceId}] No page target to position; skipping setWindowBounds`)
    return
  }

  const pageClient = await createPageClient(config, target)
  if (!pageClient) return
  try {
    const winInfo = await pageClient.send<{ windowId: number }>('Browser.getWindowForTarget', {
      targetId: target.id
    })
    if (winInfo?.windowId) {
      await pageClient.send('Browser.setWindowBounds', {
        windowId: winInfo.windowId,
        bounds: {
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
          windowState: 'normal'
        }
      })
      try { await pageClient.send('Page.bringToFront') } catch { /* non-fatal */ }
      console.log(`[managedChrome:${config.serviceId}] Forced sign-in window onscreen at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`)
    }
  } catch (err: any) {
    console.warn(`[managedChrome:${config.serviceId}] Browser.setWindowBounds failed: ${err?.message || err}`)
  } finally {
    await pageClient.close()
  }
}

export async function openManagedChromeWindow(
  config: ManagedChromeConfig,
  url: string = config.startUrl
): Promise<void> {
  // Reconnect must produce exactly ONE visible window, pointed at the dashboard URL.
  // If managed Chrome was already running for background scraping, re-using it leaves
  // stale offscreen targets that confuse waitForLoginComplete (URL polling can match
  // the old offscreen target and report "signed in" before the user has actually
  // completed Cloudflare verification or sign-in in the new visible window).
  // Solution: tear down any existing managed Chrome and launch fresh in visible mode.
  // The user-data-dir on disk preserves cookies, so this does not force re-login.
  const wasRunning = !!getActivePipeBrowser(config) || (await isDebuggerReady(config.port))
  if (wasRunning) {
    console.log(`[managedChrome:${config.serviceId}] Closing existing managed Chrome before opening sign-in window`)
    try {
      await closeManagedChrome(config)
    } catch (err) {
      console.warn(`[managedChrome:${config.serviceId}] closeManagedChrome before sign-in failed:`, err)
    }
    // Extra wait so Windows fully releases the user-data-dir Local State lock
    // even after the child process has reported exit. 500ms was not enough on
    // a loaded system; 1500ms is reliable. closeManagedChrome already awaits
    // the child exit event, so this is purely OS-filesystem settle time.
    await sleep(1500)
  }

  // Compute centered bounds on the user's primary display. We pass them as
  // Chrome CLI flags AND apply them again via CDP after attach (belt + braces).
  const bounds = computeCenteredSignInBounds()
  console.log(`[managedChrome:${config.serviceId}] Opening sign-in window at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`)

  let pipeErr: unknown = null
  try {
    await launchChromePipe(config, url, true, bounds)
  } catch (err) {
    pipeErr = err
    console.warn(`[managedChrome:${config.serviceId}] Pipe launch failed, falling back to localhost CDP:`, err)
  }

  if (pipeErr) {
    try {
      await launchChromePort(config, url, true, bounds)
    } catch (portErr) {
      // Re-throw with both causes so callers can decide whether to fall back
      // to a regular Electron BrowserWindow path.
      throw new Error(
        `[managedChrome:${config.serviceId}] Could not launch managed Chrome. ` +
        `Pipe attempt: ${(pipeErr as any)?.message || pipeErr}. ` +
        `Port attempt: ${(portErr as any)?.message || portErr}.`
      )
    }
  }

  // Give the page a moment to attach and start loading before we adjust window bounds.
  await sleep(750)
  await forceVisibleWindowOnscreen(config, url, bounds)
  console.log(`[managedChrome:${config.serviceId}] Sign-in window ready at ${url}`)
}

/**
 * Check if the managed Chrome is at a logged-in state by evaluating the dashboard URL.
 * Returns true if the page shows usage data (logged in), false if still at login page.
 */
export async function checkLoginState(
  config: ManagedChromeConfig,
  dashboardUrl: string
): Promise<{ isLoggedIn: boolean; currentUrl: string }> {
  if (!getActivePipeBrowser(config) && !(await isDebuggerReady(config.port))) {
    return { isLoggedIn: false, currentUrl: '' }
  }

  const targets = await listTargets(config)
  const target = targets.find(t => isMatchingTarget(t, dashboardUrl)) ||
    targets.find(t => t.type === 'page')
  if (!target) {
    return { isLoggedIn: false, currentUrl: '' }
  }

  const client = await createPageClient(config, target)
  if (!client) return { isLoggedIn: false, currentUrl: '' }
  try {
    await client.send('Page.enable')

    const currentUrl = await client.evaluate<string>('window.location.href') || ''

    // If we're at the dashboard URL (or a dashboard subpage), consider it logged in.
    // The ready check will confirm actual data is present.
    const pattern = config.loggedInUrlPattern ?? '/settings/'
    const patterns = pattern.split('|').map((p) => p.trim()).filter(Boolean)
    const dashboardOrigin = (() => {
      try { return new URL(dashboardUrl).origin } catch { return '' }
    })()
    const isAtDashboard =
      (dashboardOrigin === '' || currentUrl.startsWith(dashboardOrigin)) &&
      patterns.some((p) => currentUrl.includes(p))

    return { isLoggedIn: isAtDashboard, currentUrl }
  } catch {
    return { isLoggedIn: false, currentUrl: '' }
  } finally {
    await client.close()
  }
}

/**
 * Title-based "is this page actually signed in?" check. Reads ONLY the
 * `target.title` field already returned by `Target.getTargets` — no per-page
 * CDP attach, no in-page JavaScript evaluation. That matters during Cloudflare
 * challenges: Runtime.evaluate calls into the page increase the surface CF can
 * fingerprint while the user is still trying to pass the challenge.
 *
 * Title transitions reliably as Cloudflare resolves and the page navigates:
 *   "Just a moment..." → "<service> Sign in" → "<service> Dashboard"
 * We reject the first two and accept the third.
 */
function classifyTitleAsSignedIn(title: string): { signedIn: boolean; reason: string } {
  const raw = title || ''
  const t = raw.toLowerCase().trim()

  if (t.length === 0) return { signedIn: false, reason: 'no-title' }

  // Cloudflare interstitial titles across versions.
  if (t.includes('just a moment')) return { signedIn: false, reason: `cloudflare:${raw.slice(0, 40)}` }
  if (t.includes('attention required')) return { signedIn: false, reason: `cloudflare-block:${raw.slice(0, 40)}` }
  if (t.includes('cloudflare')) return { signedIn: false, reason: `cloudflare:${raw.slice(0, 40)}` }
  if (t.includes('verifying') || t.includes('please wait')) return { signedIn: false, reason: `verify:${raw.slice(0, 40)}` }

  // Sign-in / authorize form titles.
  if (/\bsign\s*in\b|\blog\s*in\b|\blogin\b|\bauthori[sz]e\b/.test(t)) {
    return { signedIn: false, reason: `signin:${raw.slice(0, 40)}` }
  }

  return { signedIn: true, reason: `title=${raw.slice(0, 60)}` }
}

/**
 * Wait for login to complete. Polls every 1s up to `timeoutMs`. Returns true
 * once a page target's URL matches `loggedInUrlPattern` AND the page body
 * passes the SIGNED_IN_PAGE_PROBE. Returns false early if the managed Chrome
 * process exits (user closed the window to give up).
 *
 * Why both checks: URL alone matches during the Cloudflare challenge because
 * CF doesn't change the URL. Body-content alone is too fuzzy across services.
 * Combining them is what the original "it just works" UX needs.
 */
export async function waitForLoginComplete(
  config: ManagedChromeConfig,
  dashboardUrl: string,
  timeoutMs = 300_000   // 5 minutes — Cloudflare + sign-in + 2FA needs real time
): Promise<boolean> {
  console.log(`[managedChrome:${config.serviceId}] Waiting for login completion (timeout=${Math.round(timeoutMs / 1000)}s)...`)
  const started = Date.now()
  const pattern = config.loggedInUrlPattern ?? '/settings/'
  const patterns = pattern.split('|').map((p) => p.trim()).filter(Boolean)
  let lastLogAt = 0
  let lastProbeOutcome = 'not-yet-checked'

  // Best-effort dashboard origin so we don't match an unrelated tab that happens
  // to contain the URL pattern fragment (e.g. a docs tab on a different domain).
  const dashboardOrigin = (() => {
    try { return new URL(dashboardUrl).origin } catch { return '' }
  })()

  while (Date.now() - started < timeoutMs) {
    // If managed Chrome died (user closed the only window), fail fast instead of
    // polling for the full timeout against a dead debugger.
    const alive = !!getActivePipeBrowser(config) || (await isDebuggerReady(config.port))
    if (!alive) {
      console.log(`[managedChrome:${config.serviceId}] Managed Chrome process exited — aborting login wait`)
      return false
    }

    let targets: ChromeTargetInfo[] = []
    try {
      targets = await listTargets(config)
    } catch (err) {
      console.warn(`[managedChrome:${config.serviceId}] listTargets failed during login wait:`, err)
    }

    // Find any page target whose URL matches the logged-in pattern and is on
    // the dashboard origin. There may be multiple targets; we want the first
    // one that ALSO passes the in-page content probe.
    const candidates = targets.filter((t) =>
      t.type === 'page' &&
      (dashboardOrigin === '' || t.url.startsWith(dashboardOrigin)) &&
      patterns.some((p) => t.url.includes(p))
    )

    for (const candidate of candidates) {
      const probed = classifyTitleAsSignedIn(candidate.title || '')
      lastProbeOutcome = probed.reason
      if (!probed.signedIn) continue

      if (config.loginCompleteExpression) {
        // Content probe for static-URL/static-title services (kimi, grok).
        // Runs only after the title check rejected Cloudflare/sign-in states,
        // so we never Runtime.evaluate into an active challenge page.
        // IMPORTANT: evaluate the expression AS-IS — client.evaluate awaits
        // promises; wrapping it in the sync `!!(expr)` readiness wrapper would
        // coerce a pending Promise to true.
        let contentOk = false
        try {
          const probeClient = await createPageClient(config, candidate)
          if (probeClient) {
            try {
              contentOk = (await probeClient.evaluate<boolean>(config.loginCompleteExpression)) === true
            } finally {
              await probeClient.close()
            }
          }
        } catch {
          contentOk = false
        }
        lastProbeOutcome = contentOk ? `content-ok (${probed.reason})` : `content-pending (${probed.reason})`
        if (!contentOk) continue
      }

      console.log(`[managedChrome:${config.serviceId}] Login complete — ${candidate.url} (${lastProbeOutcome})`)
      // Brief settle so the page can finish writing auth cookies before we proceed.
      await sleep(750)
      return true
    }

    // Throttled status log every ~10s so the user/dev can see progress.
    const now = Date.now()
    if (now - lastLogAt > 10_000) {
      const pageTargets = targets.filter((t) => t.type === 'page')
      const summary = pageTargets.map((t) => `${t.title || '<no title>'} <${t.url || '<blank>'}>`).join(' | ')
      const elapsed = Math.round((now - started) / 1000)
      console.log(`[managedChrome:${config.serviceId}] Still waiting for sign-in (${elapsed}s elapsed, last probe: ${lastProbeOutcome}). Open tabs: ${summary || '<none>'}`)
      lastLogAt = now
    }

    await sleep(1000)
  }

  console.log(`[managedChrome:${config.serviceId}] Login wait timed out after ${Math.round(timeoutMs / 1000)}s`)
  return false
}


export async function evaluateInManagedChrome<T>(
  config: ManagedChromeConfig,
  url: string,
  readyCheckExpression: string,
  evaluationExpression: string,
  timeoutMsOrOptions: number | ManagedChromeEvaluateOptions = 20000
): Promise<EvaluationResult<T> | null> {
  const options: ManagedChromeEvaluateOptions =
    typeof timeoutMsOrOptions === 'number'
      ? { timeoutMs: timeoutMsOrOptions }
      : timeoutMsOrOptions
  const timeoutMs = options.timeoutMs ?? 20000
  const allowLaunch = options.allowLaunch ?? true
  const allowTargetOpen = options.allowTargetOpen ?? false
  const allowNavigate = options.allowNavigate ?? allowTargetOpen

  const chromeReady = await ensureChrome(config, 'about:blank', false, allowLaunch)
  if (!chromeReady) {
    return null
  }

  const target = await ensureTarget(config, url, allowTargetOpen)
  if (!target) {
    return null
  }

  const client = await createPageClient(config, target)
  if (!client) return null

  try {
    await client.send('Page.enable')
    await installWebAuthnBlockerInPage(client, `managedChrome:${config.serviceId}`)
    // NOTE: Runtime.enable is intentionally NOT called here.
    // Cloudflare detects Runtime.Enable CDP side effects as an automation signal.
    // Runtime.evaluate works without Runtime.Enable being active.

    const captureNeedles = (options.captureUrlIncludes ?? []).map((s) => s.toLowerCase())
    const pendingCaptures: { requestId: string; url: string }[] = []
    if (captureNeedles.length > 0) {
      await client.send('Network.enable')
      client.on('Network.responseReceived', (params: { requestId?: string; response?: { url?: string } }) => {
        const responseUrl = params.response?.url || ''
        const requestId = params.requestId
        if (!requestId || !responseUrl) return
        const lower = responseUrl.toLowerCase()
        if (captureNeedles.some((needle) => lower.includes(needle))) {
          pendingCaptures.push({ requestId, url: responseUrl })
        }
      })
    }

    const currentUrl = await client.evaluate<string>('window.location.href')
    const alreadyOnUrl = !!(currentUrl && currentUrl.startsWith(url))
    if (!alreadyOnUrl) {
      if (!allowNavigate) {
        return null
      }

      await client.send('Page.navigate', { url })
      // Unload the previous document so the ready poll cannot succeed against it.
      await sleep(400)
    } else if (options.forceReload && allowNavigate) {
      console.log(`[managedChrome:${config.serviceId}] Reloading tab before scrape (${currentUrl})`)
      try {
        await client.send('Page.reload', { ignoreCache: true })
      } catch {
        await client.send('Page.navigate', { url })
      }
      await sleep(400)
    }

    const started = Date.now()
    let pageReady = false
    while (Date.now() - started < timeoutMs) {
      const ready = await client.evaluate<boolean>(`(() => { try { return !!(${readyCheckExpression}); } catch (e) { return false; } })()`)
      if (ready) {
        pageReady = true
        break
      }
      await sleep(500)
    }

    if (!pageReady) {
      const finalUrl = await client.evaluate<string>('window.location.href') || url
      const title = await client.evaluate<string>('document.title') || ''
      console.log(`[managedChrome:${config.serviceId}] Readiness check timed out after ${timeoutMs}ms at ${title} (${finalUrl})`)
      return null
    }

    if (captureNeedles.length > 0) {
      // The dashboard RPC often lands after the first paint.
      await sleep(2000)
    }

    const capturedResponses: { url: string; body: string }[] = []
    for (const hit of pendingCaptures) {
      try {
        const bodyResult = await client.send<{ body: string; base64Encoded?: boolean }>(
          'Network.getResponseBody',
          { requestId: hit.requestId }
        )
        if (!bodyResult?.body) continue
        const body = bodyResult.base64Encoded
          ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
          : bodyResult.body
        capturedResponses.push({ url: hit.url, body })
      } catch {
        // Body already evicted — in-page fetch in the scraper is the fallback.
      }
    }

    const finalUrl = await client.evaluate<string>('window.location.href') || url
    const title = await client.evaluate<string>('document.title') || ''
    const value = await client.evaluate<T>(evaluationExpression)

    return {
      url: finalUrl,
      title,
      value,
      capturedResponses: capturedResponses.length > 0 ? capturedResponses : undefined
    }
  } finally {
    await client.close()
  }
}

/**
 * Navigate managed Chrome directly to a URL and capture the HTTP response
 * via CDP Network domain. This avoids fetch() entirely — no CORS, no CSP,
 * no origin issues. The browser makes a normal navigation request with cookies.
 */
export async function fetchInManagedChrome<T = any>(
  config: ManagedChromeConfig,
  url: string,
  options?: { json?: boolean }
): Promise<{ ok: boolean; status: number; data: T | null } | null> {
  const json = options?.json ?? true

  const ready = await ensureChrome(config, 'about:blank', false, true)
  if (!ready) return null

  const targets = await listTargets(config)
  let target = targets.find(t => t.type === 'page')
  if (!target) return null

  const client = await createPageClient(config, target)
  if (!client) return null

  try {
    await client.send('Network.enable')
    await client.send('Page.enable')
    await installWebAuthnBlockerInPage(client, `managedChrome:${config.serviceId}`)

    // Capture the HTTP response for our navigation request
    const responseCapture = new Promise<{ requestId: string; status: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Navigation response timeout')), 15000)
      client.on('Network.responseReceived', (params: any) => {
        // Match the main document response (type=Document) for our URL
        if (params.type === 'Document' && params.response) {
          clearTimeout(timeout)
          resolve({ requestId: params.requestId, status: params.response.status })
        }
      })
    })

    // Navigate directly to the target URL
    await client.send('Page.navigate', { url })

    const { requestId, status } = await responseCapture

    if (status < 200 || status >= 400) {
      return { ok: false, status, data: null }
    }

    // Read the response body
    let body: string | null = null
    try {
      const bodyResult = await client.send<{ body: string; base64Encoded: boolean }>(
        'Network.getResponseBody', { requestId }
      )
      body = bodyResult?.body ?? null
    } catch {
      // Fallback: read from page DOM (Chrome may have already consumed the stream)
      await sleep(500)
      body = await client.evaluate<string>(
        json ? 'document.body?.innerText || null' : 'document.documentElement?.outerHTML || null'
      )
    }

    if (!body) return { ok: true, status, data: null }

    if (json) {
      try {
        return { ok: true, status, data: JSON.parse(body) as T }
      } catch {
        return { ok: true, status, data: null }
      }
    }
    return { ok: true, status, data: body as unknown as T }
  } catch (err: any) {
    const msg = err?.message || String(err)
    // Don't log full stack traces for expected failures
    console.log(`[managedChrome:${config.serviceId}] CDP navigate+capture failed: ${msg}`)
    return null
  } finally {
    await client.close()
  }
}

/**
 * Inject cookies into a running managed Chrome instance via CDP.
 * Used to sync cookies imported from the user's system Chrome so
 * that managed Chrome sessions stay authenticated automatically.
 */
export async function injectCookiesIntoManagedChrome(
  config: ManagedChromeConfig,
  cookies: Array<{ name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean }>
): Promise<number> {
  if (!getActivePipeBrowser(config) && !(await isDebuggerReady(config.port))) return 0

  // Network.setCookie requires a page-level CDP connection (not browser-level).
  // Find an existing page target, or create one via browser-level Target.createTarget.
  const targets = await listTargets(config)
  let target = targets.find(t => t.type === 'page')

  if (!target) {
    // No page target — create one via browser-level CDP
    const browserClient = await createBrowserClient(config)
    if (!browserClient) return 0
    try {
      await browserClient.send('Target.createTarget', { url: 'about:blank' })
    } catch { }
    browserClient.close()
    await sleep(500)

    // Re-fetch targets
    const newTargets = await listTargets(config)
    target = newTargets.find(t => t.type === 'page')
    if (!target) return 0
  }

  const client = await createPageClient(config, target)
  if (!client) return 0

  let injected = 0
  try {
    await client.send('Network.enable')
    for (const cookie of cookies) {
      try {
        const domain = (cookie.domain || '').replace(/^\./, '')
        await client.send('Network.setCookie', {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || undefined,
          path: cookie.path || '/',
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          url: `https://${domain}${cookie.path || '/'}`
        })
        injected++
      } catch { }
    }
  } finally {
    await client.close()
  }

  if (injected > 0) {
    console.log(`[managedChrome:${config.serviceId}] Injected ${injected} cookies via CDP`)
  }
  return injected
}

/**
 * Try to read cookies from the user's system Chrome via CDP.
 * First checks if Chrome is already running with a debugging port.
 * If Chrome is NOT running, temporarily launches headless Chrome with the
 * user's real profile to read cookies. Chrome's own process decrypts v20
 * app-bound encrypted cookies — no external decryption needed.
 */
export async function readCookiesFromSystemChrome(
  ...domains: string[]
): Promise<Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }> | null> {
  // Method 1: Check if Chrome is already running with debugging enabled
  const debugPorts = [9222, 9229]
  for (const port of debugPorts) {
    const wsUrl = await getBrowserWebSocketUrl(port)
    if (!wsUrl) continue

    console.log(`[systemChrome] Found Chrome debugging on port ${port}`)
    const cookies = await readCookiesViaCDP(port, domains)
    if (cookies && cookies.length > 0) return cookies
  }

  // Method 2: Launch headless Chrome with user's real profile temporarily
  // This works because Chrome decrypts its own v20 app-bound cookies
  if (isUserChromeProfileLocked()) {
    console.log('[systemChrome] User Chrome profile is locked — cannot launch headless with same profile')
    return null
  }

  return await readCookiesViaTemporaryChrome(domains)
}

function isUserChromeProfileLocked(): boolean {
  const { homedir } = require('os')
  const lockFile = join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'lockfile')
  if (!existsSync(lockFile)) return false

  // Lockfile exists — try to remove it. If Chrome is running, this will throw EBUSY/EPERM.
  // If Chrome was force-killed, the stale lockfile can be removed.
  try {
    const { unlinkSync } = require('fs')
    unlinkSync(lockFile)
    console.log('[systemChrome] Removed stale Chrome lockfile')
    return false
  } catch {
    return true // Chrome is actually running and holds the lock
  }
}

async function readCookiesViaCDP(
  port: number,
  domains: string[]
): Promise<Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }> | null> {
  // Try browser-level first with Storage.getCookies, then fall back to page-level Network.getAllCookies
  const wsUrl = await getBrowserWebSocketUrl(port)
  if (!wsUrl) return null

  const client = new CDPClient()
  try {
    await client.connect(wsUrl)

    let allCookies: any[] = []

    // Method 1: Storage.getCookies (browser-level, Chrome 127+)
    try {
      const result = await client.send<{ cookies: any[] }>('Storage.getCookies')
      if (result?.cookies) allCookies = result.cookies
    } catch { }

    // Method 2: Network.getAllCookies (browser-level)
    if (allCookies.length === 0) {
      try {
        const result = await client.send<{ cookies: any[] }>('Network.getAllCookies')
        if (result?.cookies) allCookies = result.cookies
      } catch { }
    }

    client.close()

    // Method 3: Use page-level connection for Network.getAllCookies
    if (allCookies.length === 0) {
      const targets = await fetchJson<ChromeTargetInfo[]>(`http://127.0.0.1:${port}/json/list`) || []
      const pageTarget = targets.find(t => t.type === 'page' && !!t.webSocketDebuggerUrl)
      if (pageTarget?.webSocketDebuggerUrl) {
        const pageClient = new CDPClient()
        try {
          await pageClient.connect(pageTarget.webSocketDebuggerUrl)
          await pageClient.send('Network.enable')
          const result = await pageClient.send<{ cookies: any[] }>('Network.getAllCookies')
          if (result?.cookies) allCookies = result.cookies
        } catch { }
        finally { pageClient.close() }
      }
    }

    if (allCookies.length === 0) {
      console.log(`[systemChrome] No cookies returned from CDP on port ${port}`)
      return null
    }

    console.log(`[systemChrome] Got ${allCookies.length} total cookies from port ${port}`)

    const filtered = allCookies.filter((c: any) =>
      domains.some(d => c.domain?.includes(d) || d.includes(c.domain?.replace(/^\./, '')))
    )

    if (filtered.length > 0) {
      console.log(`[systemChrome] Matched ${filtered.length} cookies for [${domains.join(', ')}]`)
      return filtered.map((c: any) => ({
        name: c.name, value: c.value, domain: c.domain,
        path: c.path || '/', secure: c.secure ?? true, httpOnly: c.httpOnly ?? false
      }))
    }

    console.log(`[systemChrome] 0 cookies matched domains [${domains.join(', ')}] out of ${allCookies.length} total`)
  } catch (err: any) {
    console.log(`[systemChrome] CDP cookie read error: ${err?.message || err}`)
    client.close()
  }
  return null
}

async function readCookiesViaTemporaryChrome(
  domains: string[]
): Promise<Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }> | null> {
  const { homedir } = require('os')
  const userDataDir = join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  if (!existsSync(userDataDir)) return null

  console.log('[systemChrome] Launching temporary headless Chrome with user profile to read cookies...')

  let chromePid: number | undefined
  let client: CDPClient | null = null
  try {
    const chromePath = getChromeExecutable()
    const child = spawn(chromePath, [
      '--remote-debugging-pipe',
      ...getCommonChromeArgs(userDataDir),
      '--window-position=-32000,-32000',
      '--window-size=1920,1080',
      '--disable-extensions',
      '--disable-popup-blocking',
      'about:blank'
    ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
    chromePid = child.pid

    const write = child.stdio?.[3] as Writable | undefined
    const read = child.stdio?.[4] as Readable | undefined
    if (!read || !write) {
      console.log('[systemChrome] Temporary Chrome pipe was unavailable')
      return null
    }

    client = new CDPClient()
    await client.connectPipe(read, write)
    await client.send('Browser.getVersion')

    let allCookies: any[] = []
    try {
      const result = await client.send<{ cookies: any[] }>('Storage.getCookies')
      if (result?.cookies) allCookies = result.cookies
    } catch { }

    if (allCookies.length === 0) {
      try {
        const result = await client.send<{ cookies: any[] }>('Network.getAllCookies')
        if (result?.cookies) allCookies = result.cookies
      } catch { }
    }

    if (allCookies.length === 0) {
      console.log('[systemChrome] Temporary Chrome returned no cookies')
      return null
    }

    const filtered = allCookies.filter((c: any) =>
      domains.some(d => c.domain?.includes(d) || d.includes(c.domain?.replace(/^\./, '')))
    )

    if (filtered.length === 0) {
      console.log(`[systemChrome] Temporary Chrome matched 0 cookies for [${domains.join(', ')}]`)
      return null
    }

    console.log(`[systemChrome] Temporary Chrome matched ${filtered.length} cookies for [${domains.join(', ')}]`)
    const cookies = filtered.map((c: any) => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', secure: c.secure ?? true, httpOnly: c.httpOnly ?? false
    }))

    // Shut down temporary Chrome gracefully
    try { await client.send('Browser.close') } catch { }

    return cookies
  } catch (err: any) {
    console.log(`[systemChrome] Temporary Chrome error: ${err?.message || err}`)
    return null
  } finally {
    client?.forceClose()
    // Ensure cleanup even on error
    if (chromePid) {
      try {
        const { execSync } = require('child_process')
        execSync(`taskkill /F /PID ${chromePid}`, { windowsHide: true, stdio: 'pipe' })
      } catch { }
    }
  }
}
