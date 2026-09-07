import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'

// Log entry type
export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source: 'main' | 'renderer' | 'scraper'
}

// Circular buffer to store logs (max 300 entries)
class LogBuffer {
  private logs: LogEntry[] = []
  private maxSize = 300
  private listeners: ((log: LogEntry) => void)[] = []

  add(log: LogEntry) {
    this.logs.push(log)
    if (this.logs.length > this.maxSize) {
      this.logs.shift()
    }
    // Notify listeners
    this.listeners.forEach((listener) => listener(log))
  }

  getAll(): LogEntry[] {
    return [...this.logs]
  }

  clear() {
    this.logs = []
  }

  onLog(callback: (log: LogEntry) => void) {
    this.listeners.push(callback)
    return () => {
      const index = this.listeners.indexOf(callback)
      if (index > -1) this.listeners.splice(index, 1)
    }
  }
}

export const logBuffer = new LogBuffer()

// ─── Push-based log delivery ─────────────────────────────────
// On each added entry, broadcast the full entries array to all windows via
// 'logs:entries'. Throttled to at most 4 sends/second with a trailing flush
// so no entries are lost during log bursts. The renderer subscribes via the
// preload onEntries API; 'logs:get' polling remains as-is for compatibility.
const LOG_BROADCAST_MIN_INTERVAL_MS = 250
let lastLogBroadcastAt = 0
let logBroadcastTimer: NodeJS.Timeout | null = null

function broadcastLogEntries(): void {
  const entries = logBuffer.getAll()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('logs:entries', entries)
    }
  }
}

function scheduleLogBroadcast(): void {
  const now = Date.now()
  const elapsed = now - lastLogBroadcastAt

  if (elapsed >= LOG_BROADCAST_MIN_INTERVAL_MS) {
    lastLogBroadcastAt = now
    broadcastLogEntries()
    return
  }

  // Trailing send — coalesce bursts into one broadcast per interval.
  if (!logBroadcastTimer) {
    logBroadcastTimer = setTimeout(() => {
      logBroadcastTimer = null
      lastLogBroadcastAt = Date.now()
      broadcastLogEntries()
    }, LOG_BROADCAST_MIN_INTERVAL_MS - elapsed)
  }
}

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2)
}

// Create a log entry
function createLogEntry(
  level: LogEntry['level'],
  message: string,
  source: LogEntry['source'] = 'main'
): LogEntry {
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    level,
    message,
    source
  }
}

// Override console methods to capture logs
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug
}

export function initializeLogCapture(): void {
  // Override console.log
  console.log = (...args: any[]) => {
    const message = args.map((arg) => formatArg(arg)).join(' ')
    const entry = createLogEntry('info', message, 'main')
    logBuffer.add(entry)
    originalConsole.log.apply(console, args)
  }

  // Override console.warn
  console.warn = (...args: any[]) => {
    const message = args.map((arg) => formatArg(arg)).join(' ')
    const entry = createLogEntry('warn', message, 'main')
    logBuffer.add(entry)
    originalConsole.warn.apply(console, args)
  }

  // Override console.error
  console.error = (...args: any[]) => {
    const message = args.map((arg) => formatArg(arg)).join(' ')
    const entry = createLogEntry('error', message, 'main')
    logBuffer.add(entry)
    originalConsole.error.apply(console, args)
  }

  // Override console.debug
  console.debug = (...args: any[]) => {
    const message = args.map((arg) => formatArg(arg)).join(' ')
    const entry = createLogEntry('debug', message, 'main')
    logBuffer.add(entry)
    originalConsole.debug.apply(console, args)
  }

  // Register IPC handlers
  registerLogHandlers()

  // Push new log entries to all renderer windows (throttled, see above).
  // Covers console.* captures, addLog(), and renderer-originated 'logs:log'
  // entries since they all flow through logBuffer.add().
  subscribeToLogs(() => scheduleLogBroadcast())

  // Log initialization
  console.log('[logManager] Log capture initialized')
}

// Format argument for logging
function formatArg(arg: any): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack}`
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg, null, 2)
    } catch {
      return String(arg)
    }
  }
  return String(arg)
}

// Register IPC handlers for logs
function registerLogHandlers(): void {
  // Get all logs
  ipcMain.handle('logs:get', () => {
    return logBuffer.getAll()
  })

  // Clear logs
  ipcMain.handle('logs:clear', () => {
    logBuffer.clear()
    return { success: true }
  })

  // Receive logs from renderer
  ipcMain.handle(
    'logs:log',
    (_event: IpcMainInvokeEvent, entry: Omit<LogEntry, 'id' | 'timestamp'>) => {
      const fullEntry: LogEntry = {
        ...entry,
        id: generateId(),
        timestamp: new Date().toISOString()
      }
      logBuffer.add(fullEntry)
      return { success: true }
    }
  )
}

// Export function to add logs programmatically (for scrapers, etc.)
export function addLog(level: LogEntry['level'], message: string, source: LogEntry['source'] = 'main'): void {
  const entry = createLogEntry(level, message, source)
  logBuffer.add(entry)
}

// Subscribe to new logs (for pushing to renderer)
export function subscribeToLogs(callback: (log: LogEntry) => void): () => void {
  return logBuffer.onLog(callback)
}
