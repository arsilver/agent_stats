import {
  evaluateInManagedChrome,
  type ManagedChromeConfig
} from '../managedChrome'
import {
  ScrapedUsageData,
  isScraperDebugEnabled,
  applyRenewalToScraped
} from './baseScraper'
import { ManagedChromeScraper, MANAGED_PAGE_BODY_TEXT_FN } from './managedChromeScraper'
import { parseChatgptUsageText } from './usageTextParsers'

const CHATGPT_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'chatgpt',
  port: 43211,
  startUrl: 'https://chatgpt.com/codex/cloud/settings/analytics',
  loggedInUrlPattern: '/codex/cloud/settings/|/codex/settings/|/codex/'
}

interface ChatgptRenewalProbe {
  text: string
  jsons: unknown[]
}

// In-page GET only — never POST to customer-portal (that can mint Stripe sessions).
const CHATGPT_SUBSCRIPTION_API_SCRIPT = `(async () => {
  const urls = [
    '/backend-api/subscriptions',
    '/backend-api/accounts/check'
  ];
  const jsons = [];
  await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      jsons.push(await res.json());
    } catch (e) {}
  }));
  const body = document.body;
  const text = body ? (body.innerText || body.textContent || '') : '';
  return { text: text, jsons: jsons };
})()`

const CHATGPT_SETTINGS_RENEWAL_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  ${MANAGED_PAGE_BODY_TEXT_FN}
  const clickByLabel = (pattern) => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="button"]'));
    for (const el of nodes) {
      const t = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
      if (!pattern.test(t) || t.length > 48) continue;
      try { el.click(); return t; } catch (e) {}
    }
    return null;
  };

  const jsons = [];
  await Promise.all(['/backend-api/subscriptions', '/backend-api/accounts/check'].map(async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      jsons.push(await res.json());
    } catch (e) {}
  }));

  if (!/#settings/i.test(location.hash)) {
    try { location.hash = '#settings'; } catch (e) {}
    await sleep(400);
  }
  if (!/Manage subscription|Next billing|renews|Your plan/i.test(bodyText())) {
    clickByLabel(/^(Settings)$/i);
    await sleep(500);
  }
  clickByLabel(/^(Account|My plan|Plan|Subscription|Billing)$/i);
  await sleep(600);
  for (let i = 0; i < 10; i++) {
    if (/renew|billing date|manage subscription|next payment|will be billed|period ends/i.test(bodyText())) break;
    await sleep(250);
  }
  return { text: bodyText(), jsons: jsons };
})()`

export class ChatGPTScraper extends ManagedChromeScraper {
  constructor() {
    super('chatgpt', 'https://chatgpt.com/codex/cloud/settings/analytics', CHATGPT_MANAGED_CHROME)
  }

  // Parked-SPA defense: Codex analytics is reloaded on every scrape. The main
  // scrape call also passes forceReload: true literally — a smoke fixture
  // asserts that source text (tests/test_usage_text_parsers.js). Renewal
  // probes call evaluateInManagedChrome directly so they do NOT reload.
  protected readonly forceReloadOnScrape: boolean = true

  protected getExtraCookieDomains(): string[] {
    return ['openai.com', 'auth0.openai.com']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/auth/login', '/login', '/auth', 'auth0.openai.com']
  }

  protected isCloudflareProtected(): boolean {
    return true
  }

  protected isLoginUrl(url: string): boolean {
    // Only flag auth0.openai.com URLs as login pages, NOT the homepage
    // https://chatgpt.com/ is the post-login redirect URL after authentication
    if (url.includes('auth0.openai.com')) return true
    if (url.match(/^https:\/\/chatgpt\.com\/auth\/.*/)) return true
    return false
  }

  protected getPageReadyCheck(): string {
    // Wait for a real usage meter, not just the Codex chrome. "Codex" / "Plan"
    // is on the shell before 5-hour and weekly remaining hydrate.
    return `document.readyState === 'complete' && document.body && !document.body.innerText.includes('Loading usage data') && !document.body.innerText.includes('Loading...') && /(?:Weekly usage limit|5[\\s-]*hour|\\d{1,3}%\\s*remaining)/i.test(document.body.innerText || '') && document.body.innerText.length > 200`
  }

  /**
   * ChatGPT's usage page is an SPA — there is no usable API endpoint to probe,
   * so this is intentionally a no-op. It previously performed a full CDP
   * navigation as a "connectivity check" and then unconditionally returned
   * null, which doubled page loads per scrape for zero information.
   * Kept (returning null without navigating) so the base-class contract holds.
   */
  protected async tryApiScrape(): Promise<ScrapedUsageData | null> {
    return null
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    // Try API-first via CDP fetch inside managed Chrome
    try {
      const apiData = await this.tryApiScrape()
      if (apiData) {
        console.log('[chatgpt] CDP API scrape succeeded')
        return apiData
      }
    } catch (err: any) {
      console.log(`[chatgpt] CDP API scrape error: ${err?.message || err}`)
    }

    // Return the page text and parse in-process. The parser used to be a
    // ~200-line string injected into the page — unreachable by any test, which
    // is how an untethered fallback that fabricated the 5-hour reading out of
    // the weekly bar survived. parseChatgptUsageText owns it now.
    // Always reload: parked Codex analytics is a SPA and can sit on weekly-only
    // chrome while the 5-hour meter is still hydrating.
    const page = await this.evaluateManaged<string>(
      this.dashboardUrl,
      this.getPageReadyCheck(),
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        ${MANAGED_PAGE_BODY_TEXT_FN}
        for (let i = 0; i < 24; i++) {
          const t = bodyText();
          const has5 = /5[\\s-]*hour[\\s\\S]{0,200}?\\d{1,3}%[\\s\\S]{0,40}?remaining/i.test(t);
          const hasWeekly = /Weekly[\\s\\S]{0,200}?\\d{1,3}%[\\s\\S]{0,40}?remaining/i.test(t);
          if (has5 && hasWeekly) break;
          if (hasWeekly && i >= 16 && !/5[\\s-]*hour/i.test(t)) break;
          await sleep(250);
        }
        return bodyText();
      })()`,
      { timeoutMs: 45000, allowNavigate: true, allowTargetOpen: true, forceReload: true }
    )

    if (!page) {
      this.setLastFailureReason('extract_failed')
      return null
    }

    console.log(`[chatgpt] Managed Chrome page loaded: ${page.title} (${page.url})`)

    // Every scrape now leaves a record of what the page actually said. The old
    // preview was attached only on the both-values branch, so the failing
    // cases — the ones worth diagnosing — logged nothing at all.
    if (isScraperDebugEnabled()) {
      console.log(
        `[chatgpt] RAW PAGE TEXT >>>${(page.value || '(empty)').replace(/\s+/g, ' ').slice(0, 3000)}<<<`
      )
    }

    if (page.title.includes('Just a moment')) {
      this.setLastFailureReason('cloudflare_blocked')
      return null
    }

    if (this.isLoginUrl(page.url)) {
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    const data = parseChatgptUsageText(page.value || '')
    if (data && typeof data.currentUsage === 'number') {
      console.log(`[chatgpt] Extracted: ${data.currentUsage}${data.usageUnit ? ' ' + data.usageUnit : ''}, resets: ${data.resetsAt ?? 'unknown'}, weekly: ${data.weeklyUsage ?? 'n/a'}, weeklyResets: ${data.weeklyResetsAt ?? 'n/a'}`)
      await this.attachSubscriptionRenewal(data)
      return data
    }

    // Log what we got to debug parser failures
    console.log('[chatgpt] Extraction returned:', JSON.stringify(page.value)?.substring(0, 300))
    this.setLastFailureReason('extract_failed')
    return null
  }

  /**
   * Subscription renewal lives on Settings → Account (or the subscriptions API),
   * not on Codex analytics. Hash-only billing URLs never opened that modal, so
   * Plus/Pro cards stayed on "+ Add renewal date". Non-fatal; usage still stands.
   */
  private async attachSubscriptionRenewal(data: ScrapedUsageData): Promise<void> {
    if (data.renewalDate) return
    try {
      const applyProbe = (probe: ChatgptRenewalProbe | null | undefined, source: string): boolean => {
        if (!probe) return false
        if (applyRenewalToScraped(data, probe.jsons)) {
          console.log(`[chatgpt] Renewal detected: ${data.renewalDate} (${data.renewalKind}) from ${source} API`)
          return true
        }
        if (applyRenewalToScraped(data, probe.text)) {
          console.log(`[chatgpt] Renewal detected: ${data.renewalDate} (${data.renewalKind}) from ${source} text`)
          return true
        }
        return false
      }

      const api = await evaluateInManagedChrome<ChatgptRenewalProbe>(
        CHATGPT_MANAGED_CHROME,
        this.dashboardUrl,
        'document.readyState === "complete" && !!document.body',
        CHATGPT_SUBSCRIPTION_API_SCRIPT,
        { timeoutMs: 8000, allowNavigate: false }
      )
      if (applyProbe(api?.value, 'analytics')) return

      const settings = await evaluateInManagedChrome<ChatgptRenewalProbe>(
        CHATGPT_MANAGED_CHROME,
        'https://chatgpt.com/#settings',
        `document.readyState === 'complete' && document.body && document.body.innerText.length > 80`,
        CHATGPT_SETTINGS_RENEWAL_SCRIPT,
        { timeoutMs: 12000, allowNavigate: true }
      )
      if (settings?.value && isScraperDebugEnabled()) {
        console.log(`[chatgpt] Settings renewal preview: ${settings.value.text.replace(/\s+/g, ' ').slice(0, 400)}`)
      }
      if (applyProbe(settings?.value, 'settings')) return
      console.log('[chatgpt] Renewal scrape: no subscription date found')
    } catch (err) {
      console.error('[chatgpt] Renewal scrape failed (non-fatal):', err)
    }
  }

}
