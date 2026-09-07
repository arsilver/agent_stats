/**
 * Probe #6: capture the membership page's API calls via a main-world preload
 * interceptor (no CDP attach — kimi degrades when a debugger is attached).
 *
 * Env: AGENT_STATS_TEST_PROFILE - path to the copied userData dir (required)
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { appendFileSync, writeFileSync } from 'fs'

const LOG_FILE = 'tmp/kimi-probe6-log.txt'
function log(msg: string): void {
  try { appendFileSync(LOG_FILE, msg + '\n') } catch { /* ignore */ }
  console.log(msg)
}

const TEST_PROFILE = process.env.AGENT_STATS_TEST_PROFILE
if (!TEST_PROFILE) {
  console.error('FATAL: AGENT_STATS_TEST_PROFILE not set')
  process.exit(1)
}
app.setPath('userData', TEST_PROFILE)
app.on('window-all-closed', () => {})

async function main(): Promise<void> {
  writeFileSync(LOG_FILE, '')
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition: 'persist:scraper-kimi-code',
      contextIsolation: false, // preload must patch the MAIN world's fetch
      nodeIntegration: false,
      preload: join(__dirname, '..', 'kimi-probe-preload.js')
    }
  })

  try {
    await Promise.race([
      win.loadURL('https://www.kimi.com/membership/subscription?tab=quota'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadURL 20s budget')), 20000))
    ])
  } catch (e) {
    log(`loadURL: ${e} — inspecting partial state`)
    try { win.webContents.stop() } catch { /* ignore */ }
  }

  await new Promise((r) => setTimeout(r, 15000))

  const probe = await win.webContents.executeJavaScript(`({
    readyState: document.readyState,
    innerTextLen: document.body ? document.body.innerText.length : -1,
    apiLog: window.__apiLog || ['<no log>'],
    apiBodies: window.__apiBodies || {}
  })`)

  log(JSON.stringify(probe, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
