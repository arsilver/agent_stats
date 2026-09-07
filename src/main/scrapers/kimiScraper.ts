import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import {
  checkLoginState,
  type ManagedChromeConfig
} from '../managedChrome'
import { ScrapedUsageData, ScrapeFailureReason, isScraperDebugEnabled, parseRenewalDate } from './baseScraper'
import { ManagedChromeScraper } from './managedChromeScraper'
import { parseKimiMembershipText } from './usageTextParsers'

// ─── Persistent renewal-date cache ───────────────────────────────
// Probing billing/subscription pages is slow, so the renewal pass only runs
// when the cached value is missing or older than 24h. Same small-JSON-state
// pattern used by minimaxScraper / falaiScraper.
interface RenewalSnapshot {
  renewalDate: string | null
  renewalKind: 'renewing' | 'cancelled' | null
  fetchedAt: string
}

let renewalPersistPath: string | null = null
function getRenewalPersistPath(): string {
  if (!renewalPersistPath) {
    renewalPersistPath = join(app.getPath('userData'), 'kimi-renewal-state.json')
  }
  return renewalPersistPath
}

function loadRenewalSnapshot(): RenewalSnapshot | null {
  try {
    const p = getRenewalPersistPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as RenewalSnapshot
    if (typeof data.fetchedAt !== 'string') return null
    return data
  } catch {
    return null
  }
}

function saveRenewalSnapshot(date: string | null, kind: 'renewing' | 'cancelled' | null): void {
  try {
    const snapshot: RenewalSnapshot = { renewalDate: date, renewalKind: kind, fetchedAt: new Date().toISOString() }
    writeFileSync(getRenewalPersistPath(), JSON.stringify(snapshot))
  } catch (err) {
    console.error('[kimi-code] Failed to persist renewal snapshot:', err)
  }
}

// International product is kimi.ai (Google SSO). kimi.com is the China
// product (WeChat / +86) and must not be the reconnect target.
const KIMI_ORIGIN = 'https://www.kimi.ai'
const KIMI_QUOTA_URL = `${KIMI_ORIGIN}/membership/subscription?tab=quota`
const KIMI_AGENT_URL = `${KIMI_ORIGIN}/agent`
const KIMI_RENEWAL_URLS = [
  `${KIMI_ORIGIN}/code/console/subscription`,
  `${KIMI_ORIGIN}/code/console/billing`
] as const

// ─── Bilingual (EN / 中文) matching helpers ──────────────────────
// Legacy console copy can still be Chinese: 本周用量 (weekly usage),
// 频限明细 (rate-limit details), "N 小时后重置" (resets in N hours).
// Usage values hydrate asynchronously as '-' placeholders, so every
// percentage regex must anchor on digits immediately before '%'.
const CONSOLE_IDENTITY_RE = /本周用量|频限明细|Weekly usage|Rate limit/i
// Membership quota page (kimi.ai/membership/subscription?tab=quota) identity.
const MEMBERSHIP_IDENTITY_RE = /Usage Progress|Total usage|My Quota|5-hour usage|7-day usage|Quota reset|总用量|小时用量|天用量/i
// Strong login-form markers ONLY — every entry must be a phrase that cannot
// appear on a signed-in page. Bare "sign in"/"log in"/"phone number" are
// banned: a chat titled "…Design Inspiration…" contains "sign In" (no word
// boundary), signed-in pages say "When you log in to a device…", and settings
// pages can list a phone number. That substring match made half-hydrated
// SIGNED-IN pages classify as login_required and flap the card to
// "Cookies expired" (observed live 2026-07-17).
// Single source of truth for LOGIN_MARKER_RE, getPageReadyCheck() and
// KIMI_LOGIN_COMPLETE_EXPR — contains no quotes/backslashes so it embeds
// safely inside the in-page script strings.
const KIMI_LOGIN_MARKER_SRC =
  '扫码登录|手机号登录|验证码登录|微信登录|密码登录|立即登录|登录/注册|welcome back|create account|continue with google|log in with google|log in to chat with kimi|log in with phone|log in to sync|scan qr'
const LOGIN_MARKER_RE = new RegExp(KIMI_LOGIN_MARKER_SRC, 'i')
const HYDRATED_PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/
// Agent badge counters: "剩余 12", "12 次", "12 left"
const AGENT_BADGE_RE = /剩余\s*\d+|\d+\s*次|\d+\s*left/i

/** First hydrated percentage within `window` chars after a section marker. Never matches '-' placeholders. */
function percentAfter(text: string, sectionRe: RegExp, window = 300): number | null {
  const m = text.match(sectionRe)
  if (!m || m.index === undefined) return null
  const slice = text.slice(m.index, m.index + window)
  const pct = slice.match(HYDRATED_PERCENT_RE)
  return pct ? parseFloat(pct[1]) : null
}

/** "N 小时后重置" / "Resets in N hours" after a section marker → ISO timestamp. */
function resetAfter(text: string, sectionRe: RegExp, window = 400): string | null {
  const m = text.match(sectionRe)
  if (!m || m.index === undefined) return null
  const slice = text.slice(m.index, m.index + window)

  let amount: number | null = null
  let unit = ''
  const zh = slice.match(/(\d+)\s*(小时|分钟|天)\s*后重置/)
  const en = slice.match(/Resets in (\d+)\s*(hours?|minutes?|days?)/i)
  if (zh) {
    amount = parseInt(zh[1], 10)
    unit = zh[2] === '小时' ? 'hour' : zh[2] === '分钟' ? 'minute' : 'day'
  } else if (en) {
    amount = parseInt(en[1], 10)
    unit = en[2].toLowerCase()
  }
  if (amount === null) return null

  const d = new Date()
  if (unit.startsWith('minute')) d.setMinutes(d.getMinutes() + amount)
  else if (unit.startsWith('day')) d.setDate(d.getDate() + amount)
  else d.setHours(d.getHours() + amount)
  return d.toISOString()
}

/** Largest plausible Agent-token counter from badge text (剩余 N / N 次 / N left). */
function extractAgentTokensLeft(text: string): number | null {
  const patterns = [/剩余\s*(\d+)/g, /(\d+)\s*次/g, /(\d+)\s*left/gi]
  let maxLeft: number | null = null
  for (const re of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      const val = parseInt(match[1], 10)
      // Users rarely hold more than ~100 Agent tokens; the cap also filters
      // out unrelated large numeric IDs elsewhere on the page.
      if (val >= 0 && val < 500 && (maxLeft === null || val > maxLeft)) {
        maxLeft = val
      }
    }
  }
  return maxLeft
}

// ─── Managed Chrome (real Chrome via CDP) ────────────────────────
// kimi.ai is NOT Cloudflare-fronted — managed Chrome is needed because the
// user signs in with Google SSO, which refuses Electron's embedded browser
// ("disallowed_useragent"). The Electron partition therefore never acquired a
// localStorage JWT and every scrape rendered the anonymous marketing shell.
// In a real Chrome profile the SSO works, the JWT persists, and the SPA
// refreshes its own tokens on each load.

// Sign-in probe for waitForLoginComplete and for timeout classification.
// The quota URL and the page title ("Kimi AI with K3 | …") are identical
// signed-out and signed-in, so URL/title can never decide. Signed-in =
// hydrated usage % near an identity marker, an agent badge counter, or the
// signed-in sidebar ("My Kimi" / "All Chats" — present even before the quota
// values hydrate); a strong login marker vetoes first. Deliberately NO
// localStorage token check: kimi stores anonymous_access_token/
// anonymous_refresh_token for LOGGED-OUT visitors too (verified in the
// profile's leveldb), so token-key matching misclassifies in both directions.
// Synchronous, never throws.
const KIMI_LOGIN_COMPLETE_EXPR = `(function(){
  try {
    if (document.readyState !== 'complete' || !document.body) return false;
    var t = document.body.innerText || '';
    if (t.length < 40) return false;
    if (/(?:本周用量|Weekly usage|频限明细|Rate limit|Total usage|Usage Progress|5-hour usage|7-day usage|Quota reset)[\\s\\S]{0,300}?\\d+(?:\\.\\d+)?\\s*%/.test(t)) return true;
    if (/剩余\\s*\\d+|\\d+\\s*次|\\d+\\s*left/.test(t)) return true;
    if (new RegExp('${KIMI_LOGIN_MARKER_SRC}', 'i').test(t)) return false;
    if (/\\bMy Kimi\\b|\\bAll Chats\\b/.test(t)) return true;
    return false;
  } catch (e) { return false; }
})()`

const KIMI_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'kimi-code',
  // NOTE: 43211-43216 are taken by chatgpt/claude/minimax/fal-ai/grok/cursor.
  port: 43217,
  startUrl: KIMI_QUOTA_URL,
  // URL never changes on sign-in; the origin-wide pattern only scopes tab
  // selection — loginCompleteExpression carries correctness. kimi.com is a
  // redirect fallback only (China product); reconnect always starts on kimi.ai.
  loggedInUrlPattern: 'kimi.ai|kimi.com',
  loginCompleteExpression: KIMI_LOGIN_COMPLETE_EXPR
}

export class KimiScraper extends ManagedChromeScraper {
  constructor() {
    super('kimi-code', KIMI_QUOTA_URL, KIMI_MANAGED_CHROME)
  }

  protected getExtraCookieDomains(): string[] {
    return ['kimi.ai', '.kimi.ai', 'kimi.com', '.kimi.com', '.moonshot.cn', 'kimi.moonshot.cn']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/signin', '/auth']
  }

  /**
   * kimi.ai sets a pile of tracker/preference cookies for ANONYMOUS visitors
   * (observed: theme, _ga, _ga_*, _gcl_au, Hm_lvt_*, Hm_lpvt_*, HMACCOUNT,
   * __cf_bm, intercom-*). Counting those as a "session" made isLoggedIn true
   * for signed-out users and suppressed the login window entirely.
   */
  protected getAnonymousCookieNameRe(): RegExp | null {
    return /^(_ga|_gcl|__cf_bm|_fbp|_uetsid|_uetvid|Hm_|HMACCOUNT|intercom-|theme$|amplitude|mp_)/i
  }

  protected getPageReadyCheck(): string {
    // Usage values hydrate asynchronously as '-' placeholders — so "ready"
    // requires identity markers (membership quota page OR legacy console) AND
    // at least one hydrated percentage. STRONG login shells count as ready too,
    // so extraction can classify them fast instead of burning the ready-budget.
    // A signed-in app shell whose quota panel hasn't rendered yet matches
    // neither branch and keeps polling — never classify it early.
    return `(function(){
      if (document.readyState !== 'complete' || !document.body) return false;
      var t = document.body.innerText || '';
      if (t.length < 40) return false;
      if (new RegExp('${KIMI_LOGIN_MARKER_SRC}', 'i').test(t)) return true;
      if (!/本周用量|频限明细|Weekly usage|Rate limit|Usage Progress|Total usage|My Quota|5-hour usage|7-day usage|Quota reset/i.test(t)) return false;
      return /\\d+(?:\\.\\d+)?\\s*%/.test(t);
    })()`
  }

  /**
   * Chinese-aware signed-in detection. Same predicate as the managed-Chrome
   * loginCompleteExpression — ONE constant, so the (now-vestigial) Electron
   * login-window auto-close and the managed sign-in wait can never drift.
   * Signed-in = a hydrated usage figure (checked FIRST so a stray
   * "登录设备"-style label can't veto), agent/chat counters, or a JWT-ish
   * localStorage token; anonymous = any visible login entry point.
   */
  protected getLoggedInPageCheck(): string {
    return KIMI_LOGIN_COMPLETE_EXPR
  }

  /**
   * Ready-check timeouts: a strong login shell or an identity shell stuck on
   * '-' placeholders is an anonymous session → login_required. A page with
   * NEITHER identity markers NOR strong login markers is a signed-in app shell
   * whose quota panel never rendered in time (anonymous shells always carry
   * strong markers like "Log in to Chat with Kimi") — that is page_not_ready,
   * not a sign-in problem; calling it login_required flapped the card to
   * "Cookies expired" mid-session.
   */
  protected classifyReadyTimeout(pageText: string, finalUrl: string): ScrapeFailureReason {
    if (LOGIN_MARKER_RE.test(pageText)) return 'login_required'
    const hasIdentity = CONSOLE_IDENTITY_RE.test(pageText) || MEMBERSHIP_IDENTITY_RE.test(pageText)
    if (hasIdentity && !HYDRATED_PERCENT_RE.test(pageText)) return 'login_required'
    return super.classifyReadyTimeout(pageText, finalUrl)
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    const quotaUrl = KIMI_QUOTA_URL

    // Soft budget: usageFetcher's warm-up path hard-kills a fetch at 45s
    // (cancelActiveScrape), so the WHOLE scrape — including the optional
    // passes — must fit under it or a perfectly good parse gets cancelled.
    // Warm parked tab (see end of scrape) makes the primary wait ~instant.
    const scrapeStart = Date.now()
    const timeLeft = (): number => Math.max(0, 40_000 - (Date.now() - scrapeStart))

    // ── Primary pass: membership quota page in managed Chrome ──
    let page = await this.evaluateManaged<string>(
      quotaUrl,
      this.getPageReadyCheck(), // identity markers + hydrated %; login shells count as ready
      'document.body ? document.body.innerText : ""',
      { timeoutMs: 30_000, allowNavigate: true }
    )

    if (!page || page.value == null) {
      // Readiness timed out or Chrome is down — distinguish the cases.
      const state = await checkLoginState(KIMI_MANAGED_CHROME, quotaUrl)
      if (!state.currentUrl) {
        this.setLastFailureReason('managed_browser_inactive')
        console.log('[kimi-code] Managed Chrome not running')
        return null
      }

      // Read whatever rendered plus the signed-in probe (hydrated % / agent
      // badge / localStorage JWT — same predicate the sign-in wait uses).
      // "Identity markers without hydrated %" alone CANNOT distinguish the
      // anonymous console shell from a signed-in page whose values are still
      // hydrating — the JWT can (observed live: a signed-in page took >30s to
      // hydrate and was misclassified as login_required, flapping the card).
      let timeoutText = ''
      let signedInProbe = false
      try {
        const snap = await this.evaluateManaged<{ text: string; signedIn: boolean }>(
          quotaUrl,
          'true',
          `({ text: document.body ? document.body.innerText : "", signedIn: ${KIMI_LOGIN_COMPLETE_EXPR} === true })`,
          { timeoutMs: 4_000, allowNavigate: false }
        )
        timeoutText = snap?.value?.text || ''
        signedInProbe = snap?.value?.signedIn === true
      } catch { /* classification falls through */ }

      if (isScraperDebugEnabled() && timeoutText) {
        console.log(`[kimi-code] Timeout body preview (signedInProbe=${signedInProbe}): ${timeoutText.replace(/\s+/g, ' ').slice(0, 600)}`)
      }

      if (!signedInProbe) {
        const reason = this.classifyReadyTimeout(timeoutText, state.currentUrl)
        this.setLastFailureReason(reason)
        console.log(`[kimi-code] Ready check timed out at ${state.currentUrl} — classified as ${reason}`)
        return reason === 'login_required' ? ({ loginRequired: true } as any) : null
      }

      // Signed in, panel just slow — give hydration one more bounded window
      // (within the soft budget so usageFetcher's 45s kill can't race us).
      if (timeLeft() < 6_000) {
        this.setLastFailureReason('page_not_ready')
        console.log('[kimi-code] Signed in but out of budget — page_not_ready')
        return null
      }
      console.log('[kimi-code] Signed in but quota values not hydrated yet — waiting one more round')
      page = await this.evaluateManaged<string>(
        quotaUrl,
        this.getPageReadyCheck(),
        'document.body ? document.body.innerText : ""',
        { timeoutMs: Math.min(12_000, timeLeft() - 2_000), allowNavigate: false }
      )
      if (!page || page.value == null) {
        // Still not hydrated: stale-data error, never a false "Cookies expired".
        this.setLastFailureReason('page_not_ready')
        console.log('[kimi-code] Quota values never hydrated — page_not_ready (signed-in session confirmed)')
        return null
      }
    }

    const text = page.value || ''
    console.log(`[kimi-code] Managed Chrome page loaded: ${page.title} (${page.url}), len=${text.length}`)
    if (isScraperDebugEnabled()) {
      console.log(`[kimi-code] Page text preview: ${text.replace(/\s+/g, ' ').substring(0, 900)}`)
    }

    // ── Classify + parse (exact port of the old extractUsageData branches) ──
    let finalData: any = null

    if (MEMBERSHIP_IDENTITY_RE.test(text)) {
      // A signed-in membership page ALWAYS shows hydrated quota percentages;
      // the anonymous shell renders the layout with '-' placeholders forever.
      if (!HYDRATED_PERCENT_RE.test(text)) {
        this.setLastFailureReason('login_required')
        console.log('[kimi-code] Membership page has no hydrated quota values — anonymous session, login required')
        return { loginRequired: true } as any
      }
      const membershipData = parseKimiMembershipText(text)
      if (!membershipData) {
        this.setLastFailureReason('extract_failed')
        console.log(`[kimi-code] Membership page parse failed. Preview: ${text.replace(/\s+/g, ' ').substring(0, 600)}`)
        return null
      }
      if (membershipData.renewalDate) {
        saveRenewalSnapshot(membershipData.renewalDate, membershipData.renewalKind ?? 'renewing')
      }
      finalData = { ...membershipData, subModels: [...(membershipData.subModels ?? [])] }
    } else if (CONSOLE_IDENTITY_RE.test(text)) {
      // Legacy 本周用量/频限明细 console layout (pre-membership accounts).
      if (!HYDRATED_PERCENT_RE.test(text)) {
        this.setLastFailureReason('login_required')
        console.log('[kimi-code] Console shell has no hydrated usage values — anonymous session, login required')
        return { loginRequired: true } as any
      }
      finalData = this.buildFromLegacyConsole(text) // may be null — badge pass can still salvage
    } else if (LOGIN_MARKER_RE.test(text)) {
      // Marketing/login shell: actionable sign-in state, never extract_failed.
      this.setLastFailureReason('login_required')
      console.log(`[kimi-code] Login shell rendered — treating as login_required. URL: ${page.url}`)
      return { loginRequired: true } as any
    } else {
      // Signed-in app shell whose quota panel hasn't rendered: NOT a sign-in
      // problem — report page_not_ready so last-good data survives instead of
      // flapping the card to "Cookies expired".
      this.setLastFailureReason('page_not_ready')
      console.log(`[kimi-code] Quota panel not rendered (no identity markers, no login shell) — page_not_ready. URL: ${page.url}`)
      return null
    }

    // ── Optional pass: Agent Tokens badge (timeboxed, non-fatal) ──
    let chatTokensLeft: number | null = null
    if (timeLeft() > 8_000) {
      try {
        const agent = await this.evaluateManaged<string>(
          KIMI_AGENT_URL,
          `document.readyState === 'complete' && document.body && (${AGENT_BADGE_RE.toString()}.test(document.body.innerText) || document.body.innerText.length > 400)`,
          'document.body ? document.body.innerText : ""',
          { timeoutMs: Math.min(8_000, timeLeft() - 2_000), allowNavigate: true }
        )
        chatTokensLeft = extractAgentTokensLeft(agent?.value || '')
      } catch (e) {
        console.log('[kimi-code] Agent badge pass skipped (non-fatal):', (e as Error)?.message || e)
      }
    } else {
      console.log('[kimi-code] Skipping Agent Tokens pass — soft budget exhausted')
    }

    if (finalData) {
      if (!finalData.subModels) finalData.subModels = []
      if (chatTokensLeft !== null) {
        // Name MUST stay exactly 'Agent Tokens' — the renderer keys its icon on
        // it and usageNormalizer forces polarity 'remaining' on it.
        finalData.subModels.unshift({ modelName: 'Agent Tokens', count: chatTokensLeft, total: undefined, resetsAt: null })
        console.log(`[kimi-code] Agent Tokens left: ${chatTokensLeft}`)
      }
    } else if (chatTokensLeft !== null) {
      // Legacy console rendered but parsed empty — degrade to a pure counter
      // (no totals -> the renderer draws no progress bars).
      finalData = {
        currentUsage: chatTokensLeft,
        usageLimit: null,
        percentUsed: null,
        usageUnit: 'tokens left',
        resetsAt: null,
        subModels: [{ modelName: 'Agent Tokens', count: chatTokensLeft, total: undefined, resetsAt: null }]
      }
    } else {
      this.setLastFailureReason('extract_failed')
      console.log(`[kimi-code] Both extractions failed. Preview: ${text.replace(/\s+/g, ' ').substring(0, 600)}`)
      return null
    }

    // ── Optional pass: renewal date, 24h-cached (skipped when the page had it) ──
    try {
      if (!finalData.renewalDate) {
        const cached = loadRenewalSnapshot()
        const cacheFresh = cached !== null &&
          (Date.now() - Date.parse(cached.fetchedAt)) < 24 * 60 * 60 * 1000

        if (cacheFresh) {
          finalData.renewalDate = cached!.renewalDate
          finalData.renewalKind = cached!.renewalKind
        } else {
          // Cheapest source first: the quota-page text we already scraped.
          let renewal = parseRenewalDate(text)
          let sourceUrl = 'quota-page'
          if (!renewal) {
            for (const url of KIMI_RENEWAL_URLS) {
              if (timeLeft() < 9_000) break
              try {
                const probe = await this.evaluateManaged<string>(
                  url,
                  `document.readyState === 'complete' && document.body && document.body.innerText.length > 50`,
                  'document.body ? document.body.innerText : ""',
                  { timeoutMs: Math.min(8_000, timeLeft() - 1_000), allowNavigate: true }
                )
                if (isScraperDebugEnabled() && probe?.value) {
                  console.log(`[kimi-code] Renewal page (${url}) preview: ${probe.value.substring(0, 400)}`)
                }
                renewal = probe?.value ? parseRenewalDate(probe.value) : null
                if (renewal) {
                  sourceUrl = url
                  break
                }
              } catch { /* try next */ }
            }
          }

          if (renewal) {
            finalData.renewalDate = renewal.date
            finalData.renewalKind = renewal.kind
            saveRenewalSnapshot(renewal.date, renewal.kind)
            console.log(`[kimi-code] Renewal detected: ${renewal.date} (${renewal.kind}) from ${sourceUrl}`)
          } else {
            // Negative result is cached too, so we don't re-probe every scrape.
            saveRenewalSnapshot(null, null)
            if (cached && cached.renewalDate) {
              // Stale value beats no value.
              finalData.renewalDate = cached.renewalDate
              finalData.renewalKind = cached.renewalKind
            }
          }
        }
      }
    } catch (err) {
      console.error('[kimi-code] Renewal scrape failed (non-fatal):', err)
    }

    // Park the tab back on the quota page (fire-and-forget) so the NEXT poll
    // finds a warm, already-hydrated SPA and its ready check passes instantly —
    // without this, every poll cold-navigates from /agent and re-runs the
    // hydration race that caused the "Cookies expired" flaps.
    void this.evaluateManaged<string>(
      quotaUrl,
      'true',
      '"parked"',
      { timeoutMs: 6_000, allowNavigate: true }
    ).catch(() => { /* best-effort */ })

    this.markScrapeWorked()
    return finalData
  }

  /** Old 本周用量/频限明细 console metrics (STEP 1 of the pre-managed scraper). */
  private buildFromLegacyConsole(consoleText: string): any | null {
    let detectedPlanTier: string | null = null
    const planMatch = consoleText.match(/\b(Free|Moderato|Allegretto|Allegro|Forte|Presto|Vivace)\b/i)
    if (planMatch) {
      detectedPlanTier = planMatch[1]
      if (/Free\s+(?:plan|tier)/i.test(consoleText)) detectedPlanTier = 'Free'
    }

    try {
      const weeklyPct = percentAfter(consoleText, /本周用量|Weekly usage/i)
      const ratePct = percentAfter(consoleText, /频限明细|Rate limit/i)
      if (weeklyPct === null && ratePct === null) return null

      const weeklyResetsAt = resetAfter(consoleText, /本周用量|Weekly usage/i)
      const agentResetsAt = resetAfter(consoleText, /频限明细|Rate limit/i)

      // Truthfulness: never coerce a missing value to 0 — null renders as '—'
      // on the card instead of a fake 0%.
      return {
        currentUsage: ratePct, // Rate limit is a percentage; null when not found
        usageLimit: ratePct !== null ? 100 : null,
        percentUsed: ratePct,
        usageUnit: '% used',
        resetsAt: agentResetsAt,
        weeklyUsage: weeklyPct,
        weeklyLimit: weeklyPct !== null ? 100 : null,
        weeklyResetsAt: weeklyResetsAt,
        detectedPlanTier,
        subModels: []
      }
    } catch (e) {
      console.error('[kimi-code] Error parsing console metrics:', e)
      return null
    }
  }
}
