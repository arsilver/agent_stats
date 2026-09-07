import { app, BrowserWindow, shell, session, nativeImage, powerMonitor } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { config } from 'dotenv'
import { registerCredentialHandlers } from './credentialManager'
import { registerUsageHandlers, loadCacheFromDisk, warmUpAllServices, flushCacheToDisk } from './usageFetcher'
import { initUsageHistory, closeUsageHistory, resetAllBackoffState } from './usageHistory'
import { initializeLogCapture } from './logManager'
import { registerSettingsHandlers } from './settingsStore'
import { registerStorageMaintenanceHandlers, pruneSafeBrowserStorage } from './storageMaintenance'
import { closeAllManagedChrome, reapOrphanManagedChromes, setManagedChromeAppForeground } from './managedChrome'
import { startNetworkGuard, isAppOnline, onAppNetworkOffline } from './networkGuard'
import { installWebAuthnBlockerInWindow } from './browserPromptGuards'
import {
  pickWindowRevealReason,
  shouldQuitWhenLastWindowCloses,
  shouldRecreateMainWindow,
  WINDOW_REVEAL_FALLBACK_MS
} from './windowLifecycle'

// Load .env for local dev fallback
config()

// ─── Global crash handlers — prevent silent exits ───────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err)
  // Don't exit — keep the app alive. The error is logged for debugging.
})

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason)
  // Don't exit — keep the app alive.
})

let mainWindow: BrowserWindow | null = null
let pollingInterval: NodeJS.Timeout | null = null
let isQuitting = false
let bindMainWindowRuntime: ((win: BrowserWindow) => void) | null = null
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  console.log('[startup] Another instance is already running. Quitting.')
  app.quit()
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.setSkipTaskbar(false)
  mainWindow.setTitle('Agent Stats')
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true)
    mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()
    mainWindow.setAlwaysOnTop(false)
    app.focus({ steal: true })
    return
  }
  mainWindow.show()
  mainWindow.focus()
}

async function ensureMainWindow(reason: string): Promise<void> {
  if (shouldRecreateMainWindow({
    hasWindow: mainWindow !== null,
    isDestroyed: !mainWindow || mainWindow.isDestroyed(),
    isQuitting
  })) {
    console.log(`[window] Recreating main window (${reason})`)
    await createWindow()
    return
  }
  console.log(`[window] Focusing existing window (${reason})`)
  focusMainWindow()
}

function getAppIcon(): NativeImage | undefined {
  const iconPaths = [
    join(__dirname, '../../assets/icon.png'),
    join(__dirname, '../assets/icon.png'),
    join(process.cwd(), 'assets/icon.png')
  ]

  for (const iconPath of iconPaths) {
    if (existsSync(iconPath)) {
      return nativeImage.createFromPath(iconPath)
    }
  }
  return undefined
}

async function createWindow(): Promise<void> {
  // Default size = user's preferred screenshot outer dims (785×684)
  // with collapsed sidebar + ~80% zoom (two zoom-outs).
  mainWindow = new BrowserWindow({
    width: 785,
    height: 684,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Agent Stats',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Two Chromium zoom-out steps from 100% (100 → 90 → 80)
      zoomFactor: 0.8
    }
  })

  const revealState = {
    alreadyShown: false,
    readyToShow: false,
    didFinishLoad: false,
    didFailLoad: false,
    timeoutElapsed: false
  }

  const revealIfNeeded = (): void => {
    const reason = pickWindowRevealReason(revealState)
    if (!reason || !mainWindow || mainWindow.isDestroyed()) return
    revealState.alreadyShown = true
    mainWindow.webContents.setZoomFactor(0.8)
    console.log(`[window] Showing window (${reason})`)
    focusMainWindow()
  }

  mainWindow.on('ready-to-show', () => {
    revealState.readyToShow = true
    revealIfNeeded()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  setTimeout(() => {
    revealState.timeoutElapsed = true
    revealIfNeeded()
  }, WINDOW_REVEAL_FALLBACK_MS)

  // ─── Renderer load diagnostics ────────────────────────────
  // White-screen / blank-window debugging: log every load lifecycle event so
  // the dev console tells us exactly where the renderer broke.
  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[renderer] did-start-loading')
  })
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[renderer] did-finish-load — renderer fully loaded')
    revealState.didFinishLoad = true
    revealIfNeeded()
  })
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[renderer] did-fail-load: code=${errorCode} desc="${errorDescription}" url=${validatedURL} mainFrame=${isMainFrame}`)
    if (isMainFrame) {
      revealState.didFailLoad = true
      revealIfNeeded()
    }
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[renderer] preload-error in ${preloadPath}:`, error)
  })
  // Forward renderer console messages into the main-process log so they show
  // up in dev-server.log even when DevTools is closed.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const levelLabel = ['debug', 'info', 'warn', 'error'][level] ?? `lvl${level}`
    console.log(`[renderer-console:${levelLabel}] ${message} (${sourceId}:${line})`)
  })

  // ─── Renderer crash recovery ──────────────────────────────
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] Process gone: ${details.reason} (exitCode: ${details.exitCode})`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log('[renderer] Reloading window...')
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload()
        }
      }, 1000)
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[renderer] Window became unresponsive — waiting for recovery...')
  })

  mainWindow.webContents.on('responsive', () => {
    console.log('[renderer] Window is responsive again')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        shell.openExternal(url.toString())
      } else {
        console.warn(`[window] Blocked external URL with unsupported protocol: ${details.url}`)
      }
    } catch {
      console.warn(`[window] Blocked malformed external URL: ${details.url}`)
    }
    return { action: 'deny' }
  })

  // Load dev server or production build
  const isDev = !app.isPackaged
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).catch((err) => {
      console.error('[renderer] Failed to load dev renderer:', err)
    })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((err) => {
      console.error('[renderer] Failed to load bundled renderer:', err)
    })
  }

  const guardedWindow = mainWindow
  void installWebAuthnBlockerInWindow(guardedWindow, 'main-window').catch((err) => {
    console.warn('[main-window] WebAuthn passkey prompt guard failed:', err)
  })

  bindMainWindowRuntime?.(guardedWindow)
}

app.on('second-instance', () => {
  void ensureMainWindow('second-instance')
})

if (gotTheLock) app.whenReady().then(async () => {
  // Set app user model id for Windows
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.agent-stats.app')
  }

  // Production-only CSP — in dev mode, Vite HMR needs permissive policies
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
          ]
        }
      })
    })
  }

  // Initialize log capture first (captures all subsequent logs)
  initializeLogCapture()

  // Initialize all IPC handlers
  registerCredentialHandlers()
  registerUsageHandlers()
  registerSettingsHandlers()
  registerStorageMaintenanceHandlers()
  initUsageHistory()

  // Each app start gives lightly-failing services a clean shot. Without this,
  // accumulated failures (sometimes thousands) keep the backoff guard locked
  // for hours and the user sees scrapers "skipping scheduled refresh"
  // indefinitely. Chronically failing services (>=6 consecutive failures)
  // keep their backoff so a failure storm survives restarts.
  try {
    const reset = resetAllBackoffState(6)
    if (reset.rowsAffected > 0) {
      console.log(`[startup] Cleared backoff state for ${reset.rowsAffected} services`)
    }
  } catch (err) {
    console.warn('[startup] Failed to clear backoff state:', err)
  }

  try {
    const result = pruneSafeBrowserStorage(app.getPath('userData'))
    console.log(`[startup] Safe storage prune reclaimed ${Math.round(result.removedBytes / 1024 / 1024)}MB`)
  } catch (err) {
    console.warn('[startup] Safe storage prune failed:', err)
  }

  // Load persisted usage cache from disk (instant — shows last-known data)
  loadCacheFromDisk()

  await createWindow()


  // Reap managed Chromes left behind by a prior crash/hard-kill (detached + unref).
  // PID-only; only processes whose command line targets agent-stats/managed-chrome.
  try {
    const reaped = reapOrphanManagedChromes()
    if (reaped > 0) {
      console.log(`[startup] Reaped ${reaped} orphan managed Chrome process(es)`)
    }
  } catch (err) {
    console.warn('[startup] Orphan managed Chrome reap failed:', err)
  }

  startNetworkGuard()
  onAppNetworkOffline(() => {
    console.log('[network] Closing managed Chromes so they do not hold the adapter')
    void closeAllManagedChrome()
  })

  // Background warm-up: scrape all due services (non-blocking).
  // usage-refresh-complete is emitted by warmUpAllServices itself when a real
  // run finishes — do not fire a false complete on coalesced no-ops.
  let initialWarmupDone = false
  warmUpAllServices().then((result) => {
    initialWarmupDone = true
    // Counts as a completed poll so window-show/restore right after start-up
    // doesn't immediately fire another full scrape.
    if (result.ran) {
      lastPollCompletedAt = Date.now()
    }
  }).catch((err) =>
    console.error('[startup] Warm-up error:', err)
  )

  // 10-Minute Polling Loop — with lock to prevent stacking
  let isPolling = false
  let lastPollCompletedAt = 0
  // Event-driven triggers (window show/restore, power resume) must not each
  // fire a full scrape burst — skip them when a poll finished recently.
  const EVENT_POLL_MIN_INTERVAL_MS = 5 * 60 * 1000

  // Shared poll helper — respects the isPolling lock
  async function triggerPoll(source: string, minIntervalSinceLastMs = 0): Promise<void> {
    if (isPolling) {
      console.log(`[${source}] Previous poll still running — skipping`)
      return
    }
    // Usage collection is a background responsibility: a minimized or hidden
    // dashboard must not prevent the scheduled refresh from running.
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log(`[${source}] Window not ready — skipping`)
      return
    }
    if (minIntervalSinceLastMs > 0 && lastPollCompletedAt > 0) {
      const sinceLastMs = Date.now() - lastPollCompletedAt
      if (sinceLastMs < minIntervalSinceLastMs) {
        console.log(`[${source}] Last poll completed ${Math.round(sinceLastMs / 1000)}s ago — skipping event-triggered poll`)
        return
      }
    }

    if (!isAppOnline()) {
      console.log(`[${source}] Offline — skipping poll`)
      return
    }

    isPolling = true
    console.log(`[${source}] Triggering usage poll...`)

    const POLL_TIMEOUT = 8 * 60 * 1000
    const timeoutId = setTimeout(() => {
      console.warn(`[${source}] Poll exceeded 8-minute timeout — releasing lock`)
      isPolling = false
    }, POLL_TIMEOUT)

    try {
      const result = await warmUpAllServices()
      // Only a real run advances the event-poll throttle. Coalesced waiters must
      // not pretend a second full cycle finished (that was silencing cards).
      if (result.ran) {
        lastPollCompletedAt = Date.now()
      } else if (result.coalesced) {
        console.log(`[${source}] Coalesced onto in-flight warm-up — not advancing poll clock`)
      }
      // refresh-complete is broadcast by warmUpAllServices on real completion
    } catch (err) {
      console.error(`[${source}] Polling error:`, err)
    } finally {
      clearTimeout(timeoutId)
      isPolling = false
    }
  }

  pollingInterval = setInterval(() => {
    triggerPoll('interval')
  }, 10 * 60 * 1000)

  // Pause/resume polling on system suspend/resume
  powerMonitor.on('suspend', () => {
    console.log('[power] System suspending — polling will skip')
  })

  powerMonitor.on('resume', () => {
    console.log('[power] System resumed — triggering immediate refresh')
    triggerPoll('power-resume', EVENT_POLL_MIN_INTERVAL_MS)
  })

  bindMainWindowRuntime = (win: BrowserWindow): void => {
    win.on('show', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      setManagedChromeAppForeground(true)
      if (!initialWarmupDone) return
      console.log('[window] Window shown — triggering immediate refresh')
      void triggerPoll('window-show', EVENT_POLL_MIN_INTERVAL_MS)
    })

    win.on('restore', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      setManagedChromeAppForeground(true)
      if (!initialWarmupDone) return
      console.log('[window] Window restored — triggering immediate refresh')
      void triggerPoll('window-restore', EVENT_POLL_MIN_INTERVAL_MS)
    })

    win.on('minimize', () => {
      setManagedChromeAppForeground(false)
    })

    win.on('hide', () => {
      setManagedChromeAppForeground(false)
    })
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    bindMainWindowRuntime(mainWindow)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })

})

// Properly handle terminal kill signals to ensure we reach before-quit
const handleExit = () => {
  console.log('[shutdown] Received kill signal. Quitting app...')
  app.quit()
}
process.on('SIGINT', handleExit)
process.on('SIGTERM', handleExit)
process.on('SIGQUIT', handleExit)

// Electron does NOT await async `before-quit` listeners. Without preventDefault the
// process tore down at our first `await` below, so closeAllManagedChrome() never ran
// and every managed Chrome (spawned detached + unref'd) outlived the app. We hold the
// quit open, run teardown, then quit for real — with a hard cap so a wedged Chrome
// cannot make quitting hang: closeManagedChrome() waits up to 5s PER instance.
const SHUTDOWN_TIMEOUT_MS = 10_000
let shutdownComplete = false

app.on('before-quit', (event) => {
  if (shutdownComplete) return // second pass: let Electron finish the quit
  isQuitting = true
  // Release the lock before teardown so a new run.bat can start immediately
  // instead of dying against a half-quit process.
  app.releaseSingleInstanceLock()
  event.preventDefault()

  void (async () => {
    console.log('[shutdown] Application is quitting...')

    // Clear polling interval
    if (pollingInterval) {
      clearInterval(pollingInterval)
      pollingInterval = null
    }

    const teardown = async (): Promise<void> => {
      // Persist any pending debounced cache writes before the process exits
      await flushCacheToDisk().catch((err) =>
        console.warn('[shutdown] Failed to flush usage cache:', err)
      )

      // Close the usage history database cleanly
      closeUsageHistory()

      await closeAllManagedChrome().catch((err) =>
        console.warn('[shutdown] Failed to close managed Chrome:', err)
      )
    }

    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      teardown(),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(() => {
          console.warn(`[shutdown] Teardown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — quitting anyway`)
          resolveTimeout()
        }, SHUTDOWN_TIMEOUT_MS)
      })
    ])
    if (timer) clearTimeout(timer)

    // Close any open login/scraper windows instantly without dispatching unload events
    const allWindows = BrowserWindow.getAllWindows()
    for (const window of allWindows) {
      if (window !== mainWindow && !window.isDestroyed()) {
        console.log(`[shutdown] Force-destroying hidden/login window (ID: ${window.id})`)
        window.destroy() // Completely bypasses DOM unload intercepts
      }
    }

    shutdownComplete = true
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (shouldQuitWhenLastWindowCloses(process.platform)) {
    console.log('[window] Last window closed — quitting')
    app.quit()
    return
  }
  console.log('[window] Last window closed — staying in dock')
})

export { mainWindow }
