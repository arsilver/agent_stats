/**
 * Cursor Plan & Usage contract (shared by main + renderer).
 *
 * Official numbers come from GetCurrentPeriodUsage:
 *   totalPercentUsed  → card headline (Total)
 *   autoPercentUsed   → Cursor Models / First-party models
 *   apiPercentUsed    → Other Models / API
 *
 * Total is a weighted blend. Never invent it from 2+14 or treat Cursor
 * Models as Total. See docs/cursor-usage.md.
 */

export interface CursorHeadlineInput {
  percentUsed?: number | null
  totalPercent?: number | null
  metrics?: Array<{ id: string; percent?: number | null }>
  subModels?: Array<{ name?: string; modelName?: string; count?: number | null; total?: number | null }>
}

export function isCursorPoolRowName(name: string): boolean {
  return /^(Cursor Models|Other Models|First-party models|API|Auto \+ Composer)$/i.test(name)
}

export function cursorPoolPercent(
  data: CursorHeadlineInput,
  names: RegExp
): number | null {
  const row = (data.subModels ?? []).find((sub) => names.test(sub.name || sub.modelName || ''))
  if (!row || row.total == null || row.total <= 0 || row.count == null) return null
  return Math.round((row.count / row.total) * 100)
}

export function cursorHasPoolMeters(data: CursorHeadlineInput): boolean {
  return (data.subModels ?? []).some((sub) => {
    const name = sub.name || sub.modelName || ''
    return isCursorPoolRowName(name) && sub.total != null
  })
}

/**
 * Official Plan & Usage "Total N%" only. Returns null when the reading is
 * just Cursor Models (or any single pool) so the card cannot headline 2%
 * while the site shows Total 11%.
 */
export function cursorOfficialTotalPercent(data: CursorHeadlineInput): number | null {
  if (data.totalPercent != null && Number.isFinite(data.totalPercent)) {
    return Math.round(data.totalPercent)
  }
  const metric = (data.metrics ?? []).find((row) => row.id === 'cursor:total' && row.percent != null)
  if (metric?.percent != null && Number.isFinite(metric.percent)) {
    return Math.round(metric.percent)
  }
  return null
}

export function cursorReadingHasOfficialTotal(data: CursorHeadlineInput): boolean {
  return cursorOfficialTotalPercent(data) != null
}

export const CURSOR_WRITE_PATH = 'ide-api-v1'

export const CURSOR_INCOMPLETE_RESTART_MESSAGE =
  'Plan & Usage Total is missing. Click refresh to load it from cursor.com.'

/** Connected + current only when official Total is present. */
export function cursorLooksConnected(data: CursorHeadlineInput & {
  status?: string
  isStale?: boolean
}): boolean {
  return data.status === 'ok' && !data.isStale && cursorOfficialTotalPercent(data) != null
}

export function demoteIncompleteCursorUsage<T extends CursorHeadlineInput & {
  service?: string
  status?: string
  isStale?: boolean
  error?: string
}>(data: T): T {
  if ((data.service ?? 'cursor') !== 'cursor') return data
  if (data.status !== 'ok') return data
  if (cursorOfficialTotalPercent(data) != null) return data
  return {
    ...data,
    isStale: true,
    error: data.error || CURSOR_INCOMPLETE_RESTART_MESSAGE
  }
}

/** History fallback may overlay Cursor pools only when official Total is present. */
export function cursorSnapshotMayOverlay(snapshot: CursorHeadlineInput): boolean {
  return cursorOfficialTotalPercent(snapshot) != null
}

export function applyCursorOfficialTotal<T extends CursorHeadlineInput & {
  currentUsage?: number
  usageLimit?: number | null
}>(data: T): T {
  const total = cursorOfficialTotalPercent(data)
  if (total == null) return data
  return {
    ...data,
    totalPercent: total,
    currentUsage: total,
    percentUsed: total,
    usageLimit: data.usageLimit ?? 100
  }
}

/** Prefer a newer Cursor IDE row over a getCached clobber that lacks Total. */
export function preferNewerCursorUsage<T extends CursorHeadlineInput & {
  service?: string
  lastFetched?: string | null
  lastRefreshAttemptAt?: string | null
  isStale?: boolean
  error?: string
}>(current: T | undefined, incoming: T): T {
  if (!current) return incoming
  if ((incoming.service ?? current.service) !== 'cursor') return incoming
  const incomingTotal = cursorOfficialTotalPercent(incoming)
  const currentTotal = cursorOfficialTotalPercent(current)
  const incomingAt = Date.parse(incoming.lastRefreshAttemptAt || incoming.lastFetched || '') || 0
  const currentAt = Date.parse(current.lastRefreshAttemptAt || current.lastFetched || '') || 0
  if (currentTotal != null && (incomingTotal == null || incomingAt < currentAt)) {
    if (incoming.isStale || incoming.error) {
      return {
        ...current,
        isStale: true,
        error: incoming.error ?? current.error,
        lastRefreshAttemptAt: incoming.lastRefreshAttemptAt ?? current.lastRefreshAttemptAt
      }
    }
    return current
  }
  return incoming
}

/** Persist shape for a GetCurrentPeriodUsage scrape. Tests lock 11 / 4 / 42. */
export function materializeCursorIdeReading(scrape: {
  totalPercent: number
  usageLimit?: number | null
  weeklyUsage?: number | null
  weeklyLimit?: number | null
  weeklyPercentUsed?: number | null
  weeklyBarLabel?: string
  totalBarLabel?: string
  subModels?: CursorHeadlineInput['subModels']
  renewalKind?: 'renewing' | 'cancelled' | null
  renewalDate?: string | null
}): {
  totalPercent: number
  percentUsed: number
  currentUsage: number
  usageLimit: number
  weeklyUsage: number | null
  weeklyLimit: number | null
  weeklyPercentUsed: number | null
  weeklyBarLabel: string
  totalBarLabel: string
  subModels: NonNullable<CursorHeadlineInput['subModels']>
  renewalKind: 'renewing' | 'cancelled'
  renewalDate: string | null
  cursorFetchSource: 'ide-api'
} {
  const total = Math.round(scrape.totalPercent)
  const other = (scrape.subModels ?? []).find((row) =>
    /^(Other Models|API)$/i.test(row.name || row.modelName || '')
  )
  const weeklyPct = scrape.weeklyPercentUsed ?? other?.count ?? null
  return {
    totalPercent: total,
    percentUsed: total,
    currentUsage: total,
    usageLimit: scrape.usageLimit ?? 100,
    weeklyUsage: scrape.weeklyUsage ?? weeklyPct,
    weeklyLimit: scrape.weeklyLimit ?? 100,
    weeklyPercentUsed: weeklyPct,
    weeklyBarLabel: scrape.weeklyBarLabel ?? 'Other Models',
    totalBarLabel: scrape.totalBarLabel ?? 'Total',
    subModels: scrape.subModels ?? [],
    renewalKind: scrape.renewalKind === 'cancelled' ? 'cancelled' : 'renewing',
    renewalDate: scrape.renewalDate ?? null,
    cursorFetchSource: 'ide-api'
  }
}
