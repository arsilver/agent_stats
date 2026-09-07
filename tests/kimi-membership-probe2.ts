/**
 * Probe #2: find where the kimi membership quota data lives.
 * - is the quota text in the DOM at all (innerHTML search)?
 * - what does localStorage.msh_user_subscription_data contain?
 * - which API endpoints did the page call?
 *
 * Env: AGENT_STATS_TEST_PROFILE - path to the copied userData dir (required)
 */
import { app, BrowserWindow } from 'electron'

const TEST_PROFILE = process.env.AGENT_STATS_TEST_PROFILE
if (!TEST_PROFILE) {
  console.error('FATAL: AGENT_STATS_TEST_PROFILE not set')
  process.exit(1)
}
app.setPath('userData', TEST_PROFILE)
app.on('window-all-closed', () => {})

async function main(): Promise<void> {
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition: 'persist:scraper-kimi-code',
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await win.loadURL('https://www.kimi.com/membership/subscription?tab=quota')
  await new Promise((r) => setTimeout(r, 15000))

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const html = document.body ? document.body.innerHTML : '';
    const apiUrls = performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => /\\/api\\//.test(n))
      .slice(0, 40);
    let subData = null;
    try {
      const raw = localStorage.getItem('msh_user_subscription_data');
      subData = raw ? raw.substring(0, 3000) : null;
    } catch (e) { subData = 'ERR ' + e; }
    return {
      htmlHasUsageProgress: html.includes('Usage Progress'),
      htmlHasTotalUsage: html.includes('Total usage'),
      htmlHasAllegro: html.includes('Allegro'),
      htmlHasPercent: /\\d+(?:\\.\\d+)?\\s*%/.test(html),
      htmlLen: html.length,
      fullInnerText: document.body ? document.body.innerText : '',
      apiUrls,
      subData
    };
  })()`)

  console.log(JSON.stringify(probe, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
