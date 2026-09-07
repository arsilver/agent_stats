import { useState, useEffect, useMemo } from 'react'
import '../styles/aigotchi-character.css'
import { CodexMascot, GrokMascot, KimiAvatar, QwenMascot } from './aigotchiMascots'

export type Mood = 'idle' | 'bored' | 'curious' | 'excited' | 'working' | 'yawning' | 'exhausted' | 'sad' | 'sleeping' | 'happy' | 'unknown'

interface AiGotchiCharacterProps {
    id: string
    name: string
    mood: Mood
    speechBubble?: string
    speechPlacement?: 'above' | 'below' | 'left' | 'right'
    interactingWith?: string
    isDashing?: boolean
    isEating?: boolean
    landedAt?: number
    facing?: 1 | -1
    walking?: boolean
    grabbed?: boolean
    petAt?: number
    rootRef?: (el: HTMLDivElement | null) => void
    onGrabStart?: (id: string, e: React.PointerEvent<HTMLDivElement>) => void
    shouldSuppressClick?: (id: string) => boolean
}

const renderClaudeEyes = (mood: Mood) => {
    if (mood === 'exhausted' || mood === 'sleeping' || mood === 'yawning') {
        return (
            <g className="claude-eye" stroke="#000" strokeWidth="2" strokeLinecap="round" fill="none">
                <line x1="13" y1="16" x2="17" y2="16" />
                <line x1="23" y1="16" x2="27" y2="16" />
            </g>
        )
    }
    if (mood === 'sad') {
        // Sad angled eyebrows / teary eyes
        return (
            <g className="claude-eye">
                <rect x="13" y="14" width="5" height="4" fill="#000" />
                <rect x="14" y="13" width="2" height="1" fill="#000" />
                <rect x="22" y="14" width="5" height="4" fill="#000" />
                <rect x="25" y="13" width="2" height="1" fill="#000" />
                <rect x="18" y="17" width="1" height="2" fill="#6495ed" opacity="0.7" />
            </g>
        )
    }
    if (mood === 'excited') {
        // Extra large sparkle star eyes
        return (
            <g className="claude-eye">
                <rect x="12" y="12" width="6" height="6" fill="#000" />
                <rect x="13" y="13" width="2" height="2" fill="#fff" />
                <rect x="15" y="15" width="1" height="1" fill="#fff" />
                <rect x="22" y="12" width="6" height="6" fill="#000" />
                <rect x="23" y="13" width="2" height="2" fill="#fff" />
                <rect x="25" y="15" width="1" height="1" fill="#fff" />
            </g>
        )
    }
    if (mood === 'happy' || mood === 'idle') {
        // Pixel-art style: wide open sparkly square eyes with highlight
        return (
            <g className="claude-eye">
                <rect x="13" y="13" width="5" height="5" fill="#000" />
                <rect x="14" y="14" width="2" height="2" fill="#fff" />
                <rect x="22" y="13" width="5" height="5" fill="#000" />
                <rect x="23" y="14" width="2" height="2" fill="#fff" />
            </g>
        )
    }
    // Default / Working - focused rectangular pupils
    return (
        <g className="claude-eye" fill="#000">
            <rect className="left" x="14" y="14" width="3" height="4" />
            <rect className="right" x="23" y="14" width="3" height="4" />
        </g>
    )
}

// Circular logo fallback — ONLY for services that never had custom SVG art
const LogoFallback = ({ id }: { id: string }) => (
    <div className="logo-fallback" style={{ position: 'relative', width: 52, height: 52 }}>
        <img
            src={`/logos/${id}.svg`}
            alt={`${id} mascot`}
            style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '50%',
                boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
            }}
            onError={(e) => {
                const target = e.target as HTMLImageElement
                if (target.src.endsWith('.svg')) {
                    target.src = `/logos/${id}.jpg`
                }
            }}
        />
    </div>
)

// Custom SVG mascots — Claude stays 8-bit; Codex/Grok/Kimi/Qwen live in aigotchiMascots.tsx
const renderPixelArt = (id: string, mood: Mood, kimiForm: 'box' | 'sphere', onKimiToggle: () => void) => {
    switch (id) {
        case 'claude': // Claude - Exact 8-bit Brown Retro Character (35% Bigger)
            return (
                <svg className={`svg-art claude ${mood}`} viewBox="0 0 40 40" width="54" height="54">
                    <g className="claude-container">
                        <rect className="claude-body" x="10" y="10" width="20" height="16" fill="#b87352" />
                        <rect className="claude-arm left" x="6" y="14" width="4" height="6" fill="#b87352" />
                        <rect className="claude-arm right" x="30" y="14" width="4" height="6" fill="#b87352" />
                        <rect className="claude-leg" x="12" y="26" width="3" height="6" fill="#b87352" />
                        <rect className="claude-leg" x="17" y="26" width="3" height="6" fill="#b87352" />
                        <rect className="claude-leg" x="20" y="26" width="3" height="6" fill="#b87352" />
                        <rect className="claude-leg" x="25" y="26" width="3" height="6" fill="#b87352" />
                        {renderClaudeEyes(mood)}
                    </g>
                </svg>
            )
        case 'chatgpt':
            return <CodexMascot mood={mood} />
        case 'grok':
            return <GrokMascot mood={mood} />
        case 'kimi-code': // Kimi - Box <-> Sphere Morphing Avatar
            return <KimiAvatar mood={mood} isBox={kimiForm === 'box'} onToggle={onKimiToggle} />
        case 'minimax': // MiniMax - White Cubic Box
            return (
                <svg className={`svg-art minimax ${mood}`} viewBox="0 0 40 40" width="40" height="40">
                    <path className="mm-body" d="M 12 8 L 31 8 Q 34 8 34 11 L 34 29 Q 34 32 31 32 L 27 32 L 27 22 L 23 22 L 23 32 L 17 32 L 17 22 L 13 22 L 13 32 L 9 32 Q 6 32 6 29 L 6 14 Z" fill="#fff" stroke="#ccc" strokeWidth="1" />
                    {mood === 'excited' ? (
                        <g className="mm-eye">
                            <ellipse cx="13" cy="27" rx="3" ry="4" fill="#333" />
                            <circle cx="12" cy="25.5" r="1.2" fill="#fff" />
                            <circle cx="14" cy="27.5" r="0.5" fill="#fff" />
                            <ellipse cx="27" cy="27" rx="3" ry="4" fill="#333" />
                            <circle cx="26" cy="25.5" r="1.2" fill="#fff" />
                            <circle cx="28" cy="27.5" r="0.5" fill="#fff" />
                        </g>
                    ) : mood === 'happy' || mood === 'idle' ? (
                        <g stroke="#333" strokeWidth="2.5" strokeLinecap="round" fill="none">
                            <path className="mm-eye left" d="M 11 26 Q 13 30 15 26" />
                            <path className="mm-eye right" d="M 25 26 Q 27 30 29 26" />
                        </g>
                    ) : mood === 'sad' ? (
                        <g className="mm-eye">
                            <ellipse cx="13" cy="28.5" rx="2" ry="2.5" fill="#333" />
                            <line x1="10" y1="25" x2="13" y2="26.5" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
                            <ellipse cx="27" cy="28.5" rx="2" ry="2.5" fill="#333" />
                            <line x1="30" y1="25" x2="27" y2="26.5" stroke="#333" strokeWidth="1.5" strokeLinecap="round" />
                            <circle cx="16" cy="31" r="0.8" fill="#6495ed" opacity="0.7" />
                        </g>
                    ) : mood === 'exhausted' || mood === 'sleeping' || mood === 'yawning' ? (
                        <g stroke="#999" strokeWidth="2" strokeLinecap="round" fill="none">
                            <line className="mm-eye left" x1="11" y1="28" x2="15" y2="28" />
                            <line className="mm-eye right" x1="25" y1="28" x2="29" y2="28" />
                        </g>
                    ) : (
                        <>
                            <ellipse className="mm-eye left" cx="13" cy="28" rx="2" ry="3" fill="#333" />
                            <ellipse className="mm-eye right" cx="27" cy="28" rx="2" ry="3" fill="#333" />
                        </>
                    )}
                </svg>
            )
        case 'runwayml': // RunwayML - Film Clapperboard (CSS: .svg-art.runway)
            return (
                <svg className={`svg-art runway ${mood}`} viewBox="0 0 40 40" width="44" height="44">
                    <g className="rw-clapper">
                        <rect x="4" y="16" width="32" height="18" rx="2.5" fill="#2b2b31" stroke="#55555f" strokeWidth="1.5" />
                        <rect x="7" y="28.5" width="6" height="3" rx="0.8" fill="#6366f1" opacity="0.65" />
                        <rect x="17" y="28.5" width="6" height="3" rx="0.8" fill="#6366f1" opacity="0.65" />
                        <rect x="27" y="28.5" width="6" height="3" rx="0.8" fill="#6366f1" opacity="0.65" />
                    </g>
                    <g className="rw-top-board">
                        <rect x="4" y="8" width="32" height="8" rx="2" fill="#3a3a42" stroke="#55555f" strokeWidth="1.5" />
                        <path d="M6 16 L11 8 M14 16 L19 8 M22 16 L27 8 M30 16 L35 8" stroke="#e8e8ee" strokeWidth="2.4" />
                    </g>
                    {mood === 'exhausted' || mood === 'sleeping' || mood === 'yawning' ? (
                        <g className="rw-eye" stroke="#c9c9d4" strokeWidth="2" strokeLinecap="round" fill="none">
                            <line x1="11" y1="22" x2="16" y2="22" />
                            <line x1="24" y1="22" x2="29" y2="22" />
                        </g>
                    ) : mood === 'sad' ? (
                        <g className="rw-eye">
                            <ellipse cx="13.5" cy="22.5" rx="2" ry="2.4" fill="#e8e8ee" />
                            <ellipse cx="26.5" cy="22.5" rx="2" ry="2.4" fill="#e8e8ee" />
                            <circle cx="16.5" cy="26" r="0.8" fill="#6495ed" opacity="0.7" />
                        </g>
                    ) : (
                        <g className="rw-eye">
                            <circle cx="13.5" cy="21.5" r="2.6" fill="#e8e8ee" />
                            <circle cx="26.5" cy="21.5" r="2.6" fill="#e8e8ee" />
                            <circle cx="13.5" cy="21.5" r="1.2" fill="#1b1b20" />
                            <circle cx="26.5" cy="21.5" r="1.2" fill="#1b1b20" />
                        </g>
                    )}
                </svg>
            )
        case 'fal-ai': // fal.ai - Lightning Bolt (CSS: .svg-art.fal)
            return (
                <svg className={`svg-art fal ${mood}`} viewBox="0 0 40 40" width="44" height="44">
                    <path className="fal-bolt" d="M23 3 L10 22 H18 L15 37 L30 16 H22 Z" fill="#ffeb3b" stroke="#f9a825" strokeWidth="1.5" strokeLinejoin="round" />
                    {mood === 'exhausted' || mood === 'sleeping' || mood === 'yawning' ? (
                        <g className="fal-eye" stroke="#5d4a00" strokeWidth="1.8" strokeLinecap="round" fill="none">
                            <line x1="15" y1="18" x2="18.5" y2="18" />
                            <line x1="23.5" y1="18" x2="27" y2="18" />
                        </g>
                    ) : mood === 'sad' ? (
                        <g className="fal-eye">
                            <ellipse cx="16.5" cy="18.5" rx="1.6" ry="2" fill="#5d4a00" />
                            <ellipse cx="25" cy="18.5" rx="1.6" ry="2" fill="#5d4a00" />
                            <circle cx="19.5" cy="22" r="0.7" fill="#6495ed" opacity="0.7" />
                        </g>
                    ) : (
                        <g className="fal-eye" fill="#5d4a00">
                            <circle cx="16.5" cy="18" r="1.8" />
                            <circle cx="25" cy="18" r="1.8" />
                        </g>
                    )}
                </svg>
            )
        case 'openrouter': // OpenRouter - Network Router Node (CSS: .svg-art.router)
            return (
                <svg className={`svg-art router ${mood}`} viewBox="0 0 40 40" width="44" height="44">
                    <g className="antenna left">
                        <line x1="12" y1="15" x2="8" y2="4" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
                        <circle cx="8" cy="4" r="1.6" fill="#93c5fd" />
                    </g>
                    <g className="antenna right">
                        <line x1="28" y1="15" x2="32" y2="4" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
                        <circle cx="32" cy="4" r="1.6" fill="#93c5fd" />
                    </g>
                    <rect className="router-box" x="6" y="14" width="28" height="17" rx="3.5" fill="#1e293b" stroke="#93c5fd" strokeWidth="1.5" />
                    <circle className="router-light" cx="31.5" cy="26.5" r="1.6" fill="#4ade80" />
                    {mood === 'exhausted' || mood === 'sleeping' || mood === 'yawning' ? (
                        <g className="router-eye" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" fill="none">
                            <line x1="11" y1="21" x2="15" y2="21" />
                            <line x1="21" y1="21" x2="25" y2="21" />
                        </g>
                    ) : mood === 'sad' ? (
                        <g className="router-eye">
                            <ellipse cx="13" cy="21.5" rx="1.9" ry="2.3" fill="#93c5fd" />
                            <ellipse cx="23" cy="21.5" rx="1.9" ry="2.3" fill="#93c5fd" />
                            <circle cx="16.5" cy="25" r="0.75" fill="#6495ed" opacity="0.7" />
                        </g>
                    ) : (
                        <g className="router-eye" fill="#93c5fd">
                            <circle cx="13" cy="21" r="2.2" />
                            <circle cx="23" cy="21" r="2.2" />
                        </g>
                    )}
                </svg>
            )
        case 'qwen':
            return <QwenMascot mood={mood} />
        default:
            return <LogoFallback id={id} />
    }
}

export function AiGotchiCharacter({ id, name, mood, speechBubble, speechPlacement, interactingWith, isDashing, isEating, landedAt, facing = 1, walking, grabbed, petAt, rootRef, onGrabStart, shouldSuppressClick }: AiGotchiCharacterProps) {
    // Random anim delay computed ONCE — re-renders must never restart CSS animations
    const animDelay = useMemo(() => `${(Math.random() * 0.5).toFixed(2)}s`, [])

    // Kimi form state - each Kimi instance has its own form state
    const [kimiForm, setKimiForm] = useState<'box' | 'sphere'>('sphere')

    // Auto-morph Kimi every 10 seconds — gated behind reduced-motion preference
    useEffect(() => {
        if (id !== 'kimi-code') return
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

        const interval = setInterval(() => {
            setKimiForm(prev => prev === 'box' ? 'sphere' : 'box')
        }, 10000) // 10 seconds

        return () => clearInterval(interval)
    }, [id])

    const handleKimiToggle = () => {
        if (id === 'kimi-code') {
            setKimiForm(prev => prev === 'box' ? 'sphere' : 'box')
        }
    }

    // Landing squash — timestamp-driven so it plays once per landing, no 60fps renders needed
    const [landing, setLanding] = useState(false)
    useEffect(() => {
        if (!landedAt) return
        setLanding(true)
        const t = setTimeout(() => setLanding(false), 240)
        return () => clearTimeout(t)
    }, [landedAt])

    // Pet squish — timestamp-driven squash when the user pets this character
    const [petSquish, setPetSquish] = useState(false)
    useEffect(() => {
        if (!petAt) return
        setPetSquish(true)
        const t = setTimeout(() => setPetSquish(false), 460)
        return () => clearTimeout(t)
    }, [petAt])

    // Build CSS class list
    const classNames = [
        'aigotchi-character',
        mood,
        onGrabStart ? 'interactive' : '',
        isDashing ? 'dashing' : '',
        isEating ? 'eating' : '',
        landing ? 'landing' : '',
        petSquish ? 'pet-squish' : '',
        walking ? 'walking' : '',
        grabbed ? 'grabbed' : '',
        facing === -1 ? 'facing-left' : ''
    ].filter(Boolean).join(' ')

    return (
        <div
            className={classNames}
            ref={rootRef}
            onPointerDown={(e) => onGrabStart && onGrabStart(id, e)}
            onClickCapture={(e) => {
                // After a drag-throw, swallow the synthetic click so it doesn't toggle Kimi's morph
                if (shouldSuppressClick && shouldSuppressClick(id)) {
                    e.stopPropagation()
                    e.preventDefault()
                }
            }}
        >
            {speechBubble && <div className={`speech-bubble placement-${speechPlacement || 'above'}`}>{speechBubble}</div>}

            <div className="char-flip">
                <div className="char-walk">
                    <div className={`avatar-container ${id}`} style={{ animationDelay: animDelay }}>
                        {interactingWith && <div className="interaction-heart">❤️</div>}

                        {renderPixelArt(id, mood, kimiForm, handleKimiToggle)}

                        {/* Status FX Overlays */}
                        {isDashing && <div className="status-fx startle">❗</div>}
                        {mood === 'sleeping' && <div className="status-fx zzz">Zzz</div>}
                        {mood === 'working' && <div className="status-fx sweat">💧</div>}
                        {mood === 'exhausted' && <div className="status-fx pant">💨</div>}
                        {mood === 'happy' && <div className="status-fx bounce">♪</div>}
                        {mood === 'idle' && <div className="status-fx idle-dots">· · ·</div>}
                        {mood === 'bored' && <div className="status-fx bored">⋯</div>}
                        {mood === 'curious' && <div className="status-fx curious">?</div>}
                        {mood === 'yawning' && <div className="status-fx yawn">( ˘ω˘ )</div>}
                        {mood === 'excited' && <div className="status-fx sparkle">✨</div>}
                        {mood === 'sad' && <div className="status-fx tear">💧</div>}

                        {/* Working particles — always mounted, play-state toggled by mood class */}
                        <div className="working-particle wp-left" style={{ left: '0px' }}>{'{ }'}</div>
                        <div className="working-particle wp-right" style={{ right: '0px' }}>{'</>'}</div>
                    </div>
                </div>
            </div>
            <div className="name-tag">{name}</div>
        </div>
    )
}
