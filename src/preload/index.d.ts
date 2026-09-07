/**
 * Type declarations for the APIs exposed via contextBridge.
 * Import this in renderer code for type safety.
 *
 * Domain types live in `src/shared/usageTypes.ts`. This file imports them so
 * the IPC contract can't drift between main and renderer.
 */

import type {
  AuthType,
  UsageStatus,
  UsageMetric,
  UsageMetricPolarity,
  UsageMetricScope,
  UsageMetricSource,
  UsageData,
  UsageHistoryPoint,
  PublicServiceProfile,
  LegacySubModel,
  AgentCredits,
  SessionAction
} from '../shared/usageTypes'

// Re-export so renderer code can `import type { UsageData } from '../../preload'` if it prefers,
// without reaching across the layer boundary directly.
export type {
  AuthType,
  UsageStatus,
  UsageMetric,
  UsageMetricPolarity,
  UsageMetricScope,
  UsageMetricSource,
  UsageData,
  UsageHistoryPoint,
  PublicServiceProfile,
  LegacySubModel,
  AgentCredits,
  SessionAction
}

interface CredentialListItem {
  service: string
  keys: Array<{ key: string; masked: string }>
}

interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source: 'main' | 'renderer' | 'scraper'
}

interface CredentialAPI {
  set(service: string, key: string, value: string): Promise<{ success: boolean }>
  getPublicValue(service: string, key: string): Promise<string | null>
  delete(service: string, key: string): Promise<{ success: boolean }>
  list(): Promise<CredentialListItem[]>
}

interface RefreshTimes {
  lastRefresh: string | null
  nextRefresh: string | null
}

interface UsageAPI {
  fetch(serviceId?: string, force?: boolean): Promise<UsageData | UsageData[]>
  getCached(): Promise<UsageData[]>
  openLogin(serviceId: string): Promise<{
    success: boolean
    error?: string
    pendingManualImport?: boolean
    message?: string
  }>
  reconnect(serviceId: string, clean?: boolean): Promise<{
    success: boolean
    error?: string
    usage?: UsageData
  }>
  disconnect(serviceId: string): Promise<{ success: boolean; error?: string }>
  openLoginHailuo(): Promise<{ success: boolean }>
  openLoginAgent(): Promise<{ success: boolean }>
  importCookies(serviceId?: string): Promise<Record<string, boolean>>
  warmUp(): Promise<{ started: boolean }>
  getRefreshTimes(): Promise<RefreshTimes>
  getHistory(days: number): Promise<UsageHistoryPoint[]>
  getIpcStatus(): Promise<{
    ok: boolean
    expected: string[]
    registered: string[]
    missing: string[]
    cursorWritePath?: string
  }>
  closeBrowsers(): Promise<{ success: boolean; closed: number; services: string[] }>
  getBrowserStatus(): Promise<{ running: number; services: string[] }>
  onRefreshComplete(callback: () => void): () => void
  onProgress(callback: (data: { serviceId: string; usage: UsageData }) => void): () => void
}

interface SettingsAPI {
  getProfiles(): Promise<PublicServiceProfile[]>
  getEnabled(): Promise<string[]>
  setEnabled(serviceIds: string[]): Promise<{ success: boolean }>
  getDebugMode(): Promise<boolean>
  setDebugMode(enabled: boolean): Promise<{ success: boolean }>
}

interface StorageAPI {
  getUsage(): Promise<Array<{ id: string; label: string; path: string; bytes: number }>>
  prune(): Promise<{
    removedBytes: number
    removedPaths: string[]
    errors: Array<{ path: string; error: string }>
  }>
}

interface LogsAPI {
  getAll(): Promise<LogEntry[]>
  clear(): Promise<{ success: boolean }>
  log(level: LogEntry['level'], message: string, source?: LogEntry['source']): Promise<void>
  info(message: string): Promise<void>
  warn(message: string): Promise<void>
  error(message: string): Promise<void>
  debug(message: string): Promise<void>
  onEntries(callback: (entries: LogEntry[]) => void): () => void
}

declare global {
  interface Window {
    credentialAPI: CredentialAPI
    usageAPI: UsageAPI
    settingsAPI: SettingsAPI
    storageAPI: StorageAPI
    logsAPI: LogsAPI
  }
}
