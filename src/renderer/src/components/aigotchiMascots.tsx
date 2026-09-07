import { useId } from 'react'
import type { JSX } from 'react'
import type { Mood } from './AiGotchiCharacter'

interface FaceTone {
  white: string
  pupil: string
  mouth: string
  blush: string
  tear: string
  line: string
  eyeStroke?: string
}

const CODEX_TONE: FaceTone = {
  white: '#f4fffb',
  pupil: '#06352c',
  mouth: '#06352c',
  blush: '#ff9eb8',
  tear: '#7ec8ff',
  line: '#06352c'
}

const KIMI_TONE: FaceTone = {
  white: '#fff',
  pupil: '#1a4aa8',
  mouth: '#1a4aa8',
  blush: '#ff9ec8',
  tear: '#9ec8ff',
  line: '#1a4aa8'
}

const GROK_TONE: FaceTone = {
  white: '#fff',
  pupil: '#111318',
  mouth: '#1a1d24',
  blush: '#ff8aa8',
  tear: '#8eb4ff',
  line: '#1a1d24',
  eyeStroke: '#1a1d24'
}

const QWEN_TONE: FaceTone = {
  white: '#f8f4ff',
  pupil: '#3b1d8f',
  mouth: '#3b1d8f',
  blush: '#ff9eb8',
  tear: '#c4b5fd',
  line: '#3b1d8f'
}

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '')
}

function KawaiiFace({ mood, tone, y = 23 }: { mood: Mood; tone: FaceTone; y?: number }): JSX.Element {
  const l = 18
  const r = 30
  const eyeStroke = tone.eyeStroke
    ? { stroke: tone.eyeStroke, strokeWidth: 0.85 as const }
    : {}
  const blush = (
    <g className="kawaii-blush" opacity={mood === 'sad' ? 0.35 : 0.9}>
      <ellipse cx="13.1" cy={y + 4.6} rx="2.5" ry="1.45" fill={tone.blush} />
      <ellipse cx="34.9" cy={y + 4.6} rx="2.5" ry="1.45" fill={tone.blush} />
    </g>
  )

  if (mood === 'sleeping') {
    return (
      <g className="kawaii-face sleeping">
        {blush}
        <path d={`M${l - 2.6} ${y + 0.4} Q${l} ${y + 2.6} ${l + 2.6} ${y + 0.4}`} fill="none" stroke={tone.line} strokeWidth="1.7" strokeLinecap="round" />
        <path d={`M${r - 2.6} ${y + 0.4} Q${r} ${y + 2.6} ${r + 2.6} ${y + 0.4}`} fill="none" stroke={tone.line} strokeWidth="1.7" strokeLinecap="round" />
        <path d={`M21.6 ${y + 6.6} Q24 ${y + 7.8} 26.4 ${y + 6.6}`} fill="none" stroke={tone.mouth} strokeWidth="1.35" strokeLinecap="round" />
      </g>
    )
  }

  if (mood === 'exhausted' || mood === 'yawning') {
    return (
      <g className="kawaii-face tired">
        {blush}
        <path d={`M${l - 2.4} ${y} H${l + 2.4}`} fill="none" stroke={tone.line} strokeWidth="1.7" strokeLinecap="round" />
        <path d={`M${r - 2.4} ${y} H${r + 2.4}`} fill="none" stroke={tone.line} strokeWidth="1.7" strokeLinecap="round" />
        {mood === 'yawning' ? (
          <ellipse cx="24" cy={y + 6.6} rx="2.1" ry="2.4" fill={tone.pupil} />
        ) : (
          <path d={`M21.4 ${y + 6.8} H26.6`} fill="none" stroke={tone.mouth} strokeWidth="1.35" strokeLinecap="round" />
        )}
      </g>
    )
  }

  if (mood === 'sad') {
    return (
      <g className="kawaii-face sad">
        {blush}
        <ellipse cx={l} cy={y + 0.6} rx="2.6" ry="2.4" fill={tone.white} {...eyeStroke} />
        <ellipse cx={r} cy={y + 0.6} rx="2.6" ry="2.4" fill={tone.white} {...eyeStroke} />
        <circle cx={l} cy={y + 1.1} r="1.15" fill={tone.pupil} />
        <circle cx={r} cy={y + 1.1} r="1.15" fill={tone.pupil} />
        <path d={`M${l - 3.2} ${y - 3.2} L${l + 1.6} ${y - 1.6}`} fill="none" stroke={tone.line} strokeWidth="1.25" strokeLinecap="round" />
        <path d={`M${r + 3.2} ${y - 3.2} L${r - 1.6} ${y - 1.6}`} fill="none" stroke={tone.line} strokeWidth="1.25" strokeLinecap="round" />
        <path d={`M21.4 ${y + 7.4} Q24 ${y + 5.6} 26.6 ${y + 7.4}`} fill="none" stroke={tone.mouth} strokeWidth="1.4" strokeLinecap="round" />
        <circle className="kawaii-tear" cx={l - 3.4} cy={y + 4.2} r="0.85" fill={tone.tear} />
      </g>
    )
  }

  if (mood === 'excited') {
    return (
      <g className="kawaii-face excited">
        {blush}
        <g fill={tone.line}>
          <rect x={l - 1} y={y - 3.2} width="2" height="6.4" rx="1" />
          <rect x={l - 3.2} y={y - 1} width="6.4" height="2" rx="1" />
          <rect x={r - 1} y={y - 3.2} width="2" height="6.4" rx="1" />
          <rect x={r - 3.2} y={y - 1} width="6.4" height="2" rx="1" />
        </g>
        <path d={`M20.4 ${y + 6.2} Q24 ${y + 9.4} 27.6 ${y + 6.2}`} fill="none" stroke={tone.mouth} strokeWidth="1.6" strokeLinecap="round" />
      </g>
    )
  }

  if (mood === 'working') {
    return (
      <g className="kawaii-face working">
        {blush}
        <ellipse cx={l} cy={y} rx="2.4" ry="2.8" fill={tone.white} {...eyeStroke} />
        <ellipse cx={r} cy={y} rx="2.4" ry="2.8" fill={tone.white} {...eyeStroke} />
        <ellipse cx={l + 0.35} cy={y + 0.2} rx="1.05" ry="1.55" fill={tone.pupil} />
        <ellipse cx={r + 0.35} cy={y + 0.2} rx="1.05" ry="1.55" fill={tone.pupil} />
        <circle cx={l - 0.5} cy={y - 0.8} r="0.45" fill="#fff" />
        <circle cx={r - 0.5} cy={y - 0.8} r="0.45" fill="#fff" />
        <path d={`M21.6 ${y + 6.4} H26.4`} fill="none" stroke={tone.mouth} strokeWidth="1.4" strokeLinecap="round" />
      </g>
    )
  }

  const mouth =
    mood === 'bored' ? (
      <path d={`M21.4 ${y + 6.6} H26.6`} fill="none" stroke={tone.mouth} strokeWidth="1.4" strokeLinecap="round" />
    ) : mood === 'curious' ? (
      <ellipse cx="24" cy={y + 6.7} rx="1.15" ry="1.35" fill="none" stroke={tone.mouth} strokeWidth="1.25" />
    ) : (
      <path d={`M20.6 ${y + 5.8} Q24 ${y + 8.6} 27.4 ${y + 5.8}`} fill="none" stroke={tone.mouth} strokeWidth="1.5" strokeLinecap="round" />
    )

  return (
    <g className="kawaii-face open">
      {blush}
      <ellipse className="kawaii-eye-white left" cx={l} cy={y} rx="3.05" ry="3.35" fill={tone.white} {...eyeStroke} />
      <ellipse className="kawaii-eye-white right" cx={r} cy={y} rx="3.05" ry="3.35" fill={tone.white} {...eyeStroke} />
      <circle className="kawaii-eye-pupil left" cx={l + 0.35} cy={y + 0.25} r="1.45" fill={tone.pupil} />
      <circle className="kawaii-eye-pupil right" cx={r + 0.35} cy={y + 0.25} r="1.45" fill={tone.pupil} />
      <circle cx={l - 0.7} cy={y - 0.9} r="0.55" fill="#fff" />
      <circle cx={r - 0.7} cy={y - 0.9} r="0.55" fill="#fff" />
      {mouth}
    </g>
  )
}

function Shadow(): JSX.Element {
  return <ellipse className="mascot-shadow" cx="24" cy="44.2" rx="11.5" ry="2.4" fill="rgba(0,0,0,0.34)" />
}

function Feet({ fill, stroke }: { fill: string; stroke: string }): JSX.Element {
  return (
    <g className="mascot-feet">
      <ellipse cx="18.2" cy="39.2" rx="3.5" ry="2.2" fill={fill} stroke={stroke} strokeWidth="0.7" />
      <ellipse cx="29.8" cy="39.2" rx="3.5" ry="2.2" fill={fill} stroke={stroke} strokeWidth="0.7" />
    </g>
  )
}

function Arms({ fill, stroke }: { fill: string; stroke: string }): JSX.Element {
  return (
    <g className="mascot-arms">
      <ellipse className="mascot-arm left" cx="10.4" cy="28.6" rx="2.5" ry="3.7" fill={fill} stroke={stroke} strokeWidth="0.7" />
      <ellipse className="mascot-arm right" cx="37.6" cy="28.6" rx="2.5" ry="3.7" fill={fill} stroke={stroke} strokeWidth="0.7" />
    </g>
  )
}

/** Six-petal OpenAI blossom — the ChatGPT mark as a flower hat. */
function OpenAIBloom(): JSX.Element {
  return (
    <g transform="translate(24 8.2)">
      <g className="codex-bloom">
        {[30, 90, 150, 210, 270, 330].map((deg) => (
          <ellipse
            key={deg}
            cx="0"
            cy="-5.15"
            rx="2.4"
            ry="5.4"
            fill={deg % 120 === 0 ? '#ffffff' : '#e7fff6'}
            transform={`rotate(${deg})`}
          />
        ))}
        <circle r="2.05" fill="#0b6b54" />
        <circle r="0.85" fill="#7dffd0" />
      </g>
    </g>
  )
}

function KimiEars(): JSX.Element {
  return (
    <g className="kimi-ears">
      <g className="kimi-ear left">
        <path d="M16.2 17.2 C11.4 3.6 21.8 0.6 22.6 12.4 C19.6 7.2 16.8 11.8 16.2 17.2 Z" fill="#5b9cff" />
        <path d="M17.6 15 C15.2 7.4 20.6 5.6 21.2 12 C19.6 9 18.2 12.2 17.6 15 Z" fill="#d7ebff" />
      </g>
      <g className="kimi-ear right">
        <path d="M31.8 17.2 C36.6 3.6 26.2 0.6 25.4 12.4 C28.4 7.2 31.2 11.8 31.8 17.2 Z" fill="#5b9cff" />
        <path d="M30.4 15 C32.8 7.4 27.4 5.6 26.8 12 C28.4 9 29.8 12.2 30.4 15 Z" fill="#d7ebff" />
      </g>
    </g>
  )
}

/** Codex — chubby teal bean wearing the OpenAI blossom. */
export function CodexMascot({ mood }: { mood: Mood }): JSX.Element {
  const uid = safeId(useId())
  const body = `codexPetBody-${uid}`

  return (
    <svg className={`svg-art codex ${mood}`} viewBox="0 0 48 48" width="56" height="56" fill="none">
      <defs>
        <radialGradient id={body} cx="35%" cy="28%" r="72%">
          <stop offset="0%" stopColor="#6ff3d0" />
          <stop offset="48%" stopColor="#10a37f" />
          <stop offset="100%" stopColor="#0a5c48" />
        </radialGradient>
      </defs>
      <Shadow />
      <g className="codex-body">
        <Arms fill="#0e8f70" stroke="#0a5c48" />
        <ellipse cx="24" cy="27.2" rx="13.6" ry="12.4" fill={`url(#${body})`} stroke="#0a5c48" strokeWidth="0.85" />
        <ellipse cx="19.2" cy="21.2" rx="5.6" ry="3.2" fill="rgba(255,255,255,0.3)" />
        <KawaiiFace mood={mood} tone={CODEX_TONE} y={25} />
        <OpenAIBloom />
        <Feet fill="#0d7a60" stroke="#0a5c48" />
      </g>
    </svg>
  )
}

/** Kimi — Moonshot moon-bunny. Click morphs paper-lantern <-> round bunny. */
export function KimiAvatar({
  mood,
  isBox,
  onToggle
}: {
  mood: Mood
  isBox: boolean
  onToggle: () => void
}): JSX.Element {
  const uid = safeId(useId())
  const body = `kimiPetBody-${uid}`
  const lantern = `kimiLantern-${uid}`

  return (
    <svg
      className={`svg-art kimi kimi-morph-toggle ${mood} ${isBox ? 'box-form' : 'sphere-form'}`}
      viewBox="0 0 48 48"
      width="54"
      height="54"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      style={{ cursor: 'pointer' }}
    >
      <defs>
        <radialGradient id={body} cx="34%" cy="28%" r="70%">
          <stop offset="0%" stopColor="#9fd0ff" />
          <stop offset="55%" stopColor="#4a8eff" />
          <stop offset="100%" stopColor="#2456c8" />
        </radialGradient>
        <linearGradient id={lantern} x1="20%" y1="8%" x2="80%" y2="92%">
          <stop offset="0%" stopColor="#8ec4ff" />
          <stop offset="100%" stopColor="#3b7aee" />
        </linearGradient>
      </defs>
      <Shadow />

      <g className="kimi-box">
        <Arms fill="#3d7ef0" stroke="#2456c8" />
        <rect x="18.4" y="12.2" width="11.2" height="3" rx="1.4" fill="#2456c8" />
        <rect className="kimi-box-body" x="11.2" y="14.6" width="25.6" height="22.2" rx="7.2" fill={`url(#${lantern})`} stroke="#2456c8" strokeWidth="0.85" />
        <rect x="13.6" y="17" width="8.2" height="3.1" rx="1.5" fill="rgba(255,255,255,0.3)" />
        <path className="kimi-moon" d="M35.4 13.8 A3 3 0 1 1 35.4 18.8 A2.25 2.25 0 1 0 35.4 13.8 Z" fill="#e8f2ff" />
        <KawaiiFace mood={mood} tone={KIMI_TONE} y={24.4} />
        <KimiEars />
        <ellipse className="kimi-tail" cx="37.6" cy="33.4" rx="3.1" ry="2.5" fill="#5b9cff" stroke="#2456c8" strokeWidth="0.6" />
        <Feet fill="#3d7ef0" stroke="#2456c8" />
      </g>

      <g className="kimi-sphere">
        <Arms fill="#3d7ef0" stroke="#2456c8" />
        <ellipse className="kimi-sphere-body" cx="24" cy="27" rx="13.4" ry="12.2" fill={`url(#${body})`} stroke="#2456c8" strokeWidth="0.85" />
        <ellipse className="kimi-sphere-shine" cx="19" cy="21" rx="5.4" ry="3.1" fill="rgba(255,255,255,0.3)" />
        <path className="kimi-moon" d="M35.5 13.6 A3.1 3.1 0 1 1 35.5 18.8 A2.3 2.3 0 1 0 35.5 13.6 Z" fill="#e8f2ff" />
        <KawaiiFace mood={mood} tone={KIMI_TONE} y={24.6} />
        <KimiEars />
        <ellipse className="kimi-tail" cx="37.8" cy="33.6" rx="3.2" ry="2.55" fill="#5b9cff" stroke="#2456c8" strokeWidth="0.6" />
        <Feet fill="#3d7ef0" stroke="#2456c8" />
      </g>
    </svg>
  )
}

/** Grok — cream comet-fox with xAI black-tipped ears. */
export function GrokMascot({ mood }: { mood: Mood }): JSX.Element {
  const uid = safeId(useId())
  const body = `grokPetBody-${uid}`
  const tail = `grokTail-${uid}`

  return (
    <svg className={`svg-art grok ${mood}`} viewBox="0 0 48 48" width="56" height="56" fill="none">
      <defs>
        <radialGradient id={body} cx="34%" cy="28%" r="70%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="48%" stopColor="#f3f0e8" />
          <stop offset="100%" stopColor="#d4c7a8" />
        </radialGradient>
        <linearGradient id={tail} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="50%" stopColor="#9eb0e8" />
          <stop offset="100%" stopColor="#4c5c9a" />
        </linearGradient>
      </defs>
      <Shadow />
      <g className="grok-body">
        <path
          className="grok-tail"
          d="M10.5 33.5 C-1 27 -0.5 11 13 9.5 C9 18 9.5 26.5 12 32.5 Z"
          fill={`url(#${tail})`}
        />
        <circle className="grok-tail-spark" cx="12.4" cy="10.6" r="1.85" fill="#fff" />
        <circle className="grok-tail-spark" cx="6.2" cy="16.4" r="1.05" fill="#d4def8" />
        <Arms fill="#d5dbea" stroke="#9aa3bb" />
        <ellipse cx="24" cy="27.4" rx="13.6" ry="11.6" fill={`url(#${body})`} stroke="#1a1d24" strokeWidth="1.15" />
        <ellipse cx="19.2" cy="21.6" rx="5.1" ry="2.7" fill="rgba(255,255,255,0.72)" />
        <KawaiiFace mood={mood} tone={GROK_TONE} y={24.8} />
        <g className="grok-ear left">
          <path d="M15.8 17.2 C13.6 6.2 21.6 5.2 21.6 15.2 Z" fill="#e8edf8" stroke="#1a1d24" strokeWidth="0.7" />
          <path d="M17.2 15.4 C16.4 10.6 19.8 10.2 20.2 14.8 Z" fill="#1a1d24" />
        </g>
        <g className="grok-ear right">
          <path d="M32.2 17.2 C34.4 6.2 26.4 5.2 26.4 15.2 Z" fill="#e8edf8" stroke="#1a1d24" strokeWidth="0.7" />
          <path d="M30.8 15.4 C31.6 10.6 28.2 10.2 27.8 14.8 Z" fill="#1a1d24" />
        </g>
        <Feet fill="#1a1d24" stroke="#111318" />
      </g>
    </svg>
  )
}

/** Qwen — violet hex-chick with the brand gem on its forehead. */
export function QwenMascot({ mood }: { mood: Mood }): JSX.Element {
  const uid = safeId(useId())
  const body = `qwenPetBody-${uid}`
  const gem = `qwenGem-${uid}`

  return (
    <svg className={`svg-art qwen ${mood}`} viewBox="0 0 48 48" width="56" height="56" fill="none">
      <defs>
        <radialGradient id={body} cx="34%" cy="28%" r="70%">
          <stop offset="0%" stopColor="#ddd0ff" />
          <stop offset="50%" stopColor="#9b7dff" />
          <stop offset="100%" stopColor="#5b35c4" />
        </radialGradient>
        <linearGradient id={gem} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f7f3ff" />
          <stop offset="100%" stopColor="#c4b5fd" />
        </linearGradient>
      </defs>
      <Shadow />
      <g className="qwen-body">
        <path className="qwen-ribbon left" d="M15.2 16.4 C7.6 10.2 6.4 3.6 12.2 2.6 C13.4 8.2 16.6 12.4 18.6 16.4 Z" fill="#b79cff" />
        <path className="qwen-ribbon right" d="M32.8 16.4 C40.4 10.2 41.6 3.6 35.8 2.6 C34.6 8.2 31.4 12.4 29.4 16.4 Z" fill="#b79cff" />
        <ellipse className="qwen-wing left" cx="10.6" cy="28.4" rx="3.1" ry="5.2" fill="#8b6ef0" stroke="#5b35c4" strokeWidth="0.65" />
        <ellipse className="qwen-wing right" cx="37.4" cy="28.4" rx="3.1" ry="5.2" fill="#8b6ef0" stroke="#5b35c4" strokeWidth="0.65" />
        <path
          className="qwen-body-shape"
          d="M24 11.8 L36.2 18.8 L36.2 33.2 L24 40.2 L11.8 33.2 L11.8 18.8 Z"
          fill={`url(#${body})`}
          stroke="#5b35c4"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <ellipse cx="19.4" cy="21.2" rx="5" ry="2.8" fill="rgba(255,255,255,0.28)" />
        <KawaiiFace mood={mood} tone={QWEN_TONE} y={25.4} />
        <g className="qwen-gem">
          <path d="M24 10.8 L27.2 12.7 L27.2 16.2 L24 18.1 L20.8 16.2 L20.8 12.7 Z" fill={`url(#${gem})`} stroke="#efe8ff" strokeWidth="0.75" />
        </g>
        <Feet fill="#8b6ef0" stroke="#5b35c4" />
      </g>
    </svg>
  )
}
