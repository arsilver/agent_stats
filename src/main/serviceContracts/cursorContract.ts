/**
 * Cursor usage contract.
 *
 * Pure predicates live in src/shared/cursorUsage.ts (the renderer shares
 * them); this module wires them into the pipeline hooks. Headline rule: a
 * row without the official Plan & Usage Total (GetCurrentPeriodUsage
 * totalPercentUsed) is incomplete — never cached as ok, never fresh, and
 * never allowed to overlay history. See docs/cursor-usage.md.
 */
import type { UsageData, UsageMetric } from '../../shared/usageTypes'
import type { ScrapedUsageData } from '../scrapers/baseScraper'
import type { IntegrityUsageShape } from '../usageIntegrity'
import {
  applyCursorOfficialTotal,
  cursorOfficialTotalPercent,
  cursorSnapshotMayOverlay,
  demoteIncompleteCursorUsage
} from '../../shared/cursorUsage'
import type {
  CacheLoadResult,
  OkWriteRefusal,
  ServiceUsageContract
} from './types'

/** Drop Cursor on-demand $ rows with no cap, and canonicalize pool names. */
function sanitizeCursorUsage(data: UsageData): UsageData {
  const renamed = (data.subModels ?? []).map((row) => {
    const name = row.name || row.modelName || ''
    if (/^first-party models$/i.test(name) || /^auto \+ composer$/i.test(name)) {
      return { ...row, name: 'Cursor Models', modelName: 'Cursor Models', total: row.total ?? 100 }
    }
    if (/^api$/i.test(name)) {
      return { ...row, name: 'Other Models', modelName: 'Other Models', total: row.total ?? 100 }
    }
    return row
  })
  const subModels = renamed.filter((row) => {
    const name = row.name || row.modelName || ''
    if (/on-demand|spend/i.test(name) && row.total == null) return false
    return true
  })
  const promoted = applyCursorOfficialTotal({
    ...data,
    weeklyBarLabel: data.weeklyBarLabel === 'API' ? 'Other Models' : data.weeklyBarLabel,
    totalBarLabel: data.totalBarLabel ?? (cursorOfficialTotalPercent(data) != null ? 'Total' : data.totalBarLabel),
    subModels: subModels.length > 0 ? subModels : undefined
  })
  return promoted
}

export const cursorContract: ServiceUsageContract = {
  refuseIncompleteOkRow(data: UsageData): OkWriteRefusal | null {
    if (data.status === 'ok' && !data.isStale && cursorOfficialTotalPercent(data) == null) {
      return {
        warn: '[cursor] Refusing ok-cache write without official Total (GetCurrentPeriodUsage)',
        reason: 'missing official Total (GetCurrentPeriodUsage)'
      }
    }
    return null
  },

  onCacheLoad(data: UsageData): CacheLoadResult {
    return { data: sanitizeCursorUsage(data), repaired: false }
  },

  isFresh(data: UsageData): boolean {
    // Pools without official Total (2%/14% spending-page leftovers) must not
    // satisfy TTL — Refresh would otherwise keep showing them until the user
    // Disconnects and wipes the parked Chrome session.
    return cursorOfficialTotalPercent(data) != null
  },

  refuseSnapshotOverlay(snapshot: { totalPercent: number | null; metrics: UsageMetric[] }): string | null {
    return cursorSnapshotMayOverlay(snapshot) ? null : 'without official Total'
  },

  beforeCommit(data: UsageData, scraped: ScrapedUsageData): UsageData {
    const cursorFetchSource =
      (scraped as { cursorFetchSource?: 'ide-api' | 'web-api' }).cursorFetchSource ?? 'web-api'
    return sanitizeCursorUsage({ ...data, cursorFetchSource })
  },

  commitLogLine(result: UsageData): string | null {
    const models = result.subModels?.find((row) => /Cursor Models/i.test(row.name || row.modelName || ''))?.count
    return `[cursor] wrote Total=${result.totalPercent} cursorModels=${models} other=${result.weeklyPercentUsed}`
  },

  demoteIncompleteRead(data: UsageData): UsageData {
    return demoteIncompleteCursorUsage(data)
  },

  integrityRejection(data: IntegrityUsageShape): string | null {
    return cursorOfficialTotalPercent(data) == null
      ? 'Cursor reading missing official Total (GetCurrentPeriodUsage totalPercentUsed)'
      : null
  },

  isModelPoolSubMetric(lowerLabel: string): boolean {
    return lowerLabel === 'api' || lowerLabel === 'auto + composer'
  }
}
