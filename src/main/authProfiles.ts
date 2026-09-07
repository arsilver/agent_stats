/**
 * Auth profiles define per-service metadata: plan tier, auth method,
 * API base URLs, and dashboard URLs for scraping.
 */

import type { AuthType } from '../shared/usageTypes'

export type { AuthType }

export interface AuthProfile {
  id: string
  displayName: string
  planTier: string
  authType: AuthType
  baseUrl: string
  usageUrl: string | null       // API endpoint for usage data
  dashboardUrl: string | null   // Web dashboard URL for scraping fallback
  usageUnit: string             // 'messages' | 'tokens' | 'credits' | 'minutes' | 'requests'
  iconColor: string             // For UI card accent color
  refreshIntervalMs?: number    // Custom refresh interval (default: 5 minutes)
}

/**
 * All supported AI services with their configuration.
 * Dashboard URLs are the actual pages the user sees usage data on.
 */
export const SERVICE_PROFILES: AuthProfile[] = [
  {
    id: 'chatgpt',
    displayName: 'ChatGPT Codex',
    planTier: 'Pro',
    authType: 'web_session',
    baseUrl: 'https://api.openai.com/v1',
    usageUrl: null,
    dashboardUrl: 'https://chatgpt.com/codex/cloud/settings/analytics',
    usageUnit: 'messages',
    iconColor: '#10a37f'
  },
  {
    id: 'claude',
    displayName: 'Claude',
    planTier: 'Max 200',
    authType: 'web_session',
    baseUrl: 'https://api.anthropic.com/v1',
    usageUrl: null,
    dashboardUrl: 'https://claude.ai/new#settings/usage',
    usageUnit: 'messages',
    iconColor: '#d97757'
  },

  {
    id: 'kimi-code',
    displayName: 'Kimi Code',
    // Fallback shown whenever a scrape can't confirm the live tier — keep it
    // matching the user's actual plan (page shows "Vivace", verified live).
    planTier: 'Vivace',
    authType: 'web_session',
    baseUrl: 'https://api.moonshot.cn/v1',
    usageUrl: null,
    dashboardUrl: 'https://www.kimi.ai/membership/subscription?tab=quota',
    usageUnit: '% used',
    iconColor: '#7c3aed'
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    planTier: 'Plus',
    authType: 'web_session',
    baseUrl: 'https://api.minimax.chat/v1',
    usageUrl: null,
    dashboardUrl: 'https://platform.minimax.io/user-center/payment/token-plan',
    usageUnit: 'tokens',
    iconColor: '#f59e0b',
    refreshIntervalMs: 5 * 60 * 60 * 1000 // 5 hours (high-speed token reset)
  },
  {
    id: 'runwayml',
    displayName: 'RunwayML',
    planTier: 'Subscription',
    authType: 'web_session',
    baseUrl: 'https://api.dev.runwayml.com/v1',
    usageUrl: null,
    dashboardUrl: 'https://app.runwayml.com/account/billing',
    usageUnit: 'credits',
    iconColor: '#6366f1'
  },
  {
    id: 'fal-ai',
    displayName: 'fal.ai / Kling',
    planTier: 'Subscription',
    authType: 'web_session',
    baseUrl: 'https://fal.run',
    usageUrl: null,
    dashboardUrl: 'https://fal.ai/dashboard/usage-billing',
    usageUnit: '$ spend',
    iconColor: '#ec4899'
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    planTier: 'Pay-As-You-Go',
    authType: 'web_session',
    baseUrl: 'https://openrouter.ai/api/v1',
    usageUrl: null,
    dashboardUrl: 'https://openrouter.ai/credits',
    usageUnit: '$ spend',
    iconColor: '#93c5fd'
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    planTier: 'Pro',
    authType: 'web_session',
    baseUrl: 'https://cursor.com',
    usageUrl: null,
    dashboardUrl: 'https://cursor.com/dashboard',
    usageUnit: '%',
    iconColor: '#a0a0b0'
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    // Fallback only — the usage panel's own chip ("PRO") wins when scraped.
    planTier: 'Pro',
    authType: 'web_session',
    baseUrl: 'https://gemini.google.com',
    usageUrl: null,
    dashboardUrl: 'https://gemini.google.com/u/1/usage?pageId=none',
    usageUnit: '% current usage',
    iconColor: '#4796E3'
  },
  {
    id: 'higgsfield',
    displayName: 'Higgsfield',
    planTier: 'Subscription',
    authType: 'web_session',
    baseUrl: 'https://higgsfield.ai',
    usageUrl: null,
    dashboardUrl: 'https://higgsfield.ai/profile',
    usageUnit: 'credits',
    iconColor: '#ff6b35'
  },
  {
    id: 'grok',
    displayName: 'Grok',
    planTier: 'SuperGrok',
    authType: 'web_session',
    baseUrl: 'https://api.x.ai/v1',
    usageUrl: null,
    dashboardUrl: 'https://grok.com/?_s=usage',
    // Fallback only. The old '%' would have rendered the pool count as "140%"
    // had it ever surfaced; the scraper always overrides with 'weekly used'.
    usageUnit: 'weekly used',
    iconColor: '#64748b'
  },
  {
    id: 'qwen',
    displayName: 'Qwen Code',
    planTier: 'Individual',
    authType: 'web_session',
    baseUrl: 'https://home.qwencloud.com',
    usageUrl: null,
    dashboardUrl: 'https://home.qwencloud.com/billing/subscription/token-plan-individual',
    // Token Plan Individual meters credits. Live page may be 7-day only; 5h when shown.
    usageUnit: 'credits',
    iconColor: '#8b5cf6'
  }
]

export function getProfile(serviceId: string): AuthProfile | undefined {
  return SERVICE_PROFILES.find((p) => p.id === serviceId)
}

export function getAllProfiles(): AuthProfile[] {
  return SERVICE_PROFILES
}
