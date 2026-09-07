import {
  checkLoginState,
  evaluateInManagedChrome,
  type ManagedChromeConfig
} from '../managedChrome'
import { ScrapedUsageData } from './baseScraper'
import { ManagedChromeScraper } from './managedChromeScraper'
import { parseCursorPeriodUsageJson } from './usageTextParsers'
import { fetchCursorUsageFromIde } from './cursorIdeUsage'

export const CURSOR_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'cursor',
  // NOTE: 43211–43215 are taken by chatgpt/claude/minimax/fal-ai/grok.
  port: 43216,
  startUrl: 'https://cursor.com/dashboard',
  loggedInUrlPattern: 'cursor.com/dashboard'
}

const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard'

/**
 * Same Plan & Usage RPC the site uses, run inside managed Chrome so the
 * request carries the cursor.com session. Spending-page DOM is ignored.
 */
export async function fetchCursorUsageFromWeb(): Promise<ScrapedUsageData | null> {
  let page: Awaited<ReturnType<typeof evaluateInManagedChrome<{ api?: unknown; href?: string }>>>
  try {
    page = await evaluateInManagedChrome<{ api?: unknown; href?: string }>(
    CURSOR_MANAGED_CHROME,
    CURSOR_DASHBOARD_URL,
    `document.readyState === 'complete' && !!document.body`,
    `(async () => {
      const tryJson = async (url, init) => {
        try {
          const r = await fetch(url, init);
          if (!r.ok) return null;
          return await r.json();
        } catch (e) { return null; }
      };
      const connect = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        credentials: 'include',
        body: '{}'
      };
      let api = await tryJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', connect);
      if (!api) api = await tryJson('https://cursor.com/api/dashboard/get-current-period-usage', { credentials: 'include' });
      if (!api) api = await tryJson('/api/dashboard/get-current-period-usage', { credentials: 'include' });
      return { api, href: location.href };
    })()`,
    {
      timeoutMs: 45000,
      allowNavigate: true,
      forceReload: true,
      captureUrlIncludes: [
        'GetCurrentPeriodUsage',
        'get-current-period-usage'
      ]
    }
    )
  } catch (err) {
    console.warn(`[cursor] Web Chrome evaluate failed: ${(err as Error).message}`)
    return null
  }

  if (!page || page.value == null) {
    const state = await checkLoginState(CURSOR_MANAGED_CHROME, CURSOR_DASHBOARD_URL)
    if (state.currentUrl && /login|auth|sign-in|signin|workos|authkit/i.test(state.currentUrl)) {
      console.log(`[cursor] Web dashboard bounced to login (${state.currentUrl})`)
      return { loginRequired: true } as ScrapedUsageData
    }
    console.log(`[cursor] Web GetCurrentPeriodUsage missed (url: ${state.currentUrl || 'none'})`)
    return null
  }

  if (page.url && /login|auth|sign-in|signin|workos|authkit/i.test(page.url)) {
    console.log(`[cursor] Web dashboard is a login page (${page.url})`)
    return { loginRequired: true } as ScrapedUsageData
  }

  const blobs: unknown[] = []
  if (page.value.api) blobs.push(page.value.api)
  for (const row of page.capturedResponses ?? []) {
    try { blobs.push(JSON.parse(row.body) as unknown) } catch { /* ignore */ }
  }

  const parsed = blobs.map((blob) => parseCursorPeriodUsageJson(blob)).find((row) => row?.totalPercent != null) ?? null
  if (!parsed || parsed.totalPercent == null) {
    console.log('[cursor] Web session had no planUsage.totalPercentUsed')
    return null
  }

  if (!parsed.renewalKind && parsed.renewalDate) parsed.renewalKind = 'renewing'
  console.log(
    `[cursor] Web API: total=${parsed.totalPercent}%, ` +
    `cursorModels=${parsed.subModels?.find((row) => row.name === 'Cursor Models')?.count}%, ` +
    `otherModels=${parsed.weeklyPercentUsed}%, renewal=${parsed.renewalDate} (${parsed.renewalKind ?? 'none'})`
  )
  return parsed
}

/**
 * Cursor usage from the cursor.com session. Numbers come from
 * GetCurrentPeriodUsage in the page, not spending-page DOM bars.
 */
export class CursorScraper extends ManagedChromeScraper {
  constructor() {
    super('cursor', CURSOR_DASHBOARD_URL, CURSOR_MANAGED_CHROME)
  }

  // Documents the parked-SPA reload policy. The actual evaluate lives in the
  // exported fetchCursorUsageFromWeb() free function, which passes
  // forceReload: true explicitly.
  protected readonly forceReloadOnScrape: boolean = true

  protected isCloudflareProtected(): boolean {
    return true
  }

  protected getExtraCookieDomains(): string[] {
    return ['cursor.com', '.cursor.com', 'cursor.sh', '.workos.com', 'authkit.cursor.com']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/login', '/auth', '/sign-in', '/signin', 'workos.com', 'authkit']
  }

  protected getPageReadyCheck(): string {
    return `document.readyState === 'complete' && !!document.body`
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    const web = await fetchCursorUsageFromWeb()
    if ((web as { loginRequired?: boolean } | null)?.loginRequired) {
      const ideWhileSignedOut = await fetchCursorUsageFromIde()
      if (ideWhileSignedOut?.totalPercent != null) {
        this.markScrapeWorked()
        return Object.assign(ideWhileSignedOut, { cursorFetchSource: 'ide-api' })
      }
      this.setLastFailureReason('login_required')
      return web
    }
    if (web?.totalPercent != null) {
      this.markScrapeWorked()
      return Object.assign(web, { cursorFetchSource: 'web-api' })
    }

    const ide = await fetchCursorUsageFromIde()
    if (ide?.totalPercent != null) {
      this.markScrapeWorked()
      return Object.assign(ide, { cursorFetchSource: 'ide-api' })
    }

    this.setLastFailureReason('extract_failed')
    return null
  }
}
