import { BrowserWindow } from 'electron'
import { BaseScraper, ScrapedUsageData, isScraperDebugEnabled } from './baseScraper'
import { parseHiggsfieldUsageText } from './usageTextParsers'

/**
 * Higgsfield scraper.
 *
 * Uses the user's own authenticated web session and only reads visible
 * profile/billing text for credits, plan, and renewal hints.
 */
export class HiggsfieldScraper extends BaseScraper {
  constructor() {
    super('higgsfield', 'https://higgsfield.ai/profile')
  }

  protected getExtraCookieDomains(): string[] {
    return ['higgsfield.ai', '.higgsfield.ai', 'www.higgsfield.ai']
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/auth', '/login', '/signin', '/sign-in', 'accounts.google.com', 'clerk']
  }

  protected isLoginUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase()
    return (
      lowerUrl.includes('/auth') ||
      lowerUrl.includes('/login') ||
      lowerUrl.includes('/signin') ||
      lowerUrl.includes('/sign-in') ||
      lowerUrl.includes('accounts.google.com') ||
      lowerUrl.includes('clerk')
    )
  }

  protected getPageReadyCheck(): string {
    return `document.readyState === 'complete' && document.body && document.body.innerText.length > 100 && /higgsfield|credits?|profile|billing|account|sign\\s*in/i.test(document.body.innerText)`
  }

  protected async extractUsageData(win: BrowserWindow): Promise<ScrapedUsageData | null> {
    const url = win.webContents.getURL()
    console.log(`[higgsfield] Current URL: ${url}`)

    if (this.isLoginUrl(url)) {
      console.log('[higgsfield] On login page - login required')
      return { loginRequired: true } as any
    }

    await this.dismissPromos(win)

    const firstText: string = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""'
    )

    const firstResult = this.parseOrClassify(firstText)
    if (firstResult) return firstResult

    const menuText = await this.openAccountMenuAndReadText(win)
    if (menuText) {
      const menuResult = this.parseOrClassify(menuText)
      if (menuResult) return menuResult
    }

    const candidateUrls = [
      'https://higgsfield.ai/profile',
      'https://higgsfield.ai/account',
      'https://higgsfield.ai/billing'
    ]

    for (const candidateUrl of candidateUrls) {
      if (win.isDestroyed()) return null
      if (win.webContents.getURL().startsWith(candidateUrl)) continue

      try {
        await win.loadURL(candidateUrl)
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await this.dismissPromos(win)
        const text: string = await win.webContents.executeJavaScript(
          'document.body ? document.body.innerText : ""'
        )
        const result = this.parseOrClassify(text)
        if (result) return result

        const candidateMenuText = await this.openAccountMenuAndReadText(win)
        if (candidateMenuText) {
          const candidateMenuResult = this.parseOrClassify(candidateMenuText)
          if (candidateMenuResult) return candidateMenuResult
        }
      } catch (err: any) {
        console.log(`[higgsfield] Optional page skipped (${candidateUrl}): ${err?.message || err}`)
      }
    }

    this.importError = 'Signed in, but Higgsfield credits were not visible. Open the account menu in Higgsfield, then click Refresh.'
    this.setLastFailureReason('extract_failed')
    const finalPreview = firstText.replace(/\s+/g, ' ').substring(0, 800)
    console.log(`[higgsfield] All candidate pages failed. First page preview: ${finalPreview}`)
    return null
  }

  private async dismissPromos(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return

    try {
      await win.webContents.executeJavaScript(`
        (function() {
          const blockedAction = /\\b(buy|get|upgrade|claim\\s+discount|top[-\\s]?up|boost|start\\s+creating|create)\\b/i;
          const closeIntent = /^(close|dismiss|not now|no thanks|x|×)$/i;
          const closeAttr = /\\b(close|dismiss)\\b/i;

          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

          let clicked = 0;
          const elements = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title]'));
          for (const el of elements) {
            if (clicked >= 4) break;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (!rect || rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;

            const text = (el.textContent || '').trim();
            const aria = (el.getAttribute('aria-label') || '').trim();
            const title = (el.getAttribute('title') || '').trim();
            const label = [text, aria, title].filter(Boolean).join(' ');
            if (!label) continue;
            if (blockedAction.test(label)) continue;

            if (closeIntent.test(text) || closeAttr.test(aria) || closeAttr.test(title)) {
              el.click();
              clicked += 1;
            }
          }

          return clicked;
        })()
      `)
      await new Promise((resolve) => setTimeout(resolve, 500))
    } catch (err: any) {
      console.log(`[higgsfield] Promo dismissal skipped: ${err?.message || err}`)
    }
  }

  private async openAccountMenuAndReadText(win: BrowserWindow): Promise<string | null> {
    if (win.isDestroyed()) return null

    try {
      const text: string = await win.webContents.executeJavaScript(`
        (async function() {
          const creditPattern = /\\b\\d[\\d,.]*\\s+credits?\\s+(?:available|remaining|left|balance)\\b|\\b(?:available|remaining|left|balance)\\s+credits?\\b/i;
          if (creditPattern.test(document.body?.innerText || '')) {
            return document.body.innerText;
          }

          const blockedAction = /\\b(buy|get|upgrade|claim\\s+discount|top[-\\s]?up|boost|start\\s+creating|create|assets?|notifications?|bell)\\b/i;
          const accountIntent = /\\b(account|profile|user|avatar|menu|workspace|manage\\s+account)\\b/i;
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const elements = Array.from(document.querySelectorAll([
            'button',
            '[role="button"]',
            'a',
            '[aria-label]',
            '[title]',
            '[class*="avatar" i]',
            '[class*="profile" i]',
            '[class*="user" i]',
            '[class*="account" i]'
          ].join(',')));
          const width = window.innerWidth || document.documentElement.clientWidth || 1200;

          function isVisible(el) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          }

          function labelFor(el) {
            return [
              el.textContent || '',
              el.getAttribute('aria-label') || '',
              el.getAttribute('title') || '',
              el.getAttribute('class') || ''
            ].join(' ').replace(/\\s+/g, ' ').trim();
          }

          const candidates = elements.map((el) => {
            const rect = el.getBoundingClientRect();
            const label = labelFor(el);
            return { el, rect, label, hasAccountIntent: accountIntent.test(label) };
          }).filter((candidate) => {
            const { el, rect, label, hasAccountIntent } = candidate;
            if (!isVisible(el)) return false;
            if (blockedAction.test(label)) return false;
            return hasAccountIntent || (rect.right > width - 220 && rect.top < 140);
          }).sort((a, b) => {
            if (a.hasAccountIntent !== b.hasAccountIntent) return a.hasAccountIntent ? -1 : 1;
            return b.rect.right - a.rect.right;
          });

          for (const candidate of candidates.slice(0, 12)) {
            try {
              candidate.el.click();
              await sleep(800);
              const text = document.body?.innerText || '';
              if (creditPattern.test(text)) return text;
            } catch (_err) {
              // Try the next safe candidate.
            }
          }

          return document.body?.innerText || '';
        })()
      `)

      return text || null
    } catch (err: any) {
      console.log(`[higgsfield] Account menu extraction skipped: ${err?.message || err}`)
      return null
    }
  }

  private parseOrClassify(text: string): ScrapedUsageData | null {
    const lowerText = text.toLowerCase()

    if (
      /sign\s*in|log\s*in|continue with google|create account/.test(lowerText) &&
      !/credits?|subscription|billing/.test(lowerText)
    ) {
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    if (/verify you are human|captcha|access denied|forbidden|blocked/.test(lowerText)) {
      console.log('[higgsfield] Access challenge/block page detected')
      this.setLastFailureReason('cloudflare_blocked')
      return null
    }

    if (isScraperDebugEnabled()) {
      console.log(`[higgsfield] Page text preview: ${text.replace(/\s+/g, ' ').substring(0, 1000)}`)
    }

    return parseHiggsfieldUsageText(text)
  }
}
