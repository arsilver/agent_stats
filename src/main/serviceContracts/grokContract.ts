/**
 * Grok usage contract.
 *
 * Two pools carry main-side rules:
 *  - SuperGrok weekly headline = sum of weekly product rows (denominator
 *    100); rolling 2h query pools never enter the sum (integrity repair).
 *  - Grok Bot weekly allowance (Cursor Sand) — a separate overlay persisted
 *    as grokBotPercentUsed and surfaced as the GROK_BOT_METRIC_ID metric,
 *    kept out of the Model Pools projection.
 */
import type {
  LegacySubModel,
  UsageData,
  UsageMetric,
  UsageMetricSource
} from '../../shared/usageTypes'
import type { ScrapedUsageData } from '../scrapers/baseScraper'
import type { IntegrityUsageShape, UsageIntegrityResult } from '../usageIntegrity'
import type {
  CommitOverlay,
  CommitPreparation,
  ExtraMetricsInput,
  ServiceUsageContract
} from './types'

/** Metric id for the Grok Bot weekly pool (kept out of Model Pools projection). */
export const GROK_BOT_METRIC_ID = 'grok:tool:grok-bot'

/** Same tolerance usageIntegrity applies to value/limit/percent agreement. */
const PERCENT_TOLERANCE = 1.05

const GROK_WEEKLY_PRODUCT_NAMES = new Set([
  'grok build',
  'build',
  'chat',
  'api',
  'imagine',
  'deepsearch',
  'search',
  'voice',
  'task',
  'tasks'
  // Grok Bot is a separate Cursor Sand weekly pool. Never sum it into SuperGrok.
])

function accepted<T extends IntegrityUsageShape>(data: T): UsageIntegrityResult<T> {
  return { data, disposition: 'accepted', reason: null }
}

function rejected<T extends IntegrityUsageShape>(data: T, reason: string): UsageIntegrityResult<T> {
  return { data, disposition: 'rejected', reason }
}

function normalizedLabel(row: LegacySubModel): string {
  return (row.name || row.modelName || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function reconcileGrokWeekly<T extends IntegrityUsageShape>(data: T): UsageIntegrityResult<T> {
  const products = new Map<string, number>()

  for (const row of data.subModels ?? []) {
    const label = normalizedLabel(row)
    if (!GROK_WEEKLY_PRODUCT_NAMES.has(label)) continue

    // Weekly product rows are percentages with a denominator of 100. Rolling
    // query pools (for example 0/140 over 2h) must never enter this sum.
    if (row.total !== 100) continue
    if (row.count == null || !Number.isFinite(row.count) || row.count < 0 || row.count > 100) {
      return rejected(data, `Grok weekly product "${label}" has an invalid percentage`)
    }

    const previous = products.get(label)
    if (previous != null && Math.abs(previous - row.count) > 0.05) {
      return rejected(data, `Grok weekly product "${label}" appears with conflicting values`)
    }
    if (previous == null) products.set(label, row.count)
  }

  if (products.size === 0) return accepted(data)

  const productSum = Math.round([...products.values()].reduce((sum, value) => sum + value, 0) * 10) / 10
  if (productSum > 100) {
    return rejected(data, `Grok weekly product total is impossible (${productSum}%)`)
  }

  const statedPercent = data.percentUsed ?? (data.usageLimit === 100 ? data.currentUsage : null)
  if (statedPercent != null && productSum <= statedPercent + PERCENT_TOLERANCE) {
    return accepted(data)
  }

  const repairedMetrics = data.metrics?.map((metric) =>
    metric.id === 'grok:primary'
      ? { ...metric, value: productSum, limit: 100, percent: productSum }
      : metric
  )
  const repaired = {
    ...data,
    currentUsage: productSum,
    usageLimit: 100,
    percentUsed: productSum,
    ...(repairedMetrics ? { metrics: repairedMetrics } : {})
  } as T

  return {
    data: repaired,
    disposition: 'repaired',
    reason: `Grok weekly headline reconciled to product total (${productSum}%)`
  }
}

/**
 * Resolve the Grok Bot overlay at commit: a fresh scrape wins, an explicit
 * null clears, and a scrape that never fetched Sand keeps the cached value.
 */
function resolveGrokBotOverlay(
  scraped: ScrapedUsageData,
  cached: UsageData | undefined
): CommitOverlay {
  if (scraped.grokBotPercentUsed != null) {
    return {
      grokBotPercentUsed: scraped.grokBotPercentUsed,
      grokBotResetsAt: scraped.grokBotResetsAt ?? null
    }
  }
  if (Object.prototype.hasOwnProperty.call(scraped, 'grokBotPercentUsed')) {
    return { grokBotPercentUsed: null, grokBotResetsAt: null }
  }
  return {
    grokBotPercentUsed: cached?.grokBotPercentUsed ?? null,
    grokBotResetsAt: cached?.grokBotResetsAt ?? null
  }
}

export const grokContract: ServiceUsageContract = {
  reconcileIntegrity<T extends IntegrityUsageShape>(data: T): UsageIntegrityResult<T> {
    return reconcileGrokWeekly(data)
  },

  prepareCommit(preparation: CommitPreparation): CommitPreparation {
    return {
      ...preparation,
      overlay: resolveGrokBotOverlay(preparation.scraped, preparation.cached)
    }
  },

  commitLogLine(result: UsageData): string | null {
    if (result.grokBotPercentUsed == null) return null
    return `[grok] wrote SuperGrok=${result.percentUsed} grokBot=${result.grokBotPercentUsed} resets=${result.grokBotResetsAt ?? 'n/a'}`
  },

  extraMetrics(data: ExtraMetricsInput, source: UsageMetricSource): UsageMetric[] {
    if (data.grokBotPercentUsed == null) return []
    return [
      {
        id: GROK_BOT_METRIC_ID,
        label: 'Grok Bot',
        scope: 'tool',
        source,
        unit: 'weekly used',
        value: data.grokBotPercentUsed,
        limit: 100,
        percent: data.grokBotPercentUsed,
        polarity: 'used',
        resetsAt: data.grokBotResetsAt ?? null
      }
    ]
  }
}
