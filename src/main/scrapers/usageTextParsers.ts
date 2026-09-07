import { applyRenewalToScraped, type RenewalKind, type ScrapedUsageData } from './baseScraper'

interface MetricRow {
  name: string
  count: number
  total: number
  percent: number
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
}

function normalizeText(rawText: string): string {
  return rawText
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseHumanNumber(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, '').trim()
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/i)
  if (!match) return Number.NaN

  const value = parseFloat(match[1])
  const suffix = (match[2] || '').toUpperCase()
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1
  return Math.round(value * multiplier)
}

function parsePercent(count: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.round((count / total) * 100)
}

function parseRenewalDateFromText(text: string): string | null {
  const relevantLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /(renew|billing|subscription|expires?|valid until|next payment|next charge|period ends|auto-renew)/i.test(line))

  const candidates = relevantLines.length > 0 ? relevantLines : [text]

  for (const line of candidates) {
    const iso = line.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/)
    if (iso) {
      return toIsoDate(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10))
    }

    const named = line.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/i
    )
    if (named) {
      const month = MONTHS[named[1].toLowerCase()]
      const day = parseInt(named[2], 10)
      let year = named[3] ? parseInt(named[3], 10) : new Date().getFullYear()

      if (!named[3]) {
        const today = new Date()
        const candidate = new Date(year, month - 1, day)
        const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
        if (candidate.getTime() < startOfToday.getTime()) year += 1
      }

      return toIsoDate(year, month, day)
    }
  }

  return null
}

function detectGeminiTier(flatText: string): string | null {
  const tierMatch =
    flatText.match(/\b(Tier\s*[123])\b/i) ||
    flatText.match(/\b(Free\s*tier|Free\s*plan|Free)\b/i) ||
    flatText.match(/\b(Paid\s*tier)\b/i)

  if (!tierMatch) return null

  const normalized = tierMatch[1].replace(/\s+plan$/i, '').replace(/\s+tier$/i, '').trim()
  if (/^free$/i.test(normalized)) return 'Free'
  if (/^paid$/i.test(normalized)) return 'Paid'

  return normalized.replace(/\s+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function extractMetricRows(name: string, tail: string): MetricRow[] {
  const fallbackMetricNames = ['RPM', 'TPM', 'RPD']
  const rows: MetricRow[] = []
  const ratioRe = /(\d+(?:\.\d+)?\s*[KMB]?|\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[KMB]?)\s*\/\s*(\d+(?:\.\d+)?\s*[KMB]?|\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*[KMB]?)/gi

  // Explicit unit labels (RPM/TPM/RPD) that appear on the same segment, in
  // order of appearance. When their count matches the number of ratios, pair
  // them 1:1 so each ratio gets the unit actually printed next to it instead
  // of a blind positional guess.
  const explicitUnits = Array.from(tail.matchAll(/\b(RPM|TPM|RPD)\b/gi)).map((m) => m[1].toUpperCase())

  const ratios: { count: number; total: number }[] = []
  let ratio: RegExpExecArray | null
  while ((ratio = ratioRe.exec(tail)) !== null) {
    ratios.push({ count: parseHumanNumber(ratio[1]), total: parseHumanNumber(ratio[2]) })
  }

  const useExplicitUnits = explicitUnits.length > 0 && explicitUnits.length === ratios.length

  ratios.forEach((r, index) => {
    if (!Number.isFinite(r.count) || !Number.isFinite(r.total) || r.total <= 0) return
    const metric = useExplicitUnits ? explicitUnits[index] : fallbackMetricNames[index] ?? `Limit ${index + 1}`
    rows.push({
      name: `${name} ${metric}`,
      count: r.count,
      total: r.total,
      percent: parsePercent(r.count, r.total)
    })
  })

  return rows
}

export function parseGeminiUsageText(rawText: string): ScrapedUsageData | null {
  const text = normalizeText(rawText)
  const flat = text.replace(/\s+/g, ' ')
  const detectedPlanTier = detectGeminiTier(flat)
  const rows: MetricRow[] = []
  const seen = new Set<string>()

  const humanModelRe =
    /(Gemini\s+\d(?:\.\d+)?(?:\s+(?!(?:Text|Input|Output|Multi|Image|Audio|Video|Embedding|Model|Models|RPM|TPM|RPD)\b)[A-Za-z0-9.-]+){0,5})\s+([\s\S]{0,260}?)(?=Gemini\s+\d(?:\.\d+)?|$)/gi
  let humanMatch: RegExpExecArray | null

  while ((humanMatch = humanModelRe.exec(flat)) !== null) {
    const name = humanMatch[1].replace(/\s+/g, ' ').trim()
    const tail = humanMatch[2]
    for (const row of extractMetricRows(name, tail)) {
      const key = `${row.name}:${row.total}`
      if (!seen.has(key)) {
        seen.add(key)
        rows.push(row)
      }
    }
  }

  const apiModelRe = /(gemini[-\w.]*\d(?:[.-]\w+)*)\b([\s\S]{0,220}?)(?=gemini[-\w.]*\d|$)/gi
  let apiMatch: RegExpExecArray | null

  while ((apiMatch = apiModelRe.exec(flat)) !== null) {
    const name = apiMatch[1]
    const tail = apiMatch[2]
    for (const row of extractMetricRows(name, tail)) {
      const key = `${row.name}:${row.total}`
      if (!seen.has(key)) {
        seen.add(key)
        rows.push(row)
      }
    }
  }

  if (rows.length === 0) return null

  const ranked = [...rows].sort((a, b) => {
    if (b.percent !== a.percent) return b.percent - a.percent
    if (b.count !== a.count) return b.count - a.count
    return b.total - a.total
  })
  const primary = ranked[0]

  return {
    currentUsage: primary.count,
    usageLimit: primary.total,
    percentUsed: primary.percent,
    usageUnit: 'rate limits',
    resetsAt: null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    detectedPlanTier,
    subModels: ranked.map((row) => ({
      name: row.name,
      count: row.count,
      total: row.total
    }))
  }
}

function detectHiggsfieldTier(flatText: string): string | null {
  const tierMatch = flatText.match(
    /\b(Free|Basic|Starter|Standard|Creator|Plus|Pro|Premium|Ultimate|Business|Enterprise)\b(?:\s+(?:plan|tier|subscription))?/i
  )
  if (!tierMatch) return null

  return tierMatch[1].charAt(0).toUpperCase() + tierMatch[1].slice(1).toLowerCase()
}

function parseHiggsfieldCredits(text: string): {
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  label: string
  isRemaining: boolean
} | null {
  const flat = text.replace(/\s+/g, ' ')
  const ratioRe = /(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:\/|of)\s*(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*credits?/gi
  let ratio: RegExpExecArray | null

  while ((ratio = ratioRe.exec(flat)) !== null) {
    const first = parseHumanNumber(ratio[1])
    const total = parseHumanNumber(ratio[2])
    if (!Number.isFinite(first) || !Number.isFinite(total) || total <= 0) continue

    const context = flat.slice(Math.max(0, ratio.index - 80), ratio.index + ratio[0].length + 80)
    const isRemaining = /\b(remaining|left|available|balance)\b/i.test(context)
    const isUsed = /\b(used|spent|consumed)\b/i.test(context)
    // currentUsage is always normalized to USED in this branch: either the page
    // said "used" directly, or we derive used = total - remaining.
    const derivedFromRemaining = isRemaining && !isUsed
    const currentUsage = derivedFromRemaining ? Math.max(0, total - first) : first

    return {
      currentUsage,
      usageLimit: total,
      percentUsed: parsePercent(currentUsage, total),
      label: derivedFromRemaining || isUsed ? 'Credits used' : 'Credits',
      isRemaining: false
    }
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let best: { value: number; score: number } | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const joined = [lines[i - 1], line, lines[i + 1]].filter(Boolean).join(' ')
    if (!/credits?/i.test(joined)) continue

    const hasRemainingContext = /\b(remaining|left|available|balance)\b/i.test(joined)
    const lineHasRemainingContext = /\b(remaining|left|available|balance)\b/i.test(line)
    const actionContext = /\b(per|cost|price|buy|purchase|top[-\s]?up|add credits|claim discount|get|upgrade)\b/i

    if (actionContext.test(joined) && !hasRemainingContext) continue

    const numberMatch =
      line.match(/\b(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})*(?:\.\d+)?)\b/) ||
      joined.match(/\b(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})*(?:\.\d+)?)\b/)
    if (!numberMatch) continue

    const value = parseHumanNumber(numberMatch[1])
    if (!Number.isFinite(value)) continue

    let score = 1
    if (hasRemainingContext) score += 3
    if (lineHasRemainingContext) score += 2
    if (/^\s*credits?\s*$/i.test(line) || /^\s*\d/i.test(line)) score += 1
    if (/\b(used|spent|history|change)\b/i.test(joined)) score -= 2
    if (actionContext.test(line) && !lineHasRemainingContext) score -= 3

    if (!best || score > best.score) {
      best = { value, score }
    }
  }

  if (!best) return null

  // This branch yields a raw REMAINING balance (no total), unlike the ratio
  // branch above which normalizes to used — flag it so the UI renders it as a
  // remaining tracker instead of a used-of-total bar.
  return {
    currentUsage: best.value,
    usageLimit: null,
    percentUsed: null,
    label: 'Credits remaining',
    isRemaining: true
  }
}

export function parseHiggsfieldUsageText(rawText: string): ScrapedUsageData | null {
  const text = normalizeText(rawText)
  const flat = text.replace(/\s+/g, ' ')
  const credits = parseHiggsfieldCredits(text)

  if (!credits) return null

  return {
    currentUsage: credits.currentUsage,
    usageLimit: credits.usageLimit,
    percentUsed: credits.percentUsed,
    usageUnit: 'credits',
    resetsAt: null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    isRemainingTracker: credits.isRemaining,
    renewalDate: parseRenewalDateFromText(text),
    renewalKind: 'renewing',
    detectedPlanTier: detectHiggsfieldTier(flat),
    subModels: [
      {
        name: credits.label,
        count: credits.currentUsage,
        total: credits.usageLimit ?? undefined
      }
    ]
  }
}

// ─── Cursor ──────────────────────────────────────────────────
// Parser for Plan & Usage *text* (and stale spending-page overlays).
// Official numbers come from GetCurrentPeriodUsage, not /dashboard/spending.
// Handles:
//   - 2026 Plan & Usage: "Total Usage" % + "N% First-party models and M% API used"
//   - 2026 Ultra/Pro split: "Cursor Models" % + "Other Models" %
//   - post-June-2025 usage-based: "Included usage" % + $ ratio + spend
//   - retired: "Auto + Composer" / "API" / "Total" percentage rows
// Canonical pool names are "Cursor Models" and "Other Models" (legacy
// "First-party models" / "API" / "Auto + Composer" map onto those).
// The breakdown summary ("1% First-party models and 7% API used") is
// authoritative when present — a leftover "Other Models 0%" must not win.
// Returns null when no usage figures are present — never fabricates zeros.

// Month dictionary for Cursor's localized "Resets on 26. mai" strings
// (1-based; covers EN/NO/DA/DE/FR/ES/IT/NL renderings).
const CURSOR_LOCAL_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  // Norwegian / Danish
  januar: 1, februar: 2, marts: 3, mars: 3, mai: 5, juni: 6, juli: 7, oktober: 10, desember: 12,
  // German
  marz: 3, märz: 3, dezember: 12,
  // French
  janvier: 1, fevrier: 2, février: 2, avril: 4, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
  // Spanish / Italian
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7, settembre: 9, ottobre: 10, dicembre: 12,
  // Dutch
  januari: 1, februari: 2, maart: 3, mei: 5, augustus: 8
}

function parseDollarAmount(raw: string): number {
  const value = parseFloat(raw.replace(/[$,\s]/g, ''))
  return Number.isFinite(value) ? value : Number.NaN
}

const CURSOR_EN_MONTH =
  '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'

function cursorDateFromDayMonth(day: number, monthToken: string, explicitYear: number | null): string | null {
  const month = CURSOR_LOCAL_MONTHS[monthToken.toLowerCase()] ?? MONTHS[monthToken.toLowerCase()]
  if (month === undefined || day < 1 || day > 31) return null
  const now = new Date()
  let year = explicitYear ?? now.getFullYear()
  if (!explicitYear) {
    const candidate = new Date(year, month - 1, day)
    if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) year += 1
  }
  return toIsoDate(year, month, day)
}

function parseCursorResetInfo(text: string): { date: string; kind: RenewalKind } | null {
  // 1. "Resets on ..." in the plan card — checked BEFORE cancel/expire lines
  //    so "Credits expire on July 19, 2026" cannot hijack the plan reset.
  const resetLocal = text.match(/Resets?\s+on\s+(\d{1,2})\.?\s+([A-Za-zÀ-ÿ]+)(?:\s+(\d{4}))?/i)
  if (resetLocal) {
    const date = cursorDateFromDayMonth(
      parseInt(resetLocal[1], 10),
      resetLocal[2],
      resetLocal[3] ? parseInt(resetLocal[3], 10) : null
    )
    if (date) return { date, kind: 'renewing' }
  }

  const resetEn = text.match(
    new RegExp(`Resets?\\s+on\\s+${CURSOR_EN_MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i')
  )
  if (resetEn) {
    const date = cursorDateFromDayMonth(
      parseInt(resetEn[2], 10),
      resetEn[1],
      resetEn[3] ? parseInt(resetEn[3], 10) : null
    )
    if (date) return { date, kind: 'renewing' }
  }

  const daysHint = text.match(/Resets?[\s\S]{0,60}?\((\d+)\s+days?(?:\s+remaining)?\)/i)
  if (daysHint) {
    const n = parseInt(daysHint[1], 10)
    if (n >= 0 && n <= 400) {
      const future = new Date(Date.now() + n * 24 * 60 * 60 * 1000)
      return {
        date: toIsoDate(future.getFullYear(), future.getMonth() + 1, future.getDate()),
        kind: 'renewing'
      }
    }
  }

  // 2. "Cancels on September 12, 2026" — cancelled Ultra/Pro plans.
  const cancelLocal = text.match(/Cancels?\s+on\s+(\d{1,2})\.?\s+([A-Za-zÀ-ÿ]+)(?:\s+(\d{4}))?/i)
  if (cancelLocal) {
    const date = cursorDateFromDayMonth(
      parseInt(cancelLocal[1], 10),
      cancelLocal[2],
      cancelLocal[3] ? parseInt(cancelLocal[3], 10) : null
    )
    if (date) return { date, kind: 'cancelled' }
  }

  const cancelEn = text.match(
    new RegExp(`Cancels?\\s+on\\s+${CURSOR_EN_MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i')
  )
  if (cancelEn) {
    const date = cursorDateFromDayMonth(
      parseInt(cancelEn[2], 10),
      cancelEn[1],
      cancelEn[3] ? parseInt(cancelEn[3], 10) : null
    )
    if (date) return { date, kind: 'cancelled' }
  }

  const generic = parseRenewalDateFromText(text)
  return generic ? { date: generic, kind: 'renewing' } : null
}

/** First N% inside a labeled section, stopping before the next heading. */
function percentInSection(text: string, startRe: RegExp, stopRe: RegExp, maxLen = 360): number | null {
  const start = text.search(startRe)
  if (start < 0) return null
  const heading = text.slice(start).match(startRe)
  const headingLen = heading ? heading[0].length : 0
  let window = text.slice(start, start + maxLen)
  const stop = window.slice(headingLen).search(stopRe)
  if (stop >= 0) window = window.slice(0, headingLen + stop)
  const pct = window.match(/(\d{1,3})\s*%/)
  if (!pct) return null
  const n = parseInt(pct[1], 10)
  return n >= 0 && n <= 100 ? n : null
}

function parseCursorOnDemandUsd(flat: string): number | null {
  // Disabled on-demand has no spend meter. The $400 on Ultra is "includes at
  // least $400 of API usage" — an included allowance, not a spend figure.
  if (/on[-\s]?demand\s+spend(?:ing)?(?:\s+is)?(?:\s+currently)?\s+disabled/i.test(flat)) {
    return null
  }
  // Require the $ to sit immediately after the spend label. A loose
  // [^$]{0,80} walk from "on-demand spend" to the next $ grabbed the
  // included-allowance footnote as if it were usage.
  let m = flat.match(/usage[-\s]?based\s+spend[:\s]*\$\s*([\d,.]+)/i)
  if (!m) m = flat.match(/on[-\s]?demand\s+spend(?:ing)?[:\s]*\$\s*([\d,.]+)/i)
  if (!m) return null
  const spend = parseDollarAmount(m[1])
  return Number.isFinite(spend) ? spend : null
}

/** "20,00" (decimal comma) and "1,234.56" / "1.234,56" aware number parsing. */
function parseLocaleNumber(raw: string): number {
  let s = raw.trim()
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the rightmost separator is the decimal one.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.')
    else s = s.replace(/,/g, '')
  } else if (lastComma !== -1) {
    const decimals = s.length - lastComma - 1
    // "20,00" → decimal comma; "20,000" → thousands separator.
    s = decimals === 3 ? s.replace(/,/g, '') : s.replace(',', '.')
  }
  const value = parseFloat(s)
  return Number.isFinite(value) ? value : Number.NaN
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function parseCursorUsageText(rawText: string): ScrapedUsageData | null {
  const text = normalizeText(rawText)
  const flat = text.replace(/\s+/g, ' ')

  // ─── Plan tier ─────────────────────────────────────────────
  let detectedPlanTier: string | null = null
  const planBlock = flat.match(/current\s+plan[\s\S]{0,160}?\b(Pro\+|Pro|Business|Ultra|Hobby|Free|Teams?|Enterprise)\b/i)
  if (planBlock) {
    detectedPlanTier = planBlock[1]
  } else {
    const standalone = flat.match(/\b(Pro\+|Ultra|Business|Enterprise|Hobby)\s*(?:plan|\$\d)/i)
    if (standalone) detectedPlanTier = standalone[1]
  }

  // ─── Included-usage percent (post-June-2025 layout) ────────
  let includedPct: number | null = null
  let includedUsedUsd: number | null = null
  let includedLimitUsd: number | null = null

  let m = flat.match(/included\s+(?:plan\s+)?usage[\s\S]{0,150}?(\d{1,3})\s*%/i)
  if (m) includedPct = parseInt(m[1], 10)

  if (includedPct === null) {
    m = flat.match(/(\d{1,3})\s*%\s*(?:used\s+)?of\s+(?:the\s+)?included/i)
    if (m) includedPct = parseInt(m[1], 10)
  }

  // "$7.32 of $20.00" / "$7.32 / $20" near an "included" label.
  const includedIdx = flat.search(/included/i)
  if (includedIdx !== -1) {
    const window = flat.slice(includedIdx, includedIdx + 260)
    const ratio = window.match(/\$\s*([\d,.]+)\s*(?:\/|of)\s*\$?\s*([\d,.]+)/i)
    if (ratio) {
      const used = parseDollarAmount(ratio[1])
      const limit = parseDollarAmount(ratio[2])
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
        includedUsedUsd = used
        includedLimitUsd = limit
        if (includedPct === null) includedPct = Math.round((used / limit) * 100)
      }
    }
  }

  // ─── Usage-based / on-demand spend (post-June-2025 layout) ─
  const onDemandUsd = parseCursorOnDemandUsd(flat)

  // ─── Retired layout: Auto + Composer / API / Total rows ────
  let autoPct: number | null = null
  m = flat.match(/Auto\s*\+\s*Composer[\s\S]{0,80}?(\d+)\s*%/i)
  if (m) autoPct = parseInt(m[1], 10)
  if (autoPct === null) {
    m = flat.match(/(\d+)\s*%\s*Auto\s*(?:and|\+)/i)
    if (m) autoPct = parseInt(m[1], 10)
  }

  // Authoritative Plan & Usage breakdown, e.g.
  //   "1% First-party models and 7% API used"
  //   "1% Auto and 33% API used"
  // This line is the page's own combined readout. It must win over a
  // leftover "Other Models 0%" section (stale SPA / chart legend).
  let summaryCursorPct: number | null = null
  let summaryOtherPct: number | null = null
  m = flat.match(
    /(\d{1,3})\s*%\s*(?:First-party models|Cursor Models|Auto(?:\s*\+\s*Composer)?)\s+and\s+(\d{1,3})\s*%\s*(?:API|Other Models)\s*used/i
  )
  if (m) {
    const a = parseInt(m[1], 10)
    const b = parseInt(m[2], 10)
    if (a >= 0 && a <= 100 && b >= 0 && b <= 100) {
      summaryCursorPct = a
      summaryOtherPct = b
    }
  }

  // ─── Cursor Models (2026 "Cursor Models N% used" + First-party) ─
  let cursorModelsPct = percentInSection(
    text,
    /Cursor\s+Models\b/i,
    /Other\s+Models\b(?!\s+quota)|First-party models\b|(?:^|\n)\s*API\b|On[-\s]?Demand|Usage[-\s]?based/i
  )
  if (cursorModelsPct === null) {
    cursorModelsPct = percentInSection(
      text,
      /(?:^|\n)\s*First-party models\b(?!\s+and\s+\d)/i,
      /and\s+\d{1,3}\s*%\s*(?:API|Other Models)|(?:^|\n)\s*API\b|Other\s+Models\b|On[-\s]?Demand|Usage[-\s]?based/i
    )
  }
  if (cursorModelsPct === null) {
    m = flat.match(/(\d{1,3})\s*%\s*(?:used\s+)?(?:of\s+)?Cursor\s+Models/i)
    if (m) cursorModelsPct = parseInt(m[1], 10)
  }
  if (cursorModelsPct === null) {
    m = flat.match(/(\d{1,3})\s*%\s*First-party models/i)
    if (m) cursorModelsPct = parseInt(m[1], 10)
  }
  if (cursorModelsPct === null) cursorModelsPct = autoPct

  // ─── Other Models (2026 heading + "API" meter) ─────────────
  let otherModelsPct = percentInSection(
    text,
    /Other\s+Models\b(?!\s+quota)/i,
    /On[-\s]?Demand|Usage[-\s]?based|Monthly Limit/i
  )
  if (otherModelsPct === null) {
    otherModelsPct = percentInSection(
      text,
      /(?:^|\n)\s*API\b(?!\s+(?:usage|quota|used|keys?|agent))/i,
      /On[-\s]?Demand|Usage[-\s]?based|Monthly Limit/i
    )
  }
  if (otherModelsPct === null) {
    m = flat.match(/(\d{1,3})\s*%\s*(?:used\s+)?(?:of\s+)?Other\s+Models/i)
    if (m) otherModelsPct = parseInt(m[1], 10)
  }
  if (otherModelsPct === null) {
    m = text.match(/(?:^|\n)\s*API\s*\n\s*(\d{1,3})\s*%/i)
    if (m) otherModelsPct = parseInt(m[1], 10)
  }
  if (otherModelsPct === null) {
    m = flat.match(/\bAPI\s+(\d{1,3})\s*%/i)
    if (m) otherModelsPct = parseInt(m[1], 10)
  }
  if (otherModelsPct === null) {
    m = flat.match(/(\d+)\s*%\s*API\s*used/i)
    if (m) otherModelsPct = parseInt(m[1], 10)
  }

  if (summaryCursorPct !== null) {
    if (cursorModelsPct !== null && cursorModelsPct !== summaryCursorPct) {
      console.log(`[cursor] Summary First-party ${summaryCursorPct}% overrides section ${cursorModelsPct}%`)
    }
    cursorModelsPct = summaryCursorPct
  }
  if (summaryOtherPct !== null) {
    if (otherModelsPct !== null && otherModelsPct !== summaryOtherPct) {
      console.log(`[cursor] Summary API ${summaryOtherPct}% overrides section ${otherModelsPct}%`)
    }
    otherModelsPct = summaryOtherPct
  }

  // Explicit "Total" / "Total Usage" row only. Do NOT treat "Included in
  // Ultra" as Total — that heading's first % is Cursor Models on the split
  // layout that has no combined meter.
  let totalPct: number | null = null
  m = text.match(/(?:^|\n)\s*Total(?:\s+Usage)?\s*\n\s*(\d{1,3})\s*%/im)
  if (!m) m = flat.match(/\bTotal(?:\s+Usage)?\s+(\d{1,3})\s*%(?:\s|$)/i)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 0 && n <= 100) totalPct = n
  }

  // ─── Credit balance ("20,00 USD remaining") ─────────────────
  let creditBalance: number | null = null
  m = flat.match(/(\d[\d.,]*)\s*USD\s*remaining/i)
  if (m) {
    const balance = parseLocaleNumber(m[1])
    if (Number.isFinite(balance)) creditBalance = balance
  }

  // ─── Last resort: any percentage in a usage context ────────
  if (
    includedPct === null &&
    autoPct === null &&
    cursorModelsPct === null &&
    otherModelsPct === null &&
    totalPct === null
  ) {
    m = flat.match(/(?:usage|used)[^\n]{0,60}?(\d{1,3})\s*%/i) || flat.match(/(\d{1,3})\s*%/)
    if (m) includedPct = parseInt(m[1], 10)
  }

  // ─── Reset / renewal / cancel date ─────────────────────────
  const resetInfo = parseCursorResetInfo(text)
  const resetDate = resetInfo?.date ?? null
  const resetIso = resetDate ? `${resetDate}T00:00:00.000Z` : null

  // ─── Compose ───────────────────────────────────────────────
  // Named Cursor Models + Other Models without an explicit Total row → the
  // 2026 split layout. Primary = Cursor Models; weekly = Other Models.
  // When Total is present (older spending page), keep Total as the headline.
  const namedSplitWithoutTotal =
    cursorModelsPct !== null && otherModelsPct !== null && totalPct === null && includedPct === null
  const primaryRaw = namedSplitWithoutTotal
    ? cursorModelsPct
    : (includedPct ?? totalPct ?? cursorModelsPct ?? autoPct ?? otherModelsPct)
  if (primaryRaw === null && onDemandUsd === null) return null
  const primary = primaryRaw !== null ? clampPercent(primaryRaw) : 0

  const subModels: NonNullable<ScrapedUsageData['subModels']> = []
  if (includedUsedUsd !== null && includedLimitUsd !== null) {
    subModels.push({ name: 'Included usage', count: includedUsedUsd, total: includedLimitUsd })
  }
  if (cursorModelsPct !== null) {
    subModels.push({ name: 'Cursor Models', count: cursorModelsPct, total: 100 })
  }
  if (otherModelsPct !== null) {
    subModels.push({ name: 'Other Models', count: otherModelsPct, total: 100 })
  }

  const weeklyPct = otherModelsPct

  console.log(
    `[cursor] Parsed: included=${includedPct}%, total=${totalPct}%, cursorModels=${cursorModelsPct}%, ` +
    `otherModels=${otherModelsPct}%, auto=${autoPct}%, onDemand=$${onDemandUsd}, credits=${creditBalance}, ` +
    `plan=${detectedPlanTier}, reset=${resetDate} (${resetInfo?.kind ?? 'none'})`
  )

  return {
    currentUsage: primary,
    usageLimit: 100,
    percentUsed: primary,
    usageUnit: '%',
    resetsAt: resetIso,
    weeklyUsage: weeklyPct !== null ? weeklyPct : null,
    weeklyLimit: weeklyPct !== null ? 100 : null,
    weeklyPercentUsed: weeklyPct,
    weeklyResetsAt: null,
    weeklyBarLabel: weeklyPct !== null ? 'Other Models' : undefined,
    totalPercent: totalPct,
    totalBarLabel: totalPct !== null ? 'Total' : undefined,
    isRemainingTracker: false,
    renewalDate: resetDate,
    renewalKind: resetInfo?.kind ?? (resetDate ? 'renewing' : null),
    detectedPlanTier,
    subModels: subModels.length > 0 ? subModels : undefined,
    agentCredits: creditBalance !== null
      ? { balance: creditBalance, membership: 0, valueAdded: 0, bonus: 0, debt: 0, dailyFree: 0, spendingHistory: [] }
      : undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finitePct(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseFloat(value) : Number.NaN
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return n
}

function cursorApiDate(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = n < 1e12 ? n * 1000 : n
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

function findDeep(
  value: unknown,
  match: (obj: Record<string, unknown>) => boolean,
  depth = 0
): Record<string, unknown> | null {
  const obj = asRecord(value)
  if (!obj || depth > 6) return null
  if (match(obj)) return obj
  for (const child of Object.values(obj)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const hit = findDeep(item, match, depth + 1)
        if (hit) return hit
      }
    } else {
      const hit = findDeep(child, match, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Cursor IDE / dashboard JSON (GetCurrentPeriodUsage). The spending-page DOM
 * can stay on a stale "Other Models 0%" snapshot while these fields match
 * Settings → Plan & Usage (Total / First-party / API).
 */
export function parseCursorPeriodUsageJson(raw: unknown): ScrapedUsageData | null {
  const plan = findDeep(raw, (obj) =>
    'autoPercentUsed' in obj || 'apiPercentUsed' in obj || 'totalPercentUsed' in obj ||
    'auto_percent_used' in obj || 'api_percent_used' in obj || 'total_percent_used' in obj
  )
  if (!plan) return null

  const cursorModelsPct = finitePct(plan.autoPercentUsed ?? plan.auto_percent_used)
  const otherModelsPct = finitePct(plan.apiPercentUsed ?? plan.api_percent_used)
  const totalPct = finitePct(plan.totalPercentUsed ?? plan.total_percent_used)
  if (cursorModelsPct === null && otherModelsPct === null && totalPct === null) return null

  const dated = findDeep(raw, (obj) =>
    'billingCycleEnd' in obj || 'billing_cycle_end' in obj || 'cancelAtPeriodEnd' in obj
  ) ?? asRecord(raw) ?? plan
  const billingEnd = cursorApiDate(
    dated.billingCycleEnd ?? dated.billing_cycle_end ??
    asRecord(dated.planInfo)?.billingCycleEnd
  )
  const cancelFlag = dated.cancelAtPeriodEnd ?? dated.cancel_at_period_end
  const renewalKind: RenewalKind | null =
    cancelFlag === true ? 'cancelled' : cancelFlag === false ? 'renewing' : (billingEnd ? 'renewing' : null)

  const namedSplitWithoutTotal =
    cursorModelsPct !== null && otherModelsPct !== null && totalPct === null
  const primaryRaw = namedSplitWithoutTotal
    ? cursorModelsPct
    : (totalPct ?? cursorModelsPct ?? otherModelsPct)
  if (primaryRaw === null) return null
  const primary = clampPercent(primaryRaw)
  const weeklyPct = otherModelsPct !== null ? clampPercent(otherModelsPct) : null
  const cursorRounded = cursorModelsPct !== null ? clampPercent(cursorModelsPct) : null

  const subModels: NonNullable<ScrapedUsageData['subModels']> = []
  if (cursorRounded !== null) subModels.push({ name: 'Cursor Models', count: cursorRounded, total: 100 })
  if (weeklyPct !== null) subModels.push({ name: 'Other Models', count: weeklyPct, total: 100 })

  const resetIso = billingEnd ? `${billingEnd}T00:00:00.000Z` : null
  console.log(
    `[cursor] API usage: total=${totalPct}%, auto=${cursorModelsPct}%, api=${otherModelsPct}%, ` +
    `billingEnd=${billingEnd}, cancel=${String(cancelFlag)}`
  )

  return {
    currentUsage: primary,
    usageLimit: 100,
    percentUsed: primary,
    usageUnit: '%',
    resetsAt: resetIso,
    weeklyUsage: weeklyPct,
    weeklyLimit: weeklyPct !== null ? 100 : null,
    weeklyPercentUsed: weeklyPct,
    weeklyResetsAt: null,
    weeklyBarLabel: weeklyPct !== null ? 'Other Models' : undefined,
    totalPercent: totalPct !== null ? clampPercent(totalPct) : null,
    totalBarLabel: totalPct !== null ? 'Total' : undefined,
    isRemainingTracker: false,
    renewalDate: billingEnd,
    renewalKind,
    detectedPlanTier: null,
    subModels: subModels.length > 0 ? subModels : undefined
  }
}

/** API pool percents win over a stale spending-page DOM (Other Models 0% / Cancels). */
export function mergeCursorDomWithApi(
  dom: ScrapedUsageData | null,
  api: ScrapedUsageData | null
): ScrapedUsageData | null {
  if (!api) return dom
  if (!dom) return api

  const apiOther = api.weeklyPercentUsed
  const domOther = dom.weeklyPercentUsed
  const apiOverridesPools = apiOther != null || (api.subModels ?? []).some((row) => row.name === 'Cursor Models')

  const renewalKind: RenewalKind | null =
    api.renewalKind === 'cancelled' || api.renewalKind === 'renewing'
      ? api.renewalKind
      : (api.renewalDate ? 'renewing' : (dom.renewalKind ?? null))

  const merged: ScrapedUsageData = {
    ...dom,
    ...(apiOverridesPools ? {
      currentUsage: api.currentUsage,
      usageLimit: api.usageLimit,
      percentUsed: api.percentUsed,
      weeklyUsage: api.weeklyUsage,
      weeklyLimit: api.weeklyLimit,
      weeklyPercentUsed: api.weeklyPercentUsed,
      weeklyBarLabel: api.weeklyBarLabel ?? dom.weeklyBarLabel,
      totalPercent: api.totalPercent ?? dom.totalPercent,
      totalBarLabel: api.totalBarLabel ?? dom.totalBarLabel,
      subModels: api.subModels ?? dom.subModels
    } : {}),
    detectedPlanTier: api.detectedPlanTier ?? dom.detectedPlanTier,
    renewalDate: api.renewalDate ?? dom.renewalDate,
    renewalKind,
    resetsAt: api.resetsAt ?? dom.resetsAt
  }

  if (apiOther != null && domOther != null && apiOther !== domOther) {
    console.log(`[cursor] API Other Models ${apiOther}% overrides DOM ${domOther}%`)
  }
  return merged
}

// ─── Kimi membership quota page ──────────────────────────────
// Parser for kimi.ai/membership/subscription?tab=quota. Layout (EN):
//   Allegro
//   Quota reset monthly
//   Next auto-renewal date: 2026-08-17
//   Usage Progress
//   Total usage 48.75%            Resets in 2026-08-17
//   5-hour usage  Code 0.9%       Resets in 07-17 15:41
//   7-day usage   Code 2.75%      Resets in 07-24 00:41
// Returns null when no quota figures are present.

const KIMI_MEMBERSHIP_PLAN_RE = /\b(Free|Adagio|Allegretto|Allegro|Moderato|Forte|Presto|Vivace)\b/i

function kimiSectionSlice(text: string, sectionRe: RegExp, window = 350): string | null {
  const m = text.match(sectionRe)
  if (!m || m.index === undefined) return null
  return text.slice(m.index, m.index + window)
}

function kimiPercentOf(slice: string | null): number | null {
  if (!slice) return null
  const m = slice.match(/(\d+(?:\.\d+)?)\s*%/)
  return m ? parseFloat(m[1]) : null
}

/** "07-17 15:41" (MM-DD HH:mm) → ISO. Reset times are forward-looking: a
 * candidate more than `maxPastHours` in the past means next year. */
function kimiShortResetToIso(mm: string, dd: string, hh: string, mi: string, maxPastHours: number): string | null {
  const month = parseInt(mm, 10)
  const day = parseInt(dd, 10)
  const hour = parseInt(hh, 10)
  const minute = parseInt(mi, 10)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const now = new Date()
  let candidate = new Date(now.getFullYear(), month - 1, day, hour, minute)
  if (candidate.getTime() < now.getTime() - maxPastHours * 60 * 60 * 1000) {
    candidate = new Date(now.getFullYear() + 1, month - 1, day, hour, minute)
  }
  return candidate.toISOString()
}

function kimiShortResetOf(slice: string | null): string | null {
  if (!slice) return null
  const m = slice.match(/Resets in (\d{2})-(\d{2})\s+(\d{2}):(\d{2})/i)
  if (!m) return null
  return kimiShortResetToIso(m[1], m[2], m[3], m[4], 12)
}

export function parseKimiMembershipText(rawText: string): ScrapedUsageData | null {
  const text = normalizeText(rawText)

  const totalSlice = kimiSectionSlice(text, /Total usage|总用量|本月用量/i)
  const fiveHourSlice = kimiSectionSlice(text, /5-hour usage|5\s*小时用量/i)
  const sevenDaySlice = kimiSectionSlice(text, /7-day usage|7\s*天用量/i)

  const totalPct = kimiPercentOf(totalSlice)
  const fiveHourPct = kimiPercentOf(fiveHourSlice)
  const sevenDayPct = kimiPercentOf(sevenDaySlice)

  if (totalPct === null && fiveHourPct === null && sevenDayPct === null) return null

  // Monthly reset: "Resets in 2026-08-17" after the Total usage row.
  let monthlyReset: string | null = null
  if (totalSlice) {
    const m = totalSlice.match(/Resets in (\d{4})-(\d{2})-(\d{2})/i) ||
      totalSlice.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
    if (m) monthlyReset = `${m[1]}-${m[2]}-${m[3]}`
  }

  const fiveHourResetIso = kimiShortResetOf(fiveHourSlice)
  const sevenDayResetIso = kimiShortResetOf(sevenDaySlice)

  const planMatch = text.match(KIMI_MEMBERSHIP_PLAN_RE)
  const detectedPlanTier = planMatch ? planMatch[1] : null

  // "Next auto-renewal date: 2026-08-17" → subscription renewal.
  let renewalDate: string | null = null
  const renewalMatch = text.match(/Next auto-renewal date:\s*(\d{4})-(\d{2})-(\d{2})/i)
  if (renewalMatch) {
    renewalDate = `${renewalMatch[1]}-${renewalMatch[2]}-${renewalMatch[3]}`
  } else {
    renewalDate = parseRenewalDateFromText(text)
  }

  // The guard above returns when all three are null, so one branch is always
  // non-null here; the trailing ?? 0 only satisfies the type checker.
  const primary = totalPct ?? sevenDayPct ?? fiveHourPct ?? 0

  const subModels: NonNullable<ScrapedUsageData['subModels']> = []
  if (fiveHourPct !== null) {
    subModels.push({ name: '5-hour usage (Code)', count: fiveHourPct, total: 100, resetsAt: fiveHourResetIso })
  }

  console.log(
    `[kimi-code] Membership parsed: total=${totalPct}%, 5h=${fiveHourPct}%, 7d=${sevenDayPct}%, ` +
    `plan=${detectedPlanTier}, monthlyReset=${monthlyReset}, renewal=${renewalDate}`
  )

  return {
    currentUsage: primary,
    usageLimit: 100,
    percentUsed: primary,
    usageUnit: '% used',
    resetsAt: monthlyReset ? `${monthlyReset}T00:00:00.000Z` : null,
    weeklyUsage: sevenDayPct,
    weeklyLimit: sevenDayPct !== null ? 100 : null,
    weeklyPercentUsed: sevenDayPct,
    weeklyResetsAt: sevenDayResetIso,
    weeklyBarLabel: sevenDayPct !== null ? '7-day' : undefined,
    renewalDate,
    renewalKind: renewalDate ? 'renewing' : null,
    detectedPlanTier,
    subModels: subModels.length > 0 ? subModels : undefined
  }
}

// ─── Gemini web app (gemini.google.com/u/1/usage) ───────────────────────────
//
// Distinct from parseGeminiUsageText above, which reads the AI Studio API
// rate-limit table. This is the consumer plan's usage panel:
//   "Usage limits  PRO / Current usage  9% used  Resets at 7:21 PM /
//    Weekly limit  0% used  Resets Jul 26 at 2:21 PM"
// There is no per-model breakdown on this page.

/** "Resets at 7:21 PM" / "Resets Jul 26 at 2:21 PM" → ISO timestamp. */
function parseGeminiResetPhrase(segment: string, now: Date): string | null {
  const m = segment.match(
    /Resets\s+(?:at\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i
  )
  if (!m) return null

  let hours = parseInt(m[3], 10)
  const minutes = parseInt(m[4], 10)
  const ampm = m[5].toUpperCase()
  if (ampm === 'PM' && hours < 12) hours += 12
  if (ampm === 'AM' && hours === 12) hours = 0

  if (m[1]) {
    const month = MONTHS[m[1].toLowerCase()]
    if (!month) return null
    const day = parseInt(m[2], 10)
    let year = now.getFullYear()
    const candidate = new Date(year, month - 1, day, hours, minutes, 0, 0)
    // No year on the page: a date already behind us means next January's.
    if (candidate.getTime() < now.getTime()) {
      year += 1
      return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString()
    }
    return candidate.toISOString()
  }

  // Time-only ⇒ today, or tomorrow once today's slot has passed.
  const d = new Date(now)
  d.setHours(hours, minutes, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.toISOString()
}

export function parseGeminiWebUsageText(
  rawText: string,
  now: Date = new Date()
): ScrapedUsageData | null {
  if (!rawText) return null
  const text = normalizeText(rawText).replace(/\s+/g, ' ')

  if (/Sign in to continue|Use your Google Account/i.test(text)) return null

  // Scope each "Resets ..." to its own section: the page prints two, and an
  // unscoped search would give the current-usage bar the weekly reset.
  const weeklyIdx = text.search(/Weekly\s+limit/i)
  const currentSegment = weeklyIdx > 0 ? text.slice(0, weeklyIdx) : text
  const weeklySegment = weeklyIdx > 0 ? text.slice(weeklyIdx) : ''

  const currentM = currentSegment.match(/Current\s+usage[\s\S]{0,80}?(\d+(?:\.\d+)?)\s*%\s*used/i)
  const weeklyM = weeklySegment.match(/Weekly\s+limit[\s\S]{0,80}?(\d+(?:\.\d+)?)\s*%\s*used/i)
  if (!currentM && !weeklyM) return null

  const currentPct = currentM ? parseFloat(currentM[1]) : null
  const weeklyPct = weeklyM ? parseFloat(weeklyM[1]) : null

  // The plan chip sits immediately after the "Usage limits" heading.
  // Kept verbatim ("PRO"), matching how the page renders it.
  let detectedPlanTier: string | null = null
  const tierM = text.match(/Usage\s+limits\s+(PRO|ULTRA|FREE|ADVANCED|Pro|Ultra|Free|Advanced)\b/)
  if (tierM) detectedPlanTier = tierM[1]

  const primaryPct = currentPct !== null ? currentPct : weeklyPct

  return {
    currentUsage: primaryPct ?? 0,
    usageLimit: 100,
    percentUsed: primaryPct,
    usageUnit: '% current usage',
    resetsAt: currentM ? parseGeminiResetPhrase(currentSegment, now) : null,
    weeklyUsage: weeklyPct,
    weeklyLimit: weeklyPct !== null ? 100 : null,
    weeklyPercentUsed: weeklyPct,
    weeklyResetsAt: weeklyM ? parseGeminiResetPhrase(weeklySegment, now) : null,
    detectedPlanTier
  }
}

// ─── Grok (grok.com/?_s=usage settings dialog) ──────────────────────────────
//
// Primary meter on grok.com is the WEEKLY SuperGrok (Heavy) limit — a percent
// used plus an absolute reset ("Resets July 31, 2026 at 4:42 PM"). That is what
// the Agent Stats card must headline. The rolling /rest/rate-limits pools
// (e.g. grok-4 0/140 / 2h) are short-term throttles and only belong as
// secondary rows.
//
// Two live quirks the parser has to absorb:
//  1. rAF count-up on the headline: offscreen Chrome can yield
//     "Weekly SuperGrok Heavy Limit used" with the number still empty. When the
//     older static product breakdown ("Grok Build 18% API 5% Chat 1%") is
//     present, those products partition the same weekly pool and their sum
//     reconstructs the headline (18+5+1 = 24).
//  2. 2026-07 layout: at low/zero usage the product breakdown is often omitted
//     entirely — only "0% used" + reset + Extra Usage Credits remain. In that
//     case the stated headline (or a DOM/aria hint from the scraper) is the
//     only source; never invent a percent, and never fall back to rate-limit
//     pools as the primary just because products are gone.

export interface GrokDialogParseHints {
  /** Percent taken from aria/progress/DOM when innerText lost the count-up. */
  weeklyPct?: number | null
  /** ISO reset timestamp already resolved by the scraper, if any. */
  resetsAt?: string | null
  /** Extra usage credit balance in USD, when scraped from structured DOM. */
  creditsUsd?: number | null
}

export function parseGrokUsageDialogText(
  text: string,
  now: Date = new Date(),
  hints: GrokDialogParseHints = {}
): ScrapedUsageData | null {
  if (!text && hints.weeklyPct == null) return null

  // Normalize NBSP / fullwidth percent so "0％ used" and "0% used" both match.
  const normalized = (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[％]/g, '%')
    .replace(/[ \t]+/g, ' ')

  const headerM = normalized.match(/Weekly\s+(SuperGrok(?:\s+Heavy)?|Grok)?\s*Limit/i)
  // Allow a hint-only parse when the scraper already confirmed the weekly panel
  // (e.g. aria-valuenow on the SuperGrok bar) but innerText was sparse.
  if (!headerM && hints.weeklyPct == null) return null

  // "API" was missing from this list, so the API row was dropped from the
  // breakdown even when the dialog rendered fully.
  const subModels: NonNullable<ScrapedUsageData['subModels']> = []
  const productRe =
    /(Grok Build|DeepSearch|Imagine|Search|Voice|Tasks?|Chat|Build|API)\s*(\d+(?:\.\d+)?)\s*%/gi
  let pm: RegExpExecArray | null
  while ((pm = productRe.exec(normalized)) !== null) {
    const pct = parseFloat(pm[2])
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue
    const name = pm[1]
    if (subModels.some((s) => (s.name || '').toLowerCase() === name.toLowerCase())) continue
    subModels.push({ name, count: pct, total: 100 })
  }

  // Prefer the number the page states. Only reconstruct when it is absent.
  // CRITICAL: bind the % to the Limit headline (before Resets). A wide
  // [\s\S]{0,240}? window used to grab a later product "Imagine 100% used"
  // (or any first "% used" on the page) and report it as the weekly total —
  // which is exactly the "100% right after weekly reset" failure mode when
  // the rAF headline is still empty.
  let weeklyPct: number | null = null
  const explicitPatterns = [
    // "Weekly SuperGrok Heavy Limit 0% used" — number glued to the header
    /Weekly\s+(?:SuperGrok(?:\s+Heavy)?|Grok)?\s*Limit\s+(\d+(?:\.\d+)?)\s*%\s*used/i,
    // Same, allowing a short gap, but requiring Resets immediately after so
    // we never walk into the product breakdown.
    /Weekly\s+(?:SuperGrok(?:\s+Heavy)?|Grok)?\s*Limit[\s\S]{0,60}?(\d+(?:\.\d+)?)\s*%\s*used[\s\S]{0,40}?Resets/i,
    // "SuperGrok Heavy 0% used" / "Heavy Limit 0% used" without "Weekly"
    /(?:SuperGrok(?:\s+Heavy)?|Heavy\s+Limit)\s+(\d+(?:\.\d+)?)\s*%\s*used/i
  ]
  for (const re of explicitPatterns) {
    const m = normalized.match(re)
    if (!m) continue
    const v = parseFloat(m[1])
    if (Number.isFinite(v) && v >= 0 && v <= 100) {
      weeklyPct = v
      break
    }
  }

  // Scraper-supplied DOM/aria hint wins only when text did not state a number
  // (rAF-empty headline). Never override a real page figure *when products
  // agree*. Distrust a lone 100% hint: the progress TRACK is style width:100%
  // at every usage level including 0%. After a weekly reset the fill is empty,
  // products are omitted, and the rAF headline is blank — that used to surface
  // as "100% used". Accept 100 only when the page text or product sum
  // corroborates.
  if (weeklyPct === null && hints.weeklyPct != null) {
    const v = Number(hints.weeklyPct)
    if (Number.isFinite(v) && v >= 0 && v <= 100) {
      const rounded = Math.round(v * 10) / 10
      const textSays100 = /100(?:\.0+)?\s*%\s*used/i.test(normalized)
      const productSum = subModels.reduce((acc, s) => acc + (s.count ?? 0), 0)
      const productsNear100 = subModels.length > 0 && productSum >= 90
      if (rounded >= 99.5 && !textSays100 && !productsNear100) {
        // Uncorroborated full-bar hint — almost always the track, not usage.
      } else {
        weeklyPct = rounded
      }
    }
  }

  const productSum =
    subModels.length > 0
      ? Math.round(subModels.reduce((acc, s) => acc + (s.count ?? 0), 0) * 10) / 10
      : null

  if (weeklyPct === null && productSum != null && productSum >= 0 && productSum <= 100) {
    // rAF-empty headline: product rows partition the same weekly pool.
    weeklyPct = productSum
  }

  // Stalled / partial rAF count-up (live bug 2026-07-31 → 2026-08-01):
  // headline freezes at a low digit (often 1%) while static product rows keep
  // climbing (Grok Build 8% + Chat 1% …). Healthy history shows the weekly
  // total equals the product sum when the breakdown is present — so when the
  // sum clearly exceeds the stated headline, prefer the sum.
  // Still prefer a higher stated total over a lower sum (incomplete breakdown).
  if (
    weeklyPct != null &&
    productSum != null &&
    productSum <= 100 &&
    productSum > weeklyPct + 1.05
  ) {
    weeklyPct = productSum
  }

  // Zero-usage layout after a weekly reset: header + Resets present, no
  // headline number, no product rows. Prefer 0 over falling back to rolling
  // 2h pools (which would mislabel the card as "queries used / 2h").
  if (
    weeklyPct === null &&
    headerM &&
    subModels.length === 0 &&
    /Resets\s+[A-Za-z]+/i.test(normalized)
  ) {
    weeklyPct = 0
  }

  if (weeklyPct === null) return null

  // "Resets July 24, 2026 at 4:42 PM" — V8 parses it once " at " is dropped.
  let resetsAt: string | null = null
  if (hints.resetsAt) {
    const t = Date.parse(hints.resetsAt)
    if (Number.isFinite(t) && t > now.getTime() && t < now.getTime() + 32 * 24 * 3600 * 1000) {
      resetsAt = new Date(t).toISOString()
    }
  }
  if (!resetsAt) {
    const resetM = normalized.match(
      /Resets\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]M)?/i
    )
    if (resetM) {
      const t = Date.parse(`${resetM[1]} ${resetM[2] ?? '12:00 AM'}`)
      if (Number.isFinite(t) && t > now.getTime() && t < now.getTime() + 32 * 24 * 3600 * 1000) {
        resetsAt = new Date(t).toISOString()
      }
    }
  }

  // "Extra Usage Credits … $0.00". Same count-up treatment as the headline, so
  // it is frequently absent; omitted rather than reported as a zero balance
  // UNLESS the scraper resolved it from structured DOM (hint).
  let agentCredits: ScrapedUsageData['agentCredits'] | undefined
  const credM = normalized.match(/Extra\s+Usage\s+Credits[\s\S]{0,120}?\$\s*([\d,]+(?:\.\d+)?)/i)
  const credRaw =
    credM?.[1] ??
    (hints.creditsUsd != null && Number.isFinite(hints.creditsUsd) ? String(hints.creditsUsd) : null)
  if (credRaw != null) {
    const bal = parseFloat(String(credRaw).replace(/,/g, ''))
    if (Number.isFinite(bal) && bal >= 0) {
      agentCredits = {
        balance: bal,
        membership: 0,
        valueAdded: 0,
        bonus: 0,
        debt: 0,
        dailyFree: 0,
        spendingHistory: []
      }
    }
  }

  const tier = headerM?.[1] ? headerM[1].replace(/\s+/g, ' ').trim() : 'SuperGrok'

  return {
    currentUsage: weeklyPct,
    usageLimit: 100,
    percentUsed: weeklyPct,
    // Percent of the WEEKLY SuperGrok Heavy allowance — not the 2h query pool.
    usageUnit: 'weekly used',
    resetsAt,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    subModels: subModels.length > 0 ? subModels : undefined,
    agentCredits,
    detectedPlanTier: tier && /supergrok/i.test(tier) ? tier : null
  }
}

// ─── Grok Bot weekly (Cursor Sand / GetSandUsageStatus) ─────────────────────
//
// CaptainGrok's "Weekly usage 15% / Resets in 6 days" is NOT the SuperGrok
// Heavy pool on grok.com. It is the Cursor-account Grok Bot included
// allowance (internally Sand). Live 2026-08-28:
//   POST api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus
//   { usagePercent: 15.46571, nextResetTimestampUtc: "2026-09-02T…",
//     hasNonZeroIncludedLimit: true, grokPlanLabel: "Grok Bot Plan" }
// Hide the row when the account has no included Bot allowance. Never fold
// this percent into Grok weekly product rows or DualWindow weekly*.

export type GrokBotSandParse =
  | { kind: 'usage'; percentUsed: number; resetsAt: string | null }
  | { kind: 'none' }

export function parseGrokBotSandJson(raw: unknown): GrokBotSandParse | null {
  const obj = findDeep(raw, (candidate) =>
    'usagePercent' in candidate ||
    'usage_percent' in candidate ||
    'hasNonZeroIncludedLimit' in candidate ||
    'has_non_zero_included_limit' in candidate
  )
  if (!obj) return null

  const hasLimit = obj.hasNonZeroIncludedLimit ?? obj.has_non_zero_included_limit
  if (hasLimit === false) return { kind: 'none' }

  const pct = finitePct(obj.usagePercent ?? obj.usage_percent)
  if (pct === null) return null

  const resetRaw =
    obj.nextResetTimestampUtc ??
    obj.next_reset_timestamp_utc ??
    obj.nextResetAt ??
    obj.next_reset_at
  let resetsAt: string | null = null
  if (typeof resetRaw === 'string') {
    const t = Date.parse(resetRaw)
    if (Number.isFinite(t)) resetsAt = new Date(t).toISOString()
  } else if (typeof resetRaw === 'number' && Number.isFinite(resetRaw) && resetRaw > 0) {
    const ms = resetRaw < 1e12 ? resetRaw * 1000 : resetRaw
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString()
  }

  return { kind: 'usage', percentUsed: pct, resetsAt }
}

// ─── ChatGPT Codex (chatgpt.com/codex/cloud/settings/analytics) ─────────────
//
// The analytics page reports REMAINING percentages ("Weekly usage limit / 98%
// remaining"), so results carry isRemainingTracker and the renderer inverts.
// Extracted from the injected page script so the branch that fires when a
// limit block is ABSENT is testable — that branch is what invented a 5-hour
// reading out of the weekly bar.

const CHATGPT_TIME_PART =
  '(?:Resets(?:\\s+at)?\\s+)?((?:[A-Z][a-z]+\\s+\\d{1,2},?\\s+\\d{4}\\s+|Tomorrow,?\\s*)?\\d{1,2}:\\d{2}\\s*(?:AM|PM|am|pm))'

export function parseChatgptResetTime(timeStr: string, now: Date = new Date()): string | null {
  if (!timeStr) return null

  // "Jul 26, 2026 4:43 PM"
  const dateTime = timeStr.match(
    /([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/
  )
  if (dateTime) {
    const month = MONTHS[dateTime[1].toLowerCase()]
    if (month) {
      let hours = parseInt(dateTime[4], 10)
      const ampm = dateTime[6].toUpperCase()
      if (ampm === 'PM' && hours < 12) hours += 12
      if (ampm === 'AM' && hours === 12) hours = 0
      const d = new Date(
        parseInt(dateTime[3], 10),
        month - 1,
        parseInt(dateTime[2], 10),
        hours,
        parseInt(dateTime[5], 10),
        0,
        0
      )
      if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
  }

  // "10:42 AM" / "Tomorrow, 10:42 AM"
  const timeOnly = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)/)
  if (timeOnly) {
    let hours = parseInt(timeOnly[1], 10)
    const ampm = timeOnly[3].toUpperCase()
    if (ampm === 'PM' && hours < 12) hours += 12
    if (ampm === 'AM' && hours === 12) hours = 0
    const d = new Date(now)
    d.setHours(hours, parseInt(timeOnly[2], 10), 0, 0)
    if (/tomorrow/i.test(timeStr) || d.getTime() < now.getTime()) d.setDate(d.getDate() + 1)
    return d.toISOString()
  }

  return null
}

export function parseChatgptUsageText(rawText: string, now: Date = new Date()): ScrapedUsageData | null {
  if (!rawText) return null
  const text = normalizeText(rawText)
  const finish = (data: ScrapedUsageData): ScrapedUsageData => {
    applyRenewalToScraped(data, text)
    return data
  }

  // A "5 hour" anchor must be the literal phrase. The old pattern was
  // 5[\s\S]*?hour — an unbounded gap that let a stray "5" bind to a distant
  // "hour", disagreeing with the reset-time regex about which block it meant.
  const hourlyBlock = text.match(/5[\s-]*hour[\s\S]{0,150}?(\d{1,3})%[^%\d]{0,24}?remaining/i)
  const weeklyBlock = text.match(/Weekly[\s\S]{0,150}?(\d{1,3})%[^%\d]{0,24}?remaining/i)

  // NOTE: deliberately no untethered "(\d+)% remaining" fallback here.
  // When the page carries no 5-hour block at all (Codex now states "usage
  // draws from your shared agentic usage limit" and shows only a weekly bar),
  // that fallback matched the WEEKLY figure and reported it as the 5-hour
  // reading — two bars showing one number, one of them mislabelled.
  const hourlyRemaining = hourlyBlock ? parseInt(hourlyBlock[1], 10) : null
  const weeklyRemaining = weeklyBlock ? parseInt(weeklyBlock[1], 10) : null

  const hourlyTime = text.match(new RegExp('5[\\s-]*hour[\\s\\S]{0,150}?(\\d+)%[\\s\\S]{0,50}?' + CHATGPT_TIME_PART, 'i'))
  const weeklyTime = text.match(new RegExp('Weekly[\\s\\S]{0,150}?(\\d+)%[\\s\\S]{0,50}?' + CHATGPT_TIME_PART, 'i'))
  const sessionResetsAt = hourlyTime?.[2] ? parseChatgptResetTime(hourlyTime[2], now) : null
  const weeklyResetsAt = weeklyTime?.[2] ? parseChatgptResetTime(weeklyTime[2], now) : null

  // Anchor the trailing meridiem to a clock value. "(.+?(?:AM|PM|am|pm))" with
  // /i matched the "am" inside "Team plan" and truncated the capture there.
  const globalMatch = text.match(/Resets(?:\s+at)?\s+(.+?\d{1,2}:\d{2}\s*(?:AM|PM))\b/i)
  const globalResetsAt = globalMatch ? parseChatgptResetTime(globalMatch[1], now) : null

  let detectedPlanTier: string | null = null
  const planMatch = text.match(/\b(Free|Plus|Pro|Team|Enterprise)\b/i)
  if (planMatch) {
    // Kept verbatim: the analytics page renders the chip as "PLUS", and that
    // all-caps form is the label the card is meant to show.
    detectedPlanTier = planMatch[1]
    if (/Free\s+(?:plan|tier)/i.test(text)) detectedPlanTier = 'Free'
    else if (/Plus\s+(?:plan|tier)/i.test(text)) detectedPlanTier = 'Plus'
    else if (/Pro\s+(?:plan|tier)/i.test(text)) detectedPlanTier = 'Pro'
  }

  // Model-specific carve-out (e.g. "GPT-5.3-Codex-Spark") as a sub-row.
  let subModels: NonNullable<ScrapedUsageData['subModels']> | undefined
  const sparkMatch = text.match(/GPT[-\s]?\d+(?:\.\d+)?[-\s]?(?:Codex(?:[-\s]?Spark)?|Spark)/i)
  if (sparkMatch && (sparkMatch.index ?? 0) > 0) {
    const block = text.substring(sparkMatch.index ?? 0)
    const pctM = block.match(/(\d{1,3})%[^%\d]{0,30}?remaining/i) || block.match(/(\d{1,3})%\s*used/i)
    if (pctM) {
      const pct = parseInt(pctM[1], 10)
      if (pct >= 0 && pct <= 100) {
        const modelName = sparkMatch[0].replace(/\s+/g, '-')
        subModels = [{ modelName, name: modelName, count: pct, total: 100 }]
      }
    }
  }

  if (hourlyRemaining !== null && weeklyRemaining !== null) {
    return finish({
      currentUsage: hourlyRemaining,
      usageLimit: null,
      percentUsed: hourlyRemaining,
      usageUnit: '% 5-hour limit',
      // A 5-hour window cannot reset days away. Borrowing globalResetsAt (the
      // weekly reset, being the page's first "Resets ...") is what put an
      // identical multi-day countdown on both bars.
      resetsAt: sessionResetsAt,
      weeklyUsage: weeklyRemaining,
      weeklyLimit: null,
      weeklyPercentUsed: weeklyRemaining,
      weeklyResetsAt: weeklyResetsAt || globalResetsAt,
      weeklyBarLabel: 'Weekly Limit',
      isRemainingTracker: true,
      detectedPlanTier,
      subModels
    })
  }

  if (hourlyRemaining !== null || weeklyRemaining !== null) {
    const isWeekly = weeklyRemaining !== null
    const primary = isWeekly ? weeklyRemaining : hourlyRemaining
    return finish({
      currentUsage: primary as number,
      usageLimit: null,
      percentUsed: primary as number,
      usageUnit: isWeekly ? '% weekly limit' : '% 5-hour limit',
      resetsAt: isWeekly ? weeklyResetsAt || globalResetsAt : sessionResetsAt,
      weeklyUsage: null,
      weeklyLimit: null,
      weeklyPercentUsed: null,
      weeklyResetsAt: null,
      isRemainingTracker: true,
      detectedPlanTier,
      subModels
    })
  }

  const msgMatch = text.match(/(\d+)\s*(?:\/|of)\s*(\d+)\s*messages/i)
  if (msgMatch) {
    const current = parseInt(msgMatch[1], 10)
    const limit = parseInt(msgMatch[2], 10)
    return finish({
      currentUsage: current,
      usageLimit: limit,
      percentUsed: limit > 0 ? Math.round((current / limit) * 100) : null,
      usageUnit: 'messages',
      resetsAt: globalResetsAt,
      weeklyUsage: null,
      weeklyLimit: null,
      detectedPlanTier,
      subModels
    })
  }

  const pctMatch = text.match(/(\d{1,3})%\s*used/i)
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10)
    return finish({
      currentUsage: pct,
      usageLimit: 100,
      percentUsed: pct,
      usageUnit: 'used',
      resetsAt: globalResetsAt,
      weeklyUsage: null,
      weeklyLimit: null,
      detectedPlanTier,
      subModels
    })
  }

  return null
}

// ─── Claude (claude.ai/new#settings/usage) ──────────────────────────────────
//
// Lives here rather than on ClaudeScraper so the panel layout is exercisable
// without managed Chrome — the scraper's own copy was a private method and
// therefore untestable. `now` is injectable for the same reason: the weekly
// bucket resets are day-of-week relative ("Resets Thu 6:00 PM").

const CLAUDE_RESET_VALUE_RE =
  /\bResets?\s+(?:in\s+)?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s+\d{1,2}:\d{2}\s*(?:AM|PM)|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d+\s*hr(?:\s+\d+\s*min)?|\d+\s*min)/i

/** "2 hr 53 min" / "Thu 6:00 PM" / "Mar 1" → ISO timestamp. */
export function parseClaudeResetTime(resetStr: string, now: Date = new Date()): string | null {
  if (!resetStr) return null

  // "X hr Y min" (session reset)
  const hrMinMatch = resetStr.match(/(\d+)\s*hr\s*(\d+)\s*min/i)
  if (hrMinMatch) {
    const hours = parseInt(hrMinMatch[1], 10)
    const minutes = parseInt(hrMinMatch[2], 10)
    return new Date(now.getTime() + (hours * 60 + minutes) * 60 * 1000).toISOString()
  }

  // "X min" / "in X min"
  const minOnlyMatch = resetStr.match(/(?:in\s+)?(\d+)\s*min/i)
  if (minOnlyMatch) {
    return new Date(now.getTime() + parseInt(minOnlyMatch[1], 10) * 60 * 1000).toISOString()
  }

  // "X hr"
  const hrOnlyMatch = resetStr.match(/(\d+)\s*hr/i)
  if (hrOnlyMatch) {
    return new Date(now.getTime() + parseInt(hrOnlyMatch[1], 10) * 60 * 60 * 1000).toISOString()
  }

  // "Thu 6:00 PM" (weekly reset)
  const dayTimeMatch = resetStr.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+):(\d+)\s*(AM|PM)/i)
  if (dayTimeMatch) {
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    // The capture is case-insensitive, so the lookup must be too — a bare
    // indexOf() on "THU"/"thu" returned -1 and silently produced a date in the
    // wrong week rather than failing.
    const targetDay = dayNames.indexOf(dayTimeMatch[1].slice(0, 3).toLowerCase())
    if (targetDay < 0) return null

    let hours = parseInt(dayTimeMatch[2], 10)
    const minutes = parseInt(dayTimeMatch[3], 10)
    const ampm = dayTimeMatch[4].toUpperCase()
    if (ampm === 'PM' && hours !== 12) hours += 12
    if (ampm === 'AM' && hours === 12) hours = 0

    const resetDate = new Date(now)
    resetDate.setHours(hours, minutes, 0, 0)

    let daysUntil = targetDay - now.getDay()
    if (daysUntil < 0) daysUntil += 7
    else if (daysUntil === 0 && now.getTime() >= resetDate.getTime()) daysUntil += 7
    resetDate.setDate(resetDate.getDate() + daysUntil)

    return resetDate.toISOString()
  }

  // "Mar 1" (month-day reset)
  const monthDayMatch = resetStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})/i)
  if (monthDayMatch) {
    const month = MONTHS[monthDayMatch[1].toLowerCase()]
    const day = parseInt(monthDayMatch[2], 10)
    if (!month) return null
    const resetDate = new Date(now.getFullYear(), month - 1, day)
    if (resetDate.getTime() < now.getTime()) resetDate.setFullYear(resetDate.getFullYear() + 1)
    return resetDate.toISOString()
  }

  return null
}

/**
 * One "N% used" bar in the Weekly limits section, e.g. "All models" or "Fable".
 *
 * Read structurally rather than against a list of known model names: the old
 * allowlist (All models|Sonnet|Opus|Haiku) silently dropped every bucket
 * Anthropic later added, which is how "Fable" went missing. A bucket is a
 * "N% used" line, its label is the nearest preceding line that isn't a
 * "Resets ..." line, and an optional "Resets ..." line sits between them.
 */
interface ClaudeWeeklyBucket {
  label: string
  percent: number
  resetStr: string | null
}

function isClaudeBucketLabel(line: string): boolean {
  if (!line) return false
  // Bucket labels are short nouns ("All models", "Fable", "Sonnet only").
  // The length cap is what keeps the temporary-boost paragraph ("...Claude
  // Code limit is 50% higher through August 19...") from being read as a
  // label and donating its percentages to a phantom bucket.
  if (line.length > 40) return false
  if (line.includes('%')) return false
  if (CLAUDE_RESET_VALUE_RE.test(line)) return false
  if (/^(learn more|last updated|weekly limits|current session|plan usage limits)/i.test(line)) return false
  if (/usage limits?$/i.test(line)) return false
  return true
}

function extractClaudeWeeklyBuckets(rawLines: string[]): ClaudeWeeklyBucket[] {
  const startIdx = rawLines.findIndex((l) => /^Weekly\s+limits/i.test(l))
  if (startIdx < 0) return []

  // Bound the region to the panel. Slicing to end-of-page swept in the chat
  // shell behind the modal, where a conversation title like "Opus benchmark:
  // 91% used" invented a bucket that was never on the usage panel at all.
  let endIdx = rawLines.findIndex((l, i) => i > startIdx && /^Last updated/i.test(l))
  if (endIdx < 0) endIdx = Math.min(rawLines.length, startIdx + 40)

  const buckets: ClaudeWeeklyBucket[] = []
  for (let i = startIdx + 1; i < endIdx; i++) {
    const pctM = rawLines[i].match(/^(\d{1,3})\s*%\s*used$/i)
    if (!pctM) continue
    const percent = parseInt(pctM[1], 10)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue

    // Walk back over the bar's own "Resets ..." line to reach its label.
    let resetStr: string | null = null
    let label: string | null = null
    for (let j = i - 1; j >= startIdx + 1 && j >= i - 4; j--) {
      const line = rawLines[j]
      const resetM = line.match(CLAUDE_RESET_VALUE_RE)
      if (resetM) {
        if (!resetStr) resetStr = resetM[1].trim()
        continue
      }
      if (isClaudeBucketLabel(line)) {
        label = line
        break
      }
    }
    if (!label) continue
    if (buckets.some((b) => b.label.toLowerCase() === label!.toLowerCase())) continue
    buckets.push({ label, percent, resetStr })
  }

  return buckets
}

export function parseClaudeUsageText(rawText: string, now: Date = new Date()): ScrapedUsageData | null {
  const pageText = rawText.replace(/[\n\r​‌‍﻿]/g, ' ').replace(/\s+/g, ' ')

  // Login page check
  if (pageText.includes('Log in') && pageText.includes('Sign up') && pageText.length < 500) {
    return null
  }

  // Claude shows "<Tier> plan" in the account menu and "Plan usage limits
  // <Tier> (Nx)" in the panel. Prefer the panel form — it carries the
  // multiplier, e.g. "Max (20x)".
  let detectedPlanTier: string | null = null
  const menuTier = pageText.match(/\b(Max|Pro|Free|Team|Enterprise)\s+plan\b/i)
  const panelTier = pageText.match(
    /Plan usage limits\s*((?:Max|Pro|Team|Enterprise)\s*\(\d+x\)|Max|Pro|Free|Team|Enterprise)/i
  )
  if (panelTier) detectedPlanTier = panelTier[1].replace(/\s+/g, ' ').trim()
  else if (menuTier) detectedPlanTier = menuTier[1]

  const sessionMatch = pageText.match(/Current\s+session[\s\S]{0,200}?(\d+)%\s*used/i)
  const sessionPercent = sessionMatch ? parseInt(sessionMatch[1], 10) : null

  // Reset strings are scanned line-by-line against the RAW text: on the
  // flattened pageText a greedy "Resets (...)" capture runs past the end of
  // the value into the next line's digits.
  const rawLines = rawText
    .split(/[\n\r]+/)
    .map((l) => l.replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)

  // The session block has no "Resets" line at all when no session is running
  // ("Starts when a message is sent"), so an unbounded forward scan walked
  // into the Weekly block and reported the weekly reset as the session reset.
  const weeklyHeaderIdx = rawLines.findIndex((l) => /^Weekly\s+limits/i.test(l))
  const sessionIdx = rawLines.findIndex((l) => /Current\s+session/i.test(l))
  let sessionResetStr: string | null = null
  if (sessionIdx >= 0) {
    const limit = weeklyHeaderIdx > sessionIdx ? weeklyHeaderIdx : Math.min(rawLines.length, sessionIdx + 6)
    for (let i = sessionIdx; i < limit; i++) {
      const m = rawLines[i].match(CLAUDE_RESET_VALUE_RE)
      if (m) {
        sessionResetStr = m[1].trim()
        break
      }
    }
  }

  // One structural pass yields both the aggregate weekly bar and the
  // per-model buckets, so they can never disagree about what was on the page.
  const buckets = extractClaudeWeeklyBuckets(rawLines)
  const aggregateIdx = buckets.findIndex((b) => /^all\s+models$/i.test(b.label))
  const aggregate = aggregateIdx >= 0 ? buckets[aggregateIdx] : buckets[0] ?? null
  const perModel = buckets.filter((b) => b !== aggregate)

  const weeklyPercent = aggregate ? aggregate.percent : null
  const weeklyResetAt = aggregate?.resetStr ? parseClaudeResetTime(aggregate.resetStr, now) : null

  const subModels: NonNullable<ScrapedUsageData['subModels']> = perModel.map((b) => ({
    name: b.label,
    modelName: b.label,
    count: b.percent,
    total: 100,
    resetsAt: b.resetStr ? parseClaudeResetTime(b.resetStr, now) : weeklyResetAt
  }))

  const sessionResetAt = sessionResetStr ? parseClaudeResetTime(sessionResetStr, now) : null

  if (sessionPercent !== null || weeklyPercent !== null) {
    const primaryPercent = sessionPercent !== null ? sessionPercent : weeklyPercent

    return {
      currentUsage: primaryPercent ?? 0,
      usageLimit: 100,
      percentUsed: primaryPercent,
      usageUnit: sessionPercent !== null ? 'session used' : 'weekly used',
      resetsAt: sessionResetAt,
      weeklyUsage: weeklyPercent,
      weeklyLimit: weeklyPercent !== null ? 100 : null,
      weeklyPercentUsed: weeklyPercent,
      weeklyResetsAt: weeklyResetAt,
      detectedPlanTier,
      subModels: subModels.length > 0 ? subModels : undefined
    }
  }

  return null
}

// ─── Qwen Cloud (home.qwencloud.com/billing/subscription) ──────────────────
//
// Subscription Management page. Two usage windows, each reported as
// "Remaining N%" against a "Total" credit pool, plus a reset timestamp:
//   "5 Hours Usage Limit  Reset time 2026-08-06 04:34:00  Remaining 81.4%  Total 3,000"
//   "7 Days Usage Limit   Reset time 2026-08-12 23:34:00  Remaining 94.4%  Total 10,000"
// Live/docs variants also use hyphens and "quota" wording:
//   "5-Hour Usage Limit", "5-hour limit", "5-hour quota", same for 7-day.
// The card shows USED, so we invert remaining percentages. The 5-hour
// window is the primary bar; the 7-day window becomes the weekly bar.

interface QwenWindow {
  remainingPct: number
  total: number | null
  resetsAt: string | null
  /** True when Qwen shows "Temporarily Lifted" / ∞ remaining (no hard cap). */
  lifted?: boolean
}

/** Headers accept spaces, hyphens, optional "usage", and limit|quota. */
const QWEN_FIVE_HOUR_RE = /5[\s-]*hours?\s*(?:usage\s*)?(?:limit|quota)/i
const QWEN_SEVEN_DAY_RE = /7[\s-]*days?\s*(?:usage\s*)?(?:limit|quota)/i

/** Infinity glyphs Qwen uses for unlimited remaining (live page: ♾️). */
const QWEN_INFINITY_RE = /(?:\u267E\uFE0F?|\u221E|infinity|unlimited|no\s*limit)/i

function parseQwenWindow(slice: string): QwenWindow | null {
  // Live page variants for uncapped 5h window:
  //   "Temporarily Lifted" / Remaining ♾️
  //   "Temporarily Removed" / Remaining -   (seen 2026-08-07)
  // No percent, no total, reset is "-". Still a real window we must surface.
  const lifted =
    /Temporarily\s*(?:Lifted|Removed)|limit\s*(?:is\s*)?(?:lifted|removed|not\s*enforced)/i.test(
      slice
    ) ||
    (/Remaining\s*/i.test(slice) &&
      QWEN_INFINITY_RE.test(slice) &&
      !/Remaining\s+\d/i.test(slice)) ||
    // Bare dash remaining (not a percentage) next to a usage-limit card.
    /Remaining\s*[-–—]\s*(?:$|[^\d%])/i.test(slice)

  if (lifted) {
    return { remainingPct: 100, total: null, resetsAt: null, lifted: true }
  }

  // Prefer Remaining N% (page polarity); fall back to Used N%.
  let remainingPct: number | null = null
  const rem = slice.match(/Remaining\s+(\d+(?:\.\d+)?)\s*%/i)
  if (rem) {
    const n = parseFloat(rem[1])
    if (Number.isFinite(n)) remainingPct = n
  }
  if (remainingPct === null) {
    const used = slice.match(/(?:Used|Usage)\s+(\d+(?:\.\d+)?)\s*%/i)
    if (used) {
      const n = parseFloat(used[1])
      if (Number.isFinite(n)) remainingPct = Math.max(0, Math.min(100, 100 - n))
    }
  }
  if (remainingPct === null) return null

  let total: number | null = null
  const tot = slice.match(/Total\s+([\d,]+(?:\.\d+)?)/i)
  if (tot) {
    const t = parseFloat(tot[1].replace(/,/g, ''))
    if (Number.isFinite(t)) total = t
  }

  let resetsAt: string | null = null
  const rst = slice.match(/Reset(?:s| time)?\s*(?:time)?\s*:?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/i)
  if (rst) {
    const d = new Date(rst[1].replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString()
  }

  return { remainingPct, total, resetsAt, lifted: false }
}

function qwenUsedFromRemaining(
  remainingPct: number,
  total: number | null
): { usedPct: number; used: number } {
  const usedPct = Math.max(0, Math.min(100, 100 - remainingPct))
  const used =
    total !== null ? Math.round((total * usedPct) / 100 * 100) / 100 : usedPct
  return { usedPct, used }
}

export function parseQwenSubscriptionText(rawText: string): ScrapedUsageData | null {
  const text = normalizeText(rawText)

  // Identity gate: must look like the subscription page, not a login shell.
  if (!/Usage\s*Limit|Subscription\s*Management|Token\s*Plan|5[\s-]*hours?|7[\s-]*days?/i.test(text)) {
    return null
  }
  // Usage content includes metered Remaining N% and lifted/removed ∞ windows.
  // Do not treat "Sign in" in a chrome footer as login when a real usage window is present.
  const hasUsageContent =
    /Remaining\s+\d/i.test(text) ||
    /Temporarily\s*(?:Lifted|Removed)/i.test(text) ||
    (/Remaining\s*/i.test(text) && QWEN_INFINITY_RE.test(text)) ||
    /Remaining\s*[-–—]\s*(?:$|[^\d%])/i.test(text)
  if (/Sign\s*in|Log\s*in|Create\s*account/i.test(text) && !hasUsageContent) return null

  const fiveIdx = text.search(QWEN_FIVE_HOUR_RE)
  const sevenIdx = text.search(QWEN_SEVEN_DAY_RE)
  if (fiveIdx === -1 && sevenIdx === -1) return null

  // Slice each window's block up to the next window header (or end).
  const sliceWindow = (start: number, next: number): string => {
    const end = next > start ? next : text.length
    return text.slice(start, end)
  }

  const five = fiveIdx !== -1 ? parseQwenWindow(sliceWindow(fiveIdx, sevenIdx)) : null
  const seven = sevenIdx !== -1
    ? parseQwenWindow(sliceWindow(sevenIdx, fiveIdx > sevenIdx ? fiveIdx : text.length))
    : null

  if (!five && !seven) return null

  // Same metered pool twice (same total + remaining% + reset) → one bar only.
  // Lifted ∞ windows are never clones of a numeric pool.
  const windowsAreClones = (a: QwenWindow, b: QwenWindow): boolean => {
    if (a.lifted || b.lifted) return false
    const sameTotal = a.total === b.total
    const sameRemaining = Math.abs(a.remainingPct - b.remainingPct) < 0.05
    const sameReset =
      (!a.resetsAt && !b.resetsAt) ||
      (!!a.resetsAt && !!b.resetsAt && a.resetsAt === b.resetsAt)
    return sameTotal && sameRemaining && sameReset
  }

  // Dual when both windows exist and are distinct (incl. 5h lifted + 7d metered).
  const distinctBoth = !!(five && seven && !windowsAreClones(five, seven))
  // Prefer 5-hour as primary when dual; otherwise the only window we have.
  const primary = distinctBoth ? five! : (five ?? seven!)
  const primaryParts = primary.lifted
    ? { usedPct: 0, used: 0 }
    : qwenUsedFromRemaining(primary.remainingPct, primary.total)

  let weekly: { used: number; usedPct: number; total: number | null; resetsAt: string | null } | null = null
  if (distinctBoth && seven) {
    const parts = seven.lifted
      ? { usedPct: 0, used: 0 }
      : qwenUsedFromRemaining(seven.remainingPct, seven.total)
    weekly = {
      usedPct: parts.usedPct,
      used: parts.used,
      total: seven.lifted ? null : seven.total,
      resetsAt: seven.resetsAt
    }
  }

  // Plan tier badge, e.g. "Individual Plan (Standard)" or "Individual Plan Standard".
  let detectedPlanTier: string | null = null
  const plan = text.match(/(Individual|Team)\s*Plan\s*\(?([A-Za-z]+)\)?/i)
  if (plan) {
    const tier = plan[2] && !/^(plan|individual|team)$/i.test(plan[2]) ? plan[2] : null
    detectedPlanTier = tier ? `${plan[1]} · ${tier}` : plan[1]
  }

  // Renewal / expiry date.
  let renewalDate: string | null = null
  const exp = text.match(/Expiry\s*date\s*:?(\d{4}-\d{2}-\d{2})/i)
  if (exp) renewalDate = exp[1]

  // Dual metered: plain "credits". Lifted 5h uses a unit the UI can detect.
  let usageUnit = 'credits'
  if (primary.lifted) {
    usageUnit = '5h lifted'
  } else if (!distinctBoth) {
    if (five && seven && windowsAreClones(five, seven)) {
      usageUnit = seven.total != null && seven.total >= 5000 ? '7d credits' : 'credits'
    } else if (five && !seven) {
      usageUnit = '5h credits'
    } else if (seven && !five) {
      usageUnit = '7d credits'
    }
  }

  return {
    currentUsage: primaryParts.used,
    // Lifted = no hard cap (null limit). Never invent 100 for ∞.
    usageLimit: primary.lifted ? null : (primary.total ?? 100),
    percentUsed: Math.round(primaryParts.usedPct * 100) / 100,
    usageUnit,
    resetsAt: primary.resetsAt,
    weeklyUsage: weekly ? weekly.used : null,
    weeklyLimit: weekly ? (weekly.total ?? (seven?.lifted ? null : 100)) : null,
    weeklyPercentUsed: weekly ? Math.round(weekly.usedPct * 100) / 100 : null,
    weeklyResetsAt: weekly ? weekly.resetsAt : null,
    weeklyBarLabel: weekly ? '7-day' : undefined,
    detectedPlanTier,
    renewalDate,
    renewalKind: renewalDate ? 'renewing' : null
  }
}

export function qwenPageHasFiveHourHeader(rawText: string): boolean {
  return QWEN_FIVE_HOUR_RE.test(normalizeText(rawText))
}

export function qwenPageHasSevenDayHeader(rawText: string): boolean {
  return QWEN_SEVEN_DAY_RE.test(normalizeText(rawText))
}

/**
 * Both window headers are on the page, but the parse dropped one of them.
 * That is the parked-SPA / early-exit failure that saved a lone 7d bar.
 */
export function qwenStructuredParseIsIncomplete(
  rawText: string,
  parsed: ScrapedUsageData | null
): boolean {
  if (!parsed) return true
  const has5 = qwenPageHasFiveHourHeader(rawText)
  const has7 = qwenPageHasSevenDayHeader(rawText)
  if (has5 && has7) {
    const weeklyMissing = parsed.weeklyPercentUsed == null && parsed.weeklyUsage == null
    if (weeklyMissing) return true
    if (parsed.usageUnit === '7d credits') return true
  }
  return false
}

function qwenJsonNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function qwenJsonWindowKind(obj: Record<string, unknown>): 'five' | 'seven' | null {
  const blob = [
    obj.type, obj.quotaType, obj.quota_type, obj.window, obj.windowType,
    obj.name, obj.label, obj.period, obj.cycle, obj.limitType
  ].filter((v) => typeof v === 'string').join(' ').toLowerCase()
  if (/5\s*h|five.?hour|hour.?5|5[\s_-]*hour/.test(blob)) return 'five'
  if (/7\s*d|seven.?day|day.?7|7[\s_-]*day|weekly/.test(blob)) return 'seven'
  return null
}

function qwenJsonToWindow(obj: Record<string, unknown>): QwenWindow | null {
  const lifted =
    obj.lifted === true ||
    obj.unlimited === true ||
    /lifted|removed|unlimited|infinity/i.test(String(obj.status ?? obj.state ?? obj.limitStatus ?? ''))
  if (lifted) {
    return { remainingPct: 100, total: null, resetsAt: null, lifted: true }
  }

  const total = qwenJsonNumber(
    obj.total ?? obj.quota ?? obj.limit ?? obj.totalQuota ?? obj.total_quota ?? obj.creditLimit
  )
  const remainingCredits = qwenJsonNumber(
    obj.remaining ?? obj.remain ?? obj.remainingCredits ?? obj.remaining_credits
  )
  let remainingPct = qwenJsonNumber(
    obj.remainingPercent ?? obj.remaining_percent ?? obj.remainPercent ??
    obj.remainingRate ?? obj.remaining_rate ?? obj.remainRate
  )
  if (remainingPct != null && remainingPct <= 1 && remainingPct >= 0 && (total == null || remainingPct <= 1.0001)) {
    // 0-1 rate vs 0-100 percent. Rates are typically ≤ 1; a raw 0.887 remaining of 10000 is a rate.
    if (remainingPct <= 1 && (obj.remainingRate != null || obj.remaining_rate != null || obj.remainRate != null)) {
      remainingPct = remainingPct * 100
    } else if (remainingPct <= 1 && total != null && remainingCredits == null) {
      remainingPct = remainingPct * 100
    }
  }
  if (remainingPct == null) {
    const usedPct = qwenJsonNumber(obj.usedPercent ?? obj.used_percent ?? obj.usagePercent)
    if (usedPct != null) remainingPct = Math.max(0, Math.min(100, 100 - (usedPct <= 1 ? usedPct * 100 : usedPct)))
  }
  if (remainingPct == null && remainingCredits != null && total != null && total > 0) {
    remainingPct = Math.max(0, Math.min(100, (remainingCredits / total) * 100))
  }
  if (remainingPct == null) return null

  let resetsAt: string | null = null
  const resetRaw = obj.resetTime ?? obj.reset_time ?? obj.resetsAt ?? obj.resetAt ?? obj.endTime
  if (typeof resetRaw === 'string' && resetRaw.trim()) {
    const d = new Date(resetRaw.replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString()
  }

  return { remainingPct, total, resetsAt, lifted: false }
}

function collectQwenJsonWindows(raw: unknown): { five: QwenWindow | null; seven: QwenWindow | null } {
  let five: QwenWindow | null = null
  let seven: QwenWindow | null = null
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const obj = asRecord(value)
    if (!obj) return
    const kind = qwenJsonWindowKind(obj)
    const window = qwenJsonToWindow(obj)
    if (kind && window) {
      if (kind === 'five' && !five) five = window
      if (kind === 'seven' && !seven) seven = window
    } else if (window && !kind && window.total != null) {
      if (window.total >= 5000 && !seven) seven = window
      else if (window.total < 5000 && !five) five = window
    }
    for (const child of Object.values(obj)) visit(child, depth + 1)
  }
  visit(raw, 0)
  return { five, seven }
}

function qwenWindowToSyntheticText(kind: 'five' | 'seven', window: QwenWindow): string {
  const header = kind === 'five' ? '5 Hours Usage Limit' : '7 Days Usage Limit'
  if (window.lifted) {
    return `${header} Temporarily Removed Reset time - Remaining -`
  }
  const reset = window.resetsAt
    ? `Reset time ${window.resetsAt.replace('T', ' ').replace(/\.\d{3}Z$/, '')}`
    : ''
  const total = window.total != null ? `Total ${window.total}` : ''
  return `${header} ${reset} Remaining ${window.remainingPct}% ${total}`
}

/** Same contract as the billing page, from a session JSON payload. */
export function parseQwenUsageJson(raw: unknown): ScrapedUsageData | null {
  const { five, seven } = collectQwenJsonWindows(raw)
  if (!five && !seven) return null
  const parts = ['Subscription Management Token Plan']
  if (five) parts.push(qwenWindowToSyntheticText('five', five))
  if (seven) parts.push(qwenWindowToSyntheticText('seven', seven))
  return parseQwenSubscriptionText(parts.join(' '))
}
