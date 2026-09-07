const assert = require('assert')
const fs = require('fs')
const os = require('os')
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
  pruneSafeBrowserStorage
} = require('../src/main/storageMaintenance.ts')

function touch(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function exists(relativePath, root) {
  return fs.existsSync(path.join(root, relativePath))
}

function testPrunesSafeCacheDataAndPreservesAuthData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stats-storage-'))
  try {
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'Cache', 'blob.bin'), 'cache')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'Code Cache', 'js', 'code.bin'), 'code')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'GPUCache', 'gpu.bin'), 'gpu')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'Service Worker', 'CacheStorage', 'sw.bin'), 'sw')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'optimization_guide_model_store', 'model.bin'), 'model')
    touch(path.join(root, 'Partitions', 'scraper-kimi-code', 'Cache', 'entry.bin'), 'cache')

    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'Network', 'Cookies'), 'cookies')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'Local Storage', 'leveldb', '000003.log'), 'local')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'IndexedDB', 'https_chatgpt.com_0.indexeddb.leveldb', '000003.log'), 'idb')
    touch(path.join(root, 'managed-chrome', 'chatgpt', 'Default', 'Preferences'), 'prefs')
    touch(path.join(root, 'usage-cache.json'), '{}')

    const result = pruneSafeBrowserStorage(root)

    assert(result.removedBytes > 0, 'expected cleanup to remove bytes')
    assert(result.removedPaths.some((p) => p.includes('Cache')), 'expected cache directory to be removed')

    assert(!exists(path.join('managed-chrome', 'chatgpt', 'Default', 'Cache'), root), 'Cache should be removed')
    assert(!exists(path.join('managed-chrome', 'chatgpt', 'Default', 'Code Cache'), root), 'Code Cache should be removed')
    assert(!exists(path.join('managed-chrome', 'chatgpt', 'Default', 'GPUCache'), root), 'GPUCache should be removed')
    assert(!exists(path.join('managed-chrome', 'chatgpt', 'Default', 'Service Worker', 'CacheStorage'), root), 'Service Worker cache should be removed')
    assert(!exists(path.join('managed-chrome', 'chatgpt', 'optimization_guide_model_store'), root), 'optimization model cache should be removed')
    assert(!exists(path.join('Partitions', 'scraper-kimi-code', 'Cache'), root), 'Electron partition cache should be removed')

    assert(exists(path.join('managed-chrome', 'chatgpt', 'Default', 'Network', 'Cookies'), root), 'Cookies should be preserved')
    assert(exists(path.join('managed-chrome', 'chatgpt', 'Default', 'Local Storage', 'leveldb', '000003.log'), root), 'Local Storage should be preserved')
    assert(exists(path.join('managed-chrome', 'chatgpt', 'Default', 'IndexedDB', 'https_chatgpt.com_0.indexeddb.leveldb', '000003.log'), root), 'IndexedDB should be preserved')
    assert(exists(path.join('managed-chrome', 'chatgpt', 'Default', 'Preferences'), root), 'Preferences should be preserved')
    assert(exists('usage-cache.json', root), 'usage cache should be preserved')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

testPrunesSafeCacheDataAndPreservesAuthData()

console.log('storage maintenance tests passed')
