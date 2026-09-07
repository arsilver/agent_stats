import { BrowserWindow, net, session, shell } from 'electron'
import { installWebAuthnBlockerInWindow } from '../browserPromptGuards'
import type { UsageMetric } from '../../shared/usageTypes'

// ─── Global BrowserWindow limiter — max 2 scraper windows at once ────
let activeScraperWindows = 0
const MAX_SCRAPER_WINDOWS = 2
const scraperWindowQueue: Array<() => void> = []

async function acquireScraperWindowSlot(serviceId: string): Promise<void> {
  if (activeScraperWindows < MAX_SCRAPER_WINDOWS) {
    activeScraperWindows++
    return
  }

  console.log(
    `[${serviceId}] Waiting for scraper window slot ` +
    `(${activeScraperWindows} active, ${scraperWindowQueue.length} queued)`
  )

  await new Promise<void>((resolve) => {
    scraperWindowQueue.push(resolve)
  })

  console.log(
    `[${serviceId}] Acquired queued scraper window slot ` +
    `(${activeScraperWindows} active, ${scraperWindowQueue.length} queued)`
  )
}

function releaseScraperWindowSlot(): void {
  activeScraperWindows = Math.max(0, activeScraperWindows - 1)

  const next = scraperWindowQueue.shift()
  if (!next) return

  activeScraperWindows++
  next()
}

export function isScraperDebugEnabled(): boolean {
  return process.env.AGENT_STATS_SCRAPER_DEBUG === '1'
}

// ─── Scrape-time request filtering ───────────────────────────
// Scraper windows only need the document, its scripts, and XHR data for DOM
// extraction. Images, fonts, media and stylesheets are pure bandwidth waste
// (and slow page loads), and well-known analytics/tracker endpoints add
// server load we don't benefit from. The filter is installed once per scraper
// partition and only armed while a scrape is in flight, so user-visible login
// windows on the same partition keep full page loads.
//
// NEVER block 'script' or document resource types — extraction depends on them.
const SCRAPE_BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet', 'object'])

const TRACKER_HOST_RE = /(^|\.)(doubleclick\.net|google-analytics\.com|googletagmanager\.com|googleadservices\.com|googlesyndication\.com|connect\.facebook\.net|graph\.facebook\.com|api\.segment\.io|segment\.com|cdn\.segment\.com|mixpanel\.com|api\.amplitude\.com|heapanalytics\.com|hotjar\.com|fullstory\.com|sentry\.io|o\d+\.ingest\.sentry\.io|nr-data\.net|newrelic\.com|datadoghq\.com|intercomcdn\.com|clarity\.ms)$/i

const requestFilterInstalledPartitions = new Set<string>()
// Armed per scrape-window webContents id — NEVER per partition. A login window
// shares the partition with scrapes, and partition-wide arming blocked the login
// page's own stylesheets/fonts/images (blank white window) whenever the user
// clicked Reconnect while a scrape was in flight.
const armedScrapeWebContentsIds = new Set<number>()

function installScraperRequestFilter(partition: string): void {
  if (requestFilterInstalledPartitions.has(partition)) return
  requestFilterInstalledPartitions.add(partition)

  const ses = session.fromPartition(partition)
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const webContentsId = (details as { webContentsId?: number }).webContentsId
      if (webContentsId === undefined || !armedScrapeWebContentsIds.has(webContentsId)) {
        return callback({})
      }

      const resourceType = (details as { resourceType?: string }).resourceType

      // Extraction depends on documents and scripts — never block them.
      if (
        resourceType === 'mainFrame' ||
        resourceType === 'subFrame' ||
        resourceType === 'script' ||
        resourceType === 'document'
      ) {
        return callback({})
      }

      if (resourceType && SCRAPE_BLOCKED_RESOURCE_TYPES.has(resourceType)) {
        return callback({ cancel: true })
      }

      // Well-known analytics/tracker endpoints (covers tracking XHRs/beacons).
      const hostname = new URL(details.url).hostname
      if (TRACKER_HOST_RE.test(hostname)) {
        return callback({ cancel: true })
      }
    } catch {
      // On any filtering error, allow the request — scraping must not break.
    }
    callback({})
  })
}

function armScraperRequestFilter(partition: string, webContentsId: number): void {
  installScraperRequestFilter(partition)
  armedScrapeWebContentsIds.add(webContentsId)
}

function disarmScraperRequestFilter(webContentsId: number): void {
  armedScrapeWebContentsIds.delete(webContentsId)
}

function writeDebugSnapshot(
  serviceId: string,
  finalUrl: string,
  pageTitle: string,
  reason: string | null,
  debugText: string
): void {
  if (!isScraperDebugEnabled()) return

  try {
    const debugLogPath = require('path').join(require('electron').app.getPath('userData'), `debug-${serviceId}.txt`)
    const reasonLine = reason ? `Reason: ${reason}\n` : ''
    const header = `URL: ${finalUrl}\nTitle: ${pageTitle}\nTimestamp: ${new Date().toISOString()}\n${reasonLine}${'â”€'.repeat(60)}\n`
    require('fs').writeFileSync(debugLogPath, header + debugText, 'utf8')
    console.log(`[${serviceId}] Debug saved to ${debugLogPath}`)
  } catch (err) {
    console.error(`[${serviceId}] Failed to write debug snapshot:`, err)
  }
}

/**
 * Base scraper that manages a hidden BrowserWindow for web scraping.
 * Imports cookies from the user's Chrome browser so no separate login is needed.
 */
export type LoginOutcome = 'signed_in' | 'cancelled' | 'unknown'

export abstract class BaseScraper {
  protected serviceId: string
  protected dashboardUrl: string
  private cookiesImported = false
  private lastFailureReason: ScrapeFailureReason = null
  private lastLoginOutcome: LoginOutcome = 'unknown'
  private activeScrapeWindow: BrowserWindow | null = null

  /**
   * Destroy the in-flight hidden scrape window (if any). Callers whose own
   * timeout budget expired (e.g. the 45s warm-up race) use this to actually
   * STOP the underlying scrape — otherwise the orphaned scrape keeps its
   * window and scraper slot alive until the 90s fail-safe, saturating the
   * window pool for every other service. Pending loadURL/executeJavaScript
   * calls reject on destroy, so scrape() unwinds through its normal
   * catch/finally (slot release, request-filter disarm).
   */
  public cancelActiveScrape(reason = 'caller timeout'): void {
    const win = this.activeScrapeWindow
    if (win && !win.isDestroyed()) {
      console.log(`[${this.serviceId}] Cancelling active scrape (${reason}) — destroying hidden window`)
      try {
        win.destroy()
      } catch { /* already gone */ }
    }
  }

  constructor(serviceId: string, dashboardUrl: string) {
    this.serviceId = serviceId
    this.dashboardUrl = dashboardUrl
  }

  public getPartition(): string {
    return `persist:scraper-${this.serviceId}`
  }

  public getLastFailureReason(): ScrapeFailureReason {
    return this.lastFailureReason
  }

  /**
   * Outcome of the most recent openLoginWindow() call. Lets the reconnect
   * handler distinguish "user actually signed in" (so try the scrape) from
   * "user cancelled/closed without signing in" (don't fall back to a misleading
   * cookies_expired status).
   */
  public getLastLoginOutcome(): LoginOutcome {
    return this.lastLoginOutcome
  }

  protected setLastFailureReason(reason: ScrapeFailureReason): void {
    this.lastFailureReason = reason
  }

  protected resetLastFailureReason(): void {
    this.lastFailureReason = null
  }

  public requiresExternalBrowserLogin(): boolean {
    return this.isCloudflareProtected()
  }

  public usesManagedBrowserSession(): boolean {
    return false
  }

  public getManagedChromeConfig(): { serviceId: string; port: number; startUrl: string } | null {
    return null
  }

  /**
   * Override in subclasses to provide additional domains for cookie import.
   * E.g., Claude needs 'anthropic.com', Gemini needs 'accounts.google.com'.
   */
  protected getExtraCookieDomains(): string[] {
    return []
  }

  /**
   * Override in subclasses to provide a JS expression that returns true
   * when the page is ready for data extraction.
   */
  protected getPageReadyCheck(): string {
    return `document.readyState === 'complete' && document.body && document.body.innerText.length > 100`
  }

  /**
   * Classify a page-ready timeout using the page's current text. Many SPAs
   * render a login form at the dashboard URL without a redirect, so generic
   * signed-out markers mean login_required (actionable) rather than
   * page_not_ready ("layout changed"). Override per scraper for stronger
   * signals (e.g. kimi's console shell shows identity markers with '-'
   * placeholders when signed out).
   */
  protected classifyReadyTimeout(pageText: string, _finalUrl: string): ScrapeFailureReason {
    const t = (pageText || '').toLowerCase()
    if (
      /welcome back|sign in|log in|create account|continue with|scan qr|phone number|登录|扫码登录|手机号登录|验证码|微信登录/.test(
        t
      )
    ) {
      return 'login_required'
    }
    return 'page_not_ready'
  }

  /**
   * JS expression evaluated in the login window. Returns true only when the
   * page content shows a signed-in state (not a login/marketing form).
   * Used by openLoginWindow's auto-close path: a URL match alone is not
   * enough because some services render a login form at the dashboard URL.
   * Override per scraper for stronger signals.
   */
  protected getLoggedInPageCheck(): string {
    return `(() => {
      if (document.readyState !== 'complete' || !document.body) return false;
      const t = (document.body.innerText || '').toLowerCase();
      if (t.length < 50) return false;
      const looksLikeLogin =
        /\\b(sign in|log in|continue with google|continue with github|continue with email|create account|welcome back)\\b/.test(t)
        && !/\\b(sign\\s*out|log\\s*out|billing|credits?|usage|dashboard|subscription|profile)\\b/.test(t);
      return !looksLikeLogin;
    })()`
  }

  /**
   * Import cookies from ALL Chrome profiles for this service's domain
   * and any extra domains specified by the scraper.
   */
  /** Mark that the last scrape successfully loaded the dashboard (not a login redirect). */
  private lastScrapeWorked = false
  public importError: string | null = null

  markScrapeWorked(): void {
    this.lastScrapeWorked = true
  }

  /**
   * Check if Electron session already has cookies for this service.
   * Chrome file-based cookie import was removed — Chrome 127+ uses v20
   * App-Bound Encryption which cannot be decrypted from userspace.
   * For Cloudflare-protected services, cookies come from managed Chrome sign-in.
   */
  async importChromeCookies(_force = false): Promise<boolean> {
    const ses = session.fromPartition(this.getPartition())
    const existingCookies = await ses.cookies.get({ url: this.dashboardUrl })
    if (existingCookies.length > 0) {
      console.log(`[${this.serviceId}] Electron session has ${existingCookies.length} cookies`)
      this.cookiesImported = true
      return true
    }

    this.cookiesImported = true
    this.importError = null
    console.log(`[${this.serviceId}] No Electron session cookies for ${this.dashboardUrl}`)
    return false
  }

  /**
   * Kept for API compatibility — no longer retries file-based import.
   */
  async importChromeCookiesWithRetry(_maxWaitMs = 30000): Promise<boolean> {
    return this.importChromeCookies(true)
  }

  /**
   * Kept for API compatibility (used by MiniMax scraper).
   * No-op since Chrome v20 encryption makes file-based import impossible.
   */
  protected async importCookiesForUrl(_targetUrl: string, _domains: string[]): Promise<boolean> {
    console.log(`[${this.serviceId}] importCookiesForUrl is no-op (Chrome v20 encryption)`)
    return false
  }

  /**
   * Patterns that indicate the page redirected to a login/auth page.
   * Override in subclasses for service-specific login detection.
   */
  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/signin', '/sign-in', '/auth', '/sso', '/accountchooser']
  }

  /**
   * Check if a URL looks like a login/auth page.
   */
  protected isLoginUrl(url: string): boolean {
    const lower = url.toLowerCase()
    return this.getLoginUrlPatterns().some((pattern) => lower.includes(pattern))
  }

  /**
   * After sign-in, the user lands on a URL we recognise as "logged in" — any
   * host that shares the dashboard's registrable domain (so an OAuth bounce
   * to a sibling subdomain still counts) and that isn't a login page.
   *
   * Caveat: uses a naive "drop leftmost label" rule for the registrable
   * domain. Fine for *.minimax.io, *.runwayml.com etc.; would mis-classify
   * multi-label TLDs like example.co.uk if we ever add one.
   */
  protected isLoggedInUrl(url: string): boolean {
    if (!url || url === 'about:blank') return false
    if (this.isLoginUrl(url)) return false
    try {
      const u = new URL(url)
      const d = new URL(this.dashboardUrl)
      const dashboardHost = d.hostname.replace(/^www\./, '')
      const parts = dashboardHost.split('.')
      const baseHost = parts.length > 2 ? parts.slice(1).join('.') : dashboardHost
      return u.hostname === baseHost || u.hostname.endsWith(`.${baseHost}`)
    } catch {
      return false
    }
  }

  /**
   * Optional: regex matching cookie names that are ALWAYS anonymous (tracker /
   * preference cookies set without sign-in, e.g. _ga, __cf_bm, intercom).
   * Override in subclasses. When set, isLoggedIn requires at least one cookie
   * whose name does NOT match — otherwise pure tracker cookies from an
   * anonymous page visit fake a signed-in session (observed on kimi.com: 8
   * anonymous cookies made isLoggedIn true, so the login window never opened).
   */
  protected getAnonymousCookieNameRe(): RegExp | null {
    return null
  }

  /**
   * Check if the user is logged in (has cookies for this service).
   * Auto-imports Chrome cookies on first check.
   */
  async isLoggedIn(): Promise<boolean> {
    if (!this.cookiesImported) {
      await this.importChromeCookies()
    }

    const ses = session.fromPartition(this.getPartition())
    const anonymousRe = this.getAnonymousCookieNameRe()
    const hasMeaningfulCookie = (cookies: Electron.Cookie[]): boolean => {
      if (!anonymousRe) return cookies.length > 0
      return cookies.some((c) => !anonymousRe.test(c.name))
    }

    // Check main dashboard URL
    const cookies = await ses.cookies.get({ url: this.dashboardUrl })
    if (hasMeaningfulCookie(cookies)) return true

    // Check extra domains (if they are separate domains, we construct a dummy https URL to test)
    const extraDomains = this.getExtraCookieDomains()
    for (const domain of extraDomains) {
      // Remove leading dot for URL construction
      const cleanDomain = domain.startsWith('.') ? domain.substring(1) : domain
      const dummyUrl = `https://${cleanDomain}/`
      const extraCookies = await ses.cookies.get({ url: dummyUrl })
      if (hasMeaningfulCookie(extraCookies)) return true
    }

    return false
  }

  /**
   * Attach Chrome DevTools Protocol debugger and inject anti-fingerprint patches
   * BEFORE any page JavaScript executes. This is the only reliable way to beat
   * Cloudflare Turnstile's navigator.webdriver check — executeJavaScript from
   * did-start-navigation runs too late.
   */
  private async attachAntiFingerprint(win: BrowserWindow): Promise<void> {
    // CDP sendCommand has NO built-in timeout, and on some sessions the
    // renderer is slow to service DevTools commands (observed: hangs until the
    // 90s scrape fail-safe). These patches are best-effort hardening — bound
    // each command so a slow renderer can never stall the whole scrape.
    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> =>
      Promise.race([
        promise,
        new Promise<null>((resolve) =>
          setTimeout(() => {
            console.warn(`[${this.serviceId}] CDP command ${label} timed out after ${ms}ms — continuing without it`)
            resolve(null)
          }, ms)
        )
      ])
    try {
      const { debugger: debugSession } = win.webContents
      if (!debugSession.isAttached()) {
        debugSession.attach('1.3')
      }
      await withTimeout(
        debugSession.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // Patch navigator.webdriver BEFORE Cloudflare's script reads it
          Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
            configurable: true
          });

          // Chrome runtime object
          if (!window.chrome) {
            window.chrome = {};
          }
          if (!window.chrome.runtime) {
            window.chrome.runtime = {};
          }

          // Realistic plugins array (Cloudflare checks length > 0)
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const arr = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
              ];
              arr.item = (i) => arr[i] || null;
              arr.namedItem = (n) => arr.find(p => p.name === n) || null;
              arr.refresh = () => {};
              return arr;
            },
            configurable: true
          });

          // Languages
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
            configurable: true
          });

          // Permissions API — Cloudflare queries notification permission
          if (navigator.permissions) {
            const origQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) => {
              if (params.name === 'notifications') {
                return Promise.resolve({ state: 'prompt', onchange: null });
              }
              return origQuery(params);
            };
          }
        `
        }),
        5000,
        'Page.addScriptToEvaluateOnNewDocument'
      )
      await withTimeout(
        debugSession.sendCommand('Runtime.evaluate', {
          expression: `
            Object.defineProperty(navigator, 'webdriver', {
              get: () => false,
              configurable: true
            });
          `,
          awaitPromise: true,
          returnByValue: true
        }),
        5000,
        'Runtime.evaluate'
      ).catch(() => null)
      console.log(`[${this.serviceId}] CDP anti-fingerprint patches injected`)
    } catch (err) {
      console.warn(`[${this.serviceId}] Failed to attach CDP debugger:`, err)
    }
  }

  /**
   * Override to mark services that are behind Cloudflare Turnstile.
   * These services cannot log in via Electron windows (TLS fingerprint mismatch).
   * Instead, we open the system browser and import cookies from Chrome.
   */
  protected isCloudflareProtected(): boolean {
    return false
  }

  /**
   * Open login flow. For Cloudflare-protected sites, opens the system browser
   * and then imports cookies from Chrome. For others, opens an Electron window
   * and auto-closes it as soon as the user lands on a logged-in URL so the
   * caller can refresh without waiting for a manual close.
   */
  async openLoginWindow(): Promise<void> {
    this.lastLoginOutcome = 'unknown'

    if (this.isCloudflareProtected()) {
      // Open in the user's real browser and let the user import cookies manually.
      console.log(`[${this.serviceId}] Cloudflare-protected — opening system browser for login`)
      await shell.openExternal(this.dashboardUrl)
      return
    }

    // Non-Cloudflare services: use Electron login window
    if (!this.cookiesImported) {
      try {
        await this.importChromeCookies()
      } catch (err) {
        console.error(`[${this.serviceId}] Failed to import Chrome cookies during openLoginWindow:`, err)
      }
    }

    return new Promise((resolve) => {
      const loginSes = session.fromPartition(this.getPartition())
      const chromeUA = loginSes.getUserAgent().replace(/\s*Electron\/\S+/, '')
      loginSes.setUserAgent(chromeUA)

      const win = new BrowserWindow({
        width: 1000,
        height: 700,
        title: `Login — ${this.serviceId}`,
        webPreferences: {
          partition: this.getPartition(),
          contextIsolation: true,
          nodeIntegration: false
        }
      })

      let settled = false
      let autoDetected = false
      let autoCloseTimer: NodeJS.Timeout | null = null

      const settle = async (reason: 'auto-detect' | 'user-close') => {
        if (settled) return
        settled = true
        try {
          const ses = session.fromPartition(this.getPartition())
          // BrowserWindow.close() does not synchronously flush the cookie store
          // to disk. Flush before the subsequent scrape so it can find the
          // cookies in the same partition.
          await ses.cookies.flushStore()
          const url = new URL(this.dashboardUrl)
          const cookies = await ses.cookies.get({ domain: url.hostname })
          console.log(
            `[${this.serviceId}] Login window closed (${reason}). Saved ${cookies.length} cookies for ${url.hostname}.`
          )
          const refreshDomain = `.${url.hostname.replace('www.', '')}`
          const extraCookies = await ses.cookies.get({ domain: refreshDomain })
          console.log(
            `[${this.serviceId}] Additionally found ${extraCookies.length} generic cookies for ${refreshDomain}.`
          )

          // Probe whether the partition actually has cookies for the dashboard.
          // If auto-detect closed the window, we already verified — trust it.
          // If the user closed manually, we need to confirm there's *something*
          // to scrape; otherwise mark as cancelled so the reconnect handler
          // can show "Connect" instead of misleading "Reconnect" again.
          if (autoDetected) {
            this.lastLoginOutcome = 'signed_in'
          } else {
            const hasAny = cookies.length > 0 || extraCookies.length > 0
            this.lastLoginOutcome = hasAny ? 'signed_in' : 'cancelled'
            if (!hasAny) {
              console.log(`[${this.serviceId}] Login window closed manually with no cookies — treating as cancelled`)
            }
          }
        } catch (err) {
          console.error(`[${this.serviceId}] Error reading cookies after login:`, err)
          this.lastLoginOutcome = 'unknown'
        }
        resolve()
      }

      // Detect successful sign-in via URL + content. URL alone is not enough:
      // some services render a login form at the dashboard URL itself, so we
      // also evaluate getLoggedInPageCheck() in the page. If the URL matches
      // but content doesn't, we re-poll every RECHECK_MS — this covers SPA
      // flows where the page transitions to logged-in without firing a
      // navigation event.
      const RECHECK_MS = 2000
      const STABILITY_MS = 1500
      let recheckTimer: NodeJS.Timeout | null = null

      const tryAutoClose = async (trigger: 'nav' | 'recheck' | 'load'): Promise<void> => {
        if (settled || autoCloseTimer || win.isDestroyed()) return
        const url = win.webContents.getURL()
        if (!this.isLoggedInUrl(url)) return

        let contentOk = false
        try {
          contentOk = !!(await win.webContents.executeJavaScript(this.getLoggedInPageCheck(), true))
        } catch {
          return // page mid-transition; next event or recheck will retry
        }

        if (!contentOk) {
          if (!recheckTimer && !settled && !win.isDestroyed()) {
            recheckTimer = setTimeout(() => {
              recheckTimer = null
              void tryAutoClose('recheck')
            }, RECHECK_MS)
          }
          return
        }

        // Extra gate: confirm the partition actually has cookies before closing.
        // Catches the "page rendered the dashboard shell but auth cookie still
        // hasn't been written" race that left users stuck in cookies_expired.
        try {
          const ses = session.fromPartition(this.getPartition())
          const dashHost = new URL(this.dashboardUrl).hostname
          const hostCookies = await ses.cookies.get({ domain: dashHost })
          if (hostCookies.length === 0) {
            // Recheck shortly — likely cookies will land in the next tick.
            if (!recheckTimer && !settled && !win.isDestroyed()) {
              recheckTimer = setTimeout(() => {
                recheckTimer = null
                void tryAutoClose('recheck')
              }, RECHECK_MS)
            }
            return
          }
        } catch {
          // If the cookie probe fails, fall through and use existing logic.
        }

        console.log(`[${this.serviceId}] Login URL+content+cookies match (${trigger}, ${url}) — auto-closing in ${STABILITY_MS}ms`)
        autoCloseTimer = setTimeout(async () => {
          autoCloseTimer = null
          if (settled || win.isDestroyed()) return
          if (!this.isLoggedInUrl(win.webContents.getURL())) return
          try {
            const stillOk = await win.webContents.executeJavaScript(this.getLoggedInPageCheck(), true)
            if (!stillOk) return
          } catch {
            return
          }
          autoDetected = true
          try {
            win.close()
          } catch (err) {
            console.error(`[${this.serviceId}] Failed to auto-close login window:`, err)
          }
        }, STABILITY_MS)
      }

      win.webContents.on('did-navigate', () => void tryAutoClose('nav'))
      win.webContents.on('did-navigate-in-page', () => void tryAutoClose('nav'))
      win.webContents.on('did-finish-load', () => void tryAutoClose('load'))

      win.on('closed', () => {
        if (autoCloseTimer) {
          clearTimeout(autoCloseTimer)
          autoCloseTimer = null
        }
        if (recheckTimer) {
          clearTimeout(recheckTimer)
          recheckTimer = null
        }
        void settle(autoDetected ? 'auto-detect' : 'user-close')
      })

      void (async () => {
        await installWebAuthnBlockerInWindow(win, `${this.serviceId}:login`)
        await win.loadURL(this.dashboardUrl)
      })().catch((err) => {
        console.error(`[${this.serviceId}] Failed to load login window:`, err)
      })
    })
  }

  /**
   * Detect and wait for Cloudflare "Just a moment..." challenge to auto-resolve.
   * Returns true if Cloudflare was detected (whether or not it resolved).
   */
  private async waitForCloudflare(win: BrowserWindow): Promise<boolean> {
    if (win.isDestroyed()) return false
    const title = await win.webContents.executeJavaScript('document.title').catch(() => '')
    if (!title.includes('Just a moment')) return false

    console.log(`[${this.serviceId}] Cloudflare challenge detected — waiting up to 15s for auto-resolve...`)
    const start = Date.now()
    while (Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 1000))
      if (win.isDestroyed()) return true
      const t = await win.webContents.executeJavaScript('document.title').catch(() => 'Just a moment')
      if (!t.includes('Just a moment')) {
        console.log(`[${this.serviceId}] Cloudflare challenge resolved after ${Date.now() - start}ms`)
        return true
      }
    }
    console.log(`[${this.serviceId}] Cloudflare challenge did NOT resolve within 15s`)
    return true
  }

  /**
   * Wait for the page to be ready using the scraper's ready check.
   * Polls every 500ms, times out after maxWait ms.
   */
  private async waitForPageReady(win: BrowserWindow, maxWait = 20000): Promise<boolean> {
    const checkJs = this.getPageReadyCheck()
    const start = Date.now()
    let lastError: string | null = null

    while (Date.now() - start < maxWait) {
      try {
        const ready = await win.webContents.executeJavaScript(`(function() { try { return !!(${checkJs}); } catch(e) { return false; } })()`)
        if (ready) {
          console.log(`[${this.serviceId}] Page ready after ${Date.now() - start}ms`)
          return true
        }
      } catch (e) {
        lastError = String(e)
        // Page may not be ready yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    console.log(`[${this.serviceId}] Page ready check timed out after ${maxWait}ms`)
    return false
  }

  /**
   * Make an authenticated fetch request using this scraper's session cookies.
   * Bypasses Cloudflare page challenges since it's a direct HTTP request.
   */
  protected async sessionFetch(url: string, options?: { headers?: Record<string, string> }): Promise<Response | null> {
    try {
      const ses = session.fromPartition(this.getPartition())
      const chromeUA = ses.getUserAgent().replace(/\s*Electron\/\S+/, '')
      console.log(`[${this.serviceId}] sessionFetch: ${url}`)

      // Race against a 10s timeout so we don't block the entire scrape pipeline
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)

      const resp = await (net.fetch as any)(url, {
        session: ses,
        signal: controller.signal,
        headers: {
          'User-Agent': chromeUA,
          'Accept': 'application/json, text/html',
          'Accept-Language': 'en-US,en;q=0.9',
          ...options?.headers
        }
      })
      clearTimeout(timer)
      console.log(`[${this.serviceId}] sessionFetch response: ${resp.status} ${resp.statusText}`)
      return resp
    } catch (err) {
      console.log(`[${this.serviceId}] sessionFetch failed for ${url}:`, err)
      return null
    }
  }

  /**
   * Override in subclasses to try fetching usage data via API calls
   * (bypasses Cloudflare). Returns null if not implemented or if API fails.
   */
  protected async tryApiScrape(): Promise<ScrapedUsageData | null> {
    return null
  }

  /**
   * Load the dashboard in a hidden window and extract usage data.
   * Returns:
   *   - ScrapedUsageData on success
   *   - { loginRequired: true } if the page redirected to a login page
   *   - null if extraction failed for other reasons
   */
  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    // Try API-first approach (bypasses Cloudflare page challenges)
    try {
      const apiData = await this.tryApiScrape()
      if (apiData) {
        console.log(`[${this.serviceId}] API scrape succeeded — skipping BrowserWindow`)
        this.lastScrapeWorked = true
        return apiData
      }
    } catch (err) {
      console.log(`[${this.serviceId}] API scrape failed, falling back to BrowserWindow:`, err)
    }

    const loggedIn = await this.isLoggedIn()
    if (!loggedIn) {
        this.setLastFailureReason(
          this.importError && this.importError.includes('locking')
            ? 'cookie_import_blocked'
            : 'login_required'
        )
      return null
    }

    await acquireScraperWindowSlot(this.serviceId)

    const ses = session.fromPartition(this.getPartition())

    // Block bandwidth-heavy resources (images/fonts/media/stylesheets) and
    // tracker endpoints while this scrape is in flight. Armed per scrape-window
    // webContents id below — login windows on the same partition load fully.

    // Spoof user-agent to match real Chrome so Cloudflare doesn't block us.
    // Electron's default UA contains "Electron/" which Cloudflare flags.
    const chromeUA = ses.getUserAgent().replace(/\s*Electron\/\S+/, '')
    ses.setUserAgent(chromeUA)

    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      paintWhenInitiallyHidden: false,
      webPreferences: {
        partition: this.getPartition(),
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    // Arm the request filter for THIS scrape window only (by webContents id) —
    // concurrent login windows on the same partition are unaffected.
    armScraperRequestFilter(this.getPartition(), win.webContents.id)
    this.activeScrapeWindow = win

    // Fail-safe cleanup timer: forcefully destroy the window if scraping hangs longer than 90 seconds.
    // This absolutely prevents zombie Electron processes from accumulating and locking the profile cache.
    // Extended from 45s to 90s to accommodate Cloudflare challenge waits + cookie refresh retries.
    const failSafeTimer = setTimeout(() => {
      console.error(`[${this.serviceId}] Scrape exceeded 90s fail-safe timeout — forcefully killing window to prevent zombie process.`)
      if (!win.isDestroyed()) {
        try { win.destroy() } catch { }
      }
    }, 90000)

    try {
      // Load the page and wait for it to finish
      await this.attachAntiFingerprint(win)
      await installWebAuthnBlockerInWindow(win, `${this.serviceId}:scrape`)

      // Race loadURL against a 30s budget. Cloudflare-protected sites can stall
      // loadURL indefinitely (the "Just a moment..." challenge never resolves
      // for Electron's TLS fingerprint) — without this race the 90s fail-safe
      // destroys the window and we lose the chance to inspect the Cloudflare
      // page or trigger the existing waitForCloudflare logic below.
      const LOAD_BUDGET_MS = 30_000
      let loadTimedOut = false
      try {
        await Promise.race([
          win.loadURL(this.dashboardUrl),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              loadTimedOut = true
              reject(new Error(`loadURL exceeded ${LOAD_BUDGET_MS / 1000}s budget`))
            }, LOAD_BUDGET_MS)
          })
        ])
      } catch (err: any) {
        if (loadTimedOut) {
          console.log(`[${this.serviceId}] loadURL timed out after ${LOAD_BUDGET_MS / 1000}s — proceeding to inspect partial state`)
          // Stop any in-flight loading so subsequent checks see a stable DOM.
          if (!win.isDestroyed()) {
            try { win.webContents.stop() } catch {}
          }
        } else {
          throw err
        }
      }

      // Give redirects a moment to settle (client-side JS redirects).
      // Skip the fixed sleep when the document is already fully loaded —
      // with heavy resources filtered out, most pages are complete by now.
      const alreadyComplete: boolean = await win.webContents
        .executeJavaScript(`document.readyState === 'complete'`)
        .catch(() => false)
      if (!alreadyComplete) {
        await new Promise((r) => setTimeout(r, 4000))
      }

      if (win.isDestroyed()) {
        console.log(`[${this.serviceId}] Scrape aborted — window was destroyed during load.`)
        this.setLastFailureReason('page_not_ready')
        return null
      }

      // Check where we actually landed
      let finalUrl = win.webContents.getURL()
      let pageTitle = await win.webContents.executeJavaScript('document.title').catch(() => '(unknown)')
      console.log(`[${this.serviceId}] Page loaded: ${pageTitle} (${finalUrl})`)

      // Cloudflare challenge handling: wait for auto-resolve, then force re-import if stuck
      const cfDetected = await this.waitForCloudflare(win)
      if (cfDetected && !win.isDestroyed()) {
        pageTitle = await win.webContents.executeJavaScript('document.title').catch(() => '')
        if (pageTitle.includes('Just a moment')) {
          this.setLastFailureReason('cloudflare_blocked')
          console.log(`[${this.serviceId}] Cloudflare challenge persists — giving up`)
          return null
        } else {
          finalUrl = win.webContents.getURL()
          console.log(`[${this.serviceId}] Cloudflare resolved — continuing with: ${pageTitle} (${finalUrl})`)
        }
      }

      // Login redirect detection
      if (this.isLoginUrl(finalUrl)) {
        console.log(`[${this.serviceId}] Redirected to login`)
        this.setLastFailureReason('login_required')
        this.lastScrapeWorked = false
        this.cookiesImported = false
        return { loginRequired: true } as any
      }

      // Dashboard loaded successfully — remember this for cookie import optimization
      this.lastScrapeWorked = true

      // Wait for page content to be ready (SPA data loading)
      const ready = await this.waitForPageReady(win)
      if (!ready) {
        // Read the page text BEFORE classifying so scrapers can distinguish
        // "signed-out shell" (login_required) from "layout changed" (page_not_ready).
        const timeoutText: string = win.isDestroyed()
          ? ''
          : await win.webContents
              .executeJavaScript(`document.body ? document.body.innerText.substring(0, 2000) : ''`)
              .catch(() => '')
        this.setLastFailureReason(this.classifyReadyTimeout(timeoutText, finalUrl))
        console.log(`[${this.serviceId}] Page ready check timed out at ${finalUrl} (title: ${pageTitle})`)
        // Always log a small preview so we can see WHY the readiness predicate
        // never matched — distinguishes "page didn't load" from "page loaded but
        // copy changed". Full snapshot still gated behind AGENT_STATS_SCRAPER_DEBUG.
        if (!win.isDestroyed()) {
          try {
            const preview: string = await win.webContents.executeJavaScript(
              `document.body ? document.body.innerText.substring(0, 600) : '(no body)'`
            )
            console.log(`[${this.serviceId}] Body preview on timeout: ${preview.replace(/\s+/g, ' ').trim().slice(0, 600)}`)
          } catch (err) {
            console.log(`[${this.serviceId}] Could not read body preview: ${(err as any)?.message || err}`)
          }
          if (isScraperDebugEnabled()) {
            const debugText = await win.webContents.executeJavaScript(
              `document.body ? document.body.innerText.substring(0, 5000) : '(no body)'`
            ).catch(() => '(error reading body)')
            writeDebugSnapshot(this.serviceId, finalUrl, pageTitle, 'Page ready check timed out', debugText)
          }
        }

        return null
      }

      if (win.isDestroyed()) {
        this.setLastFailureReason('page_not_ready')
        return null
      }

      // Extract usage data
      const data = await this.extractUsageData(win)

      // Debug: log page text, URL, and title on failure
      if (!data) {
        this.setLastFailureReason(this.lastFailureReason ?? 'extract_failed')
        console.log(`[${this.serviceId}] Extract failed at ${finalUrl} (title: ${pageTitle})`)
        if (!win.isDestroyed()) {
          try {
            const preview: string = await win.webContents.executeJavaScript(
              `document.body ? document.body.innerText.substring(0, 600) : '(no body)'`
            )
            console.log(`[${this.serviceId}] Body preview on extract fail: ${preview.replace(/\s+/g, ' ').trim().slice(0, 600)}`)
          } catch (err) {
            console.log(`[${this.serviceId}] Could not read body preview: ${(err as any)?.message || err}`)
          }
          if (isScraperDebugEnabled()) {
            const debugText = await win.webContents.executeJavaScript(
              `document.body ? document.body.innerText.substring(0, 5000) : '(no body)'`
            ).catch(() => '(error reading body)')
            writeDebugSnapshot(this.serviceId, finalUrl, pageTitle, null, debugText)
          }
        }
      }

      return data
    } catch (err) {
      this.setLastFailureReason(this.lastFailureReason ?? 'extract_failed')
      console.error(`[${this.serviceId}] Scrape error:`, err)
      return null
    } finally {
      disarmScraperRequestFilter(win.webContents.id)
      this.activeScrapeWindow = null
      releaseScraperWindowSlot()
      clearTimeout(failSafeTimer)
      if (!win.isDestroyed()) {
        try {
          win.destroy()
        } catch (err) {
          console.error(`[${this.serviceId}] Error destroying window in finally:`, err)
        }
      }
    }
  }

  protected abstract extractUsageData(win: BrowserWindow): Promise<ScrapedUsageData | null>
}

export type ScrapeFailureReason =
  | 'login_required'
  | 'managed_browser_inactive'
  | 'cookie_import_blocked'
  | 'cloudflare_blocked'
  | 'page_not_ready'
  | 'extract_failed'
  | null

export type RenewalKind = 'renewing' | 'cancelled'

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]
const MONTH_SHORT = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
]

function monthIndex(token: string): number {
  const t = token.toLowerCase().replace(/[.,]/g, '')
  const full = MONTH_NAMES.indexOf(t)
  if (full !== -1) return full
  return MONTH_SHORT.indexOf(t)
}

function toIsoYmd(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100) return null
  if (m < 0 || m > 11) return null
  if (d < 1 || d > 31) return null
  const mm = String(m + 1).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

function inferYear(monthIdx: number, day: number): number {
  const now = new Date()
  const thisYear = now.getFullYear()
  const candidate = new Date(thisYear, monthIdx, day)
  if (candidate.getTime() < now.getTime() - 1000 * 60 * 60 * 24 * 30) {
    return thisYear + 1
  }
  return thisYear
}

function parseDateFragment(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, ' ')

  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return toIsoYmd(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]))

  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (slash) {
    let y = parseInt(slash[3])
    if (y < 100) y += 2000
    return toIsoYmd(y, parseInt(slash[1]) - 1, parseInt(slash[2]))
  }

  const monthDayYear = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/)
  if (monthDayYear) {
    const m = monthIndex(monthDayYear[1])
    if (m !== -1) return toIsoYmd(parseInt(monthDayYear[3]), m, parseInt(monthDayYear[2]))
  }

  const dayMonthYear = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/)
  if (dayMonthYear) {
    const m = monthIndex(dayMonthYear[2])
    if (m !== -1) return toIsoYmd(parseInt(dayMonthYear[3]), m, parseInt(dayMonthYear[1]))
  }

  const monthDay = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/)
  if (monthDay) {
    const m = monthIndex(monthDay[1])
    if (m !== -1) {
      const day = parseInt(monthDay[2])
      return toIsoYmd(inferYear(m, day), m, day)
    }
  }

  return null
}

/**
 * Extract a subscription renewal/end date from a page's text.
 * Returns { date, kind } where kind=cancelled means access ends on that date
 * (sub is not renewing), and kind=renewing means next charge on that date.
 */
function isPlausibleRenewingDate(ymd: string): boolean {
  // Renewal dates are always in the future (or within ~2 days of now for same-day renewals).
  // Past dates matched as "renewing" are almost always unrelated dates
  // (invoice history, "member since", etc.).
  const target = new Date(`${ymd}T00:00:00Z`).getTime()
  if (isNaN(target)) return false
  const now = Date.now()
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000
  const fourHundredDaysAhead = now + 400 * 24 * 60 * 60 * 1000
  return target >= twoDaysAgo && target <= fourHundredDaysAhead
}

// Stricter plausibility for ISO fallback matches that lack their own keyword
// context. Require the date to be strictly tomorrow or later — this rules out
// "today" false positives (e.g. a page showing today's date in an unrelated
// "Today's usage" string) while still accepting legitimate future renewals.
function isPlausibleFutureRenewalDate(ymd: string): boolean {
  const target = new Date(`${ymd}T00:00:00Z`).getTime()
  if (isNaN(target)) return false
  const now = Date.now()
  const tomorrow = now + 24 * 60 * 60 * 1000
  const fourHundredDaysAhead = now + 400 * 24 * 60 * 60 * 1000
  return target >= tomorrow && target <= fourHundredDaysAhead
}

// Keywords that indicate a date is likely a renewal/billing/expiry date.
// Used by the ISO fallback to avoid blindly matching any ISO date on a page.
const RENEWAL_CONTEXT_RE =
  /\b(?:renew|renewal|renews|renewed|billing|payment|charge|charged|invoice|subscription|plan|auto[-\s]?renew|expires?|expiring|ends?\s+on|cancel(?:led|s)?|valid\s+(?:through|until)|access\s+until|paid\s+through|next\s+(?:charge|payment|billing|invoice))\b/i

function hasNearbyRenewalContext(
  text: string,
  matchIndex: number,
  matchLength: number,
  radius = 150
): boolean {
  const start = Math.max(0, matchIndex - radius)
  const end = Math.min(text.length, matchIndex + matchLength + radius)
  return RENEWAL_CONTEXT_RE.test(text.slice(start, end))
}

export function parseRenewalDate(
  text: string
): { date: string; kind: RenewalKind } | null {
  const normalized = text.replace(/\s+/g, ' ')

  const dateFragment = '((?:\\d{4}-\\d{1,2}-\\d{1,2})|(?:\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})|(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)|(?:\\d{1,2}\\s+[A-Za-z]{3,9}\\.?(?:\\s+\\d{4})?))'

  const cancelledPatterns: RegExp[] = [
    new RegExp(`(?:cancel(?:led|ed|s(?:\\s+on)?)?|ends\\s+on|expires?|expiring|access\\s+until|valid\\s+(?:through|until)|active\\s+until)\\s+(?:on\\s+)?${dateFragment}`, 'i'),
    new RegExp(`${dateFragment}\\s*(?:\\.|,)?\\s*(?:your\\s+)?(?:access|subscription)\\s+(?:will\\s+)?end`, 'i'),
    new RegExp(`your\\s+plan\\s+(?:will\\s+)?(?:end|expire)s?\\s+(?:on\\s+)?${dateFragment}`, 'i'),
    new RegExp(`subscription\\s+ends?\\s+(?:on\\s+)?${dateFragment}`, 'i')
  ]

  const renewingPatterns: RegExp[] = [
    new RegExp(`(?:renew(?:s|al|ed)?)\\s+(?:on|date|at)?\\s*${dateFragment}`, 'i'),
    new RegExp(`(?:will\\s+)?(?:auto[\\s-]?renews?|automatically\\s+renews?)\\s+(?:on\\s+)?${dateFragment}`, 'i'),
    new RegExp(`next\\s+(?:billing|payment|charge|renewal|invoice)\\s+(?:date|on|is|at|:)?\\s*:?\\s*${dateFragment}`, 'i'),
    new RegExp(`(?:will\\s+be\\s+)?(?:charged|billed|renewed)\\s+(?:again\\s+)?(?:on\\s+)?${dateFragment}`, 'i'),
    new RegExp(`${dateFragment}\\s*(?:\\.|,)?\\s*(?:subscription|plan)?\\s*renews`, 'i'),
    new RegExp(`next\\s+invoice\\s+(?:on|date|is|:)?\\s*${dateFragment}`, 'i'),
    new RegExp(`(?:renewal|billing)\\s+date\\s*:?\\s*${dateFragment}`, 'i'),
    new RegExp(`current\\s+(?:billing\\s+)?period\\s+ends?\\s+(?:on\\s+)?${dateFragment}`, 'i')
  ]

  for (const re of cancelledPatterns) {
    const match = normalized.match(re)
    if (match) {
      const iso = parseDateFragment(match[1])
      if (iso) return { date: iso, kind: 'cancelled' }
    }
  }

  for (const re of renewingPatterns) {
    const matches = Array.from(normalized.matchAll(new RegExp(re.source, re.flags + 'g')))
    for (const match of matches) {
      const iso = parseDateFragment(match[1])
      if (iso && isPlausibleRenewingDate(iso)) return { date: iso, kind: 'renewing' }
    }
  }

  // ISO fallback: match any bare YYYY-MM-DD, but only accept if a renewal
  // keyword appears within 150 chars AND the date is strictly future (>=
  // tomorrow). This blocks false positives from pages that show today's date
  // in unrelated UI strings.
  const isoMatches = Array.from(normalized.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g))
  for (const m of isoMatches) {
    const iso = parseDateFragment(m[1])
    if (!iso) continue
    const idx = m.index ?? -1
    if (idx < 0) continue
    if (!hasNearbyRenewalContext(normalized, idx, m[0].length)) continue
    if (!isPlausibleFutureRenewalDate(iso)) continue
    return { date: iso, kind: 'renewing' }
  }

  return null
}

const RENEWAL_JSON_KEY_RE =
  /^(current_period_end|billing_period_end|subscription_ends_at|next_billing_date|next_payment_date|next_invoice_date|renews_at|renewal_date|renew_on|renews_on|cancel_at|expires_at|expires_on|active_until|access_until|period_end)$/i
const RENEWAL_JSON_SKIP_RE =
  /^(created|updated|start|started|trial_start|member|joined|last_payment|paid_at|timestamp|active_start)/i

function coerceJsonDateToYmd(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return null
    return toIsoYmd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return parseDateFragment(trimmed.slice(0, 10))
  if (/^\d{9,13}$/.test(trimmed)) return coerceJsonDateToYmd(Number(trimmed))
  return parseDateFragment(trimmed)
}

function jsonLooksCancelled(obj: Record<string, unknown>): boolean {
  if (obj.cancel_at_period_end === true) return true
  if (obj.was_canceled_at_period_end === true) return true
  if (obj.will_renew === false) return true
  if (obj.was_canceled === true || obj.cancelled === true || obj.canceled === true) return true
  const status = typeof obj.status === 'string' ? obj.status.toLowerCase() : ''
  return status === 'canceled' || status === 'cancelled' || status === 'canceling'
}

/**
 * Walk a billing/subscription JSON payload for a renewal or cancel date.
 * Ignores created/updated/start timestamps so invoice history cannot win.
 */
export function parseRenewalFromJson(
  value: unknown,
  depth = 0
): { date: string; kind: RenewalKind } | null {
  if (value == null || depth > 8) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = parseRenewalFromJson(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null

  const obj = value as Record<string, unknown>
  const kind: RenewalKind = jsonLooksCancelled(obj) ? 'cancelled' : 'renewing'

  for (const [key, nested] of Object.entries(obj)) {
    if (!RENEWAL_JSON_KEY_RE.test(key)) continue
    const iso = coerceJsonDateToYmd(nested)
    if (iso && (kind === 'cancelled' || isPlausibleRenewingDate(iso))) {
      return { date: iso, kind }
    }
  }

  for (const nested of Object.values(obj)) {
    if (nested && typeof nested === 'object') {
      const found = parseRenewalFromJson(nested, depth + 1)
      if (found) return found
    }
  }

  // Named-key miss: still accept a nested string/number next to a renewal-ish
  // key that did not match the strict allow-list (e.g. billingPeriodEnd).
  for (const [key, nested] of Object.entries(obj)) {
    if (RENEWAL_JSON_SKIP_RE.test(key)) continue
    if (!/renew|expir|period_end|billing_period|cancel_at|active_until|next_billing/i.test(key)) {
      continue
    }
    const iso = coerceJsonDateToYmd(nested)
    if (iso && isPlausibleRenewingDate(iso)) return { date: iso, kind }
  }

  return null
}

/** Stamp renewalDate/kind when missing. `source` may be page text or JSON. */
export function applyRenewalToScraped(
  data: ScrapedUsageData,
  source: string | unknown | null | undefined
): boolean {
  if (data.renewalDate) return true
  if (source == null || source === '') return false
  const renewal =
    typeof source === 'string' ? parseRenewalDate(source) : parseRenewalFromJson(source)
  if (!renewal) return false
  data.renewalDate = renewal.date
  data.renewalKind = renewal.kind
  return true
}

export interface ScrapedUsageData {
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  usageUnit: string
  resetsAt: string | null
  weeklyUsage: number | null
  weeklyLimit: number | null
  weeklyPercentUsed?: number | null // Missing from previous interface but used extensively
  weeklyResetsAt?: string | null
  weeklyBarLabel?: string
  totalPercent?: number | null
  totalBarLabel?: string
  /** Grok Bot weekly included allowance (Cursor Sand). Undefined = not fetched. */
  grokBotPercentUsed?: number | null
  grokBotResetsAt?: string | null
  isRemainingTracker?: boolean
  loginRequired?: boolean
  debugText?: string
  renewalDate?: string | null
  renewalKind?: RenewalKind | null
  detectedPlanTier?: string | null
  subModels?: {
    name?: string
    modelName?: string
    count?: number
    total?: number
    resetsAt?: string | null
  }[]
  metrics?: UsageMetric[]
  agentCredits?: {
    balance: number
    membership: number
    valueAdded: number
    bonus: number
    debt: number
    dailyFree: number
    spendingHistory: { taskName: string; date: string; creditsChange: number }[]
  }
}
