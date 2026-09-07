/**
 * Probe #5: intercept all fetch/XHR calls the membership page makes,
 * then dump the body of any that look quota/subscription-related.
 *
 * Env: AGENT_STATS_TEST_PROFILE - path to the copied userData dir (required)
 */
import { app, BrowserWindow } from 'electron'
import { appendFileSync, writeFileSync } from 'fs'

const LOG_FILE = 'tmp/kimi-probe5-log.txt'
function log(msg: string): void {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString().slice(11, 19)} ${msg}\n`) } catch { /* ignore */ }
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
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Inject the interceptor BEFORE page scripts run (same CDP pattern as baseScraper).
  log('attaching debugger...')
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
    await Promise.race([
      dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      window.__apiLog = [];
      window.__apiBodies = {};
      const of = window.fetch;
      window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const method = (args[1] && args[1].method) || 'GET';
        window.__apiLog.push(method + ' ' + url);
        const p = of.apply(this, args);
        p.then((r) => {
          try {
            if (/quota|subscription|membership|billing|usage|pay/i.test(url)) {
              r.clone().text().then((t) => { window.__apiBodies[method + ' ' + url] = t.substring(0, 3000); });
            }
          } catch (e) {}
        }).catch(() => {});
        return p;
      };
      const ox = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(m, u, ...rest) {
        window.__apiLog.push(m + ' ' + u);
        this.addEventListener('load', () => {
          try {
            if (/quota|subscription|membership|billing|usage|pay/i.test(String(u))) {
              window.__apiBodies[m + ' ' + u] = String(this.responseText).substring(0, 3000);
            }
          } catch (e) {}
        });
        return ox.call(this, m, u, ...rest);
      };
    `
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP inject timeout')), 8000))
    ])
    log('interceptor injected')
  } catch (e) {
    log(`CDP inject failed (continuing without interceptor): ${e}`)
  }

  log('loading membership page...')
  try {
    await Promise.race([
      win.loadURL('https://www.kimi.com/membership/subscription?tab=quota'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadURL 20s budget')), 20000))
    ])
    log('loadURL resolved')
  } catch (e) {
    log(`loadURL: ${e} — inspecting partial state`)
    try { win.webContents.stop() } catch { /* ignore */ }
  }

  await new Promise((r) => setTimeout(r, 15000))
  log('dumping probe...')

  const probe = await win.webContents.executeJavaScript(`({
    readyState: document.readyState,
    innerTextLen: document.body ? document.body.innerText.length : -1,
    apiLog: window.__apiLog || ['<interceptor not installed>'],
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
