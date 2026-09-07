import { BrowserWindow } from 'electron'
import {
  checkLoginState,
  evaluateInManagedChrome,
  openManagedChromeWindow,
  type ManagedChromeConfig
} from '../managedChrome'
import { BaseScraper, ScrapedUsageData } from './baseScraper'

// ─── Shared in-page helpers ──────────────────────────────────
// Verbatim-identical copies of these lived inside several scrapers' page-script
// strings. Page scripts embed them via ${...} interpolation, so the emitted
// JavaScript keeps the same behavior. (The clickTab/tryJson copies have drifted
// per service — different length caps, extra params — and deliberately stay
// local to their scrapers.)

/**
 * innerText-first page-text reader with a textContent fallback (managed Chrome
 * can leave innerText empty right after hydration). Same behavior as the copies
 * that were inlined in the chatgpt/grok page scripts.
 */
export const MANAGED_PAGE_BODY_TEXT_FN = `const bodyText = () => {
  const b = document.body;
  if (!b) return '';
  const it = (b.innerText || '').trim();
  return it.length > 80 ? (b.innerText || '') : (b.textContent || b.innerText || '');
};`

// ─── Managed-Chrome evaluate plumbing ────────────────────────
// ManagedChromeEvaluateOptions / EvaluationResult are not exported from
// managedChrome.ts; these structural mirrors keep this module decoupled from
// its internals (assignment is structural, so calls typecheck unchanged).
export interface ManagedEvaluateOptions {
  timeoutMs?: number
  allowLaunch?: boolean
  allowTargetOpen?: boolean
  allowNavigate?: boolean
  forceReload?: boolean
  captureUrlIncludes?: string[]
}

export interface ManagedPageResult<T> {
  url: string
  title: string
  value: T | null
  capturedResponses?: { url: string; body: string }[]
}

/** Reasons classifyManagedNullResult can set (the standard managed-Chrome miss mapping). */
export type ManagedNullResultReason = 'login_required' | 'managed_browser_inactive' | 'page_not_ready'

/**
 * Base for scrapers that drive a managed (real Chrome, CDP-controlled) browser
 * session instead of a hidden Electron BrowserWindow.
 *
 * Owns the boilerplate every managed scraper used to copy-paste:
 *  - managed-session flags (usesManagedBrowserSession / requiresExternalBrowserLogin)
 *  - getManagedChromeConfig() served from a constructor-supplied ManagedChromeConfig
 *  - isLoggedIn() → true (the session lives in the Chrome profile, not the
 *    Electron partition; usageFetcher skips the isLoggedIn gate for managed
 *    scrapers anyway, and the page evaluation itself classifies sign-in state)
 *  - openLoginWindow() → openManagedChromeWindow(config, dashboardUrl)
 *  - a null extractUsageData stub (scrape() is overridden wholesale)
 *
 * Subclasses still override scrape() entirely and keep their service-specific
 * ready checks, cookie domains, login-URL patterns and failure classification.
 */
export abstract class ManagedChromeScraper extends BaseScraper {
  protected readonly managedConfig: ManagedChromeConfig

  /**
   * Reload floor for evaluateManaged: when true, every evaluateManaged call
   * reloads the tab even when it is already on the URL (parked-SPA defense).
   * A per-call `forceReload: true` wins too — the flag raises the floor, never
   * lowers it. Calls that must NOT reload (e.g. secondary renewal probes) call
   * evaluateInManagedChrome directly instead of evaluateManaged.
   */
  protected readonly forceReloadOnScrape: boolean = false

  constructor(serviceId: string, dashboardUrl: string, managedConfig: ManagedChromeConfig) {
    super(serviceId, dashboardUrl)
    this.managedConfig = managedConfig
  }

  public usesManagedBrowserSession(): boolean {
    return true
  }

  // Sign-in is openLoginWindow() into this scraper's own managed Chrome
  // profile, never a system-browser cookie import — Reconnect must not route
  // to the no-op cookie-import stub (tests/managed-session-login-smoke.js).
  public requiresExternalBrowserLogin(): boolean {
    return false
  }

  public getManagedChromeConfig(): ManagedChromeConfig {
    return this.managedConfig
  }

  async isLoggedIn(): Promise<boolean> {
    // Cookies live in the managed Chrome profile, not the Electron partition.
    // Let the actual page evaluation decide if we are logged in.
    return true
  }

  async openLoginWindow(): Promise<void> {
    await openManagedChromeWindow(this.managedConfig, this.dashboardUrl)
  }

  /**
   * evaluateInManagedChrome bound to this scraper's config, with the class
   * reload floor merged in (`forceReloadOnScrape || options.forceReload`).
   */
  protected async evaluateManaged<T>(
    url: string,
    readyCheckExpression: string,
    evaluationExpression: string,
    options?: ManagedEvaluateOptions
  ): Promise<ManagedPageResult<T> | null> {
    return evaluateInManagedChrome<T>(this.managedConfig, url, readyCheckExpression, evaluationExpression, {
      ...options,
      forceReload: this.forceReloadOnScrape || options?.forceReload
    })
  }

  /**
   * Standard classification when evaluateManaged returned null / no value:
   * probes checkLoginState once and maps to the usual reasons —
   *   no reachable tab        → managed_browser_inactive
   *   landed on a login page  → login_required (only with loginUrlIsLoginRequired)
   *   anything else           → page_not_ready
   * Logs the same lines the per-scraper copies did.
   */
  protected async classifyManagedNullResult(
    url: string,
    options?: { loginUrlIsLoginRequired?: boolean }
  ): Promise<{ reason: ManagedNullResultReason; currentUrl: string }> {
    const state = await checkLoginState(this.managedConfig, url)
    const reason: ManagedNullResultReason = !state.currentUrl
      ? 'managed_browser_inactive'
      : options?.loginUrlIsLoginRequired && this.isLoginUrl(state.currentUrl)
        ? 'login_required'
        : 'page_not_ready'
    this.setLastFailureReason(reason)
    if (reason === 'login_required') {
      console.log(`[${this.serviceId}] Dashboard bounced to login (${state.currentUrl})`)
    } else {
      console.log(
        `[${this.serviceId}] Managed Chrome unavailable or page never became ready (url: ${state.currentUrl || 'none'})`
      )
    }
    return { reason, currentUrl: state.currentUrl }
  }

  // Managed-Chrome scrapers override scrape() wholesale; the hidden-window
  // extraction path is unused. A scraper with a working hidden-window parse
  // (claude) keeps its own override.
  protected async extractUsageData(_win: BrowserWindow): Promise<ScrapedUsageData | null> {
    return null
  }
}
