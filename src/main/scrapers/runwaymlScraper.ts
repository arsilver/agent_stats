import { BrowserWindow, app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BaseScraper, ScrapedUsageData, isScraperDebugEnabled, parseRenewalDate } from './baseScraper'

// Persist whatever org UUID Runway redirects us to, so subsequent runs go
// straight there. Stops the scraper from being tied to one user's org.
function getOrgPersistPath(): string {
  return join(app.getPath('userData'), 'runwayml-org.json')
}

function loadPersistedOrgId(): string | null {
  try {
    const path = getOrgPersistPath()
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { orgId?: string }
    if (typeof raw.orgId === 'string' && /^[a-f0-9-]{20,}$/i.test(raw.orgId)) {
      return raw.orgId
    }
  } catch (err) {
    console.log(`[runwayml] Failed to read persisted org id: ${(err as any)?.message || err}`)
  }
  return null
}

function persistOrgId(orgId: string): void {
  try {
    writeFileSync(getOrgPersistPath(), JSON.stringify({ orgId, savedAt: new Date().toISOString() }))
    console.log(`[runwayml] Persisted org id ${orgId}`)
  } catch (err) {
    console.error(`[runwayml] Failed to persist org id: ${(err as any)?.message || err}`)
  }
}

export class RunwayMLScraper extends BaseScraper {
  constructor() {
    // Start at the org-agnostic billing page. Runway will redirect to the
    // user's actual org on its own; we capture that org id in extractUsageData.
    super('runwayml', 'https://app.runwayml.com/account/billing')
  }

  protected getExtraCookieDomains(): string[] {
    return ['runwayml.com', '.runwayml.com', 'dev.runwayml.com', 'app.runwayml.com']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/signin', '/auth', '/sign-in']
  }

  protected getPageReadyCheck(): string {
    // Wait for the page to have some content — usage data may load async
    return `document.readyState === 'complete' && document.body && document.body.innerText.length > 200`
  }

  /**
   * Discover the user's RunwayML organization UUID.
   * Priority: cached on disk → URL after redirect → null (org-agnostic URLs only).
   */
  private getOrgId(currentUrl: string): string | null {
    const inUrl = currentUrl.match(/organization\/([a-f0-9-]{20,})/i)?.[1]
    if (inUrl) return inUrl
    return loadPersistedOrgId()
  }

  private async scrapeRenewal(win: BrowserWindow): Promise<{ date: string; kind: 'renewing' | 'cancelled' } | null> {
    const orgId = this.getOrgId(win.webContents.getURL())
    const urls: string[] = []
    if (orgId) {
      urls.push(
        `https://dev.runwayml.com/organization/${orgId}/billing`,
        `https://dev.runwayml.com/organization/${orgId}/account`
      )
    }
    urls.push(
      'https://app.runwayml.com/account/billing',
      'https://app.runwayml.com/account'
    )

    for (const url of urls) {
      try {
        await win.loadURL(url)
        await new Promise(r => setTimeout(r, 3000))
        const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""')
        if (isScraperDebugEnabled()) {
          console.log(`[runwayml] Renewal page (${url}) preview: ${text.substring(0, 400)}`)
        }
        const renewal = parseRenewalDate(text)
        if (renewal) {
          console.log(`[runwayml] Renewal detected: ${renewal.date} (${renewal.kind}) from ${url}`)
          return renewal
        }
      } catch { /* try next */ }
    }
    return null
  }

  protected async extractUsageData(win: BrowserWindow): Promise<ScrapedUsageData | null> {
    const url = win.webContents.getURL()
    console.log(`[runwayml] Current URL: ${url}`)

    // Capture and persist org id if the redirect already gave us one.
    const newOrgId = url.match(/organization\/([a-f0-9-]{20,})/i)?.[1]
    if (newOrgId && newOrgId !== loadPersistedOrgId()) {
      persistOrgId(newOrgId)
    }

    // Check if redirected to homepage (login required)
    if (url === 'https://dev.runwayml.com/' || url === 'https://dev.runwayml.com'
        || url === 'https://app.runwayml.com/' || url === 'https://app.runwayml.com'
        || url === 'https://runwayml.com/' || url === 'https://runwayml.com') {
      console.log('[runwayml] Redirected to homepage - login required')
      return { loginRequired: true } as any
    }

    // Check if on login page
    if (this.isLoginUrl(url)) {
      console.log('[runwayml] On login page - login required')
      return { loginRequired: true } as any
    }

    // Get page text
    const pageText = await win.webContents.executeJavaScript('document.body.innerText')
    if (isScraperDebugEnabled()) {
      console.log(`[runwayml] Page text preview: ${pageText.substring(0, 800)}`)
    }

    // Check for login indicators
    if (pageText.toLowerCase().includes('log in') || pageText.toLowerCase().includes('sign in')) {
      if (!pageText.includes('Billing') && !pageText.includes('Credits') && !pageText.includes('Usage')) {
        console.log('[runwayml] Login detected from text content')
        return { loginRequired: true } as any
      }
    }

    // Try to also detect a renewal date on the already-loaded billing page first
    let preloadRenewal: { date: string; kind: 'renewing' | 'cancelled' } | null = null
    try {
      const renewal = parseRenewalDate(pageText)
      if (renewal) preloadRenewal = renewal
    } catch { /* non-fatal */ }

    const applyRenewal = async (base: ScrapedUsageData): Promise<ScrapedUsageData> => {
      let renewal = preloadRenewal
      if (!renewal) {
        try {
          renewal = await this.scrapeRenewal(win)
        } catch (err) {
          console.error('[runwayml] Renewal scrape failed (non-fatal):', err)
        }
      }
      if (renewal) {
        base.renewalDate = renewal.date
        base.renewalKind = renewal.kind
      }
      return base
    }

    // Strategy 1: "Current credits" followed by a number (original billing page format)
    const currentCreditsMatch = pageText.match(/Current credits[:\s\n]*([\d,]+)/i)
    if (currentCreditsMatch) {
      const remaining = parseInt(currentCreditsMatch[1].replace(/,/g, ''), 10)
      const total = 1000
      const used = total - remaining
      console.log(`[runwayml] Found current credits: ${remaining} remaining`)
      return applyRenewal({
        detectedPlanTier: 'Subscription',
        currentUsage: used,
        usageLimit: total,
        percentUsed: Math.round((used / total) * 100),
        usageUnit: 'credits',
        resetsAt: null,
        weeklyUsage: null,
        weeklyLimit: null
      })
    }

    // Strategy 2: "Credits purchased" number — falls back to "0 used" because
    // we don't know what fraction has been consumed. Logged so it's visible.
    const purchasedMatch = pageText.match(/Credits purchased[:\s\n]*([\d,]+)/i)
    if (purchasedMatch) {
      const purchased = parseInt(purchasedMatch[1].replace(/,/g, ''), 10)
      console.warn(`[runwayml] Strategy 2 fallback: "Credits purchased" only — usage shown as 0 of ${purchased}`)
      return applyRenewal({
        detectedPlanTier: 'Subscription',
        currentUsage: 0,
        usageLimit: purchased,
        percentUsed: 0,
        usageUnit: 'credits',
        resetsAt: null,
        weeklyUsage: null,
        weeklyLimit: null
      })
    }

    // Strategy 3: Extract "Max monthly credits" from the rate limit table.
    // Same caveat as strategy 2 — no actual used value available.
    const monthlyCreditsMatch = pageText.match(/Max monthly credits[\s\n]*([\d,]+)/i)
    if (monthlyCreditsMatch) {
      const monthlyCredits = parseInt(monthlyCreditsMatch[1].replace(/,/g, ''), 10)
      console.warn(`[runwayml] Strategy 3 fallback: "Max monthly credits" only — usage shown as 0 of ${monthlyCredits}`)
      return applyRenewal({
        detectedPlanTier: 'Subscription',
        currentUsage: 0,
        usageLimit: monthlyCredits,
        percentUsed: 0,
        usageUnit: 'monthly credits',
        resetsAt: null,
        weeklyUsage: null,
        weeklyLimit: null
      })
    }

    // Strategy 4: Extract usage tier info as minimal data
    const tierMatch = pageText.match(/Usage tier\s*(\d+)/i)
    if (tierMatch) {
      const tier = parseInt(tierMatch[1], 10)
      console.warn(`[runwayml] Strategy 4 fallback: only "Usage tier ${tier}" parsed (no credit balance)`)
      return applyRenewal({
        detectedPlanTier: `Tier ${tier}`,
        currentUsage: tier,
        usageLimit: 5, // RunwayML has 5 usage tiers
        percentUsed: Math.round((tier / 5) * 100),
        usageUnit: 'tier',
        resetsAt: null,
        weeklyUsage: null,
        weeklyLimit: null
      })
    }

    // Strategy 5: Try to find credit data via DOM query (not just innerText)
    const domResult = await win.webContents.executeJavaScript(`
      (function() {
        try {
          // Look for elements with credit-related text content
          const allEls = Array.from(document.querySelectorAll('*'));
          for (const el of allEls) {
            const text = (el.textContent || '').trim();
            // Match standalone numbers that could be credit values
            if (/^[\\d,]+$/.test(text)) {
              const parent = el.parentElement;
              const parentText = (parent?.textContent || '').toLowerCase();
              if (parentText.includes('credit') || parentText.includes('balance')) {
                return { credits: parseInt(text.replace(/,/g, ''), 10), context: parentText.substring(0, 100) };
              }
            }
          }
          return null;
        } catch { return null; }
      })()
    `)

    if (domResult && domResult.credits > 0) {
      console.log(`[runwayml] Found credits via DOM: ${domResult.credits} (${domResult.context})`)
      return applyRenewal({
        detectedPlanTier: 'Subscription',
        currentUsage: 0,
        usageLimit: domResult.credits,
        percentUsed: 0,
        usageUnit: 'credits',
        resetsAt: null,
        weeklyUsage: null,
        weeklyLimit: null
      })
    }

    console.log('[runwayml] Could not extract usage data')
    return null
  }
}
