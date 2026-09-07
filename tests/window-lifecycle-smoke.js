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
  shouldQuitWhenLastWindowCloses,
  shouldRecreateMainWindow,
  pickWindowRevealReason,
  WINDOW_REVEAL_FALLBACK_MS
} = require('../src/main/windowLifecycle.ts')

function testLastWindowCloseQuitsOnWindowsEvenInDev() {
  assert.strictEqual(shouldQuitWhenLastWindowCloses('win32'), true)
  assert.strictEqual(shouldQuitWhenLastWindowCloses('linux'), true)
  assert.strictEqual(
    shouldQuitWhenLastWindowCloses('darwin'),
    false,
    'macOS keeps the dock icon until explicit quit'
  )
}

function testSecondInstanceRecreatesOnlyWhenTheWindowIsGone() {
  assert.strictEqual(
    shouldRecreateMainWindow({ hasWindow: false, isDestroyed: true, isQuitting: false }),
    true
  )
  assert.strictEqual(
    shouldRecreateMainWindow({ hasWindow: true, isDestroyed: true, isQuitting: false }),
    true
  )
  assert.strictEqual(
    shouldRecreateMainWindow({ hasWindow: true, isDestroyed: false, isQuitting: false }),
    false,
    'an existing window must be focused, not rebuilt'
  )
  assert.strictEqual(
    shouldRecreateMainWindow({ hasWindow: false, isDestroyed: true, isQuitting: true }),
    false,
    'do not spawn a window while the process is quitting'
  )
}

function testWindowMustRevealEvenIfReadyToShowNeverFires() {
  assert.ok(WINDOW_REVEAL_FALLBACK_MS >= 1000)
  assert.strictEqual(
    pickWindowRevealReason({
      alreadyShown: false,
      readyToShow: false,
      didFinishLoad: false,
      didFailLoad: false,
      timeoutElapsed: true
    }),
    'startup-timeout'
  )
  assert.strictEqual(
    pickWindowRevealReason({
      alreadyShown: true,
      readyToShow: true,
      didFinishLoad: true,
      didFailLoad: false,
      timeoutElapsed: true
    }),
    null
  )
  assert.strictEqual(
    pickWindowRevealReason({
      alreadyShown: false,
      readyToShow: false,
      didFinishLoad: false,
      didFailLoad: true,
      timeoutElapsed: false
    }),
    'did-fail-load',
    'a failed renderer load must still show a window instead of staying invisible'
  )
}

testLastWindowCloseQuitsOnWindowsEvenInDev()
testSecondInstanceRecreatesOnlyWhenTheWindowIsGone()
testWindowMustRevealEvenIfReadyToShowNeverFires()

console.log('window lifecycle smoke test passed')
