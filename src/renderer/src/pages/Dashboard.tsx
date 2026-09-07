import { useState, useEffect, useCallback, useRef } from 'react'
import type { JSX } from 'react'
import { Link } from 'react-router-dom'
import { UsageCard } from '../components/UsageCard'
import { useToast } from '../components/Toast'
import type { UsageData } from '../../../shared/usageTypes'
import { CURSOR_WRITE_PATH, preferNewerCursorUsage } from '../../../shared/cursorUsage'

function mergeCachedUsage(current: UsageData[], incoming: UsageData[]): UsageData[] {
  const prev = new Map(current.map((row) => [row.service, row]))
  return incoming.map((row) => preferNewerCursorUsage(prev.get(row.service), row))
}

interface RefreshTimes {
  lastRefresh: string | null
  nextRefresh: string | null
}

// Format time remaining
function formatTimeRemaining(targetDate: Date | null): string {
  if (!targetDate) return 'Unknown'

  const now = new Date()
  const diff = targetDate.getTime() - now.getTime()

  if (diff <= 0) return 'Refreshing...'

  const minutes = Math.floor(diff / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function isMissingIpcHandlerError(err: unknown, channel: string): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('No handler registered') && message.includes(channel)
}

function staleMainProcessMessage(channel: string): string {
  return `The renderer has the ${channel} call, but the running Electron main process is stale and did not register it. Fully close Agent Stats and start it again so main/preload/renderer are from the same build.`
}

export function Dashboard(): JSX.Element {
  const usageAPI = window.usageAPI

  if (!usageAPI) {
    return <BridgeUnavailableState />
  }

  return <DashboardContent usageAPI={usageAPI} />
}

function BridgeUnavailableState(): JSX.Element {
  return (
    <div style={{ display: 'grid', minHeight: '320px', placeItems: 'center', color: 'var(--text-2)' }}>
      <div style={{
        maxWidth: '420px',
        padding: '24px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-2)',
        textAlign: 'center'
      }}>
        <h2 style={{ color: 'var(--text-1)', fontSize: 'var(--fs-lg)', marginBottom: '8px' }}>
          Electron bridge unavailable
        </h2>
        <p style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
          Agent Stats needs to run inside the desktop app to load usage data.
        </p>
      </div>
    </div>
  )
}

function DashboardContent({ usageAPI }: { usageAPI: NonNullable<typeof window.usageAPI> }): JSX.Element {
  const [usageData, setUsageData] = useState<UsageData[]>([])
  const [loadingServices, setLoadingServices] = useState<Set<string>>(new Set())
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshTimes, setRefreshTimes] = useState<RefreshTimes>({ lastRefresh: null, nextRefresh: null })
  const [timeRemaining, setTimeRemaining] = useState<string>('Unknown')
  const [online, setOnline] = useState(() => navigator.onLine)
  const toast = useToast()

  const warmedUp = useRef(false)
  // Mirror usageData in a ref so callbacks can read the latest snapshot without
  // listing it as a dependency (avoids resetting the polling interval on every progress event).
  const usageDataRef = useRef<UsageData[]>([])
  useEffect(() => {
    usageDataRef.current = usageData
  }, [usageData])

  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // Load cached data on mount, then trigger background warm-up
  useEffect(() => {
    usageAPI.getCached().then((cached) => {
      setUsageData(cached)

      // Ask main process to warm up in the background after showing cached data.
      if (!warmedUp.current) {
        warmedUp.current = true
        usageAPI.warmUp().catch(() => { })
      }
    })
  }, [usageAPI])

  useEffect(() => {
    const warnStaleMain = (): void => {
      toast.error(
        'Restart Agent Stats',
        'This window is running an old main process. Close Agent Stats completely, then start it with run.bat so Cursor can fetch Plan & Usage from cursor.com.'
      )
    }
    usageAPI.getIpcStatus()
      .then((status) => {
        if (!status || status.cursorWritePath !== CURSOR_WRITE_PATH) {
          warnStaleMain()
        }
      })
      .catch(() => {
        warnStaleMain()
      })
  }, [toast, usageAPI])

  // Fetch refresh times
  const fetchRefreshTimes = useCallback(async () => {
    try {
      const times = await usageAPI.getRefreshTimes()
      setRefreshTimes(times)
    } catch (err) {
      console.error('Failed to get refresh times:', err)
    }
  }, [usageAPI])

  // Update countdown timer — 5s cadence is enough for a minute-granularity display
  useEffect(() => {
    fetchRefreshTimes()

    const interval = setInterval(() => {
      if (refreshTimes.nextRefresh) {
        setTimeRemaining(formatTimeRemaining(new Date(refreshTimes.nextRefresh)))
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [refreshTimes.nextRefresh, fetchRefreshTimes])

  const fetchAll = useCallback(async (showLoading = true) => {
    if (showLoading) setRefreshingAll(true)

    // Mark every card as loading so each shows its own spinner. As per-service
    // results stream in via 'usage:progress', the listener (set up below) will
    // clear each one independently. Read from ref so we don't have to depend
    // on usageData (which would reset the polling interval).
    if (showLoading) {
      setLoadingServices(new Set(usageDataRef.current.map((d) => d.service)))
    }

    try {
      const data = (await usageAPI.fetch(undefined, true)) as UsageData[]
      setUsageData((prev) => mergeCachedUsage(prev, data))
      // Refresh the timer after fetching
      await fetchRefreshTimes()
    } catch (err) {
      console.error('Failed to fetch usage:', err)
    } finally {
      setRefreshingAll(false)
      setLoadingServices(new Set())
    }
  }, [fetchRefreshTimes, usageAPI])

  // Main process owns scheduling; the renderer only listens for pushed updates.
  useEffect(() => {
    const cleanup = usageAPI.onRefreshComplete?.(() => {
      usageAPI.getCached().then((cached) => {
        setUsageData((prev) => mergeCachedUsage(prev, cached))
      }).catch(() => {})
      fetchRefreshTimes()
    })

    // Stream per-service results as each scraper finishes during Refresh All.
    // This lets fast cards (Gemini, Cursor) settle in <2s while slow ones keep
    // their own spinner.
    const progressCleanup = usageAPI.onProgress?.(
      (data: { serviceId: string; usage: UsageData }) => {
        const { serviceId, usage } = data
        setUsageData((prev) =>
          prev.map((item) => (item.service === serviceId ? preferNewerCursorUsage(item, usage) : item))
        )
        setLoadingServices((prev) => {
          if (!prev.has(serviceId)) return prev
          const next = new Set(prev)
          next.delete(serviceId)
          return next
        })
      }
    )

    return () => {
      if (cleanup) cleanup()
      if (progressCleanup) progressCleanup()
    }
  }, [fetchRefreshTimes, usageAPI])

  const fetchSingle = useCallback(async (serviceId: string) => {
    setLoadingServices((prev) => new Set(prev).add(serviceId))

    try {
      const data = (await usageAPI.fetch(serviceId, true)) as UsageData
      setUsageData((prev) =>
        prev.map((item) => (item.service === serviceId ? preferNewerCursorUsage(item, data) : item))
      )
    } catch (err) {
      console.error(`Failed to fetch ${serviceId}:`, err)
    } finally {
      setLoadingServices((prev) => {
        const next = new Set(prev)
        next.delete(serviceId)
        return next
      })
    }
  }, [usageAPI])

  const importCookies = useCallback(async (serviceId: string) => {
    setLoadingServices((prev) => new Set(prev).add(serviceId))

    try {
      const results = await usageAPI.importCookies(serviceId)
      const data = (await usageAPI.fetch(serviceId, true)) as UsageData
      setUsageData((prev) =>
        prev.map((item) => (item.service === serviceId ? preferNewerCursorUsage(item, data) : item))
      )

      if (!results[serviceId]) {
        const title = data.manualCookieRefresh ? 'Reconnect Required' : 'Refresh Required'
        const msg = data.manualCookieRefresh
          ? (data.error || 'Reconnect this service after signing in.')
          : (data.error || 'Click Open Browser, sign in there, then click Refresh.')
        toast.error(title, msg)
      }
    } catch (err) {
      toast.error('Reconnect Error', String(err))
    } finally {
      setLoadingServices((prev) => {
        const next = new Set(prev)
        next.delete(serviceId)
        return next
      })
    }
  }, [toast, usageAPI])

  const handleLogin = useCallback(async (serviceId: string) => {
    try {
      const result = await usageAPI.openLogin(serviceId)

      if (result && result.success === false && result.error) {
        toast.warning('Notice', result.error)
        return
      }

      if (result?.pendingManualImport) {
        toast.info('Finish In Chrome', result.message || 'Complete login in the browser, then refresh this service.')
        return
      }
    } catch (err: any) {
      toast.error('IPC Error', String(err))
      return
    }

    await fetchSingle(serviceId)
  }, [fetchSingle, toast, usageAPI])

  const handleReconnect = useCallback(async (serviceId: string) => {
    setLoadingServices((prev) => new Set(prev).add(serviceId))

    try {
      const result = await usageAPI.reconnect(serviceId)
      if (result?.usage) {
        setUsageData((prev) =>
          prev.map((item) => (item.service === serviceId ? result.usage as UsageData : item))
        )
      } else {
        const data = (await usageAPI.fetch(serviceId, true)) as UsageData
        setUsageData((prev) =>
          prev.map((item) => (item.service === serviceId ? data : item))
        )
      }

      if (result?.success === false && result.error) {
        toast.warning('Reconnect incomplete', result.error)
      }
      await fetchRefreshTimes()
    } catch (err) {
      if (isMissingIpcHandlerError(err, 'usage:reconnect')) {
        toast.error('Restart Agent Stats', staleMainProcessMessage('usage:reconnect'))
      } else {
        toast.error('Reconnect error', String(err))
      }
    } finally {
      setLoadingServices((prev) => {
        const next = new Set(prev)
        next.delete(serviceId)
        return next
      })
    }
  }, [fetchRefreshTimes, toast, usageAPI])

  const handleDisconnect = useCallback(async (serviceId: string) => {
    try {
      const result = await usageAPI.disconnect(serviceId)
      if (!result?.success) {
        toast.error('Disconnect failed', result?.error ?? 'Unknown error')
        return
      }
      toast.success(
        'Disconnected',
        serviceId === 'minimax'
          ? 'MiniMax session cleared (including Hailuo & Agent sub-accounts). Click Sign In to connect a new account.'
          : 'Session cleared. Click Sign In to reconnect.'
      )
      await fetchSingle(serviceId)
    } catch (err) {
      toast.error('Disconnect error', String(err))
    }
  }, [fetchSingle, toast, usageAPI])

  // Enabled services only (disabled disappear entirely)
  const visibleServices = usageData.filter((d) => d.status !== 'disabled')

  const sortedServices = visibleServices
    .slice()
    .sort((a, b) => {
      const score = (d: UsageData) => {
        if (d.status === 'ok') return 0
        if (d.status === 'cookies_expired') return 1
        return 2
      }
      return score(a) - score(b)
    })

  return (
    <div className="db-page">
      {/* Single-row header: Refresh All must never wrap below */}
      <div className="page-header db-header" style={{ flexWrap: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ flexShrink: 0 }}>
            <h2 style={{ margin: 0 }}>Usage</h2>
            <p className="db-subtitle">Live quotas across enabled services</p>
          </div>

          {refreshTimes.nextRefresh && (
            <div className="db-pill db-pill-live">
              <span className="db-live-dot" />
              <span>Auto in <span className="num" style={{ color: 'var(--text-1)', fontWeight: 600 }}>{timeRemaining}</span></span>
              {refreshTimes.lastRefresh && (
                <span className="num" style={{ color: 'var(--text-3)', marginLeft: '2px' }}>
                  · {new Date(refreshTimes.lastRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          )}
        </div>

        <button
          className={`btn btn-secondary db-refresh${refreshingAll ? ' is-busy' : ''}`}
          style={{ flexShrink: 0 }}
          onClick={() => fetchAll(true)}
          disabled={refreshingAll}
        >
          {refreshingAll ? (
            <>
              <span className="loading-spinner" />
              Refreshing
            </>
          ) : (
            <>
              <span aria-hidden="true" style={{ fontSize: '14px' }}>↻</span>
              Refresh All
            </>
          )}
        </button>
      </div>

      {!online && (
        <div className="notice-bar" style={{ marginBottom: 12 }}>
          <span className="notice-icon">!</span>
          <span>
            You appear offline. Scrapers are paused so they do not hog the network adapter.
            Cached usage stays on the cards.
          </span>
        </div>
      )}

      <div className="usage-grid">
        {sortedServices.map((data, index) => (
            <UsageCard
              key={data.service}
              data={data}
              onRefresh={fetchSingle}
              onLogin={handleLogin}
              onReconnect={handleReconnect}
              onDisconnect={handleDisconnect}
              onImportCookies={importCookies}
              loading={loadingServices.has(data.service)}
              enterDelayMs={index * 45}
            />
          ))}
      </div>

      {visibleServices.length === 0 && (
        <div className="empty-state">
          <svg className="empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
          <h3>{usageData.length > 0 ? 'All services are hidden' : 'No services configured yet'}</h3>
          <p>
            {usageData.length > 0
              ? 'Enable the services you use in Settings and they will show up here.'
              : 'Add your API keys or sign in via browser to start tracking usage across your AI services.'}
          </p>
          <Link to="/settings" className="btn btn-primary">Open Settings</Link>
        </div>
      )}
    </div>
  )
}
