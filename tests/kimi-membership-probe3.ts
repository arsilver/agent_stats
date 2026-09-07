/**
 * Probe #3: dump the kimi quota API responses.
 * Navigates to the lightweight /api/config JSON page (same origin, so
 * localStorage is accessible), then fetches /api/user/usage and /api/user
 * with the Bearer token from localStorage.
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
    width: 800,
    height: 600,
    webPreferences: {
      partition: 'persist:scraper-kimi-code',
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await win.loadURL('https://www.kimi.com/api/config')

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const token = localStorage.getItem('access_token');
    if (!token) return { error: 'no access_token in localStorage' };
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const grab = async (url) => {
      try {
        const resp = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers });
        const text = await resp.text();
        return { status: resp.status, body: text.substring(0, 4000) };
      } catch (e) {
        return { error: String(e) };
      }
    };
    return {
      usage: await grab('/api/user/usage'),
      user: await grab('/api/user')
    };
  })()`, true)

  console.log(JSON.stringify(probe, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
