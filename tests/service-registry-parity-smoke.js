const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8')
}

function parseProfileIds() {
  const text = read('src/main/authProfiles.ts')
  return [...text.matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1])
}

function parseScraperIds() {
  const text = read('src/main/scrapers/index.ts')
  const objectMatch = text.match(/const scrapers:[\s\S]*?=\s*\{([\s\S]*?)\n\}/)
  assert(objectMatch, 'scraper registry object should be present')
  return [...objectMatch[1].matchAll(/(?:^|\n)\s*(?:'([^']+)'|([a-zA-Z][\w-]*))\s*:/g)]
    .map((match) => match[1] || match[2])
}

const expected = [
  'chatgpt',
  'claude',
  'kimi-code',
  'minimax',
  'runwayml',
  'fal-ai',
  'openrouter',
  'cursor',
  'gemini',
  'higgsfield',
  'grok',
  'qwen'
]

const profileIds = parseProfileIds().sort()
const scraperIds = parseScraperIds().sort()

assert.deepStrictEqual(profileIds, expected.slice().sort(), 'auth profile catalog should contain the configured services')
assert.deepStrictEqual(scraperIds, profileIds, 'scraper registry should match auth profile catalog exactly')

console.log('service registry parity smoke test passed')
