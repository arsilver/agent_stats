import { useState, Suspense, lazy } from 'react'
import type { ReactNode } from 'react'
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'
import { Logs } from './pages/Logs'

const Charts = lazy(() => import('./pages/Charts').then((m) => ({ default: m.Charts })))
const AiGotchi = lazy(() => import('./pages/AiGotchi').then((m) => ({ default: m.AiGotchi })))

interface IconProps {
  size?: number
}

function IconBase({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function GridIcon() {
  return (
    <IconBase>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </IconBase>
  )
}

function LineChartIcon() {
  return (
    <IconBase>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3.5 3.5L19 8" />
    </IconBase>
  )
}

function TerminalIcon() {
  return (
    <IconBase>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M12.5 15H17" />
    </IconBase>
  )
}

function GamepadIcon() {
  return (
    <IconBase>
      <path d="M17.3 5H6.7a4 4 0 0 0-4 3.6l-.7 5.6a2.5 2.5 0 0 0 4.3 1.9L8.5 14h7l2.2 2.1a2.5 2.5 0 0 0 4.3-1.9l-.7-5.6a4 4 0 0 0-4-3.6Z" />
      <path d="M7 10v4" />
      <path d="M5 12h4" />
      <path d="M15.5 11h.01" />
      <path d="M17.5 13h.01" />
    </IconBase>
  )
}

function SlidersIcon() {
  return (
    <IconBase>
      <path d="M4 8h9" />
      <path d="M17 8h3" />
      <circle cx="15" cy="8" r="2" />
      <path d="M4 16h3" />
      <path d="M11 16h9" />
      <circle cx="9" cy="16" r="2" />
    </IconBase>
  )
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <IconBase size={12}>
      {direction === 'right' ? <path d="M9 5l7 7-7 7" /> : <path d="M15 5l-7 7 7 7" />}
    </IconBase>
  )
}

function RouteFallback(): ReactNode {
  return (
    <div className="page-header">
      <h2>Loading</h2>
    </div>
  )
}

export function App() {
  // Default collapsed — denser first paint (icons-only rail)
  const [collapsed, setCollapsed] = useState(true)

  return (
    <HashRouter>
      <div className="app-layout">
        <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-brand">
            <h1>{collapsed ? 'AS' : 'Agent Stats'}</h1>
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed(!collapsed)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <ChevronIcon direction={collapsed ? 'right' : 'left'} />
            </button>
          </div>
          <ul className="sidebar-nav">
            <li>
              <NavLink to="/" end title="Dashboard">
                <span className="nav-icon"><GridIcon /></span>
                {!collapsed && <span className="nav-label">Dashboard</span>}
              </NavLink>
            </li>
            <li>
              <NavLink to="/charts" title="Analytics">
                <span className="nav-icon"><LineChartIcon /></span>
                {!collapsed && <span className="nav-label">Analytics</span>}
              </NavLink>
            </li>
            <li>
              <NavLink to="/logs" title="Logs">
                <span className="nav-icon"><TerminalIcon /></span>
                {!collapsed && <span className="nav-label">Logs</span>}
              </NavLink>
            </li>
            <li>
              <NavLink to="/aigotchi" title="aiGotchi">
                <span className="nav-icon"><GamepadIcon /></span>
                {!collapsed && <span className="nav-label">aiGotchi</span>}
              </NavLink>
            </li>
            <li>
              <NavLink to="/settings" title="Settings">
                <span className="nav-icon"><SlidersIcon /></span>
                {!collapsed && <span className="nav-label">Settings</span>}
              </NavLink>
            </li>
          </ul>
        </nav>
        <main className="main-content">
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/charts" element={<Charts />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/aigotchi" element={<AiGotchi />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </HashRouter>
  )
}
