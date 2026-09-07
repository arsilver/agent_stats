/** Probe 2: dump localStorage/sessionStorage keys on kimi.com (sandbox profile). */
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'

const TEST_PROFILE = process.env.AGENT_STATS_TEST_PROFILE
if (!TEST_PROFILE) {
  console.error('FATAL: AGENT_STATS_TEST_PROFILE not set')
  process.exit(1)
}
app.setPath('userData', TEST_PROFILE)
app.on('window-all-closed', () => {})
const OUT = process.env.AGENT_STATS_PROBE_OUT || 'tmp/kimi-storage.txt'

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
    await new Promise((r) => setTimeout(r, 6000))
    const dump: string = await win.webContents.executeJavaScript(`(function(){
      function keys(s){ try { return Object.keys(s || {}) } catch(e){ return ['<err:'+e+'>'] } }
      function preview(v){ if (!v) return String(v); return v.length > 60 ? v.slice(0,30)+'…('+v.length+' chars)' : v }
      var ls = keys(window.localStorage).map(function(k){ return k + ' = ' + preview(localStorage.getItem(k)) })
      var ss = keys(window.sessionStorage).map(function(k){ return k + ' = ' + preview(sessionStorage.getItem(k)) })
      return 'LOCALSTORAGE (' + ls.length + '):\\n' + ls.join('\\n') + '\\n\\nSESSIONSTORAGE (' + ss.length + '):\\n' + ss.join('\\n')
    })()`)
    writeFileSync(OUT, dump + '\n')
    console.log('written', OUT)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
