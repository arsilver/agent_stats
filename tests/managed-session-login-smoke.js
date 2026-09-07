// Guards the Reconnect button's routing for managed-Chrome scrapers.
//
// BaseScraper.requiresExternalBrowserLogin() defaults to isCloudflareProtected().
// UsageCard.handleSessionAction() reads that flag (as data.manualCookieRefresh)
// and, when it is true, dispatches Reconnect to usage:importCookies — which for
// a managed-Chrome scraper is a no-op stub that counts Electron-partition
// cookies and never opens a sign-in window. The card then sits in
// "Cookies expired" forever with no way out.
//
// A scraper that signs in through its OWN managed Chrome profile
// (openLoginWindow -> openManagedChromeWindow) must therefore override
// requiresExternalBrowserLogin() to return false. Cursor and Grok both shipped
// without it; this test fails if either regresses, or if a new managed-Chrome
// scraper is added with the same omission.
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const scrapersDir = path.resolve(__dirname, '..', 'src', 'main', 'scrapers')

/** Does `methodName` exist in `source` with a literal `return <value>`? */
function returnsLiteral(source, methodName, value) {
  const re = new RegExp(
    `(?:public|protected|private)?\\s*${methodName}\\s*\\(\\s*\\)\\s*:\\s*boolean\\s*\\{\\s*return\\s+${value}\\s*\\}`
  )
  return re.test(source)
}

const offenders = []
const checked = []

for (const file of fs.readdirSync(scrapersDir).filter((f) => f.endsWith('Scraper.ts'))) {
  if (file === 'baseScraper.ts') continue
  const source = fs.readFileSync(path.join(scrapersDir, file), 'utf8')

  const managed = returnsLiteral(source, 'usesManagedBrowserSession', 'true')
  if (!managed) continue

  const cloudflare = returnsLiteral(source, 'isCloudflareProtected', 'true')
  const overrides = returnsLiteral(source, 'requiresExternalBrowserLogin', 'false')

  checked.push(file)

  // Only Cloudflare-flagged scrapers inherit a `true` default, so only they can
  // land on the dead cookie-import path.
  if (cloudflare && !overrides) offenders.push(file)
}

assert(checked.length > 0, 'expected to find managed-browser-session scrapers to check')

assert.deepStrictEqual(
  offenders,
  [],
  'managed-Chrome scrapers must override requiresExternalBrowserLogin() to return false, ' +
    'otherwise the Reconnect button dispatches to the no-op cookie-import stub instead of ' +
    'opening a sign-in window. Offenders: ' + offenders.join(', ')
)

console.log(
  `managed session login smoke test passed (${checked.length} managed-Chrome scrapers: ${checked.join(', ')})`
)
