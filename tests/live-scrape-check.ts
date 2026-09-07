/**
 * Live scraper validation harness (v2 — interactive-sign-in safe).
 *
 * Runs the REAL scraper code end-to-end inside Electron against a sandboxed
 * copy of the app's userData profile. Progress is teed to a log file so the
 * run is observable even if the parent shell times out. Cookies are flushed
 * periodically while the login window is open so a completed sign-in survives
 * even a hard kill of this harness.
 *
 * Env:
 *   AGENT_STATS_TEST_PROFILE    - path to the copied userData dir (required)
 *   AGENT_STATS_TEST_LOGIN=1    - open visible login windows for sign-in
 *   AGENT_STATS_TEST_SERVICES   - comma list, default all targets
 *   AGENT_STATS_SCRAPER_DEBUG=1 - write debug page snapshots into the copy
 */
import { app, session } from 'electron'
import { appendFileSync, writeFileSync } from 'fs'

const LOG_FILE = process.env.AGENT_STATS_TEST_LOG || 'tmp/live-scrape-log.txt'
const origLog = console.log.bind(console)
const origErr = console.error.bind(console)
function tee(prefix: string, args: unknown[]): void {
  try {
    appendFileSync(LOG_FILE, `${prefix}${args.map(String).join(' ')}\n`)
  } catch { /* ignore */ }
}
console.log = (...args: unknown[]) => { origLog(...args); tee('', args) }
console.error = (...args: unknown[]) => { origErr(...args); tee('ERR ', args) }

const TEST_PROFILE = process.env.AGENT_STATS_TEST_PROFILE
if (!TEST_PROFILE) {
  console.error('FATAL: AGENT_STATS_TEST_PROFILE not set')
  process.exit(1)
}
app.setPath('userData', TEST_PROFILE)
// Never quit just because a window closed — the flow is driven by main().
app.on('window-all-closed', () => {})

const ALL_TARGETS: Array<{ id: string; domain: string }> = [
  { id: 'kimi-code', domain: 'kimi.ai' },
  { id: 'cursor', domain: 'cursor.com' },
  { id: 'higgsfield', domain: 'higgsfield.ai' }
]

const TARGETS = process.env.AGENT_STATS_TEST_SERVICES
  ? ALL_TARGETS.filter((t) => process.env.AGENT_STATS_TEST_SERVICES!.split(',').includes(t.id))
  : ALL_TARGETS

async function checkCookies(serviceId: string, domain: string): Promise<number> {
  const ses = session.fromPartition(`persist:scraper-${serviceId}`)
  const cookies = await ses.cookies.get({})
  const relevant = cookies.filter((c) => (c.domain || '').includes(domain))
  const names = relevant.map((c) => {
    const anyC = c as { name: string; expirationDate?: number }
    const exp = anyC.expirationDate ? new Date(anyC.expirationDate * 1000).toISOString().slice(0, 10) : 'SESSION'
    return `${c.name}<${exp}>`
  })
  console.log(`COOKIES ${serviceId}: ${relevant.length} matching ${domain} -> [${names.join(', ')}]`)
  return relevant.length
}

async function main(): Promise<void> {
  writeFileSync(LOG_FILE, `=== live-scrape-check @ ${new Date().toISOString()} ===\n`)
  await app.whenReady()
  console.log(`profile: ${app.getPath('userData')}`)

  const { getScraper } = await import('../src/main/scrapers/index')

  for (const { id, domain } of TARGETS) {
    console.log(`\n--- ${id} ---`)
    const scraper = getScraper(id) as any
    if (!scraper) {
      console.log(`SCRAPE ${id}: NOT REGISTERED`)
      continue
    }
    await checkCookies(id, domain)

    let loggedIn = false
    try {
      loggedIn = await scraper.isLoggedIn()
    } catch (e: any) {
      console.log(`isLoggedIn ${id} threw: ${e?.message || e}`)
    }
    console.log(`isLoggedIn ${id}: ${loggedIn}`)

    if (!loggedIn && process.env.AGENT_STATS_TEST_LOGIN === '1') {
      console.log(`LOGIN ${id}: opening login window — please sign in...`)
      // Flush cookies every 5s while the window is open so a completed
      // sign-in lands on disk even if this harness is later killed.
      const ses = session.fromPartition(`persist:scraper-${id}`)
      const flushTimer = setInterval(() => {
        ses.cookies.flushStore().catch(() => undefined)
      }, 5000)
      try {
        await scraper.openLoginWindow()
        console.log(`LOGIN ${id}: window closed (outcome=${scraper.getLastLoginOutcome?.() ?? 'unknown'})`)
      } catch (e: any) {
        console.log(`LOGIN ${id} threw: ${e?.message || e}`)
      } finally {
        clearInterval(flushTimer)
        try {
          await ses.cookies.flushStore()
        } catch { /* ignore */ }
      }
      await checkCookies(id, domain)
      try {
        loggedIn = await scraper.isLoggedIn()
      } catch { /* ignore */ }
      console.log(`isLoggedIn ${id} after login window: ${loggedIn}`)
    }

    const t0 = Date.now()
    try {
      const result = await scraper.scrape()
      const ms = Date.now() - t0
      console.log(`SCRAPE ${id}: completed in ${ms}ms`)
      console.log(`FAILURE_REASON ${id}: ${scraper.getLastFailureReason?.() ?? 'null'}`)
      console.log(`RESULT ${id}: ${JSON.stringify(result)}`)
    } catch (e: any) {
      console.log(`SCRAPE ${id}: THREW after ${Date.now() - t0}ms -> ${e?.message || e}`)
    }
  }

  console.log('\n=== done ===')
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
