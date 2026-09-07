import { BrowserWindow } from 'electron'
import {
  fetchInManagedChrome,
  injectCookiesIntoManagedChrome,
  readCookiesFromSystemChrome,
  type ManagedChromeConfig
} from '../managedChrome'
import { ScrapedUsageData, isScraperDebugEnabled, parseRenewalDate } from './baseScraper'
import { ManagedChromeScraper } from './managedChromeScraper'
import { parseClaudeUsageText } from './usageTextParsers'

const CLAUDE_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'claude',
  port: 43212,
  // Usage is a hash-routed settings panel over the chat app. The bare
  // /settings/usage path 302s here anyway when signed in, but navigating to the
  // canonical URL directly avoids the redirect bounce.
  startUrl: 'https://claude.ai/new#settings/usage',
  // Match both the canonical usage URL and the signed-in chat app (/new).
  loggedInUrlPattern: 'settings/usage|/new'
}

export class ClaudeScraper extends ManagedChromeScraper {
  /** Set by tryApiScrape(): true only when /api/organizations confirms a live session. */
  private authConfirmed = false

  constructor() {
    super('claude', 'https://claude.ai/new#settings/usage', CLAUDE_MANAGED_CHROME)
  }

  protected getExtraCookieDomains(): string[] {
    return ['anthropic.com']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/signin', '/oauth']
  }

  protected isCloudflareProtected(): boolean {
    return true
  }

  protected isLoginUrl(url: string): boolean {
    // Only flag explicit login URLs, not the homepage
    // claude.ai/ is the post-login redirect, not a login page
    if (url.includes('auth.anthropic.com')) return true
    // /logout is where claude.ai sends an expired/invalid session (it then bounces
    // to /login?from=logout). Treat it as a logged-out state, not a parse failure,
    // so the UI shows "reconnect" instead of a misleading "layout changed" error.
    if (url.match(/\/login|\/signin|\/auth|\/logout/)) return true
    return false
  }

  protected getPageReadyCheck(): string {
    // Usage lives in a hash-routed settings panel over the chat app
    // (claude.ai/new#settings/usage). Wait specifically for the panel's own text
    // ("Current session" / "Plan usage limits" / an "N% used" figure) so we don't
    // capture the chat shell before the panel finishes rendering.
    return `document.readyState === 'complete' && !!document.body && (/Current\\s+session/i.test(document.body.innerText) || /Plan usage limits/i.test(document.body.innerText) || /\\d+%\\s*used/i.test(document.body.innerText))`
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()
    this.authConfirmed = false

    // Try API-first via CDP fetch inside managed Chrome. This also verifies the
    // session via /api/organizations and sets this.authConfirmed.
    try {
      const apiData = await this.tryApiScrape()
      if (apiData) {
        console.log('[claude] CDP API scrape succeeded')
        return apiData
      }
    } catch (err: any) {
      console.log(`[claude] CDP API scrape error: ${err?.message || err}`)
    }

    // NOTE: We no longer hard-bail here on !authConfirmed.
    // The org API check (tryApiScrape) is best-effort to set the flag early.
    // We always attempt the usage page scrape via managed Chrome; the page content
    // itself (or later isLoginUrl check) will surface login_required if needed.
    // This lets Claude reach 'ok' + percentUsed when the managed profile has cookies
    // even if the lightweight /api/organizations probe was flaky.
    if (!this.authConfirmed) {
      console.log('[claude] authConfirmed false — proceeding to page scrape anyway (page content will decide login state)')
    }

    const page = await this.evaluateManaged<string>(
      this.dashboardUrl,
      this.getPageReadyCheck(),
      'document.body ? document.body.innerText : ""',
      { timeoutMs: 20000, allowNavigate: true }
    )

    if (!page) {
      this.setLastFailureReason('extract_failed')
      return null
    }

    console.log(`[claude] Managed Chrome page loaded: ${page.title} (${page.url})`)

    if (page.title.includes('Just a moment')) {
      this.setLastFailureReason('cloudflare_blocked')
      return null
    }

    if (this.isLoginUrl(page.url)) {
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    if (isScraperDebugEnabled()) {
      console.log(`[claude] Page text preview: ${(page.value || '').replace(/\s+/g, ' ').substring(0, 1000)}`)
    }

    const parsed = parseClaudeUsageText(page.value || '')
    if (parsed) {
      console.log(
        `[claude] FINAL: ${parsed.percentUsed}% ${parsed.usageUnit}, weekly ${parsed.weeklyPercentUsed}%, ` +
          `buckets=[${(parsed.subModels ?? []).map((s) => `${s.name} ${s.count}%`).join(', ')}]`
      )
    }
    if (parsed) {
      // Successful page parse means the session is good for usage data.
      // Promote authConfirmed so future cycles skip unnecessary early bail/logging.
      this.authConfirmed = true

      // Secondary pass: subscription renewal date from settings/billing (non-fatal)
      console.log('[claude] Starting renewal scrape...')
      try {
        const billingUrls = [
          'https://claude.ai/settings/billing',
          'https://claude.ai/settings/plans'
        ]
        let foundRenewal = false
        for (const billingUrl of billingUrls) {
          try {
            const billing = await this.evaluateManaged<string>(
              billingUrl,
              `document.readyState === 'complete' && document.body && document.body.innerText.length > 100`,
              'document.body ? document.body.innerText : ""',
              { timeoutMs: 15000, allowNavigate: true }
            )
            if (!billing || !billing.value) {
              console.log(`[claude] Renewal: no content from ${billingUrl}`)
              continue
            }
            if (isScraperDebugEnabled()) {
              console.log(`[claude] Billing page (${billingUrl}) preview: ${billing.value.substring(0, 400)}`)
            }
            const renewal = parseRenewalDate(billing.value)
            if (renewal) {
              parsed.renewalDate = renewal.date
              parsed.renewalKind = renewal.kind
              console.log(`[claude] Renewal detected: ${renewal.date} (${renewal.kind}) from ${billingUrl}`)
              foundRenewal = true
              break
            } else if (isScraperDebugEnabled()) {
              console.log(`[claude] Renewal: no match in ${billingUrl} (${billing.value.length} chars)`)
            }
          } catch (err: any) {
            console.log(`[claude] Renewal navigation to ${billingUrl} failed: ${err?.message || err}`)
          }
        }
        if (!foundRenewal) console.log('[claude] Renewal scrape: no renewal date found')
      } catch (err) {
        console.error('[claude] Renewal scrape failed (non-fatal):', err)
      }
      return parsed
    }

    this.setLastFailureReason('extract_failed')
    return null
  }

  /**
   * Verify auth is valid via API, then fall through to page scraping.
   * The rate_limits API returns config (concurrency limits), not usage percentages.
   * Usage data must be scraped from the settings/usage page DOM.
   */
  protected async tryApiScrape(): Promise<ScrapedUsageData | null> {
    const config = CLAUDE_MANAGED_CHROME

    // Single auth probe against /api/organizations. The result only sets the
    // authConfirmed flag — usage data always comes from the page scrape below,
    // so a second probe after cookie injection would be a wasted request whose
    // result was ignored anyway. If the probe fails we still inject system
    // cookies (once) to help the subsequent page scrape.
    const orgResp = await fetchInManagedChrome<any[]>(config, 'https://claude.ai/api/organizations')

    if (orgResp?.ok && orgResp.data && Array.isArray(orgResp.data) && orgResp.data.length > 0) {
      this.authConfirmed = true
      console.log(`[claude] Auth verified: ${orgResp.data[0].name || orgResp.data[0].uuid || 'unknown org'}`)
    } else {
      this.authConfirmed = false
      console.log(`[claude] Auth probe returned ${orgResp?.status ?? 'null'} — injecting system cookies for the page scrape`)
      await this.injectSystemCookiesIntoCDP(config)
    }

    // Always return null — usage data comes from page scraping, not API
    return null
  }

  /**
   * Import cookies from system Chrome and inject them into managed Chrome via CDP.
   * Tries: 1) CDP port 9222 (if Chrome has debugging), 2) file-based cookie import.
   */
  private async injectSystemCookiesIntoCDP(config: ManagedChromeConfig): Promise<void> {
    try {
      // Read cookies from user's Chrome via CDP (handles v20 app-bound encryption)
      const cdpCookies = await readCookiesFromSystemChrome('claude.ai', 'anthropic.com')
      if (cdpCookies && cdpCookies.length > 0) {
        await injectCookiesIntoManagedChrome(config, cdpCookies)
        return
      }
      console.log('[claude] No cookies available from system Chrome')
    } catch (err) {
      console.log(`[claude] Cookie injection into CDP failed: ${(err as any)?.message || err}`)
    }
  }

  // Panel parsing (weekly buckets, reset times, plan tier) lives in
  // usageTextParsers.ts as parseClaudeUsageText/parseClaudeResetTime. It was
  // private here, which made the layout untestable without managed Chrome —
  // and the untested bucket scan is exactly what dropped the "Fable" bar.

  protected async extractUsageData(win: BrowserWindow): Promise<ScrapedUsageData | null> {
    const rawText = await win.webContents.executeJavaScript('document.body.innerText')
    return parseClaudeUsageText(rawText)
  }
}
