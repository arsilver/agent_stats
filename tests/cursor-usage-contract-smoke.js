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

const {
  applyCursorOfficialTotal,
  CURSOR_WRITE_PATH,
  cursorLooksConnected,
  cursorOfficialTotalPercent,
  cursorPoolPercent,
  cursorReadingHasOfficialTotal,
  cursorSnapshotMayOverlay,
  demoteIncompleteCursorUsage,
  materializeCursorIdeReading,
  preferNewerCursorUsage
} = require('../src/shared/cursorUsage.ts')

function testOfficialTotalIsRequiredForHeadline() {
  const staleSpendingPage = {
    percentUsed: 2,
    subModels: [
      { name: 'Cursor Models', count: 2, total: 100 },
      { name: 'Other Models', count: 14, total: 100 }
    ]
  }
  assert.strictEqual(
    cursorOfficialTotalPercent(staleSpendingPage),
    null,
    '2% Cursor Models must not headline as Total'
  )
  assert.strictEqual(cursorReadingHasOfficialTotal(staleSpendingPage), false)
}

function testLivePlanAndUsageHeadline() {
  const live = {
    percentUsed: 11,
    totalPercent: 11,
    totalBarLabel: 'Total',
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  assert.strictEqual(cursorOfficialTotalPercent(live), 11)
  assert.strictEqual(cursorPoolPercent(live, /^(Cursor Models|First-party models)$/i), 4)
  assert.strictEqual(cursorPoolPercent(live, /^(Other Models|API)$/i), 42)
  assert.strictEqual(cursorReadingHasOfficialTotal(live), true)
}

function testMetricFallbackStillRequiresCursorTotalId() {
  const fromMetric = {
    percentUsed: 2,
    metrics: [{ id: 'cursor:total', percent: 11 }],
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  assert.strictEqual(cursorOfficialTotalPercent(fromMetric), 11)
  const primaryOnly = {
    percentUsed: 11,
    metrics: [{ id: 'cursor:primary', percent: 11 }],
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  assert.strictEqual(
    cursorOfficialTotalPercent(primaryOnly),
    null,
    'primary percent without totalPercent is not official Total'
  )
}

function testFourFortyTwoCachePlusIdeScrapePersistsOfficialTotal() {
  const cache = {
    service: 'cursor',
    percentUsed: 4,
    currentUsage: 4,
    usageLimit: 100,
    weeklyPercentUsed: 42,
    weeklyUsage: 42,
    weeklyLimit: 100,
    renewalKind: 'cancelled',
    lastFetched: '2026-08-15T00:33:54.000Z',
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  assert.strictEqual(cursorOfficialTotalPercent(cache), null)

  const ide = {
    totalPercent: 11,
    percentUsed: 11,
    currentUsage: 11,
    usageLimit: 100,
    weeklyPercentUsed: 42,
    weeklyUsage: 42,
    weeklyLimit: 100,
    weeklyBarLabel: 'Other Models',
    totalBarLabel: 'Total',
    renewalKind: 'renewing',
    renewalDate: '2026-09-12',
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  const applied = materializeCursorIdeReading(ide)
  assert.strictEqual(applied.totalPercent, 11)
  assert.strictEqual(applied.percentUsed, 11)
  assert.strictEqual(applied.currentUsage, 11)
  assert.strictEqual(applied.weeklyPercentUsed, 42)
  assert.strictEqual(applied.subModels.find((row) => row.name === 'Cursor Models').count, 4)
  assert.strictEqual(applied.subModels.find((row) => row.name === 'Other Models').count, 42)
  assert.strictEqual(applied.renewalKind, 'renewing')
  assert.strictEqual(applied.cursorFetchSource, 'ide-api')

  const promoted = applyCursorOfficialTotal({ ...cache, ...ide })
  assert.strictEqual(promoted.totalPercent, 11)
  assert.strictEqual(promoted.percentUsed, 11)
}

function testGetCachedCannotClobberNewerIdeRow() {
  const ideRow = {
    service: 'cursor',
    totalPercent: 11,
    percentUsed: 11,
    lastRefreshAttemptAt: '2026-08-15T00:40:00.000Z',
    lastFetched: '2026-08-15T00:40:00.000Z'
  }
  const staleCache = {
    service: 'cursor',
    percentUsed: 4,
    lastRefreshAttemptAt: '2026-08-15T00:33:54.000Z',
    lastFetched: '2026-08-15T00:33:54.000Z'
  }
  const kept = preferNewerCursorUsage(ideRow, staleCache)
  assert.strictEqual(kept.totalPercent, 11)
  assert.strictEqual(cursorOfficialTotalPercent(kept), 11)

  const failedRefresh = {
    ...staleCache,
    isStale: true,
    error: 'Refresh failed: Plan & Usage API missed. Showing last known data.',
    lastRefreshAttemptAt: '2026-08-15T00:41:00.000Z'
  }
  const honestMiss = preferNewerCursorUsage(ideRow, failedRefresh)
  assert.strictEqual(honestMiss.totalPercent, 11)
  assert.strictEqual(honestMiss.isStale, true)
  assert.match(honestMiss.error, /Plan & Usage API missed/)
}

function cacheShapeFrom0124() {
  return {
    service: 'cursor',
    status: 'ok',
    isStale: false,
    percentUsed: 4,
    currentUsage: 4,
    weeklyPercentUsed: 42,
    renewalKind: 'cancelled',
    lastFetched: '2026-08-15T01:24:27.390Z',
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
}

function test0124CacheIsNotConnectedAndCannotOverlay() {
  const row = cacheShapeFrom0124()
  assert.strictEqual(cursorOfficialTotalPercent(row), null)
  assert.strictEqual(cursorLooksConnected(row), false, '4/42 with no Total must not look Connected')
  assert.strictEqual(cursorSnapshotMayOverlay(row), false, 'history fallback must not revive 4/42')

  const demoted = demoteIncompleteCursorUsage(row)
  assert.strictEqual(demoted.isStale, true)
  assert.strictEqual(cursorLooksConnected(demoted), false)
  assert.match(demoted.error, /cursor\.com/)
}

function testSnapshotWithOfficialTotalMayOverlay() {
  const snapshot = {
    percentUsed: 14,
    totalPercent: 14,
    metrics: [{ id: 'cursor:total', percent: 14 }],
    subModels: [
      { name: 'Cursor Models', count: 7, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  assert.strictEqual(cursorSnapshotMayOverlay(snapshot), true)
  assert.strictEqual(cursorLooksConnected({ ...snapshot, status: 'ok', isStale: false }), true)
}

function testIdeFourteenSevenFortyTwoPersists() {
  const applied = materializeCursorIdeReading({
    totalPercent: 14,
    weeklyPercentUsed: 42,
    renewalKind: 'renewing',
    renewalDate: '2026-09-12',
    subModels: [
      { name: 'Cursor Models', count: 7, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  })
  assert.strictEqual(applied.totalPercent, 14)
  assert.strictEqual(applied.percentUsed, 14)
  assert.strictEqual(applied.weeklyPercentUsed, 42)
  assert.strictEqual(applied.subModels.find((row) => row.name === 'Cursor Models').count, 7)
  assert.strictEqual(applied.renewalKind, 'renewing')
  assert.strictEqual(applied.cursorFetchSource, 'ide-api')
  assert.strictEqual(CURSOR_WRITE_PATH, 'ide-api-v1')
}

function testFetcherUsesNormalScrapeLoop() {
  const fs = require('fs')
  const path = require('path')
  // The scrape loop now lives in refreshCoordinator (usageFetcher wires the
  // ports); check the union so a Cursor-only early return is caught anywhere.
  const src =
    fs.readFileSync(path.join(__dirname, '../src/main/usageFetcher.ts'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '../src/main/refreshCoordinator.ts'), 'utf8')
  assert.doesNotMatch(
    src,
    /if \(serviceId === 'cursor'\) \{\s*return fetchCursorUsageIdeOnly/,
    'Cursor must use scraper.scrape() like the other cards'
  )
  assert.doesNotMatch(src, /function fetchCursorUsageIdeOnly/, 'Cursor-only persist path must be gone')
  assert.match(src, /scraped = await scraper\.scrape\(\)/, 'normal scrape loop must remain')
}

function testWebPersistShapeLooksConnected() {
  const applied = materializeCursorIdeReading({
    totalPercent: 15,
    weeklyPercentUsed: 42,
    renewalKind: 'renewing',
    renewalDate: '2026-09-12',
    subModels: [
      { name: 'Cursor Models', count: 8, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  })
  const row = { ...applied, status: 'ok', isStale: false, cursorFetchSource: 'web-api' }
  assert.strictEqual(cursorOfficialTotalPercent(row), 15)
  assert.strictEqual(cursorLooksConnected(row), true)
  assert.strictEqual(row.percentUsed, 15)
  assert.strictEqual(row.weeklyPercentUsed, 42)
  assert.strictEqual(row.renewalKind, 'renewing')
}

testOfficialTotalIsRequiredForHeadline()
testLivePlanAndUsageHeadline()
testMetricFallbackStillRequiresCursorTotalId()
testFourFortyTwoCachePlusIdeScrapePersistsOfficialTotal()
testGetCachedCannotClobberNewerIdeRow()
test0124CacheIsNotConnectedAndCannotOverlay()
testSnapshotWithOfficialTotalMayOverlay()
testIdeFourteenSevenFortyTwoPersists()
testFetcherUsesNormalScrapeLoop()
testWebPersistShapeLooksConnected()
console.log('cursor usage contract smoke test passed')
