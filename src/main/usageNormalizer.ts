import type {
  LegacySubModel,
  UsageMetric,
  UsageMetricPolarity,
  UsageMetricScope,
  UsageMetricSource
} from '../shared/usageTypes'
import { getServiceContract } from './serviceContracts'
import { GROK_BOT_METRIC_ID } from './serviceContracts/grokContract'

interface NormalizableUsage {
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  usageUnit: string
  resetsAt?: string | null
  isRemainingTracker?: boolean
  weeklyUsage?: number | null
  weeklyLimit?: number | null
  weeklyPercentUsed?: number | null
  weeklyResetsAt?: string | null
  weeklyBarLabel?: string
  totalPercent?: number | null
  totalBarLabel?: string
  grokBotPercentUsed?: number | null
  grokBotResetsAt?: string | null
  metrics?: UsageMetric[]
  subModels?: LegacySubModel[]
  agentCredits?: {
    balance: number
    membership: number
    valueAdded: number
    bonus: number
    debt: number
    dailyFree: number
    spendingHistory: { taskName: string; date: string; creditsChange: number }[]
  }
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'metric'
}

function inferPrimaryPolarity(serviceId: string, data: NormalizableUsage): UsageMetricPolarity {
  const unit = (data.usageUnit || '').toLowerCase()
  if (serviceId === 'fal-ai' || serviceId === 'openrouter' || unit.includes('$') || unit.includes('spend')) {
    return 'spend'
  }
  if (unit.includes('balance')) return 'balance'
  if (data.isRemainingTracker || unit.includes('remaining') || unit.includes('left')) {
    return 'remaining'
  }
  return 'used'
}

function inferSubMetricScope(serviceId: string, label: string): UsageMetricScope {
  const lower = label.toLowerCase()
  if (serviceId === 'gemini' || lower.includes('/') || lower.includes('gpt') || lower.includes('claude')) {
    return 'model'
  }
  if (
    lower.includes('cursor models') ||
    lower.includes('other models') ||
    lower.includes('first-party') ||
    getServiceContract(serviceId).isModelPoolSubMetric?.(lower) === true
  ) {
    return 'model'
  }
  if (lower.includes('credit') || lower.includes('balance')) return 'account'
  return 'tool'
}

function inferSubMetricPolarity(label: string, data: NormalizableUsage): UsageMetricPolarity {
  const lower = label.toLowerCase()
  // 'Agent Tokens' (Kimi) is a "N left" counter — its semantics are remaining,
  // even though the label itself contains no left/remaining keyword.
  if (lower.includes('agent token')) return 'remaining'
  if (lower.includes('left') || lower.includes('remaining') || lower.includes('available')) return 'remaining'
  if (lower.includes('balance') || lower.includes('credit')) return 'balance'
  return inferPrimaryPolarity('', data) === 'spend' ? 'spend' : 'used'
}

function percentFrom(value: number, limit: number | null | undefined): number | null {
  if (limit == null || limit <= 0) return null
  return Math.round((value / limit) * 100)
}

function metricKey(serviceId: string, scope: UsageMetricScope, label: string): string {
  return `${serviceId}:${scope}:${slugify(label)}`
}

function dedupeMetrics(metrics: UsageMetric[]): UsageMetric[] {
  const seen = new Map<string, UsageMetric>()
  for (const metric of metrics) {
    seen.set(metric.id, metric)
  }
  return [...seen.values()]
}

export function normalizeUsageMetrics(
  serviceId: string,
  data: NormalizableUsage,
  source: UsageMetricSource = 'scraper'
): UsageMetric[] {
  const metrics: UsageMetric[] = []

  metrics.push({
    id: `${serviceId}:primary`,
    label: data.usageUnit || 'Usage',
    scope: 'service',
    source,
    unit: data.usageUnit || '',
    value: data.currentUsage,
    limit: data.usageLimit ?? null,
    percent: data.percentUsed ?? percentFrom(data.currentUsage, data.usageLimit),
    polarity: inferPrimaryPolarity(serviceId, data),
    resetsAt: data.resetsAt ?? null
  })

  if (data.weeklyUsage != null || data.weeklyPercentUsed != null) {
    const value = data.weeklyUsage ?? data.weeklyPercentUsed ?? 0
    // Weekly is a separate pool. Period-specific primary units (e.g. Qwen
    // "5h lifted") must not stamp the weekly metric — that made charts show
    // unit "5h lifted" on the 7-day bar.
    const primaryUnit = data.usageUnit || ''
    const periodSpecificPrimary =
      /^(5h\s|7d\s)/i.test(primaryUnit) || /lifted/i.test(primaryUnit)
    const fiveHourPrimary = /5[\s-]*hour/i.test(primaryUnit)
    const weeklyUnit = fiveHourPrimary
      ? primaryUnit.replace(/5[\s-]*hour/ig, 'weekly')
      : periodSpecificPrimary
        ? 'credits'
        : primaryUnit
    metrics.push({
      id: `${serviceId}:weekly`,
      label: data.weeklyBarLabel ?? 'Weekly',
      scope: 'service',
      source,
      unit: weeklyUnit,
      value,
      limit: data.weeklyLimit ?? null,
      percent: data.weeklyPercentUsed ?? percentFrom(value, data.weeklyLimit),
      polarity: data.isRemainingTracker ? 'remaining' : 'used',
      resetsAt: data.weeklyResetsAt ?? null
    })
  }

  if (data.totalPercent != null) {
    metrics.push({
      id: `${serviceId}:total`,
      label: data.totalBarLabel ?? 'Total',
      scope: 'service',
      source: 'derived',
      unit: '%',
      value: data.totalPercent,
      limit: 100,
      percent: data.totalPercent,
      polarity: 'used',
      resetsAt: null
    })
  }

  // Per-service extra metrics appended at this exact position (Grok Bot weekly pool).
  metrics.push(...(getServiceContract(serviceId).extraMetrics?.(data, source) ?? []))

  // A primary unit carrying a period qualifier ("grok-4 queries used / 2h")
  // describes the PRIMARY metric's own pool and rolling window. Sub-metrics are
  // separate pools with their own windows — already carried in their labels —
  // so inheriting it verbatim stamps them with a period we never measured for
  // them. Inherit only an unqualified unit.
  const subUnit = (data.usageUnit || '').includes(' / ') ? '' : (data.usageUnit || '')

  for (const sub of data.subModels ?? []) {
    const label = sub.name || sub.modelName || 'Unknown'
    const value = sub.count ?? 0
    const limit = sub.total ?? null
    const scope = inferSubMetricScope(serviceId, label)
    metrics.push({
      id: metricKey(serviceId, scope, label),
      label,
      scope,
      source,
      unit: subUnit,
      value,
      limit,
      percent: percentFrom(value, limit),
      polarity: inferSubMetricPolarity(label, data),
      resetsAt: sub.resetsAt ?? null
    })
  }

  if (data.agentCredits) {
    metrics.push({
      id: `${serviceId}:account:agent-credits`,
      label: 'Agent Credits',
      scope: 'account',
      source,
      unit: 'credits',
      value: data.agentCredits.balance,
      limit: null,
      percent: null,
      polarity: 'balance',
      resetsAt: null
    })
  }

  return dedupeMetrics([...(data.metrics ?? []), ...metrics])
}

export function metricsToSubModels(metrics: UsageMetric[] | undefined): LegacySubModel[] | undefined {
  const detailMetrics = (metrics ?? []).filter((metric) =>
    metric.scope !== 'service' && metric.id !== GROK_BOT_METRIC_ID
  )
  if (detailMetrics.length === 0) return undefined

  return detailMetrics.map((metric) => ({
    name: metric.label,
    modelName: metric.label,
    count: metric.value,
    total: metric.limit ?? undefined,
    resetsAt: metric.resetsAt
  }))
}
