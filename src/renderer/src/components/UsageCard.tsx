import { useState, memo, Fragment } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import type { UsageData } from '../../../shared/usageTypes'
import {
  CURSOR_INCOMPLETE_RESTART_MESSAGE,
  cursorHasPoolMeters,
  cursorOfficialTotalPercent,
  cursorPoolPercent
} from '../../../shared/cursorUsage'
import { dualWindowLabels, hasDualWindowBars } from '../../../shared/dualWindowUsage'
import { getNowMs, useClockSnapshot } from '../nowClock'

// ─── Shared helpers ───────────────────────────────────────────

function ringProgressSnapshot(lastFetched: string | null, interval: number): number {
  if (!lastFetched) return 0
  const pct = Math.min(((getNowMs() - new Date(lastFetched).getTime()) / interval) * 100, 100)
  return Math.round(pct)
}

function CircularTimer({
  lastFetched,
  interval = 5 * 60 * 1000,
  size = 32,
  strokeWidth = 2.5,
  onClick,
  loading = false
}: {
  lastFetched: string | null
  interval?: number
  size?: number
  strokeWidth?: number
  onClick?: () => void
  loading?: boolean
}) {
  const progress = useClockSnapshot(() => ringProgressSnapshot(lastFetched, interval))
  const [isHovered, setIsHovered] = useState(false)

  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (progress / 100) * circumference
  const isOverdue = progress >= 100

  return (
    <button
      onClick={onClick}
      disabled={loading}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'relative', width: size, height: size,
        background: 'transparent',
        border: `1px solid ${isHovered ? 'var(--border-strong)' : 'var(--border)'}`,
        borderRadius: '50%', cursor: loading ? 'not-allowed' : 'pointer',
        padding: 0, transition: 'border-color 140ms var(--ease-out)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
      }}
      title={loading ? 'Refreshing...' : isOverdue ? 'Click to refresh' : `Click to refresh (${Math.round(100 - progress)}% until auto)`}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(237,228,214,.12)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={isOverdue ? 'var(--danger)' : 'var(--accent)'} strokeWidth={strokeWidth}
          strokeDasharray={circumference} strokeDashoffset={loading ? 0 : offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s ease' }}
        />
      </svg>
      <span style={{ fontSize: '12px', color: 'var(--accent)', zIndex: 1, display: loading || isHovered ? 'inline' : 'none' }}>
        {loading ? '⟳' : '↻'}
      </span>
    </button>
  )
}

function getProgressColor(percent: number | null): string {
  if (percent === null) return 'var(--ok)'
  if (percent >= 85) return 'var(--danger)'
  if (percent >= 60) return 'var(--warn)'
  return 'var(--ok)'
}

function formatTimeAgo(iso: string | null, now = getNowMs()): string {
  if (!iso) return 'Never'
  const diff = now - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '<1m ago'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function LiveTimeAgo({ iso, prefix }: { iso: string | null; prefix?: string }): JSX.Element {
  const label = useClockSnapshot(() => formatTimeAgo(iso))
  return <span className="num">{prefix ? `${prefix}${label}` : label}</span>
}

interface CountdownInfo {
  text: string
  level: 'ok' | 'warn' | 'danger'
}

function computeCountdown(resetsAt: string | null, now: number): CountdownInfo | null {
  if (!resetsAt) return null
  const diff = new Date(resetsAt).getTime() - now
  if (diff <= 0) return { text: 'now', level: 'danger' }
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  let text: string
  if (days > 0) text = hours > 0 ? `${days}d ${hours}h` : `${days}d`
  else if (hours > 0) text = `${hours}h ${minutes}m`
  else if (minutes > 0) text = `${minutes}m ${seconds}s`
  else text = `${seconds}s`
  const level: CountdownInfo['level'] =
    diff < 10 * 60 * 1000 ? 'danger' : diff < 60 * 60 * 1000 ? 'warn' : 'ok'
  return { text, level }
}

function LiveCountdown({ resetsAt }: { resetsAt: string | null }): JSX.Element | null {
  const snapshot = useClockSnapshot(() => {
    const info = computeCountdown(resetsAt, getNowMs())
    return info ? JSON.stringify(info) : ''
  })
  if (!snapshot) return null
  const countdown = JSON.parse(snapshot) as CountdownInfo
  return <CountdownChip countdown={countdown} />
}

function CountdownChip({ countdown }: { countdown: CountdownInfo }) {
  const cls = countdown.level === 'ok' ? 'countdown-chip' : `countdown-chip ${countdown.level}`
  return (
    <span className={cls} title="Time until this quota window resets">
      <span aria-hidden="true">↻</span>
      <span>{countdown.text}</span>
    </span>
  )
}

function Meter({ percent, color }: { percent: number; color: string }) {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const tone = clamped >= 85 ? 'is-danger' : clamped >= 60 ? 'is-warn' : 'is-ok'
  const style = {
    width: `${clamped}%`,
    '--meter-color': color
  } as CSSProperties

  return (
    <div
      className={`meter ${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <i style={style}>
        <span className="meter-sheen" aria-hidden="true" />
        <span className="meter-tip" aria-hidden="true" />
      </i>
    </div>
  )
}

// ─── Meter block ────────────────────────────────────────────
//
// The single layout for every progress bar in a card:
//
//   [ label ......................... value ]   header — nothing on the bar's axis
//   [ ========== meter, full width ======== ]   width depends on the container
//   [ ............................. footer ]   optional, right-aligned
//
// Do NOT add a slot on the meter's row. Bars used to sit in a `flex: 1` slot
// beside their own label, percentage and countdown, so every bar rendered at a
// different width — 26px to 333px across one screen — and re-flowed on every
// countdown tick. Keeping the meter a block child is the entire point here.

type MeterDensity = 'comfortable' | 'compact'

interface MeterBlockProps {
  /** Fill 0-100. `null` means "no denominator known" — renders no track at all. */
  percent: number | null
  color: string
  /** Header, left: a label, or the composed figure on the primary bar. */
  label?: ReactNode
  /** Header, right: the value, plus the countdown chip on compact rows. */
  value?: ReactNode
  /** Row under the meter, right-aligned. Countdown chip on full-width bars. */
  footer?: ReactNode
  /** 'comfortable' = 6px gaps (the full-width bars), 'compact' = 4px (list rows). */
  density?: MeterDensity
  /** Outer wrapper only — margins. Never set a width here. */
  style?: CSSProperties
}

function MeterBlock({
  percent,
  color,
  label,
  value,
  footer,
  density = 'comfortable',
  style
}: MeterBlockProps): JSX.Element {
  const gap = density === 'compact' ? '4px' : '6px'
  const hasHeader = label != null || value != null
  return (
    <div style={style}>
      {hasHeader && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          gap: '8px', marginBottom: percent !== null || footer ? gap : 0
        }}>
          {/* Two wrappers so space-between always sees exactly two items, however
              many nodes a slot holds.
              minWidth:0 is required — without it the wrapper's `min-width:auto`
              resolves to its min-content size, which measures nowrap text at full
              width, so a long tool name overflows the card instead of ellipsizing.
              Do NOT add `overflow:hidden` here: an overflow-hidden flex item
              baselines off its margin box, shifting the primary bar's figure
              against its percentage. */}
          <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }}>{label}</span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: '4px', flexShrink: 0 }}>{value}</span>
        </div>
      )}
      {percent !== null && <Meter percent={percent} color={color} />}
      {footer && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: gap }}>{footer}</div>
      )}
    </div>
  )
}

// Percentages render as integers everywhere. The meter is 6px tall and ~330px
// wide, so 1px of bar is ~0.3% — decimals annotate below the bar's own
// resolution, and `.num` uses tabular-nums specifically to stop width jitter.
// Round here, not in main: usageHistory persists the raw values.
function formatPercent(percent: number | null): string {
  return percent === null || !Number.isFinite(percent) ? '—' : `${Math.round(percent)}%`
}

function formatRenewal(
  ymd: string,
  kind: 'renewing' | 'cancelled' = 'renewing'
): { label: string; delta: string; past: boolean } | null {
  if (!ymd) return null
  const parts = ymd.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null
  const target = new Date(parts[0], parts[1] - 1, parts[2])
  if (Number.isNaN(target.getTime())) return null
  const now = new Date()
  const daysLeft = Math.round((target.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000)
  const dateLabel = target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const verb = kind === 'cancelled' ? 'Ends' : 'Renews'
  const pastVerb = kind === 'cancelled' ? 'Ended' : 'Renewed'
  if (daysLeft === 0) return { label: `${verb} ${dateLabel}`, delta: 'today', past: false }
  if (daysLeft > 0) return { label: `${verb} ${dateLabel}`, delta: `in ${daysLeft}d`, past: false }
  return { label: `${pastVerb} ${dateLabel}`, delta: `${-daysLeft}d ago`, past: true }
}

// ─── Dual-window progress display (MiniMax / Qwen / ChatGPT Codex) ─
// Longer window (weekly / 7-day) on top. 5-hour underneath.

interface DualWindowUsageDisplayProps {
  data: UsageData
}

function isGrokRollingWindowRow(name: string): boolean {
  // "grok-4 · 2h" / "Heavy - 2h" — short-term rate-limit buckets, not weekly products.
  return /[·\-–]\s*\d+\s*h\s*$/i.test(name.trim())
}

function DualWindowUsageDisplay({ data }: DualWindowUsageDisplayProps) {
  const labels = dualWindowLabels(data.service, data.weeklyBarLabel)
  // Qwen Token Plan can mark the 5-hour quota as "Temporarily Lifted" (∞ remaining).
  const fiveHourLifted =
    data.service === 'qwen' &&
    (data.usageUnit === '5h lifted' ||
      (data.usageLimit == null && (data.percentUsed === 0 || data.percentUsed == null)))

  const fiveHourVisual = fiveHourLifted
    ? 0
    : data.isRemainingTracker
      ? Math.max(0, 100 - (data.percentUsed ?? 0))
      : (data.percentUsed ?? 0)
  const fiveHourColor = fiveHourLifted ? 'var(--ok)' : getProgressColor(fiveHourVisual)

  const weeklyVisual = data.isRemainingTracker
    ? Math.max(0, 100 - (data.weeklyPercentUsed ?? 0))
    : (data.weeklyPercentUsed ?? 0)
  const weeklyColor = getProgressColor(weeklyVisual)

  // ChatGPT stores "N% remaining". The bar fill is already inverted to used;
  // the figure next to it must match or the card reads "100%" beside an empty bar.
  const remainingPctUnit = !!data.isRemainingTracker && (data.usageUnit || '').startsWith('%')
  const fiveHourPctLabel = remainingPctUnit ? fiveHourVisual : (data.percentUsed ?? 0)
  const weeklyPctLabel = remainingPctUnit ? weeklyVisual : (data.weeklyPercentUsed ?? 0)

  const fmtCount = (n: number): string =>
    Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  const windowLabel = (text: string): JSX.Element => (
    <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {text}
    </span>
  )

  return (
    <>
      {/* ── Longer window (weekly / 7-day) — headline ── */}
      {data.weeklyPercentUsed !== null && data.weeklyPercentUsed !== undefined && (
        <MeterBlock
          percent={weeklyVisual}
          color={weeklyColor}
          style={{ marginBottom: '2px' }}
          label={windowLabel(labels.top)}
          value={
            remainingPctUnit ? (
              <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: weeklyColor }}>
                {formatPercent(weeklyPctLabel)}
              </span>
            ) : (
              <>
                <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-1)' }}>
                  {data.weeklyUsage != null ? fmtCount(data.weeklyUsage) : '—'}
                </span>
                {data.weeklyLimit != null && (
                  <span className="num" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>
                    / {fmtCount(data.weeklyLimit)}
                  </span>
                )}
                <span className="num" style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: weeklyColor, marginLeft: '4px' }}>
                  {formatPercent(weeklyPctLabel)}
                </span>
              </>
            )
          }
          footer={<LiveCountdown resetsAt={data.weeklyResetsAt} />}
        />
      )}

      {/* Separator between the two bars */}
      <div style={{ height: '1px', background: 'var(--border)', margin: '10px 0' }} />

      {/* ── Short window (5-hour) ── */}
      <MeterBlock
        percent={fiveHourLifted ? null : fiveHourVisual}
        color={fiveHourColor}
        style={{ marginTop: '2px' }}
        label={windowLabel(labels.bottom)}
        value={
          fiveHourLifted ? (
            <>
              <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-1)' }}>
                ∞
              </span>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--ok)', marginLeft: '6px' }}>
                Temporarily lifted
              </span>
            </>
          ) : remainingPctUnit ? (
            <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: fiveHourColor }}>
              {formatPercent(fiveHourPctLabel)}
            </span>
          ) : (
            <>
              <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-1)' }}>
                {fmtCount(data.currentUsage)}
              </span>
              {data.usageLimit != null && (
                <span className="num" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>
                  / {fmtCount(data.usageLimit)}
                </span>
              )}
              <span className="num" style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: fiveHourColor, marginLeft: '4px' }}>
                {formatPercent(fiveHourPctLabel)}
              </span>
            </>
          )
        }
        footer={
          fiveHourLifted
            ? (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
                No 5-hour reset while lifted
              </span>
            )
            : <LiveCountdown resetsAt={data.resetsAt} />
        }
      />
    </>
  )
}

// ─── Generic single-bar usage display (for non-MiniMax services) ──

interface GenericUsageDisplayProps {
  data: UsageData
  progressColor: string
  visualPercent: number | null
  weeklyVisualPercent: number | null
}

function GenericUsageDisplay({ data, progressColor, visualPercent, weeklyVisualPercent }: GenericUsageDisplayProps) {
  // Cursor pools are the breakdown (like Grok). Every other card still leads
  // with a headline meter — official Plan & Usage "Total N%", not Cursor Models.
  if (data.service === 'cursor' && cursorHasPoolMeters(data)) {
    const officialTotal = cursorOfficialTotalPercent(data)
    if (officialTotal == null) return null
    const totalColor = getProgressColor(officialTotal)
    const cursorModels = cursorPoolPercent(data, /^(Cursor Models|First-party models|Auto \+ Composer)$/i)
    const otherModels = cursorPoolPercent(data, /^(Other Models|API)$/i)
    return (
      <>
        <MeterBlock
          percent={officialTotal}
          color={totalColor}
          style={{ marginBottom: cursorModels != null && otherModels != null ? '6px' : '10px' }}
          label={
            <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
              {officialTotal}
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text-3)', marginLeft: '3px' }}>/ 100</span>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', marginLeft: '4px', textTransform: 'uppercase' }}>
                Total used
              </span>
            </span>
          }
          value={
            <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: totalColor }}>
              {formatPercent(officialTotal)}
            </span>
          }
          footer={<LiveCountdown resetsAt={data.resetsAt} />}
        />
        {cursorModels != null && otherModels != null && (
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', marginBottom: '10px' }}>
            {cursorModels}% First-party models and {otherModels}% API used
          </div>
        )}
      </>
    )
  }
  const isDollar = data.usageUnit === '$ spend' || data.usageUnit === 'dollars'
  const isPercentUnit = (data.usageUnit || '').startsWith('%')
  const rawUnit = (data.usageUnit || '').replace(/^%\s*/, '')
  const fmtUnit = isDollar ? 'spent' : rawUnit
  // Percent-unit services store the raw page number, which for a
  // remaining-tracker (ChatGPT) is "N% remaining". visualPercent is the
  // polarity-corrected used-value that the bar fill already uses; the headline
  // has to agree with it or the card reads "98%" beside a 2%-full bar.
  const fmtUsage = isDollar ? `$${data.currentUsage}`
    : isPercentUnit ? `${visualPercent ?? data.currentUsage}%` : String(data.currentUsage)
  const fmtLimit = data.usageLimit != null
    ? (isDollar ? `$${data.usageLimit}` : isPercentUnit ? `${data.usageLimit}%` : String(data.usageLimit))
    : null

  const totalColor = getProgressColor(data.totalPercent ?? null)

  return (
    <>
      {/* Total progress (e.g. Cursor combined usage). Hide when it clones the primary bar. */}
      {data.totalPercent !== null && data.totalPercent !== undefined && data.totalPercent !== data.percentUsed && (
        <MeterBlock
          percent={data.totalPercent}
          color={totalColor}
          style={{ marginBottom: '10px' }}
          label={
            <span style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--text-1)', letterSpacing: '-0.01em' }}>
              {data.totalBarLabel ?? 'Total'}
            </span>
          }
          value={
            <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: totalColor }}>
              {formatPercent(data.totalPercent)}
            </span>
          }
        />
      )}

      {/* Main progress */}
      <MeterBlock
        percent={visualPercent ?? 0}
        color={progressColor}
        style={{ marginBottom: '10px' }}
        label={
          <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>
            {fmtUsage}
            {fmtLimit && <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text-3)', marginLeft: '3px' }}>/ {fmtLimit}</span>}
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', marginLeft: '4px', textTransform: 'uppercase' }}>{fmtUnit}</span>
          </span>
        }
        value={
          <span className="num" style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: progressColor }}>
            {/* visualPercent, not percentUsed: the weekly bar below already
                renders its polarity-corrected value, so reading the raw field
                here made the two bars contradict each other. */}
            {formatPercent(visualPercent ?? 0)}
          </span>
        }
        footer={<LiveCountdown resetsAt={data.resetsAt} />}
      />

      {data.service === 'grok' && data.grokBotPercentUsed != null && (
        <>
          <div style={{ height: '1px', background: 'var(--border)', margin: '10px 0' }} />
          <img
            src="logos/grok-bot.svg"
            alt=""
            width={28}
            height={28}
            style={{ display: 'block', width: 28, height: 28, marginBottom: '6px' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
          <MeterBlock
            percent={data.grokBotPercentUsed}
            color={getProgressColor(data.grokBotPercentUsed)}
            density="compact"
            style={{ marginBottom: '10px' }}
            label={
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.05em' }}>
                Grok Bot
              </span>
            }
            value={
              <>
                <span className="num" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontWeight: 600 }}>
                  {formatPercent(data.grokBotPercentUsed)}
                </span>
                <LiveCountdown resetsAt={data.grokBotResetsAt ?? null} />
              </>
            }
          />
        </>
      )}

      {/* Weekly mini-bar. Flat, not a panel: panel padding would inset this bar
          from the primary bar above it, which is the inconsistency being fixed. */}
      {weeklyVisualPercent !== null && weeklyVisualPercent !== undefined && (
        <>
          <div style={{ height: '1px', background: 'var(--border)', margin: '10px 0' }} />
          <MeterBlock
            percent={weeklyVisualPercent}
            color={getProgressColor(weeklyVisualPercent)}
            density="compact"
            style={{ marginBottom: '10px' }}
            label={
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.05em' }}>
                {data.weeklyBarLabel ?? 'Weekly'}
              </span>
            }
            value={
              <>
                <span className="num" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontWeight: 600 }}>
                  {formatPercent(weeklyVisualPercent)}
                </span>
                {<LiveCountdown resetsAt={data.weeklyResetsAt} />}
              </>
            }
          />
        </>
      )}
    </>
  )
}

// ─── SubModels (API tools) display ─────────────────────────

interface SubModelsDisplayProps {
  data: UsageData
}

interface SubModelRowProps {
  sub: NonNullable<UsageData['subModels']>[number]
  service: string
  toolIcons: Record<string, string>
}

// One row per tool/pool so each can mount its own LiveCountdown chip.
function SubModelRow({ sub, service, toolIcons }: SubModelRowProps) {

  const subCount = sub.count ?? 0
  const isSubCumulative =
    service === 'minimax' ||
    service === 'openrouter' ||
    service === 'fal-ai' ||
    service === 'gemini' ||
    service === 'higgsfield' ||
    // grok pools and kimi's 5-hour window carry used-of-total counts;
    // the remaining-semantics default rendered them as "0/400 left"
    // with an inverted (full-at-zero-usage) bar.
    service === 'grok' ||
    service === 'kimi-code' ||
    // claude's per-model weekly buckets are "N% used" straight off the panel,
    // same as the aggregate weekly bar above them.
    service === 'claude' ||
    service === 'cursor'
  const subPct = sub.total ? Math.round((isSubCumulative ? (subCount / sub.total) : ((sub.total - subCount) / sub.total)) * 100) : 0

  let displayCount: string | number = subCount
  let displayTotal: string | number | undefined = sub.total
  let subLabel = isSubCumulative ? 'used' : 'left'

  if (service === 'openrouter' || service === 'fal-ai') {
    displayCount = '$' + (subCount < 0.01 ? subCount.toFixed(4) : subCount.toFixed(2))
    if (sub.total) displayTotal = '$' + sub.total.toFixed(2)
  } else if (service === 'cursor' && sub.total === 100) {
    // Match cursor.com/dashboard/spending ("1% used"), not "1/100 used"
    // which truncates to "1/10…" on the card.
    displayCount = `${Math.round(subPct)}%`
    displayTotal = undefined
    subLabel = 'used'
  } else if (service === 'minimax' && !sub.total) {
    displayCount = subCount
    subLabel = ''
  }

  const icon = toolIcons[sub.name || sub.modelName || ''] || toolIcons['Default']
  const subColor = getProgressColor(subPct)

  return (
    <MeterBlock
      // No denominator means the quota is unbounded, not zero-used — render the
      // header alone rather than an empty track asserting 0%.
      percent={sub.total ? subPct : null}
      color={subColor}
      density="compact"
      label={
        <>
          {/* Tool icon */}
          <span style={{ fontSize: '13px', flexShrink: 0 }}>{icon}</span>

          {/* Tool name. No width clamp: with the bar on its own line, the name
              gets the whole header and only truncates when it genuinely must. */}
          <span style={{
            fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontWeight: 500,
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {sub.name || sub.modelName}
          </span>
        </>
      }
      value={
        <>
          <span className="num" style={{ fontSize: 'var(--fs-xs)', color: subColor, fontWeight: 700 }}>
            {displayCount}{displayTotal != null && displayTotal !== '' ? `/${displayTotal}` : ''}
          </span>
          {sub.total && (
            <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 'normal', color: 'var(--text-3)' }}>{subLabel}</span>
          )}
          <LiveCountdown resetsAt={sub.resetsAt ?? null} />
        </>
      }
    />
  )
}

function SubModelsDisplay({ data }: SubModelsDisplayProps) {
  if (!data.subModels || data.subModels.length === 0) return <>{/* no submodels */}</>

  const rows = data.subModels.filter((sub) => {
    const name = sub.name || sub.modelName || ''
    if (data.service === 'grok' && isGrokRollingWindowRow(name)) return false
    if (/^grok bot$/i.test(name)) return false
    if (data.service !== 'cursor') return true
    // No denominator = no bar (stale "$400" on-demand). Keep percent pools.
    return sub.total != null
  })
  if (rows.length === 0) return <>{/* no submodels */}</>

  const sectionLabel =
    data.service === 'gemini'
      ? 'Model Quota'
      : data.service === 'higgsfield'
        ? 'Credits'
        // Grok's rows are weekly product pools (Grok Build, Chat, Imagine),
        // not API tools — the generic fallback header mislabels them.
        : data.service === 'grok'
          ? 'Model Pools'
          // claude's rows are the per-model bars from the Weekly limits
          // section (e.g. "Fable"), sibling to the aggregate weekly bar.
          : data.service === 'claude'
            ? 'Weekly Limits'
            : data.service === 'cursor'
              ? 'Model Pools'
              : 'API Tools'

  // Icon map for known API tools
  const toolIcons: Record<string, string> = {
    'Image Generation': '🖼️',
    'Text-to-Speech': '🔊',
    'Speech-to-Text': '🎤',
    'Web Search': '🔍',
    'Video Generation': '🎬',
    'Translation': '🌐',
    'Embeddings': '📊',
    'Hailuo Credits': '🍪',
    'Default': '⚡'
  }

  const collapseByDefault =
    rows.length > 2 && (data.service === 'grok' || data.service === 'claude')

  const rowList = (
    <div style={data.service === 'minimax'
      ? { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '232px', overflowY: 'auto', paddingRight: '2px' }
      : { display: 'flex', flexDirection: 'column', gap: '8px' }
    }>
      {rows.map((sub, idx) => (
        <Fragment key={idx}>
          {idx > 0 && <div style={{ height: '1px', background: 'var(--border)' }} />}
          <SubModelRow sub={sub} service={data.service} toolIcons={toolIcons} />
        </Fragment>
      ))}
    </div>
  )

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px'
    }}>
      {collapseByDefault ? (
        <details>
          <summary style={{
            display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px',
            cursor: 'pointer'
          }}>
            <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {sectionLabel}
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>{rows.length}</span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          </summary>
          {rowList}
        </details>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
            <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {sectionLabel}
            </span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          </div>
          {rowList}
        </>
      )}
    </div>
  )
}

// ─── Status presentation maps ───────────────────────────────

const STATUS_CHIP_VARIANT: Record<UsageData['status'], 'ok' | 'warn' | 'danger' | 'muted'> = {
  ok: 'ok',
  error: 'danger',
  not_configured: 'muted',
  login_required: 'warn',
  cookies_expired: 'warn',
  disabled: 'muted'
}

const STATUS_DOT_COLOR: Record<UsageData['status'], string> = {
  ok: 'var(--ok)',
  error: 'var(--danger)',
  not_configured: 'var(--text-3)',
  login_required: 'var(--warn)',
  cookies_expired: 'var(--warn)',
  disabled: 'var(--text-3)'
}

function MiniMaxExtras({
  data,
  onRefresh
}: {
  data: UsageData
  onRefresh: (serviceId: string) => void
}): JSX.Element | null {
  if (data.service !== 'minimax') return null
  return (
    <>
      {(!data.subModels || data.subModels.length === 0) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 10px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-3)', marginBottom: '10px'
        }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}>Hailuo AI credits not connected</span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              await window.usageAPI.openLoginHailuo()
              onRefresh(data.service)
            }}
          >
            Connect Hailuo
          </button>
        </div>
      )}
      {data.agentCredits ? (
        <div style={{ marginBottom: '10px', padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontWeight: 500 }}>Agent Credits</span>
            <span className="num" style={{ fontSize: 'var(--fs-xs)', fontWeight: 700, color: 'var(--text-1)' }}>{data.agentCredits.balance}</span>
          </div>
        </div>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 10px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-3)', marginBottom: '10px'
        }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }}>Agent credits not connected</span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              await window.usageAPI.openLoginAgent()
              onRefresh(data.service)
            }}
          >
            Connect Agent
          </button>
        </div>
      )}
    </>
  )
}

// ─── Main UsageCard ─────────────────────────────────────────

interface Props {
  data: UsageData
  onRefresh: (serviceId: string) => void
  onLogin: (serviceId: string) => void
  onReconnect: (serviceId: string) => void
  onDisconnect?: (serviceId: string) => void
  onImportCookies: (serviceId: string) => void
  loading?: boolean
  /** Stagger entrance animation delay in ms */
  enterDelayMs?: number
}

function UsageCardInner({ data, onRefresh, onLogin, onReconnect, onDisconnect, onImportCookies, loading, enterDelayMs = 0 }: Props): JSX.Element {
  const [renewalOverride, setRenewalOverride] = useState<string | null>(null)
  const [editingRenewal, setEditingRenewal] = useState(false)

  const effectiveRenewalDate = renewalOverride ?? data.renewalDate ?? ''
  const effectiveRenewalKind: 'renewing' | 'cancelled' =
    renewalOverride != null ? 'renewing' : (data.renewalKind ?? 'renewing')
  const renewal = effectiveRenewalDate ? formatRenewal(effectiveRenewalDate, effectiveRenewalKind) : null

  const saveRenewal = async (value: string): Promise<void> => {
    setEditingRenewal(false)
    const trimmed = (value || '').trim()
    if (!trimmed) {
      await window.credentialAPI.delete(data.service, 'renewalDate').catch(() => {})
      setRenewalOverride('')
      return
    }
    await window.credentialAPI.set(data.service, 'renewalDate', trimmed).catch(() => {})
    setRenewalOverride(trimmed)
  }

  const primaryPercent = data.percentUsed
  const visualPercent = primaryPercent === null ? null
    : data.isRemainingTracker ? Math.max(0, 100 - primaryPercent) : primaryPercent
  const weeklyVisualPercent = data.weeklyPercentUsed === null || data.weeklyPercentUsed === undefined ? null
    : data.isRemainingTracker ? Math.max(0, 100 - data.weeklyPercentUsed) : data.weeklyPercentUsed

  const statusLabel = {
    ok: 'Connected', error: 'Error', not_configured: 'Not configured',
    login_required: 'Login required', cookies_expired: 'Cookies expired', disabled: 'Hidden'
  }

  const cursorMissingTotal =
    data.service === 'cursor' &&
    cursorOfficialTotalPercent(data) == null &&
    (data.status === 'ok' || cursorHasPoolMeters(data))
  const isStaleData = (data.status === 'ok' && !!data.isStale) || cursorMissingTotal
  const progressColor = getProgressColor(visualPercent)
  const showUsageData =
    !cursorMissingTotal &&
    (data.status === 'ok' || (data.status === 'cookies_expired' && !!data.lastFetched))
  const sessionDetail = data.sessionAction?.detail || data.error
  const sessionLabel = data.sessionAction?.label || 'Reconnect'
  const handleSessionAction = () => {
    if (data.status === 'login_required' || data.status === 'not_configured') {
      onLogin(data.service)
      return
    }
    if (data.manualCookieRefresh) {
      onImportCookies(data.service)
      return
    }
    onReconnect(data.service)
  }

  // Dual-window bars: MiniMax 5h/weekly tokens, Qwen 5h/7-day credits,
  // ChatGPT Codex 5h/weekly remaining. Cursor uses Grok-style Model Pools.
  const isMiniMax = data.service === 'minimax'
  const hasDualBars = hasDualWindowBars(data)

  const renewalControl = editingRenewal ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <input type="date" defaultValue={effectiveRenewalDate} autoFocus
        onBlur={(e) => { void saveRenewal(e.currentTarget.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter') void saveRenewal(e.currentTarget.value); if (e.key === 'Escape') setEditingRenewal(false) }}
        style={{ background: 'var(--bg-3)', border: '1px solid var(--border-strong)', borderRadius: '6px', color: 'var(--text-1)', fontSize: 'var(--fs-xs)', padding: '2px 6px', colorScheme: 'dark' }}
      />
      {effectiveRenewalDate && <button type="button" onClick={() => { void saveRenewal('') }} title="Clear renewal date" style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 'var(--fs-xs)', padding: 0 }}>clear</button>}
    </span>
  ) : renewal ? (
    <span onClick={() => setEditingRenewal(true)} title="Click to edit renewal date" style={{ cursor: 'pointer' }}>
      <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>{renewal.label}</span>
      <span style={{ opacity: 0.7 }}> · {renewal.delta}</span>
    </span>
  ) : (
    <span onClick={() => setEditingRenewal(true)} title="Set the subscription renewal date so you know when to pay" style={{ cursor: 'pointer', color: 'var(--text-3)', fontStyle: 'italic' }}>+ Add renewal date</span>
  )

  return (
    <div
      className={`usage-card${loading ? ' is-loading' : ''}${data.status === 'ok' && !cursorMissingTotal ? ' is-ok' : ''}`}
      style={{
        position: 'relative',
        ['--svc-color' as string]: data.iconColor,
        ['--card-delay' as string]: `${enterDelayMs}ms`
      } as CSSProperties}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%', overflow: 'hidden',
              background: 'var(--bg-3)', boxShadow: '0 0 0 1px var(--border)'
            }}>
              <img
                src={`logos/${data.service}.svg`}
                alt={data.displayName}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  const target = e.target as HTMLImageElement
                  // Try JPG fallback
                  if (target.src.endsWith('.svg')) {
                    target.src = `logos/${data.service}.jpg`
                    return
                  }
                  // Final fallback to color circle
                  target.style.display = 'none'
                  const fallback = document.createElement('div')
                  fallback.style.cssText = `width:100%;height:100%;border-radius:50%;background:${data.iconColor};`
                  target.parentNode?.insertBefore(fallback, target)
                }}
              />
            </div>
            {/* 7px status dot overlapped at bottom-right */}
            <span
              className={data.status === 'ok' && !isStaleData && !cursorMissingTotal ? 'status-dot-live' : undefined}
              style={{
              position: 'absolute', right: '-1px', bottom: '-1px',
              width: 7, height: 7, borderRadius: '50%',
              background: isStaleData || cursorMissingTotal ? 'var(--warn)' : STATUS_DOT_COLOR[data.status],
              boxShadow: data.status === 'ok' && !isStaleData && !cursorMissingTotal ? undefined : '0 0 0 2px var(--bg-2)'
              }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-1)' }}>{data.displayName}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', marginTop: '1px' }}>{data.planTier}</div>
          </div>
        </div>

        {/* Status + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className={`chip ${isStaleData || cursorMissingTotal ? 'warn' : STATUS_CHIP_VARIANT[data.status]}`}>
            {cursorMissingTotal ? 'Incomplete' : isStaleData ? 'Stale data' : statusLabel[data.status]}
          </span>

          {(isStaleData || cursorMissingTotal) && (data.error || cursorMissingTotal) && (
            <span className="chip warn" title={data.error || CURSOR_INCOMPLETE_RESTART_MESSAGE} style={{ cursor: 'help' }}>
              {cursorMissingTotal ? 'no Total' : 'refresh failed'}
            </span>
          )}

          {data.status === 'ok' && onDisconnect && (
            <button
              type="button"
              className="icon-btn card-menu-btn"
              onClick={() => onDisconnect(data.service)}
              title="Disconnect — clear session data so you can sign into a different account"
              aria-label="Disconnect"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
          )}

          {(data.status === 'ok' || cursorMissingTotal) && (
            <CircularTimer lastFetched={data.lastFetched} interval={data.refreshIntervalMs} size={32} strokeWidth={2.5}
              onClick={() => onRefresh(data.service)} loading={loading} />
          )}
        </div>
      </div>

      {cursorMissingTotal && (
        <div className="inline-notice" style={{ borderColor: 'var(--warn)', color: 'var(--text-2)', marginBottom: '8px' }}>
          {data.error || CURSOR_INCOMPLETE_RESTART_MESSAGE}
        </div>
      )}

      {showUsageData && (() => {
        // ── Dual-window display (MiniMax / Qwen / ChatGPT Codex) ──
        if (hasDualBars) {
          return (
            <>
              <DualWindowUsageDisplay data={data} />

              {/* API Tools / SubModels (MiniMax tools, etc.) */}
              {data.subModels && data.subModels.length > 0 && (
                <SubModelsDisplay data={data} />
              )}

              <MiniMaxExtras data={data} onRefresh={onRefresh} />

              {/* Footer — renewal + time-ago once */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 'var(--fs-xs)', color: 'var(--text-3)', marginTop: '8px'
              }}>
                <div>{renewalControl}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {loading && <span className="loading-spinner" style={{ width: 12, height: 12 }} />}
                  <LiveTimeAgo iso={data.lastFetched} prefix={isStaleData ? 'Last good ' : undefined} />
                </div>
              </div>
            </>
          )
        }

        // ── Generic display (non-MiniMax or MiniMax without dual data) ──
        return (
          <>
            <GenericUsageDisplay
              data={data} progressColor={progressColor} visualPercent={visualPercent}
              weeklyVisualPercent={weeklyVisualPercent}
            />

            {/* SubModels list */}
            {data.subModels && data.subModels.length > 0 && (
              <SubModelsDisplay data={data} />
            )}

            <MiniMaxExtras data={data} onRefresh={onRefresh} />

            {data.status === 'cookies_expired' && sessionDetail && (
              <div className="inline-notice">
                {sessionDetail}
              </div>
            )}

            {isStaleData && data.error && (
              <div className="inline-notice" style={{ borderColor: 'var(--warn)', color: 'var(--text-2)' }}>
                {data.error} Last successful update: <LiveTimeAgo iso={data.lastFetched} />.
              </div>
            )}

            {/* Footer — renewal + time-ago once (reset timers live on the bars) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', marginTop: '8px' }}>
              <div>{renewalControl}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {loading && <span className="loading-spinner" style={{ width: 12, height: 12 }} />}
                <LiveTimeAgo iso={data.lastFetched} prefix={isStaleData ? 'Last good ' : undefined} />
              </div>
            </div>
          </>
        )
      })()}

      {data.status === 'cookies_expired' && !hasDualBars && (
        <div style={{ padding: showUsageData ? '0 0 4px 0' : '12px 0', textAlign: showUsageData ? 'left' : 'center' }}>
          {!showUsageData && sessionDetail && <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)', marginBottom: '12px', lineHeight: 1.5 }}>{sessionDetail}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: showUsageData ? 'flex-start' : 'center' }}>
            <button className="btn btn-primary" onClick={handleSessionAction} disabled={loading}>
              {sessionLabel}
            </button>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>Opens browser session</span>
          </div>
        </div>
      )}

      {(data.status === 'login_required' || data.status === 'not_configured') && (
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          {sessionDetail && <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)', marginBottom: '12px', lineHeight: 1.5 }}>{sessionDetail}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleSessionAction}>
                {data.status === 'not_configured' ? `Connect${data.service === 'minimax' ? ' MiniMax' : ''}` : sessionLabel}
              </button>
              {isMiniMax && (
                <button className="btn btn-secondary" onClick={async () => { await window.usageAPI.openLoginHailuo(); onRefresh(data.service) }}>
                  Connect Hailuo
                </button>
              )}
              {isMiniMax && (
                <button className="btn btn-secondary" onClick={async () => { await window.usageAPI.openLoginAgent(); onRefresh(data.service) }}>
                  Connect Agent
                </button>
              )}
            </div>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
              {data.status === 'not_configured' ? 'Set up credentials in Settings or sign in via browser' : 'Opens a browser window to sign in'}
            </span>
          </div>
        </div>
      )}

      {data.status === 'error' && (
        <div style={{ padding: '12px 0' }}>
          <p style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)', marginBottom: '12px' }}>{data.error || 'Failed to fetch'}</p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => onReconnect(data.service)}>Reconnect</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onRefresh(data.service)}>Retry</button>
          </div>
        </div>
      )}
    </div>
  )
}

export const UsageCard = memo(UsageCardInner)
