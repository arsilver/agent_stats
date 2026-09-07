import { ScrapedUsageData, isScraperDebugEnabled, parseRenewalDate } from './baseScraper'
import { type ManagedChromeConfig } from '../managedChrome'
import { ManagedChromeScraper } from './managedChromeScraper'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const FALAI_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'fal-ai',
  port: 43214,
  startUrl: 'https://fal.ai/dashboard/usage-billing',
  loggedInUrlPattern: '/dashboard'
}

// Persistent storage for max balance and topup sum (lazy loaded)
let maxBalanceSeen = 0
let lastKnownTopup = 0
let persistFilePath: string | null = null

function getPersistFilePath(): string {
  if (!persistFilePath) {
    persistFilePath = join(app.getPath('userData'), 'fal-max-balance.json')
  }
  return persistFilePath
}

function loadPersisted(): { maxBalance: number; topupSum: number } {
  try {
    const filePath = getPersistFilePath()
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      return { maxBalance: data.maxBalance || 0, topupSum: data.topupSum || 0 }
    }
  } catch { }
  return { maxBalance: 0, topupSum: 0 }
}

function savePersisted(maxBalance: number, topupSum: number): void {
  try {
    writeFileSync(getPersistFilePath(), JSON.stringify({ maxBalance, topupSum }))
  } catch { }
}

function loadMaxBalance(): number {
  const data = loadPersisted()
  lastKnownTopup = data.topupSum
  return data.maxBalance
}

export class FalAIScraper extends ManagedChromeScraper {
  constructor() {
    super('fal-ai', 'https://fal.ai/dashboard/usage-billing', FALAI_MANAGED_CHROME)
  }

  protected isCloudflareProtected(): boolean {
    return true
  }

  protected getExtraCookieDomains(): string[] {
    return ['fal.ai', '.fal.ai']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/signin', '/auth', '/sign-in']
  }

  protected getPageReadyCheck(): string {
    return `document.readyState === 'complete' && document.body && document.body.innerText.length > 200`
  }

  /**
   * Managed Chrome scrape: bypasses Cloudflare's TLS-fingerprint blocking by
   * driving a real Chrome subprocess via CDP. The page's own fetches to
   * /api/billing/* succeed (real Chrome handshake), so we just read innerText.
   */
  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    if (maxBalanceSeen === 0) {
      maxBalanceSeen = loadMaxBalance()
    }

    // ── PASS 1: credits page → balance + currentUsage ──
    const creditsUrl = 'https://fal.ai/dashboard/usage-billing/credits'
    const creditsReady = `(() => {
      const text = document.body && document.body.innerText || '';
      const m = text.match(/Current credit balance[\\s\\S]{0,80}?\\$\\s*([\\d,.]+)/i);
      return !!(m && parseFloat(m[1].replace(/,/g, '')) >= 0);
    })()`

    const creditsResult = await this.evaluateManaged<{ balance: number; usage: number; pageText: string }>(
      creditsUrl,
      creditsReady,
      `(() => {
        function safeFloat(raw) {
          if (!raw) return 0;
          const c = String(raw).replace(/,/g, '').trim();
          if (/^[-–—]+$/.test(c) || c === '') return 0;
          const v = parseFloat(c);
          return isNaN(v) ? 0 : v;
        }
        function findByText(regex) {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while ((node = w.nextNode())) {
            if (regex.test(node.nodeValue)) return node.parentElement;
          }
          return null;
        }
        let b = 0, u = 0;
        try {
          const balanceLabel = findByText(/Current credit balance/i) || findByText(/Current balance/i);
          const usageLabel = findByText(/Total cost estimate/i) || findByText(/Usage this month/i) || findByText(/Total cost/i);
          if (balanceLabel) {
            const c = balanceLabel.closest('.flex') || balanceLabel.closest('div[class*="grid"]') || balanceLabel.parentElement.parentElement;
            if (c) {
              const m = c.innerText.match(/\\$\\s*([\\d,.]+)/);
              if (m) b = safeFloat(m[1]);
            }
          }
          if (usageLabel) {
            const c = usageLabel.closest('.flex') || usageLabel.closest('div[class*="grid"]') || usageLabel.parentElement.parentElement;
            if (c) {
              const m = c.innerText.match(/\\$\\s*([\\d,.]+)/);
              if (m) u = safeFloat(m[1]);
            }
          }
        } catch (e) {}
        if (b === 0 && u === 0) {
          const text = document.body.innerText || '';
          const amounts = [...text.matchAll(/\\$\\s*([\\d,.]+)/g)].map(m => safeFloat(m[1])).filter(v => v > 0);
          if (text.includes('Current credit balance') && amounts.length >= 1) b = amounts[0];
          if (text.includes('Total cost estimate') && amounts.length >= 2) u = amounts[amounts.length - 1];
        }
        return { balance: b, usage: u, pageText: (document.body.innerText || '').substring(0, 800) };
      })()`,
      { timeoutMs: 25_000, allowNavigate: true }
    )

    if (!creditsResult) {
      this.setLastFailureReason('extract_failed')
      console.log('[fal-ai] Managed Chrome unavailable or no target — needs sign-in')
      return null
    }

    if (creditsResult.title?.includes('Just a moment')) {
      console.log('[fal-ai] Cloudflare challenge — needs sign-in via Open Browser')
      this.setLastFailureReason('cloudflare_blocked')
      return null
    }

    // Path-aware login detection (avoid false positives on URL-encoded redirect params)
    let finalPath = ''
    try {
      finalPath = new URL(creditsResult.url).pathname
    } catch {
      finalPath = creditsResult.url
    }
    if (this.isLoginUrl(finalPath)) {
      console.log(`[fal-ai] Page is on login (${creditsResult.url}) — needs sign-in`)
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    let balance = creditsResult.value?.balance ?? 0
    let currentUsage = creditsResult.value?.usage ?? 0

    if (isScraperDebugEnabled()) {
      console.log(`[fal-ai] Credits page text preview: ${creditsResult.value?.pageText}`)
    }
    console.log(`[fal-ai] Managed Chrome credits: balance=$${balance}, usage=$${currentUsage}`)

    const zeroUsageLooksValid = /Current credit balance|Current balance|Total cost estimate|Usage this month|Total cost/i
      .test(creditsResult.value?.pageText || '')
    if (balance === 0 && currentUsage === 0 && !zeroUsageLooksValid) {
      this.setLastFailureReason('extract_failed')
      console.log('[fal-ai] All extraction strategies returned 0 — preserving last-good cache')
      return null
    }

    // ── PASS 2: invoices → topupSum ──
    let topupSum = 0
    const invoicesResult = await this.evaluateManaged<number>(
      'https://fal.ai/dashboard/usage-billing/invoices',
      `document.readyState === 'complete' && document.body && document.body.innerText.length > 50`,
      `(() => {
        let sum = 0;
        try {
          const text = document.body.innerText || '';
          const matches = text.match(/\\$\\s*([\\d,.]+)/g);
          if (matches) {
            for (const m of matches) {
              const v = parseFloat(m.replace(/[^\\d.]/g, ''));
              if (v > 0) sum += v;
            }
          }
        } catch (e) {}
        return sum;
      })()`,
      { timeoutMs: 12_000, allowNavigate: true }
    )

    if (invoicesResult && typeof invoicesResult.value === 'number' && invoicesResult.value > 0) {
      topupSum = invoicesResult.value
      lastKnownTopup = topupSum
      savePersisted(maxBalanceSeen, topupSum)
      console.log(`[fal-ai] Invoices loaded: topupSum=$${topupSum} (saved)`)
    } else if (lastKnownTopup > 0) {
      topupSum = lastKnownTopup
      console.log(`[fal-ai] Invoices unavailable — using saved topupSum=$${topupSum}`)
    } else {
      topupSum = balance + currentUsage
      console.log(`[fal-ai] No invoice data — estimated topupSum=$${topupSum}`)
    }

    // ── PASS 3: overview → subModels via __NEXT_DATA__ ──
    const overviewResult = await this.evaluateManaged<Array<{ name: string; count: number; total: number }>>(
      'https://fal.ai/dashboard/usage-billing',
      `document.readyState === 'complete' && document.body && document.body.innerText.length > 100`,
      `(() => {
        try {
          const nextData = document.getElementById('__NEXT_DATA__');
          let data = '';
          if (nextData) {
            data = nextData.innerHTML;
          } else {
            for (const s of document.querySelectorAll('script')) data += s.innerHTML + '\\n';
          }
          const merged = {};
          const patterns = [
            /\\{"[^"]*model[^"]*"\\s*:\\s*"([^"]+)"[^}]+(?:cost|total_cost|amount)"\\s*:\\s*([\\d.]+)/gi,
            /"([^"]+)"\\s*:\\s*\\{\\s*"total_cost"\\s*:\\s*([\\d.]+)/gi,
            /"model_name"\\s*:\\s*"([^"]+)"[^}]+(?:cost|total_cost|amount)"\\s*:\\s*([\\d.]+)/gi,
            /"identifier"\\s*:\\s*"([^"]+)"[^}]+(?:cost|total_cost|amount)"\\s*:\\s*([\\d.]+)/gi
          ];
          for (const pat of patterns) {
            const matches = data.matchAll(pat);
            for (const m of matches) {
              const name = m[1];
              const cost = parseFloat(m[2]);
              if ((name.includes('/') || name.includes('fal-ai') || name.includes('flux')) &&
                  name !== 'Others' && name !== 'others' && cost > 0 && cost < 1000) {
                merged[name] = (merged[name] || 0) + cost;
              }
            }
          }
          const total = ${currentUsage > 0 ? currentUsage : 1};
          const out = Object.entries(merged).map(([n, c]) => ({
            name: n.replace('fal-ai-', 'fal-ai/').replace('fal-ai/', ''),
            count: c,
            total
          }));
          out.sort((a, b) => b.count - a.count);
          return out;
        } catch (e) {
          return [];
        }
      })()`,
      { timeoutMs: 12_000, allowNavigate: true }
    )

    const subModels = overviewResult?.value ?? []
    console.log(`[fal-ai] Extracted ${subModels.length} top models`)

    if (topupSum > 0 && balance > 0 && currentUsage === 0) {
      currentUsage = Number((topupSum - balance).toFixed(2))
    }

    let visualLimit = topupSum
    if (currentUsage > 0 && balance >= 0) {
      visualLimit = Number((currentUsage + balance).toFixed(2))
    }
    const percentUsed = visualLimit > 0 ? Math.round((currentUsage / visualLimit) * 100) : 0

    // ── PASS 4: renewal date (best-effort) ──
    let renewalDate: string | null = null
    let renewalKind: 'renewing' | 'cancelled' | null = null
    const renewalUrls = [
      'https://fal.ai/dashboard/settings/billing',
      'https://fal.ai/dashboard/account'
    ]
    for (const url of renewalUrls) {
      const r = await this.evaluateManaged<string>(
        url,
        `document.readyState === 'complete' && document.body && document.body.innerText.length > 50`,
        `document.body ? document.body.innerText : ""`,
        { timeoutMs: 8_000, allowNavigate: true }
      )
      if (r?.value) {
        const renewal = parseRenewalDate(r.value)
        if (renewal) {
          renewalDate = renewal.date
          renewalKind = renewal.kind
          console.log(`[fal-ai] Renewal: ${renewal.date} (${renewal.kind}) from ${url}`)
          break
        }
      }
    }

    return {
      currentUsage,
      usageLimit: visualLimit,
      percentUsed,
      usageUnit: '$ spend',
      resetsAt: null,
      weeklyUsage: null,
      weeklyLimit: null,
      weeklyPercentUsed: null,
      renewalDate,
      renewalKind,
      subModels: subModels.length > 0 ? subModels : undefined
    }
  }

}
