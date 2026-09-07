// Behavior smoke for the refresh coordinator seam (replaces the old
// source-regex refresh-coordinator-smoke.js). Drives refreshCoordinator.ts in
// plain Node with a fake ScraperSource + in-memory UsageSink and asserts the
// shared scrape rules as BEHAVIOR:
//   (a) fresh cache short-circuits (no scrape call)
//   (b) transient null after a recent ok keeps the row connected (isStale=false)
//   (c) Cursor ok-without-Total row is refused at the cache gate
//   (d) scraper timeout → stale result + cancelActiveScrape called
//   (e) commit persists exactly once through the funnel (sink calls counted)
//   (f) warm-up coalesces concurrent runs and fires complete even on failure
//   (+) backoff skip stamps stale, login_required/offline skips, 2-wide pool
const assert = require('assert')
const esbuild = require('esbuild')

require.extensions['.ts'] = function loadTs(module, filename) {
  const fs = require('fs')
  const source = fs.readFileSync(filename, 'utf8')
  const output = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18'
  })
  module._compile(output.code, filename)
}

const { createRefreshCoordinator } = require('../src/main/refreshCoordinator.ts')

// ─── Fake ports ─────────────────────────────────────────────

function makeEnv() {
  const env = {
    cache: new Map(),
    latestSnapshots: new Map(),
    health: new Map(),
    scrapers: new Map(),
    enabled: new Set(),
    credentials: new Map(),
    online: true,
    snapshots: [],
    events: [],
    logLines: [],
    launchAllowed: [],
    writeCount: 0,
    flushScheduled: 0,
    flushed: 0,
    successes: [],
    failures: [],
    pruned: 0,
    closedChrome: 0,
    refreshNotes: 0
  }

  env.deps = {
    scrapers: {
      getScraper: (serviceId) => env.scrapers.get(serviceId),
      fetchViaAPI: async () => null,
      isPrimaryOfficialAPIService: () => false,
      setManagedChromeLaunchAllowed: (serviceId, allowed) => {
        env.launchAllowed.push([serviceId, allowed])
      }
    },
    sink: {
      readCacheRow: (serviceId) => env.cache.get(serviceId),
      writeCacheRow: (serviceId, data) => {
        env.writeCount++
        env.cache.set(serviceId, data)
      },
      scheduleCacheFlush: () => { env.flushScheduled++ },
      flushCacheToDisk: async () => { env.flushed++ },
      saveSnapshot: (snapshot) => { env.snapshots.push(snapshot) },
      readLatestSnapshot: (serviceId) => env.latestSnapshots.get(serviceId) ?? null,
      recordServiceSuccess: (serviceId) => { env.successes.push(serviceId) },
      recordServiceFailure: (serviceId, reason) => { env.failures.push([serviceId, reason]) },
      getServiceHealth: (serviceId) => env.health.get(serviceId) ?? null,
      broadcastUsageProgress: (serviceId, usage) => {
        env.events.push({ type: 'progress', serviceId, usage })
      },
      broadcastRefreshComplete: () => { env.events.push({ type: 'complete' }) }
    },
    isServiceEnabled: (serviceId) => env.enabled.has(serviceId),
    isOnline: () => env.online,
    getCredential: async (serviceId, key) => env.credentials.get(`${serviceId}:${key}`) ?? null,
    noteGlobalRefresh: () => { env.refreshNotes++ },
    closeAllManagedChrome: () => { env.closedChrome++ },
    pruneUsageHistory: () => { env.pruned++ },
    logger: {
      log: (...args) => { env.logLines.push(args.map(String).join(' ')) },
      warn: (...args) => { env.logLines.push(args.map(String).join(' ')) },
      error: (...args) => { env.logLines.push(args.map(String).join(' ')) }
    }
  }

  return env
}

function fakeScraper({ scrape, managed = true, loggedIn = true, failureReason = null } = {}) {
  return {
    scrapeCalls: 0,
    cancelCalls: [],
    importError: null,
    async scrape() {
      this.scrapeCalls++
      return scrape ? scrape() : null
    },
    cancelActiveScrape(reason) { this.cancelCalls.push(reason) },
    async isLoggedIn() { return loggedIn },
    usesManagedBrowserSession() { return managed },
    requiresExternalBrowserLogin() { return false },
    getLastFailureReason() { return failureReason }
  }
}

function scrapedOk(overrides = {}) {
  return {
    currentUsage: 10,
    usageLimit: 100,
    percentUsed: 10,
    usageUnit: 'credits',
    resetsAt: null,
    weeklyUsage: null,
    weeklyLimit: null,
    ...overrides
  }
}

function okCacheRow(serviceId, ageMs, overrides = {}) {
  return {
    service: serviceId,
    displayName: serviceId,
    planTier: 'Pro',
    currentUsage: 10,
    usageLimit: 100,
    usageUnit: 'credits',
    percentUsed: 10,
    resetsAt: null,
    resetCountdown: null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    weeklyResetsAt: null,
    weeklyResetCountdown: null,
    lastFetched: new Date(Date.now() - ageMs).toISOString(),
    status: 'ok',
    isStale: false,
    iconColor: '#000',
    manualCookieRefresh: false,
    metrics: [],
    ...overrides
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── (a) fresh cache short-circuits the scrape ──────────────

async function testFreshCacheShortCircuits() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => scrapedOk() })
  env.scrapers.set('gemini', scraper)
  env.cache.set('gemini', okCacheRow('gemini', 60_000)) // 1min old, cadence is >= 8min

  const coordinator = createRefreshCoordinator(env.deps)
  const result = await coordinator.fetchServiceUsage('gemini', false)

  assert.strictEqual(scraper.scrapeCalls, 0, 'fresh cache must not call the scraper')
  assert.strictEqual(result.status, 'ok', 'fresh cache returns the ok row')
  assert.strictEqual(result.percentUsed, 10, 'fresh cache returns the cached reading')
  console.log('[a] fresh cache short-circuits (no scrape call)')
}

// ─── (b) transient miss keeps a fresh row connected ─────────

async function testTransientMissKeepsFreshCache() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => null, failureReason: 'extract_failed' })
  env.scrapers.set('gemini', scraper)
  env.cache.set('gemini', okCacheRow('gemini', 120_000))

  const coordinator = createRefreshCoordinator(env.deps)
  const result = await coordinator.fetchServiceUsage('gemini', true) // force bypasses TTL

  assert.strictEqual(scraper.scrapeCalls, 1, 'extract_failed must not be retried')
  assert.strictEqual(result.status, 'ok', 'transient miss keeps the ok status')
  assert.strictEqual(result.isStale, false, 'transient miss must NOT paint the row stale')
  assert.strictEqual(result.error, undefined, 'transient miss clears the error')
  assert.ok(result.lastRefreshAttemptAt, 'transient miss still stamps the attempt')
  assert.notStrictEqual(result.lastRefreshAttemptAt, result.lastFetched)
  const cached = env.cache.get('gemini')
  assert.strictEqual(cached.isStale, false, 'cached row stays connected too')
  assert.ok(
    env.logLines.some((line) => line.includes('Transient miss (extract_failed) — keeping fresh cache')),
    'expected the transient-miss log line'
  )
  console.log('[b] transient null after a recent ok keeps the row connected (isStale=false)')
}

// ─── (c) Cursor ok-without-Total refused at the cache gate ──

async function testCursorRowWithoutTotalRefused() {
  const env = makeEnv()
  const coordinator = createRefreshCoordinator(env.deps)
  const cursorRow = okCacheRow('cursor', 60_000, {
    percentUsed: 15,
    currentUsage: 15,
    metrics: []
  })
  delete cursorRow.totalPercent

  coordinator.cacheSet('cursor', cursorRow)

  assert.strictEqual(env.cache.has('cursor'), false, 'ok-without-Total must not reach the cache')
  assert.deepStrictEqual(
    env.failures,
    [['cursor', 'missing official Total (GetCurrentPeriodUsage)']],
    'refusal must be recorded as a service failure'
  )
  assert.ok(
    env.logLines.some((line) =>
      line.includes('[cursor] Refusing ok-cache write without official Total (GetCurrentPeriodUsage)')),
    'expected the verbatim refusal warn line'
  )
  console.log('[c] Cursor ok-without-Total row is refused at the cache gate')
}

// ─── (d) scraper timeout → stale result + cancel ────────────

async function testBoundedFetchTimeoutCancelsScrape() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => new Promise(() => {}) }) // hangs
  env.scrapers.set('gemini', scraper)
  env.cache.set('gemini', okCacheRow('gemini', 120_000))

  const coordinator = createRefreshCoordinator(env.deps)
  const progressed = []
  const results = await coordinator.fetchEnabledServicesBounded({
    force: true,
    timeoutMs: 30,
    timeoutLabel: 'test 30ms budget',
    skipFresh: false,
    logPrefix: 'test',
    onEach: (serviceId, usage) => progressed.push([serviceId, usage])
  })

  assert.strictEqual(results.length, 1)
  const row = results[0]
  assert.deepStrictEqual(scraper.cancelCalls, ['test 30ms budget'], 'hung scrape must be cancelled')
  assert.strictEqual(row.status, 'ok', 'timeout keeps last-good data')
  assert.strictEqual(row.isStale, true, 'timeout result is stamped stale')
  assert.match(row.error, /did not respond within the refresh timeout/)
  assert.ok(!/cookies_expired/i.test(row.error), 'a pure timeout is not session expiry')
  assert.strictEqual(row.status === 'cookies_expired', false, 'timeout must not mark cookies_expired')
  assert.strictEqual(progressed.length, 1, 'timeout row still broadcasts progress')
  console.log('[d] scraper timeout → stale result with cancelActiveScrape called')
}

// ─── (e) commit persists exactly once through the funnel ────

async function testCommitPersistsExactlyOnce() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => scrapedOk() })
  env.scrapers.set('gemini', scraper)

  const coordinator = createRefreshCoordinator(env.deps)
  const result = await coordinator.fetchServiceUsage('gemini', true)

  assert.strictEqual(result.status, 'ok')
  assert.strictEqual(env.snapshots.length, 1, 'exactly one SQLite snapshot per commit')
  assert.strictEqual(env.snapshots[0].service, 'gemini')
  assert.strictEqual(env.snapshots[0].percentUsed, 10)
  assert.strictEqual(env.writeCount, 1, 'exactly one cache write per commit')
  assert.deepStrictEqual(env.successes, ['gemini'], 'one service-success record per commit')
  assert.deepStrictEqual(env.failures, [], 'no failure records on success')
  assert.strictEqual(env.flushScheduled, 1, 'one flush scheduled per commit')
  const cached = env.cache.get('gemini')
  assert.strictEqual(cached.status, 'ok')
  assert.strictEqual(cached.isStale, false)
  assert.ok(cached.lastFetched, 'commit stamps lastFetched')
  console.log('[e] commit persists exactly once through the funnel (sink calls counted)')
}

// ─── (f) warm-up coalesces + completes even on failure ──────

async function testWarmUpCoalescesAndCompletesOnFailure() {
  const env = makeEnv()
  env.enabled.add('gemini')
  // Deterministic failure with no cache: error row, warm-up must still finish.
  const scraper = fakeScraper({ scrape: () => null, failureReason: 'extract_failed' })
  env.scrapers.set('gemini', scraper)

  const coordinator = createRefreshCoordinator(env.deps)
  const p1 = coordinator.warmUpAllServices()
  const p2 = coordinator.warmUpAllServices()
  const [r1, r2] = await Promise.all([p1, p2])

  assert.deepStrictEqual(r1, { ran: true, coalesced: false }, 'first caller runs the warm-up')
  assert.deepStrictEqual(r2, { ran: false, coalesced: true }, 'second caller coalesces onto it')
  assert.strictEqual(env.pruned, 1, 'warm-up prunes history once')
  assert.strictEqual(env.refreshNotes, 1, 'warm-up stamps the refresh clock once')
  assert.strictEqual(env.flushed, 1, 'warm-up flushes the cache once')

  const completeEvents = env.events.filter((event) => event.type === 'complete')
  assert.strictEqual(completeEvents.length, 1, 'usage-refresh-complete fires exactly once, even on failure')
  const progressEvents = env.events.filter((event) => event.type === 'progress')
  assert.strictEqual(progressEvents.length, 1, 'per-service progress still broadcasts (cards do not freeze)')
  assert.strictEqual(progressEvents[0].serviceId, 'gemini')
  assert.strictEqual(progressEvents[0].usage.status, 'error', 'the failed row is what broadcasts')
  assert.deepStrictEqual(env.failures.length, 1, 'failed service is recorded as a failure')
  console.log('[f] warm-up coalesces concurrent runs and fires complete even on failure')
}

// ─── (+) backoff / login_required / offline / pool width ────

async function testBackoffSkipStampsStale() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => scrapedOk() })
  env.scrapers.set('gemini', scraper)
  env.health.set('gemini', {
    service: 'gemini',
    lastErrorAt: Date.now(),
    lastErrorReason: 'boom',
    consecutiveFailures: 4,
    lastSuccessAt: null
  })
  env.cache.set('gemini', okCacheRow('gemini', 3_600_000)) // 1h old — past cadence

  const coordinator = createRefreshCoordinator(env.deps)
  const result = await coordinator.fetchServiceUsage('gemini', false)

  assert.strictEqual(scraper.scrapeCalls, 0, 'backoff must not scrape')
  assert.strictEqual(result.isStale, true, 'backoff skip stamps the row stale')
  assert.ok(result.lastRefreshAttemptAt, 'backoff skip stamps lastRefreshAttemptAt (never raw cache)')
  assert.match(result.error, /Refresh paused after 4 failures — retry in ~\d+m/)
  assert.ok(
    env.logLines.some((line) => line.includes('[gemini] backoff_skip (4 failures')),
    'expected the backoff_skip log line'
  )
  console.log('[+] backoff skip stamps stale / lastRefreshAttemptAt (never returns raw cache)')
}

async function testLoginRequiredSkipKeepsChromeClosed() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => scrapedOk() })
  env.scrapers.set('gemini', scraper)
  const loginRow = { ...okCacheRow('gemini', 3_600_000), status: 'login_required', lastFetched: null }
  env.cache.set('gemini', loginRow)

  const coordinator = createRefreshCoordinator(env.deps)
  const result = await coordinator.fetchServiceUsage('gemini', false)

  assert.strictEqual(scraper.scrapeCalls, 0, 'signed-out background poll must not scrape')
  assert.deepStrictEqual(
    env.launchAllowed,
    [['gemini', false]],
    'managed Chrome launch is blocked while last status needs login'
  )
  assert.strictEqual(result, loginRow, 'login_required_skip returns the cached row untouched')
  assert.ok(
    env.logLines.some((line) => line.includes('[gemini] login_required_skip')),
    'expected the login_required_skip log line'
  )

  // Forced refresh / Reconnect always launch.
  const forced = coordinator.fetchServiceUsage('gemini', true)
  await forced
  assert.deepStrictEqual(env.launchAllowed[1], ['gemini', true], 'forced refresh allows the launch')
  console.log('[+] login_required background skip keeps Chrome closed; force may launch')
}

async function testOfflineSkipStaleAndWarmUpOffline() {
  const env = makeEnv()
  env.enabled.add('gemini')
  const scraper = fakeScraper({ scrape: () => scrapedOk() })
  env.scrapers.set('gemini', scraper)
  env.cache.set('gemini', okCacheRow('gemini', 120_000))
  env.online = false

  const coordinator = createRefreshCoordinator(env.deps)
  const result = await coordinator.fetchServiceUsage('gemini', true)

  assert.strictEqual(scraper.scrapeCalls, 0, 'offline must not scrape')
  assert.strictEqual(result.isStale, true, 'offline stamps the last-known row stale')
  assert.match(result.error, /Offline — showing last known data/)
  assert.ok(
    env.logLines.some((line) => line.includes('[gemini] offline_skip')),
    'expected the offline_skip log line'
  )

  const warmResult = await coordinator.warmUpAllServices()
  assert.deepStrictEqual(warmResult, { ran: false, coalesced: false }, 'offline warm-up does not run')
  assert.strictEqual(env.closedChrome, 1, 'offline warm-up closes managed browsers')
  assert.strictEqual(env.events.filter((event) => event.type === 'complete').length, 0,
    'offline warm-up must not fire a false complete')
  console.log('[+] offline fetches skip scrapes and stamp stale; offline warm-up is a no-op')
}

async function testBoundedPoolIsTwoWide() {
  const env = makeEnv()
  let concurrent = 0
  let maxConcurrent = 0
  for (const serviceId of ['gemini', 'minimax', 'runwayml']) {
    env.enabled.add(serviceId)
    env.scrapers.set(serviceId, fakeScraper({
      scrape: async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await delay(30)
        concurrent--
        return scrapedOk()
      }
    }))
  }

  const coordinator = createRefreshCoordinator(env.deps)
  const results = await coordinator.fetchEnabledServicesBounded({
    force: true,
    timeoutMs: 5_000,
    timeoutLabel: 'test pool budget',
    skipFresh: false,
    logPrefix: 'test'
  })

  assert.strictEqual(results.length, 3, 'every enabled service gets a row')
  assert.ok(results.every((row) => row.status === 'ok'), 'all rows scrape to ok')
  assert.strictEqual(maxConcurrent, 2, 'service fetch pool is exactly 2 wide (SERVICE_FETCH_CONCURRENCY)')
  console.log('[+] warm-up / Refresh All share a 2-wide service fetch pool')
}

// ─── runner ─────────────────────────────────────────────────

async function main() {
  await testFreshCacheShortCircuits()
  await testTransientMissKeepsFreshCache()
  await testCursorRowWithoutTotalRefused()
  await testBoundedFetchTimeoutCancelsScrape()
  await testCommitPersistsExactlyOnce()
  await testWarmUpCoalescesAndCompletesOnFailure()
  await testBackoffSkipStampsStale()
  await testLoginRequiredSkipKeepsChromeClosed()
  await testOfflineSkipStaleAndWarmUpOffline()
  await testBoundedPoolIsTwoWide()
  console.log('refresh-coordinator-behavior-smoke: OK (fresh TTL, transient-miss keep, cursor gate, timeout cancel, single-commit funnel, warm-up coalesce/complete, backoff/login/offline skips, 2-wide pool)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
