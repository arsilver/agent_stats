/**
 * ChatGPT Codex usage contract.
 *
 * ChatGPT currently has no main-side row rules: the 5-hour + weekly dual
 * windows are produced scraper-side (chatgptScraper / usageTextParsers),
 * the dual-bar render gate lives in src/shared/dualWindowUsage.ts, and the
 * "% 5-hour limit" → "% weekly limit" weekly-unit rule is the generic
 * normalizer path. The contract stays the default no-op; this module exists
 * so the per-service map in the registry is complete.
 */
import type { ServiceUsageContract } from './types'

export const chatgptContract: ServiceUsageContract = {}
