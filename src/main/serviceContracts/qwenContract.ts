/**
 * Qwen Code usage contract.
 *
 * The 7-day window can arrive as a clone of the primary pool (same limit,
 * percent, and usage). The clone check is one shared predicate —
 * isQwenCloneWeeklyWindow in src/shared/qwenUsage.ts — used here for the
 * cache-load drop and the commit-time drop, and by the renderer's
 * dual-window gate. See docs/qwen-usage.md.
 */
import type { UsageData } from '../../shared/usageTypes'
import { isQwenCloneWeeklyWindow } from '../../shared/qwenUsage'
import type {
  CacheLoadResult,
  CommitPreparation,
  ServiceUsageContract
} from './types'

export const qwenContract: ServiceUsageContract = {
  onCacheLoad(data: UsageData): CacheLoadResult {
    if (!isQwenCloneWeeklyWindow(data)) return { data, repaired: false }
    console.log(
      `[qwen] Cache load: dropping clone weekly (${data.weeklyUsage}/${data.weeklyLimit} @ ${data.weeklyPercentUsed}%)`
    )
    return {
      data: {
        ...data,
        weeklyUsage: null,
        weeklyLimit: null,
        weeklyPercentUsed: null,
        weeklyResetsAt: null,
        weeklyResetCountdown: null,
        weeklyBarLabel: undefined,
        usageUnit:
          data.usageUnit === 'credits' || !data.usageUnit ? '7d credits' : data.usageUnit
      },
      repaired: true
    }
  },

  prepareCommit(preparation: CommitPreparation): CommitPreparation {
    const { weekly, scraped } = preparation
    if (
      !isQwenCloneWeeklyWindow({
        usageLimit: scraped.usageLimit,
        percentUsed: scraped.percentUsed,
        currentUsage: scraped.currentUsage,
        weeklyUsage: weekly.weeklyUsage,
        weeklyLimit: weekly.weeklyLimit,
        weeklyPercentUsed: weekly.weeklyPercentUsed
      })
    ) {
      return preparation
    }
    console.log(
      `[qwen] Dropping clone weekly window (${weekly.weeklyUsage}/${weekly.weeklyLimit} @ ${weekly.weeklyPercentUsed}%)`
    )
    return {
      ...preparation,
      weekly: {
        weeklyUsage: null,
        weeklyLimit: null,
        weeklyPercentUsed: null,
        weeklyResetsAt: null,
        weeklyBarLabel: undefined
      }
    }
  }
}
