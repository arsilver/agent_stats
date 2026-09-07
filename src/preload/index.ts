import { contextBridge, ipcRenderer } from 'electron'

// ─── Credential API ──────────────────────────────────────────
const credentialAPI = {
  set: (service: string, key: string, value: string) =>
    ipcRenderer.invoke('credentials:set', service, key, value),

  getPublicValue: (service: string, key: string) =>
    ipcRenderer.invoke('credentials:getPublicValue', service, key),

  delete: (service: string, key: string) =>
    ipcRenderer.invoke('credentials:delete', service, key),

  list: () => ipcRenderer.invoke('credentials:list')
}

// ─── Usage API ───────────────────────────────────────────────
const usageAPI = {
  fetch: (serviceId?: string, force?: boolean) =>
    ipcRenderer.invoke('usage:fetch', serviceId, force),

  getCached: () => ipcRenderer.invoke('usage:getCached'),

  openLogin: (serviceId: string) =>
    ipcRenderer.invoke('usage:openLogin', serviceId),

  reconnect: (serviceId: string, clean?: boolean) =>
    ipcRenderer.invoke('usage:reconnect', serviceId, clean),

  disconnect: (serviceId: string) =>
    ipcRenderer.invoke('usage:disconnect', serviceId) as Promise<{ success: boolean; error?: string }>,

  openLoginHailuo: () =>
    ipcRenderer.invoke('usage:openLoginHailuo'),

  openLoginAgent: () =>
    ipcRenderer.invoke('usage:openLoginAgent'),

  importCookies: (serviceId?: string) => ipcRenderer.invoke('usage:importCookies', serviceId),

  warmUp: () => ipcRenderer.invoke('usage:warmUp'),

  getRefreshTimes: () => ipcRenderer.invoke('usage:getRefreshTimes') as Promise<RefreshTimes>,

  getHistory: (days: number) => ipcRenderer.invoke('usage:getHistory', days),

  getIpcStatus: () => ipcRenderer.invoke('usage:getIpcStatus'),

  closeBrowsers: () => ipcRenderer.invoke('usage:closeBrowsers'),

  getBrowserStatus: () => ipcRenderer.invoke('usage:getBrowserStatus'),

  onRefreshComplete: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('usage-refresh-complete', handler)
    return () => ipcRenderer.removeListener('usage-refresh-complete', handler)
  },

  onProgress: (callback: (data: { serviceId: string; usage: unknown }) => void) => {
    const handler = (_event: unknown, data: { serviceId: string; usage: unknown }): void =>
      callback(data)
    ipcRenderer.on('usage:progress', handler)
    return () => ipcRenderer.removeListener('usage:progress', handler)
  }
}

// ─── Refresh Times API ───────────────────────────────────────
interface RefreshTimes {
  lastRefresh: string | null
  nextRefresh: string | null
}

// ─── Settings API ──────────────────────────────────────────
const settingsAPI = {
  getProfiles: () => ipcRenderer.invoke('settings:getProfiles'),
  getEnabled: () => ipcRenderer.invoke('settings:getEnabled'),
  setEnabled: (serviceIds: string[]) => ipcRenderer.invoke('settings:setEnabled', serviceIds),
  getDebugMode: () => ipcRenderer.invoke('settings:getDebugMode'),
  setDebugMode: (enabled: boolean) => ipcRenderer.invoke('settings:setDebugMode', enabled)
}

const storageAPI = {
  getUsage: () => ipcRenderer.invoke('storage:getUsage'),
  prune: () => ipcRenderer.invoke('storage:prune')
}

// ─── Logs API ────────────────────────────────────────────────
export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source: 'main' | 'renderer' | 'scraper'
}

const logsAPI = {
  getAll: () => ipcRenderer.invoke('logs:get'),

  clear: () => ipcRenderer.invoke('logs:clear'),

  log: (level: LogEntry['level'], message: string, source: LogEntry['source'] = 'renderer') =>
    ipcRenderer.invoke('logs:log', { level, message, source }),

  // Send logs from renderer to main
  info: (message: string) => ipcRenderer.invoke('logs:log', { level: 'info', message, source: 'renderer' }),
  warn: (message: string) => ipcRenderer.invoke('logs:log', { level: 'warn', message, source: 'renderer' }),
  error: (message: string) => ipcRenderer.invoke('logs:log', { level: 'error', message, source: 'renderer' }),
  debug: (message: string) => ipcRenderer.invoke('logs:log', { level: 'debug', message, source: 'renderer' }),

  // Main process broadcasts the full (throttled) log buffer on 'logs:entries'
  onEntries: (callback: (entries: LogEntry[]) => void) => {
    const handler = (_event: unknown, entries: LogEntry[]): void => callback(entries)
    ipcRenderer.on('logs:entries', handler)
    return () => ipcRenderer.removeListener('logs:entries', handler)
  }
}

// ─── Expose to renderer ─────────────────────────────────────
contextBridge.exposeInMainWorld('credentialAPI', credentialAPI)
contextBridge.exposeInMainWorld('usageAPI', usageAPI)
contextBridge.exposeInMainWorld('settingsAPI', settingsAPI)
contextBridge.exposeInMainWorld('storageAPI', storageAPI)
contextBridge.exposeInMainWorld('logsAPI', logsAPI)
