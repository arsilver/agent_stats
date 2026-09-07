// ─── Official API fetchers ───────────────────────────────────
// Per-service API-key fetchers plus the fetchViaAPI routing switch, extracted
// from usageFetcher so the refresh orchestration (refreshCoordinator) can take
// the API path through an injected port. This module is electron-free and
// better-sqlite3-free: it only talks to the network via fetch.

import type { AuthProfile } from './authProfiles'
import type { UsageData, UsageMetric, UsageMetricSource } from '../shared/usageTypes'

/**
 * Try to fetch usage via the service's API endpoint.
 */
export async function fetchViaAPI(
  profile: AuthProfile,
  apiKey: string
): Promise<Partial<UsageData> | null> {
  try {
    switch (profile.id) {
      case 'runwayml':
        return await fetchRunwayAPI(apiKey)
      case 'fal-ai':
        return await fetchFalAIPlatformUsage(apiKey)
      case 'openrouter':
        return await fetchOpenRouterKeyUsage(apiKey)
      case 'chatgpt':
        return await fetchOpenAIAdminUsageMetrics(apiKey)
      case 'claude':
        return await fetchAnthropicAdminUsageMetrics(apiKey)
      default:
        return null
    }
  } catch (err) {
    return { status: 'error', error: String(err) }
  }
}

export function isPrimaryOfficialAPIService(serviceId: string): boolean {
  return serviceId === 'runwayml' || serviceId === 'fal-ai' || serviceId === 'openrouter'
}

function numberFrom(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,]/g, '').trim()
    if (!cleaned) return null
    const parsed = Number(cleaned)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function firstNumberFromObject(source: any, keys: string[]): number | null {
  const seen = new Set<any>()
  const visit = (value: any): number | null => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)

    for (const key of keys) {
      const direct = numberFrom(value[key])
      if (direct != null) return direct
    }

    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(item)
      if (found != null) return found
    }
    return null
  }

  return visit(source)
}

async function fetchJSONWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const text = await response.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { ok: response.ok, status: response.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String((err as any)?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

function metric(
  id: string,
  label: string,
  unit: string,
  value: number,
  limit: number | null,
  source: UsageMetricSource,
  scope: UsageMetric['scope'] = 'api',
  polarity: UsageMetric['polarity'] = 'used',
  resetsAt: string | null = null
): UsageMetric {
  return {
    id,
    label,
    scope,
    source,
    unit,
    value,
    limit,
    percent: limit && limit > 0 ? Math.round((value / limit) * 100) : null,
    polarity,
    resetsAt
  }
}

function flattenNamedUsageRows(data: any): Array<{ name: string; value: number }> {
  const rows: Array<{ name: string; value: number }> = []
  const seen = new Set<any>()
  const visit = (value: any): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)

    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    const name =
      typeof value.model === 'string' ? value.model :
        typeof value.model_name === 'string' ? value.model_name :
          typeof value.endpoint_id === 'string' ? value.endpoint_id :
            typeof value.identifier === 'string' ? value.identifier :
              typeof value.name === 'string' ? value.name :
                typeof value.label === 'string' ? value.label : null
    const amount =
      numberFrom(value.total_cost) ??
      numberFrom(value.cost) ??
      numberFrom(value.amount) ??
      numberFrom(value.credits) ??
      numberFrom(value.total_credits) ??
      numberFrom(value.usage) ??
      numberFrom(value.total)

    if (name && amount != null && amount > 0) {
      rows.push({ name, value: amount })
    }

    for (const child of Object.values(value)) visit(child)
  }

  visit(data)
  return rows
}

async function fetchRunwayAPI(apiKey: string): Promise<Partial<UsageData> | null> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': '2024-11-06'
  }

  const org = await fetchJSONWithTimeout('https://api.dev.runwayml.com/v1/organization', headers)
  const usage = await fetchJSONWithTimeout('https://api.dev.runwayml.com/v1/organization/usage', headers)
  if (!org.ok && !usage.ok) {
    return { status: 'error', error: `Runway API returned ${org.status || usage.status}` }
  }

  const combined = { organization: org.data, usage: usage.data }
  const remaining = firstNumberFromObject(combined, [
    'creditBalance',
    'credit_balance',
    'creditsRemaining',
    'remainingCredits',
    'remaining_credits',
    'balance'
  ])
  const limit = firstNumberFromObject(combined, [
    'monthlyCreditLimit',
    'monthly_credit_limit',
    'maxMonthlyCredits',
    'max_monthly_credits',
    'creditLimit',
    'creditsPurchased',
    'limit'
  ])
  let used = firstNumberFromObject(combined, [
    'creditsUsed',
    'credits_used',
    'currentUsage',
    'current_usage',
    'totalCreditsUsed',
    'total_credits_used',
    'usage'
  ])

  let isRemainingTracker = false
  if (used == null && remaining != null && limit != null) {
    used = Math.max(0, limit - remaining)
  } else if (used == null && remaining != null) {
    used = remaining
    isRemainingTracker = true
  }

  if (used == null) return null

  const percentUsed = limit && limit > 0
    ? Math.round((used / limit) * 100)
    : null
  const subModels = flattenNamedUsageRows(usage.data).map((row) => ({
    name: row.name,
    count: row.value,
    total: limit ?? undefined
  }))
  const metrics = [
    metric('runwayml:api:credits', 'Runway API credits', 'credits', used, limit, 'api', 'api', isRemainingTracker ? 'remaining' : 'used'),
    ...(remaining != null
      ? [metric('runwayml:api:remaining-credits', 'Runway API remaining credits', 'credits', remaining, limit, 'api', 'account', 'remaining')]
      : [])
  ]

  return {
    currentUsage: used,
    usageLimit: limit,
    usageUnit: 'credits',
    percentUsed,
    resetsAt: null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    isRemainingTracker,
    metrics,
    subModels: subModels.length > 0 ? subModels : undefined,
    status: 'ok'
  }
}

async function fetchFalAIPlatformUsage(apiKey: string): Promise<Partial<UsageData> | null> {
  const now = new Date()
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const qs = new URLSearchParams({
    from_date: start.toISOString().slice(0, 10),
    to_date: now.toISOString().slice(0, 10)
  })
  const response = await fetchJSONWithTimeout(`https://api.fal.ai/v1/models/usage?${qs}`, {
    Authorization: `Key ${apiKey}`
  })
  if (!response.ok) {
    return { status: 'error', error: `fal.ai API returned ${response.status}` }
  }

  const totalSpend =
    firstNumberFromObject(response.data, ['total_cost', 'totalCost', 'total_cost_usd', 'cost_usd', 'cost']) ??
    firstNumberFromObject(response.data, ['total_credits', 'credits']) ??
    0
  const requestCount = firstNumberFromObject(response.data, ['total_requests', 'requests', 'request_count'])
  const modelRows = flattenNamedUsageRows(response.data)
  const subModels = modelRows.map((row) => ({
    name: row.name,
    count: row.value,
    total: totalSpend > 0 ? totalSpend : undefined
  }))
  const metrics: UsageMetric[] = [
    metric('fal-ai:api:platform-spend', 'fal.ai API platform spend', '$', totalSpend, null, 'api', 'api', 'spend'),
    ...(requestCount != null
      ? [metric('fal-ai:api:requests', 'fal.ai API requests', 'requests', requestCount, null, 'api', 'api', 'used')]
      : []),
    ...modelRows.map((row) =>
      metric(`fal-ai:model:${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, row.name, '$', row.value, totalSpend || null, 'api', 'model', 'spend')
    )
  ]

  return {
    currentUsage: totalSpend,
    usageLimit: null,
    usageUnit: '$ spend',
    percentUsed: null,
    resetsAt: null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    metrics,
    subModels: subModels.length > 0 ? subModels : undefined,
    status: 'ok'
  }
}

async function fetchOpenRouterKeyUsage(apiKey: string): Promise<Partial<UsageData> | null> {
  const response = await fetchJSONWithTimeout('https://openrouter.ai/api/v1/key', {
    Authorization: `Bearer ${apiKey}`
  })
  if (!response.ok) {
    return { status: 'error', error: `OpenRouter API returned ${response.status}` }
  }

  const data = response.data?.data ?? response.data ?? {}
  const usage = numberFrom(data.usage) ?? 0
  const remaining = numberFrom(data.limit_remaining)
  const dailyUsage = numberFrom(data.usage_daily)
  const weeklyUsage = numberFrom(data.usage_weekly)
  const monthlyUsage = numberFrom(data.usage_monthly)
  const limit = numberFrom(data.limit) ?? (remaining != null ? usage + remaining : null)
  const metrics: UsageMetric[] = [
    metric('openrouter:api:key-usage', data.label ? `OpenRouter key ${data.label}` : 'OpenRouter key usage', '$', usage, limit, 'api', 'api', 'spend'),
    ...(dailyUsage != null
      ? [metric('openrouter:api:daily-usage', 'OpenRouter daily usage', '$', dailyUsage, null, 'api', 'api', 'spend')]
      : []),
    ...(weeklyUsage != null
      ? [metric('openrouter:api:weekly-usage', 'OpenRouter weekly usage', '$', weeklyUsage, null, 'api', 'api', 'spend')]
      : []),
    ...(monthlyUsage != null
      ? [metric('openrouter:api:monthly-usage', 'OpenRouter monthly usage', '$', monthlyUsage, limit, 'api', 'api', 'spend')]
      : []),
    ...(remaining != null
      ? [metric('openrouter:account:remaining-credit', 'OpenRouter remaining credit', '$', remaining, limit, 'api', 'account', 'remaining')]
      : [])
  ]

  return {
    currentUsage: usage,
    usageLimit: limit,
    usageUnit: '$ spend',
    percentUsed: limit && limit > 0 ? Math.round((usage / limit) * 100) : null,
    resetsAt: typeof data.expires_at === 'string' ? data.expires_at : null,
    weeklyUsage,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    metrics,
    status: 'ok'
  }
}

async function fetchOpenAIAdminUsageMetrics(apiKey: string): Promise<Partial<UsageData> | null> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - 30 * 24 * 60 * 60
  const qs = new URLSearchParams({
    start_time: String(start),
    end_time: String(end),
    bucket_width: '1d',
    group_by: 'model'
  })
  const response = await fetchJSONWithTimeout(`https://api.openai.com/v1/organization/costs?${qs}`, {
    Authorization: `Bearer ${apiKey}`
  })
  if (!response.ok) return null

  const rows = flattenNamedUsageRows(response.data)
  const total = rows.reduce((sum, row) => sum + row.value, 0) ||
    firstNumberFromObject(response.data, ['amount', 'cost', 'total_cost']) ||
    0
  const metrics: UsageMetric[] = [
    metric('chatgpt:api:openai-org-cost', 'OpenAI API org cost (30d)', '$', total, null, 'api', 'api', 'spend'),
    ...rows.map((row) =>
      metric(`chatgpt:api:model:${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, `OpenAI API ${row.name}`, '$', row.value, total || null, 'api', 'model', 'spend')
    )
  ]
  return { metrics, status: 'ok' }
}

async function fetchAnthropicAdminUsageMetrics(apiKey: string): Promise<Partial<UsageData> | null> {
  const now = new Date()
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const qs = new URLSearchParams({
    starting_at: start.toISOString(),
    ending_at: now.toISOString()
  })
  const response = await fetchJSONWithTimeout(`https://api.anthropic.com/v1/organizations/cost_report?${qs}`, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'usage-cost-api-2025-08-18'
  })
  if (!response.ok) return null

  const rows = flattenNamedUsageRows(response.data)
  const total = rows.reduce((sum, row) => sum + row.value, 0) ||
    firstNumberFromObject(response.data, ['amount', 'cost', 'total_cost']) ||
    0
  const metrics: UsageMetric[] = [
    metric('claude:api:anthropic-org-cost', 'Anthropic API org cost (30d)', '$', total, null, 'api', 'api', 'spend'),
    ...rows.map((row) =>
      metric(`claude:api:model:${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, `Anthropic API ${row.name}`, '$', row.value, total || null, 'api', 'model', 'spend')
    )
  ]
  return { metrics, status: 'ok' }
}
