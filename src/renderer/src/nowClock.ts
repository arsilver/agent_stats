import { useSyncExternalStore } from 'react'

/**
 * One 1 Hz clock for the renderer. Countdown chips and refresh rings subscribe
 * via useSyncExternalStore so a card body does not re-render every tick —
 * React skips the leaf when the snapshot string is unchanged (e.g. "12d 4h").
 */

let nowMs = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function emit(): void {
  nowMs = Date.now()
  for (const listener of listeners) listener()
}

export function subscribeClock(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  if (!timer) {
    timer = setInterval(emit, 1000)
  }
  return () => {
    listeners.delete(onStoreChange)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function getNowMs(): number {
  return nowMs
}

/** Re-render only when the snapshot value changes (Object.is). */
export function useClockSnapshot<T>(getSnapshot: () => T): T {
  return useSyncExternalStore(subscribeClock, getSnapshot, getSnapshot)
}
