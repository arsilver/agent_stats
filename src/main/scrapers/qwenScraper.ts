import { type ManagedChromeConfig } from '../managedChrome'
import { ScrapedUsageData, isScraperDebugEnabled } from './baseScraper'
import { ManagedChromeScraper } from './managedChromeScraper'
import {
  parseQwenSubscriptionText,
  parseQwenUsageJson,
  qwenStructuredParseIsIncomplete
} from './usageTextParsers'

const QWEN_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'qwen',
  // NOTE: 43211-43218 are taken by chatgpt/claude/minimax/fal-ai/grok/cursor/kimi/gemini.
  port: 43219,
  startUrl: 'https://home.qwencloud.com/billing/subscription/token-plan-individual',
  loggedInUrlPattern: 'qwencloud.com',
  loginCompleteExpression: `(async () => {
    try {
      if (!/(^|\\.)qwencloud\\.com$/.test(location.hostname)) return false;
      // Check if we're on a billing/subscription page (signed-in state)
      return /billing|subscription|token|usage/i.test(location.pathname);
    } catch (e) { return false; }
  })()`
}

/**
 * Qwen Code (QwenCloud) scraper.
 *
 * QwenCloud is a SPA (Single Page Application) that requires managed Chrome
 * to render the billing/subscription page. The scraper extracts usage data
 * from the token plan individual page.
 *
 * Expected data on the page:
 * - Token usage (current/limit)
 * - Subscription tier
 * - Reset date
 * - Credit balance
 */
export class QwenScraper extends ManagedChromeScraper {
  constructor() {
    super('qwen', 'https://home.qwencloud.com/billing/subscription/token-plan-individual', QWEN_MANAGED_CHROME)
  }

  // Parked-SPA defense: the billing page is reloaded on every scrape. The main
  // scrape call also passes forceReload: true literally — a smoke fixture
  // asserts that source text (tests/test_usage_text_parsers.js).
  protected readonly forceReloadOnScrape: boolean = true

  protected isCloudflareProtected(): boolean {
    return false
  }

  protected getExtraCookieDomains(): string[] {
    return ['qwencloud.com', '.qwencloud.com', 'aliyun.com', '.aliyun.com']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/auth', '/sign-in', '/signin']
  }

  protected getPageReadyCheck(): string {
    // Wait for either a metered Remaining N% or the lifted ∞ 5-hour card.
    return `document.readyState === 'complete' && document.body && /(?:Usage\\s*Limit|5[\\s-]*hours?|7[\\s-]*days?|Remaining\\s*\\d|Temporarily\\s*(?:Lifted|Removed))/i.test(document.body.innerText || '')`
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    type QwenPageValue = {
      text?: string
      has5?: boolean
      has7?: boolean
      lastUpdated?: string | null
      apis?: unknown[]
    }

    // Always reload. A parked Qwen SPA can sit on "Last updated 04:27" all
    // day while live usage moves (0.3% → 11.3%). Same class of bug as Cursor
    // spending-page DOM.
    const page = await this.evaluateManaged<QwenPageValue>(
      this.dashboardUrl,
      this.getPageReadyCheck(),
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const tryJson = async (url) => {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2500);
            const r = await fetch(url, {
              credentials: 'include',
              headers: { Accept: 'application/json' },
              signal: ctrl.signal
            });
            clearTimeout(timer);
            if (!r.ok) return null;
            return await r.json();
          } catch (e) { return null; }
        };
        for (let i = 0; i < 30; i++) {
          const text = document.body ? document.body.innerText : '';
          const has5 = /5[\\s-]*hours?/i.test(text);
          const has7 = /7[\\s-]*days?/i.test(text);
          const hasMeter = /Remaining\\s*\\d/i.test(text);
          const hasLifted = /Temporarily\\s*(?:Lifted|Removed)|Remaining\\s*(?:[\\u267E\\u221E]|[-\\u2013\\u2014])/i.test(text);
          const dualReady = has5 && has7 && (hasMeter || hasLifted);
          const singleReady = (hasMeter || hasLifted) && i >= 26;
          if (dualReady || singleReady) break;
          await sleep(500);
        }
        const text = document.body ? document.body.innerText : '';
        const last = text.match(/Last updated\\s+(\\d{1,2}:\\d{2}:\\d{2})/i);
        const apis = [];
        for (const url of [
          '/tokenplan/personal/api/v2/usage',
          '/tokenplan/personal/api/v2/quota-config',
          '/tokenplan/personal/api/v2/subscription'
        ]) {
          const json = await tryJson(url);
          if (json) apis.push(json);
        }
        return {
          text,
          has5: /5[\\s-]*hours?/i.test(text),
          has7: /7[\\s-]*days?/i.test(text),
          lastUpdated: last ? last[1] : null,
          apis
        };
      })()`,
      {
        timeoutMs: 45000,
        allowNavigate: true,
        forceReload: true,
        captureUrlIncludes: [
          'tokenplan',
          'token-plan',
          'quota-config',
          'subscription',
          'quota',
          'usage',
          'credit'
        ]
      }
    )

    if (!page || page.value == null) {
      const classified = await this.classifyManagedNullResult(this.dashboardUrl, { loginUrlIsLoginRequired: true })
      if (classified.reason === 'login_required') return { loginRequired: true } as any
      return null
    }

    console.log(`[qwen] Managed Chrome page loaded: ${page.title} (${page.url})`)

    if (page.title.includes('Just a moment') || page.title.includes('Cloudflare')) {
      this.setLastFailureReason('cloudflare_blocked')
      console.log('[qwen] Cloudflare challenge persists in managed Chrome')
      return null
    }

    if (this.isLoginUrl(page.url)) {
      console.log(`[qwen] Redirected to login (${page.url})`)
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    const text = page.value.text || ''
    const lower = text.toLowerCase()

    if (/verify you are human|captcha|access denied|just a moment/.test(lower)) {
      this.setLastFailureReason('cloudflare_blocked')
      console.log('[qwen] Access challenge detected in page text')
      return null
    }

    if (
      /sign in|log in|continue with|create account|welcome back/.test(lower) &&
      !/token|usage|subscription|billing|credit|quota|\d{1,3}\s*\/\s*\d{1,3}/.test(lower)
    ) {
      this.setLastFailureReason('login_required')
      console.log('[qwen] Login form detected on dashboard — needs sign-in')
      return { loginRequired: true } as any
    }

    if (isScraperDebugEnabled()) {
      console.log(`[qwen] Page text preview: ${text.replace(/\s+/g, ' ').substring(0, 1500)}`)
    } else {
      // Always log a snippet for debugging
      console.log(`[qwen] Page text snippet: ${text.replace(/\s+/g, ' ').substring(0, 400)}`)
    }

    const blobs: unknown[] = [...(page.value.apis ?? [])]
    for (const row of page.capturedResponses ?? []) {
      try { blobs.push(JSON.parse(row.body) as unknown) } catch { /* ignore */ }
    }
    const jsonParsed = blobs.map((blob) => parseQwenUsageJson(blob)).find((row) => row != null) ?? null
    const textParsed = parseQwenSubscriptionText(text)
    const candidates = [jsonParsed, textParsed].filter((row): row is NonNullable<typeof row> => row != null)
    const structured =
      candidates.find((row) => !qwenStructuredParseIsIncomplete(text, row)) ??
      candidates[0] ??
      null
    if (structured && qwenStructuredParseIsIncomplete(text, structured)) {
      console.log(
        `[qwen] Refusing incomplete parse (has5=${page.value.has5} has7=${page.value.has7} ` +
        `unit=${structured.usageUnit} weekly=${structured.weeklyPercentUsed ?? 'n/a'})`
      )
      this.setLastFailureReason('extract_failed')
      return null
    }
    if (structured) {
      const primaryLabel =
        structured.usageUnit === '5h lifted'
          ? '5h=LIFTED(∞)'
          : structured.usageUnit === '7d credits'
            ? `7d=${structured.currentUsage}/${structured.usageLimit ?? '∞'} (${structured.percentUsed}%)`
            : `5h=${structured.currentUsage}/${structured.usageLimit ?? '∞'} (${structured.percentUsed}%)`
      console.log(
        `[qwen] structured: ${primaryLabel} reset=${structured.resetsAt ?? 'none'} | ` +
        `weekly=${structured.weeklyUsage ?? 'n/a'}/${structured.weeklyLimit ?? 'n/a'} ` +
        `(${structured.weeklyPercentUsed ?? 'n/a'}%) reset7d=${structured.weeklyResetsAt ?? 'none'} ` +
        `plan=${structured.detectedPlanTier ?? 'n/a'} lastUpdated=${page.value.lastUpdated ?? 'n/a'} ` +
        `has5=${page.value.has5} has7=${page.value.has7}`
      )
      this.markScrapeWorked()
      return structured
    }

    // Last-resort fallback. Never treat a bare "Remaining N%" as used% — that
    // inverted polarity produced the broken 81.4/100 card with no 7-day bar.
    const fallback = this.parseUsageFromText(text)
    if (fallback) {
      console.log(
        `[qwen] fallback: ${fallback.currentUsage}/${fallback.usageLimit} (${fallback.percentUsed}%) ` +
        `weekly=${fallback.weeklyPercentUsed ?? 'n/a'}%`
      )
      this.markScrapeWorked()
      return fallback
    }

    console.log('[qwen] Could not parse usage data from page text')
    this.setLastFailureReason('extract_failed')
    return null
  }

  /**
   * Loose multi-window extract for pages where header wording drifted past the
   * structured parser. Only accepts Remaining/Used percentages paired with a
   * Total pool — never invents a 100-point percent bar from a bare remaining %.
   */
  private parseUsageFromText(text: string): ScrapedUsageData | null {
    // Re-try structured parse after collapsing newlines (SPA sometimes inserts
    // hard breaks mid-label that normalizeText already handles; keep as noop
    // safety so callers can pass either form).
    const retry = parseQwenSubscriptionText(text)
    if (retry) return retry

    const normalized = text.replace(/\s+/g, ' ').trim()

    // Lifted 5h (Temporarily Lifted / Remaining ∞) + optional 7d meter.
    // Structured parse should already catch this; keep as last-resort dual path.
    const fiveMatch = normalized.match(/5[\s-]*hours?\s*(?:usage\s*)?(?:limit|quota)/i)
    const sevenMatch = normalized.match(/7[\s-]*days?\s*(?:usage\s*)?(?:limit|quota)/i)
    const fiveSlice = fiveMatch
      ? normalized.slice(
          fiveMatch.index!,
          sevenMatch && sevenMatch.index! > fiveMatch.index! ? sevenMatch.index! : normalized.length
        )
      : ''
    const fiveLifted =
      fiveSlice.length > 0 &&
      (/Temporarily\s*(?:Lifted|Removed)|limit\s*(?:is\s*)?(?:lifted|removed|not\s*enforced)/i.test(
        fiveSlice
      ) ||
        (/Remaining\s*/i.test(fiveSlice) &&
          /(?:\u267E\uFE0F?|\u221E|infinity|unlimited|no\s*limit)/i.test(fiveSlice) &&
          !/Remaining\s+\d/i.test(fiveSlice)) ||
        /Remaining\s*[-–—]\s*(?:$|[^\d%])/i.test(fiveSlice))

    // Collect Remaining N% … Total M pairs in order. Two pairs ⇒ 5h + 7d.
    const windows: { remainingPct: number; total: number | null; resetsAt: string | null }[] = []
    const pairRe =
      /Remaining\s+(\d+(?:\.\d+)?)\s*%[\s\S]{0,120}?Total\s+([\d,]+(?:\.\d+)?)/gi
    let m: RegExpExecArray | null
    while ((m = pairRe.exec(normalized)) !== null && windows.length < 2) {
      const remainingPct = parseFloat(m[1])
      const total = parseFloat(m[2].replace(/,/g, ''))
      if (!Number.isFinite(remainingPct)) continue
      // Reset time may appear before Remaining in the same card; scan a window around the match.
      const aroundStart = Math.max(0, m.index - 160)
      const around = normalized.slice(aroundStart, m.index + m[0].length + 40)
      let resetsAt: string | null = null
      const rst = around.match(/Reset(?:s| time)?\s*(?:time)?\s*:?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/i)
      if (rst) {
        const d = new Date(rst[1].replace(' ', 'T'))
        if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString()
      }
      windows.push({
        remainingPct,
        total: Number.isFinite(total) ? total : null,
        resetsAt
      })
    }

    if (fiveLifted) {
      const sevenWin = windows[0] ?? null
      const toUsed = (w: { remainingPct: number; total: number | null }) => {
        const usedPct = Math.max(0, Math.min(100, 100 - w.remainingPct))
        const used =
          w.total !== null ? Math.round((w.total * usedPct) / 100 * 100) / 100 : usedPct
        return { usedPct, used }
      }
      const w = sevenWin ? toUsed(sevenWin) : null
      return {
        currentUsage: 0,
        usageLimit: null,
        percentUsed: 0,
        usageUnit: '5h lifted',
        resetsAt: null,
        weeklyUsage: w ? w.used : null,
        weeklyLimit: sevenWin ? (sevenWin.total ?? 100) : null,
        weeklyPercentUsed: w ? Math.round(w.usedPct * 100) / 100 : null,
        weeklyResetsAt: sevenWin?.resetsAt ?? null,
        weeklyBarLabel: w ? '7-day' : undefined
      }
    }

    if (windows.length === 0) {
      // Explicit used ratio only — never a bare percent.
      const usedRatio = normalized.match(
        /(?:used|usage|consumed)[:\s]*(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)/i
      )
      if (!usedRatio) return null
      const currentUsage = parseFloat(usedRatio[1].replace(/,/g, ''))
      const usageLimit = parseFloat(usedRatio[2].replace(/,/g, ''))
      if (!Number.isFinite(currentUsage) || !Number.isFinite(usageLimit) || usageLimit <= 0) return null
      return {
        currentUsage,
        usageLimit,
        percentUsed: Math.round((currentUsage / usageLimit) * 1000) / 10,
        usageUnit: 'credits',
        resetsAt: null,
        weeklyUsage: null,
        weeklyLimit: null,
        weeklyPercentUsed: null
      }
    }

    const toUsed = (w: { remainingPct: number; total: number | null }) => {
      const usedPct = Math.max(0, Math.min(100, 100 - w.remainingPct))
      const used =
        w.total !== null ? Math.round((w.total * usedPct) / 100 * 100) / 100 : usedPct
      return { usedPct, used }
    }

    const primary = windows[0]
    const p = toUsed(primary)
    const weeklyWin = windows[1] ?? null
    const w = weeklyWin ? toUsed(weeklyWin) : null

    return {
      currentUsage: p.used,
      usageLimit: primary.total ?? 100,
      percentUsed: Math.round(p.usedPct * 100) / 100,
      usageUnit: 'credits',
      resetsAt: primary.resetsAt,
      weeklyUsage: w ? w.used : null,
      weeklyLimit: weeklyWin ? (weeklyWin.total ?? 100) : null,
      weeklyPercentUsed: w ? Math.round(w.usedPct * 100) / 100 : null,
      weeklyResetsAt: weeklyWin?.resetsAt ?? null,
      weeklyBarLabel: w ? '7-day' : undefined
    }
  }
}
