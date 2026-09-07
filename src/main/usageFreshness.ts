import type { UsageData } from '../shared/usageTypes'
import { getServiceContract } from './serviceContracts'

/**
 * Preserve the last successful reading when a new refresh fails. A failed
 * attempt is deliberately separate from lastFetched: the latter is the time
 * the displayed usage was actually verified.
 */
export function createStaleUsageData(
  lastGood: UsageData,
  attemptedAt: string,
  error: string
): UsageData {
  return {
    ...lastGood,
    isStale: true,
    lastRefreshAttemptAt: attemptedAt,
    error
  }
}

/**
 * Older builds persisted failed refreshes as status=ok and only left the
 * failure marker in `error`. Recognize those entries so they cannot hold the
 * UI on an obsolete percentage until their normal TTL expires.
 */
export function isUsageDataStale(data: UsageData | undefined): boolean {
  if (!data) return false
  if (data.isStale) return true

  return data.status === 'ok' && /^refresh failed\b/i.test(data.error?.trim() ?? '')
}

/** A stale reading must always bypass the normal per-service TTL. */
export function isUsageDataFresh(data: UsageData | undefined): boolean {
  if (!data || data.status !== 'ok' || isUsageDataStale(data)) return false
  // Per-service completeness gate (Cursor: pools without official Total must
  // not satisfy TTL — Refresh would otherwise keep showing spending-page
  // leftovers until the user Disconnects the parked Chrome session).
  if (getServiceContract(data.service).isFresh?.(data) === false) return false
  return true
}
