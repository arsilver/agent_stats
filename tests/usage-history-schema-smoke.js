const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8')
}

function testCacheSchemaV2() {
  const text = read('src/main/usageFetcher.ts')
  assert(/const\s+CACHE_SCHEMA_VERSION\s*=\s*2\b/.test(text), 'usage cache schema should be v2')
  assert(/schema_version/.test(text), 'cache file should include schema_version')
  assert(/migrateCacheFile/.test(text), 'cache should have an explicit migration path')
}

function testMetricSnapshotTable() {
  const text = read('src/main/usageHistory.ts')
  assert(/CREATE TABLE IF NOT EXISTS usage_metric_snapshots/.test(text), 'history should create usage_metric_snapshots')
  for (const column of ['metric_id', 'service', 'timestamp', 'label', 'scope', 'source', 'unit', 'value', 'usage_limit', 'percent', 'polarity', 'resets_at']) {
    assert(text.includes(column), `metric snapshot table should include ${column}`)
  }
  assert(/idx_usage_metrics_service_metric_time/.test(text), 'metric snapshots should be indexed by service + metric + timestamp')
  assert(/snapshot\.metrics/.test(text), 'saveUsageSnapshot should persist metric rows')
  assert(/getMetricsForSnapshot/.test(text), 'history reads should attach metric rows')
}

testCacheSchemaV2()
testMetricSnapshotTable()

console.log('usage history schema smoke test passed')
