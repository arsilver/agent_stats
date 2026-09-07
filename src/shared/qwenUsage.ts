/**
 * Qwen dual-window contract (shared by main + renderer).
 *
 * A live Individual page can be 7-day only, and when the page does report a
 * "weekly" (7-day) window it can arrive as a mere copy of the primary pool
 * (same limit, same percent, same usage). That second window is a clone,
 * not a real pool: it must be dropped everywhere — cache load, commit, and
 * the dual-window render gate. See docs/qwen-usage.md.
 */

export interface QwenCloneWindowInput {
  usageLimit?: number | null
  percentUsed?: number | null
  currentUsage?: number
  weeklyUsage?: number | null
  weeklyLimit?: number | null
  weeklyPercentUsed?: number | null
}

/**
 * True when the weekly/7-day window only duplicates the primary pool. The
 * three historical formulations (cache-load drop, commit-time drop,
 * dual-window render gate) all reduce to this single predicate.
 */
export function isQwenCloneWeeklyWindow(data: QwenCloneWindowInput): boolean {
  return (
    data.weeklyPercentUsed != null &&
    data.weeklyLimit === data.usageLimit &&
    data.weeklyPercentUsed === data.percentUsed &&
    (data.weeklyUsage == null || data.weeklyUsage === data.currentUsage)
  )
}
