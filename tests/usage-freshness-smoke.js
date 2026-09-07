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
  createStaleUsageData,
  isUsageDataFresh
} = require('../src/main/usageFreshness.ts')

function makeLastGoodUsage() {
  return {
    service: 'claude',
    displayName: 'Claude',
    planTier: 'Max 200',
    currentUsage: 42,
    usageLimit: 100,
    usageUnit: '% used',
    percentUsed: 42,
    resetsAt: '2026-08-02T12:00:00.000Z',
    resetCountdown: '15h',
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    weeklyResetsAt: null,
    weeklyResetCountdown: null,
    lastFetched: '2026-08-01T10:00:00.000Z',
    status: 'ok',
    iconColor: '#cc785c',
    renewalDate: null,
    renewalKind: null
  }
}

function testFailedRefreshKeepsLastSuccessfulTimestamp() {
  const lastGood = makeLastGoodUsage()
  const attemptedAt = '2026-08-01T18:47:00.000Z'
  const stale = createStaleUsageData(
    lastGood,
    attemptedAt,
    'Refresh failed: signed in, but the scraper could not parse the current layout.'
  )

  assert.strictEqual(stale.status, 'ok', 'last-known usage should remain displayable')
  assert.strictEqual(stale.isStale, true, 'a failed refresh must be marked stale')
  assert.strictEqual(stale.lastFetched, lastGood.lastFetched, 'lastFetched must remain the last successful refresh')
  assert.strictEqual(stale.lastRefreshAttemptAt, attemptedAt, 'the failed attempt should be tracked separately')
  assert.strictEqual(isUsageDataFresh(stale), false, 'stale data must not satisfy the polling TTL')
}

function testLegacyFailedRefreshNeverCountsAsFresh() {
  const poisonedCacheEntry = {
    ...makeLastGoodUsage(),
    lastFetched: '2026-08-01T21:19:49.049Z',
    error: 'Refresh failed — showing cached data'
  }

  assert.strictEqual(
    isUsageDataFresh(poisonedCacheEntry),
    false,
    'legacy failed-refresh entries must bypass the polling TTL'
  )
}

function testCursorPoolsWithoutOfficialTotalAreNeverFresh() {
  const incomplete = {
    ...makeLastGoodUsage(),
    service: 'cursor',
    displayName: 'Cursor',
    percentUsed: 4,
    weeklyPercentUsed: 42,
    lastFetched: new Date().toISOString(),
    subModels: [
      { name: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', count: 42, total: 100 }
    ]
  }
  assert.strictEqual(
    isUsageDataFresh(incomplete),
    false,
    'Cursor 4%/42% without Total must not be treated as fresh (Refresh would skip the IDE API)'
  )

  const complete = { ...incomplete, totalPercent: 11, percentUsed: 11 }
  assert.strictEqual(isUsageDataFresh(complete), true, 'Cursor with official Total is fresh')
}

testFailedRefreshKeepsLastSuccessfulTimestamp()
testLegacyFailedRefreshNeverCountsAsFresh()
testCursorPoolsWithoutOfficialTotalAreNeverFresh()

console.log('usage freshness smoke test passed')
