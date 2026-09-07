// Preload for probe #6 — runs in the MAIN world (contextIsolation disabled in
// the probe window), so patching window.fetch / XHR here affects the page's own
// scripts. No CDP attach needed (kimi throttles hydration when a debugger is
// attached, which is exactly what we are avoiding).
window.__apiLog = []
window.__apiBodies = {}

const of = window.fetch
window.fetch = function (...args) {
  const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''
  const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET'
  window.__apiLog.push(method + ' ' + url)
  const p = of.apply(this, args)
  p.then((r) => {
    try {
      if (/quota|subscription|membership|billing|usage|pay|level/i.test(url)) {
        r.clone().text().then((t) => { window.__apiBodies[method + ' ' + url] = t.substring(0, 4000) })
      }
    } catch (e) { /* ignore */ }
  }).catch(() => {})
  return p
}

const ox = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (m, u, ...rest) {
  window.__apiLog.push(m + ' ' + u)
  this.addEventListener('load', () => {
    try {
      if (/quota|subscription|membership|billing|usage|pay|level/i.test(String(u))) {
        window.__apiBodies[m + ' ' + u] = String(this.responseText).substring(0, 4000)
      }
    } catch (e) { /* ignore */ }
  })
  return ox.call(this, m, u, ...rest)
}
