export type AuthType = 'api_key' | 'oauth' | 'bearer' | 'web_session'

export type UsageStatus =
  | 'ok'
  | 'error'
  | 'not_configured'
  | 'login_required'
  | 'cookies_expired'
  | 'disabled'

export type UsageMetricPolarity = 'used' | 'remaining' | 'balance' | 'spend'

export type UsageMetricScope = 'service' | 'model' | 'tool' | 'account' | 'api' | 'subscription'

export type UsageMetricSource = 'api' | 'scraper' | 'cache' | 'history' | 'derived'

export interface UsageMetric {
  id: string
  label: string
  scope: UsageMetricScope
  source: UsageMetricSource
  unit: string
  value: number
  limit: number | null
  percent: number | null
  polarity: UsageMetricPolarity
  resetsAt: string | null
}

export interface SessionAction {
  kind: 'reconnect'
  label: string
  detail: string
  canCleanReconnect: boolean
}

export interface PublicServiceProfile {
  id: string
  displayName: string
  planTier: string
  authType: AuthType
  dashboardUrl: string | null
  usageUnit: string
  iconColor: string
  refreshIntervalMs?: number
}

export interface LegacySubModel {
  name?: string
  modelName?: string
  count?: number
  total?: number
  resetsAt?: string | null
  resetCountdown?: string | null
}

export interface AgentCredits {
  balance: number
  membership: number
  valueAdded: number
  bonus: number
  debt: number
  dailyFree: number
  spendingHistory: { taskName: string; date: string; creditsChange: number }[]
}

export interface UsageData {
  service: string
  displayName: string
  planTier: string
  currentUsage: number
  usageLimit: number | null
  usageUnit: string
  percentUsed: number | null
  resetsAt: string | null
  resetCountdown: string | null
  weeklyUsage: number | null
  weeklyLimit: number | null
  weeklyPercentUsed: number | null
  weeklyResetsAt: string | null
  weeklyResetCountdown: string | null
  weeklyBarLabel?: string
  totalPercent?: number | null
  totalBarLabel?: string
  /** Grok Bot weekly included allowance (Cursor Sand). Not the SuperGrok Heavy pool. */
  grokBotPercentUsed?: number | null
  grokBotResetsAt?: string | null
  grokBotResetCountdown?: string | null
  /** Cursor only: proves the row came from GetCurrentPeriodUsage, not spending DOM. */
  cursorFetchSource?: 'ide-api' | 'web-api'
  /** When true, currentUsage is the last known good reading, not a successful latest refresh. */
  isStale?: boolean
  lastFetched: string | null
  /** Most recent refresh attempt, retained separately so it cannot mask lastFetched. */
  lastRefreshAttemptAt?: string | null
  lastIncreasedAt?: number | null   // set by fetcher when a scrape shows increase vs prior cached value (drives aiGotchi seating)
  isRemainingTracker?: boolean
  status: UsageStatus
  error?: string
  sessionAction?: SessionAction
  iconColor: string
  manualCookieRefresh?: boolean
  renewalDate: string | null
  renewalKind: 'renewing' | 'cancelled' | null
  refreshIntervalMs?: number
  metrics?: UsageMetric[]
  subModels?: LegacySubModel[]
  agentCredits?: AgentCredits
}

export interface UsageHistoryPoint {
  service: string
  timestamp: string
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  usageUnit?: string | null
  resetsAt?: string | null
  weeklyUsage?: number | null
  weeklyLimit?: number | null
  weeklyPercentUsed?: number | null
  metrics?: UsageMetric[] | null
  subModels?: LegacySubModel[] | null
  agentCredits?: AgentCredits | null
}
