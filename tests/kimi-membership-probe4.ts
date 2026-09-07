/**
 * Probe #4: find the working method/shape for the kimi quota API.
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
    if (!token) return { error: 'no access_token' };
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
    const grab = async (label, url, options) => {
      try {
        const resp = await fetch(url, { headers, ...options });
        const text = await resp.text();
        return { label, status: resp.status, body: text.substring(0, 5000) };
      } catch (e) {
        return { label, error: String(e) };
      }
    };
    const results = [];
    results.push(await grab('POST /api/user/usage', '/api/user/usage', { method: 'POST', body: '{}' }));
    if (results[0].status === 405) {
      results.push(await grab('GET /api/membership/subscription', '/api/membership/subscription'));
      results.push(await grab('GET /api/user/quota', '/api/user/quota'));
    }
    return results;
  })()`, true)

  console.log(JSON.stringify(probe, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
