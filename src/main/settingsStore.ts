import { ipcMain, app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getAllProfiles } from './authProfiles'
import type { PublicServiceProfile } from '../shared/usageTypes'

interface AppSettings {
  enabledServices: string[]
  knownServiceIds: string[]
  debugMode: boolean
}

const LEGACY_KNOWN_SERVICE_IDS = [
  'chatgpt',
  'claude',
  'kimi-code',
  'minimax',
  'runwayml',
  'fal-ai',
  'openrouter',
  'cursor',
  'gemini'
]

function getCurrentServiceIds(): string[] {
  return getAllProfiles().map((p) => p.id)
}

const DEFAULT_SETTINGS: AppSettings = {
  enabledServices: getCurrentServiceIds(),
  knownServiceIds: getCurrentServiceIds(),
  debugMode: false
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

function readSettingsFile(): AppSettings {
  try {
    const path = getSettingsPath()
    if (!existsSync(path)) return { ...DEFAULT_SETTINGS }
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const currentServiceIds = getCurrentServiceIds()
    const previousKnownServiceIds = Array.isArray(parsed.knownServiceIds)
      ? parsed.knownServiceIds
      : LEGACY_KNOWN_SERVICE_IDS
    const enabledServices = Array.isArray(parsed.enabledServices)
      ? parsed.enabledServices.filter((id) => currentServiceIds.includes(id))
      : [...DEFAULT_SETTINGS.enabledServices]
    const newlyAddedServices = currentServiceIds.filter((id) => !previousKnownServiceIds.includes(id))
    const migrated: AppSettings = {
      enabledServices: [
        ...enabledServices,
        ...newlyAddedServices.filter((id) => !enabledServices.includes(id))
      ],
      knownServiceIds: currentServiceIds,
      debugMode: typeof parsed.debugMode === 'boolean' ? parsed.debugMode : DEFAULT_SETTINGS.debugMode
    }

    if (!Array.isArray(parsed.knownServiceIds) || newlyAddedServices.length > 0) {
      writeSettingsFile(migrated)
    }

    return migrated
  } catch (err) {
    console.error('[settingsStore] Failed to read settings file:', err)
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettingsFile(settings: AppSettings): void {
  try {
    writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (err) {
    console.error('[settingsStore] Failed to write settings file:', err)
  }
}

let cachedSettings: AppSettings | null = null

export function getEnabledServices(): string[] {
  if (!cachedSettings) {
    cachedSettings = readSettingsFile()
  }
  return [...cachedSettings.enabledServices]
}

export function setEnabledServices(serviceIds: string[]): void {
  if (!cachedSettings) cachedSettings = readSettingsFile()
  cachedSettings = {
    ...cachedSettings,
    enabledServices: [...serviceIds],
    knownServiceIds: getCurrentServiceIds()
  }
  writeSettingsFile(cachedSettings)
}

export function isServiceEnabled(serviceId: string): boolean {
  return getEnabledServices().includes(serviceId)
}

export function getPublicProfiles(): PublicServiceProfile[] {
  return getAllProfiles().map((profile) => ({
    id: profile.id,
    displayName: profile.displayName,
    planTier: profile.planTier,
    authType: profile.authType,
    dashboardUrl: profile.dashboardUrl,
    usageUnit: profile.usageUnit,
    iconColor: profile.iconColor,
    refreshIntervalMs: profile.refreshIntervalMs
  }))
}

export function enableService(serviceId: string): void {
  const current = getEnabledServices()
  if (!current.includes(serviceId)) {
    setEnabledServices([...current, serviceId])
  }
}

export function disableService(serviceId: string): void {
  const current = getEnabledServices()
  setEnabledServices(current.filter((id) => id !== serviceId))
}

export function isDebugMode(): boolean {
  if (!cachedSettings) {
    cachedSettings = readSettingsFile()
  }
  return cachedSettings.debugMode
}

export function setDebugMode(enabled: boolean): void {
  if (!cachedSettings) cachedSettings = readSettingsFile()
  cachedSettings = { ...cachedSettings, debugMode: enabled }
  writeSettingsFile(cachedSettings)
  if (enabled) {
    process.env.AGENT_STATS_SCRAPER_DEBUG = '1'
    console.log(`[settingsStore] Debug mode enabled - scraper snapshots will be saved`)
  } else {
    delete process.env.AGENT_STATS_SCRAPER_DEBUG
    console.log(`[settingsStore] Debug mode disabled`)
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getEnabled', () => {
    return getEnabledServices()
  })

  ipcMain.handle('settings:getProfiles', () => {
    return getPublicProfiles()
  })

  ipcMain.handle('settings:setEnabled', (_event, serviceIds: string[]) => {
    setEnabledServices(serviceIds)
    return { success: true }
  })

  ipcMain.handle('settings:getDebugMode', () => {
    return isDebugMode()
  })

  ipcMain.handle('settings:setDebugMode', (_event, enabled: boolean) => {
    setDebugMode(enabled)
    return { success: true }
  })
}
