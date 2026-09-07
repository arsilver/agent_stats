import { BrowserWindow, app, session } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { ScrapedUsageData, isScraperDebugEnabled, parseRenewalDate } from './baseScraper'
import { installWebAuthnBlockerInWindow } from '../browserPromptGuards'
import {
  openManagedChromeWindow,
  type ManagedChromeConfig
} from '../managedChrome'
import { ManagedChromeScraper } from './managedChromeScraper'

const MINIMAX_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'minimax',
  port: 43213,
  startUrl: 'https://platform.minimax.io/user-center/payment/token-plan',
  loggedInUrlPattern: '/user-center|/payment'
}

// ─── Persistent last-good weekly snapshot ────────────────────────
// Survives transient scrape failures so the WEEKLY bar doesn't blink to 0%.
interface WeeklySnapshot {
  weeklyUsage: number | null
  weeklyLimit: number | null
  weeklyPercentUsed: number | null
  weeklyResetsAt: string | null
  savedAt: string
}

let weeklyPersistPath: string | null = null
function getWeeklyPersistPath(): string {
  if (!weeklyPersistPath) {
    weeklyPersistPath = join(app.getPath('userData'), 'minimax-weekly-state.json')
  }
  return weeklyPersistPath
}

// Snapshots older than this are treated as absent — a weekly bar parsed many
// hours ago must not be presented as fresh data.
const WEEKLY_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000 // ~6h

function loadWeeklySnapshot(): WeeklySnapshot | null {
  try {
    const p = getWeeklyPersistPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as WeeklySnapshot
    if (typeof data.weeklyPercentUsed !== 'number') return null
    const savedAtMs = Date.parse(data.savedAt)
    if (!Number.isFinite(savedAtMs) || Date.now() - savedAtMs > WEEKLY_SNAPSHOT_MAX_AGE_MS) {
      console.log(`[minimax] Weekly snapshot on disk is stale (saved ${data.savedAt}) — ignoring`)
      return null
    }
    return data
  } catch {
    return null
  }
}

function saveWeeklySnapshot(snap: Omit<WeeklySnapshot, 'savedAt'>): void {
  try {
    writeFileSync(getWeeklyPersistPath(), JSON.stringify({ ...snap, savedAt: new Date().toISOString() }))
  } catch (err) {
    console.error('[minimax] Failed to persist weekly snapshot:', err)
  }
}

// Managed-Chrome weekly-tab flow. Finds the "Text Generation" card, snapshots
// its default 5-hour text, clicks the "Weekly" tab, re-reads the card, then
// restores the 5-hour tab. Returns both card texts so the caller can detect a
// no-op click.
const MINIMAX_WEEKLY_CARD_SCRIPT = `
  (async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    function tagCards() {
      const targets = [
        { regex: /^Text\\s*Generation$/i, key: 'textGeneration' },
        { regex: /^image-?01$/i, key: 'image01' }
      ];
      const out = {};
      const candidates = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="Title"], [class*="header"], [class*="Header"], div, span');
      for (const el of candidates) {
        const txt = (el.textContent || '').trim();
        if (txt.length === 0 || txt.length > 60) continue;
        for (const { regex, key } of targets) {
          if (out[key]) continue;
          if (!regex.test(txt)) continue;
          let node = el;
          for (let depth = 0; depth < 12 && node; depth++) {
            const t = (node.textContent || '');
            if (/\\d+\\s*\\/\\s*\\d+/.test(t) && /(Used|Resets?|Time Range)/i.test(t)) {
              if (!node.dataset || node.tagName === 'BODY' || node.tagName === 'HTML') break;
              node.dataset.minimaxKey = key;
              out[key] = { text: t, title: txt };
              break;
            }
            node = node.parentElement;
          }
        }
      }
      return out;
    }
    function clickTab(cardKey, pattern) {
      const card = document.querySelector('[data-minimax-key=' + JSON.stringify(cardKey) + ']');
      if (!card) return false;
      const tabs = card.querySelectorAll('button, [role="tab"], [class*="tab"], [class*="Tab"]');
      for (const t of tabs) {
        const lbl = (t.textContent || '').trim();
        if (pattern.test(lbl)) { t.click(); return true; }
      }
      return false;
    }
    const cards = tagCards();
    if (!cards.textGeneration) return null;
    const fiveHour = cards.textGeneration.text;
    if (!clickTab('textGeneration', /^\\s*Weekly\\s*$/i)) return null;
    await sleep(1500);
    const updated = tagCards();
    const weekly = updated.textGeneration ? updated.textGeneration.text : null;
    // Restore the default 5-hour tab so subsequent passes stay consistent.
    clickTab('textGeneration', /^\\s*5\\s*Hour/i);
    return { fiveHour, weekly };
  })()
`

export class MiniMaxScraper extends ManagedChromeScraper {
  constructor() {
    super('minimax', 'https://platform.minimax.io/user-center/payment/token-plan', MINIMAX_MANAGED_CHROME)
  }

  protected isCloudflareProtected(): boolean {
    return true
  }

  async openLoginWindow(): Promise<void> {
    try {
      await openManagedChromeWindow(MINIMAX_MANAGED_CHROME, this.dashboardUrl)
      console.log('[minimax] openLoginWindow: managed Chrome launched')
      return
    } catch (err) {
      console.error('[minimax] openLoginWindow: managed Chrome failed, falling back to Electron BrowserWindow:', err)
      // Fall through to BrowserWindow path so the user always gets *some* window.
    }

    await this.openLoginWindowFallback(this.dashboardUrl)
  }

  /**
   * Last-resort sign-in path used only when the managed-Chrome subprocess can't
   * launch (Chrome missing, port locked, etc.). Opens a regular Electron
   * BrowserWindow against the same persisted partition so cookies persist.
   * Note: this won't bypass Cloudflare TLS fingerprinting; if MiniMax demands
   * real Chrome, the user will get a Cloudflare challenge here. That's still
   * better UX than a "reconnect did nothing" silent failure.
   */
  private async openLoginWindowFallback(loadUrl: string): Promise<void> {
    const partition = this.getPartition()
    const ses = session.fromPartition(partition)
    const ua = ses.getUserAgent().replace(/\s*Electron\/\S+/, '')
    ses.setUserAgent(ua)

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'Login — MiniMax (fallback)',
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false }
      })
      void (async () => {
        await installWebAuthnBlockerInWindow(win, 'minimax-fallback-login')
        await win.loadURL(loadUrl)
      })().catch((err) => {
        console.error('[minimax] Fallback login window failed to load:', err)
      })

      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) {
          console.log('[minimax] Fallback login window timed out after 10 minutes')
          win.destroy()
        }
      }, 10 * 60 * 1000)

      win.on('closed', async () => {
        clearTimeout(timeout)
        try {
          await ses.cookies.flushStore()
        } catch (err) {
          console.error('[minimax] Cookie flush after fallback login failed:', err)
        }
        resolve()
      })
    })
  }

  protected getExtraCookieDomains(): string[] {
    return ['minimax.io', '.minimax.io', 'agent.minimax.io', 'platform.minimax.io', 'minimax.chat', '.minimax.chat', 'minimaxi.com', '.minimaxi.com', 'hailuoai.com', '.hailuoai.com', 'hailuoai.video', '.hailuoai.video']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/signin', '/auth']
  }

  protected getPageReadyCheck(): string {
    return `document.readyState === 'complete' && document.body && document.body.innerText.length > 50`
  }

  /**
   * Managed Chrome scrape. Uses real Chrome subprocess via CDP to bypass any
   * Cloudflare TLS-fingerprint blocking and to render the SPA fully before
   * reading text. Primary path extracts the new "Available usage: X model
   * requests / Y hours" format.
   */
  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    // Wait until the SPA has rendered actual quota text — not just navigation chrome.
    const readyCheck = `(() => {
      const text = document.body && document.body.innerText || '';
      // Either the new "Available usage: ..." line OR the legacy "% Used" card text.
      return /Available\\s+usage[:\\s]+\\d/i.test(text) || /\\d+\\s*\\/\\s*\\d+\\s*\\n?\\s*\\d+\\s*%\\s*Used/i.test(text);
    })()`

    const tokenPlan = await this.evaluateManaged<string>(
      'https://platform.minimax.io/user-center/payment/token-plan',
      readyCheck,
      `document.body ? document.body.innerText : ""`,
      { timeoutMs: 25_000, allowNavigate: true }
    )

    if (!tokenPlan) {
      this.setLastFailureReason('extract_failed')
      console.log('[minimax] Managed Chrome unavailable or no target — needs sign-in')
      return null
    }

    if (tokenPlan.title?.includes('Just a moment')) {
      console.log('[minimax] Cloudflare challenge — needs sign-in via Open Browser')
      this.setLastFailureReason('cloudflare_blocked')
      return null
    }

    // URL-aware login detection: parse the path so URL-encoded redirect params
    // like "?redirect=%2Fuser-center%2F..." don't fool a substring check.
    const finalUrl = tokenPlan.url
    let finalPath = ''
    try {
      finalPath = new URL(finalUrl).pathname
    } catch {
      finalPath = finalUrl
    }
    const isOnLogin = this.isLoginUrl(finalPath) || finalPath === '/' || finalPath === ''
    const isOnDashboard = finalPath.includes('user-center') || finalPath.includes('payment') || finalPath.includes('token-plan')
    if (isOnLogin || !isOnDashboard) {
      console.log(`[minimax] Page is on login/redirect (${finalUrl}) — needs sign-in`)
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    const fullPageText = tokenPlan.value || ''
    if (isScraperDebugEnabled()) {
      console.log(`[minimax] Token plan page text:\n${fullPageText.substring(0, 1500)}`)
    }

    const tierFromHeader = this.parsePlanTierFromHeader(fullPageText)
    const tierMatch = fullPageText.match(/\b(Free|Basic|Personal|Standard|Plus|Pro|Enterprise)\b/i)
    const detectedPlanTier = tierFromHeader || (tierMatch ? tierMatch[1] : 'Plus')

    let result: ScrapedUsageData | null = null

    // ── PRIMARY: new "Available usage: X model requests / Y hours" format ──
    const availUsage = this.parseAvailableUsage(fullPageText)
    if (availUsage) {
      // windowHours/windowMinutes is the LENGTH of the rolling window, NOT the
      // time until reset — deriving resetsAt from it would fabricate a
      // timestamp. resetsAt must be an absolute future time, so only a real
      // "Resets in ..." hint on the page qualifies (null otherwise).
      const resetsAt = this.parseResetTimestamp(fullPageText)
      console.log(
        `[minimax] Available usage: ${availUsage.remaining} ${availUsage.unit} ` +
        `/ ${availUsage.windowHours}h${availUsage.windowMinutes ? ` ${availUsage.windowMinutes}m` : ''}`
      )
      result = {
        currentUsage: availUsage.remaining,
        usageLimit: null,
        percentUsed: null,
        usageUnit: availUsage.unit,
        resetsAt,
        weeklyUsage: null,
        weeklyLimit: null,
        weeklyPercentUsed: null,
        weeklyResetsAt: null,
        isRemainingTracker: true,
        detectedPlanTier
      }
    }

    // ── FALLBACK: legacy "5/100 5% Used" pattern via flat text ──
    if (!result) {
      const legacy = this.parseCardUsage(fullPageText)
      if (legacy) {
        console.log(`[minimax] Legacy 5-hour parse: ${legacy.current}/${legacy.limit} (${legacy.percent}%)`)
        result = {
          currentUsage: legacy.current,
          usageLimit: legacy.limit,
          percentUsed: legacy.percent,
          usageUnit: 'tokens',
          resetsAt: this.parseResetTimestamp(fullPageText),
          weeklyUsage: null,
          weeklyLimit: null,
          weeklyPercentUsed: null,
          weeklyResetsAt: null,
          detectedPlanTier
        }
      }
    }

    if (!result) {
      this.setLastFailureReason('extract_failed')
      console.log('[minimax] Neither new "Available usage" nor legacy "% Used" pattern matched')
      return null
    }

    // ── Weekly bucket: click the Weekly tab on the Text Generation card ──
    // Weekly tokens refresh live in managed Chrome via MINIMAX_WEEKLY_CARD_SCRIPT.
    try {
      const weeklyCard = await this.evaluateManaged<{ fiveHour: string | null; weekly: string | null } | null>(
        'https://platform.minimax.io/user-center/payment/token-plan',
        readyCheck,
        MINIMAX_WEEKLY_CARD_SCRIPT,
        { timeoutMs: 20_000, allowNavigate: true }
      )
      const payload = weeklyCard?.value
      if (payload?.weekly) {
        const wk = this.parseCardUsage(payload.weekly)
        const fh = payload.fiveHour ? this.parseCardUsage(payload.fiveHour) : null
        // Sanity: if weekly numbers are identical to the 5-hour card, the tab
        // click was a no-op — leave weekly null so the snapshot fallback kicks in.
        const sameAsFiveHour = wk && fh && wk.current === fh.current && wk.limit === fh.limit
        if (wk && !sameAsFiveHour) {
          console.log(`[minimax] Weekly tokens (managed): ${wk.current}/${wk.limit} (${wk.percent}%)`)
          result.weeklyUsage = wk.current
          result.weeklyLimit = wk.limit
          result.weeklyPercentUsed = wk.percent
          result.weeklyResetsAt = this.parseResetTimestamp(payload.weekly)
        } else if (sameAsFiveHour) {
          console.log('[minimax] Weekly numbers identical to 5-hour — tab click likely failed, ignoring')
        } else {
          console.log(`[minimax] Weekly parse failed — card text: ${payload.weekly.substring(0, 240)}`)
        }
      } else {
        console.log('[minimax] Weekly tab not found on Text Generation card in managed Chrome')
      }
    } catch (err) {
      console.error('[minimax] Weekly tab scrape failed (non-fatal):', err)
    }

    // ── Restore last-good weekly snapshot if we don't have fresh weekly data ──
    if (result.weeklyPercentUsed == null) {
      const snap = loadWeeklySnapshot()
      if (snap && snap.weeklyPercentUsed != null) {
        console.log(`[minimax] Restoring last-good weekly snapshot from disk (saved ${snap.savedAt})`)
        result.weeklyUsage = snap.weeklyUsage
        result.weeklyLimit = snap.weeklyLimit
        result.weeklyPercentUsed = snap.weeklyPercentUsed
        result.weeklyResetsAt = snap.weeklyResetsAt
      }
    } else {
      saveWeeklySnapshot({
        weeklyUsage: result.weeklyUsage,
        weeklyLimit: result.weeklyLimit,
        weeklyPercentUsed: result.weeklyPercentUsed,
        weeklyResetsAt: result.weeklyResetsAt ?? null
      })
    }

    // ── Renewal date from billing page (best-effort) ──
    const subModels: NonNullable<ScrapedUsageData['subModels']> = [...(result.subModels ?? [])]

    const hailuo = await this.evaluateManaged<string>(
      'https://hailuoai.video/subscribe',
      `document.readyState === 'complete' && document.body && document.body.innerText.length > 50`,
      `document.body ? document.body.innerText : ""`,
      { timeoutMs: 10_000, allowNavigate: true }
    )
    if (hailuo?.value) {
      const hailuoText = hailuo.value
      const signedOut = /sign\s*in|log\s*in|continue with/i.test(hailuoText) &&
        !/credits?\s+remaining|membership|top-up/i.test(hailuoText)
      if (!signedOut) {
        const creditsMatch = hailuoText.match(/(?:Credits\s*Remaining)\s*[\n\r]*\s*([\d,]+)/i) ||
          hailuoText.match(/([\d,]+)\s*[\n\r]*\s*Credits\s*Remaining/i)
        const membershipMatch = hailuoText.match(/Membership:\s*([\d,]+)/i)
        const topupMatch = hailuoText.match(/Top-up:\s*([\d,]+)/i)
        const bonusMatch = hailuoText.match(/Bonus:\s*([\d,]+)/i)
        const totalCredits = creditsMatch ? parseInt(creditsMatch[1].replace(/,/g, ''), 10) : 0
        const membershipCredits = membershipMatch ? parseInt(membershipMatch[1].replace(/,/g, ''), 10) : 0
        const topupCredits = topupMatch ? parseInt(topupMatch[1].replace(/,/g, ''), 10) : 0
        const bonusCredits = bonusMatch ? parseInt(bonusMatch[1].replace(/,/g, ''), 10) : 0
        const remaining = totalCredits || (membershipCredits + topupCredits + bonusCredits)
        if (remaining > 0) {
          console.log(`[minimax] Hailuo credits: ${remaining}`)
          subModels.push({ name: 'Hailuo Credits', count: remaining, total: undefined })
        }
      }
    }

    const agent = await this.evaluateManaged<{
      balance: number
      membership: number
      valueAdded: number
      bonus: number
      debt: number
      loginRequired: boolean
    }>(
      'https://agent.minimax.io/',
      `document.readyState === 'complete' && document.body && document.body.innerText.length > 30`,
      `(async () => {
        const text = document.body ? document.body.innerText : '';
        const loginRequired = /sign\\s*in|log\\s*in|continue with/i.test(text) && !/credits?|balance/i.test(text);
        let balance = 0, membership = 0, valueAdded = 0, bonus = 0, debt = 0;
        if (!loginRequired) {
          const endpoints = [
            '/api/v1/user/credit', '/api/v1/credit/balance', '/api/v1/wallet/balance',
            '/api/v1/credit/spending', '/api/v1/credit/history',
            '/api/v1/billing/credit', '/api/v1/member/info'
          ];
          for (const ep of endpoints) {
            try {
              const resp = await fetch(ep, { credentials: 'include' });
              if (!resp.ok) continue;
              const json = await resp.json().catch(() => null);
              const data = json && (json.data || json.result || json);
              if (!data || typeof data !== 'object') continue;
              const bal = data.credit ?? data.credits ?? data.balance ?? 0;
              if (typeof bal === 'number' && bal > balance) balance = bal;
              if (typeof data.membership === 'number') membership = data.membership;
              if (typeof data.value_added === 'number') valueAdded = data.value_added;
              if (typeof data.bonus === 'number') bonus = data.bonus;
              if (typeof data.debt === 'number') debt = data.debt;
            } catch {}
          }
          if (balance === 0) {
            const patterns = [
              /Credits\\s*\\n?\\s*(?:\\u24C2|\\(M\\))?\\s*([\\d,]+)/i,
              /Balance\\s*\\n?\\s*(?:Membership)?\\s*([\\d,]+)/i
            ];
            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match) {
                const parsed = parseInt(match[1].replace(/,/g, ''), 10);
                if (parsed > 0) { balance = parsed; break; }
              }
            }
          }
          if (balance === 0 && membership > 0) balance = membership + valueAdded + bonus - debt;
        }
        return { balance, membership, valueAdded, bonus, debt, loginRequired };
      })()`,
      { timeoutMs: 12_000, allowNavigate: true }
    )
    if (agent?.value && !agent.value.loginRequired && agent.value.balance > 0) {
      console.log(`[minimax] Agent credits: balance=${agent.value.balance}`)
      result.agentCredits = {
        balance: agent.value.balance,
        membership: agent.value.membership,
        valueAdded: agent.value.valueAdded,
        bonus: agent.value.bonus,
        debt: agent.value.debt,
        dailyFree: 0,
        spendingHistory: []
      }
    }

    const billing = await this.evaluateManaged<string>(
      'https://platform.minimax.io/user-center/payment/manage-subscription',
      `document.readyState === 'complete' && document.body && document.body.innerText.length > 100`,
      `document.body ? document.body.innerText : ""`,
      { timeoutMs: 8_000, allowNavigate: true }
    )
    if (billing?.value) {
      const renewal = parseRenewalDate(billing.value)
      if (renewal) {
        result.renewalDate = renewal.date
        result.renewalKind = renewal.kind
        console.log(`[minimax] Renewal: ${renewal.date} (${renewal.kind})`)
      }
    }

    if (subModels.length > 0) {
      result.subModels = subModels
    }

    return result
  }

  // ─── Helpers ───────────────────────────────────────────────

  private parseResetTimestamp(text: string): string | null {
    const dayMatch = text.match(/Resets?\s+in\s+(\d+)\s*day/i)
    if (dayMatch) {
      return new Date(Date.now() + parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000).toISOString()
    }
    const hrMin = text.match(/Resets?\s+in\s+(\d+)\s*hr\s+(\d+)\s*min/i)
    if (hrMin) {
      const ms = (parseInt(hrMin[1], 10) * 60 + parseInt(hrMin[2], 10)) * 60 * 1000
      return new Date(Date.now() + ms).toISOString()
    }
    const hr = text.match(/Resets?\s+in\s+(\d+)\s*hour/i)
    if (hr) {
      return new Date(Date.now() + parseInt(hr[1], 10) * 60 * 60 * 1000).toISOString()
    }
    const min = text.match(/Resets?\s+in\s+(\d+)\s*min/i)
    if (min) {
      return new Date(Date.now() + parseInt(min[1], 10) * 60 * 1000).toISOString()
    }
    return null
  }

  // Strict per-card extraction anchored to "% Used". The tight digit length
  // (max 7 chars) and "Used" anchor stop date strings like "2026/04/25 - 04/26"
  // from being misread as "current/limit".
  private parseCardUsage(cardText: string): { current: number; limit: number; percent: number } | null {
    const strict = cardText.match(/(\d[\d,]{0,6})\s*\/\s*(\d[\d,]{0,6})\s*\n?\s*(\d+)\s*%\s*Used/i)
    if (strict) {
      const current = parseInt(strict[1].replace(/,/g, ''), 10)
      const limit = parseInt(strict[2].replace(/,/g, ''), 10)
      const percent = parseInt(strict[3], 10)
      if (limit > 0 && current >= 0 && current <= limit * 1.05) {
        return { current, limit, percent }
      }
    }
    const loose = cardText.match(/(\d[\d,]{0,6})\s*\/\s*(\d[\d,]{0,6})[\s\S]{0,80}?(\d+)\s*%\s*Used/i)
    if (loose) {
      const current = parseInt(loose[1].replace(/,/g, ''), 10)
      const limit = parseInt(loose[2].replace(/,/g, ''), 10)
      const percent = parseInt(loose[3], 10)
      const computed = limit > 0 ? Math.round((current / limit) * 100) : -1
      if (limit > 0 && Math.abs(computed - percent) <= 5) {
        return { current, limit, percent }
      }
    }
    return null
  }

  // Parse the new "Available usage: 4500 model requests / 5 hours" format that
  // replaced the old per-card "5/100 / 5% Used" layout. The first number is
  // REMAINING quota (decreases as you use), the second is the rolling reset
  // window. Returns null if the pattern is absent.
  private parseAvailableUsage(text: string): {
    remaining: number
    unit: string
    windowHours: number
    windowMinutes: number
  } | null {
    const m = text.match(
      /Available\s+usage[:\s]+([\d,]+)\s+([a-z][\w\s-]{0,30}?)\s*\/\s*(\d+)\s*hours?(?:\s+(\d+)\s*min)?/i
    )
    if (m) {
      const remaining = parseInt(m[1].replace(/,/g, ''), 10)
      if (Number.isFinite(remaining) && remaining >= 0) {
        return {
          remaining,
          unit: m[2].trim().toLowerCase(),
          windowHours: parseInt(m[3], 10),
          windowMinutes: m[4] ? parseInt(m[4], 10) : 0
        }
      }
    }
    // Fallback: minutes-only window
    const m2 = text.match(
      /Available\s+usage[:\s]+([\d,]+)\s+([a-z][\w\s-]{0,30}?)\s*\/\s*(\d+)\s*min/i
    )
    if (m2) {
      const remaining = parseInt(m2[1].replace(/,/g, ''), 10)
      if (Number.isFinite(remaining) && remaining >= 0) {
        return {
          remaining,
          unit: m2[2].trim().toLowerCase(),
          windowHours: 0,
          windowMinutes: parseInt(m2[3], 10)
        }
      }
    }
    return null
  }

  // "Plus – High-Speed", "Pro – Standard" → "Plus", "Pro"
  private parsePlanTierFromHeader(text: string): string | null {
    const m = text.match(/\b(Free|Basic|Personal|Standard|Plus|Pro|Enterprise)\b\s*[–\-—]/i)
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null
  }
}
