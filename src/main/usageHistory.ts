import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type { AgentCredits, LegacySubModel, UsageMetric } from '../shared/usageTypes'

let db: Database.Database | null = null

export function closeUsageHistory(): void {
  if (db) {
    try {
      db.close()
      db = null
      console.log('[SQLite] Database closed cleanly')
    } catch (err) {
      console.error('[SQLite] Error closing database:', err)
    }
  }
}

export function initUsageHistory(): void {
  const dbPath = join(app.getPath('userData'), 'usage-history.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      current_usage REAL NOT NULL,
      usage_limit REAL,
      percent_used REAL,
      usage_unit TEXT,
      resets_at TEXT,
      weekly_usage REAL,
      weekly_limit REAL,
      weekly_percent_used REAL,
      sub_models TEXT
    )
  `)

  // Safe migration: Add sub_models column if it doesn't exist on older databases
  try {
    const tableInfo = db.pragma('table_info(usage_snapshots)') as { name: string }[]
    const hasSubModels = tableInfo.some(col => col.name === 'sub_models')
    if (!hasSubModels) {
      db.exec(`ALTER TABLE usage_snapshots ADD COLUMN sub_models TEXT`)
      console.log('[SQLite] Migrated usage_snapshots to include sub_models column')
    }
  const hasAgentCredits = tableInfo.some(col => col.name === 'agent_credits')
    if (!hasAgentCredits) {
      db.exec(`ALTER TABLE usage_snapshots ADD COLUMN agent_credits TEXT`)
      console.log('[SQLite] Migrated usage_snapshots to include agent_credits column')
    }
  } catch (err) {
    console.error('[SQLite] Failed to run schema migration:', err)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_service_time
    ON usage_snapshots(service, timestamp)
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      metric_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      unit TEXT NOT NULL,
      value REAL NOT NULL,
      usage_limit REAL,
      percent REAL,
      polarity TEXT NOT NULL,
      resets_at TEXT
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_metrics_service_metric_time
    ON usage_metric_snapshots(service, metric_id, timestamp)
  `)

  // Per-service health: current error state and consecutive failure count.
  // Drives backoff in usageFetcher and gives a queryable history of flaky services.
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_health (
      service TEXT PRIMARY KEY,
      last_error_at INTEGER,
      last_error_reason TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER
    )
  `)
}

export interface ServiceHealth {
  service: string
  lastErrorAt: number | null
  lastErrorReason: string | null
  consecutiveFailures: number
  lastSuccessAt: number | null
}

export function recordServiceSuccess(service: string): void {
  if (!db) return
  const stmt = db.prepare(`
    INSERT INTO service_health (service, last_error_at, last_error_reason, consecutive_failures, last_success_at)
    VALUES (?, NULL, NULL, 0, ?)
    ON CONFLICT(service) DO UPDATE SET
      last_error_at = NULL,
      last_error_reason = NULL,
      consecutive_failures = 0,
      last_success_at = excluded.last_success_at
  `)
  stmt.run(service, Date.now())
}

export function recordServiceFailure(service: string, reason: string | null): void {
  if (!db) return
  const stmt = db.prepare(`
    INSERT INTO service_health (service, last_error_at, last_error_reason, consecutive_failures, last_success_at)
    VALUES (?, ?, ?, 1, NULL)
    ON CONFLICT(service) DO UPDATE SET
      last_error_at = excluded.last_error_at,
      last_error_reason = excluded.last_error_reason,
      consecutive_failures = service_health.consecutive_failures + 1
  `)
  stmt.run(service, Date.now(), reason ?? 'unknown')
}

export function getServiceHealth(service: string): ServiceHealth | null {
  if (!db) return null
  const row = db.prepare(`
    SELECT service, last_error_at as lastErrorAt, last_error_reason as lastErrorReason,
           consecutive_failures as consecutiveFailures, last_success_at as lastSuccessAt
    FROM service_health
    WHERE service = ?
  `).get(service) as ServiceHealth | undefined
  return row ?? null
}

/**
 * Reset consecutive_failures and last_error_at so the exponential-backoff
 * guard in usageFetcher (>=3 failures + lastErrorAt set) doesn't suppress
 * scheduled refreshes after an app restart. last_error_reason is preserved
 * so the diagnostic history is not lost.
 *
 * Services at or above `maxConsecutiveFailures` keep their backoff state —
 * chronically failing services (failure storms) should not get a free reset
 * on every app start.
 */
export function resetAllBackoffState(maxConsecutiveFailures = 6): { rowsAffected: number } {
  if (!db) return { rowsAffected: 0 }
  const result = db.prepare(`
    UPDATE service_health
    SET consecutive_failures = 0, last_error_at = NULL
    WHERE (consecutive_failures > 0 OR last_error_at IS NOT NULL)
      AND consecutive_failures < ?
  `).run(maxConsecutiveFailures)
  return { rowsAffected: result.changes }
}

export interface UsageSnapshot {
  service: string
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  usageUnit: string | null
  resetsAt: string | null
  weeklyUsage: number | null
  weeklyLimit: number | null
  weeklyPercentUsed: number | null
  totalPercent?: number | null
  subModels?: LegacySubModel[] | null
  metrics?: UsageMetric[] | null
  agentCredits?: AgentCredits | null
}

export function saveUsageSnapshot(snapshot: UsageSnapshot): void {
  if (!db) return
  const timestamp = new Date().toISOString()

  // Dedup: skip the snapshot row entirely when the headline numbers AND the
  // product/pool breakdown are unchanged from this service's latest row —
  // otherwise the 10-minute poll writes an identical row every cycle and the
  // table grows without bound. Sub-model-only changes (e.g. Grok Build 6→8
  // while a stalled weekly headline stays at 1%) MUST still record a row so
  // Analytics/history track the real burn.
  const latestSnapshot = db.prepare(`
    SELECT current_usage as currentUsage, percent_used as percentUsed, sub_models as subModels
    FROM usage_snapshots
    WHERE service = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(snapshot.service) as {
    currentUsage: number
    percentUsed: number | null
    subModels: string | null
  } | undefined

  const nextSubModelsJson = snapshot.subModels ? JSON.stringify(snapshot.subModels) : null
  const snapshotUnchanged =
    latestSnapshot != null &&
    latestSnapshot.currentUsage === snapshot.currentUsage &&
    (latestSnapshot.percentUsed ?? null) === (snapshot.percentUsed ?? null) &&
    (latestSnapshot.subModels ?? null) === (nextSubModelsJson ?? null)

  if (!snapshotUnchanged) {
    const stmt = db.prepare(`
      INSERT INTO usage_snapshots
      (service, timestamp, current_usage, usage_limit, percent_used, usage_unit, resets_at,
       weekly_usage, weekly_limit, weekly_percent_used, sub_models, agent_credits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const subModelsJson = nextSubModelsJson
    const agentCreditsJson = snapshot.agentCredits ? JSON.stringify(snapshot.agentCredits) : null

    stmt.run(
      snapshot.service,
      timestamp,
      snapshot.currentUsage,
      snapshot.usageLimit,
      snapshot.percentUsed,
      snapshot.usageUnit,
      snapshot.resetsAt,
      snapshot.weeklyUsage,
      snapshot.weeklyLimit,
      snapshot.weeklyPercentUsed,
      subModelsJson,
      agentCreditsJson
    )
  }

  const metrics = snapshot.metrics ?? []
  if (metrics.length === 0) return

  const metricStmt = db.prepare(`
    INSERT INTO usage_metric_snapshots
    (service, metric_id, timestamp, label, scope, source, unit, value,
     usage_limit, percent, polarity, resets_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const latestMetricStmt = db.prepare(`
    SELECT value
    FROM usage_metric_snapshots
    WHERE service = ? AND metric_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `)

  const insertMetrics = db.transaction((rows: UsageMetric[]) => {
    for (const metric of rows) {
      // Same dedup rule as snapshots: only record a metric row when its value
      // actually changed since that metric's latest row.
      const latestMetric = latestMetricStmt.get(snapshot.service, metric.id) as { value: number } | undefined
      if (latestMetric && latestMetric.value === metric.value) continue

      metricStmt.run(
        snapshot.service,
        metric.id,
        timestamp,
        metric.label,
        metric.scope,
        metric.source,
        metric.unit,
        metric.value,
        metric.limit,
        metric.percent,
        metric.polarity,
        metric.resetsAt
      )
    }
  })

  insertMetrics(metrics)
}

function getMetricsForSnapshot(service: string, timestamp: string): UsageMetric[] | null {
  if (!db) return null

  const rows = db.prepare(`
    SELECT
      metric_id as id,
      label,
      scope,
      source,
      unit,
      value,
      usage_limit as "limit",
      percent,
      polarity,
      resets_at as resetsAt
    FROM usage_metric_snapshots
    WHERE service = ? AND timestamp = ?
    ORDER BY id ASC
  `).all(service, timestamp) as UsageMetric[]

  return rows.length > 0 ? rows : null
}

function mapUsageSnapshotRow(row: any): UsageSnapshot & { timestamp: string } {
  const metrics = getMetricsForSnapshot(row.service, row.timestamp)
  const totalFromMetrics = (metrics ?? []).find((metric) => metric.id === `${row.service}:total`)
  return {
    ...row,
    subModels: row.subModelsRaw ? JSON.parse(row.subModelsRaw) : null,
    subModelsRaw: undefined,
    agentCredits: row.agentCreditsRaw ? JSON.parse(row.agentCreditsRaw) : null,
    agentCreditsRaw: undefined,
    metrics,
    totalPercent: totalFromMetrics?.percent ?? row.totalPercent ?? null
  }
}

export function getUsageHistory(
  service: string,
  days: number = 30
): Array<UsageSnapshot & { timestamp: string }> {
  if (!db) return []

  // Downsample: Hourly aggregates for <= 7 days, Daily for > 7 days
  const timeFormat = days <= 7 ? '%Y-%m-%d %H' : '%Y-%m-%d'

  const stmt = db.prepare(`
    SELECT
      service,
      MAX(timestamp) as timestamp,
      AVG(current_usage) as currentUsage,
      MAX(usage_limit) as usageLimit,
      AVG(percent_used) as percentUsed,
      MAX(usage_unit) as usageUnit,
      MAX(resets_at) as resetsAt,
      AVG(weekly_usage) as weeklyUsage,
      MAX(weekly_limit) as weeklyLimit,
      AVG(weekly_percent_used) as weeklyPercentUsed,
      MAX(sub_models) as subModelsRaw,
      MAX(agent_credits) as agentCreditsRaw
    FROM usage_snapshots
    WHERE service = ? AND timestamp > datetime('now', ?)
    GROUP BY service, strftime('${timeFormat}', timestamp)
    ORDER BY timestamp ASC
  `)

  const rows = stmt.all(service, `-${days} days`) as any[]

  return rows.map(mapUsageSnapshotRow)
}

export function getAllUsageHistory(
  days: number = 30
): Array<UsageSnapshot & { timestamp: string; service: string }> {
  if (!db) return []

  // Downsample: Hourly aggregates for <= 7 days, Daily for > 7 days
  const timeFormat = days <= 7 ? '%Y-%m-%d %H' : '%Y-%m-%d'

  const stmt = db.prepare(`
    SELECT
      service,
      MAX(timestamp) as timestamp,
      AVG(current_usage) as currentUsage,
      MAX(usage_limit) as usageLimit,
      AVG(percent_used) as percentUsed,
      MAX(usage_unit) as usageUnit,
      MAX(resets_at) as resetsAt,
      AVG(weekly_usage) as weeklyUsage,
      MAX(weekly_limit) as weeklyLimit,
      AVG(weekly_percent_used) as weeklyPercentUsed,
      MAX(sub_models) as subModelsRaw,
      MAX(agent_credits) as agentCreditsRaw
    FROM usage_snapshots
    WHERE timestamp > datetime('now', ?)
    GROUP BY service, strftime('${timeFormat}', timestamp)
    ORDER BY service, timestamp ASC
  `)

  const rows = stmt.all(`-${days} days`) as any[]

  return rows.map(mapUsageSnapshotRow)
}

export function getLatestUsageSnapshot(
  service: string
): (UsageSnapshot & { timestamp: string }) | null {
  if (!db) return null

  const stmt = db.prepare(`
    SELECT
      service,
      timestamp,
      current_usage as currentUsage,
      usage_limit as usageLimit,
      percent_used as percentUsed,
      usage_unit as usageUnit,
      resets_at as resetsAt,
      weekly_usage as weeklyUsage,
      weekly_limit as weeklyLimit,
      weekly_percent_used as weeklyPercentUsed,
      sub_models as subModelsRaw,
      agent_credits as agentCreditsRaw
    FROM usage_snapshots
    WHERE service = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `)

  const row = stmt.get(service) as any
  if (!row) return null

  return mapUsageSnapshotRow(row)
}

// ─── Retention ───────────────────────────────────────────────
// The poller writes snapshots every cycle; without pruning the DB grows
// forever. Keep 7 days of raw rows (the downsample queries already aggregate
// hourly/daily within that window) and prune at startup + at most once daily.

const RETENTION_DAYS = 7
const RETENTION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
let lastRetentionPruneAt = 0

export function pruneUsageHistoryOlderThan(days: number = RETENTION_DAYS): { snapshotsDeleted: number; metricSnapshotsDeleted: number } {
  if (!db) return { snapshotsDeleted: 0, metricSnapshotsDeleted: 0 }
  const snapshots = db.prepare(`
    DELETE FROM usage_snapshots
    WHERE timestamp < datetime('now', ?)
  `).run(`-${days} days`)
  const metricSnapshots = db.prepare(`
    DELETE FROM usage_metric_snapshots
    WHERE timestamp < datetime('now', ?)
  `).run(`-${days} days`)
  return { snapshotsDeleted: snapshots.changes, metricSnapshotsDeleted: metricSnapshots.changes }
}

/**
 * Run the retention prune at most once per 24h. Call at startup and from the
 * poll loop — the internal guard makes repeated calls cheap no-ops.
 */
export function maybePruneUsageHistory(): void {
  if (!db) return
  const now = Date.now()
  if (now - lastRetentionPruneAt < RETENTION_PRUNE_INTERVAL_MS) return
  lastRetentionPruneAt = now
  try {
    const result = pruneUsageHistoryOlderThan(RETENTION_DAYS)
    if (result.snapshotsDeleted > 0 || result.metricSnapshotsDeleted > 0) {
      console.log(
        `[SQLite] Retention prune deleted ${result.snapshotsDeleted} snapshots ` +
        `and ${result.metricSnapshotsDeleted} metric snapshots older than ${RETENTION_DAYS} days`
      )
    }
  } catch (err) {
    console.warn('[SQLite] Retention prune failed:', err)
  }
}
