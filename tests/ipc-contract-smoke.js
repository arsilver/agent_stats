const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const preloadPath = path.join(root, 'src', 'preload', 'index.ts')
const mainRoot = path.join(root, 'src', 'main')

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else if (/\.(ts|tsx|js)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}

function collect(pattern, text) {
  const matches = new Set()
  let match
  while ((match = pattern.exec(text)) !== null) {
    matches.add(match[1])
  }
  return matches
}

const preloadText = fs.readFileSync(preloadPath, 'utf8')
const invokedUsageChannels = collect(/ipcRenderer\.invoke\(\s*['"`](usage:[^'"`]+)['"`]/g, preloadText)

const handledUsageChannels = new Set()
for (const file of walk(mainRoot)) {
  const text = fs.readFileSync(file, 'utf8')
  const handlerPattern =
    /(?:(?:ipcMain|electron\.ipcMain)\.handle|registerUsageIpcHandler)\(\s*['"`](usage:[^'"`]+)['"`]/g
  for (const channel of collect(handlerPattern, text)) {
    handledUsageChannels.add(channel)
  }
}

const missing = [...invokedUsageChannels]
  .filter((channel) => !handledUsageChannels.has(channel))
  .sort()

const required = ['usage:fetch', 'usage:getCached', 'usage:reconnect']
const missingRequired = required
  .filter((channel) => !handledUsageChannels.has(channel))
  .sort()

if (missing.length > 0 || missingRequired.length > 0) {
  console.error('IPC contract smoke test failed.')
  if (missing.length > 0) {
    console.error(`Preload invokes missing main handlers: ${missing.join(', ')}`)
  }
  if (missingRequired.length > 0) {
    console.error(`Required usage handlers missing: ${missingRequired.join(', ')}`)
  }
  process.exit(1)
}

console.log(
  `IPC contract smoke test passed (${invokedUsageChannels.size} preload usage channels, ${handledUsageChannels.size} main usage handlers).`
)
