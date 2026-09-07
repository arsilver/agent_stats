import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export type BurstKind = 'crumbs' | 'hearts' | 'dust' | 'confetti' | 'steam'

export interface AmbientCanvasHandle {
    burst: (x: number, y: number, kind: BurstKind) => void
}

interface AmbientCanvasProps {
    nightFactor: number      // 0 (full day) .. 1 (full night) — dust motes re-tint into fireflies
    workzoneActive: boolean  // any character recently used → data rain inside the workzone
    workzoneHeight?: number  // px from top where data rain may fall (default 150)
}

interface Mote { x: number; y: number; r: number; phase: number; speed: number; drift: number; alpha: number }
interface RainDrop { x: number; y: number; speed: number; glyph: string }
interface Particle { x: number; y: number; vx: number; vy: number; age: number; ttl: number; kind: BurstKind; size: number; hue: number; spin: number; rot: number }

const MOTE_COUNT = 35
const MAX_RAIN = 20
const MAX_PARTICLES = 60
const RAIN_GLYPHS = ['{', '}', '<', '>', '/', '0', '1']

// Pre-render a soft radial-gradient sprite so the per-frame draw is a single drawImage (no shadowBlur)
function makeSprite(color: string): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = 16
    c.height = 16
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(8, 8, 0, 8, 8, 8)
    grad.addColorStop(0, color)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 16, 16)
    return c
}

export const AmbientCanvas = forwardRef<AmbientCanvasHandle, AmbientCanvasProps>(function AmbientCanvas(
    { nightFactor, workzoneActive, workzoneHeight = 150 },
    ref
) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const nightRef = useRef(nightFactor)
    const workzoneActiveRef = useRef(workzoneActive)
    const workzoneHeightRef = useRef(workzoneHeight)
    const particlesRef = useRef<Particle[]>([])
    const burstCursorRef = useRef(0)

    useEffect(() => { nightRef.current = nightFactor }, [nightFactor])
    useEffect(() => { workzoneActiveRef.current = workzoneActive }, [workzoneActive])
    useEffect(() => { workzoneHeightRef.current = workzoneHeight }, [workzoneHeight])

    useImperativeHandle(ref, () => ({
        burst(x: number, y: number, kind: BurstKind) {
            const parts = particlesRef.current
            const spawn = (p: Particle) => {
                if (parts.length < MAX_PARTICLES) parts.push(p)
                else {
                    parts[burstCursorRef.current % MAX_PARTICLES] = p
                    burstCursorRef.current++
                }
            }
            if (kind === 'crumbs') {
                for (let i = 0; i < 6; i++) {
                    spawn({ x, y, vx: (Math.random() - 0.5) * 90, vy: -30 - Math.random() * 70, age: 0, ttl: 0.7 + Math.random() * 0.4, kind, size: 1.5 + Math.random() * 1.5, hue: 32, spin: 0, rot: 0 })
                }
            } else if (kind === 'hearts') {
                const n = 3 + Math.floor(Math.random() * 3) // 3-5 hearts
                for (let i = 0; i < n; i++) {
                    spawn({ x: x + (Math.random() - 0.5) * 20, y, vx: (Math.random() - 0.5) * 30, vy: -50 - Math.random() * 50, age: 0, ttl: 0.9 + Math.random() * 0.5, kind, size: 9 + Math.random() * 5, hue: 340, spin: 0, rot: 0 })
                }
            } else if (kind === 'dust') {
                for (let i = 0; i < 4; i++) {
                    spawn({ x: x + (Math.random() - 0.5) * 14, y, vx: (Math.random() - 0.5) * 40, vy: -8 - Math.random() * 18, age: 0, ttl: 0.5 + Math.random() * 0.3, kind, size: 3 + Math.random() * 3, hue: 0, spin: 0, rot: 0 })
                }
            } else if (kind === 'confetti') {
                for (let i = 0; i < 8; i++) {
                    spawn({ x, y, vx: (Math.random() - 0.5) * 160, vy: -60 - Math.random() * 140, age: 0, ttl: 1.1 + Math.random() * 0.6, kind, size: 3 + Math.random() * 3, hue: Math.random() * 360, spin: (Math.random() - 0.5) * 12, rot: Math.random() * Math.PI })
                }
            } else if (kind === 'steam') {
                for (let i = 0; i < 2; i++) {
                    spawn({ x: x + (Math.random() - 0.5) * 10, y, vx: (Math.random() - 0.5) * 8, vy: -18 - Math.random() * 14, age: 0, ttl: 1.4 + Math.random() * 0.6, kind, size: 4 + Math.random() * 4, hue: 0, spin: 0, rot: 0 })
                }
            }
        }
    }), [])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
        let w = 0
        let h = 0
        const resize = () => {
            const rect = canvas.getBoundingClientRect()
            w = rect.width
            h = rect.height
            canvas.width = Math.max(1, Math.round(w * dpr))
            canvas.height = Math.max(1, Math.round(h * dpr))
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        resize()
        const ro = new ResizeObserver(resize)
        ro.observe(canvas)

        const coolSprite = makeSprite('rgba(205,216,228,0.9)')
        const warmSprite = makeSprite('rgba(255,178,92,0.95)')

        const motes: Mote[] = []
        for (let i = 0; i < MOTE_COUNT; i++) {
            motes.push({
                x: Math.random(), y: Math.random(),
                r: 1 + Math.random() * 1.5,
                phase: Math.random() * Math.PI * 2,
                speed: 0.4 + Math.random() * 0.8,
                drift: 6 + Math.random() * 14,
                alpha: 0.05 + Math.random() * 0.1
            })
        }

        const rain: RainDrop[] = []
        let visible = true
        let rafId = 0
        let frame = 0
        let last = performance.now()

        const tick = (now: number) => {
            rafId = requestAnimationFrame(tick)
            frame++
            if (frame % 2 !== 0) return // 30fps: tick every other rAF
            const dt = Math.min((now - last) / 1000, 0.1)
            last = now
            if (!visible || w === 0 || h === 0) return

            const night = nightRef.current
            ctx.clearRect(0, 0, w, h)

            // ── Dust motes / fireflies ──
            for (const m of motes) {
                m.phase += dt * m.speed
                m.x += (m.drift * 0.12 * dt) / Math.max(w, 1)
                if (m.x > 1.05) m.x = -0.05
                const px = m.x * w + Math.sin(m.phase) * m.drift
                const py = m.y * h + Math.cos(m.phase * 0.7) * m.drift * 0.6
                const size = m.r * 8 * (1 + night * 0.35)
                const twinkle = 0.75 + 0.25 * Math.sin(m.phase * 2.3)
                if (night < 0.98) {
                    ctx.globalAlpha = m.alpha * twinkle * (1 - night)
                    ctx.drawImage(coolSprite, px - size / 2, py - size / 2, size, size)
                }
                if (night > 0.02) {
                    ctx.globalAlpha = m.alpha * 1.5 * twinkle * night
                    ctx.drawImage(warmSprite, px - size / 2, py - size / 2, size, size)
                }
            }

            // ── Data rain inside the workzone ──
            if (workzoneActiveRef.current) {
                if (rain.length < MAX_RAIN && Math.random() < 0.25) {
                    rain.push({
                        x: Math.random() * w,
                        y: -12,
                        speed: 40 + Math.random() * 55,
                        glyph: RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)]
                    })
                }
            }
            const wzH = workzoneHeightRef.current
            ctx.font = '10px monospace'
            for (let i = rain.length - 1; i >= 0; i--) {
                const r = rain[i]
                r.y += r.speed * dt
                if (r.y > wzH) { rain.splice(i, 1); continue }
                ctx.globalAlpha = Math.max(0, 0.55 * (1 - r.y / wzH))
                ctx.fillStyle = '#4ade80'
                ctx.fillText(r.glyph, r.x, r.y)
            }

            // ── Burst particles (ring buffer) ──
            const parts = particlesRef.current
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i]
                p.age += dt
                if (p.age >= p.ttl) { parts.splice(i, 1); continue }
                const t = p.age / p.ttl
                if (p.kind === 'crumbs' || p.kind === 'confetti') p.vy += 320 * dt
                p.x += p.vx * dt
                p.y += p.vy * dt
                p.rot += p.spin * dt

                if (p.kind === 'hearts') {
                    ctx.globalAlpha = 1 - t
                    ctx.font = `${p.size}px sans-serif`
                    ctx.fillStyle = '#ff7ba9'
                    ctx.fillText('♥', p.x, p.y)
                } else if (p.kind === 'confetti') {
                    ctx.globalAlpha = 1 - t * t
                    ctx.save()
                    ctx.translate(p.x, p.y)
                    ctx.rotate(p.rot)
                    ctx.fillStyle = `hsl(${p.hue}, 85%, 62%)`
                    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
                    ctx.restore()
                } else if (p.kind === 'crumbs') {
                    ctx.globalAlpha = 1 - t
                    ctx.fillStyle = '#d2a679'
                    ctx.beginPath()
                    ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2)
                    ctx.fill()
                } else if (p.kind === 'dust') {
                    ctx.globalAlpha = 0.35 * (1 - t)
                    ctx.fillStyle = '#9aa4b0'
                    ctx.beginPath()
                    ctx.arc(p.x, p.y, p.size * (0.6 + t), 0, Math.PI * 2)
                    ctx.fill()
                } else if (p.kind === 'steam') {
                    ctx.globalAlpha = 0.22 * (1 - t)
                    ctx.fillStyle = '#c7ccd4'
                    ctx.beginPath()
                    ctx.ellipse(p.x + Math.sin(p.age * 5) * 4, p.y, p.size * (0.7 + t * 0.8), p.size * (1 + t), 0, 0, Math.PI * 2)
                    ctx.fill()
                }
            }
            ctx.globalAlpha = 1
        }

        rafId = requestAnimationFrame(tick)

        const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting }, { threshold: 0.05 })
        io.observe(canvas)
        const onVis = () => { visible = !document.hidden }
        document.addEventListener('visibilitychange', onVis)

        return () => {
            cancelAnimationFrame(rafId)
            io.disconnect()
            document.removeEventListener('visibilitychange', onVis)
            ro.disconnect()
        }
    }, [])

    return <canvas ref={canvasRef} className="ambient-canvas" aria-hidden="true" />
})
