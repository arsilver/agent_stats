/**
 * One-off probe: why is kimi.com/membership/subscription?tab=quota blank
 * (empty innerText) in the hidden scraper window? Dumps render diagnostics.
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

  const probe = await win.webContents.executeJavaScript(`(() => {
    const b = document.body;
    const shadowHosts = [];
    document.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) shadowHosts.push(el.tagName.toLowerCase()); });
    return {
      readyState: document.readyState,
      url: location.href,
      title: document.title,
      innerTextLen: b ? b.innerText.length : -1,
      innerTextPreview: b ? b.innerText.substring(0, 300) : null,
      bodyHtmlSnippet: b ? b.innerHTML.replace(/\\s+/g, ' ').substring(0, 800) : null,
      shadowHosts: shadowHosts.slice(0, 10),
      scripts: document.scripts.length,
      lsKeys: Object.keys(localStorage).slice(0, 25)
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
