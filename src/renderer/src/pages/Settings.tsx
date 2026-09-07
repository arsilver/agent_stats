import { useState, useEffect, useCallback, useRef } from 'react'
import type { JSX } from 'react'
import { useToast } from '../components/Toast'

interface ServiceConfig {
  id: string
  displayName: string
  iconColor: string
  planTier: string
  authType: 'api_key' | 'oauth' | 'bearer' | 'web_session'
  dashboardUrl: string | null
  usageUnit: string
  currentKey: string | null
  masked: string | null
  enabled: boolean
  refreshIntervalMs?: number
}

interface StorageUsageEntry {
  id: string
  label: string
  path: string
  bytes: number
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return '****'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export function Settings(): JSX.Element {
  const [configs, setConfigs] = useState<ServiceConfig[]>([])
  const [editingService, setEditingService] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toast = useToast()
  const [enabledServices, setEnabledServices] = useState<string[]>([])
  const [debugMode, setDebugMode] = useState(false)
  const [showApiKeys, setShowApiKeys] = useState(false)
  const [storageUsage, setStorageUsage] = useState<StorageUsageEntry[]>([])
  const [cleaningStorage, setCleaningStorage] = useState(false)
  const [closingBrowsers, setClosingBrowsers] = useState(false)
  const [browserStatus, setBrowserStatus] = useState<{ running: number; services: string[] }>({
    running: 0,
    services: []
  })

  // Load current credentials, enabled services, and debug mode on mount
  useEffect(() => {
    loadCredentials()
    window.settingsAPI.getDebugMode().then((enabled) => {
      setDebugMode(enabled)
    }).catch(() => {})
    loadStorageUsage()
    loadBrowserStatus()
  }, [])

  const loadCredentials = useCallback(async () => {
    const [credentialList, profiles, enabledIds] = await Promise.all([
      window.credentialAPI.list(),
      window.settingsAPI.getProfiles(),
      window.settingsAPI.getEnabled()
    ])
    setEnabledServices(enabledIds)

    const result: ServiceConfig[] = profiles.map((svc) => {
      const found = credentialList.find((c: any) => c.service === svc.id)
      const apiKeyEntry = found?.keys.find((k: any) => k.key === 'api_key')

      return {
        ...svc,
        currentKey: null,
        masked: apiKeyEntry?.masked || null,
        enabled: enabledIds.includes(svc.id)
      }
    })

    setConfigs(result)
  }, [])

  const handleSave = useCallback(
    async (serviceId: string) => {
      if (!inputValue.trim()) return

      setSaving(true)
      try {
        await window.credentialAPI.set(serviceId, 'api_key', inputValue.trim())
        setEditingService(null)
        setInputValue('')
        await loadCredentials()
        const name = configs.find(s => s.id === serviceId)?.displayName || serviceId
        toast.success(`API key saved for ${name}`)
      } catch (err) {
        console.error('Failed to save credential:', err)
        toast.error('Save failed', String(err))
      } finally {
        setSaving(false)
      }
    },
    [inputValue, loadCredentials]
  )

  const handleDeleteClick = useCallback((serviceId: string) => {
    if (confirmingDelete === serviceId) {
      // Second click — actually delete
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmingDelete(null)
      window.credentialAPI.delete(serviceId, 'api_key').then(async () => {
        await loadCredentials()
        const name = configs.find(s => s.id === serviceId)?.displayName || serviceId
        toast.success(`API key removed for ${name}`)
      }).catch(err => {
        console.error('Failed to delete credential:', err)
        toast.error('Delete failed', String(err))
      })
    } else {
      // First click — show confirmation state for 3 seconds
      setConfirmingDelete(serviceId)
      confirmTimerRef.current = setTimeout(() => setConfirmingDelete(null), 3000)
    }
  }, [confirmingDelete, loadCredentials, toast])

  const handleLogin = useCallback(async (serviceId: string) => {
    await window.usageAPI.openLogin(serviceId)
  }, [])

  const handleToggleEnabled = useCallback(async (serviceId: string, enabled: boolean) => {
    const next = enabled
      ? [...enabledServices, serviceId]
      : enabledServices.filter((id) => id !== serviceId)
    setEnabledServices(next)
    setConfigs((prev) =>
      prev.map((c) => (c.id === serviceId ? { ...c, enabled } : c))
    )
    try {
      await window.settingsAPI.setEnabled(next)
    } catch (err) {
      console.error('Failed to save enabled services:', err)
    }
  }, [enabledServices])

  const handleToggleDebugMode = useCallback(async (enabled: boolean) => {
    setDebugMode(enabled)
    try {
      await window.settingsAPI.setDebugMode(enabled)
      toast.success(enabled ? 'Debug mode enabled' : 'Debug mode disabled')
    } catch (err) {
      console.error('Failed to toggle debug mode:', err)
      toast.error('Failed to toggle debug mode', String(err))
    }
  }, [])

  const loadBrowserStatus = useCallback(async () => {
    try {
      const status = await window.usageAPI.getBrowserStatus()
      setBrowserStatus(status)
    } catch {
      setBrowserStatus({ running: 0, services: [] })
    }
  }, [])

  const handleCloseBrowsers = useCallback(async () => {
    setClosingBrowsers(true)
    try {
      const result = await window.usageAPI.closeBrowsers()
      await loadBrowserStatus()
      if (result.closed === 0) {
        toast.info('No managed browsers running')
      } else {
        toast.success(
          'Browsers closed',
          `Stopped ${result.closed} Chrome instance${result.closed === 1 ? '' : 's'}. Usage cards keep cached data.`
        )
      }
    } catch (err) {
      toast.error('Could not close browsers', String(err))
    } finally {
      setClosingBrowsers(false)
    }
  }, [loadBrowserStatus, toast])

  useEffect(() => {
    const timer = setInterval(() => {
      void loadBrowserStatus()
    }, 10000)
    return () => clearInterval(timer)
  }, [loadBrowserStatus])

  const loadStorageUsage = useCallback(async () => {
    try {
      const usage = await window.storageAPI.getUsage()
      setStorageUsage(usage.sort((a, b) => b.bytes - a.bytes))
    } catch (err) {
      console.error('Failed to load storage usage:', err)
    }
  }, [])

  const handlePruneStorage = useCallback(async () => {
    setCleaningStorage(true)
    try {
      const result = await window.storageAPI.prune()
      await loadStorageUsage()
      const mb = Math.round(result.removedBytes / 1024 / 1024)
      if (result.errors.length > 0) {
        toast.warning('Storage cleaned', `Reclaimed ${mb} MB. ${result.errors.length} locked paths were skipped.`)
      } else {
        toast.success('Storage cleaned', `Reclaimed ${mb} MB.`)
      }
    } catch (err) {
      toast.error('Storage cleanup failed', String(err))
    } finally {
      setCleaningStorage(false)
    }
  }, [loadStorageUsage, toast])

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
    return `${Math.round(bytes / 1024)} KB`
  }

  const trackedCount = configs.filter((c) => c.enabled).length

  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
      </div>

      {configs.length > 0 && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)', margin: '-4px 0 16px' }}>
          <strong style={{ color: 'var(--text-2)' }}>
            Tracking {trackedCount} of {configs.length} services
          </strong>
          {' · '}disabled services aren’t scraped or shown on the Dashboard or Analytics.
          {' · '}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowApiKeys((v) => !v)}
          >
            {showApiKeys ? 'Hide API keys' : 'Show API keys'}
          </button>
        </div>
      )}

      <div className="settings-list">
        {configs.map((svc) => (
          <div key={svc.id} className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-title">
                <div className="service-dot" style={{ backgroundColor: svc.iconColor }} />
                <span className="service-name">{svc.displayName}</span>
                <span className="plan-tier">{svc.planTier}</span>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: 'var(--fs-xs)',
                    fontWeight: 600,
                    color: svc.enabled ? 'var(--ok)' : 'var(--text-3)',
                    userSelect: 'none'
                  }}
                  title={svc.enabled
                    ? 'Tracked — scraped on schedule and shown on the Dashboard. Turn off to stop scraping it.'
                    : 'Off — not scraped and hidden from the Dashboard. Turn on to track it.'}
                >
                  <input
                    type="checkbox"
                    className="toggle"
                    checked={svc.enabled}
                    onChange={(e) => handleToggleEnabled(svc.id, e.target.checked)}
                  />
                  {svc.enabled ? 'Tracked' : 'Off'}
                </label>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleLogin(svc.id)}
                >
                  Web Login
                </button>
              </div>
            </div>

            {showApiKeys && (
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 'var(--fs-xs)',
                  color: 'var(--text-3)',
                  marginBottom: '6px'
                }}
              >
                API Key
              </label>

              {editingService === svc.id ? (
                <div className="credential-input-row">
                  <input
                    type="password"
                    placeholder="Paste your API key..."
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSave(svc.id)
                      if (e.key === 'Escape') {
                        setEditingService(null)
                        setInputValue('')
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleSave(svc.id)}
                    disabled={saving || !inputValue.trim()}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setEditingService(null)
                      setInputValue('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : svc.masked ? (
                <div className="credential-input-row">
                  <div className="credential-masked">{svc.masked}</div>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setEditingService(svc.id)
                      setInputValue('')
                    }}
                  >
                    Update
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDeleteClick(svc.id)}
                    style={confirmingDelete === svc.id ? {
                      background: 'var(--danger)',
                      color: '#fff',
                      fontWeight: 700
                    } : undefined}
                  >
                    {confirmingDelete === svc.id ? 'Confirm?' : 'Remove'}
                  </button>
                </div>
              ) : (
                <div className="credential-input-row">
                  <span
                    style={{
                      flex: 1,
                      color: 'var(--text-3)',
                      fontSize: 'var(--fs-sm)'
                    }}
                  >
                    No API key configured
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      setEditingService(svc.id)
                      setInputValue('')
                    }}
                  >
                    Add Key
                  </button>
                </div>
              )}
            </div>
            )}
          </div>
        ))}

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <span className="service-name">Debug Mode</span>
              <span className="plan-tier">Advanced</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                className="toggle"
                checked={debugMode}
                onChange={(e) => handleToggleDebugMode(e.target.checked)}
              />
              <span style={{ fontSize: 'var(--fs-sm)', color: debugMode ? 'var(--ok)' : 'var(--text-3)' }}>
                {debugMode ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)', padding: '4px 0' }}>
            When enabled, saves debug snapshots of scraper pages to help troubleshoot login issues.
            Check the Logs page for debug output.
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <span className="service-name">Managed browsers</span>
              <span className="plan-tier">
                {browserStatus.running === 0 ? 'Idle' : `${browserStatus.running} running`}
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { void handleCloseBrowsers() }}
              disabled={closingBrowsers || browserStatus.running === 0}
            >
              {closingBrowsers ? 'Closing...' : 'Close browsers'}
            </button>
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)', padding: '4px 0' }}>
            Agent Stats opens extra Chrome windows to read usage. Close them if the network
            adapter feels stuck. Cards keep cached numbers; the next refresh will relaunch
            only what is due.
            {browserStatus.services.length > 0
              ? ` Running: ${browserStatus.services.join(', ')}.`
              : ''}
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <span className="service-name">Session Storage</span>
              <span className="plan-tier">
                {formatBytes(storageUsage.reduce((sum, item) => sum + item.bytes, 0))}
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handlePruneStorage}
              disabled={cleaningStorage}
            >
              {cleaningStorage ? 'Cleaning...' : 'Clean Cache'}
            </button>
          </div>
          <div style={{ display: 'grid', gap: '6px', paddingTop: '4px' }}>
            {storageUsage.slice(0, 6).map((item) => (
              <div key={`${item.label}-${item.path}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                <span className="num" style={{ color: 'var(--text-2)', flexShrink: 0 }}>{formatBytes(item.bytes)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
