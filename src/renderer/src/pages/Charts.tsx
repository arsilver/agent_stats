import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { JSX, CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { UsageMetric } from '../../../shared/usageTypes'
import '../styles/charts.css'

interface UsageHistoryPoint {
  service: string
  timestamp: string
  currentUsage: number
  usageLimit: number | null
  percentUsed: number | null
  metrics?: UsageMetric[] | null
  subModels?: any
}

interface ServiceConfig {
  id: string
  name: string
  color: string
  unit: string
}

interface ChartPoint {
  value: number
  label: string
  timestamp?: string
}

interface XY {
  x: number
  y: number
}

// ─── Geometry helpers ───────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function niceNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}k`
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`
  if (Number.isInteger(value)) return String(value)
  if (abs >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formatValue(val: number, unit: string): string {
  if (!val || val === 0) return '0'
  if (unit === 'tokens' && val >= 1000) return `${(val / 1000).toFixed(1)}k`
  return niceNumber(val)
}

/** Catmull-Rom → cubic Bézier path for silky trend lines */
function smoothPath(points: XY[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`
  }

  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }
  return d
}

function areaFromPath(pathD: string, points: XY[], baselineY: number): string {
  if (points.length === 0) return ''
  return `${pathD} L ${points[points.length - 1].x} ${baselineY} L ${points[0].x} ${baselineY} Z`
}

// ─── Sparkline ──────────────────────────────────────────────

function Sparkline({
  data,
  color,
  width = 140,
  height = 36,
  filled = true
}: {
  data: number[]
  color: string
  width?: number
  height?: number
  filled?: boolean
}): JSX.Element {
  const gid = useMemo(() => `sp-${Math.random().toString(36).slice(2, 9)}`, [])

  if (data.length < 2) {
    return (
      <svg width={width} height={height} className="ax-spark">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border-strong)"
          strokeDasharray="3 4"
        />
      </svg>
    )
  }

  const max = Math.max(...data, 1)
  const min = Math.min(...data)
  const range = max - min || 1
  const padY = 3

  const points: XY[] = data.map((val, i) => ({
    x: (i / (data.length - 1)) * width,
    y: padY + (height - padY * 2) - ((val - min) / range) * (height - padY * 2)
  }))

  const line = smoothPath(points)
  const area = areaFromPath(line, points, height)
  const last = points[points.length - 1]

  return (
    <svg width={width} height={height} className="ax-spark" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={`${gid}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {filled && <path d={area} fill={`url(#${gid})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${gid}-glow)`}
      />
      <circle cx={last.x} cy={last.y} r="2.75" fill={color}>
        <animate attributeName="r" values="2.4;3.2;2.4" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  )
}

// ─── Radial gauge ───────────────────────────────────────────

function RadialGauge({
  percent,
  color,
  size = 44
}: {
  percent: number | null
  color: string
  size?: number
}): JSX.Element {
  const p = clamp(percent ?? 0, 0, 100)
  const stroke = 3.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c - (p / 100) * c
  const danger = p >= 90
  const warn = p >= 70
  const ring = danger ? 'var(--danger)' : warn ? 'var(--warn)' : color

  return (
    <svg width={size} height={size} className="ax-gauge">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={ring}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }}
      />
      <text
        x={size / 2}
        y={size / 2 + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        className="num"
        fill="var(--text-1)"
        fontSize="10"
        fontWeight="700"
      >
        {percent == null ? '—' : `${Math.round(p)}`}
      </text>
    </svg>
  )
}

// ─── Line chart (detail) ────────────────────────────────────

function LineChart({
  data,
  color,
  width = 700,
  height = 220,
  unit = ''
}: {
  data: ChartPoint[]
  color: string
  width?: number
  height?: number
  unit?: string
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const gid = useMemo(() => `lc-${Math.random().toString(36).slice(2, 9)}`, [])

  if (data.length < 2) {
    return (
      <div className="ax-empty-chart" style={{ width, height }}>
        Not enough data to display chart
      </div>
    )
  }

  const values = data.map((d) => d.value)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const padding = { top: 22, right: 18, bottom: 34, left: 52 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  const points: XY[] = data.map((d, i) => ({
    x: padding.left + (i / (data.length - 1)) * chartWidth,
    y: padding.top + chartHeight - ((d.value - min) / range) * chartHeight
  }))

  const pathD = smoothPath(points)
  const areaD = areaFromPath(pathD, points, padding.top + chartHeight)

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const t = i / 4
    return {
      value: min + t * range,
      y: padding.top + chartHeight - t * chartHeight
    }
  })

  const labelCount = Math.min(6, data.length)
  const xLabels = Array.from({ length: labelCount }, (_, i) => {
    const idx = Math.round((i / Math.max(labelCount - 1, 1)) * (data.length - 1))
    return {
      label: data[idx]?.label || '',
      x: padding.left + (idx / (data.length - 1)) * chartWidth
    }
  }).filter((v, i, a) => a.findIndex((t) => t.label === v.label) === i)

  const onMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const rel = (x - padding.left) / chartWidth
    const idx = clamp(Math.round(rel * (data.length - 1)), 0, data.length - 1)
    setHover(idx)
  }

  const hi = hover != null ? points[hover] : null
  const hv = hover != null ? data[hover] : null

  return (
    <div className="ax-chart-wrap" style={{ width }}>
      <svg
        width={width}
        height={height}
        className="ax-chart"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="70%" stopColor={color} stopOpacity="0.06" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <filter id={`${gid}-glow`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={tick.y}
              x2={width - padding.right}
              y2={tick.y}
              className="ax-grid"
            />
            <text x={padding.left - 10} y={tick.y + 3} textAnchor="end" className="ax-tick num">
              {niceNumber(tick.value)}
            </text>
          </g>
        ))}

        <path d={areaD} fill={`url(#${gid})`} />
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#${gid}-glow)`}
        />

        {hi && hv && (
          <>
            <line
              x1={hi.x}
              y1={padding.top}
              x2={hi.x}
              y2={padding.top + chartHeight}
              stroke={color}
              strokeOpacity="0.35"
              strokeDasharray="3 4"
            />
            <circle cx={hi.x} cy={hi.y} r="5.5" fill={color} fillOpacity="0.22" />
            <circle cx={hi.x} cy={hi.y} r="3.2" fill={color} stroke="var(--bg-2)" strokeWidth="1.5" />
          </>
        )}

        {!hi && (
          <circle
            cx={points[points.length - 1].x}
            cy={points[points.length - 1].y}
            r="3.5"
            fill={color}
            stroke="var(--bg-2)"
            strokeWidth="1.5"
          />
        )}

        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={height - 10} textAnchor="middle" className="ax-tick">
            {l.label}
          </text>
        ))}
      </svg>

      {hi && hv && (
        <div
          className="ax-tooltip"
          style={
            {
              left: clamp(hi.x, 70, width - 70),
              top: Math.max(8, hi.y - 48)
            } as CSSProperties
          }
        >
          <div className="ax-tooltip-label">{hv.label}</div>
          <div className="ax-tooltip-value num" style={{ color }}>
            {formatValue(hv.value, unit)}
            {unit ? <span className="ax-tooltip-unit">{unit}</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Horizontal rank bars ───────────────────────────────────

function RankBars({
  items,
  width = 700
}: {
  items: { id: string; name: string; value: number; display: string; color: string; unit: string }[]
  width?: number
}): JSX.Element {
  const ranked = [...items].sort((a, b) => b.value - a.value)
  const max = Math.max(...ranked.map((i) => i.value), 1)

  if (ranked.length === 0) {
    return <div className="ax-empty-chart">No services to compare</div>
  }

  return (
    <div className="ax-rank" style={{ width }}>
      {ranked.map((item, index) => {
        const pct = (item.value / max) * 100
        return (
          <div key={item.id} className="ax-rank-row" style={{ '--rank-color': item.color } as CSSProperties}>
            <div className="ax-rank-meta">
              <span className="ax-rank-pos num">{String(index + 1).padStart(2, '0')}</span>
              <span className="ax-rank-dot" style={{ background: item.color }} />
              <span className="ax-rank-name">{item.name}</span>
              <span className="ax-rank-val num">
                {item.display}
                <span className="ax-rank-unit">{item.unit}</span>
              </span>
            </div>
            <div className="ax-rank-track">
              <div
                className="ax-rank-fill"
                style={{
                  width: `${Math.max(pct, item.value > 0 ? 2 : 0)}%`,
                  background: `linear-gradient(90deg, ${item.color}55, ${item.color})`
                }}
              />
              <div className="ax-rank-glow" style={{ left: `${Math.max(pct, 0)}%`, background: item.color }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Multi-line trend with crosshair ────────────────────────

function MultiLineChart({
  datasets,
  width = 700,
  height = 240,
  ySuffix = ''
}: {
  datasets: { id: string; name: string; color: string; values: ChartPoint[] }[]
  width?: number
  height?: number
  ySuffix?: string
}): JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  const validDatasets = datasets.filter((d) => d.values.length >= 2)

  if (validDatasets.length === 0) {
    return (
      <div className="ax-empty-chart" style={{ width, height }}>
        Not enough data for comparison
      </div>
    )
  }

  const allValues = validDatasets.flatMap((d) => d.values.map((v) => v.value))
  const max = Math.max(...allValues, 1)
  const min = Math.min(...allValues, 0)
  const range = max - min || 1
  const padding = { top: 16, right: 18, bottom: 34, left: 52 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  const longest = validDatasets.reduce(
    (best, d) => (d.values.length > best.length ? d.values : best),
    validDatasets[0].values
  )

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const t = i / 4
    return {
      value: min + t * range,
      y: padding.top + chartHeight - t * chartHeight
    }
  })

  const labelCount = Math.min(6, longest.length)
  const xLabels = Array.from({ length: labelCount }, (_, i) => {
    const idx = Math.round((i / Math.max(labelCount - 1, 1)) * (longest.length - 1))
    return {
      label: longest[idx]?.label || '',
      x: padding.left + (idx / Math.max(longest.length - 1, 1)) * chartWidth
    }
  }).filter((v, i, a) => a.findIndex((t) => t.label === v.label) === i)

  const onMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const rel = (x - padding.left) / chartWidth
    const idx = clamp(Math.round(rel * (longest.length - 1)), 0, longest.length - 1)
    setHoverIdx(idx)
  }

  const hoverX =
    hoverIdx != null
      ? padding.left + (hoverIdx / Math.max(longest.length - 1, 1)) * chartWidth
      : null

  const hoverRows = validDatasets
    .map((d) => {
      const pt = d.values[Math.min(hoverIdx ?? 0, d.values.length - 1)]
      return pt
        ? { id: d.id, name: d.name, color: d.color, value: pt.value, label: pt.label }
        : null
    })
    .filter(Boolean) as { id: string; name: string; color: string; value: number; label: string }[]

  hoverRows.sort((a, b) => b.value - a.value)

  return (
    <div className="ax-chart-wrap" style={{ width }}>
      <svg
        width={width}
        height={height}
        className="ax-chart"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={tick.y}
              x2={width - padding.right}
              y2={tick.y}
              className="ax-grid"
            />
            <text x={padding.left - 10} y={tick.y + 3} textAnchor="end" className="ax-tick num">
              {niceNumber(tick.value)}
              {ySuffix}
            </text>
          </g>
        ))}

        {validDatasets.map((dataset) => {
          const pts: XY[] = dataset.values.map((d, i) => ({
            x: padding.left + (i / Math.max(dataset.values.length - 1, 1)) * chartWidth,
            y: padding.top + chartHeight - ((d.value - min) / range) * chartHeight
          }))
          const pathD = smoothPath(pts)
          const dimmed = focusId != null && focusId !== dataset.id
          const emphasized = focusId === dataset.id

          return (
            <g
              key={dataset.id}
              opacity={dimmed ? 0.18 : 1}
              style={{ transition: 'opacity 160ms var(--ease-out)' }}
            >
              <path
                d={pathD}
                fill="none"
                stroke={dataset.color}
                strokeWidth={emphasized ? 2.8 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {hoverIdx != null && pts[Math.min(hoverIdx, pts.length - 1)] && (
                <circle
                  cx={pts[Math.min(hoverIdx, pts.length - 1)].x}
                  cy={pts[Math.min(hoverIdx, pts.length - 1)].y}
                  r={emphasized ? 4 : 3}
                  fill={dataset.color}
                  stroke="var(--bg-2)"
                  strokeWidth="1.5"
                />
              )}
            </g>
          )
        })}

        {hoverX != null && (
          <line
            x1={hoverX}
            y1={padding.top}
            x2={hoverX}
            y2={padding.top + chartHeight}
            stroke="var(--text-3)"
            strokeOpacity="0.45"
            strokeDasharray="3 4"
          />
        )}

        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={height - 10} textAnchor="middle" className="ax-tick">
            {l.label}
          </text>
        ))}
      </svg>

      {hoverIdx != null && hoverRows.length > 0 && hoverX != null && (
        <div
          className="ax-tooltip ax-tooltip-multi"
          style={
            {
              left: clamp(hoverX, 110, width - 110),
              top: 12
            } as CSSProperties
          }
        >
          <div className="ax-tooltip-label">{hoverRows[0].label}</div>
          {hoverRows.slice(0, 6).map((row) => (
            <div key={row.id} className="ax-tooltip-row">
              <span className="ax-rank-dot" style={{ background: row.color }} />
              <span>{row.name}</span>
              <span className="num" style={{ color: row.color }}>
                {niceNumber(row.value)}
                {ySuffix}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="ax-legend">
        {validDatasets.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`ax-legend-item ${focusId === d.id ? 'active' : ''}`}
            onClick={() => setFocusId((prev) => (prev === d.id ? null : d.id))}
            title="Click to focus series"
          >
            <span className="ax-rank-dot" style={{ background: d.color }} />
            <span>{d.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Burn histogram ─────────────────────────────────────────

function BurnBars({
  data,
  color,
  width = 700,
  height = 200
}: {
  data: ChartPoint[]
  color: string
  width?: number
  height?: number
}): JSX.Element {
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return (
      <div className="ax-empty-chart" style={{ width, height }}>
        No burn activity in this window
      </div>
    )
  }

  const values = data.map((d) => d.value)
  const max = Math.max(...values, 1)
  const padding = { top: 18, right: 12, bottom: 34, left: 12 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom
  const gap = Math.max(2, Math.min(6, innerW / data.length / 4))
  const barW = Math.max(2, (innerW - gap * (data.length - 1)) / data.length)

  const labelCount = Math.min(6, data.length)
  const xLabels = Array.from({ length: labelCount }, (_, i) => {
    const idx = Math.round((i / Math.max(labelCount - 1, 1)) * (data.length - 1))
    return { label: data[idx]?.label || '', idx }
  }).filter((v, i, a) => a.findIndex((t) => t.label === v.label) === i)

  return (
    <svg width={width} height={height} className="ax-chart">
      {[0.25, 0.5, 0.75, 1].map((t) => (
        <line
          key={t}
          x1={padding.left}
          y1={padding.top + innerH * (1 - t)}
          x2={width - padding.right}
          y2={padding.top + innerH * (1 - t)}
          className="ax-grid"
        />
      ))}
      {data.map((d, i) => {
        const h = (d.value / max) * innerH
        const x = padding.left + i * (barW + gap)
        const y = padding.top + innerH - h
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={Math.max(h, d.value > 0 ? 2 : 0)}
            rx={Math.min(3, barW / 2)}
            fill={color}
            opacity={0.55 + (d.value / max) * 0.45}
          >
            <title>{`${d.label}: ${niceNumber(d.value)}`}</title>
          </rect>
        )
      })}
      {xLabels.map((l, i) => (
        <text
          key={i}
          x={padding.left + l.idx * (barW + gap) + barW / 2}
          y={height - 10}
          textAnchor="middle"
          className="ax-tick"
        >
          {l.label}
        </text>
      ))}
    </svg>
  )
}

// ─── Page ───────────────────────────────────────────────────

export function Charts(): JSX.Element {
  const [history, setHistory] = useState<UsageHistoryPoint[]>([])
  const [serviceConfigs, setServiceConfigs] = useState<ServiceConfig[]>([])
  const [selectedService, setSelectedService] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<'1d' | '7d' | '14d' | '30d'>('7d')
  const [viewMode, setViewMode] = useState<'quota' | 'burn'>('quota')
  const [hasRealData, setHasRealData] = useState(false)
  const [loading, setLoading] = useState(true)
  const [chartWidth, setChartWidth] = useState(700)
  const containerRef = useRef<HTMLDivElement>(null)

  // Load only enabled services — disabled ones are fully omitted
  useEffect(() => {
    let cancelled = false
    Promise.all([window.settingsAPI.getProfiles(), window.settingsAPI.getEnabled()])
      .then(([profiles, enabledIds]) => {
        if (cancelled) return
        const enabled = new Set(enabledIds)
        setServiceConfigs(
          profiles
            .filter((profile) => enabled.has(profile.id))
            .map((profile) => ({
              id: profile.id,
              name: profile.displayName,
              color: profile.iconColor,
              unit: profile.usageUnit
            }))
        )
      })
      .catch(() => {
        if (!cancelled) setServiceConfigs([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Drop selection if the service was disabled
  useEffect(() => {
    if (selectedService && !serviceConfigs.some((s) => s.id === selectedService)) {
      setSelectedService(null)
    }
  }, [serviceConfigs, selectedService])

  const loadHistory = useCallback(() => {
    if (serviceConfigs.length === 0) {
      setHistory([])
      setLoading(false)
      return
    }
    const fetchDays =
      timeRange === '1d' ? 1 : timeRange === '7d' ? 7 : timeRange === '14d' ? 14 : 30
    const enabledIds = new Set(serviceConfigs.map((s) => s.id))

    if (window.usageAPI?.getHistory) {
      window.usageAPI
        .getHistory(fetchDays)
        .then((realData: UsageHistoryPoint[]) => {
          if (realData && realData.length > 0) {
            setHistory(realData.filter((h) => enabledIds.has(h.service)))
            setHasRealData(true)
          } else {
            setHistory([])
            setHasRealData(false)
          }
        })
        .catch(() => {
          setHistory([])
          setHasRealData(false)
        })
        .finally(() => setLoading(false))
    } else {
      setHistory([])
      setHasRealData(false)
      setLoading(false)
    }
  }, [serviceConfigs, timeRange])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    const cleanup = window.usageAPI?.onRefreshComplete?.(() => {
      loadHistory()
    })
    return () => {
      if (cleanup) cleanup()
    }
  }, [loadHistory])

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setChartWidth(Math.max(300, entry.contentRect.width - 32))
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const filteredData = useMemo(() => {
    const days =
      timeRange === '1d' ? 1 : timeRange === '7d' ? 7 : timeRange === '14d' ? 14 : 30
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    return history.filter((h) => new Date(h.timestamp).getTime() >= cutoff)
  }, [history, timeRange])

  const serviceStats = useMemo(() => {
    const formatLabel = (timestamp: string): string => {
      const d = new Date(timestamp)
      if (timeRange === '1d') {
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      }
      if (timeRange === '7d') {
        return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d
          .toLocaleTimeString('en-US', { hour: 'numeric' })
          .replace(' AM', 'am')
          .replace(' PM', 'pm')}`
      }
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }

    return serviceConfigs.map((service) => {
      const serviceData = filteredData
        .filter((h) => h.service === service.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      if (serviceData.length === 0) {
        return {
          ...service,
          current: 0,
          previous: 0,
          change: 0,
          values: [] as number[],
          avg: 0,
          max: 0,
          min: 0,
          latestPercent: null as number | null,
          dataPoints: [] as ChartPoint[],
          burnDataPoints: [] as ChartPoint[],
          percentDataPoints: [] as ChartPoint[]
        }
      }

      const values = serviceData.map((h) => h.currentUsage)
      const current = values[values.length - 1] || 0
      const previous = values[0] || 0
      const change = previous > 0 ? ((current - previous) / previous) * 100 : 0
      const avg = values.reduce((a, b) => a + b, 0) / values.length
      const max = Math.max(...values)
      const min = Math.min(...values)
      const latest = serviceData[serviceData.length - 1]
      const latestPercent = latest.percentUsed

      const lowerUnit = service.unit.toLowerCase()
      const isCumulative =
        lowerUnit.includes('token') ||
        lowerUnit.includes('rmb') ||
        lowerUnit.includes('message') ||
        lowerUnit.includes('request') ||
        lowerUnit.includes('quota used') ||
        lowerUnit.includes('%')

      const burnDataPoints = serviceData.map((h, i, arr) => {
        if (i === 0) return { value: 0, label: formatLabel(h.timestamp) }
        const prev = arr[i - 1].currentUsage
        const curr = h.currentUsage
        let burn = isCumulative ? curr - prev : prev - curr
        if (burn < 0) burn = 0
        return { value: burn, label: formatLabel(h.timestamp) }
      })

      const percentDataPoints = serviceData.map((h) => {
        let pct = h.percentUsed ?? 0
        if ((pct === 0 || pct == null) && h.usageLimit && h.usageLimit > 0) {
          pct = (h.currentUsage / h.usageLimit) * 100
        } else if ((pct === 0 || pct == null) && max > 0) {
          pct = (h.currentUsage / max) * 100
        }
        return { value: pct, label: formatLabel(h.timestamp) }
      })

      return {
        ...service,
        current,
        previous,
        change,
        values,
        avg,
        max,
        min,
        latestPercent,
        dataPoints: serviceData.map((h) => ({
          value: h.currentUsage,
          label: formatLabel(h.timestamp)
        })),
        burnDataPoints,
        percentDataPoints
      }
    })
  }, [filteredData, serviceConfigs, timeRange])

  const selectedServiceData = useMemo(() => {
    if (!selectedService) return null
    return serviceStats.find((s) => s.id === selectedService) || null
  }, [selectedService, serviceStats])

  const selectedBreakdown = useMemo(() => {
    if (!selectedService) return []
    const latest = filteredData
      .filter((point) => point.service === selectedService)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
    const metricBreakdown = (latest?.metrics ?? [])
      .filter((metric) => metric.scope !== 'service')
      .map((metric) => ({
        id: metric.id,
        label: metric.label,
        value: metric.value,
        limit: metric.limit,
        unit: metric.unit,
        percent: metric.percent,
        color: selectedServiceData?.color ?? '#fff'
      }))
    if (metricBreakdown.length > 0) return metricBreakdown

    const subModels = Array.isArray(latest?.subModels) ? latest.subModels : []
    return subModels.map((sub: any, index: number) => ({
      id: `${selectedService}:legacy:${index}`,
      label: sub.name || sub.modelName || 'Metric',
      value: sub.count ?? 0,
      limit: sub.total ?? null,
      unit: selectedServiceData?.unit ?? '',
      percent: sub.total ? Math.round(((sub.count ?? 0) / sub.total) * 100) : null,
      color: selectedServiceData?.color ?? '#fff'
    }))
  }, [filteredData, selectedService, selectedServiceData])

  const hero = useMemo(() => {
    const withData = serviceStats.filter((s) => s.values.length > 0)
    const peak = [...serviceStats].sort(
      (a, b) => (b.latestPercent ?? -1) - (a.latestPercent ?? -1)
    )[0]
    const mover = [...serviceStats].sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
    const avgUtil =
      withData.length > 0
        ? withData.reduce((sum, s) => sum + (s.latestPercent ?? 0), 0) / withData.length
        : 0
    return {
      tracked: serviceStats.length,
      withData: withData.length,
      peak,
      mover,
      avgUtil
    }
  }, [serviceStats])

  const rangeLabel =
    timeRange === '1d'
      ? '24 Hours'
      : timeRange === '7d'
        ? '7 Days'
        : timeRange === '14d'
          ? '14 Days'
          : '30 Days'

  if (!loading && serviceConfigs.length === 0) {
    return (
      <div className="ax-page">
        <div className="page-header">
          <h2>Analytics</h2>
        </div>
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h3>No services enabled</h3>
          <p>Turn on services in Settings to populate Analytics. Disabled providers stay completely off this page.</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="ax-page">
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <h2>Analytics</h2>
          <p className="ax-subtitle">
            {hero.tracked} active service{hero.tracked === 1 ? '' : 's'} · {rangeLabel}
            {!hasRealData && hero.tracked > 0 ? ' · no history yet' : ''}
          </p>
        </div>

        <div className="ax-controls">
          <div className="seg">
            {(['quota', 'burn'] as const).map((mode) => (
              <button
                key={mode}
                className={viewMode === mode ? 'active' : ''}
                onClick={() => setViewMode(mode)}
              >
                {mode === 'burn' ? 'Velocity / Burn' : 'Raw Quota'}
              </button>
            ))}
          </div>

          <div className="seg">
            {(['1d', '7d', '14d', '30d'] as const).map((range) => (
              <button
                key={range}
                className={timeRange === range ? 'active' : ''}
                onClick={() => setTimeRange(range)}
              >
                {range === '1d'
                  ? '24h'
                  : range === '7d'
                    ? '7d'
                    : range === '14d'
                      ? '14d'
                      : '30d'}
              </button>
            ))}
          </div>

          {selectedService && (
            <button className="btn btn-secondary btn-sm" onClick={() => setSelectedService(null)}>
              Show All
            </button>
          )}
        </div>
      </div>

      {/* Hero metrics */}
      <div className="ax-hero">
        <div className="ax-hero-card">
          <span className="ax-hero-label">Tracking</span>
          <span className="ax-hero-value num">
            {hero.tracked}
            <span className="ax-hero-suffix">services</span>
          </span>
          <span className="ax-hero-note">{hero.withData} with history in range</span>
        </div>
        <div className="ax-hero-card">
          <span className="ax-hero-label">Avg utilization</span>
          <span className="ax-hero-value num">
            {hero.avgUtil.toFixed(0)}
            <span className="ax-hero-suffix">%</span>
          </span>
          <span className="ax-hero-note">Across enabled services</span>
        </div>
        <div className="ax-hero-card">
          <span className="ax-hero-label">Peak load</span>
          <span className="ax-hero-value num" style={{ color: hero.peak?.color }}>
            {hero.peak?.latestPercent != null ? `${Math.round(hero.peak.latestPercent)}%` : '—'}
          </span>
          <span className="ax-hero-note">{hero.peak?.name ?? 'No data'}</span>
        </div>
        <div className="ax-hero-card">
          <span className="ax-hero-label">Biggest mover</span>
          <span
            className="ax-hero-value num"
            style={{
              color:
                (hero.mover?.change ?? 0) >= 0 ? 'var(--ok)' : 'var(--danger)'
            }}
          >
            {hero.mover
              ? `${hero.mover.change >= 0 ? '+' : ''}${hero.mover.change.toFixed(1)}%`
              : '—'}
          </span>
          <span className="ax-hero-note">{hero.mover?.name ?? 'No data'}</span>
        </div>
      </div>

      {/* Service cards — enabled only */}
      <div className="ax-cards">
        {serviceStats.map((stat) => {
          const active = selectedService === stat.id
          return (
            <button
              key={stat.id}
              type="button"
              className={`ax-card ${active ? 'active' : ''}`}
              onClick={() => setSelectedService(active ? null : stat.id)}
              style={{ '--svc-color': stat.color } as CSSProperties}
            >
              <div className="ax-card-top">
                <div className="ax-card-id">
                  <span className="ax-rank-dot" style={{ background: stat.color }} />
                  <span>{stat.name}</span>
                </div>
                <RadialGauge percent={stat.latestPercent} color={stat.color} />
              </div>

              <div className="ax-card-metric">
                <span className="ax-card-value num">{formatValue(stat.current, stat.unit)}</span>
                <span className="ax-card-unit">{stat.unit}</span>
              </div>

              <div
                className={`ax-card-delta num ${stat.change >= 0 ? 'up' : 'down'}`}
              >
                {stat.change >= 0 ? '↑' : '↓'} {Math.abs(stat.change).toFixed(1)}%
                <span> vs start of range</span>
              </div>

              <div className="ax-card-spark">
                <Sparkline data={stat.values} color={stat.color} width={148} height={38} />
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected detail */}
      {selectedServiceData && (
        <section className="ax-panel ax-detail" style={{ '--svc-color': selectedServiceData.color } as CSSProperties}>
          <div className="ax-panel-head">
            <h3>
              <span className="ax-rank-dot" style={{ background: selectedServiceData.color }} />
              {selectedServiceData.name}
              <span className="ax-panel-mode">
                {viewMode === 'burn' ? 'Burn rate' : 'Usage over time'}
              </span>
            </h3>
            {selectedServiceData.values.length > 0 ? (
              <div className="ax-stat-pills">
                <span className="ax-pill">
                  Avg <strong className="num">{formatValue(Math.round(selectedServiceData.avg), selectedServiceData.unit)}</strong>
                </span>
                <span className="ax-pill">
                  Max <strong className="num">{formatValue(selectedServiceData.max, selectedServiceData.unit)}</strong>
                </span>
                <span className="ax-pill">
                  Min <strong className="num">{formatValue(selectedServiceData.min, selectedServiceData.unit)}</strong>
                </span>
              </div>
            ) : (
              <span className="ax-muted">No historical data yet</span>
            )}
          </div>

          {viewMode === 'burn' ? (
            <BurnBars
              data={selectedServiceData.burnDataPoints}
              color={selectedServiceData.color}
              width={chartWidth}
              height={220}
            />
          ) : (
            <LineChart
              data={selectedServiceData.dataPoints}
              color={selectedServiceData.color}
              width={chartWidth}
              height={220}
              unit={selectedServiceData.unit}
            />
          )}

          {selectedBreakdown.length > 0 && (
            <div className="ax-breakdown">
              {selectedBreakdown.map((metric) => (
                <div key={metric.id} className="ax-breakdown-card">
                  <div className="ax-breakdown-label">{metric.label}</div>
                  <div className="ax-breakdown-row">
                    <span className="num ax-breakdown-val">
                      {formatValue(metric.value, metric.unit)}
                    </span>
                    <span className="ax-card-unit">{metric.unit}</span>
                    {metric.percent != null && (
                      <span className="num ax-breakdown-pct">{metric.percent}%</span>
                    )}
                  </div>
                  {metric.percent != null && (
                    <div className="ax-mini-track">
                      <div
                        className="ax-mini-fill"
                        style={{
                          width: `${clamp(metric.percent, 0, 100)}%`,
                          background: metric.color
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Comparison */}
      <section className="ax-panel">
        <div className="ax-panel-head">
          <h3>Current usage ranking</h3>
          <span className="ax-muted">Enabled services only · normalized bars</span>
        </div>
        <RankBars
          width={chartWidth}
          items={serviceStats.map((s) => ({
            id: s.id,
            name: s.name,
            value: s.current,
            display: formatValue(s.current, s.unit),
            color: s.color,
            unit: s.unit
          }))}
        />
      </section>

      {/* Multi trend */}
      <section className="ax-panel">
        <div className="ax-panel-head">
          <h3>{viewMode === 'burn' ? 'Burn velocity' : 'Utilization trend'}</h3>
          <span className="ax-muted">
            {viewMode === 'burn'
              ? 'Delta between samples'
              : '% used · click legend to solo a series · hover for crosshair'}
          </span>
        </div>
        <MultiLineChart
          width={chartWidth}
          height={250}
          ySuffix={viewMode === 'burn' ? '' : '%'}
          datasets={serviceStats
            .filter((s) => s.values.length >= 2)
            .map((s) => ({
              id: s.id,
              name: s.name,
              color: s.color,
              values: viewMode === 'burn' ? s.burnDataPoints : s.percentDataPoints
            }))}
        />
      </section>

      <div className={`notice-bar ${hasRealData ? 'ok' : ''}`} style={{ marginTop: 4 }}>
        <span className="notice-icon" aria-hidden="true">
          {hasRealData ? '✓' : '!'}
        </span>
        <span>
          {hasRealData
            ? 'Live history. Disabled services are hidden from every chart and card.'
            : 'No snapshots yet. Refresh the dashboard so Analytics can record real usage.'}
        </span>
      </div>
    </div>
  )
}
