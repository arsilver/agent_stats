/**
 * Per-service usage contracts — shared types.
 *
 * One contract module per service holds the row rules that used to be
 * scattered across usageFetcher / usageIntegrity / usageFreshness /
 * usageNormalizer ("what is a valid Cursor row?"). The generic pipeline
 * programs against the registry in ./index.ts instead of inline
 * `serviceId === 'x'` branches; services without a module use the default
 * no-op contract.
 *
 * Every hook below is a move of existing inline logic and is invoked at the
 * exact sequence point the inline code used to run — do not reorder the
 * call sites. All members are optional: an unimplemented hook means
 * "no extra rule" (accept / pass through unchanged).
 */
import type { UsageData, UsageMetric, UsageMetricSource } from '../../shared/usageTypes'
import type { ScrapedUsageData } from '../scrapers/baseScraper'
import type { IntegrityUsageShape, UsageIntegrityResult } from '../usageIntegrity'

/** Refusal returned when an 'ok' row is too incomplete to cache. */
export interface OkWriteRefusal {
  /** Exact console.warn line (kept verbatim from the inline implementation). */
  warn: string
  /** Reason recorded via recordServiceFailure. */
  reason: string
}

/** Result of the per-service cache-load cleanup. */
export interface CacheLoadResult {
  data: UsageData
  /** Counts toward the "[cache] Loaded … repaired N" tally + flush trigger. */
  repaired: boolean
}

/** Weekly-window locals during commitSuccessfulScrape, before row assembly. */
export interface CommitWeeklyWindow {
  weeklyUsage: number | null
  weeklyLimit: number | null
  weeklyPercentUsed: number | null
  weeklyResetsAt: string | null
  weeklyBarLabel: string | undefined
}

/** Overlay-only fields resolved before the row is assembled (Grok Bot). */
export interface CommitOverlay {
  grokBotPercentUsed: number | null
  grokBotResetsAt: string | null
}

/** Pre-assembly commit state a contract may adjust. */
export interface CommitPreparation {
  scraped: ScrapedUsageData
  cached: UsageData | undefined
  weekly: CommitWeeklyWindow
  overlay: CommitOverlay
}

/** Subset of normalizable usage fields a contract reads for extra metrics. */
export interface ExtraMetricsInput {
  grokBotPercentUsed?: number | null
  grokBotResetsAt?: string | null
}

export interface ServiceUsageContract {
  /** cacheSet gate: refuse an 'ok' row too incomplete to persist (Cursor w/o Total). */
  refuseIncompleteOkRow?(data: UsageData): OkWriteRefusal | null

  /** Cache-load cleanup (Qwen clone-weekly drop, Cursor pool sanitize). */
  onCacheLoad?(data: UsageData): CacheLoadResult

  /** Extra freshness gate beyond TTL; false = never fresh (Cursor w/o Total). */
  isFresh?(data: UsageData): boolean

  /** History-snapshot overlay gate; return a refusal reason to skip the overlay. */
  refuseSnapshotOverlay?(snapshot: { totalPercent: number | null; metrics: UsageMetric[] }): string | null

  /** Pre-assembly commit adjustments (Grok Bot overlay, Qwen clone-weekly drop). */
  prepareCommit?(preparation: CommitPreparation): CommitPreparation

  /** Post-assembly commit transform (Cursor pool sanitize + official Total). */
  beforeCommit?(data: UsageData, scraped: ScrapedUsageData): UsageData

  /** Post-commit log line; return null to log nothing. */
  commitLogLine?(result: UsageData): string | null

  /** Read-side demotion for cached rows served to the renderer (Cursor incomplete). */
  demoteIncompleteRead?(data: UsageData): UsageData

  /** Pre-validation integrity reconcile/repair (Grok weekly product sum). */
  reconcileIntegrity?<T extends IntegrityUsageShape>(data: T): UsageIntegrityResult<T>

  /** Post-validation integrity rejection reason (Cursor requires official Total). */
  integrityRejection?(data: IntegrityUsageShape): string | null

  /** Normalizer: service-gated model-scope rows (Cursor API / Auto + Composer). */
  isModelPoolSubMetric?(lowerLabel: string): boolean

  /** Normalizer: extra service metrics appended after totalPercent (Grok Bot). */
  extraMetrics?(data: ExtraMetricsInput, source: UsageMetricSource): UsageMetric[]
}
