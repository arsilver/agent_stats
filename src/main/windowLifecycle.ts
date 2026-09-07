/**
 * Window / process lifecycle policy for the desktop app.
 *
 * Closing the last window used to keep a headless Electron process in dev.
 * That process held the single-instance lock, so the next run.bat exited
 * immediately and the user saw nothing.
 */

export const WINDOW_REVEAL_FALLBACK_MS = 4000

export function shouldQuitWhenLastWindowCloses(platform: NodeJS.Platform): boolean {
  // Standard Electron: macOS stays in the dock until Cmd+Q.
  return platform !== 'darwin'
}

export function shouldRecreateMainWindow(options: {
  hasWindow: boolean
  isDestroyed: boolean
  isQuitting: boolean
}): boolean {
  if (options.isQuitting) return false
  return !options.hasWindow || options.isDestroyed
}

export function pickWindowRevealReason(events: {
  alreadyShown: boolean
  readyToShow: boolean
  didFinishLoad: boolean
  didFailLoad: boolean
  timeoutElapsed: boolean
}): 'ready-to-show' | 'did-finish-load' | 'did-fail-load' | 'startup-timeout' | null {
  if (events.alreadyShown) return null
  if (events.readyToShow) return 'ready-to-show'
  if (events.didFinishLoad) return 'did-finish-load'
  if (events.didFailLoad) return 'did-fail-load'
  if (events.timeoutElapsed) return 'startup-timeout'
  return null
}
