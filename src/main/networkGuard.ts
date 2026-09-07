import { net, powerMonitor } from 'electron'

/**
 * Cheap online check so background scrapes do not spawn Chrome when the
 * adapter is down. `true` is not a guarantee of a working route — `false`
 * is a strong signal to stay off the network.
 */

const offlineListeners = new Set<() => void>()
const onlineListeners = new Set<() => void>()
let started = false
let lastOnline = true
let pollTimer: NodeJS.Timeout | null = null

export function isAppOnline(): boolean {
  try {
    return net.isOnline()
  } catch {
    return true
  }
}

export function onAppNetworkOffline(listener: () => void): () => void {
  offlineListeners.add(listener)
  return () => {
    offlineListeners.delete(listener)
  }
}

export function onAppNetworkOnline(listener: () => void): () => void {
  onlineListeners.add(listener)
  return () => {
    onlineListeners.delete(listener)
  }
}

function emitOffline(): void {
  for (const listener of offlineListeners) listener()
}

function emitOnline(): void {
  for (const listener of onlineListeners) listener()
}

function tick(): void {
  const online = isAppOnline()
  if (lastOnline && !online) {
    console.log('[network] Offline / adapter down — pausing scrapers')
    emitOffline()
  } else if (!lastOnline && online) {
    console.log('[network] Back online')
    emitOnline()
  }
  lastOnline = online
}

export function startNetworkGuard(): void {
  if (started) return
  started = true
  lastOnline = isAppOnline()

  pollTimer = setInterval(tick, 15_000)
  pollTimer.unref?.()

  powerMonitor.on('suspend', () => {
    console.log('[network] System suspending — treating as offline for scrapers')
    if (lastOnline) {
      lastOnline = false
      emitOffline()
    }
  })
}
