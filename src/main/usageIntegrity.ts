import type { LegacySubModel, UsageMetric } from '../shared/usageTypes'
import { getServiceContract } from './serviceContracts'

export type UsageIntegrityDisposition = 'accepted' | 'repaired' | 'rejected'

export interface IntegrityUsageShape {
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  usageUnit: string
  weeklyUsage?: number | null
  weeklyLimit?: number | null
  weeklyPercentUsed?: number | null
  totalPercent?: number | null
  grokBotPercentUsed?: number | null
  subModels?: LegacySubModel[]
  metrics?: UsageMetric[]
}

export interface UsageIntegrityResult<T extends IntegrityUsageShape> {
  data: T
  disposition: UsageIntegrityDisposition
  reason: string | null
}

const PERCENT_TOLERANCE = 1.05

function accepted<T extends IntegrityUsageShape>(data: T): UsageIntegrityResult<T> {
  return { data, disposition: 'accepted', reason: null }
}

function rejected<T extends IntegrityUsageShape>(data: T, reason: string): UsageIntegrityResult<T> {
  return { data, disposition: 'rejected', reason }
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function isValidPercent(value: number | null | undefined): boolean {
  return value == null || (Number.isFinite(value) && value >= 0 && value <= 100)
}

function validateValueLimitPercent(
  label: string,
  value: number | null | undefined,
  limit: number | null | undefined,
  percent: number | null | undefined
): string | null {
  if (value != null && !isFiniteNonNegative(value)) return `${label} value is not finite and nonnegative`
  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) return `${label} limit is not finite and positive`
  if (!isValidPercent(percent)) return `${label} percent is outside 0-100`

  if (value != null && limit != null && percent != null) {
    const calculated = (value / limit) * 100
    if (!Number.isFinite(calculated) || Math.abs(calculated - percent) > PERCENT_TOLERANCE) {
      return `${label} value, limit, and percent disagree`
    }
  }

  return null
}

/**
 * Validate one fetched or cached usage reading before it becomes authoritative.
 * Repairs are deliberately service-specific (see serviceContracts/); ambiguous
 * data is rejected rather than guessed so callers can retain their last known
 * good reading.
 */
export function validateAndReconcileUsage<T extends IntegrityUsageShape>(
  serviceId: string,
  input: T
): UsageIntegrityResult<T> {
  const contract = getServiceContract(serviceId)
  let candidate = input

  // Pre-validation service reconcile (Grok weekly product-sum repair).
  const reconcile = contract.reconcileIntegrity
  if (reconcile) {
    const reconciled = reconcile(candidate)
    if (reconciled.disposition === 'rejected') return reconciled
    candidate = reconciled.data

    const validationError = validateUsageShape(candidate)
    if (validationError) return rejected(input, validationError)
    return reconciled.disposition === 'repaired'
      ? { data: candidate, disposition: 'repaired', reason: reconciled.reason }
      : accepted(candidate)
  }

  const validationError = validateUsageShape(candidate)
  if (validationError) return rejected(input, validationError)

  // Post-validation service rejection (Cursor requires official Total).
  const integrityRejection = contract.integrityRejection?.(candidate)
  if (integrityRejection) return rejected(input, integrityRejection)

  return accepted(candidate)
}

function validateUsageShape(data: IntegrityUsageShape): string | null {
  const primaryError = validateValueLimitPercent(
    'Primary usage',
    data.currentUsage,
    data.usageLimit,
    data.percentUsed
  )
  if (primaryError) return primaryError

  const weeklyError = validateValueLimitPercent(
    'Weekly usage',
    data.weeklyUsage,
    data.weeklyLimit,
    data.weeklyPercentUsed
  )
  if (weeklyError) return weeklyError
  if (!isValidPercent(data.totalPercent)) return 'Total percent is outside 0-100'
  if (!isValidPercent(data.grokBotPercentUsed)) return 'Grok Bot percent is outside 0-100'

  for (const row of data.subModels ?? []) {
    const label = row.name || row.modelName || 'Unknown detail row'
    if (row.count != null && !isFiniteNonNegative(row.count)) return `${label} value is invalid`
    if (row.total != null && (!Number.isFinite(row.total) || row.total <= 0)) return `${label} limit is invalid`
    if (row.count != null && row.total != null && row.count > row.total) return `${label} exceeds its limit`
  }

  for (const metric of data.metrics ?? []) {
    const metricError = validateValueLimitPercent(
      `Metric ${metric.id}`,
      metric.value,
      metric.limit,
      metric.percent
    )
    if (metricError) return metricError
  }

  return null
}
