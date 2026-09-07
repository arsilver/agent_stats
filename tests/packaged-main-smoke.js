const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const archivePath = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
const extractDir = path.join(root, 'tmp', 'packaged-main-smoke')

function assertInsideRoot(candidatePath) {
  const resolved = path.resolve(candidatePath)
  const tmpRoot = path.resolve(root, 'tmp')
  if (resolved !== tmpRoot && !resolved.startsWith(`${tmpRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove path outside tmp: ${resolved}`)
  }
}

function readExtractedFile(filePath) {
  const fullPath = path.join(extractDir, filePath)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing ${filePath} in extracted app.asar`)
  }
  return fs.readFileSync(fullPath, 'utf8')
}

if (!fs.existsSync(archivePath)) {
  console.error(`Packaged smoke test failed: ${archivePath} does not exist.`)
  process.exit(1)
}

try {
  assertInsideRoot(extractDir)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  asar.extractAll(archivePath, extractDir)

  const packageJson = JSON.parse(readExtractedFile('package.json'))
  const mainFile = (packageJson.main || './out/main/index.js').replace(/^\.\//, '').replace(/\\/g, '/')
  const mainText = readExtractedFile(mainFile)
  const preloadText = readExtractedFile('out/preload/index.js')

  const missing = []
  if (!mainText.includes('usage:reconnect')) missing.push(`${mainFile}: usage:reconnect`)
  if (!preloadText.includes('usage:reconnect')) missing.push('out/preload/index.js: usage:reconnect')

  if (missing.length > 0) {
    console.error(`Packaged smoke test failed. Missing: ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log(`Packaged smoke test passed (${mainFile} and out/preload/index.js include usage:reconnect).`)
} catch (err) {
  console.error(`Packaged smoke test failed: ${err.message}`)
  process.exit(1)
}
