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

const { validateAndReconcileUsage } = require('../src/main/usageIntegrity.ts')

function grokUsage(overrides = {}) {
  return {
    service: 'grok',
    displayName: 'Grok',
    planTier: 'SuperGrok Heavy',
    currentUsage: 1,
    usageLimit: 100,
    usageUnit: 'weekly used',
    percentUsed: 1,
    resetsAt: '2026-08-07T14:42:00.000Z',
    resetCountdown: '5d 13h',
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    weeklyResetsAt: null,
    weeklyResetCountdown: null,
    lastFetched: '2026-08-02T01:09:54.694Z',
    status: 'ok',
    iconColor: '#64748b',
    renewalDate: null,
    renewalKind: null,
    subModels: [
      { name: 'Grok Build', modelName: 'Grok Build', count: 13, total: 100 },
      { name: 'Chat', modelName: 'Chat', count: 1, total: 100 },
      { name: 'grok-4 · 2h', modelName: 'grok-4 · 2h', count: 0, total: 140 },
      { name: 'Heavy · 2h', modelName: 'Heavy · 2h', count: 0, total: 20 }
    ],
    metrics: [
      {
        id: 'grok:primary', label: 'weekly used', scope: 'service', source: 'cache',
        unit: 'weekly used', value: 1, limit: 100, percent: 1,
        polarity: 'used', resetsAt: '2026-08-07T14:42:00.000Z'
      },
      {
        id: 'grok:tool:grok-build', label: 'Grok Build', scope: 'tool', source: 'cache',
        unit: 'weekly used', value: 13, limit: 100, percent: 13,
        polarity: 'used', resetsAt: null
      },
      {
        id: 'grok:tool:chat', label: 'Chat', scope: 'tool', source: 'cache',
        unit: 'weekly used', value: 1, limit: 100, percent: 1,
        polarity: 'used', resetsAt: null
      }
    ],
    ...overrides
  }
}

function testRepairsObservedGrokPayloadAndPrimaryMetric() {
  const result = validateAndReconcileUsage('grok', grokUsage())

  assert.strictEqual(result.disposition, 'repaired')
  assert.strictEqual(result.data.currentUsage, 14)
  assert.strictEqual(result.data.percentUsed, 14)
  assert.strictEqual(result.data.metrics.find((metric) => metric.id === 'grok:primary').value, 14)
  assert.strictEqual(result.data.metrics.find((metric) => metric.id === 'grok:primary').percent, 14)
  assert.deepStrictEqual(
    result.data.subModels.map((row) => [row.name, row.count, row.total]),
    [
      ['Grok Build', 13, 100],
      ['Chat', 1, 100],
      ['grok-4 · 2h', 0, 140],
      ['Heavy · 2h', 0, 20]
    ],
    'rolling pools remain unchanged and separate'
  )
}

function testRepairIsIdempotent() {
  const first = validateAndReconcileUsage('grok', grokUsage())
  const second = validateAndReconcileUsage('grok', first.data)

  assert.strictEqual(second.disposition, 'accepted')
  assert.deepStrictEqual(second.data, first.data)
}

function testKeepsHigherExplicitGrokHeadline() {
  const result = validateAndReconcileUsage('grok', grokUsage({
    currentUsage: 31,
    percentUsed: 31,
    metrics: undefined,
    subModels: [
      { name: 'Grok Build', count: 18, total: 100 },
      { name: 'API', count: 5, total: 100 },
      { name: 'Chat', count: 1, total: 100 }
    ]
  }))

  assert.strictEqual(result.disposition, 'accepted')
  assert.strictEqual(result.data.percentUsed, 31)
}

function testDeduplicatesWeeklyRowsBeforeReconciliation() {
  const result = validateAndReconcileUsage('grok', grokUsage({
    metrics: undefined,
    subModels: [
      { name: 'Grok Build', count: 13, total: 100 },
      { name: 'grok build', count: 13, total: 100 },
      { name: 'Chat', count: 1, total: 100 }
    ]
  }))

  assert.strictEqual(result.disposition, 'repaired')
  assert.strictEqual(result.data.percentUsed, 14)
}

function testDoesNotSumGrokBotIntoWeeklyHeadline() {
  const result = validateAndReconcileUsage('grok', grokUsage({
    currentUsage: 22,
    percentUsed: 22,
    grokBotPercentUsed: 15.46571,
    grokBotResetsAt: '2026-09-02T02:25:37.520Z',
    metrics: undefined,
    subModels: [
      { name: 'Grok Build', count: 18, total: 100 },
      { name: 'Voice', count: 3, total: 100 },
      { name: 'Chat', count: 1, total: 100 },
      { name: 'Grok Bot', count: 15.46571, total: 100 }
    ]
  }))

  assert.strictEqual(result.disposition, 'accepted')
  assert.strictEqual(result.data.percentUsed, 22, 'Grok Bot must not enter the SuperGrok product sum')
  assert.strictEqual(result.data.grokBotPercentUsed, 15.46571)
}

function testRejectsImpossibleGrokProductTotal() {
  const result = validateAndReconcileUsage('grok', grokUsage({
    currentUsage: 80,
    percentUsed: 80,
    metrics: undefined,
    subModels: [
      { name: 'Grok Build', count: 80, total: 100 },
      { name: 'Chat', count: 30, total: 100 }
    ]
  }))

  assert.strictEqual(result.disposition, 'rejected')
}

function testDoesNotSumOtherServices() {
  const data = grokUsage({ service: 'claude', displayName: 'Claude', metrics: undefined })
  const result = validateAndReconcileUsage('claude', data)

  assert.strictEqual(result.disposition, 'accepted')
  assert.strictEqual(result.data.percentUsed, 1)
}

function cursorSpendingPageCache() {
  return {
    service: 'cursor',
    displayName: 'Cursor',
    planTier: 'Pro',
    currentUsage: 4,
    usageLimit: 100,
    usageUnit: '%',
    percentUsed: 4,
    weeklyUsage: 42,
    weeklyLimit: 100,
    weeklyPercentUsed: 42,
    weeklyBarLabel: 'Other Models',
    lastFetched: '2026-08-15T00:33:54.000Z',
    status: 'ok',
    isStale: false,
    renewalKind: 'cancelled',
    renewalDate: '2026-09-12',
    subModels: [
      { name: 'Cursor Models', modelName: 'Cursor Models', count: 4, total: 100 },
      { name: 'Other Models', modelName: 'Other Models', count: 42, total: 100 }
    ]
  }
}

function testRejectsCursorOkWithoutOfficialTotal() {
  const result = validateAndReconcileUsage('cursor', cursorSpendingPageCache())
  assert.strictEqual(result.disposition, 'rejected', '4/42 with no Total must not be stored as ok')
}

function testAcceptsCursorIdeTotalEleven() {
  const result = validateAndReconcileUsage('cursor', {
    ...cursorSpendingPageCache(),
    currentUsage: 11,
    percentUsed: 11,
    totalPercent: 11,
    totalBarLabel: 'Total',
    renewalKind: 'renewing'
  })
  assert.strictEqual(result.disposition, 'accepted')
  assert.strictEqual(result.data.totalPercent, 11)
}

function testRejectsInvalidAndIncoherentReadings() {
  assert.strictEqual(
    validateAndReconcileUsage('chatgpt', grokUsage({ currentUsage: -1, percentUsed: 0 })).disposition,
    'rejected'
  )
  assert.strictEqual(
    validateAndReconcileUsage('chatgpt', grokUsage({ currentUsage: 50, percentUsed: 10 })).disposition,
    'rejected'
  )
  assert.strictEqual(
    validateAndReconcileUsage('chatgpt', grokUsage({ currentUsage: 50, percentUsed: 101 })).disposition,
    'rejected'
  )
}

testRepairsObservedGrokPayloadAndPrimaryMetric()
testRepairIsIdempotent()
testKeepsHigherExplicitGrokHeadline()
testDeduplicatesWeeklyRowsBeforeReconciliation()
testDoesNotSumGrokBotIntoWeeklyHeadline()
testRejectsImpossibleGrokProductTotal()
testDoesNotSumOtherServices()
testRejectsCursorOkWithoutOfficialTotal()
testAcceptsCursorIdeTotalEleven()
testRejectsInvalidAndIncoherentReadings()

console.log('usage integrity smoke test passed')
