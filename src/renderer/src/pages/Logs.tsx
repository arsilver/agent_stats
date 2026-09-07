import { useState, useEffect, useRef, useCallback } from 'react'
import type { JSX } from 'react'

interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source: 'main' | 'renderer' | 'scraper'
}

const LOG_COLORS: Record<LogEntry['level'], string> = {
  info: 'var(--text-1)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
  debug: 'var(--text-3)'
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function formatFullDate(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function Logs(): JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'debug'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  // Full re-sync with the main-process log buffer
  const loadLogs = useCallback(async () => {
    try {
      const allLogs = await window.logsAPI.getAll()
      setLogs(allLogs)
    } catch (err) {
      console.error('Failed to load logs:', err)
    }
  }, [])

  useEffect(() => {
    loadLogs().then(() => setIsLoading(false))

    // Primary update path: main broadcasts the full buffer (throttled) on 'logs:entries'
    const unsubscribe = window.logsAPI.onEntries?.((entries) => {
      setLogs(entries)
    })

    if (!unsubscribe) {
      intervalRef.current = setInterval(loadLogs, 15000)
    }

    return () => {
      if (unsubscribe) unsubscribe()
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [loadLogs])

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  // Handle manual scroll to disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!logsContainerRef.current) return

    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
    setAutoScroll(isAtBottom)
  }, [])

  const handleClear = async () => {
    try {
      await window.logsAPI.clear()
      setLogs([])
    } catch (err) {
      console.error('Failed to clear logs:', err)
    }
  }

  const handleCopyAll = () => {
    const text = filteredLogs
      .map((log) => `[${formatTimestamp(log.timestamp)}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`)
      .join('\n')
    navigator.clipboard.writeText(text)
  }

  const handleCopyLog = (log: LogEntry) => {
    const text = `[${formatTimestamp(log.timestamp)}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`
    navigator.clipboard.writeText(text)
  }

  // Filter logs
  const filteredLogs = logs.filter((log) => {
    const matchesLevel = filter === 'all' || log.level === filter
    const matchesSearch =
      searchQuery === '' ||
      log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.source.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesLevel && matchesSearch
  })

  // Count by level
  const counts = {
    all: logs.length,
    info: logs.filter((l) => l.level === 'info').length,
    warn: logs.filter((l) => l.level === 'warn').length,
    error: logs.filter((l) => l.level === 'error').length,
    debug: logs.filter((l) => l.level === 'debug').length
  }

  return (
    <div className="logs-container" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="page-header" style={{ marginBottom: '12px', paddingBottom: '12px' }}>
        <h2>Logs</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary btn-sm" onClick={handleCopyAll}>
            Copy All
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>

      {/* Filters toolbar */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
        {/* Level filters */}
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {(['all', 'info', 'warn', 'error', 'debug'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={`filter-pill ${filter === level ? 'active' : ''}`}
            >
              {level} ({counts[level]})
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          className="text-input"
          placeholder="Search logs..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ flex: 1, minWidth: '150px' }}
        />

        {/* Auto-scroll toggle */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: 'var(--fs-xs)',
            color: 'var(--text-2)',
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          <input
            type="checkbox"
            className="toggle"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
      </div>

      {/* Logs list */}
      <div
        ref={logsContainerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 0',
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          lineHeight: 1.5
        }}
      >
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>
            Loading logs...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="empty-state" style={{ padding: '48px 24px', fontFamily: 'var(--font-sans)' }}>
            <svg className="empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15H17" />
            </svg>
            <h3>{logs.length === 0 ? 'No logs yet' : 'No matching logs'}</h3>
            <p>
              {logs.length === 0
                ? 'Log output from the app, scrapers and renderer will appear here as it happens.'
                : 'Try a different level filter or search query.'}
            </p>
            {logs.length > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={() => { setFilter('all'); setSearchQuery('') }}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div
              key={log.id}
              onClick={() => handleCopyLog(log)}
              style={{
                padding: '4px 24px',
                display: 'flex',
                gap: '12px',
                cursor: 'pointer',
                background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                borderLeft: '3px solid transparent',
                transition: 'background 0.1s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.borderLeftColor = LOG_COLORS[log.level]
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
                e.currentTarget.style.borderLeftColor = 'transparent'
              }}
              title={`Click to copy - ${formatFullDate(log.timestamp)}`}
            >
              {/* Timestamp */}
              <span className="num" style={{ color: 'var(--text-3)', minWidth: '86px', flexShrink: 0 }}>
                {formatTimestamp(log.timestamp)}
              </span>

              {/* Level badge */}
              <span
                style={{
                  color: LOG_COLORS[log.level],
                  minWidth: '45px',
                  fontWeight: 600,
                  flexShrink: 0,
                  textTransform: 'uppercase'
                }}
              >
                {log.level}
              </span>

              {/* Source badge */}
              <span
                style={{
                  color: 'var(--text-3)',
                  minWidth: '55px',
                  flexShrink: 0
                }}
              >
                {log.source}
              </span>

              {/* Message */}
              <span
                style={{
                  color: LOG_COLORS[log.level],
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  flex: 1
                }}
              >
                {log.message}
              </span>
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '8px 24px',
          borderTop: '1px solid var(--border)',
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-3)',
          display: 'flex',
          justifyContent: 'space-between'
        }}
      >
        <span>Showing {filteredLogs.length} of {logs.length} logs</span>
        <span>Last updated: {logs.length > 0 ? formatFullDate(logs[logs.length - 1]?.timestamp) : 'Never'}</span>
      </div>
    </div>
  )
}
