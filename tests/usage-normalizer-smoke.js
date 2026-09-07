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
  normalizeUsageMetrics,
  metricsToSubModels
} = require('../src/main/usageNormalizer.ts')

function testNormalizesServiceAndBreakdownMetrics() {
  const metrics = normalizeUsageMetrics('fal-ai', {
    currentUsage: 3.25,
    usageLimit: 10,
    percentUsed: 33,
    usageUnit: '$ spend',
    resetsAt: null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    subModels: [
      { name: 'fal-ai/flux/dev', count: 2, total: 3.25 },
      { modelName: 'fal-ai/kling-video/v2.1', count: 1.25, total: 3.25 }
    ]
  })

  assert.strictEqual(metrics[0].id, 'fal-ai:primary')
  assert.strictEqual(metrics[0].scope, 'service')
  assert.strictEqual(metrics[0].polarity, 'spend')
  assert.strictEqual(metrics[1].id, 'fal-ai:model:fal-ai-flux-dev')
  assert.strictEqual(metrics[1].scope, 'model')
  assert.strictEqual(metrics[1].source, 'scraper')
  assert.strictEqual(metrics[2].label, 'fal-ai/kling-video/v2.1')
}

function testProjectsMetricsToLegacySubModels() {
  const metrics = normalizeUsageMetrics('gemini', {
    currentUsage: 80,
    usageLimit: 100,
    percentUsed: 80,
    usageUnit: '% quota used',
    resetsAt: '2026-05-06T21:35:47.000Z',
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    subModels: [
      {
        name: 'Gemini 3.1 Pro (High)',
        count: 80,
        total: 100,
        resetsAt: '2026-05-06T21:35:47.000Z'
      }
    ]
  })

  const projected = metricsToSubModels(metrics)
  assert.deepStrictEqual(projected, [
    {
      name: 'Gemini 3.1 Pro (High)',
      modelName: 'Gemini 3.1 Pro (High)',
      count: 80,
      total: 100,
      resetsAt: '2026-05-06T21:35:47.000Z'
    }
  ])
}

function testQwenWeeklyUnitNotInheritedFromLiftedPrimary() {
  const metrics = normalizeUsageMetrics('qwen', {
    currentUsage: 0,
    usageLimit: null,
    percentUsed: 0,
    usageUnit: '5h lifted',
    resetsAt: null,
    weeklyUsage: 6020,
    weeklyLimit: 10000,
    weeklyPercentUsed: 60.2,
    weeklyResetsAt: '2026-08-12T21:34:00.000Z',
    weeklyBarLabel: '7-day'
  })

  assert.strictEqual(metrics[0].id, 'qwen:primary')
  assert.strictEqual(metrics[0].unit, '5h lifted')
  assert.strictEqual(metrics[1].id, 'qwen:weekly')
  assert.strictEqual(metrics[1].label, '7-day')
  assert.strictEqual(metrics[1].unit, 'credits', 'weekly must not inherit "5h lifted"')
  assert.strictEqual(metrics[1].value, 6020)
  assert.strictEqual(metrics[1].limit, 10000)
  assert.strictEqual(metrics[1].percent, 60.2)
}

function testCursorModelPoolScope() {
  const metrics = normalizeUsageMetrics('cursor', {
    currentUsage: 4,
    usageLimit: 100,
    percentUsed: 4,
    usageUnit: '%',
    weeklyUsage: 14,
    weeklyLimit: 100,
    weeklyPercentUsed: 14,
    weeklyBarLabel: 'Other Models',
    totalPercent: 4,
    totalBarLabel: 'Total',
    subModels: [
      { name: 'Cursor Models', count: 2, total: 100 },
      { name: 'Other Models', count: 14, total: 100 }
    ]
  })

  const cursorModels = metrics.find((metric) => metric.id === 'cursor:model:cursor-models')
  const otherModels = metrics.find((metric) => metric.id === 'cursor:model:other-models')
  assert(cursorModels, 'expected a Cursor Models metric')
  assert.strictEqual(cursorModels.scope, 'model')
  assert(otherModels, 'expected an Other Models metric')
  assert.strictEqual(otherModels.scope, 'model')
  assert.strictEqual(otherModels.percent, 14)
  const total = metrics.find((metric) => metric.id === 'cursor:total')
  assert(total, 'expected a Cursor Total metric for the card headline')
  assert.strictEqual(total.percent, 4)
  assert.strictEqual(total.label, 'Total')
}

function testGrokBotMetricIsNotProjectedIntoSubModels() {
  const metrics = normalizeUsageMetrics('grok', {
    currentUsage: 22,
    usageLimit: 100,
    percentUsed: 22,
    usageUnit: 'weekly used',
    grokBotPercentUsed: 15.46571,
    grokBotResetsAt: '2026-09-02T02:25:37.520Z',
    subModels: [
      { name: 'Grok Build', count: 18, total: 100 },
      { name: 'Voice', count: 3, total: 100 }
    ]
  })

  const bot = metrics.find((metric) => metric.id === 'grok:tool:grok-bot')
  assert(bot, 'expected grok:tool:grok-bot')
  assert.strictEqual(bot.label, 'Grok Bot')
  assert.strictEqual(bot.percent, 15.46571)
  assert.strictEqual(bot.resetsAt, '2026-09-02T02:25:37.520Z')
  assert.strictEqual(metrics.find((metric) => metric.id === 'grok:weekly'), undefined)
  const projected = metricsToSubModels(metrics)
  assert(projected)
  assert.strictEqual(
    projected.some((row) => /grok bot/i.test(row.name || '')),
    false,
    'Grok Bot must stay off Model Pools'
  )
}

function testChatgptWeeklyUnitNotInheritedFromFiveHourPrimary() {
  const metrics = normalizeUsageMetrics('chatgpt', {
    currentUsage: 100,
    usageLimit: null,
    percentUsed: 100,
    usageUnit: '% 5-hour limit',
    isRemainingTracker: true,
    weeklyUsage: 96,
    weeklyLimit: null,
    weeklyPercentUsed: 96,
    weeklyBarLabel: 'Weekly Limit'
  })

  assert.strictEqual(metrics[0].id, 'chatgpt:primary')
  assert.strictEqual(metrics[0].unit, '% 5-hour limit')
  const weekly = metrics.find((metric) => metric.id === 'chatgpt:weekly')
  assert(weekly, 'expected a weekly metric')
  assert.strictEqual(weekly.label, 'Weekly Limit')
  assert.strictEqual(weekly.unit, '% weekly limit', 'weekly must not inherit "% 5-hour limit"')
  assert.strictEqual(weekly.percent, 96)
}

testNormalizesServiceAndBreakdownMetrics()
testProjectsMetricsToLegacySubModels()
testQwenWeeklyUnitNotInheritedFromLiftedPrimary()
testChatgptWeeklyUnitNotInheritedFromFiveHourPrimary()
testCursorModelPoolScope()
testGrokBotMetricIsNotProjectedIntoSubModels()

console.log('usage normalizer smoke test passed')
