const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
// API fetchers live in apiFetchers.ts; the primary-API call site is in the
// refresh coordinator's decision tree.
const text =
  fs.readFileSync(path.join(root, 'src/main/apiFetchers.ts'), 'utf8') +
  fs.readFileSync(path.join(root, 'src/main/refreshCoordinator.ts'), 'utf8')

function expect(pattern, message) {
  assert(pattern.test(text), message)
}

expect(/https:\/\/api\.dev\.runwayml\.com\/v1\/organization['"]/, 'Runway organization API should be wired')
expect(/https:\/\/api\.dev\.runwayml\.com\/v1\/organization\/usage['"]/, 'Runway organization usage API should be wired')
expect(/X-Runway-Version['"]:\s*['"]2024-11-06['"]/, 'Runway API should send the documented API version header')
expect(/https:\/\/api\.fal\.ai\/v1\/models\/usage/, 'fal.ai Platform Models Usage API should be wired')
expect(/Authorization:\s*`Key \$\{apiKey\}`/, 'fal.ai Platform API should use Authorization: Key')
expect(/https:\/\/openrouter\.ai\/api\/v1\/key/, 'OpenRouter current key API should be wired')
expect(/OpenAI API org cost \(30d\)/, 'OpenAI admin API metrics should be labeled as API usage')
expect(/Anthropic API org cost \(30d\)/, 'Anthropic admin API metrics should be labeled as API usage')
expect(/isPrimaryOfficialAPIService\(serviceId\)/, 'API fetches should only become primary for matching official surfaces')

console.log('usage API fetcher smoke test passed')
