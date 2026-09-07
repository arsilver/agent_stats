/**
 * Dual-window cards (MiniMax, Qwen, ChatGPT Codex).
 *
 * Longer window (weekly / 7-day) is the headline on top. The 5-hour window
 * sits under it. Cursor is not dual-window — it uses Model Pools.
 */

import { isQwenCloneWeeklyWindow } from './qwenUsage'

export interface DualWindowInput {
  service: string
  weeklyPercentUsed?: number | null
  weeklyLimit?: number | null
  weeklyUsage?: number | null
  percentUsed?: number | null
  usageLimit?: number | null
  currentUsage?: number
}

export function hasDualWindowBars(data: DualWindowInput): boolean {
  if (data.weeklyPercentUsed == null) return false
  if (data.service === 'cursor') return false
  if (data.service === 'qwen') {
    // A weekly window that only clones the primary pool is a single bar.
    return !isQwenCloneWeeklyWindow(data)
  }
  return data.service === 'minimax' || data.service === 'chatgpt'
}

export function dualWindowLabels(
  service: string,
  weeklyBarLabel?: string
): { top: string; bottom: string } {
  if (service === 'qwen') {
    return { top: '7-Day Credits', bottom: '5-Hour Credits' }
  }
  if (service === 'chatgpt') {
    return { top: weeklyBarLabel || 'Weekly Limit', bottom: '5-Hour Limit' }
  }
  return { top: weeklyBarLabel || 'Weekly Tokens', bottom: '5-Hour Tokens' }
}
