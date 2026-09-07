// ─── Refresh Coordinator ─────────────────────────────────────
// Owns the per-service refresh decision tree (disabled/unknown shells →
// offline → TTL → health backoff → API path → scraper retry loop), the
// timeout/failure shaping (stale rows, transient-miss cache keep), the commit
// funnel (renewal/increase detection → contract hooks → snapshot → cache
// gate), and the bounded multi-service fetch used by warm-up and Refresh All.
//
// This module is deliberately electron-free and better-sqlite3-free so the
// shared scrape rules are assertable behavior in plain Node: every side
// effect goes through the two injected ports (ScraperSource / UsageSink) plus
// a small set of policy inputs. Production wiring lives in usageFetcher.ts as
// a single createRefreshCoordinator() call binding the real modules; tests
// bind fakes (see tests/refresh-coordinator-behavior-smoke.js).

import { getAllProfiles, getProfile } from './authProfiles'
import type { AuthProfile } from './authProfiles'
import type { ScrapedUsageData, ScrapeFailureReason } from './scrapers/baseScraper'
import type { SessionAction, UsageData, UsageMetric, UsageMetricSource } from '../shared/usageTypes'
import { metricsToSubModels, normalizeUsageMetrics } from './usageNormalizer'
import { validateAndReconcileUsage } from './usageIntegrity'
import { createStaleUsageData, isUsageDataFresh } from './usageFreshness'
import { cursorOfficialTotalPercent } from '../shared/cursorUsage'
import { getServiceContract } from './serviceContracts'
import { GROK_BOT_METRIC_ID } from './serviceContracts/grokContract'
import type { ServiceHealth, UsageSnapshot } from './usageHistory'

// ─── Ports ───────────────────────────────────────────────────

/** Minimal scraper surface the refresh orchestration drives (BaseScraper-compatible). */
export interface ScraperHandle {
  scrape(): Promise<ScrapedUsageData | null>
  cancelActiveScrape(reason?: string): void
  isLoggedIn(): Promise<boolean>
  usesManagedBrowserSession(): boolean
  requiresExternalBrowserLogin(): boolean
  getLastFailureReason(): ScrapeFailureReason
  readonly importError: string | null
}

/** Where usage readings come from: the scraper registry + official API routing. */
export interface ScraperSource {
  getScraper(serviceId: string): ScraperHandle | undefined
  fetchViaAPI(profile: AuthProfile, apiKey: string): Promise<Partial<UsageData> | null>
  isPrimaryOfficialAPIService(serviceId: string): boolean
  setManagedChromeLaunchAllowed(serviceId: string, allowed: boolean): void
}

/** Latest persisted history row for a service (usage_snapshots shape). */
export type LatestUsageSnapshot = UsageSnapshot & { timestamp: string }

/** Where refresh results go: cache rows, SQLite snapshots, health, events. */
export interface UsageSink {
  readCacheRow(serviceId: string): UsageData | undefined
  writeCacheRow(serviceId: string, data: UsageData): void
  scheduleCacheFlush(): void
  flushCacheToDisk(): Promise<void>
  saveSnapshot(snapshot: UsageSnapshot): void
  readLatestSnapshot(serviceId: string): LatestUsageSnapshot | null
  recordServiceSuccess(serviceId: string): void
  recordServiceFailure(serviceId: string, reason: string | null): void
  getServiceHealth(serviceId: string): ServiceHealth | null
  broadcastUsageProgress(serviceId: string, usage: UsageData): void
  broadcastRefreshComplete(): void
}

export interface RefreshLogger {
  log(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
}

export interface RefreshCoordinatorDeps {
  scrapers: ScraperSource
  sink: UsageSink
  isServiceEnabled(serviceId: string): boolean
  isOnline(): boolean
  getCredential(serviceId: string, key: string): Promise<string | null>
  /** Stamp the global refresh clock (usageFetcher's updateRefreshTimes). */
  noteGlobalRefresh(): void
  /** Offline warm-up path: close managed browsers so they release the adapter. */
  closeAllManagedChrome(): void
  /** Daily SQLite retention prune (internally guarded — cheap no-op otherwise). */
  pruneUsageHistory(): void
  /** Clock override for tests; defaults to Date.now. */
  now?(): number
  /** Log sink override for tests; defaults to console. */
  logger?: RefreshLogger
}

export interface BoundedFetchOptions {
  force: boolean
  timeoutMs: number
  timeoutLabel: string
  skipFresh: boolean
  logPrefix: string
  sort?: (a: AuthProfile, b: AuthProfile) => number
  onEach?: (serviceId: string, usage: UsageData) => void
}

export type WarmUpResult = {
  ran: boolean
  coalesced: boolean
}

export interface RefreshCoordinator {
  fetchServiceUsage(serviceId: string, force?: boolean): Promise<UsageData>
  fetchEnabledServicesBounded(options: BoundedFetchOptions): Promise<UsageData[]>
  warmUpAllServices(force?: boolean): Promise<WarmUpResult>
  cacheSet(serviceId: string, data: UsageData): void
  createUsageShell(profile: AuthProfile): UsageData
  createSessionActionResult(
    profile: AuthProfile,
    reason: ScrapeFailureReason,
    existing: UsageData | undefined
  ): UsageData
  applyLatestSnapshotFallback(base: UsageData, serviceId: string): UsageData
  withRenewalOverride(data: UsageData): Promise<UsageData>
}

// Default TTL: 10 minutes (used when a profile declares no refreshIntervalMs)
export const CACHE_TTL = 10 * 60 * 1000

/** Matches MAX_CONCURRENT_CHROME_LAUNCHES so Refresh All / warm-up don't queue past the spawn cap. */
const SERVICE_FETCH_CONCURRENCY = 2

/**
 * Deterministic per-service jitter multiplier in the range [0.80, 1.20].
 * Derived from a stable hash of the serviceId so the value never changes
 * between runs — services with the same nominal cadence land at different
 * offsets instead of all firing in one burst.
 */
function cadenceJitter(serviceId: string): number {
  let hash = 0
  for (let i = 0; i < serviceId.length; i++) {
    hash = (hash * 31 + serviceId.charCodeAt(i)) >>> 0
  }
  const magnitude = 0.10 + ((hash % 1000) / 1000) * 0.10 // 10%..20%
  const sign = hash % 2 === 0 ? -1 : 1
  return 1 + sign * magnitude
}

/**
 * Effective freshness window for a service: its declared refreshIntervalMs
 * (e.g. MiniMax's 5h) or the global TTL, with deterministic per-service
 * jitter applied.
 */
function getServiceCadenceMs(serviceId: string): number {
  const profile = getProfile(serviceId)
  const base = profile?.refreshIntervalMs ?? CACHE_TTL
  return base * cadenceJitter(serviceId)
}

/**
 * Calculate a human-readable countdown from a reset datetime.
 */
export function calculateCountdown(resetsAt: string | null): string | null {
  if (!resetsAt) return null

  try {
    const resetTime = new Date(resetsAt).getTime()
    const now = Date.now()
    const diff = resetTime - now

    if (diff <= 0) return 'Resetting now...'

    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))

    const parts: string[] = []
    if (days > 0) parts.push(`${days}d`)
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0) parts.push(`${minutes}m`)

    return parts.join(' ') || '< 1m'
  } catch {
    return resetsAt
  }
}

export function addSubModelCountdowns(subModels: UsageData['subModels']): UsageData['subModels'] {
  return subModels?.map((sm) => ({
    ...sm,
    resetCountdown: calculateCountdown(sm.resetsAt ?? null)
  }))
}

export function attachCanonicalMetrics(
  serviceId: string,
  data: UsageData,
  source: UsageMetricSource = 'scraper'
): UsageData {
  if (data.status !== 'ok') return data
  const metrics = normalizeUsageMetrics(serviceId, data, source)
  const projectedSubModels = metricsToSubModels(metrics)
  return {
    ...data,
    grokBotResetCountdown: calculateCountdown(data.grokBotResetsAt ?? null),
    metrics,
    subModels: addSubModelCountdowns(data.subModels ?? projectedSubModels)
  }
}

function getSessionActionMessage(
  profile: AuthProfile,
  reason: ScrapeFailureReason,
  importError: string | null,
  manualCookieRefresh: boolean,
  managedBrowserSession: boolean
): string | undefined {
  if (profile.authType !== 'web_session') return undefined

  if (managedBrowserSession) {
    if (reason === 'managed_browser_inactive') {
      return 'Reconnect this service to resume the managed browser session.'
    }

    if (reason === 'cloudflare_blocked') {
      return 'Managed Chrome could not load the usage page. Reconnect and sign in again.'
    }

    if (reason === 'login_required') {
      return 'Reconnect to sign in to the managed Chrome session.'
    }

    return 'Reconnect this service in the browser session.'
  }

  if (reason === 'cookie_import_blocked') {
    if (manualCookieRefresh) {
      return 'Chrome is still running. Finish signing in, then click Reconnect after Chrome has settled.'
    }
    return importError || 'Chrome is locking the cookie database. Close Chrome, then try again.'
  }

  if (reason === 'cloudflare_blocked') {
    if (manualCookieRefresh) {
      return 'The service blocked the embedded browser. Reconnect in the browser session to refresh your sign-in.'
    }
    return 'The embedded browser was blocked while refreshing usage.'
  }

  if (reason === 'extract_failed' || reason === 'page_not_ready') {
    return 'Couldn\'t read usage from the page. Your session may have expired; reconnect to refresh it.'
  }

  if (manualCookieRefresh) {
    return 'Open the browser session, sign in again, then reconnect this service.'
  }

  return importError || 'No session cookies found. Reconnect this service.'
}

function createSessionAction(
  profile: AuthProfile,
  reason: ScrapeFailureReason,
  importError: string | null,
  manualCookieRefresh: boolean,
  managedBrowserSession: boolean
): SessionAction | undefined {
  if (profile.authType !== 'web_session') return undefined

  return {
    kind: 'reconnect',
    label: 'Reconnect',
    detail: getSessionActionMessage(
      profile,
      reason,
      importError,
      manualCookieRefresh,
      managedBrowserSession
    ) || 'Reconnect your browser session, then refresh usage.',
    canCleanReconnect: reason !== 'cookie_import_blocked'
  }
}

function attachSessionAction(
  data: UsageData,
  profile: AuthProfile,
  reason: ScrapeFailureReason,
  importError: string | null,
  manualCookieRefresh: boolean,
  managedBrowserSession: boolean
): UsageData {
  const sessionAction = createSessionAction(
    profile,
    reason,
    importError,
    manualCookieRefresh,
    managedBrowserSession
  )
  return sessionAction ? { ...data, sessionAction } : data
}

function clearSessionAction(data: UsageData): UsageData {
  if (!data.sessionAction) return data
  const { sessionAction: _sessionAction, ...rest } = data
  return rest
}

function snapshotFromUsage(data: UsageData): UsageSnapshot {
  return {
    service: data.service,
    currentUsage: data.currentUsage,
    usageLimit: data.usageLimit,
    percentUsed: data.percentUsed,
    usageUnit: data.usageUnit,
    resetsAt: data.resetsAt,
    weeklyUsage: data.weeklyUsage,
    weeklyLimit: data.weeklyLimit,
    weeklyPercentUsed: data.weeklyPercentUsed,
    metrics: data.metrics ?? null,
    totalPercent: data.totalPercent ?? null,
    subModels: data.subModels?.map((sm) => ({
      name: sm.name || sm.modelName || 'Unknown',
      modelName: sm.modelName,
      count: sm.count,
      total: sm.total,
      resetsAt: sm.resetsAt
    })) ?? null,
    agentCredits: data.agentCredits || null
  }
}

// ─── Factory ─────────────────────────────────────────────────

export function createRefreshCoordinator(deps: RefreshCoordinatorDeps): RefreshCoordinator {
  const scrapers = deps.scrapers
  const sink = deps.sink
  const log: RefreshLogger = deps.logger ?? console
  const now: () => number = deps.now ?? (() => Date.now())

  /**
   * Fetch usage for a single service (API first, then fallback to scraper with TTL check).
   */
  const inFlightServiceUsageFetches = new Map<string, { force: boolean; promise: Promise<UsageData> }>()

  let warmUpDone = false
  let warmUpRunning = false
  let warmUpInFlight: Promise<WarmUpResult> | null = null

  /**
   * Save a single service's usage data to the in-memory cache (authoritative)
   * and schedule a debounced disk flush. Only 'ok' entries are written to
   * disk — error/login_required states are kept in memory only so they never
   * overwrite good cached data.
   *
   * Also records the result in the service_health table so we can apply
   * exponential backoff and surface persistent failures. Auth-state results
   * (login_required / cookies_expired) are NOT service-health failures and
   * never increment the backoff counter.
   */
  function cacheSet(serviceId: string, data: UsageData): void {
    // Per-service completeness gate (Cursor: refuse ok-without-official-Total).
    const refusal = getServiceContract(serviceId).refuseIncompleteOkRow?.(data)
    if (refusal) {
      log.warn(refusal.warn)
      sink.recordServiceFailure(serviceId, refusal.reason)
      return
    }

    const integrity = data.status === 'ok' ? validateAndReconcileUsage(serviceId, data) : null
    if (integrity?.disposition === 'rejected') {
      const reason = integrity.reason ?? 'usage integrity check failed'
      log.warn(`[${serviceId}] Usage integrity rejected cache write: ${reason}`)
      sink.recordServiceFailure(serviceId, reason)
      return
    }
    if (integrity?.disposition === 'repaired') {
      log.log(`[${serviceId}] Usage integrity repaired cache write: ${integrity.reason}`)
    }

    const integrityData = integrity?.data ?? data
    const normalizedData =
      integrityData.status === 'ok'
        ? integrityData.metrics && integrityData.metrics.length > 0
          ? { ...integrityData, subModels: addSubModelCountdowns(integrityData.subModels) }
          : attachCanonicalMetrics(serviceId, integrityData, 'cache')
        : integrityData

    sink.writeCacheRow(serviceId, normalizedData)

    if (normalizedData.status === 'ok' && !normalizedData.isStale) {
      sink.recordServiceSuccess(serviceId)
      sink.scheduleCacheFlush()
      return
    }

    if (normalizedData.status === 'ok' && normalizedData.isStale) {
      // Displayable last-known data is still a failed refresh. It must not reset
      // service health/backoff or be reported as a successful fetch.
      sink.recordServiceFailure(serviceId, normalizedData.error ?? 'Refresh failed — showing last known data')
      sink.scheduleCacheFlush()
      return
    }

    // 'disabled' and 'not_configured' are user-driven, not real failures.
    // 'login_required' and 'cookies_expired' are auth state, not service health —
    // counting them would trip the exponential backoff for services that are
    // perfectly reachable but simply signed out.
    if (normalizedData.status === 'error') {
      sink.recordServiceFailure(serviceId, normalizedData.error ?? normalizedData.status)
    }
  }

  /**
   * Check if cached data is still fresh for this service's own cadence
   * (profile.refreshIntervalMs ?? CACHE_TTL, with per-service jitter).
   */
  function isCacheFresh(serviceId: string): boolean {
    const cached = sink.readCacheRow(serviceId)
    if (!cached || !cached.lastFetched) return false
    if (!isUsageDataFresh(cached)) return false

    const age = now() - new Date(cached.lastFetched).getTime()
    return age < getServiceCadenceMs(serviceId)
  }

  /**
   * A CDP timeout or busy Chrome must not paint a 2-minute-old success as
   * "Stale / refresh failed". Keep the last good row Connected.
   */
  function keepFreshCacheOnTransientMiss(
    serviceId: string,
    fetchedAt: string,
    reason: string
  ): UsageData | null {
    const existing = sink.readCacheRow(serviceId)
    if (!existing || existing.status !== 'ok' || !existing.lastFetched || existing.isStale) {
      return null
    }
    const age = now() - new Date(existing.lastFetched).getTime()
    if (!Number.isFinite(age) || age >= getServiceCadenceMs(serviceId)) return null
    log.log(
      `[${serviceId}] Transient miss (${reason}) — keeping fresh cache (${Math.round(age / 1000)}s old)`
    )
    return {
      ...existing,
      lastRefreshAttemptAt: fetchedAt,
      isStale: false,
      error: undefined
    }
  }

  function applyLatestSnapshotFallback(base: UsageData, serviceId: string): UsageData {
    const latest = sink.readLatestSnapshot(serviceId)
    if (!latest) return base
    const usageUnit = latest.usageUnit || base.usageUnit
    const metrics = latest.metrics && latest.metrics.length > 0
      ? latest.metrics
      : normalizeUsageMetrics(serviceId, {
        currentUsage: latest.currentUsage,
        usageLimit: latest.usageLimit,
        percentUsed: latest.percentUsed,
        usageUnit,
        resetsAt: latest.resetsAt,
        weeklyUsage: latest.weeklyUsage,
        weeklyLimit: latest.weeklyLimit,
        weeklyPercentUsed: latest.weeklyPercentUsed,
        totalPercent: latest.totalPercent,
        subModels: latest.subModels ?? undefined,
        agentCredits: latest.agentCredits ?? undefined
      }, 'history')
    const totalPercent = cursorOfficialTotalPercent({
      totalPercent: latest.totalPercent,
      metrics,
      percentUsed: latest.percentUsed
    })

    // Per-service overlay gate (Cursor: history may overlay only with official Total).
    const overlayRefusal = getServiceContract(serviceId).refuseSnapshotOverlay?.({ totalPercent, metrics })
    if (overlayRefusal) {
      log.log(`[${serviceId}] Skipping history fallback ${overlayRefusal}`)
      return base
    }

    const botMetric = metrics.find((metric) => metric.id === GROK_BOT_METRIC_ID)

    return {
      ...base,
      currentUsage: latest.currentUsage,
      usageLimit: latest.usageLimit,
      usageUnit,
      percentUsed: latest.percentUsed,
      resetsAt: latest.resetsAt,
      resetCountdown: calculateCountdown(latest.resetsAt),
      weeklyUsage: latest.weeklyUsage,
      weeklyLimit: latest.weeklyLimit,
      weeklyPercentUsed: latest.weeklyPercentUsed,
      weeklyResetsAt: null,
      weeklyResetCountdown: null,
      lastFetched: latest.timestamp,
      totalPercent: totalPercent ?? latest.totalPercent ?? undefined,
      totalBarLabel: totalPercent != null ? 'Total' : base.totalBarLabel,
      grokBotPercentUsed: botMetric?.percent ?? botMetric?.value ?? base.grokBotPercentUsed ?? null,
      grokBotResetsAt: botMetric?.resetsAt ?? base.grokBotResetsAt ?? null,
      grokBotResetCountdown: calculateCountdown(botMetric?.resetsAt ?? base.grokBotResetsAt ?? null),
      metrics,
      subModels: addSubModelCountdowns(latest.subModels?.map((sm) => ({
        name: sm.name,
        modelName: sm.modelName || sm.name,
        count: sm.count,
        total: sm.total,
        resetsAt: sm.resetsAt ?? null
      })) ?? metricsToSubModels(metrics)),
      agentCredits: latest.agentCredits || undefined
    }
  }

  function createUsageShell(profile: AuthProfile): UsageData {
    const scraper = scrapers.getScraper(profile.id)
    const manualCookieRefresh = scraper?.requiresExternalBrowserLogin() ?? false
    const managedBrowserSession = scraper?.usesManagedBrowserSession() ?? false
    const shell: UsageData = {
      service: profile.id,
      displayName: profile.displayName,
      planTier: profile.planTier,
      currentUsage: 0,
      usageLimit: null,
      usageUnit: profile.usageUnit,
      percentUsed: null,
      resetsAt: null,
      resetCountdown: null,
      weeklyUsage: null,
      weeklyLimit: null,
      weeklyPercentUsed: null,
      weeklyResetsAt: null,
      weeklyResetCountdown: null,
      lastFetched: null,
      lastIncreasedAt: null,
      renewalDate: null,
      renewalKind: null,
      status:
        profile.authType === 'web_session'
          ? manualCookieRefresh
            ? 'cookies_expired'
            : managedBrowserSession
              ? 'login_required'
              : 'login_required'
          : 'not_configured',
      error:
        profile.authType === 'web_session'
          ? getSessionActionMessage(
            profile,
            'login_required',
            scraper?.importError ?? null,
            manualCookieRefresh,
            managedBrowserSession
          )
          : undefined,
      iconColor: profile.iconColor,
      manualCookieRefresh,
      refreshIntervalMs: profile.refreshIntervalMs,
      subModels: undefined
    }

    if (profile.authType === 'web_session') {
      shell.sessionAction = createSessionAction(
        profile,
        'login_required',
        scraper?.importError ?? null,
        manualCookieRefresh,
        managedBrowserSession
      )
    }

    const fallback = applyLatestSnapshotFallback(shell, profile.id)
    if (fallback.lastFetched && profile.authType === 'web_session') {
      const reason: ScrapeFailureReason = manualCookieRefresh ? 'cloudflare_blocked' : 'login_required'
      fallback.status = 'cookies_expired'
      fallback.error = getSessionActionMessage(
        profile,
        reason,
        scraper?.importError ?? null,
        manualCookieRefresh,
        managedBrowserSession
      )
      fallback.sessionAction = createSessionAction(
        profile,
        reason,
        scraper?.importError ?? null,
        manualCookieRefresh,
        managedBrowserSession
      )
    }

    return fallback
  }

  /**
   * Result returned when a per-service refresh exceeds its timeout. Preserves
   * any cached last-good data so the card doesn't blank out.
   *
   * Timeouts are NOT session expiry — do not mark cookies_expired (that pushes
   * the user into a reconnect flow when the scrape was merely slow).
   */
  function createTimeoutResult(
    profile: AuthProfile,
    existing: UsageData | undefined
  ): UsageData {
    const attemptedAt = new Date(now()).toISOString()
    const error =
      'This service did not respond within the refresh timeout. Showing last known data — try again.'

    if (existing && (existing.status === 'ok' || existing.lastFetched)) {
      return {
        ...createStaleUsageData(existing, attemptedAt, error),
        service: profile.id,
        displayName: profile.displayName,
        planTier: profile.planTier,
        iconColor: profile.iconColor,
        // Keep last-good bars; strip misleading session-action from a pure timeout.
        sessionAction: undefined
      }
    }

    return {
      ...createUsageShell(profile),
      status: 'error',
      error,
      lastRefreshAttemptAt: attemptedAt,
      iconColor: profile.iconColor
    }
  }

  async function withRenewalOverride(data: UsageData): Promise<UsageData> {
    try {
      const override = await deps.getCredential(data.service, 'renewalDate')
      if (!override) return data
      if (data.renewalDate === override && data.renewalKind === 'renewing') return data
      return { ...data, renewalDate: override, renewalKind: 'renewing' }
    } catch {
      return data
    }
  }

  function createSessionActionResult(
    profile: AuthProfile,
    reason: ScrapeFailureReason,
    existing: UsageData | undefined
  ): UsageData {
    const scraper = scrapers.getScraper(profile.id)
    const manualCookieRefresh = scraper?.requiresExternalBrowserLogin() ?? false
    const managedBrowserSession = scraper?.usesManagedBrowserSession() ?? false
    const base =
      existing && (existing.status === 'ok' || existing.lastFetched)
        ? existing
        : createUsageShell(profile)
    const status =
      base.lastFetched != null
        ? 'cookies_expired'
        : manualCookieRefresh
          ? 'cookies_expired'
          : 'login_required'

    return {
      ...base,
      service: profile.id,
      displayName: profile.displayName,
      planTier: profile.planTier,
      usageUnit: base.usageUnit || profile.usageUnit,
      status,
      error: getSessionActionMessage(
        profile,
        reason,
        scraper?.importError ?? null,
        manualCookieRefresh,
        managedBrowserSession
      ),
      iconColor: profile.iconColor,
      manualCookieRefresh,
      sessionAction: createSessionAction(
        profile,
        reason,
        scraper?.importError ?? null,
        manualCookieRefresh,
        managedBrowserSession
      )
    }
  }

  function commitSuccessfulScrape(
    serviceId: string,
    profile: AuthProfile,
    baseResult: UsageData,
    scraped: ScrapedUsageData,
    fetchedAt: string,
    supplementalApiMetrics: UsageMetric[]
  ): UsageData {
    const cachedExisting = sink.readCacheRow(serviceId)
    const scrapedRenewalDate =
      scraped.renewalDate ?? cachedExisting?.renewalDate ?? null
    const scrapedRenewalKind =
      scraped.renewalDate
        ? (scraped.renewalKind ?? 'renewing')
        : cachedExisting?.renewalKind ?? null

    let lastIncreasedAt: number | null = cachedExisting?.lastIncreasedAt ?? null
    if (scraped.percentUsed != null && cachedExisting && cachedExisting.percentUsed != null) {
      const prevP = cachedExisting.percentUsed
      const currP = scraped.percentUsed
      const isRem = !!(scraped.isRemainingTracker || cachedExisting.isRemainingTracker)
      const increased = isRem ? currP < prevP : currP > prevP
      if (increased) {
        lastIncreasedAt = now()
        log.log(`[${serviceId}] Increase detected vs cache: ${prevP} -> ${currP} (isRemaining=${isRem}); lastIncreasedAt=${lastIncreasedAt}`)
      }
    }

    let weeklyUsage = scraped.weeklyUsage ?? null
    let weeklyLimit = scraped.weeklyLimit ?? null
    let weeklyPercentUsed: number | null =
      scraped.weeklyPercentUsed !== undefined && scraped.weeklyPercentUsed !== null
        ? scraped.weeklyPercentUsed
        : scraped.weeklyUsage !== undefined && scraped.weeklyUsage !== null &&
            scraped.weeklyLimit !== undefined && scraped.weeklyLimit !== null
          ? Math.round((scraped.weeklyUsage / scraped.weeklyLimit) * 100)
          : null
    let weeklyResetsAt = scraped.weeklyResetsAt || null
    let weeklyBarLabel: string | undefined = scraped.weeklyBarLabel ?? undefined

    // Pre-assembly per-service commit rules, at the same sequence point as the
    // old inline blocks: Grok Bot overlay resolve, then Qwen clone-weekly drop.
    const contract = getServiceContract(serviceId)
    const preparation = contract.prepareCommit?.({
      scraped,
      cached: cachedExisting,
      weekly: { weeklyUsage, weeklyLimit, weeklyPercentUsed, weeklyResetsAt, weeklyBarLabel },
      overlay: { grokBotPercentUsed: null, grokBotResetsAt: null }
    })
    if (preparation) {
      weeklyUsage = preparation.weekly.weeklyUsage
      weeklyLimit = preparation.weekly.weeklyLimit
      weeklyPercentUsed = preparation.weekly.weeklyPercentUsed
      weeklyResetsAt = preparation.weekly.weeklyResetsAt
      weeklyBarLabel = preparation.weekly.weeklyBarLabel
    }
    const grokBot = preparation?.overlay ?? {
      grokBotPercentUsed: null as number | null,
      grokBotResetsAt: null as string | null
    }

    const scrapedUsage: UsageData = {
      ...baseResult,
      planTier: scraped.detectedPlanTier ?? baseResult.planTier,
      currentUsage: scraped.currentUsage,
      usageLimit: scraped.usageLimit,
      usageUnit: scraped.usageUnit || profile.usageUnit,
      percentUsed: scraped.percentUsed,
      isRemainingTracker: scraped.isRemainingTracker || false,
      resetsAt: scraped.resetsAt,
      resetCountdown: calculateCountdown(scraped.resetsAt),
      weeklyUsage,
      weeklyLimit,
      weeklyPercentUsed,
      weeklyResetsAt,
      weeklyResetCountdown: calculateCountdown(weeklyResetsAt),
      weeklyBarLabel,
      totalPercent: scraped.totalPercent ?? undefined,
      totalBarLabel: scraped.totalBarLabel ?? undefined,
      grokBotPercentUsed: grokBot.grokBotPercentUsed,
      grokBotResetsAt: grokBot.grokBotResetsAt,
      grokBotResetCountdown: calculateCountdown(grokBot.grokBotResetsAt),
      lastFetched: fetchedAt,
      lastRefreshAttemptAt: fetchedAt,
      isStale: false,
      lastIncreasedAt,
      status: 'ok',
      error: undefined,
      sessionAction: undefined,
      renewalDate: scrapedRenewalDate,
      renewalKind: scrapedRenewalKind,
      subModels: scraped.subModels?.map((sm) => ({
        name: sm.name,
        modelName: sm.modelName || sm.name,
        count: sm.count,
        total: sm.total,
        resetsAt: sm.resetsAt ?? null,
        resetCountdown: calculateCountdown(sm.resetsAt ?? null)
      })),
      metrics: [...(scraped.metrics ?? []), ...supplementalApiMetrics],
      agentCredits: scraped.agentCredits
    }

    const prepared = contract.beforeCommit?.(scrapedUsage, scraped) ?? scrapedUsage
    const result = attachCanonicalMetrics(serviceId, prepared, 'scraper')
    sink.saveSnapshot(snapshotFromUsage(result))
    cacheSet(serviceId, result)
    const commitLogLine = contract.commitLogLine?.(result)
    if (commitLogLine) log.log(commitLogLine)
    return result
  }

  async function fetchServiceUsage(serviceId: string, force = false): Promise<UsageData> {
    while (true) {
      const existing = inFlightServiceUsageFetches.get(serviceId)
      if (!existing) break

      // Forced Refresh must not reuse a non-force warm-up that returned the
      // previous cache row. Wait for it, then start a new fetch.
      if (!force || existing.force) {
        log.log(`[${serviceId}] Reusing in-flight usage fetch`)
        return existing.promise
      }

      log.log(`[${serviceId}] Waiting for scheduled fetch before forced refresh`)
      await existing.promise.catch(() => undefined)
    }

    const promise = fetchServiceUsageUncoalesced(serviceId, force).then(withRenewalOverride)
    inFlightServiceUsageFetches.set(serviceId, { force, promise })

    try {
      return await promise
    } finally {
      if (inFlightServiceUsageFetches.get(serviceId)?.promise === promise) {
        inFlightServiceUsageFetches.delete(serviceId)
      }
    }
  }

  async function fetchServiceUsageUncoalesced(serviceId: string, force = false): Promise<UsageData> {
    const profile = getProfile(serviceId)
    const fetchedAt = new Date(now()).toISOString()

    if (!deps.isServiceEnabled(serviceId)) {
      if (!profile) {
        return {
          service: serviceId,
          displayName: serviceId,
          planTier: 'Unknown',
          currentUsage: 0,
          usageLimit: null,
          usageUnit: 'unknown',
          percentUsed: null,
          resetsAt: null,
          resetCountdown: null,
          weeklyUsage: null,
          weeklyLimit: null,
          weeklyPercentUsed: null,
          weeklyResetsAt: null,
          weeklyResetCountdown: null,
          lastFetched: fetchedAt,
          status: 'disabled',
          iconColor: '#666',
          manualCookieRefresh: false,
          renewalDate: null,
          renewalKind: null
        }
      }
      return {
        service: profile.id,
        displayName: profile.displayName,
        planTier: profile.planTier,
        currentUsage: 0,
        usageLimit: null,
        usageUnit: profile.usageUnit,
        percentUsed: null,
        resetsAt: null,
        resetCountdown: null,
        weeklyUsage: null,
        weeklyLimit: null,
        weeklyPercentUsed: null,
        weeklyResetsAt: null,
        weeklyResetCountdown: null,
        lastFetched: null,
        status: 'disabled',
        iconColor: profile.iconColor,
        manualCookieRefresh: false,
        renewalDate: null,
        renewalKind: null
      }
    }

    if (!profile) {
      return {
        service: serviceId,
        displayName: serviceId,
        planTier: 'Unknown',
        currentUsage: 0,
        usageLimit: null,
        usageUnit: 'unknown',
        percentUsed: null,
        resetsAt: null,
        resetCountdown: null,
        weeklyUsage: null,
        weeklyLimit: null,
        weeklyPercentUsed: null,
        weeklyResetsAt: null,
        weeklyResetCountdown: null,
        lastFetched: fetchedAt,
        status: 'error',
        error: 'Unknown service',
        iconColor: '#666',
        manualCookieRefresh: false,
        renewalDate: null,
        renewalKind: null
      }
    }

    if (!deps.isOnline()) {
      const existing = sink.readCacheRow(serviceId)
      log.log(`[${serviceId}] offline_skip`)
      if (existing && (existing.status === 'ok' || existing.lastFetched)) {
        const stale = createStaleUsageData(
          existing,
          fetchedAt,
          'Offline — showing last known data. Scrapers paused so they do not hog the network adapter.'
        )
        cacheSet(serviceId, stale)
        return stale
      }
      return {
        ...createUsageShell(profile),
        status: 'error',
        error: 'Offline — connect to the internet, then refresh.',
        lastRefreshAttemptAt: fetchedAt
      }
    }

    // TTL check — return cached if fresh (unless forced)
    if (!force && isCacheFresh(serviceId)) {
      const cached = sink.readCacheRow(serviceId)!
      // Recalculate countdown (time-sensitive)
      cached.resetCountdown = calculateCountdown(cached.resetsAt)
      cached.weeklyResetCountdown = calculateCountdown(cached.weeklyResetsAt)
      if (cached.subModels) {
        cached.subModels = addSubModelCountdowns(cached.subModels)
      }
      const normalized = cached.metrics && cached.metrics.length > 0
        ? cached
        : attachCanonicalMetrics(serviceId, cached, 'cache')
      sink.writeCacheRow(serviceId, normalized)
      return normalized
    }

    // Exponential backoff: after >=3 consecutive failures, skip non-forced refreshes
    // until the backoff window elapses. User-initiated refreshes (force=true) always run.
    // IMPORTANT: never return raw cache — stamp lastRefreshAttemptAt + isStale so cards
    // cannot look "live" with an ancient lastFetched while auto-refresh is paused.
    if (!force) {
      const health = sink.getServiceHealth(serviceId)
      if (health && health.consecutiveFailures >= 3 && health.lastErrorAt) {
        const exp = Math.min(health.consecutiveFailures - 2, 6) // 1..6
        const waitMs = Math.min(Math.pow(2, exp) * 60_000, 60 * 60_000) // 2m..1h
        const nextAttemptAt = health.lastErrorAt + waitMs
        if (now() < nextAttemptAt) {
          const remaining = Math.max(1, Math.round((nextAttemptAt - now()) / 60_000))
          const attemptedAt = new Date(now()).toISOString()
          const reason =
            `Refresh paused after ${health.consecutiveFailures} failures — retry in ~${remaining}m`
          log.log(
            `[${serviceId}] backoff_skip (${health.consecutiveFailures} failures, ${remaining}m remaining)`
          )
          const cached = sink.readCacheRow(serviceId)
          if (cached && (cached.status === 'ok' || cached.lastFetched)) {
            return createStaleUsageData(cached, attemptedAt, reason)
          }
          if (cached) {
            return {
              ...cached,
              isStale: true,
              lastRefreshAttemptAt: attemptedAt,
              error: reason
            }
          }
          return {
            ...createUsageShell(profile),
            status: 'error',
            error: reason,
            lastRefreshAttemptAt: attemptedAt
          }
        }
      }
    }

    const baseResult = createUsageShell(profile)

    const supplementalApiMetrics: UsageMetric[] = []
    const apiKey = await deps.getCredential(serviceId, 'api_key')
    if (apiKey) {
      log.log(`[usageFetcher] Attempting official API fetch for ${serviceId}...`)
      const apiResult = await scrapers.fetchViaAPI(profile, apiKey)
      if (apiResult && apiResult.status === 'ok') {
        let rejectedPrimaryApi = false
        if (scrapers.isPrimaryOfficialAPIService(serviceId) && apiResult.currentUsage !== undefined) {
          const apiCandidate: UsageData = {
            ...baseResult,
            currentUsage: apiResult.currentUsage ?? 0,
            usageLimit: apiResult.usageLimit ?? null,
            usageUnit: apiResult.usageUnit ?? profile.usageUnit,
            percentUsed: apiResult.percentUsed ?? null,
            isRemainingTracker: apiResult.isRemainingTracker ?? false,
            resetsAt: apiResult.resetsAt ?? null,
            resetCountdown: calculateCountdown(apiResult.resetsAt ?? null),
            weeklyUsage: apiResult.weeklyUsage ?? null,
            weeklyLimit: apiResult.weeklyLimit ?? null,
            weeklyPercentUsed: apiResult.weeklyPercentUsed ?? null,
            weeklyResetsAt: apiResult.weeklyResetsAt ?? null,
            weeklyResetCountdown: calculateCountdown(apiResult.weeklyResetsAt ?? null),
            lastFetched: fetchedAt,
            status: 'ok',
            error: undefined,
            sessionAction: undefined,
            metrics: apiResult.metrics,
            subModels: apiResult.subModels,
            agentCredits: apiResult.agentCredits
          }
          const integrity = validateAndReconcileUsage(serviceId, apiCandidate)
          if (integrity.disposition === 'rejected') {
            rejectedPrimaryApi = true
            log.warn(
              `[${serviceId}] Usage integrity rejected official API reading; falling back to scraper: ${integrity.reason}`
            )
          } else {
            if (integrity.disposition === 'repaired') {
              log.log(`[${serviceId}] Usage integrity repaired official API reading: ${integrity.reason}`)
            }
            const apiUsage = attachCanonicalMetrics(serviceId, integrity.data, 'api')

            sink.saveSnapshot(snapshotFromUsage(apiUsage))
            cacheSet(serviceId, apiUsage)
            log.log(`[usageFetcher] Successfully fetched via official API for ${serviceId}`)
            return apiUsage
          }
        }

        if (!rejectedPrimaryApi && apiResult.metrics && apiResult.metrics.length > 0) {
          supplementalApiMetrics.push(...apiResult.metrics)
          log.log(`[usageFetcher] Collected ${apiResult.metrics.length} supplemental API metrics for ${serviceId}`)
        }
      } else if (apiResult?.status === 'error') {
        log.log(`[usageFetcher] API fetch failed for ${serviceId}; falling back to scraper. Error: ${apiResult.error}`)
      }
    }

    // Try scraper with retry logic
    const scraper = scrapers.getScraper(serviceId)
    if (scraper) {
      if (!scraper.usesManagedBrowserSession()) {
        const loggedIn = await scraper.isLoggedIn()
        const isChromeLockedError = scraper.importError != null && scraper.importError.includes('Chrome is locking')

        if (!loggedIn) {
          const reason: ScrapeFailureReason = isChromeLockedError ? 'cookie_import_blocked' : 'login_required'
          const actionRequired = createSessionActionResult(profile, reason, sink.readCacheRow(serviceId))
          cacheSet(serviceId, actionRequired)
          return actionRequired
        }
      } else {
        // Background polls must not cold-launch Chrome for sessions we already
        // know are signed out. First-ever fetch has no cache — that launch is
        // required so we can discover login state. Forced fetch / Reconnect
        // always launch.
        const cached = sink.readCacheRow(serviceId)
        const lastNeedsLogin =
          cached?.status === 'login_required' || cached?.status === 'cookies_expired'
        scrapers.setManagedChromeLaunchAllowed(serviceId, force || !lastNeedsLogin)

        if (!force && lastNeedsLogin && cached) {
          log.log(
            `[${serviceId}] login_required_skip (last status=${cached.status}; Reconnect to launch Chrome)`
          )
          return cached
        }
      }

      // Retry scraping up to 3 attempts with exponential backoff (1s → 4s,
      // ±20% jitter). Deterministic parse failures (page_not_ready /
      // extract_failed) and auth-state failures are never retried — retrying
      // them just re-hammers the same page for the same result.
      let scraped: ScrapedUsageData | null = null
      let lastError: Error | null = null
      let integrityFailureReason: string | null = null
      let integrityRejections = 0
      const maxRetries = 3
      const NON_RETRYABLE_REASONS: Array<NonNullable<ScrapeFailureReason>> = [
        'page_not_ready',
        'extract_failed',
        'cookie_import_blocked',
        'cloudflare_blocked',
        'login_required',
        'managed_browser_inactive'
      ]

      const retryDelayMs = (attempt: number): number => {
        const base = 1000 * Math.pow(4, attempt - 1) // attempt 1 → 1s, attempt 2 → 4s
        return Math.round(base * (0.8 + Math.random() * 0.4))
      }

      if (!scraped) for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          scraped = await scraper.scrape()
          if (scraped) {
            // Auth sentinels intentionally do not carry currentUsage and must
            // continue through the existing login-required branch below.
            if (scraped.currentUsage === undefined) break

            const integrity = validateAndReconcileUsage(serviceId, scraped)
            if (integrity.disposition === 'rejected') {
              integrityFailureReason = integrity.reason ?? 'usage integrity check failed'
              integrityRejections++
              log.warn(
                `[${serviceId}] Usage integrity rejected scrape attempt ${attempt}: ${integrityFailureReason}`
              )
              scraped = null

              // A second read is useful for transient DOM animation/hydration,
              // but never keep hammering a page that remains contradictory.
              if (integrityRejections < 2 && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 750))
                continue
              }
              break
            }

            scraped = integrity.data
            integrityFailureReason = null
            if (integrity.disposition === 'repaired') {
              log.log(`[${serviceId}] Usage integrity repaired fresh reading: ${integrity.reason}`)
            }
            break
          }

          // If failure reason indicates a deterministic/non-retryable issue, don't retry
          const reason = scraper.getLastFailureReason()
          if (reason && NON_RETRYABLE_REASONS.includes(reason)) {
            break
          }

          if (attempt < maxRetries) {
            const delay = retryDelayMs(attempt)
            log.log(`[${serviceId}] Scrape returned null, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`)
            await new Promise(r => setTimeout(r, delay))
          }
        } catch (error) {
          lastError = error as Error
          log.error(`[${serviceId}] Scrape error on attempt ${attempt}:`, error)
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, retryDelayMs(attempt)))
          }
        }
      }

      if (scraped && scraped.currentUsage !== undefined) {
        const result = commitSuccessfulScrape(
          serviceId,
          profile,
          baseResult,
          scraped,
          fetchedAt,
          supplementalApiMetrics
        )
        return result
      } else if (integrityFailureReason) {
        const existing = sink.readCacheRow(serviceId)
        const integrityError = `Refresh failed: fetched usage was internally inconsistent (${integrityFailureReason}). Showing last known data.`
        if (existing && existing.status === 'ok') {
          const stale = clearSessionAction({
            ...createStaleUsageData(existing, fetchedAt, integrityError),
            resetCountdown: calculateCountdown(existing.resetsAt),
            weeklyResetCountdown: calculateCountdown(existing.weeklyResetsAt)
          })
          cacheSet(serviceId, stale)
          return stale
        }

        baseResult.status = 'error'
        baseResult.error = `Fetched usage was internally inconsistent: ${integrityFailureReason}`
        cacheSet(serviceId, clearSessionAction(baseResult))
        return baseResult
      } else if (
        (scraped as any)?.loginRequired ||
        [
          'login_required',
          'managed_browser_inactive',
          'cookie_import_blocked',
          'cloudflare_blocked'
        ].includes(scraper.getLastFailureReason() || '')
      ) {
        const reason: ScrapeFailureReason = (scraped as any)?.loginRequired
          ? 'login_required'
          : scraper.getLastFailureReason()
        const actionRequired = createSessionActionResult(profile, reason, sink.readCacheRow(serviceId))
        cacheSet(serviceId, actionRequired)
        return actionRequired
      } else if (['extract_failed', 'page_not_ready'].includes(scraper.getLastFailureReason() || '')) {
        const kept = keepFreshCacheOnTransientMiss(
          serviceId,
          fetchedAt,
          scraper.getLastFailureReason() || 'extract_failed'
        )
        if (kept) {
          cacheSet(serviceId, kept)
          return kept
        }
        const reason = scraper.getLastFailureReason()
        const existing = sink.readCacheRow(serviceId)
        const parserError = reason === 'page_not_ready'
          ? 'Refresh failed: the dashboard did not finish loading. Showing cached data.'
          : 'Refresh failed: signed in, but the scraper could not parse the current layout. Showing cached data.'
        if (existing && existing.status === 'ok') {
          const stale = clearSessionAction({
            ...createStaleUsageData(existing, fetchedAt, parserError),
            resetCountdown: calculateCountdown(existing.resetsAt),
            weeklyResetCountdown: calculateCountdown(existing.weeklyResetsAt)
          })
          cacheSet(serviceId, stale)
          return stale
        }
        baseResult.status = 'error'
        baseResult.error = reason === 'page_not_ready'
          ? 'The dashboard page did not finish loading.'
          : 'Signed in, but the scraper could not parse the usage layout.'
        cacheSet(serviceId, clearSessionAction(baseResult))
        return baseResult
      } else {
        // Scrape returned null with no recognised failure reason — surface a stale-cache
        // indicator with a fresh timestamp so the renderer knows the refresh ran (and
        // the timer ring resets), but the user can see the refresh did not succeed.
        const existing = sink.readCacheRow(serviceId)
        const kept = keepFreshCacheOnTransientMiss(
          serviceId,
          fetchedAt,
          lastError?.message || 'extract_miss'
        )
        if (kept) {
          cacheSet(serviceId, kept)
          return kept
        }
        if (existing && existing.status === 'ok') {
          log.log(`[${serviceId}] Extraction failed — keeping last successful timestamp`)
          const stale: UsageData = {
            ...createStaleUsageData(existing, fetchedAt, 'Refresh failed — showing last known data'),
            resetCountdown: calculateCountdown(existing.resetsAt),
            weeklyResetCountdown: calculateCountdown(existing.weeklyResetsAt)
          }
          cacheSet(serviceId, stale)
          return stale
        }
        baseResult.status = 'error'
        baseResult.error =
          scraper.importError ||
          'Page loaded but could not extract usage data - try Login'
        cacheSet(serviceId, baseResult)
        return baseResult
      }
    }

    cacheSet(serviceId, baseResult)
    return baseResult
  }

  async function fetchEnabledServicesBounded(options: BoundedFetchOptions): Promise<UsageData[]> {
    const profiles = getAllProfiles()
      .filter((p) => deps.isServiceEnabled(p.id))
      .sort(options.sort ?? (() => 0))
    const results = new Array<UsageData>(profiles.length)
    let cursor = 0
    const workerCount = Math.min(SERVICE_FETCH_CONCURRENCY, profiles.length)

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const next = cursor++
        if (next >= profiles.length) return
        const profile = profiles[next]

        if (options.skipFresh && !options.force && isCacheFresh(profile.id)) {
          const cached = sink.readCacheRow(profile.id)
          if (cached) {
            log.log(`[${options.logPrefix}] ${profile.id} fresh_skip (within cadence)`)
            results[next] = cached
            continue
          }
        }

        const startedAt = now()
        log.log(`[${options.logPrefix}] ${profile.id} fetch_start`)
        const timeoutPromise = new Promise<UsageData>((resolve) =>
          setTimeout(() => {
            scrapers.getScraper(profile.id)?.cancelActiveScrape(options.timeoutLabel)
            resolve(createTimeoutResult(profile, sink.readCacheRow(profile.id)))
          }, options.timeoutMs)
        )

        let usage: UsageData
        try {
          usage = await Promise.race([
            fetchServiceUsage(profile.id, options.force),
            timeoutPromise
          ])
        } catch (err) {
          log.error(
            `[${options.logPrefix}] ${profile.id} fetch_timeout_or_error ms=${now() - startedAt}:`,
            err
          )
          usage = createTimeoutResult(profile, sink.readCacheRow(profile.id))
        }

        usage = await withRenewalOverride(usage)
        results[next] = usage
        options.onEach?.(profile.id, usage)
        log.log(
          `[${options.logPrefix}] ${profile.id} fetch_end status=${usage.status}` +
            `${usage.isStale ? ' stale' : ''} ms=${now() - startedAt}`
        )
      }
    })

    await Promise.all(workers)
    return results
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
   */
  async function warmUpAllServices(force = false): Promise<WarmUpResult> {
    if (!deps.isOnline()) {
      log.log('[warmUp] Offline — skipping scrape cycle')
      void deps.closeAllManagedChrome()
      return { ran: false, coalesced: false }
    }

    if (warmUpInFlight) {
      log.log('[warmUp] Already running — coalescing onto in-flight warm-up')
      await warmUpInFlight
      return { ran: false, coalesced: true }
    }

    const run = (async (): Promise<WarmUpResult> => {
      warmUpRunning = true
      deps.noteGlobalRefresh()
      log.log('[warmUp] Starting background fetch for all services...')
      try {
        // Daily SQLite retention prune (guarded internally — cheap no-op otherwise)
        deps.pruneUsageHistory()

        await fetchEnabledServicesBounded({
          force,
          timeoutMs: 45_000,
          timeoutLabel: 'warm-up 45s budget',
          skipFresh: true,
          logPrefix: 'warmUp',
          sort: (a, b) => {
            const ah = sink.getServiceHealth(a.id)
            const bh = sink.getServiceHealth(b.id)
            return (ah?.consecutiveFailures ?? 0) - (bh?.consecutiveFailures ?? 0)
          },
          onEach: (serviceId, usage) => sink.broadcastUsageProgress(serviceId, usage)
        })

        // Flush the debounced cache writes from this cycle in one disk operation.
        await sink.flushCacheToDisk()

        warmUpDone = true
        // Single source of "batch finished" for Dashboard getCached reloads —
        // including the fire-and-forget usage:warmUp path.
        sink.broadcastRefreshComplete()
        log.log('[warmUp] Background fetch complete')
        return { ran: true, coalesced: false }
      } finally {
        warmUpRunning = false
        warmUpInFlight = null
      }
    })()

    warmUpInFlight = run
    return run
  }

  return {
    fetchServiceUsage,
    fetchEnabledServicesBounded,
    warmUpAllServices,
    cacheSet,
    createUsageShell,
    createSessionActionResult,
    applyLatestSnapshotFallback,
    withRenewalOverride
  }
}
