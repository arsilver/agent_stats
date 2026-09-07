import { ipcMain, app, session, BrowserWindow } from 'electron'
import { readFileSync, existsSync, promises as fsPromises } from 'fs'
import { join } from 'path'
import { getAllProfiles, getProfile } from './authProfiles'
import { getScraper, getAllScrapers } from './scrapers'
import type { ScrapeFailureReason } from './scrapers/baseScraper'
import type { UsageData } from '../shared/usageTypes'
import { validateAndReconcileUsage } from './usageIntegrity'
import { createStaleUsageData, isUsageDataStale } from './usageFreshness'
import {
  saveUsageSnapshot,
  getAllUsageHistory,
  getLatestUsageSnapshot,
  recordServiceSuccess,
  recordServiceFailure,
  getServiceHealth,
  maybePruneUsageHistory
} from './usageHistory'
import { getCredentialInternal } from './credentialManager'
import { isServiceEnabled } from './settingsStore'
import { clearManagedChromeProfile, waitForLoginComplete, setManagedChromeLaunchAllowed, closeAllManagedChrome, listRunningManagedChrome } from './managedChrome'
import { installWebAuthnBlockerInWindow } from './browserPromptGuards'
import { isAppOnline } from './networkGuard'
import { CURSOR_WRITE_PATH } from '../shared/cursorUsage'
import { getServiceContract } from './serviceContracts'
import { fetchViaAPI, isPrimaryOfficialAPIService } from './apiFetchers'
import {
  addSubModelCountdowns,
  attachCanonicalMetrics,
  CACHE_TTL,
  calculateCountdown,
  createRefreshCoordinator
} from './refreshCoordinator'
import type { WarmUpResult } from './refreshCoordinator'

export type { WarmUpResult } from './refreshCoordinator'

// ─── Disk-backed cache (simple JSON file) ────────────────────

const CACHE_SCHEMA_VERSION = 2

interface CacheFile {
  schema_version: number
  services: Record<string, UsageData>
}

function getCacheFilePath(): string {
  return join(app.getPath('userData'), 'usage-cache.json')
}

function migrateCacheFile(raw: unknown): CacheFile {
  if (raw && typeof raw === 'object' && 'schema_version' in raw && 'services' in raw) {
    const cache = raw as Partial<CacheFile>
    const version = typeof cache.schema_version === 'number' ? cache.schema_version : 0
    const services = (cache.services && typeof cache.services === 'object'
      ? cache.services
      : {}) as Record<string, UsageData>
    if (version === CACHE_SCHEMA_VERSION) {
      return { schema_version: CACHE_SCHEMA_VERSION, services }
    }
    // Future: insert per-version migration steps here.
    console.log(`[cache] Migrating from v${version} to v${CACHE_SCHEMA_VERSION}`)
    return { schema_version: CACHE_SCHEMA_VERSION, services }
  }

  // v0: flat object keyed by serviceId. Pre-versioning shape.
  if (raw && typeof raw === 'object') {
    console.log(`[cache] Migrating from v0 (flat) to v${CACHE_SCHEMA_VERSION}`)
    return {
      schema_version: CACHE_SCHEMA_VERSION,
      services: raw as Record<string, UsageData>
    }
  }

  return { schema_version: CACHE_SCHEMA_VERSION, services: {} }
}

function readCacheFile(): Record<string, UsageData> {
  try {
    const filePath = getCacheFilePath()
    if (!existsSync(filePath)) return {}
    const raw = readFileSync(filePath, 'utf8')
    return migrateCacheFile(JSON.parse(raw)).services
  } catch {
    return {}
  }
}

// ─── Debounced, atomic disk persistence ──────────────────────
// The in-memory map is authoritative. cacheSet() only marks the cache dirty
// and schedules a debounced flush, so a full refresh cycle performs ONE async
// write instead of a full read+write per service success. Flushes are atomic
// (write to a .tmp file, then rename) so a crash mid-write can't corrupt the
// cache.
let cacheDiskDirty = false
let cacheFlushTimer: NodeJS.Timeout | null = null
let cacheFlushRunning: Promise<void> | null = null

function scheduleCacheFlush(): void {
  cacheDiskDirty = true
  if (cacheFlushTimer) return
  cacheFlushTimer = setTimeout(() => {
    cacheFlushTimer = null
    void flushCacheToDisk()
  }, 2000)
}

async function writeCacheFileAtomic(services: Record<string, UsageData>): Promise<void> {
  const payload: CacheFile = { schema_version: CACHE_SCHEMA_VERSION, services }
  const filePath = getCacheFilePath()
  const tmpPath = `${filePath}.tmp`
  await fsPromises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
  await fsPromises.rename(tmpPath, filePath)
}

export async function flushCacheToDisk(): Promise<void> {
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer)
    cacheFlushTimer = null
  }
  if (!cacheDiskDirty) return
  if (cacheFlushRunning) return cacheFlushRunning

  cacheFlushRunning = (async () => {
    while (cacheDiskDirty) {
      cacheDiskDirty = false
      // Only persist 'ok' entries — error/login_required states stay memory-only
      // so they never overwrite good cached data.
      const services: Record<string, UsageData> = {}
      for (const [key, value] of usageCache) {
        if (value.status === 'ok') services[key] = value
      }
      try {
        await writeCacheFileAtomic(services)
      } catch (err) {
        console.error('[cache] Failed to write cache file:', err)
        // Retry on the next scheduled flush; mark dirty so data isn't lost.
        cacheDiskDirty = true
        break
      }
    }
  })().finally(() => {
    cacheFlushRunning = null
    // If new dirt accumulated while flushing, schedule the next round.
    if (cacheDiskDirty) scheduleCacheFlush()
  })

  return cacheFlushRunning
}

// In-memory fast cache, loaded from disk on startup
const usageCache: Map<string, UsageData> = new Map()

// ─── Refresh orchestration seam ──────────────────────────────
// The per-service refresh decision tree, retry/timeout/failure shaping, commit
// funnel, and warm-up pool live in refreshCoordinator (electron-free, so the
// shared scrape rules are assertable behavior). This module keeps the glue:
// module state, cache file I/O, IPC registration, timers/polling, and
// countdown recomputation on reads. The factory call below binds the real
// modules to the coordinator's ports; tests bind fakes instead.
const refreshCoordinator = createRefreshCoordinator({
  scrapers: {
    getScraper,
    fetchViaAPI,
    isPrimaryOfficialAPIService,
    setManagedChromeLaunchAllowed
  },
  sink: {
    readCacheRow: (serviceId) => usageCache.get(serviceId),
    writeCacheRow: (serviceId, data) => { usageCache.set(serviceId, data) },
    scheduleCacheFlush,
    flushCacheToDisk,
    saveSnapshot: saveUsageSnapshot,
    readLatestSnapshot: getLatestUsageSnapshot,
    recordServiceSuccess,
    recordServiceFailure,
    getServiceHealth,
    broadcastUsageProgress,
    broadcastRefreshComplete
  },
  isServiceEnabled,
  isOnline: isAppOnline,
  getCredential: getCredentialInternal,
  noteGlobalRefresh: updateRefreshTimes,
  closeAllManagedChrome,
  pruneUsageHistory: maybePruneUsageHistory
})

const fetchServiceUsage = refreshCoordinator.fetchServiceUsage
const fetchEnabledServicesBounded = refreshCoordinator.fetchEnabledServicesBounded
const cacheSet = refreshCoordinator.cacheSet
const createUsageShell = refreshCoordinator.createUsageShell
const createSessionActionResult = refreshCoordinator.createSessionActionResult
const withRenewalOverride = refreshCoordinator.withRenewalOverride

/**
 * Load persisted cache from disk into memory.
 */
export function loadCacheFromDisk(): void {
  const all = readCacheFile()
  let okCount = 0
  let skippedCount = 0
  let migratedFailureCount = 0
  let repairedCount = 0
  for (const [key, value] of Object.entries(all)) {
    if (value && typeof value === 'object' && 'service' in value) {
      const data = value as UsageData
      // Only load 'ok' entries — stale login_required/error states will be
      // re-evaluated when the scraper runs
      if (data.status === 'ok') {
        const integrity = validateAndReconcileUsage(key, data)
        if (integrity.disposition === 'rejected') {
          console.warn(`[${key}] Usage integrity rejected cached reading: ${integrity.reason}`)
          skippedCount++
          continue
        }

        let cacheData = integrity.data
        // Per-service cache-load rules (Qwen clone-weekly drop, Cursor pool
        // sanitize) — contract lookup covers both the map key and the row's
        // own service field, matching the legacy `key === 'x' || service` checks.
        for (const contractId of new Set([key, cacheData.service])) {
          const onCacheLoad = getServiceContract(contractId).onCacheLoad
          if (!onCacheLoad) continue
          const loaded = onCacheLoad(cacheData)
          cacheData = loaded.data
          if (loaded.repaired) repairedCount++
        }
        if (integrity.disposition === 'repaired') {
          repairedCount++
          console.log(`[${key}] Usage integrity repaired cached reading: ${integrity.reason}`)
        }
        if (isUsageDataStale(data) && !data.isStale) {
          const failedAttemptAt = data.lastRefreshAttemptAt ?? data.lastFetched ?? new Date().toISOString()
          const snapshotFallback = refreshCoordinator.applyLatestSnapshotFallback(cacheData, key)
          const fallbackIntegrity = validateAndReconcileUsage(key, snapshotFallback)
          const lastGood = fallbackIntegrity.disposition === 'rejected'
            ? cacheData
            : fallbackIntegrity.data
          if (fallbackIntegrity.disposition === 'repaired') {
            repairedCount++
            console.log(`[${key}] Usage integrity repaired history fallback: ${fallbackIntegrity.reason}`)
          }
          cacheData = createStaleUsageData(
            lastGood,
            failedAttemptAt,
            data.error ?? 'Refresh failed — showing last known data'
          )
          migratedFailureCount++
        }

        usageCache.set(
          key,
          cacheData.metrics && cacheData.metrics.length > 0
            ? {
                ...cacheData,
                grokBotResetCountdown: calculateCountdown(cacheData.grokBotResetsAt ?? null),
                subModels: addSubModelCountdowns(cacheData.subModels)
              }
            : attachCanonicalMetrics(key, cacheData, 'cache')
        )
        okCount++
      } else {
        skippedCount++
      }
    }
  }
  if (migratedFailureCount > 0 || repairedCount > 0) scheduleCacheFlush()
  console.log(
    `[cache] Loaded ${okCount} services from disk ` +
    `(skipped ${skippedCount}, migrated ${migratedFailureCount} failed refreshes, repaired ${repairedCount})`
  )
}

/**
 * Short, user-readable label for a ScrapeFailureReason. Used by the reconnect
 * IPC handler to surface why a fresh sign-in didn't actually fix anything,
 * instead of letting the renderer show the same generic "cookies expired".
 */
function failureReasonLabel(reason: NonNullable<ScrapeFailureReason>): string {
  switch (reason) {
    case 'login_required':
      return 'still signed out — sign-in did not stick.'
    case 'managed_browser_inactive':
      return 'managed Chrome session is no longer active.'
    case 'cookie_import_blocked':
      return 'Chrome is locking the cookie store. Close Chrome and try again.'
    case 'cloudflare_blocked':
      return 'Cloudflare blocked the request. Try again in a minute.'
    case 'page_not_ready':
      return 'the dashboard page never finished loading.'
    case 'extract_failed':
      return 'signed in, but the dashboard layout did not match — the page may have changed.'
    default:
      return String(reason)
  }
}

// Track refresh times
let nextGlobalRefresh: Date | null = null
let lastGlobalRefresh: Date | null = null

export function getNextGlobalRefresh(): Date | null {
  return nextGlobalRefresh
}

export function getLastGlobalRefresh(): Date | null {
  return lastGlobalRefresh
}

function updateRefreshTimes(): void {
  lastGlobalRefresh = new Date()
  nextGlobalRefresh = new Date(Date.now() + CACHE_TTL)
  console.log(`[refresh] Last: ${lastGlobalRefresh.toISOString()}, Next: ${nextGlobalRefresh.toISOString()}`)
}

function broadcastUsageProgress(serviceId: string, usage: UsageData): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('usage:progress', { serviceId, usage })
    }
  }
}

function broadcastRefreshComplete(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('usage-refresh-complete')
    }
  }
}

const USAGE_IPC_CHANNELS = [
  'usage:fetch',
  'usage:getCached',
  'usage:reconnect',
  'usage:openLogin',
  'usage:disconnect',
  'usage:importCookies',
  'usage:openLoginHailuo',
  'usage:openLoginAgent',
  'usage:warmUp',
  'usage:getRefreshTimes',
  'usage:getHistory',
  'usage:getIpcStatus',
  'usage:closeBrowsers',
  'usage:getBrowserStatus'
] as const

const registeredUsageIpcHandlers = new Set<string>()
type IpcHandleListener = Parameters<typeof ipcMain.handle>[1]

// Reconnect coalescing state (IPC glue; per-service fetch coalescing lives in
// the coordinator).
const inFlightReconnects = new Map<string, Promise<{ success: boolean; error?: string; usage?: UsageData }>>()

function registerUsageIpcHandler(channel: typeof USAGE_IPC_CHANNELS[number], listener: IpcHandleListener): void {
  try {
    ipcMain.removeHandler(channel)
  } catch (err) {
    console.warn(`[usageFetcher] Could not clear previous IPC handler for ${channel}:`, err)
  }
  ipcMain.handle(channel, listener)
  registeredUsageIpcHandlers.add(channel)
}


/**
 * Background warm-up: fetch all services without blocking.
 * Services that are still within their own refresh cadence (per-service TTL)
 * are skipped unless `force` is set — the poll interval must not override
 * per-service cadences such as MiniMax's 5 hours.
 *
 * Concurrent callers coalesce onto one in-flight run. Only a real run
 * ({ ran: true }) should advance poll completion / event-throttle clocks —
 * a silent no-op used to falsely fire usage-refresh-complete and freeze the
 * 5-minute event debounce.
 *
 * Implementation lives in refreshCoordinator; this delegate keeps the
 * historical usageFetcher export for index.ts and the usage:warmUp IPC.
 */
export async function warmUpAllServices(force = false): Promise<WarmUpResult> {
  return refreshCoordinator.warmUpAllServices(force)
}

/**
 * Register all usage-related IPC handlers.
 */
export function registerUsageHandlers(): void {
  registerUsageIpcHandler('usage:fetch', async (event, serviceId?: string, force?: boolean) => {
    if (serviceId) {
      const result = await fetchServiceUsage(serviceId, force ?? true)
      broadcastUsageProgress(serviceId, result)
      if (result.status === 'ok') {
        updateRefreshTimes()
      }
      return result
    }

    const sender = event?.sender
    const fetched = await fetchEnabledServicesBounded({
      force: force ?? true,
      timeoutMs: 90_000,
      timeoutLabel: 'usage:fetch 90s budget',
      skipFresh: false,
      logPrefix: 'usage:fetch',
      onEach: (serviceId, usage) => {
        if (sender && !sender.isDestroyed()) {
          sender.send('usage:progress', { serviceId, usage })
        }
      }
    })

    if (fetched.some((usage) => usage.status === 'ok')) {
      updateRefreshTimes()
    }

    await flushCacheToDisk()

    const fetchedById = new Map(fetched.map((usage) => [usage.service, usage]))
    return getAllProfiles().map((p) => {
      if (!isServiceEnabled(p.id)) {
        return { ...createUsageShell(p), status: 'disabled' as const }
      }
      return fetchedById.get(p.id) ?? createUsageShell(p)
    })
  })

  registerUsageIpcHandler('usage:getCached', async () => {
    // Return from memory cache (loaded from disk on startup)
    if (usageCache.size === 0) {
      return getAllProfiles().map((p) => createUsageShell(p))
    }

    // Merge: return cached data for known services + empty shells for uncached
    const profiles = getAllProfiles()
    return Promise.all(profiles.map(async (p) => {
      if (!isServiceEnabled(p.id)) {
        return {
          ...createUsageShell(p),
          status: 'disabled' as const
        }
      }
      const cached = usageCache.get(p.id)
      if (cached) {
        // Per-service read-side demotion (Cursor: incomplete rows go stale).
        const contract = getServiceContract(p.id)
        const safeCached = contract.demoteIncompleteRead?.(cached) ?? cached
        safeCached.resetCountdown = calculateCountdown(safeCached.resetsAt)
        safeCached.weeklyResetCountdown = calculateCountdown(safeCached.weeklyResetsAt)
        if (safeCached.subModels) {
          safeCached.subModels = addSubModelCountdowns(safeCached.subModels)
        }
        safeCached.refreshIntervalMs = p.refreshIntervalMs
        const normalized = safeCached.metrics && safeCached.metrics.length > 0
          ? safeCached
          : attachCanonicalMetrics(p.id, safeCached, 'cache')
        const displayable = contract.demoteIncompleteRead?.(normalized) ?? normalized
        usageCache.set(p.id, displayable)
        return withRenewalOverride(displayable)
      }
      return createUsageShell(p)
    }))
  })

  registerUsageIpcHandler('usage:reconnect', async (event, serviceId: string, clean = false) => {
    const existing = inFlightReconnects.get(serviceId)
    if (existing) {
      console.log(`[reconnect:${serviceId}] Reusing in-flight reconnect`)
      return existing
    }

    const reconnectPromise = (async () => {
    const scraper = getScraper(serviceId)
    const profile = getProfile(serviceId)
    console.log(`[reconnect:${serviceId}] Received usage:reconnect IPC request (clean=${clean})`)

    if (!scraper || !profile) {
      console.log(`[reconnect:${serviceId}] No scraper/profile registered`)
      return { success: false, error: 'No scraper for this service' }
    }

    try {
      if (clean) {
        console.log(`[reconnect:${serviceId}] Clean reconnect requested — clearing partition storage`)
        const ses = session.fromPartition(scraper.getPartition())
        await ses.clearStorageData()
        const cleanManagedConfig = scraper.getManagedChromeConfig()
        if (cleanManagedConfig) {
          await clearManagedChromeProfile(cleanManagedConfig)
        }
        usageCache.delete(serviceId)
      }

      console.log(`[reconnect:${serviceId}] Opening login window...`)
      await scraper.openLoginWindow()
      const loginOutcome = scraper.getLastLoginOutcome()
      console.log(`[reconnect:${serviceId}] Login window closed. outcome=${loginOutcome}`)

      const managedConfig = scraper.getManagedChromeConfig()
      if (managedConfig) {
        // 5-minute window: long enough for Cloudflare + manual sign-in + 2FA.
        // The wait returns early if the user closes the Chrome window (gives up).
        const LOGIN_TIMEOUT_MS = 300_000
        console.log(`[reconnect:${serviceId}] Managed Chrome configured, waiting for login completion (up to ${LOGIN_TIMEOUT_MS / 1000}s, or until user closes Chrome)...`)
        const loginComplete = await waitForLoginComplete(
          managedConfig,
          profile.dashboardUrl || managedConfig.startUrl,
          LOGIN_TIMEOUT_MS
        )
        if (!loginComplete) {
          console.log(`[reconnect:${serviceId}] Managed Chrome login did not complete (timeout or window closed)`)
          const usage = createSessionActionResult(profile, 'login_required', usageCache.get(serviceId))
          cacheSet(serviceId, usage)
          broadcastUsageProgress(serviceId, usage)
          return {
            success: false,
            usage,
            error: 'Sign-in was not completed. Click Reconnect, sign in (and pass any "verify you are human" check) in the Chrome window that opens, then leave it open until this card refreshes.'
          }
        }
        console.log(`[reconnect:${serviceId}] Managed Chrome login completed`)
      } else if (loginOutcome === 'cancelled') {
        // For BrowserWindow services, distinguish "user closed without signing
        // in" from "scrape failure" so we don't show a misleading
        // cookies_expired badge again. Pass undefined so createSessionActionResult
        // doesn't auto-promote to cookies_expired based on cached lastFetched.
        console.log(`[reconnect:${serviceId}] User closed login window without signing in — reporting login_required`)
        const usage = createSessionActionResult(profile, 'login_required', undefined)
        usage.error = 'Sign-in window was closed before completing login.'
        cacheSet(serviceId, usage)
        broadcastUsageProgress(serviceId, usage)
        return {
          success: false,
          usage,
          error: 'You closed the sign-in window before completing the login. Click Reconnect and complete sign-in this time.'
        }
      }

      console.log(`[reconnect:${serviceId}] Running fresh scrape with new cookies...`)
      const usage = await fetchServiceUsage(serviceId, true)
      const failureReason = scraper.getLastFailureReason()
      console.log(`[reconnect:${serviceId}] Scrape result: status=${usage.status}, failureReason=${failureReason ?? 'none'}`)
      broadcastUsageProgress(serviceId, usage)
      if (usage.status === 'ok') {
        updateRefreshTimes()
      }
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('usage-refresh-complete')
      }

      if (usage.status === 'ok') {
        return { success: true, usage }
      }

      // Surface what actually went wrong instead of letting the user see the
      // same generic "cookies_expired" they had before clicking Reconnect.
      const reasonLabel = failureReason
        ? failureReasonLabel(failureReason)
        : usage.error || 'Sign-in completed but the dashboard did not return usage data.'
      const errorMsg = `Reconnect didn't complete: ${reasonLabel}`
      console.log(`[reconnect:${serviceId}] Returning failure to renderer: ${errorMsg}`)
      return { success: false, usage, error: errorMsg }
    } catch (err) {
      console.error(`[reconnect:${serviceId}] Unhandled error:`, err)
      return { success: false, error: String((err as any)?.message ?? err) }
    }
    })()

    inFlightReconnects.set(serviceId, reconnectPromise)
    try {
      return await reconnectPromise
    } finally {
      if (inFlightReconnects.get(serviceId) === reconnectPromise) {
        inFlightReconnects.delete(serviceId)
      }
    }
  })

  registerUsageIpcHandler('usage:openLogin', async (_event, serviceId: string) => {
    const scraper = getScraper(serviceId)
    console.log(`[usageFetcher] Received usage:openLogin IPC request for ${serviceId}`)

    if (!scraper) {
      console.error(`[usageFetcher] Error: No scraper found for serviceId: ${serviceId}`)
      return { success: false, error: 'No scraper for this service' }
    }

    try {
      console.log(`[usageFetcher] Spawning openLoginWindow for ${serviceId}`)
      await scraper.openLoginWindow()
      console.log(`[usageFetcher] openLoginWindow completed for ${serviceId}`)

      if (scraper.requiresExternalBrowserLogin() || scraper.usesManagedBrowserSession()) {
        const managedConfig = scraper.getManagedChromeConfig()
        if (managedConfig) {
          // Auto-detect login completion and auto-refresh for managed Chrome
          console.log(`[usageFetcher] Starting auto-detection of login for ${serviceId}`)
          const profile = getProfile(serviceId)
          const dashboardUrl = profile?.dashboardUrl || managedConfig.startUrl

          // Start background task to wait for login and trigger refresh
          const mainWindow = BrowserWindow.getAllWindows()[0]
          ;(async () => {
            try {
              const loginComplete = await waitForLoginComplete(managedConfig, dashboardUrl, 120000)
              if (loginComplete) {
                console.log(`[usageFetcher] Login detected for ${serviceId}, triggering auto-refresh`)
                const usage = await fetchServiceUsage(serviceId, true)
                broadcastUsageProgress(serviceId, usage)
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('usage-refresh-complete')
                }
              } else {
                console.log(`[usageFetcher] Login timeout for ${serviceId}, user may need to refresh manually`)
              }
            } catch (err) {
              console.error(`[usageFetcher] Auto-refresh error for ${serviceId}:`, err)
            }
          })()

          return {
            success: true,
            pendingManualImport: true,
            message: 'Complete login in the Chrome window that opened. The app will automatically detect when you\'re signed in and refresh your usage data.'
          }
        }

        return {
          success: true,
          pendingManualImport: true,
          message: scraper.requiresExternalBrowserLogin()
            ? 'Complete login in Chrome, then return to Agent Stats and reconnect or refresh this service.'
            : 'Complete login in the Chrome window that opened, then click Refresh. Future refreshes will stay passive and will not reopen the browser by themselves.'
        }
      }

      // After login, try to fetch immediately
      const usage = await fetchServiceUsage(serviceId, true)
      return { success: true, usage }
    } catch (err) {
      console.error(`[usageFetcher] openLoginWindow failed for ${serviceId}:`, err)
      return { success: false, error: String(err) }
    }
  })

  // Wipe a service's Electron partition (cookies, localStorage, IDB, service workers)
  // and remove its cached usage entry, so the next Sign In is a clean new-account login.
  // For web_session services this clears all session data; for API-key services it just
  // wipes the cached usage entry.
  registerUsageIpcHandler('usage:disconnect', async (_event, serviceId: string) => {
    console.log(`[usageFetcher] Received usage:disconnect IPC request for ${serviceId}`)
    const scraper = getScraper(serviceId)
    const profile = getProfile(serviceId)

    try {
      // Clear Electron partition storage if this is a web_session service with a scraper
      if (scraper && profile?.authType === 'web_session') {
        const ses = session.fromPartition(scraper.getPartition())
        await ses.clearStorageData()
        const managedConfig = scraper.getManagedChromeConfig()
        if (managedConfig) {
          await clearManagedChromeProfile(managedConfig)
        }
      }

      // Always wipe memory cache; the debounced flush persists the removal
      // (the in-memory map is authoritative — disk only ever mirrors 'ok' entries).
      usageCache.delete(serviceId)
      scheduleCacheFlush()
      await flushCacheToDisk()

      console.log(`[usageFetcher] Disconnected ${serviceId}: partition cleared, cache removed`)
      return { success: true }
    } catch (err) {
      console.error(`[usageFetcher] Disconnect failed for ${serviceId}:`, err)
      return { success: false, error: String(err) }
    }
  })

  // Manual cookie import with retry — used when user quits Chrome.
  // Only refreshes services whose scrapers actually report a usable session
  // after the import; it no longer force-scrapes every service.
  registerUsageIpcHandler('usage:importCookies', async (_event, serviceId?: string) => {
    console.log('[usageFetcher] Manual cookie import triggered')
    const scrapers = getAllScrapers()
    const results: Record<string, boolean> = {}

    const targets = serviceId
      ? Object.entries(scrapers).filter(([id]) => id === serviceId)
      : Object.entries(scrapers)

    const importTargets = targets.filter(([, scraper]) => scraper.requiresExternalBrowserLogin())

    for (const [id, scraper] of importTargets) {
      const ok = await scraper.importChromeCookiesWithRetry(30000)
      results[id] = ok
    }

    console.log('[usageFetcher] Cookie import results:', results)

    // Refresh only the services we attempted to import for, and only when the
    // scraper reports a usable session. Non-forced so TTL/backoff still apply.
    for (const [id, scraper] of targets) {
      if (!isServiceEnabled(id)) continue
      try {
        const usableSession = await scraper.isLoggedIn()
        if (!usableSession) {
          console.log(`[usageFetcher] Post-import: ${id} has no usable session — skipping refresh`)
          continue
        }
        await fetchServiceUsage(id, false)
      } catch (err) {
        console.error(`[usageFetcher] Post-import fetch failed for ${id}:`, err)
      }
    }

    await flushCacheToDisk()

    return results
  })

  registerUsageIpcHandler('usage:openLoginHailuo', async () => {
    const scraper = getScraper('minimax')
    const partition = scraper ? `persist:scraper-minimax` : `persist:scraper-minimax`

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1000, height: 700,
        title: 'Login — Hailuo AI',
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false }
      })
      void (async () => {
        await installWebAuthnBlockerInWindow(win, 'hailuo-login')
        await win.loadURL('https://hailuoai.video/subscribe')
      })().catch((err) => {
        console.error('[login] Hailuo login window failed to load:', err)
      })

      // Auto-close after 10 minutes if user forgets
      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) {
          console.log('[login] Hailuo login window timed out after 10 minutes')
          win.destroy()
        }
      }, 10 * 60 * 1000)

      win.on('closed', () => {
        clearTimeout(timeout)
        resolve({ success: true })
      })
    })
  })

  registerUsageIpcHandler('usage:openLoginAgent', async () => {
    const partition = `persist:scraper-minimax`

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1000, height: 700,
        title: 'Login — MiniMax Agent',
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false }
      })
      void (async () => {
        await installWebAuthnBlockerInWindow(win, 'minimax-agent-login')
        await win.loadURL('https://agent.minimax.io/')
      })().catch((err) => {
        console.error('[login] MiniMax Agent login window failed to load:', err)
      })

      // Auto-close after 10 minutes if user forgets
      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) {
          console.log('[login] Agent login window timed out after 10 minutes')
          win.destroy()
        }
      }, 10 * 60 * 1000)

      win.on('closed', () => {
        clearTimeout(timeout)
        resolve({ success: true })
      })
    })
  })

  registerUsageIpcHandler('usage:warmUp', async () => {
    // Non-blocking: kick off warm-up in background
    warmUpAllServices().catch((err) =>
      console.error('[warmUp] Error:', err)
    )
    return { started: true }
  })

  registerUsageIpcHandler('usage:getRefreshTimes', () => {
    return {
      lastRefresh: lastGlobalRefresh?.toISOString() || null,
      nextRefresh: nextGlobalRefresh?.toISOString() || null
    }
  })

  registerUsageIpcHandler('usage:getHistory', (_event, days: number = 30) => {
    try {
      return getAllUsageHistory(days)
    } catch (err) {
      console.error('[usageFetcher] Failed to get history:', err)
      return []
    }
  })

  registerUsageIpcHandler('usage:closeBrowsers', async () => {
    const before = listRunningManagedChrome()
    const closed = await closeAllManagedChrome()
    console.log(`[usageFetcher] Closed ${closed} managed Chrome instance(s): ${before.join(', ') || 'none'}`)
    return { success: true, closed, services: before }
  })

  registerUsageIpcHandler('usage:getBrowserStatus', () => {
    const services = listRunningManagedChrome()
    return { running: services.length, services }
  })

  registerUsageIpcHandler('usage:getIpcStatus', () => {
    const expected = [...USAGE_IPC_CHANNELS]
    const registered = [...registeredUsageIpcHandlers].sort()
    const missing = expected.filter((channel) => !registeredUsageIpcHandlers.has(channel))
    return {
      ok: missing.length === 0,
      expected,
      registered,
      missing,
      cursorWritePath: CURSOR_WRITE_PATH
    }
  })
}
