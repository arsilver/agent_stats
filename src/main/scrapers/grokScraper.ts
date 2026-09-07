import { type ManagedChromeConfig } from '../managedChrome'
import { ScrapedUsageData, applyRenewalToScraped, isScraperDebugEnabled } from './baseScraper'
import { ManagedChromeScraper, MANAGED_PAGE_BODY_TEXT_FN } from './managedChromeScraper'
import { parseGrokUsageDialogText, type GrokDialogParseHints } from './usageTextParsers'
import { fetchGrokBotSandFromIde } from './cursorIdeUsage'

// Sign-in probe for waitForLoginComplete: grok.com's URL and title ("Grok")
// are identical signed-out and signed-in, so the title heuristic alone
// false-positives instantly. /rest/suggestions/profile is 401 for anonymous
// sessions and 200 signed-in (live-verified 2026-07-17). /api/auth/session is
// NOT usable alone — it returns status:"authenticated" with an empty userId
// for anonymous sessions.
const GROK_LOGIN_COMPLETE_EXPR = `(async () => {
  try {
    if (!/(^|\\.)grok\\.com$/.test(location.hostname)) return false;
    const r = await fetch('/rest/suggestions/profile', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch (e) { return false; }
})()`

const GROK_MANAGED_CHROME: ManagedChromeConfig = {
  serviceId: 'grok',
  // NOTE: 43211-43216 are taken by chatgpt/claude/minimax/fal-ai/(this)/cursor.
  port: 43215,
  startUrl: 'https://grok.com',
  // Signed-in grok lives at grok.com root — the URL cannot discriminate login
  // state, so the pattern is origin-wide and loginCompleteExpression carries
  // correctness. (The old value's extra alternatives were redundant: the bare
  // 'grok.com' fragment already matched every grok URL.)
  loggedInUrlPattern: 'grok.com',
  loginCompleteExpression: GROK_LOGIN_COMPLETE_EXPR
}

// Shape of one /rest/rate-limits response (anonymous-session sample,
// live-verified 2026-07-17):
//   {"windowSizeSeconds":14400,"remainingQueries":2,"totalQueries":2,
//    "lowEffortRateLimits":null,"highEffortRateLimits":null}
// Signed-in payloads may carry extra fields — the probe returns them verbatim
// in `raw` so debug runs can extend the mapping.
interface GrokRateLimitEntry {
  modelName: string
  windowSizeSeconds?: number
  remainingQueries?: number
  totalQueries?: number
  lowEffortRateLimits?: unknown
  highEffortRateLimits?: unknown
  [key: string]: unknown
}

interface GrokApiProbe {
  kind: 'ok' | 'anonymous' | 'api_error' | 'wrong_origin'
  limits?: GrokRateLimitEntry[]
  error?: string
  raw: Record<string, unknown>
}

/** Structured fields pulled from the ?_s=usage dialog DOM (not just innerText). */
interface GrokDialogDomHints {
  weeklyPct: number | null
  /** How weeklyPct was obtained — useful for distrusting lone track-width 100s. */
  weeklyPctSource?: string | null
  resetsText: string | null
  creditsUsd: number | null
  openedUsageTab: boolean
  hasWeeklyHeader: boolean
}

// In-page API probe. Runs via Runtime.evaluate (awaitPromise) inside the
// managed Chrome, so every fetch carries the real session cookies and Chrome's
// TLS fingerprint. CONTRACT: never throws (returns discriminated objects) and
// self-bounds to ~11s — CDP send() rejects at a fixed 15s.
const GROK_API_PROBE_SCRIPT = `(async () => {
  const out = { kind: 'api_error', raw: { url: location.href } };
  try {
    if (!/(^|\\.)grok\\.com$/.test(location.hostname)) { out.kind = 'wrong_origin'; return out; }
    const deadline = Date.now() + 11000;
    const budget = () => Math.max(500, Math.min(2500, deadline - Date.now()));
    const j = async (url, init) => {
      const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(budget()) }, init || {}));
      let body = null;
      try { body = await res.json(); } catch (e) {}
      return { status: res.status, ok: res.ok, body: body };
    };
    const post = (url, payload) => j(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // 1) Auth gate: session.userId must be NON-EMPTY, else confirm via the
    //    profile probe. Anonymous sessions get rate limits too — reporting
    //    those as the user's usage would be plausible-but-wrong data.
    const session = await j('/api/auth/session');
    out.raw.session = session.body;
    const userId = session.body && session.body.session && session.body.session.userId;
    if (!userId) {
      const profile = await j('/rest/suggestions/profile');
      out.raw.profileStatus = profile.status;
      if (!profile.ok) { out.kind = 'anonymous'; return out; }
    }

    // 2) Best-effort mode discovery — logged for field mapping only, never load-bearing.
    if (Date.now() < deadline - 6000) {
      try { out.raw.modes = (await post('/rest/modes', {})).body; } catch (e) { out.raw.modesError = String(e); }
    }

    // 3) Rate limits per candidate model. 404 code 5 = model renamed — tolerated;
    //    debug logs carry the per-model status so the list can be updated.
    //    Valid pool names (live-verified 2026-07-17): grok-4, grok-4-heavy,
    //    grok-3. grok-3 is deliberately NOT queried — it's an obsolete pool
    //    nobody plans around; showing it just confuses the card.
    //    These are SHORT-TERM rolling windows (e.g. 2h), NOT the weekly
    //    SuperGrok Heavy allowance shown on ?_s=usage.
    const models = ['grok-4', 'grok-4-heavy'];
    const limits = [];
    for (const modelName of models) {
      if (Date.now() > deadline - 1000) { out.raw.deadlineHit = modelName; break; }
      try {
        const r = await post('/rest/rate-limits', { requestKind: 'DEFAULT', modelName: modelName });
        out.raw['rateLimits_' + modelName] = { status: r.status, body: r.body };
        if (r.ok && r.body && typeof r.body.totalQueries === 'number') {
          limits.push(Object.assign({ modelName: modelName }, r.body));
        }
      } catch (e) { out.raw['rateLimitsThrew_' + modelName] = String(e); }
    }
    if (limits.length > 0) { out.kind = 'ok'; out.limits = limits; }
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e);
    return out;
  }
})()`

/**
 * Open the Usage settings panel if needed, then scrape text + structured
 * weekly-limit fields. The weekly SuperGrok Heavy % is the card primary; the
 * API probe runs afterward for auth + rolling pool sub-rows.
 *
 * Why structured DOM: the headline percent is a rAF count-up. When products
 * are also omitted (2026-07 zero-usage layout), innerText alone can miss the
 * only number that matters. aria-valuenow / width style recover it.
 *
 * Escaping note: this is a TS template literal. Regex atoms in the page JS
 * (\s \d \. \S) are written with a doubled backslash here so the emitted
 * string carries a single backslash.
 */
const GROK_USAGE_DIALOG_EXTRACT_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });
  // Prefer visible innerText; fall back to textContent when managed Chrome
  // leaves innerText empty after hydration.
  ${MANAGED_PAGE_BODY_TEXT_FN}
  const hasWeekly = () => {
    const t = bodyText();
    return /Weekly\\s+SuperGrok|Weekly\\s+Grok|Extra\\s+Usage\\s+Credits|Heavy\\s+Limit/i.test(t);
  };
  // Headline only — product rows are \"Imagine 18%\", not \"18% used\".
  // Bind tightly so a product line never satisfies the wait.
  const hasHeadlinePctUsed = () =>
    /Weekly\\s+(?:SuperGrok(?:\\s+Heavy)?|Grok)?\\s*Limit[\\s\\S]{0,80}?\\d+(?:\\.\\d+)?\\s*%\\s*used/i.test(bodyText()) ||
    /(?:SuperGrok(?:\\s+Heavy)?|Heavy\\s+Limit)\\s+\\d+(?:\\.\\d+)?\\s*%\\s*used/i.test(bodyText());
  // Static product rows (not rAF) — reliable when the headline count-up stalls.
  const hasProductRows = () =>
    /(Grok Build|DeepSearch|Imagine|Search|Voice|Tasks?|Chat|Build|API)\\s+\\d+(?:\\.\\d+)?\\s*%/i.test(bodyText());

  let openedUsageTab = false;
  const clickUsageTab = () => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role=\"tab\"], [role=\"menuitem\"], [role=\"button\"]'));
    for (const el of nodes) {
      const t = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
      // Exact \"Usage\" only — not \"Extra Usage Credits\" / \"Usage-based\".
      if (/^Usage$/i.test(t)) {
        try { el.click(); openedUsageTab = true; return true; } catch (e) {}
      }
    }
    return false;
  };

  // Deep link sometimes lands on Account. Force the Usage tab before reading.
  if (!hasWeekly()) {
    clickUsageTab();
    for (let i = 0; i < 20 && !hasWeekly(); i++) await sleep(300);
  }
  // Give the rAF count-up time once the panel is up. After a weekly reset the
  // headline often paints empty for longer than one frame; 1.6s was not enough
  // and the CSS track (always width:100%) was scraped as \"100% used\".
  // Also accept static product rows — live bug stuck the headline at 1% while
  // Grok Build/Chat kept climbing.
  if (hasWeekly() && !hasHeadlinePctUsed()) {
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      if (hasHeadlinePctUsed()) break;
      if (i >= 8 && hasProductRows()) break;
    }
  } else if (hasWeekly() && hasHeadlinePctUsed() && !hasProductRows()) {
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      if (hasProductRows()) break;
    }
  }

  const text = bodyText();
  const hasWeeklyHeader = /Weekly\\s+(?:SuperGrok(?:\\s+Heavy)?|Grok)?\\s*Limit/i.test(text);

  let weeklyPct = null;
  let weeklyPctSource = null;
  // Prefer the number glued to the Limit header (before Resets). Never let a
  // later product "N% used" leak into the weekly total via a wide window.
  const pctFromText =
    text.match(/Weekly\\s+(?:SuperGrok(?:\\s+Heavy)?|Grok)?\\s*Limit\\s+(\\d+(?:\\.\\d+)?)\\s*%\\s*used/i) ||
    text.match(/Weekly\\s+(?:SuperGrok(?:\\s+Heavy)?|Grok)?\\s*Limit[\\s\\S]{0,60}?(\\d+(?:\\.\\d+)?)\\s*%\\s*used[\\s\\S]{0,40}?Resets/i) ||
    text.match(/(?:SuperGrok(?:\\s+Heavy)?|Heavy\\s+Limit)\\s+(\\d+(?:\\.\\d+)?)\\s*%\\s*used/i);
  if (pctFromText) {
    const v = parseFloat(pctFromText[1]);
    if (Number.isFinite(v) && v >= 0 && v <= 100) {
      weeklyPct = v;
      weeklyPctSource = 'text';
    }
  }

  // aria progressbars near the weekly block
  if (weeklyPct == null) {
    const bars = Array.from(document.querySelectorAll('[role="progressbar"], progress'));
    for (const el of bars) {
      const host = el.closest('section, article, li, form, div');
      const ctx = ((host && host.innerText) || (el.parentElement && el.parentElement.innerText) || '').slice(0, 500);
      if (!/Weekly|SuperGrok|Heavy\\s+Limit|%\\s*used/i.test(ctx)) continue;
      const nowAttr = el.getAttribute('aria-valuenow');
      const maxAttr = el.getAttribute('aria-valuemax');
      if (nowAttr != null && nowAttr !== '') {
        const n = parseFloat(nowAttr);
        const mx = maxAttr != null && maxAttr !== '' ? parseFloat(maxAttr) : 100;
        if (Number.isFinite(n) && n >= 0) {
          weeklyPct = (Number.isFinite(mx) && mx > 0 && mx !== 100)
            ? Math.round((n / mx) * 1000) / 10
            : n;
          if (weeklyPct > 100 && Number.isFinite(mx) && mx > 0) {
            weeklyPct = Math.round((n / mx) * 1000) / 10;
          }
          weeklyPctSource = 'aria';
          break;
        }
      }
    }
  }

  // CSS / geometry fill inside a SuperGrok block.
  // CRITICAL: the track is almost always style width:100%. Taking the first
  // width match reports 100% used right after a weekly reset (empty fill, no
  // product rows, rAF headline still empty). Prefer the SMALLEST width under
  // 100, then pixel fill ratio; never treat a lone 100% track as usage.
  if (weeklyPct == null) {
    const blocks = Array.from(document.querySelectorAll('div, section, li, article'));
    for (const block of blocks) {
      const t = (block.innerText || '').slice(0, 400);
      if (!/Weekly\\s+SuperGrok|Heavy\\s+Limit/i.test(t)) continue;
      if (!/%\\s*used|Resets|SuperGrok/i.test(t)) continue;

      const widths = [];
      const candidates = Array.from(block.querySelectorAll('[style*="width"]')).slice(0, 20);
      for (const el of candidates) {
        const style = el.getAttribute('style') || '';
        const wm = style.match(/width\\s*:\\s*([\\d.]+)\\s*%/i);
        if (!wm) continue;
        const w = parseFloat(wm[1]);
        if (Number.isFinite(w) && w >= 0 && w <= 100) widths.push(w);
        // scaleX(0..1) is another common fill encoding
        const sm = style.match(/scaleX\\s*\\(\\s*([\\d.]+)\\s*\\)/i);
        if (sm) {
          const s = parseFloat(sm[1]);
          if (Number.isFinite(s) && s >= 0 && s <= 1) widths.push(Math.round(s * 1000) / 10);
        }
      }
      const under100 = widths.filter(function (w) { return w < 99.5; });
      if (under100.length > 0) {
        // Fill is the smallest positive-or-zero bar; track is always 100.
        weeklyPct = Math.min.apply(null, under100);
        weeklyPctSource = 'width';
        break;
      }

      // Geometry: measure the innermost narrow bar-like child vs its parent.
      let bestRatio = null;
      const barish = Array.from(block.querySelectorAll('[class*="progress"], [class*="bar"], [role="progressbar"], [style*="width"]')).slice(0, 16);
      for (const el of barish) {
        const parent = el.parentElement;
        if (!parent) continue;
        const fw = el.getBoundingClientRect().width;
        const pw = parent.getBoundingClientRect().width;
        if (!(pw > 8) || fw < 0 || fw > pw + 2) continue;
        const ratio = Math.round((fw / pw) * 1000) / 10;
        if (ratio > 100) continue;
        // Prefer the smaller ratio (fill over full-width track/container).
        if (bestRatio == null || ratio < bestRatio) bestRatio = ratio;
      }
      if (bestRatio != null && bestRatio < 99.5) {
        weeklyPct = bestRatio;
        weeklyPctSource = 'geometry';
        break;
      }
      // Lone 100% track + empty fill after reset → 0, not 100.
      if (widths.some(function (w) { return w >= 99.5; }) || bestRatio != null) {
        const looksEmpty =
          bestRatio == null || bestRatio < 1.5 ||
          widths.some(function (w) { return w < 1.5; });
        if (looksEmpty) {
          weeklyPct = 0;
          weeklyPctSource = 'empty_track';
          break;
        }
      }
    }
  }

  // Post-reset zero-usage layout: weekly header + Resets present, no headline
  // number, no product percentages, empty/missing bar → 0% used.
  if (weeklyPct == null && hasWeeklyHeader && /Resets\\s+[A-Za-z]+/i.test(text)) {
    const hasProductPct =
      /(Grok Build|DeepSearch|Imagine|Search|Voice|Tasks?|Chat|Build|API)\\s+\\d+(?:\\.\\d+)?\\s*%/i.test(text);
    if (!hasProductPct) {
      weeklyPct = 0;
      weeklyPctSource = 'zero_default';
    }
  }

  let resetsText = null;
  const resetM = text.match(/Resets\\s+([A-Za-z]+\\s+\\d{1,2},\\s*\\d{4}(?:\\s*(?:at\\s*)?\\d{1,2}:\\d{2}\\s*[AP]M)?)/i);
  if (resetM) resetsText = resetM[0];

  let creditsUsd = null;
  const credM = text.match(/Extra\\s+Usage\\s+Credits[\\s\\S]{0,120}?\\$\\s*([\\d,]+(?:\\.\\d+)?)/i);
  if (credM) {
    const bal = parseFloat(credM[1].replace(/,/g, ''));
    if (Number.isFinite(bal) && bal >= 0) creditsUsd = bal;
  }

  const api = await ${GROK_API_PROBE_SCRIPT};
  const xhr = (performance.getEntriesByType('resource') || [])
    .filter(function (e) { return e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'; })
    .map(function (e) { return e.name; })
    .slice(-80);

  return {
    text: text,
    api: api,
    xhr: xhr,
    dom: {
      weeklyPct: weeklyPct,
      weeklyPctSource: weeklyPctSource,
      resetsText: resetsText,
      creditsUsd: creditsUsd,
      openedUsageTab: openedUsageTab,
      hasWeeklyHeader: hasWeeklyHeader
    }
  };
})()`

const GROK_BILLING_EXTRACT_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });
  ${MANAGED_PAGE_BODY_TEXT_FN}
  const hasBillingCopy = () =>
    /renew|next\\s+(?:billing|payment|invoice)|manage\\s+subscription|billing\\s+date|period\\s+ends|cancels?\\s+on/i.test(bodyText());
  const clickTab = (pattern) => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="button"]'));
    for (const el of nodes) {
      const t = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
      if (!pattern.test(t) || t.length > 40) continue;
      try { el.click(); return true; } catch (e) {}
    }
    return false;
  };
  if (!hasBillingCopy()) {
    clickTab(/^Billing$/i);
    for (let i = 0; i < 16 && !hasBillingCopy(); i++) await sleep(250);
  }
  return bodyText();
})()`

/**
 * Grok (xAI) scraper.
 *
 * API-first: the grok.com web app's own endpoints are fetched in-page through
 * managed Chrome (live-verified 2026-07-17):
 *  - GET  /api/auth/session          → auth gate (session.userId non-empty)
 *  - GET  /rest/suggestions/profile  → 401 anonymous / 200 signed-in
 *  - POST /rest/rate-limits {requestKind:'DEFAULT', modelName}
 *        → { windowSizeSeconds, remainingQueries, totalQueries, ... }
 *
 * The ?_s=usage settings-dialog DOM parse (parseUsageFromText) survives only
 * as a fallback for the day the REST endpoints move or all candidate model
 * names 404.
 */
export class GrokScraper extends ManagedChromeScraper {
  constructor() {
    // Canonical usage deep-link (opens the usage panel directly)
    super('grok', 'https://grok.com/?_s=usage', GROK_MANAGED_CHROME)
  }

  protected isCloudflareProtected(): boolean {
    return true
  }

  async scrape(): Promise<ScrapedUsageData | null> {
    this.resetLastFailureReason()

    // ── Combined pass at the ?_s=usage deep link: the settings dialog is the
    //    authoritative source for the WEEKLY SuperGrok (Heavy) limit —
    //    "Weekly SuperGrok Heavy Limit / N% used / Resets July 31, 2026 at
    //    4:42 PM / Extra Usage Credits $N" (live-verified 2026-07) — while
    //    the in-page API fetches carry the auth gate + rolling 2h pools
    //    (secondary rows only; never the card headline).
    type ProbeValue = {
      text: string
      api: GrokApiProbe
      xhr?: string[]
      dom?: GrokDialogDomHints
    }
    let probe: { url: string; title: string; value: ProbeValue | null } | null = null
    try {
      probe = await this.evaluateManaged<ProbeValue>(
        'https://grok.com/?_s=usage',
        // Prefer the usage panel itself. Still accept a settled settings shell
        // (Account/Appearance) so the extract script can click the Usage tab
        // and the API gate can still classify anonymous sessions.
        // Fall back to textContent when innerText is empty (managed-Chrome
        // hydration quirk — readiness used to time out with innerTextLen=0
        // while the dialog was already in the DOM).
        `(() => {
          if (document.readyState !== 'complete' || !document.body) return false;
          const it = document.body.innerText || '';
          const tc = document.body.textContent || '';
          const t = it.length > 80 ? it : (tc || it);
          if (t.length < 150) return false;
          return /Weekly SuperGrok|Extra Usage Credits|% used/i.test(t)
            || /Sign in|Sign up|Account|Appearance/i.test(t);
        })()`,
        GROK_USAGE_DIALOG_EXTRACT_SCRIPT,
        // Extract script may wait ~6s for the Usage tab + count-up + products.
        { timeoutMs: 50000, allowNavigate: true }
      )
    } catch (err) {
      console.log('[grok] Combined probe evaluate threw (falling back to DOM):', (err as Error)?.message || err)
    }

    if (!probe || !probe.value) {
      await this.classifyManagedNullResult(this.dashboardUrl)
      if (isScraperDebugEnabled()) {
        // A readiness timeout says nothing about WHY the gate never matched.
        // Re-read the page behind a permissive gate so the log carries its real
        // state (did the usage panel open? was the deep-link param stripped?).
        const diag = await this.evaluateManaged<{ url: string; title: string; len: number; text: string }>(
          this.dashboardUrl,
          'document.readyState === "complete"',
          '(() => { const b = document.body; const it = (b && b.innerText) || ""; const tc = (b && b.textContent) || ""; return { url: location.href, title: document.title, innerTextLen: it.length, textContentLen: tc.length, elements: document.querySelectorAll("*").length, hasUsageMarker: /Weekly SuperGrok|Extra Usage Credits|% used/i.test(tc), text: (it || tc).replace(/\\s+/g, " ").slice(0, 700) }; })()',
          { timeoutMs: 15000, allowNavigate: false }
        ).catch(() => null)
        console.log(`[grok] Readiness diagnostic: ${diag && diag.value ? JSON.stringify(diag.value) : 'unavailable'}`)
      }
      return null
    }

    const dialogText = probe.value.text || ''
    const value = probe.value.api
    const dom = probe.value.dom
    if (isScraperDebugEnabled()) {
      if (value) console.log(`[grok] API probe raw: ${JSON.stringify(value.raw).slice(0, 4000)}`)
      // Full text, not a 600-char preview: the question is whether the Usage
      // panel rendered at all or the dialog settled on another tab, and the
      // sidebar items alone fill the first 600 chars either way.
      console.log(`[grok] RAW DIALOG TEXT >>>${dialogText.replace(/\s+/g, ' ').slice(0, 3000)}<<<`)
      console.log(`[grok] DOM hints: ${JSON.stringify(dom ?? null)}`)
      console.log(`[grok] XHR seen (${probe.value.xhr?.length ?? 0}): ${JSON.stringify(probe.value.xhr ?? [])}`)
    }

    if (value?.kind === 'anonymous') {
      // NEVER report the anonymous quota (2 queries / window) as the user's usage.
      console.log('[grok] Session is anonymous (profile probe 401) — sign-in required')
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    // ── Primary: the weekly SuperGrok Heavy limit (what grok.com headlines) ──
    const hints: GrokDialogParseHints = {
      weeklyPct: dom?.weeklyPct ?? null,
      creditsUsd: dom?.creditsUsd ?? null
    }
    const weekly = parseGrokUsageDialogText(dialogText, new Date(), hints)
    if (weekly) {
      // Rolling /rest/rate-limits windows (grok-4 · 2h, Heavy · 2h) sit at 0
      // most of the time and are not the weekly products. Keep Model Pools to
      // Grok Build / Chat / Imagine from the usage dialog.
      console.log(
        `[grok] Weekly SuperGrok limit: ${weekly.percentUsed}% used, resets ${weekly.resetsAt ?? 'n/a'}, ` +
          `subs=${weekly.subModels?.length ?? 0}` +
          (dom?.weeklyPctSource ? `, pctSource=${dom.weeklyPctSource}` : '') +
          (dom?.openedUsageTab ? ' (clicked Usage tab)' : '')
      )
      this.markScrapeWorked()
      await this.attachSubscriptionRenewal(weekly)
      return await this.attachGrokBotOverlay(weekly)
    }

    if (value?.kind === 'ok' && value.limits && value.limits.length > 0) {
      // Last resort only — the website's headline is weekly %, not these pools.
      // Log loudly so a silent regression back to "0/140 queries" is obvious.
      const data = this.buildFromRateLimits(value.limits)
      if (data) {
        console.log(
          `[grok] WARNING: weekly dialog parse failed — falling back to rolling pool ` +
            `${data.currentUsage}/${data.usageLimit} (${data.percentUsed}%) across ${value.limits.length} pool(s). ` +
            `dom=${JSON.stringify(dom ?? null)}`
        )
        this.markScrapeWorked()
        await this.attachSubscriptionRenewal(data)
        return await this.attachGrokBotOverlay(data)
      }
    }

    console.log(
      `[grok] Neither dialog nor API usable (kind=${value?.kind ?? 'null'}${value?.error ? `, error=${value.error}` : ''}) — falling back to legacy DOM parse`
    )
    const domFallback = await this.scrapeFromDom()
    return domFallback ? await this.attachGrokBotOverlay(domFallback) : null
    }

  // The ?_s=usage dialog parser lives in usageTextParsers.ts as
  // parseGrokUsageDialogText so the offscreen-render quirk it works around
  // is covered by a fixture.

  /**
   * Row label for a rolling rate-limit pool, e.g. "Heavy · 2h".
   *
   * Both the weekly-dialog path and the pool fallback render these rows, so the
   * name is derived here once. They had already drifted: the fallback dropped
   * the window suffix entirely, so a "Heavy" row showed no period at all while
   * the metrics layer stamped it with grok-4's window instead.
   *
   * "Heavy" is our rename of the grok-4-heavy pool, matching Grok's own UI —
   * the API only ever returns the raw model name.
   */
  private poolRowName(entry: GrokRateLimitEntry): string {
    const label = entry.modelName === 'grok-4-heavy' ? 'Heavy' : (entry.modelName ?? 'pool')
    const windowH =
      typeof entry.windowSizeSeconds === 'number' && entry.windowSizeSeconds > 0
        ? `${Math.round(entry.windowSizeSeconds / 3600)}h`
        : null
    return windowH ? `${label} · ${windowH}` : label
  }

  /** Map /rest/rate-limits pools onto the card model. Flagship pool = primary bar. */
  private buildFromRateLimits(limits: GrokRateLimitEntry[]): ScrapedUsageData | null {
    const flagship = limits.find((l) => l.modelName === 'grok-4') ?? limits[0]
    const total = typeof flagship.totalQueries === 'number' ? flagship.totalQueries : null
    const remaining = typeof flagship.remainingQueries === 'number' ? flagship.remainingQueries : null
    if (total === null || remaining === null || total <= 0) return null

    const used = Math.max(0, total - remaining)
    const percentUsed = Math.round((used / total) * 1000) / 10

    // Rolling-window length, e.g. 7200s → "/ 2h" — the most useful context the
    // API reliably provides (an absolute reset only exists once queries burn).
    const windowHours =
      typeof flagship.windowSizeSeconds === 'number' && flagship.windowSizeSeconds > 0
        ? Math.round((flagship.windowSizeSeconds / 3600) * 10) / 10
        : null
    const windowSuffix = windowHours ? ` / ${windowHours % 1 === 0 ? windowHours.toFixed(0) : windowHours}h` : ''

    const subModels: NonNullable<ScrapedUsageData['subModels']> = []
    for (const entry of limits) {
      if (entry === flagship) continue
      if (
        typeof entry.totalQueries === 'number' &&
        typeof entry.remainingQueries === 'number' &&
        entry.totalQueries > 0
      ) {
        subModels.push({
          name: this.poolRowName(entry),
          count: Math.max(0, entry.totalQueries - entry.remainingQueries),
          total: entry.totalQueries
        })
      }
    }

    return {
      currentUsage: used,
      usageLimit: total,
      percentUsed,
      // These are query COUNTS (e.g. 3 of 140 this window), not percentages —
      // a '%' unit would make the card print the limit as "140%".
      // Name the pool: this is one model's rolling bucket, NOT an account-wide
      // quota, and an unqualified "140 queries" reads like the latter.
      usageUnit: `${typeof flagship.modelName === 'string' ? `${flagship.modelName} ` : ''}queries used${windowSuffix}`,
      // Truthfulness: windowSizeSeconds is the WINDOW LENGTH, not time-to-reset —
      // never derive resetsAt from it. Only an absolute timestamp field counts.
      resetsAt: this.extractResetTimestamp(flagship),
      weeklyUsage: null,
      weeklyLimit: null,
      weeklyPercentUsed: null,
      subModels: subModels.length > 0 ? subModels : undefined,
      // Profile fallback ('SuperGrok') applies downstream when null.
      detectedPlanTier: null
    }
  }

  /**
   * Accept a reset timestamp only when the payload carries one — absolute
   * (candidate timestamp keys) or relative (seconds-until keys, which xAI
   * emits once queries have been consumed). Real API values only; never
   * derived from windowSizeSeconds.
   */
  private extractResetTimestamp(entry: GrokRateLimitEntry): string | null {
    const MAX_AHEAD_MS = 32 * 24 * 3600 * 1000

    for (const key of ['resetsAt', 'resetAt', 'resetTime', 'nextRefreshTime', 'windowEndsAt']) {
      const v = entry[key]
      if (typeof v !== 'string' && typeof v !== 'number') continue
      const t = typeof v === 'number' && v > 1e12 ? v : Date.parse(String(v))
      if (Number.isFinite(t) && t > Date.now() && t < Date.now() + MAX_AHEAD_MS) {
        return new Date(t).toISOString()
      }
    }

    for (const key of ['waitTimeSeconds', 'retryAfterSeconds', 'resetAfterSeconds', 'secondsUntilReset', 'waitTimeSecs']) {
      const v = entry[key]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (v > 0 && v * 1000 < MAX_AHEAD_MS) {
        return new Date(Date.now() + v * 1000).toISOString()
      }
    }

    return null
  }

  /** Fallback: parse the ?_s=usage settings dialog text (pre-API behavior). */
  private async scrapeFromDom(): Promise<ScrapedUsageData | null> {
    const usageDeepLink = 'https://grok.com/?_s=usage'

    const result = await this.evaluateManaged<string>(
      usageDeepLink,
      this.getPageReadyCheck(),
      'document.body ? document.body.innerText : ""',
      { timeoutMs: 30000, allowNavigate: true }
    )

    if (!result || result.value == null) {
      await this.classifyManagedNullResult(this.dashboardUrl)
      return null
    }

    const text = result.value || ''
    const lower = text.toLowerCase()

    console.log(`[grok] Managed Chrome page loaded (len=${text.length})`)

    // Strong login guard
    if (
      /sign in|log in|continue with google|continue with x|create account/.test(lower) &&
      !/usage|weekly|reset|credits|chat|imagine|voice|build/.test(lower)
    ) {
      this.setLastFailureReason('login_required')
      return { loginRequired: true } as any
    }

    if (/verify you are human|captcha|cloudflare|access denied|forbidden|just a moment/.test(lower)) {
      console.log('[grok] Access challenge / block page detected in managed Chrome')
      this.setLastFailureReason('cloudflare_blocked')
      return null
    }

    if (isScraperDebugEnabled()) {
      console.log(`[grok] Page text preview: ${text.replace(/\s+/g, ' ').substring(0, 900)}`)
    }

    const parsed = this.parseUsageFromText(text)
    if (parsed) {
      this.markScrapeWorked()
      await this.attachSubscriptionRenewal(parsed)
    }
    return parsed
  }

  private parseUsageFromText(text: string): ScrapedUsageData | null {
    // ─── Parse main overall usage % ─────────────────────────────────────────
    // Grok usage page likely shows "X% used" or progress for SuperGrok weekly pool
    let mainPct: number | null = null
    // Look for SuperGrok or usage pool context first
    const superGrokRe = /(?:supergrok|weekly usage|usage pool)[^\n]{0,100}?(\d{1,3})\s*%/i
    let m = text.match(superGrokRe)
    if (m) mainPct = parseInt(m[1], 10)

    if (mainPct === null) {
      const contextRe = /(?:used|usage|pool|weekly|of your|remaining)[^\n]{0,80}?(\d{1,3})\s*%/i
      m = text.match(contextRe)
      if (m) mainPct = parseInt(m[1], 10)
    }

    if (mainPct === null) {
      // Any prominent percentage on the page, prefer first large one
      const allPcts = Array.from(text.matchAll(/(\d{1,3})\s*%/g)).map(match => parseInt(match[1], 10)).filter(v => v >= 0 && v <= 100)
      if (allPcts.length > 0) {
        mainPct = allPcts[0]
      }
    }

    // ─── Weekly quota reset (not subscription renewal) ───────────────────────
    // "Resets July 24, 2026 at 4:42 PM" is the weekly SuperGrok window.
    // Never treat that as the card's Renews/Ends date.
    let resetsAt: string | null = null
    const resetM = text.match(
      /Resets\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]M)?/i
    )
    if (resetM) {
      const t = Date.parse(`${resetM[1]} ${resetM[2] ?? '12:00 AM'}`)
      if (Number.isFinite(t)) resetsAt = new Date(t).toISOString()
    }

    // ─── Product breakdown ───────────
    const subModels: { name?: string; count?: number; total?: number }[] = []
    // Look for lines like "Chat 45%" or "Imagine: 30%" etc. Common on Grok usage
    const productRe = /(Chat|Imagine|Voice|Build|API|Agents?|Search|DeepSearch|Text|Image|Video)[^\n]{0,40}?(\d{1,3})\s*%/gi
    let pm: RegExpExecArray | null
    while ((pm = productRe.exec(text)) !== null) {
      const name = pm[1]
      const pct = parseInt(pm[2], 10)
      if (!isNaN(pct) && pct >= 0 && pct <= 100) {
        const lowerName = name.toLowerCase()
        if (!subModels.some((s) => (s.name || '').toLowerCase() === lowerName)) {
          subModels.push({ name, count: pct, total: 100 })
        }
      }
    }

    // NOTE: no "Product N" fallback here — sub-model rows are only emitted when
    // a real product label was parsed above. Invented labels are worse than none.

    // ─── Extra usage credits → agentCredits (same shape minimax/falai use) ──
    const credMatch = text.match(/extra\s*(?:usage\s*)?credits?\s*[:\-]?\s*\$?\s*([\d,.]+)/i) || text.match(/credits?\s*balance\s*[:\-]?\s*\$?\s*([\d,.]+)/i)
    let agentCredits: ScrapedUsageData['agentCredits'] | undefined
    if (credMatch) {
      const val = parseFloat(credMatch[1].replace(/,/g, ''))
      if (!isNaN(val) && val >= 0) {
        console.log(`[grok] Extra usage credits: ${val}`)
        agentCredits = {
          balance: val,
          membership: 0,
          valueAdded: 0,
          bonus: 0,
          debt: 0,
          dailyFree: 0,
          spendingHistory: []
        }
      }
    }

    if (mainPct === null && subModels.length === 0) {
      const preview = text.replace(/\s+/g, ' ').substring(0, 800)
      console.log(`[grok] No recognizable usage numbers found. Page preview: ${preview}`)
      this.setLastFailureReason('extract_failed')
      return null
    }

    // If we have mainPct but it looks like overall used, use it; else default
    const effectiveMain = mainPct !== null ? mainPct : (subModels.length > 0 ? Math.max(...subModels.map(s => s.count || 0)) : 0)

    console.log(`[grok] Parsed: main=${effectiveMain}%, subs=${subModels.length}, resetsAt=${resetsAt}`)

    return {
      currentUsage: effectiveMain,
      usageLimit: 100,
      percentUsed: effectiveMain,
      usageUnit: '%',
      resetsAt,
      weeklyUsage: null,
      weeklyLimit: null,
      weeklyPercentUsed: null,
      subModels: subModels.length > 0 ? subModels : undefined,
      agentCredits,
      detectedPlanTier: text.match(/supergrok|super grok/i) ? 'SuperGrok' : null
    }
  }

  /**
   * CaptainGrok weekly % is Cursor Sand, not grok.com. Same IDE token as the
   * Cursor card. A miss must not drop a good SuperGrok scrape.
   */
  private async attachGrokBotOverlay(data: ScrapedUsageData): Promise<ScrapedUsageData> {
    try {
      const sand = await fetchGrokBotSandFromIde()
      if (sand.kind === 'usage') {
        data.grokBotPercentUsed = sand.percentUsed
        data.grokBotResetsAt = sand.resetsAt
        console.log(
          `[grok] Grok Bot weekly: ${sand.percentUsed}% used, resets ${sand.resetsAt ?? 'n/a'}`
        )
      } else if (sand.kind === 'none') {
        data.grokBotPercentUsed = null
        data.grokBotResetsAt = null
        console.log('[grok] Grok Bot weekly: no included allowance')
      } else {
        console.log('[grok] Grok Bot weekly: Sand fetch missed (keeping last overlay)')
      }
    } catch (err) {
      console.log(`[grok] Grok Bot weekly: Sand fetch failed (non-fatal): ${(err as Error).message}`)
    }
    return data
  }

  /**
   * SuperGrok billing is a separate settings tab (grok.com/?_s=billing).
   * The usage dialog only has the weekly quota reset, which is not the
   * subscription renew/end date the card footer shows.
   */
  private async attachSubscriptionRenewal(data: ScrapedUsageData): Promise<void> {
    if (data.renewalDate) return
    try {
      const billing = await this.evaluateManaged<string>(
        'https://grok.com/?_s=billing',
        `(() => {
          if (document.readyState !== 'complete' || !document.body) return false;
          const t = document.body.innerText || document.body.textContent || '';
          return t.length > 80 && /billing|renew|subscription|manage subscription|next payment|super\\s*grok/i.test(t);
        })()`,
        GROK_BILLING_EXTRACT_SCRIPT,
        { timeoutMs: 12000, allowNavigate: true }
      )
      if (!billing?.value) {
        console.log('[grok] Renewal scrape: billing tab never became ready')
        return
      }
      if (isScraperDebugEnabled()) {
        console.log(`[grok] Billing text preview: ${billing.value.replace(/\s+/g, ' ').slice(0, 400)}`)
      }
      if (applyRenewalToScraped(data, billing.value)) {
        console.log(`[grok] Renewal detected: ${data.renewalDate} (${data.renewalKind}) from ?_s=billing`)
      } else {
        console.log('[grok] Renewal scrape: no subscription date on billing tab')
      }
    } catch (err) {
      console.error('[grok] Renewal scrape failed (non-fatal):', err)
    }
  }

  protected getExtraCookieDomains(): string[] {
    return [
      'grok.com',
      '.grok.com',
      'grok.x.ai',
      '.grok.x.ai',
      'x.ai',
      '.x.ai',
      'accounts.x.ai'
    ]
  }

  protected getLoginUrlPatterns(): string[] {
    return ['/sign-in', '/login', '/auth', 'accounts.x.ai', 'sign in with']
  }

  protected getPageReadyCheck(): string {
    // Wait for the actual usage panel content (the ?_s=usage deep link)
    // Look for SuperGrok indicators, percentages, or product names
    return `document.readyState === 'complete' && document.body && (document.body.innerText.includes('SuperGrok') || document.body.innerText.includes('weekly') || /\\d+%/.test(document.body.innerText) || /Chat|Imagine|Voice|Build|usage pool/i.test(document.body.innerText)) && document.body.innerText.length > 150`
  }
}
