const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8')
}

function collectUsageApiMethodsFromPreload() {
  const text = read('src/preload/index.ts')
  const objectMatch = text.match(/const usageAPI = \{([\s\S]*?)\n\}/)
  assert(objectMatch, 'preload usageAPI object should be present')
  const methods = new Set()
  const re = /\n\s+([a-zA-Z]\w*)\s*:/g
  let match
  while ((match = re.exec(objectMatch[1])) !== null) {
    methods.add(match[1])
  }
  return methods
}

function collectUsageApiMethodsFromTypes() {
  const text = read('src/preload/index.d.ts')
  const ifaceMatch = text.match(/interface UsageAPI \{([\s\S]*?)\n\}/)
  assert(ifaceMatch, 'preload UsageAPI declaration should be present')
  const methods = new Set()
  const re = /\n\s+([a-zA-Z]\w*)\(/g
  let match
  while ((match = re.exec(ifaceMatch[1])) !== null) {
    methods.add(match[1])
  }
  return methods
}

function testSharedUsageContractExists() {
  const contractPath = path.join(root, 'src/shared/usageTypes.ts')
  assert(fs.existsSync(contractPath), 'src/shared/usageTypes.ts should define shared usage contracts')
  const text = fs.readFileSync(contractPath, 'utf8')
  for (const symbol of [
    'UsageData',
    'UsageMetric',
    'UsageMetricPolarity',
    'PublicServiceProfile',
    'UsageHistoryPoint'
  ]) {
    assert(
      new RegExp(`export\\s+(?:interface|type)\\s+${symbol}\\b`).test(text),
      `shared contract should export ${symbol}`
    )
  }
}

function testPreloadDeclarationMatchesRuntime() {
  const runtimeMethods = collectUsageApiMethodsFromPreload()
  const declaredMethods = collectUsageApiMethodsFromTypes()
  const missing = [...runtimeMethods].filter((method) => !declaredMethods.has(method)).sort()
  assert.deepStrictEqual(missing, [], `preload UsageAPI type is missing runtime methods: ${missing.join(', ')}`)
}

function testRendererDoesNotHardcodeServiceCatalogs() {
  const hardcodedCatalogFiles = [
    'src/renderer/src/pages/Settings.tsx',
    'src/renderer/src/pages/Charts.tsx',
    'src/renderer/src/pages/AiGotchi.tsx'
  ]

  for (const relPath of hardcodedCatalogFiles) {
    const text = read(relPath)
    assert(
      !/const\s+SERVICES\s*[:=]/.test(text) && !/const\s+CHARACTERS\s*[:=]/.test(text),
      `${relPath} should derive service metadata from the shared profile catalog`
    )
  }
}

testSharedUsageContractExists()
testPreloadDeclarationMatchesRuntime()
testRendererDoesNotHardcodeServiceCatalogs()

console.log('usage contract smoke test passed')
