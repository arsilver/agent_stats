import { type ManagedChromeConfig } from '../managedChrome'
import { ScrapedUsageData, isScraperDebugEnabled } from './baseScraper'
import { ManagedChromeScraper } from './managedChromeScraper'
import { parseGeminiWebUsageText } from './usageTextParsers'

const GEMINI_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'gemini',
  // NOTE: 43211-43217 are taken by chatgpt/claude/minimax/fal-ai/grok/cursor/kimi-code.
  port: 43218,
  startUrl: 'https://gemini.google.com/u/1/usage?pageId=none',
  // Signed out, Google bounces to accounts.google.com; the origin-wide pattern
  // scopes tab selection while isLoginUrl() carries correctness.
  loggedInUrlPattern: 'gemini.google.com'
}

/**
 * Gemini consumer usage scraper.
 *
 * Reads gemini.google.com's own usage panel — "Current usage N% used" and
 * "Weekly limit N% used" — which is what the Gemini card is meant to mirror.
 *
 * This replaced a reader that pulled model quotas out of the Antigravity IDE's
 * local state.vscdb. That source made no network request at all, so it silently
 * froze whenever Antigravity was not in use. The local protobuf reader remains
 * as a test-only fixture (`antigravityQuotaReader.ts`).
 */
export class GeminiScraper extends ManagedChromeScraper {
  constructor() {
    super('gemini', 'https://gemini.google.com/u/1/usage?pageId=none', GEMINI_MANAGED_CHROME)
  }

  protected getLoginUrlPatterns(): string[] {
    return ['accounts.google.com', '/ServiceLogin', '/signin']
  }

  protected isLoginUrl(url: string): boolean {
    return /accounts\.google\.com|\/ServiceLogin|\/signin/i.test(url)
  }

  protected getPageReadyCheck(): string {
    // Wait for the panel itself, not the Gemini app shell: the shell settles
    // long before the usage figures render.
    return `document.readyState === 'complete' && document.body && (/Current usage|Weekly limit|% used/i.test(document.body.innerText) || /accounts\\.google\\.com/.test(location.href)) && document.body.innerText.length > 100`
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    const page = await this.evaluateManaged<string>(
      this.dashboardUrl,
      this.getPageReadyCheck(),
      'document.body ? document.body.innerText : ""',
      { timeoutMs: 25000, allowNavigate: true }
    )

    if (!page) {
      // A readiness timeout says nothing about WHY. Signed out, Gemini serves
      // its app shell at /app — no usage copy, no accounts.google.com redirect
      // — so the strict gate can never match and the run would otherwise end
      // as an unexplained 25s stall. Re-read permissively to classify.
      const settled = await this.evaluateManaged<string>(
        this.dashboardUrl,
        'document.readyState === "complete"',
        'document.body ? document.body.innerText : ""',
        // allowNavigate must stay true: signed out, Gemini redirects
        // /u/1/usage → /app, and evaluateInManagedChrome bails outright when
        // the settled URL no longer prefixes the requested one.
        { timeoutMs: 10000, allowNavigate: true }
      ).catch(() => null)

      if (!settled) {
        this.setLastFailureReason('managed_browser_inactive')
        console.log('[gemini] Managed Chrome unavailable')
        return null
      }

      if (isScraperDebugEnabled()) {
        console.log(
          `[gemini] SETTLED PAGE (${settled.url}) >>>${(settled.value || '(empty)').replace(/\s+/g, ' ').slice(0, 1200)}<<<`
        )
      }

      const parsedLate = parseGeminiWebUsageText(settled.value || '')
      if (parsedLate) {
        console.log(`[gemini] FINAL (late): ${parsedLate.percentUsed}% current, weekly ${parsedLate.weeklyPercentUsed}%`)
        this.markScrapeWorked()
        return parsedLate
      }

      this.setLastFailureReason('login_required')
      console.log(`[gemini] No usage panel at ${settled.url} — Google sign-in required in the managed profile`)
      return { loginRequired: true } as any
    }

    console.log(`[gemini] Managed Chrome page loaded: ${page.title} (${page.url})`)

    if (isScraperDebugEnabled()) {
      console.log(
        `[gemini] RAW PAGE TEXT >>>${(page.value || '(empty)').replace(/\s+/g, ' ').slice(0, 2000)}<<<`
      )
    }

    if (this.isLoginUrl(page.url)) {
      this.setLastFailureReason('login_required')
      console.log('[gemini] Signed out — Google sign-in required in the managed profile')
      return { loginRequired: true } as any
    }

    const parsed = parseGeminiWebUsageText(page.value || '')
    if (!parsed) {
      // A signed-in page that yields no figures is a parse problem, not a
      // login problem — keep the two distinguishable in the log.
      this.setLastFailureReason('extract_failed')
      console.log(`[gemini] No usage figures found (${(page.value || '').length} chars of page text)`)
      return null
    }

    console.log(
      `[gemini] FINAL: ${parsed.percentUsed}% current, weekly ${parsed.weeklyPercentUsed}%, ` +
        `plan ${parsed.detectedPlanTier ?? 'unknown'}, resets ${parsed.resetsAt ?? 'n/a'}`
    )
    this.markScrapeWorked()
    this.importError = null
    return parsed
  }
}
