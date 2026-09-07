// Guards the four structural properties that keep managed Chrome from outliving the app.
//
// Managed Chromes are spawned `detached: true` + `child.unref()`, so any instance the
// main process does not TRACK or KILL survives forever — invisible to the next run
// (pipe mode opens no debugger port, so isDebuggerReady() can never rediscover it).
// Four separate paths leaked one:
//
//   1. `app.on('before-quit', async () => ...)` — Electron does not await async
//      before-quit listeners, so the process died at the first `await` and
//      closeAllManagedChrome() never ran. Needs preventDefault + an explicit quit.
//   2. launchChromePipe() spawned, THEN did throwable init (CDP streams, connectPipe,
//      Browser.getVersion) before registering in managedPipeBrowsers. A throw in that
//      window orphaned the child AND made ensureChrome() fall back to launchChromePort,
//      putting a second Chrome on the same profile.
//   3. launchChromePort() threw on waitForDebugger failure with the child still running.
//   4. closeAllManagedChrome() iterated only managedPipeBrowsers, so every port-mode
//      fallback instance was unclosable at quit.
//
// These are source-shape assertions, matching this repo's other smoke tests: the
// Electron main process cannot be exercised headlessly here.
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const mainDir = path.resolve(__dirname, '..', 'src', 'main')
const indexSrc = fs.readFileSync(path.join(mainDir, 'index.ts'), 'utf8')
const chromeSrc = fs.readFileSync(path.join(mainDir, 'managedChrome.ts'), 'utf8')
const scraperSrc = fs.readFileSync(path.join(mainDir, 'scrapers', 'baseScraper.ts'), 'utf8')

/** Slice a balanced `{...}` block starting at the first occurrence of `header`. */
function blockAfter(source, header, label) {
  const start = source.indexOf(header)
  assert(start !== -1, `could not find ${label} (looked for: ${header})`)
  const open = source.indexOf('{', start)
  assert(open !== -1, `no opening brace for ${label}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while slicing ${label}`)
}

// --- 1. shutdown must hold the quit open ---
assert(
  !/app\.on\(\s*['"]before-quit['"]\s*,\s*async/.test(indexSrc),
  'before-quit listener must not be async: Electron does not await it, so teardown ' +
    '(closeAllManagedChrome) never runs and managed Chromes outlive the app. ' +
    'Use event.preventDefault(), run teardown, then app.quit().'
)

const shutdown = blockAfter(indexSrc, "app.on('before-quit'", 'before-quit handler')
assert(
  /event\.preventDefault\(\)/.test(shutdown),
  'the before-quit handler that tears down must call event.preventDefault(), or the ' +
    'process exits before closeAllManagedChrome() completes'
)
assert(
  /closeAllManagedChrome\(\)/.test(shutdown) && /app\.quit\(\)|app\.exit\(/.test(shutdown),
  'the before-quit handler must close managed Chrome AND then quit explicitly'
)

// --- 2 & 3. every spawn path reaps its child on failure ---
for (const fn of ['async function launchChromePipe', 'async function launchChromePort']) {
  const body = blockAfter(chromeSrc, fn, fn)
  assert(
    /killOrphanedChrome\(/.test(body),
    `${fn} must call killOrphanedChrome() on its failure path — it spawns detached + ` +
      'unref\'d, so a throw before/without tracking leaks a Chrome nothing can close'
  )
}

// --- 4. closing everything must mean everything ---
const closeAll = blockAfter(chromeSrc, 'export async function closeAllManagedChrome', 'closeAllManagedChrome')
assert(
  /managedPortBrowsers/.test(closeAll),
  'closeAllManagedChrome() must also close port-mode instances (managedPortBrowsers), ' +
    'not just managedPipeBrowsers'
)
assert(
  /managedPipeBrowsers/.test(closeAll),
  'closeAllManagedChrome() must still close pipe-mode instances'
)

// --- 5. pipe close must force-kill if the child never exits ---
const closeOne = blockAfter(chromeSrc, 'export async function closeManagedChrome', 'closeManagedChrome')
assert(
  /pipe close: no exit within 5s|Force-killed|killOrphanedChrome\(/.test(closeOne),
  'closeManagedChrome pipe path must force-kill (killOrphanedChrome) when the child ' +
    'does not exit within 5s — untracking without kill creates zombies'
)

// --- 6. soft kill must escalate to PID force-kill on Windows ---
assert(
  /function killOrphanedChrome/.test(chromeSrc) &&
    /taskkill \/F(?: \/T)? \/PID/.test(chromeSrc),
  'killOrphanedChrome / forceKillChromeByPid must use taskkill /F [/T] /PID (never /IM chrome.exe)'
)
assert(
  !/taskkill\s+\/F\s+\/IM\s+chrome/i.test(chromeSrc),
  'must never kill chrome by image name — that would kill the user\'s personal browser'
)

// --- 7. idle close must cover port-mode too ---
const idleClose = blockAfter(chromeSrc, 'async function closeIdleManagedChromes', 'closeIdleManagedChromes')
assert(
  /managedPortBrowsers/.test(idleClose),
  'closeIdleManagedChromes must also consider managedPortBrowsers (not only pipe map)'
)

// --- 8. startup orphan reaper exists and is invoked from index ---
assert(
  /export function reapOrphanManagedChromes/.test(chromeSrc),
  'reapOrphanManagedChromes must be exported for startup cleanup'
)
assert(
  /reapOrphanManagedChromes\(/.test(indexSrc),
  'index.ts must call reapOrphanManagedChromes() on startup'
)

// --- 9. ensureChrome must not spawn a second untracked Chrome for existing browsers ---
const ensure = blockAfter(chromeSrc, 'async function ensureChrome', 'ensureChrome')
assert(
  !/openUrlInExistingChrome/.test(ensure),
  'ensureChrome must not call openUrlInExistingChrome (untracked second spawn on same profile)'
)

assert(
  /const MAX_CONCURRENT_CHROME_LAUNCHES = 2/.test(chromeSrc) &&
    /acquireChromeLaunchSlot/.test(chromeSrc),
  'ensureChrome cold-launch path must cap concurrent Chrome spawns at 2'
)
assert(
  /MANAGED_CHROME_HIDDEN_IDLE_TIMEOUT_MS = 5 \* 60 \* 1000/.test(chromeSrc) &&
    /export function setManagedChromeAppForeground/.test(chromeSrc),
  'hidden/minimized app must use a 5-minute managed-Chrome idle timeout'
)
assert(
  /const MAX_SCRAPER_WINDOWS = 2/.test(scraperSrc),
  'hidden Electron scraper windows must cap at 2 (aligned with Chrome launch cap)'
)
assert(
  /export function listRunningManagedChrome/.test(chromeSrc) &&
    /Promise<number>/.test(
      chromeSrc.slice(chromeSrc.indexOf('export async function closeAllManagedChrome'))
    ),
  'Settings must be able to list and close running managed Chromes'
)

console.log(
  'managed-chrome-teardown-smoke: OK (shutdown, spawn reaps, closeAll both maps, ' +
    'pipe force-kill, taskkill-by-PID, idle port map, orphan reaper, no dual-spawn)'
)
