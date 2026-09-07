const assert = require('assert')
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const output = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18'
  })
  module._compile(output.code, filename)
}

const {
  hasDualWindowBars,
  dualWindowLabels
} = require('../src/shared/dualWindowUsage.ts')

function testChatgptWithBothWindowsUsesDualBars() {
  assert.strictEqual(
    hasDualWindowBars({
      service: 'chatgpt',
      percentUsed: 100,
      weeklyPercentUsed: 96
    }),
    true,
    'ChatGPT Codex with 5h + weekly must use DualWindow'
  )
}

function testChatgptWeeklyOnlyIsSingleBar() {
  assert.strictEqual(
    hasDualWindowBars({
      service: 'chatgpt',
      percentUsed: 98,
      weeklyPercentUsed: null
    }),
    false,
    'weekly-as-primary Codex must not invent a second bar'
  )
}

function testCursorNeverUsesDualWindow() {
  assert.strictEqual(
    hasDualWindowBars({
      service: 'cursor',
      percentUsed: 15,
      weeklyPercentUsed: 42
    }),
    false
  )
}

function testQwenCloneDoesNotDual() {
  assert.strictEqual(
    hasDualWindowBars({
      service: 'qwen',
      currentUsage: 100,
      usageLimit: 1000,
      percentUsed: 10,
      weeklyUsage: 100,
      weeklyLimit: 1000,
      weeklyPercentUsed: 10
    }),
    false
  )
}

function testWeeklyOrTotalIsTheTopLabel() {
  assert.deepStrictEqual(dualWindowLabels('chatgpt'), {
    top: 'Weekly Limit',
    bottom: '5-Hour Limit'
  })
  assert.deepStrictEqual(dualWindowLabels('qwen'), {
    top: '7-Day Credits',
    bottom: '5-Hour Credits'
  })
  assert.deepStrictEqual(dualWindowLabels('minimax'), {
    top: 'Weekly Tokens',
    bottom: '5-Hour Tokens'
  })
}

function testUsageCardRendersWeeklyFirst() {
  const card = fs.readFileSync(
    path.join(__dirname, '../src/renderer/src/components/UsageCard.tsx'),
    'utf8'
  )
  const topIdx = card.indexOf('labels.top')
  const bottomIdx = card.indexOf('labels.bottom')
  assert.ok(topIdx > 0 && bottomIdx > 0, 'DualWindow must render labels.top and labels.bottom')
  assert.ok(topIdx < bottomIdx, 'weekly/total (labels.top) must render before 5-hour (labels.bottom)')
  assert.match(card, /hasDualWindowBars\(data\)/, 'Codex must not be MiniMax/Qwen-only')
}

testChatgptWithBothWindowsUsesDualBars()
testChatgptWeeklyOnlyIsSingleBar()
testCursorNeverUsesDualWindow()
testQwenCloneDoesNotDual()
testWeeklyOrTotalIsTheTopLabel()
testUsageCardRendersWeeklyFirst()

console.log('dual-window smoke test passed')
