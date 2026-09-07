import { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: number
  type: ToastType
  title: string
  message?: string
  exiting?: boolean
}

interface ToastContextValue {
  success: (title: string, message?: string) => void
  error: (title: string, message?: string) => void
  info: (title: string, message?: string) => void
  warning: (title: string, message?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const TOAST_COLORS: Record<ToastType, string> = {
  success: 'var(--ok)',
  error: 'var(--danger)',
  info: 'var(--accent)',
  warning: 'var(--warn)'
}

const AUTO_DISMISS_MS = 5000
const EXIT_ANIMATION_MS = 300

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '12px 14px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-4)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${TOAST_COLORS[toast.type]}`,
        boxShadow: 'var(--shadow-3)',
        minWidth: '280px',
        maxWidth: '380px',
        animation: toast.exiting ? `toastOut ${EXIT_ANIMATION_MS}ms ease-in forwards` : 'toastIn 300ms var(--ease-out)',
        cursor: 'pointer'
      }}
      onClick={() => onDismiss(toast.id)}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--fs-sm)',
          fontWeight: 600,
          color: TOAST_COLORS[toast.type],
          marginBottom: toast.message ? '4px' : 0
        }}>
          {toast.title}
        </div>
        {toast.message && (
          <div style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-2)',
            lineHeight: 1.4,
            wordBreak: 'break-word'
          }}>
            {toast.message}
          </div>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(toast.id) }}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-3)',
          cursor: 'pointer',
          fontSize: '14px',
          padding: '0 2px',
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        ×
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t))
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, EXIT_ANIMATION_MS)
  }, [])

  const show = useCallback((type: ToastType, title: string, message?: string) => {
    const id = ++idRef.current
    setToasts(prev => [...prev, { id, type, title, message }])
    setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
  }, [dismiss])

  const success = useCallback((title: string, message?: string) => show('success', title, message), [show])
  const error = useCallback((title: string, message?: string) => show('error', title, message), [show])
  const info = useCallback((title: string, message?: string) => show('info', title, message), [show])
  const warning = useCallback((title: string, message?: string) => show('warning', title, message), [show])
  const ctx = useMemo(
    () => ({ success, error, info, warning }),
    [success, error, info, warning]
  )

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {toasts.length > 0 && (
        <div style={{
          position: 'fixed',
          top: '16px',
          right: '16px',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          pointerEvents: 'none'
        }}>
          {toasts.map(toast => (
            <div key={toast.id} style={{ pointerEvents: 'auto' }}>
              <ToastItem toast={toast} onDismiss={dismiss} />
            </div>
          ))}
        </div>
      )}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes toastOut {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(40px); }
        }
      `}</style>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
