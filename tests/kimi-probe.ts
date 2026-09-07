/**
 * Probe: dump what kimi.com/code/console actually renders in a hidden Electron
 * window using the sandbox profile (anonymous cookies). Ground truth for
 * designing signed-in vs signed-out detection.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'

const TEST_PROFILE = process.env.AGENT_STATS_TEST_PROFILE
if (!TEST_PROFILE) {
  console.error('FATAL: AGENT_STATS_TEST_PROFILE not set')
  process.exit(1)
}
app.setPath('userData', TEST_PROFILE)
app.on('window-all-closed', () => {})

const OUT = process.env.AGENT_STATS_PROBE_OUT || 'tmp/kimi-probe.txt'

async function main(): Promise<void> {
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { partition: 'persist:scraper-kimi-code', contextIsolation: true, nodeIntegration: false }
  })
  try {
    await Promise.race([
      win.loadURL('https://www.kimi.com/code/console?from=kfc_overview_topbar'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('load budget')), 20000))
    ]).catch((e) => console.log('loadURL:', String(e)))
    // let SPA hydrate
    await new Promise((r) => setTimeout(r, 10000))
    const url = win.webContents.getURL()
    const title = await win.webContents.executeJavaScript('document.title').catch(() => '(err)')
    const text: string = await win.webContents
      .executeJavaScript(`document.body ? document.body.innerText : '(no body)'`)
      .catch(() => '(err)')
    writeFileSync(
      OUT,
      `URL: ${url}\nTITLE: ${title}\nLEN: ${text.length}\n---TEXT---\n${text.slice(0, 6000)}\n---END---\n`
    )
    console.log('probe written to', OUT)
    // also evaluate the current getLoggedInPageCheck logic inline for diagnosis
    const check: boolean = await win.webContents.executeJavaScript(`(function(){
      var t = document.body ? document.body.innerText : '';
      var out = [];
      out.push('len=' + t.length);
      out.push('hydrated=' + /(?:本周用量|Weekly usage|频限明细|Rate limit)[\\s\\S]{0,300}?\\d+(?:\\.\\d+)?\\s*%/.test(t));
      out.push('badge=' + /剩余\\s*\\d+|\\d+\\s*次|\\d+\\s*left/.test(t));
      out.push('loginmarker=' + /登录|扫码登录|手机号登录|验证码|微信登录|Welcome back|Sign in|Log in/i.test(t));
      var m = t.match(/(?:本周用量|Weekly usage|频限明细|Rate limit)[\\s\\S]{0,300}?\\d+(?:\\.\\d+)?\\s*%/);
      out.push('hydratedMatch=' + (m ? JSON.stringify(m[0].slice(0, 200)) : 'null'));
      return out.join('\\n');
    })()`)
    writeFileSync(OUT + '.check', String(check) + '\n')
    console.log('check written to', OUT + '.check')
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
