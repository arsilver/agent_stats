import { existsSync, lstatSync, readdirSync, rmSync } from 'fs'
import { join, resolve, sep } from 'path'

export interface StorageUsageEntry {
  id: string
  label: string
  path: string
  bytes: number
}

export interface StorageCleanupResult {
  removedBytes: number
  removedPaths: string[]
  errors: Array<{ path: string; error: string }>
}

const SAFE_CACHE_DIR_NAMES = new Set([
  'blob_storage',
  'BrowserMetrics',
  'Cache',
  'Code Cache',
  'component_crx_cache',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DeferredBrowserMetrics',
  'extensions_crx_cache',
  'GPUCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'optimization_guide_hint_cache_store',
  'optimization_guide_model_store',
  'Safe Browsing',
  'Safe Browsing Network',
  'ShaderCache',
  'Shared Dictionary'
])

const SAFE_SERVICE_WORKER_CHILDREN = new Set([
  'CacheStorage',
  'ScriptCache'
])

const AUTH_CRITICAL_DIR_NAMES = new Set([
  'IndexedDB',
  'Local Storage',
  'Network',
  'Session Storage',
  'Sessions',
  'Storage',
  'Sync Data',
  'WebStorage'
])

const AUTH_CRITICAL_FILE_NAMES = new Set([
  'Cookies',
  'Extension Cookies',
  'Local State',
  'Preferences',
  'Secure Preferences'
])

function getElectronUserDataPath(): string {
  const electron = require('electron') as { app?: { getPath(name: string): string } }
  const userData = electron.app?.getPath('userData')
  if (!userData) {
    throw new Error('Electron app userData path is unavailable')
  }
  return userData
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
}

function getDirectorySize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0

  let total = 0
  const stack = [dirPath]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: string[] = []
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = join(current, entry)
      try {
        const stat = lstatSync(fullPath)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          stack.push(fullPath)
        } else {
          total += stat.size
        }
      } catch {
        // Ignore files that vanish or are locked while sizing.
      }
    }
  }

  return total
}

function collectStorageUsage(root: string, child: string, label: string): StorageUsageEntry[] {
  const base = join(root, child)
  if (!existsSync(base)) return []

  const entries: StorageUsageEntry[] = []
  try {
    for (const name of readdirSync(base)) {
      const fullPath = join(base, name)
      const stat = lstatSync(fullPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      entries.push({
        id: name,
        label: `${label}: ${name}`,
        path: fullPath,
        bytes: getDirectorySize(fullPath)
      })
    }
  } catch {
    // A missing/locked directory should not break Settings.
  }
  return entries
}

export function getStorageUsage(userDataPath = getElectronUserDataPath()): StorageUsageEntry[] {
  return [
    ...collectStorageUsage(userDataPath, 'managed-chrome', 'Managed Chrome'),
    ...collectStorageUsage(userDataPath, 'Partitions', 'Electron session'),
    {
      id: 'app-root-cache',
      label: 'App browser cache',
      path: userDataPath,
      bytes: ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary']
        .map((name) => getDirectorySize(join(userDataPath, name)))
        .reduce((sum, bytes) => sum + bytes, 0)
    }
  ]
}

function shouldPruneDirectory(dirName: string, parentName: string): boolean {
  if (AUTH_CRITICAL_DIR_NAMES.has(dirName) || AUTH_CRITICAL_FILE_NAMES.has(dirName)) {
    return false
  }

  if (parentName === 'Service Worker' && SAFE_SERVICE_WORKER_CHILDREN.has(dirName)) {
    return true
  }

  return SAFE_CACHE_DIR_NAMES.has(dirName)
}

function collectPruneTargets(root: string): string[] {
  if (!existsSync(root)) return []

  const targets: string[] = []
  const stack = [root]

  while (stack.length > 0) {
    const current = stack.pop()!
    let children: string[] = []
    try {
      children = readdirSync(current)
    } catch {
      continue
    }

    for (const child of children) {
      const fullPath = join(current, child)
      let stat
      try {
        stat = lstatSync(fullPath)
      } catch {
        continue
      }

      if (stat.isSymbolicLink() || !stat.isDirectory()) continue

      const parentName = current.split(/[\\/]/).pop() || ''
      if (shouldPruneDirectory(child, parentName)) {
        targets.push(fullPath)
        continue
      }

      if (AUTH_CRITICAL_DIR_NAMES.has(child)) continue
      stack.push(fullPath)
    }
  }

  return targets
}

export function pruneSafeBrowserStorage(userDataPath = getElectronUserDataPath()): StorageCleanupResult {
  const root = resolve(userDataPath)
  const result: StorageCleanupResult = {
    removedBytes: 0,
    removedPaths: [],
    errors: []
  }

  const targets = collectPruneTargets(root)
    .filter((target, index, all) => all.indexOf(target) === index)
    .sort((a, b) => b.length - a.length)

  for (const target of targets) {
    if (!isInsideRoot(root, target)) {
      result.errors.push({ path: target, error: 'Refusing to remove path outside userData' })
      continue
    }

    const bytes = getDirectorySize(target)
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      result.removedBytes += bytes
      result.removedPaths.push(target)
    } catch (err) {
      result.errors.push({ path: target, error: String(err) })
    }
  }

  return result
}

export function registerStorageMaintenanceHandlers(): void {
  const electron = require('electron') as {
    ipcMain: {
      handle(channel: string, handler: (...args: any[]) => unknown): void
    }
    app: { getPath(name: string): string }
  }

  electron.ipcMain.handle('storage:getUsage', () => {
    return getStorageUsage(electron.app.getPath('userData'))
  })

  electron.ipcMain.handle('storage:prune', () => {
    return pruneSafeBrowserStorage(electron.app.getPath('userData'))
  })
}
