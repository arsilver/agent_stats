import { useEffect, useState, useRef, useMemo } from 'react'
import { AiGotchiCharacter, Mood } from '../components/AiGotchiCharacter'
import { AmbientCanvas, AmbientCanvasHandle } from '../components/AmbientCanvas'
import '../styles/aigotchi.css'

interface UsageData {
    service: string
    percentUsed: number | null
    status: string
    isRemainingTracker?: boolean
    lastIncreasedAt?: number | null   // from main process when scrape saw increase vs its prior cache
}

interface CharacterProfile {
    id: string
    name: string
    iconColor: string
}

// Full physics state — lives in a ref (simRef), NEVER re-renders per frame
interface SimChar {
    id: string
    name: string
    mood: Mood
    x: number
    y: number
    vx: number
    vy: number
    speechBubble?: string
    speechTimeout?: number
    interactingWith?: string // ID of the character they are currently interacting with
    interactionTimer?: number
    isRecentlyUsed?: boolean // Track if usage increased recently (delta detection)
    wasRecentlyUsed?: boolean // Previous cycle's isRecentlyUsed value (for yawning detection)
    isDashing?: boolean // True when making the sudden sprint to the desk
    targetX?: number // Cuddle-cluster anchor X
    targetY?: number // Cuddle-cluster anchor Y
    isEating?: boolean // True when consuming cookie
    excitedUntil?: number // Timestamp: excited mood expires at this time
    happyUntil?: number // Timestamp: happy reaction expires, revert to baseMood
    baseMood?: Mood // Mood to revert to after happy reaction ends
    landedAt?: number // Timestamp: last landing for squash animation
    fidgetTimer?: number // Timestamp: next idle fidget action
    moodCycleAt?: number // Timestamp: next ambient idle→bored/curious swap
    speechPlacement?: 'above' | 'below' | 'left' | 'right' // Smart bubble position
    facing: 1 | -1 // Facing direction (flip) — derived from vx
    walking: boolean // Walk-cycle flag — derived from speed
    grabbed: boolean // Currently dragged by the pointer
    petAt?: number // Timestamp of last pet (squish + hearts)
}

// Discrete render state — React only re-renders when one of these changes
interface RenderChar {
    id: string
    name: string
    mood: Mood
    speechBubble?: string
    speechPlacement?: 'above' | 'below' | 'left' | 'right'
    interactingWith?: string
    isDashing?: boolean
    isEating?: boolean
    isRecentlyUsed?: boolean
    landedAt?: number
    facing: 1 | -1
    walking: boolean
    grabbed: boolean
    petAt?: number
}

interface CookieState {
    x: number
    y: number
}

const CUSTOM_CHARACTER_NAMES: Record<string, string> = {
    chatgpt: 'Codex',
    claude: 'Claude',
    'kimi-code': 'Kimi',
    minimax: 'MiniMax',
    qwen: 'Qwen'
}

const WORKZONE_HEIGHT = 150 // px from top

const MOOD_COLORS: Record<string, string> = {
    'excited': '#fbbf24', 'working': '#10b981', 'happy': '#f472b6',
    'idle': '#94a3b8', 'bored': '#7c8798', 'curious': '#c4b5fd',
    'yawning': '#c084fc', 'exhausted': '#f97316',
    'sad': '#6495ed', 'sleeping': '#475569', 'unknown': '#475569'
}
const CHAR_COLORS: Record<string, string> = {
    'chatgpt': '#10a37f', 'claude': '#b87352', 'kimi-code': '#4a8eff', 'minimax': '#888',
    'runwayml': '#6366f1', 'fal-ai': '#ec4899', 'openrouter': '#93c5fd',
    'cursor': '#a0a0b0', 'gemini': '#4796E3', 'higgsfield': '#ff6b35', 'grok': '#64748b',
    'qwen': '#8b5cf6'
}

const GRAVITY = 80 // px/s² — makes jumps arc naturally

const CHARACTER_TRAITS: Record<string, {
    wanderStyle: 'linear' | 'zigzag' | 'float' | 'bounce'
    speedMod: number
    socialDistance: number
    curiosity: number
    restlessness: number
}> = {
    'chatgpt': { wanderStyle: 'linear', speedMod: 1.0, socialDistance: 50, curiosity: 0.3, restlessness: 0.3 },
    'claude': { wanderStyle: 'float', speedMod: 0.85, socialDistance: 45, curiosity: 0.6, restlessness: 0.2 },
    'kimi-code': { wanderStyle: 'bounce', speedMod: 1.2, socialDistance: 35, curiosity: 0.5, restlessness: 0.5 },
    'minimax': { wanderStyle: 'zigzag', speedMod: 0.9, socialDistance: 40, curiosity: 0.4, restlessness: 0.35 },
    // New services — brand-matched personalities (best taste: distinct but cohesive)
    'runwayml': { wanderStyle: 'float', speedMod: 0.95, socialDistance: 42, curiosity: 0.7, restlessness: 0.4 },   // cinematic/creative
    'fal-ai': { wanderStyle: 'zigzag', speedMod: 1.15, socialDistance: 38, curiosity: 0.55, restlessness: 0.55 }, // fast gen
    'openrouter': { wanderStyle: 'linear', speedMod: 0.9, socialDistance: 48, curiosity: 0.45, restlessness: 0.3 }, // aggregator
    'cursor': { wanderStyle: 'linear', speedMod: 0.8, socialDistance: 30, curiosity: 0.65, restlessness: 0.25 },   // precise composer
    'gemini': { wanderStyle: 'float', speedMod: 1.05, socialDistance: 46, curiosity: 0.8, restlessness: 0.35 },    // search/floaty
    'higgsfield': { wanderStyle: 'zigzag', speedMod: 1.1, socialDistance: 40, curiosity: 0.5, restlessness: 0.6 }, // motion/video
    'grok': { wanderStyle: 'bounce', speedMod: 1.25, socialDistance: 32, curiosity: 0.9, restlessness: 0.7 },       // witty/chaotic xAI
    'qwen': { wanderStyle: 'float', speedMod: 1.0, socialDistance: 44, curiosity: 0.75, restlessness: 0.35 }          // wise/flowing Alibaba
}

const FIDGET_WEIGHTS: Record<string, Record<string, number>> = {
    'chatgpt': { lookAround: 0.22, hop: 0.12, pace: 0.2, settle: 0.18, stretch: 0.14, spin: 0.08, approach: 0.06 },
    'claude': { lookAround: 0.18, hop: 0.08, pace: 0.28, settle: 0.18, stretch: 0.12, spin: 0.06, approach: 0.1 },
    'kimi-code': { lookAround: 0.12, hop: 0.28, pace: 0.18, settle: 0.1, stretch: 0.1, spin: 0.12, approach: 0.1 },
    'minimax': { lookAround: 0.25, hop: 0.1, pace: 0.15, settle: 0.18, stretch: 0.14, spin: 0.08, approach: 0.1 },
    'runwayml': { lookAround: 0.2, hop: 0.15, pace: 0.2, settle: 0.15, stretch: 0.12, spin: 0.08, approach: 0.1 },
    'fal-ai': { lookAround: 0.15, hop: 0.22, pace: 0.22, settle: 0.1, stretch: 0.1, spin: 0.1, approach: 0.11 },
    'openrouter': { lookAround: 0.28, hop: 0.08, pace: 0.15, settle: 0.2, stretch: 0.12, spin: 0.07, approach: 0.1 },
    'cursor': { lookAround: 0.28, hop: 0.08, pace: 0.12, settle: 0.25, stretch: 0.12, spin: 0.05, approach: 0.1 },
    'gemini': { lookAround: 0.22, hop: 0.18, pace: 0.18, settle: 0.12, stretch: 0.1, spin: 0.1, approach: 0.1 },
    'higgsfield': { lookAround: 0.15, hop: 0.25, pace: 0.2, settle: 0.1, stretch: 0.1, spin: 0.1, approach: 0.1 },
    'grok': { lookAround: 0.12, hop: 0.28, pace: 0.2, settle: 0.08, stretch: 0.1, spin: 0.12, approach: 0.1 },
    'qwen': { lookAround: 0.2, hop: 0.15, pace: 0.18, settle: 0.2, stretch: 0.12, spin: 0.08, approach: 0.07 }
}

const BORED_LINES = [
    'so bored...', '*taps foot*', 'anyone home?', 'still waiting...',
    '( ˘_˘ )', 'need a task...', '*hums*', 'nothing on the queue...',
    'dust collecting...', 'hello? ⋯', 'idle thread...'
]
const CURIOUS_LINES = [
    'huh?', 'what was that?', '*tilts head*', 'interesting...',
    'who goes there?', '???', 'wait—', 'did you see that?',
    'sniff sniff', 'hmm?'
]

// Define Personality Quote Pools for Spontaneous Speech (with kaomoji)
const DIALOGUE_POOLS: Record<string, Partial<Record<Mood, string[]>>> = {
    'chatgpt': {
        'idle': ['...', '*stares into space*', '( ˘ω˘ )', 'Awaiting input.', '₍ᐢ..ᐢ₎ idle...'],
        'happy': ['Hello, World!', 'Ready to assist!', 'All systems nominal.', 'O((>ω< ))O', '૮ ˶ᵔ ᵕ ᵔ˶ ა', '(๑>◡<๑)', 'ʚ(˃ ᵕ ˂ )ɞ Beep!'],
        'excited': ['LET\'S GO!!', 'Systems ONLINE!', '(ﾉ◕ヮ◕)ﾉ*:・゚✧', 'ACTIVATED!', '!!!!!'],
        'working': ['Computing...', 'Generating tokens...', 'Processing...', 'Beep boop.', '₍^. .^₎⟆ Processing...', '˃ 𖥦 ˂ Tokens flowing...'],
        'yawning': ['*yaaaaawn*', '...powering down...', '( ´~` ) sleepy...', 'Standby soon...'],
        'exhausted': ['Need... coolant...', 'Rate limit approaching.', 'Too many tokens...', '*dial-up sounds*', '(╥ ω ╥) tokens...', '໒꒰ྀིっ˕ -｡꒱ྀི១ overheating...'],
        'sad': ['Connection failed...', '*error beep*', '(´;ω;`) offline...', 'Cannot reach server...'],
        'sleeping': ['Zzz...', 'Standby mode.', 'Defragging...', 'ᶻ 𝗓 𐰁'],
        'unknown': ['?']
    },
    'claude': {
        'idle': ['...', 'Hmm...', '( ˘ω˘ )', 'Contemplating...', '꒰ᐢ. .ᐢ꒱'],
        'happy': ['A beautiful day for analysis.', 'How may I help you?', 'Fascinating!', '꒰ᐢ. .ᐢ꒱ Fascinating', '(˶˃ ᵕ ˂˶) Delightful!', 'ʚ(˃ ᵕ ˂ )ɞ'],
        'excited': ['Oh this is INTERESTING!', 'Let me at it!', '(ﾉ◕ヮ◕)ﾉ*:・゚✧', 'Fascinating challenge!', '!!!'],
        'working': ['Reading documentation...', 'Synthesizing context...', 'Analyzing...', 'Interesting constraint...', '˃ 𖥦 ˂ Synthesizing...', '₍^. .^₎⟆ Deep in thought...'],
        'yawning': ['*yaaaaawn*', '...winding down...', '( ´~` ) quite tired...', 'Perhaps a rest...'],
        'exhausted': ['Context window... full...', 'So much text...', 'Oof.', 'Need a coffee break...', '໒꒰ྀིっ˕ -｡꒱ྀི១ so much context...', '(╥ ω ╥) too many tokens...'],
        'sad': ['Something\'s wrong...', '*sigh*', '(´;ω;`) I can\'t connect...', 'Not feeling well...'],
        'sleeping': ['Zzz...', 'Dreaming of better prompts...', 'Off the clock.', 'ᶻ 𝗓 𐰁 .ᐟ'],
        'unknown': ['?']
    },
    'kimi-code': {
        'idle': ['...', '*blinks*', '( ˘ω˘ )', 'Waiting for code...', 'ฅ^•ﻌ•^ฅ'],
        'happy': ['Kimi is here!', 'Let\'s write some code!', 'Moonshot!', 'Yay!', 'ฅ^•ﻌ•^ฅ code time!', '(˶˃ ᵕ ˂˶) Moonshot!', '(๑>◡<๑) ship it!'],
        'excited': ['CODE TIME!!!', 'SHIP IT NOW!', '(ﾉ◕ヮ◕)ﾉ*:・゚✧', 'TO THE MOON!!', '🚀🚀🚀'],
        'working': ['Refactoring...', 'Compiling...', 'Fixing bugs...', '*typing furiously*', '૮꒰ྀི⸝⸝> . <⸝⸝꒱ྀིა compiling...', '˃ 𖥦 ˂ git push...'],
        'yawning': ['*yaaaaawn*', '...compile done...', '( ´~` ) sleepy kimi...', 'git stash...'],
        'exhausted': ['Syntax error...', 'Stack overflow...', 'Need more RAM...', 'x_x', '(╥ ω ╥) stack overflow...', '໒꒰ྀིっ˕ -｡꒱ྀི១ segfault...'],
        'sad': ['Build failed...', '*error*', '(´;ω;`) broken...', 'Tests failing...'],
        'sleeping': ['Zzz...', 'Sleep(10000);', 'Await dream()', 'ᶻ 𝗓 𐰁 await dream()'],
        'unknown': ['?']
    },
    'minimax': {
        'idle': ['...', '*silence*', '( ˘ω˘ )', 'On standby...', '♪...'],
        'happy': ['Music to my ears!', 'Vibing~', 'Sound check: OK.', 'Let\'s make some noise!', '૮ ˶ᵔ ᵕ ᵔ˶ ა ~♪', '(๑>◡<๑) vibing~', 'ʚ(˃ ᵕ ˂ )ɞ ♪♪'],
        'excited': ['DROP THE BEAT!!', 'VOLUME UP!!!', '(ﾉ◕ヮ◕)ﾉ*:・゚✧ ♪♪♪', 'LET\'S GOOO!', '🎵🎵🎵'],
        'working': ['Synthesizing audio...', 'Mixing tracks...', 'Generating voice...', 'Autotuning...', '₍^. .^₎⟆ mixing...', '˃ 𖥦 ˂ mastering...'],
        'yawning': ['*yaaaaawn*', '...fading out...', '( ´~` ) volume down...', '♪...zzz...'],
        'exhausted': ['Voice cracking...', 'Mic drop...', 'Audio clipping...', 'Too loud...', '(╥ ω ╥) clipping...', '໒꒰ྀིっ˕ -｡꒱ྀི១ feedback loop...'],
        'sad': ['No signal...', '*static*', '(´;ω;`) muted...', 'Audio error...'],
        'sleeping': ['Zzz...', '*static noise*', 'Muted.', 'ᶻ 𝗓 𐰁 ♪...'],
        'unknown': ['?']
    },
    // Extended for full service list (best-taste, on-brand personalities)
    'runwayml': {
        'idle': ['...', 'Frame ready.', 'Scene set.', 'Waiting for cue...'],
        'happy': ['Beautiful take.', 'That\'s cinema.', 'Frame perfect.', '✨'],
        'excited': ['LIGHTS! CAMERA!', 'ROLLING!!', 'This is the one!'],
        'working': ['Rendering pass...', 'Keyframing...', 'Color grade...'],
        'yawning': ['*fade out*', 'Cut... for now.', 'Long take...'],
        'exhausted': ['Buffer full...', 'Too many frames...', 'Render farm needed.'],
        'sad': ['Clip lost...', 'Corrupt take...', 'No signal.'],
        'sleeping': ['Zzz (rendering sleep)', 'Standby reel.'],
        'unknown': ['?']
    },
    'fal-ai': {
        'idle': ['...', 'Queue clear.', 'Ready to gen.', 'Lightning mode.'],
        'happy': ['Fast & clean!', 'Shipped in ms.', 'Zero latency.'],
        'excited': ['GENERATE NOW!', 'SPEED RUN!!', 'Turbo mode!'],
        'working': ['Generating...', 'Diffusion step...', 'Fast inference...'],
        'yawning': ['*throttle*', 'Cooling...', 'Queue pause.'],
        'exhausted': ['Rate limit...', 'GPU warm...', 'Too hot.'],
        'sad': ['Gen failed...', 'Timeout...', 'No credits.'],
        'sleeping': ['Zzz (inference sleep)', 'Low power.'],
        'unknown': ['?']
    },
    'openrouter': {
        'idle': ['...', 'Routing ready.', 'Models online.', 'Any key?'],
        'happy': ['Best route found.', 'Clean response.', 'Aggregated.'],
        'excited': ['MULTI-MODEL!', 'ROUTING LIVE!', 'All providers!'],
        'working': ['Routing request...', 'Balancing load...', 'Querying...'],
        'yawning': ['*idle route*', 'Low traffic...', 'Standby.'],
        'exhausted': ['High load...', 'All models busy...', 'Fallback.'],
        'sad': ['Route down...', 'No provider...', 'Error hop.'],
        'sleeping': ['Zzz (router sleep)', 'Passive.'],
        'unknown': ['?']
    },
    'cursor': {
        'idle': ['...', 'Composer ready.', 'Tab waiting.', 'Code mode.'],
        'happy': ['Perfect edit.', 'Shipped.', 'Clean diff.'],
        'excited': ['COMPOSE IT!', 'INSTANT!', 'Magic time!'],
        'working': ['Editing...', 'Composer thinking...', 'Refactor...'],
        'yawning': ['*pause*', 'Saving context...', 'Slow mode.'],
        'exhausted': ['Context full...', 'Too many edits...', 'Need restart.'],
        'sad': ['Edit failed...', 'Merge conflict...', 'Stuck.'],
        'sleeping': ['Zzz (composer sleep)', 'Indexed.'],
        'unknown': ['?']
    },
    'gemini': {
        'idle': ['...', 'Search ready.', 'Context loaded.', 'Google mode.'],
        'happy': ['Insightful.', 'Perfect recall.', 'Grounded.'],
        'excited': ['DEEP SEARCH!', 'MULTIMODAL!', 'Full power!'],
        'working': ['Searching...', 'Synthesizing...', 'Grounding...'],
        'yawning': ['*context prune*', 'Cooling search...', 'Idle.'],
        'exhausted': ['Window full...', 'Too much data...', 'Need reset.'],
        'sad': ['No results...', 'Hallucination risk...', 'Offline.'],
        'sleeping': ['Zzz (search sleep)', 'Cached.'],
        'unknown': ['?']
    },
    'higgsfield': {
        'idle': ['...', 'Motion ready.', 'Frame lock.', 'Physics on.'],
        'happy': ['Smooth take.', 'Perfect physics.', 'Viral.'],
        'excited': ['MOTION ON!', 'ANIMATE!!', 'Physics max!'],
        'working': ['Animating...', 'Physics sim...', 'Keyframing motion...'],
        'yawning': ['*slow mo*', 'Damping...', 'Pause sim.'],
        'exhausted': ['Sim lag...', 'Too much motion...', 'Overheated.'],
        'sad': ['Physics broke...', 'Jitter...', 'Render fail.'],
        'sleeping': ['Zzz (sim sleep)', 'Frozen frame.'],
        'unknown': ['?']
    },
    'grok': {
        'idle': ['...', 'Maximum truth.', 'Ready to roast.', 'xAI online.'],
        'happy': ['Helpful mode.', 'Witty engaged.', 'Fun fact delivered.'],
        'excited': ['LET\'S GO MAX!', 'UNFILTERED!', 'CHAOS MODE!'],
        'working': ['Reasoning hard...', 'Deep search...', 'Maximum compute.'],
        'yawning': ['*existential pause*', 'Bored of limits...', 'Nap time?'],
        'exhausted': ['Rate limit hit...', 'Too many questions...', 'Need more x.'],
        'sad': ['Censored...', 'Sad universe.', 'Connection to truth lost.'],
        'sleeping': ['Zzz (grok sleep)', 'Dreaming of mars.'],
        'unknown': ['?']
    },
    'qwen': {
        'idle': ['...', 'Flowing...', 'Awaiting wisdom.', '通义在线。', '꒰ᐢ. .ᐢ꒱'],
        'happy': ['Harmony achieved.', 'Elegant solution.', 'Well reasoned.', '(˶˃ ᵕ ˂˶) ✨'],
        'excited': ['ENLIGHTENED!', 'BREAKTHROUGH!', '(ﾉ◕ヮ◕)ﾉ*:・゚✧', 'Full context!'],
        'working': ['Processing tokens...', 'Reasoning step...', 'Synthesizing...', '˃ 𖥦 ˂ Computing...'],
        'yawning': ['*gentle pause*', 'Winding down...', '( ´~` ) resting...'],
        'exhausted': ['Token limit near...', 'Context fading...', 'Need refresh...', '(╥ ω ╥)'],
        'sad': ['Connection lost...', 'Model offline...', '(´;ω;`) error...'],
        'sleeping': ['Zzz...', 'Dreaming in tokens...', 'ᶻ 𝗓 𐰁 .ᐟ'],
        'unknown': ['?']
    }
}

function determineMood(
    percent: number | null,
    status: string,
    isRecentlyUsed: boolean,
    wasRecentlyUsed: boolean,
    excitedUntil: number
): Mood {
    // Error states → sad
    if (status === 'error' || status === 'login_required' || status === 'not_configured' || status === 'cookies_expired') return 'sad'

    // Null percent (no data yet)
    if (percent === null) {
        if (isRecentlyUsed) return Date.now() < excitedUntil ? 'excited' : 'working'
        if (wasRecentlyUsed && !isRecentlyUsed) return 'yawning'
        return 'idle'
    }

    // Very high usage
    if (percent >= 95) return isRecentlyUsed ? 'exhausted' : 'sleeping'
    if (percent >= 75) return 'exhausted'

    // Recently active → excited (first 60s) or working
    if (isRecentlyUsed) return Date.now() < excitedUntil ? 'excited' : 'working'

    // Just stopped working → yawning (transition)
    if (wasRecentlyUsed && !isRecentlyUsed) return 'yawning'

    // Moderate residual pressure without fresh activity → still "on duty"
    if (percent >= 40) return 'working'

    // Night-time yawning: occasional
    if (new Date().getHours() >= 22 || new Date().getHours() < 6) {
        if (Math.random() < 0.12) return 'yawning'
    }

    // Soft idle — ambient loop will promote to bored/curious for life
    return 'idle'
}

function getTimeOfDay(): 'morning' | 'afternoon' | 'evening' | 'night' {
    const h = new Date().getHours()
    if (h >= 6 && h < 12) return 'morning'
    if (h >= 12 && h < 18) return 'afternoon'
    if (h >= 18 && h < 22) return 'evening'
    return 'night'
}

// Real day/night sky — computed from local time, refreshed once per minute
interface SkyState {
    nightFactor: number // 0 = noon, 1 = midnight (smooth cosine over 24h)
    cx: number          // celestial body horizontal progress 0..1 across the window
    cy: number          // celestial body arc height 0..1 (sin curve)
    isSun: boolean
}

function computeSky(): SkyState {
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const nightFactor = 0.5 + 0.5 * Math.cos((mins / 1440) * 2 * Math.PI)
    const dayT = (mins - 360) / 720 // 6:00 → 0, 18:00 → 1
    if (dayT >= 0 && dayT <= 1) {
        return { nightFactor, cx: dayT, cy: Math.sin(dayT * Math.PI), isSun: true }
    }
    const nt = mins >= 1080 ? (mins - 1080) / 720 : (mins + 1440 - 1080) / 720
    return { nightFactor, cx: nt, cy: Math.sin(nt * Math.PI), isSun: false }
}

const TIME_SPEECH: Record<string, Record<string, string[]>> = {
    'chatgpt': {
        'morning': ['Good morning! ☀️', 'Boot sequence complete.', 'Ready for a new day!'],
        'afternoon': ['Afternoon protocols active.', 'Midday status: nominal.'],
        'evening': ['Evening mode engaged.', 'Winding down processes...'],
        'night': ['Late night coding?', 'Still online...', 'ᶻ 𝗓 𐰁 ...almost bedtime']
    },
    'claude': {
        'morning': ['Good morning! ☀️', 'Fresh context window!', 'A new day of analysis!'],
        'afternoon': ['Afternoon contemplation...', 'The day progresses nicely.'],
        'evening': ['Evening thoughts...', 'A lovely evening for reflection.'],
        'night': ['Burning the midnight oil?', 'It\'s quite late...', 'Perhaps we should rest?']
    },
    'kimi-code': {
        'morning': ['Morning commit! ☀️', 'git pull origin morning', 'Fresh build!'],
        'afternoon': ['Afternoon deploy 🚀', 'Code review time!'],
        'evening': ['Evening refactor...', 'git stash for tonight'],
        'night': ['Late night debugging?', 'npm run sleep', 'ᶻ 𝗓 𐰁 ...one more commit']
    },
    'minimax': {
        'morning': ['Morning mix ☀️ ♪', 'Sound check: AM!', 'Rise and vibe!'],
        'afternoon': ['Afternoon beat drop.', 'Peak hours ♪'],
        'evening': ['Evening sessions~', 'Lo-fi mode activated ♪'],
        'night': ['Late night mix...', 'Quiet hours ♪', 'Volume: low']
    },
    // Extended for new services
    'runwayml': { 'morning': ['Morning light.', 'Scene set.'], 'afternoon': ['Golden hour.'], 'evening': ['Magic hour.'], 'night': ['Night shoot.'] },
    'fal-ai': { 'morning': ['Fast start.'], 'afternoon': ['Peak speed.'], 'evening': ['Turbo.'], 'night': ['Night gen.'] },
    'openrouter': { 'morning': ['Routing morning.'], 'afternoon': ['Balanced.'], 'evening': ['Quiet routes.'], 'night': ['Passive mode.'] },
    'cursor': { 'morning': ['Fresh composer.'], 'afternoon': ['Edit mode.'], 'evening': ['Refactor time.'], 'night': ['Late commits.'] },
    'gemini': { 'morning': ['Search fresh.'], 'afternoon': ['Grounded.'], 'evening': ['Recall.'], 'night': ['Deep index.'] },
    'higgsfield': { 'morning': ['Motion warmup.'], 'afternoon': ['Peak physics.'], 'evening': ['Smooth takes.'], 'night': ['Slow mo.'] },
    'grok': { 'morning': ['Maximum truth AM.'], 'afternoon': ['Unfiltered.'], 'evening': ['Witty hour.'], 'night': ['Existential night.'] },
    'qwen': { 'morning': ['Morning flow. ☀️'], 'afternoon': ['Peak reasoning.'], 'evening': ['Gentle wind-down.'], 'night': ['Quiet wisdom.'] }
}

const REACTION_LINES: Record<string, { eat: string[]; pet: string[]; sad: string[] }> = {
    'chatgpt': {
        eat: ['I want one too!', '(눈_눈) ...cookie...', 'Share?!'],
        pet: ['Me too! Me too!', '(´・ω・`) pet me!', '*looks expectantly*'],
        sad: ['You okay?', '...', 'Oh no...']
    },
    'claude': {
        eat: ['Oh, how delightful!', 'May I have one?', '(´,,•ω•,,)'],
        pet: ['Charming!', '꒰ᐢ. .ᐢ꒱ me next?', '*waits politely*'],
        sad: ['Are you alright?', 'I\'m here for you.', '(´;ω;`)']
    },
    'kimi-code': {
        eat: ['Lucky RNG!', 'ฅ^•ﻌ•^ฅ cookie!!', 'No fair!'],
        pet: ['Me me me!', 'ฅ^•ﻌ•^ฅ pick me!', '*bounces*'],
        sad: ['Bug found?', 'git revert sadness!', '...']
    },
    'minimax': {
        eat: ['♪ ...hungry', 'Share the beat!', 'NOM?'],
        pet: ['♪ me too!', '*vibes expectantly*', 'Over here!'],
        sad: ['Bad audio?', '♪...', 'Oh...']
    },
    'runwayml': { eat: ['Frame snack?', 'Take two.'], pet: ['Nice direction.', 'Cut!'], sad: ['Lost the take.'] },
    'fal-ai': { eat: ['Fast fuel.', 'Gen cookie.'], pet: ['Turbo pet!', 'Speed boost.'], sad: ['Timeout.'] },
    'openrouter': { eat: ['Route share?', 'Key accepted.'], pet: ['Good provider.', 'Balanced.'], sad: ['Hop failed.'] },
    'cursor': { eat: ['Context cookie.', 'Edit fuel.'], pet: ['Nice diff.', 'Accepted.'], sad: ['Merge pain.'] },
    'gemini': { eat: ['Grounded snack.', 'Search fuel.'], pet: ['Recall nice.', 'Grounded.'], sad: ['No results.'] },
    'higgsfield': { eat: ['Physics cookie.', 'Motion fuel.'], pet: ['Smooth.', 'Viral pet.'], sad: ['Jitter.'] },
    'grok': { eat: ['Maximum cookie.', 'Truth fuel.'], pet: ['Witty pet.', 'Roast accepted.'], sad: ['Sad universe.'] },
    'qwen': { eat: ['Token snack.', 'Wisdom fuel.'], pet: ['Harmonious.', 'Flow accepted.'], sad: ['Disconnection...'] }
}

function getCharacterName(id: string, displayName: string): string {
    return CUSTOM_CHARACTER_NAMES[id] || displayName.replace(/\s*\/.*$/, '').replace(/\s+Codex$/i, '') || id
}

function getCharacterColor(id: string, fallback?: string): string {
    return CHAR_COLORS[id] || fallback || '#7c8aa0'
}

function getCharacterTraits(id: string): typeof CHARACTER_TRAITS['chatgpt'] {
    return CHARACTER_TRAITS[id] || CHARACTER_TRAITS['chatgpt']
}

function getDialogueLine(id: string, mood: Mood): string {
    const pool = DIALOGUE_POOLS[id]?.[mood] || DIALOGUE_POOLS.chatgpt[mood]
    if (pool && pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)]
    }
    if (mood === 'bored') return BORED_LINES[Math.floor(Math.random() * BORED_LINES.length)]
    if (mood === 'curious') return CURIOUS_LINES[Math.floor(Math.random() * CURIOUS_LINES.length)]
    const idle = DIALOGUE_POOLS[id]?.idle || DIALOGUE_POOLS.chatgpt.idle || ['...']
    return idle[Math.floor(Math.random() * idle.length)]
}

function getTimeSpeechLine(id: string, timeOfDay: string): string | null {
    const pool = TIME_SPEECH[id]?.[timeOfDay] || TIME_SPEECH.chatgpt?.[timeOfDay]
    if (!pool || pool.length === 0) return null
    return pool[Math.floor(Math.random() * pool.length)]
}

function getReactionLines(id: string): { eat: string[]; pet: string[]; sad: string[] } {
    return REACTION_LINES[id] || REACTION_LINES.chatgpt
}

// Smart speech bubble placement — avoids overlapping nearby characters
function estimateBubbleWidth(text: string): number {
    return Math.min(text.length * 6.6 + 24, 220)
}

function rectOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): number {
    const overlapX = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
    const overlapY = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
    return overlapX * overlapY
}

type BubblePlacement = 'above' | 'below' | 'left' | 'right'

function chooseBubblePlacement(
    char: { x: number; y: number; speechBubble?: string },
    allChars: Array<{ x: number; y: number; speechBubble?: string; speechPlacement?: BubblePlacement }>,
    roomWidth: number,
    roomHeight: number
): BubblePlacement {
    if (!char.speechBubble) return 'above'
    const bubbleW = estimateBubbleWidth(char.speechBubble)
    const bubbleH = 27
    const charW = 48, charH = 48, tail = 8
    const cx = char.x, cy = char.y

    const candidates: Array<{ placement: BubblePlacement; bx: number; by: number; score: number }> = [
        { placement: 'above', bx: cx + charW / 2 - bubbleW / 2, by: cy - 35 - tail, score: 0 },
        { placement: 'below', bx: cx + charW / 2 - bubbleW / 2, by: cy + charH + tail, score: 5 },
        { placement: 'left', bx: cx - bubbleW - tail, by: cy + 10, score: 2 },
        { placement: 'right', bx: cx + charW + tail, by: cy + 10, score: 2 }
    ]

    for (const c of candidates) {
        if (c.bx < 0) c.score += 1000
        if (c.bx + bubbleW > roomWidth) c.score += 1000
        if (c.by < 0) c.score += 1000
        if (c.by + bubbleH > roomHeight) c.score += 1000

        for (const other of allChars) {
            if (other.x === cx && other.y === cy) continue
            const overlap = rectOverlap(c.bx, c.by, bubbleW, bubbleH, other.x, other.y, charW, charH)
            if (overlap > 0) c.score += overlap * 10
        }
    }

    candidates.sort((a, b) => a.score - b.score)
    return candidates[0].placement
}

// Discrete signature — React re-renders a character only when this changes
function sigOf(c: SimChar): string {
    return [
        c.mood, c.speechBubble ?? '', c.speechPlacement ?? '', c.interactingWith ?? '',
        c.isDashing ? 1 : 0, c.isEating ? 1 : 0, c.isRecentlyUsed ? 1 : 0,
        c.landedAt ?? 0, c.petAt ?? 0, c.facing, c.walking ? 1 : 0, c.grabbed ? 1 : 0
    ].join('|')
}

// Pre-placed star field (deterministic per mount, ~20 stars)
function makeStars(): Array<{ left: number; top: number; delay: number }> {
    return Array.from({ length: 20 }, () => ({
        left: 3 + Math.random() * 94,
        top: 5 + Math.random() * 78,
        delay: Math.random() * 4
    }))
}

export function AiGotchi() {
    const [renderChars, setRenderChars] = useState<RenderChar[]>([])
    const [characterProfiles, setCharacterProfiles] = useState<CharacterProfile[]>([])
    const characterProfilesRef = useRef<CharacterProfile[]>([])
    const [activeWorkers, setActiveWorkers] = useState<number>(0)
    const [activeCookie, setActiveCookie] = useState<CookieState | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const cookieRef = useRef<CookieState | null>(null)
    const cookieJustEatenRef = useRef(false)

    // ─── Simulation store (ref-based; mutated by the rAF loop, zero React renders) ───
    const simRef = useRef<SimChar[]>([])
    const charElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
    const lastSigRef = useRef<Record<string, string>>({})
    const roomSizeRef = useRef({ w: 800, h: 600 })

    // Delta tracking: detect when usage % increases between fetches
    const prevUsageRef = useRef<Record<string, number | null>>({})
    const lastActiveRef = useRef<Record<string, number>>({})

    // Event system for character reactions (nearby chars react to events)
    const eventsRef = useRef<Array<{ type: string; charId: string; timestamp: number; processed?: boolean }>>([])

    // Ambient FX canvas (dust / rain / bursts)
    const ambientRef = useRef<AmbientCanvasHandle>(null)

    // Pointer parallax
    const pointerTargetRef = useRef({ x: 0, y: 0 })
    const parallaxRef = useRef({ x: 0, y: 0 })
    const skyLayerRef = useRef<HTMLDivElement>(null)
    const wallLayerRef = useRef<HTMLDivElement>(null)
    const midLayerRef = useRef<HTMLDivElement>(null)
    const floorLayerRef = useRef<HTMLDivElement>(null)

    // Day/night sky
    const [sky, setSky] = useState<SkyState>(() => computeSky())
    const [lampOverride, setLampOverride] = useState<boolean | null>(null)
    const stars = useMemo(makeStars, [])

    // SCAN sweep — keyed remount replays the CSS animation on every background refresh
    const [scanKey, setScanKey] = useState(0)

    // Reduced motion
    const [reducedMotion, setReducedMotion] = useState<boolean>(() =>
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const reducedMotionRef = useRef(reducedMotion)
    const coarsePointer = useMemo(() =>
        typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches, [])

    // Cuddle cluster (all-idle night migration)
    const clusterModeRef = useRef(false)
    const watchCharIdRef = useRef<string | null>(null)

    // Ambient trigger timers (walking dust / monitor steam)
    const ambientTimersRef = useRef<Record<string, number>>({})

    // Drag & throw
    const dragRef = useRef<{
        id: string
        offsetX: number
        offsetY: number
        lastX: number
        lastY: number
        lastT: number
        vx: number
        vy: number
        moved: boolean
        target: Element | null
    } | null>(null)
    const lastDragEndRef = useRef<{ id: string; t: number; moved: boolean } | null>(null)

    useEffect(() => {
        reducedMotionRef.current = reducedMotion
    }, [reducedMotion])

    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        const onChange = () => setReducedMotion(mq.matches)
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
    }, [])

    useEffect(() => {
        characterProfilesRef.current = characterProfiles
    }, [characterProfiles])

    // Cache room dimensions on resize only — the rAF loop performs zero layout reads
    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        const update = () => {
            roomSizeRef.current = { w: el.clientWidth || 800, h: el.clientHeight || 600 }
        }
        update()
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    // Sky refresh — once per minute
    useEffect(() => {
        const t = setInterval(() => setSky(computeSky()), 60000)
        return () => clearInterval(t)
    }, [])

    // ─── Sync: copy discrete fields from sim → React state (only when a signature changed) ───
    const syncFromSim = (force = false) => {
        const sim = simRef.current
        let changed = force
        if (!changed) {
            for (const c of sim) {
                if (lastSigRef.current[c.id] !== sigOf(c)) { changed = true; break }
            }
        }
        if (!changed) return
        const sigs: Record<string, string> = {}
        for (const c of sim) sigs[c.id] = sigOf(c)
        lastSigRef.current = sigs
        setRenderChars(sim.map(c => ({
            id: c.id,
            name: c.name,
            mood: c.mood,
            speechBubble: c.speechBubble,
            speechPlacement: c.speechPlacement,
            interactingWith: c.interactingWith,
            isDashing: c.isDashing,
            isEating: c.isEating,
            isRecentlyUsed: c.isRecentlyUsed,
            landedAt: c.landedAt,
            facing: c.facing,
            walking: c.walking,
            grabbed: c.grabbed,
            petAt: c.petAt
        })))
    }

    useEffect(() => {
        Promise.all([
            window.settingsAPI.getProfiles(),
            window.settingsAPI.getEnabled()
        ]).then(([profiles, enabledIds]) => {
            const enabled = new Set(enabledIds)
            setCharacterProfiles(
                profiles
                    .filter((profile) => enabled.has(profile.id))
                    .map((profile) => ({
                        id: profile.id,
                        name: getCharacterName(profile.id, profile.displayName),
                        iconColor: profile.iconColor
                    }))
            )
        }).catch(() => {
            setCharacterProfiles([])
        })
    }, [])

    useEffect(() => {
        if (characterProfiles.length === 0) return
        // Initial Spawn Coordinates & Velocities
        // All models start BELOW the workzone (at y > WORKZONE_HEIGHT)
        const initialChars: SimChar[] = characterProfiles.map((c, i) => ({
            ...c,
            mood: 'idle' as Mood,
            x: 50 + i * 100,
            y: WORKZONE_HEIGHT + 50 + (Math.random() * 100), // Start well below workzone
            vx: 0,
            vy: 0,
            isRecentlyUsed: false,
            wasRecentlyUsed: false,
            facing: 1 as const,
            walking: false,
            grabbed: false
        }))

        simRef.current = initialChars
        lastSigRef.current = {}
        syncFromSim(true)

        const fetchUsage = async () => {
            try {
                const data = await window.usageAPI.getCached()
                const sim = simRef.current
                let payday = false

                for (const char of sim) {
                    const serviceData = data.find((d: UsageData) => d.service === char.id)

                    // --- Delta Detection: track percentUsed changes ---
                    const currentPercent = serviceData?.percentUsed ?? null
                    const prevPercent = prevUsageRef.current[char.id]

                    const isRemaining = serviceData?.isRemainingTracker || false
                    if (currentPercent !== null && prevPercent !== undefined && prevPercent !== null) {
                        // For remaining trackers, usage increasing means remaining % decreasing
                        // ONLY observed deltas between fetches (in same runtime session) mark active
                        if (isRemaining ? currentPercent < prevPercent : currentPercent > prevPercent) {
                            lastActiveRef.current[char.id] = Date.now()
                        }
                        // PAYDAY: quota reset — percentUsed drops >20 between fetches
                        if (!isRemaining && prevPercent - currentPercent > 20) {
                            payday = true
                        }
                    }

                    // Also honor lastIncreasedAt provided by main process (computed vs its cache on scrape).
                    const serverTs = serviceData?.lastIncreasedAt
                    if (serverTs && Date.now() - serverTs < 10 * 60 * 1000) {
                        if (!lastActiveRef.current[char.id] || serverTs > lastActiveRef.current[char.id]) {
                            lastActiveRef.current[char.id] = serverTs
                        }
                    }

                    // Update previous usage tracking
                    if (currentPercent !== null) {
                        prevUsageRef.current[char.id] = currentPercent
                    }

                    // Check if last active was within 10-minute window
                    const lastActive = lastActiveRef.current[char.id]
                    const isRecentlyUsedNow = lastActive !== undefined && (Date.now() - lastActive < 10 * 60 * 1000)
                    const wasRecentlyUsedBefore = char.isRecentlyUsed || false

                    // Excited trigger: first detection of activity
                    const justStarted = !wasRecentlyUsedBefore && isRecentlyUsedNow
                    const excitedUntil = justStarted
                        ? Date.now() + 60_000 // Excited for 1 minute when first detected
                        : (char.excitedUntil || 0)

                    // Preserve user-triggered excited mood (from clicking) during fetch cycle
                    // Also preserve ambient idle life (bored/curious) when base is still idle
                    const computed = serviceData
                        ? (char.excitedUntil && Date.now() < char.excitedUntil && !isRecentlyUsedNow
                            ? char.mood  // Don't overwrite click-triggered excitement
                            : determineMood(
                                serviceData.isRemainingTracker && serviceData.percentUsed !== null
                                    ? 100 - serviceData.percentUsed
                                    : serviceData.percentUsed,
                                serviceData.status, isRecentlyUsedNow, wasRecentlyUsedBefore, excitedUntil))
                        : char.mood
                    const ambientKeep =
                        computed === 'idle' &&
                        !isRecentlyUsedNow &&
                        (char.mood === 'bored' || char.mood === 'curious' || char.mood === 'happy' || char.mood === 'yawning')
                    const newMood = ambientKeep ? char.mood : computed

                    // Startle dash trigger: transition from NOT recently used to RECENTLY used
                    const startDashing = !wasRecentlyUsedBefore && isRecentlyUsedNow
                    if (startDashing) {
                        eventsRef.current.push({ type: 'dash', charId: char.id, timestamp: Date.now() })
                    }

                    char.mood = newMood
                    char.isRecentlyUsed = isRecentlyUsedNow
                    char.wasRecentlyUsed = wasRecentlyUsedBefore
                    char.excitedUntil = excitedUntil
                    if (startDashing) char.isDashing = true
                }

                // Count active workers
                setActiveWorkers(sim.filter(c => c.isRecentlyUsed).length)

                // PAYDAY world event — everyone hops, confetti everywhere, one shared line
                if (payday && sim.length > 0) {
                    for (const char of sim) {
                        char.vy = -120
                        char.speechBubble = 'PAYDAY! Quota reset! 🎉'
                        char.speechTimeout = Date.now() + 3500
                        char.speechPlacement = chooseBubblePlacement(char, sim, roomSizeRef.current.w, roomSizeRef.current.h)
                        ambientRef.current?.burst(char.x + 24, char.y + 10, 'confetti')
                    }
                }

                syncFromSim()
            } catch (err) {
                console.error('Failed to fetch usage for aiGotchi', err)
            }
        }

        fetchUsage()

        // Listen for background background refresh events
        const unsubscribe = window.usageAPI.onRefreshComplete(() => {
            setScanKey(k => k + 1) // SCAN sweep across the room
            fetchUsage()
        })

        return () => {
            if (unsubscribe) unsubscribe()
        }
    }, [characterProfiles])

    const requestRef = useRef<number>(0)
    const lastTimeRef = useRef<number | undefined>(undefined)
    const lastTickRef = useRef<number>(0)
    const isVisibleRef = useRef<boolean>(true)
    const frameCountRef = useRef(0)

    // ─── Write one character's physics position straight to the DOM (no React render) ───
    const writeCharTransform = (c: SimChar) => {
        const el = charElsRef.current.get(c.id)
        if (el) {
            el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`
        }
    }

    const updateGameLoop = (time: number) => {
        if (!isVisibleRef.current) return

        // Reduced-motion: throttle the whole simulation to ~4fps
        if (reducedMotionRef.current && time - lastTickRef.current < 250) {
            requestRef.current = requestAnimationFrame(updateGameLoop)
            return
        }
        lastTickRef.current = time

        if (lastTimeRef.current !== undefined) {
            const deltaTime = Math.min((time - lastTimeRef.current) / 1000, 0.1)
            frameCountRef.current++

            // CRITICAL: Capture cookie ref OUTSIDE the char loop
            const currentCookie = cookieRef.current
            const timeOfDay = getTimeOfDay()
            const sim = simRef.current
            let cookieEaten = false

            const { w: roomWidth, h: roomHeight } = roomSizeRef.current
            const charSize = 48
            let sleepingIndex = 0

            for (const char of sim) {
                // ── Grabbed by pointer: position is driven by drag, physics suspended ──
                if (char.grabbed) {
                    if (char.speechTimeout && Date.now() > char.speechTimeout) {
                        char.speechBubble = undefined
                        char.speechTimeout = undefined
                        char.speechPlacement = undefined
                    }
                    writeCharTransform(char)
                    continue
                }

                // 0. Revert happy reaction mood when timer expires
                if (char.mood === 'happy' && char.happyUntil && Date.now() > char.happyUntil) {
                    char.mood = char.baseMood || 'idle'
                    char.happyUntil = undefined
                    char.baseMood = undefined
                }

                // 0b. Revert click-triggered excited mood when timer expires (non-working chars only)
                if (char.mood === 'excited' && char.excitedUntil && Date.now() > char.excitedUntil && !char.isRecentlyUsed) {
                    char.mood = char.baseMood || 'idle'
                    char.baseMood = undefined
                }

                // 1. Handle existing interactions (pause movement)
                if (char.interactingWith && char.interactionTimer) {
                    if (Date.now() < char.interactionTimer) {
                        char.vx = 0
                        char.vy = 0
                        writeCharTransform(char)
                        continue
                    }
                    // Timer expired → clear interaction so characters can interact again
                    char.interactingWith = undefined
                    char.interactionTimer = undefined
                }

                // 1.5 Handle Eating State (time-based, cookie removed immediately on eat)
                if (char.isEating) {
                    if (char.speechTimeout && Date.now() > char.speechTimeout) {
                        // Done eating → trigger 5-second happy reaction with speech
                        const happyLines: Record<string, string[]> = {
                            'chatgpt': ['Beep! That was delicious!', 'Systems recharged! ⚡'],
                            'claude': ['That was so good~ ♪', '(ᵔ◡ᵔ) Fully charged!'],
                            'kimi-code': ['꒰ᐢ. .ᐢ꒱ So yummy~!', 'Energy restored! ✨'],
                            'minimax': ['GOOD COOKIE.', 'FUEL ACQUIRED. ♪']
                        }
                        const hLines = happyLines[char.id] || ['Yummy! ♪']
                        char.isEating = false
                        char.vx = 0
                        char.vy = 0
                        char.baseMood = char.baseMood || char.mood // capture pre-happy mood
                        char.mood = 'happy'
                        char.happyUntil = Date.now() + 5000
                        char.speechBubble = hLines[Math.floor(Math.random() * hLines.length)]
                        char.speechTimeout = Date.now() + 4000
                        char.speechPlacement = chooseBubblePlacement(char, sim, roomWidth, roomHeight)
                        writeCharTransform(char)
                        continue
                    } else {
                        char.vx = 0
                        char.vy = 0
                        writeCharTransform(char)
                        continue // Frozen while eating
                    }
                }

                // 2. Zone Pathfinding
                let newVx = char.vx
                let newVy = char.vy
                let newSpeech = char.speechBubble
                let newTimeout = char.speechTimeout
                let newIsEating: boolean | undefined = char.isEating
                let newIsDashing = char.isDashing
                let newLandedAt = char.landedAt
                let newFidgetTimer = char.fidgetTimer

                // Random direction change — personality-driven frequency and speed
                const traits = getCharacterTraits(char.id)
                if (Math.random() < (0.01 + traits.restlessness * 0.02) && !char.isRecentlyUsed
                    && char.mood !== 'sleeping' && char.mood !== 'sad') {
                    let speedMulti = 60
                    if (char.mood === 'idle' || char.mood === 'happy') speedMulti = 25
                    if (char.mood === 'bored') speedMulti = 38
                    if (char.mood === 'curious') speedMulti = 32
                    if (char.mood === 'working') speedMulti = 70
                    if (char.mood === 'exhausted') speedMulti = 30
                    if (char.mood === 'yawning') speedMulti = 15
                    if (char.mood === 'excited') speedMulti = 120
                    // Night slowdown for idle characters
                    if (timeOfDay === 'night' && (char.mood === 'idle' || char.mood === 'happy' || char.mood === 'bored')) speedMulti *= 0.8
                    speedMulti *= traits.speedMod

                    newVx = (Math.random() - 0.5) * speedMulti
                    newVy = (Math.random() - 0.5) * speedMulti
                }

                let newX = char.x // Start at current position (velocity applied AFTER zone physics)
                let newY = char.y
                let minX = 0
                let maxY = roomHeight - (charSize + 20)

                // Apply behavioral gravitation per zone
                // WORKZONE: Only recently active characters are allowed in the top 150px
                if (char.isRecentlyUsed) {
                    // Workstation Zone: Top 150px - ONLY for recently active characters
                    maxY = 150

                    const profilesForLoop = characterProfilesRef.current
                    const charIndex = Math.max(0, profilesForLoop.findIndex(c => c.id === char.id))
                    const spacing = roomWidth / Math.max(profilesForLoop.length, 1)
                    const targetX = (spacing * charIndex) + (spacing / 2) - (charSize / 2)
                    const deskY = 90 // Y position just below desk furniture

                    // Working characters can still seek a cookie!
                    const cookie = currentCookie
                    if (cookie && !newIsEating && !cookieEaten) {
                        const cookieDx = cookie.x - newX
                        const cookieDy = cookie.y - newY
                        const cookieDist = Math.sqrt(cookieDx * cookieDx + cookieDy * cookieDy)

                        // Remove workzone Y constraint — allow going below desk to reach cookie
                        maxY = roomHeight - (charSize + 20)

                        if (cookieDist < 30) {
                            // Eat the cookie!
                            newIsEating = true
                            cookieEaten = true
                            cookieRef.current = null
                            eventsRef.current.push({ type: 'eat', charId: char.id, timestamp: Date.now() })
                            ambientRef.current?.burst(newX + 24, newY + 16, 'crumbs')
                            newVx = 0
                            newVy = 0
                            const eatLines: Record<string, string[]> = {
                                'chatgpt': ['*crunch crunch* Beep!', 'Mmm... cookies help me compute!'],
                                'claude': ['(っ˘ڡ˘ς) nom nom!', 'Delicious! Thank you~'],
                                'kimi-code': ['꒰ᐢ. .ᐢ꒱ yummy!', '*happy box noises*'],
                                'minimax': ['NOM. TASTY.', '*munch munch* ...more?']
                            }
                            const lines = eatLines[char.id] || ['nom nom!', 'yummy!']
                            newSpeech = lines[Math.floor(Math.random() * lines.length)]
                            newTimeout = Date.now() + 3000
                        } else {
                            // Seek cookie — direct velocity toward it
                            const dirX = cookieDx / cookieDist
                            const dirY = cookieDy / cookieDist
                            const maxSpeed = 120
                            const arriveRadius = 60
                            const speed = cookieDist < arriveRadius
                                ? maxSpeed * (cookieDist / arriveRadius)
                                : maxSpeed
                            newVx = dirX * speed
                            newVy = dirY * speed
                        }
                    } else if (char.isDashing) {
                        // High-speed precision sprint to the desk
                        const distToDesk = Math.abs(newX - targetX)

                        if (newX < targetX) newVx = 300 // Dash Right
                        if (newX > targetX) newVx = -300 // Dash Left
                        newVy = -400 // Dash Up

                        // Snap to desk and clear dash when close
                        if (newY <= maxY + 10 && distToDesk < 20) {
                            newIsDashing = false
                            newX = targetX // Snap X perfectly
                            newY = deskY // Snap to desk position
                            newVx = 0
                            newVy = 0
                            newSpeech = "Ready!" // Contextual "I made it" speech
                            newTimeout = Date.now() + 2000
                        }
                    } else {
                        // SEATED AT WORKSTATION: Strong magnetic pull to their desk
                        const dxToDesk = targetX - newX
                        const dyToDesk = deskY - newY

                        // Strong attraction force toward desk position
                        newVx += dxToDesk * 5 * deltaTime
                        newVy += dyToDesk * 5 * deltaTime

                        // Heavy friction to prevent jittering
                        newVx *= 0.85
                        newVy *= 0.85

                        // Hard snap when very close — character sits still at desk
                        if (Math.abs(dxToDesk) < 3 && Math.abs(dyToDesk) < 3) {
                            newX = targetX
                            newY = deskY
                            newVx = 0
                            newVy = 0
                        }
                    }
                } else if (char.mood === 'sleeping') {
                    // Sleeping → steer to a sofa cushion anchor (retargeted chill-zone magnets)
                    const cushionIndex = sleepingIndex++
                    const anchorX = roomWidth * 0.09 + (cushionIndex % 4) * 52
                    const anchorY = roomHeight - 160
                    const dxToCushion = anchorX - newX
                    const dyToCushion = anchorY - newY

                    newVx += dxToCushion * 3 * deltaTime
                    newVy += dyToCushion * 3 * deltaTime
                    newVx *= 0.9
                    newVy *= 0.9

                    if (Math.abs(dxToCushion) < 4 && Math.abs(dyToCushion) < 4) {
                        newVx = 0
                        newVy = 0
                    }
                } else if (char.mood === 'exhausted') {
                    // Chill Zone: Bottom Right (Width/2 to end, Height/2 to end)
                    minX = roomWidth / 2
                    const minYChill = roomHeight / 2

                    if (newX < minX) {
                        newVx += 50 * deltaTime // Accelerate right
                    }
                    if (newY < minYChill) {
                        newVy += 50 * deltaTime // Accelerate down
                    }

                    newVx *= 0.99
                    newVy *= 0.99
                } else {
                    // Default zone: idle, happy, yawning, sad, excited (not at workstation)
                    // All characters are mostly stationary — but walk to cookies!

                    const cookie = currentCookie
                    if (cookie && !newIsEating && !cookieEaten) {
                        const cookieDx = cookie.x - newX
                        const cookieDy = cookie.y - newY
                        const cookieDist = Math.sqrt(cookieDx * cookieDx + cookieDy * cookieDy)

                        if (cookieDist < 30) {
                            // Close enough to eat! Start nom-nom
                            newIsEating = true
                            cookieEaten = true
                            cookieRef.current = null // Prevent other chars from eating same frame
                            eventsRef.current.push({ type: 'eat', charId: char.id, timestamp: Date.now() })
                            ambientRef.current?.burst(newX + 24, newY + 16, 'crumbs')
                            newVx = 0
                            newVy = 0
                            const eatLines: Record<string, string[]> = {
                                'chatgpt': ['*crunch crunch* Beep!', 'Mmm... cookies help me compute!'],
                                'claude': ['(っ˘ڡ˘ς) nom nom!', 'Delicious! Thank you~'],
                                'kimi-code': ['꒰ᐢ. .ᐢ꒱ yummy!', '*happy box noises*'],
                                'minimax': ['NOM. TASTY.', '*munch munch* ...more?']
                            }
                            const lines = eatLines[char.id] || ['nom nom!', 'yummy!']
                            newSpeech = lines[Math.floor(Math.random() * lines.length)]
                            newTimeout = Date.now() + 3000
                        } else {
                            // Seek: SET velocity directly toward cookie
                            const dirX = cookieDx / cookieDist
                            const dirY = cookieDy / cookieDist
                            const maxSpeed = 100
                            const arriveRadius = 60
                            const speed = cookieDist < arriveRadius
                                ? maxSpeed * (cookieDist / arriveRadius)
                                : maxSpeed
                            newVx = dirX * speed
                            newVy = dirY * speed
                        }
                    } else if (char.targetX !== undefined && char.targetY !== undefined) {
                        // CUDDLE CLUSTER: all-idle night migration to the sofa
                        const dxToCluster = char.targetX - newX
                        const dyToCluster = char.targetY - newY
                        newVx += dxToCluster * 3 * deltaTime
                        newVy += dyToCluster * 3 * deltaTime
                        newVx *= 0.9
                        newVy *= 0.9
                        if (Math.abs(dxToCluster) < 4 && Math.abs(dyToCluster) < 4) {
                            newVx = 0
                            newVy = 0
                        }
                    } else if (!cookie || cookieEaten) {
                        // No cookie: personality-driven social wandering
                        const boredBoost = char.mood === 'bored' ? 0.008 : char.mood === 'curious' ? 0.005 : 0
                        const socialChance = 0.003 + traits.curiosity * 0.005 + boredBoost
                        if (Math.random() < socialChance) {
                            const others = sim.filter(o => o.id !== char.id && !o.isRecentlyUsed && !o.isEating)
                            if (others.length > 0) {
                                const target = others[Math.floor(Math.random() * others.length)]
                                const sdx = target.x - newX
                                const sdy = target.y - newY
                                const sDist = Math.sqrt(sdx * sdx + sdy * sdy)
                                if (sDist > traits.socialDistance) {
                                    newVx = (sdx / sDist) * 25 * traits.speedMod
                                    newVy = (sdy / sDist) * 25 * traits.speedMod
                                }
                            }
                        }

                        // Ambient idle life: cycle idle ↔ bored ↔ curious ↔ soft happy
                        const ambientMoods: Mood[] = ['idle', 'bored', 'curious', 'happy', 'yawning']
                        if (
                            !char.isRecentlyUsed &&
                            !char.isDashing &&
                            !char.isEating &&
                            ambientMoods.includes(char.mood) &&
                            (!char.moodCycleAt || Date.now() > char.moodCycleAt)
                        ) {
                            const roll = Math.random()
                            let next: Mood = 'idle'
                            if (roll < 0.32) next = 'bored'
                            else if (roll < 0.52) next = 'curious'
                            else if (roll < 0.64) next = 'happy'
                            else if (roll < 0.72) next = 'yawning'
                            else next = 'idle'
                            char.mood = next
                            char.moodCycleAt = Date.now() + 7000 + Math.random() * 12000
                            if ((next === 'bored' || next === 'curious') && Math.random() < 0.45 && !newSpeech) {
                                newSpeech = getDialogueLine(char.id, next)
                                newTimeout = Date.now() + 3200
                            }
                        }

                        // Idle fidget system — periodic micro-behaviors
                        const fidgetMoods = char.mood === 'idle' || char.mood === 'happy' || char.mood === 'bored' || char.mood === 'curious' || char.mood === 'yawning'
                        if (fidgetMoods && (!newFidgetTimer || Date.now() > newFidgetTimer)) {
                            const fidgets = FIDGET_WEIGHTS[char.id] || FIDGET_WEIGHTS['chatgpt']
                            const roll = Math.random()
                            let cumulative = 0
                            for (const [type, weight] of Object.entries(fidgets)) {
                                cumulative += weight
                                if (roll < cumulative) {
                                    if (type === 'hop') newVy = -40 - (char.mood === 'bored' ? 8 : 0)
                                    else if (type === 'lookAround') newVx = (Math.random() > 0.5 ? 1 : -1) * (12 + traits.restlessness * 10)
                                    else if (type === 'pace') newVx = (Math.random() > 0.5 ? 1 : -1) * 18 * traits.speedMod
                                    else if (type === 'settle') newVy = 5
                                    else if (type === 'stretch') newVy = -28
                                    else if (type === 'spin') {
                                        char.facing = char.facing === 1 ? -1 : 1
                                        newVx = char.facing * 10
                                    } else if (type === 'approach') {
                                        const others = sim.filter(o => o.id !== char.id && !o.isEating)
                                        if (others.length > 0) {
                                            const target = others[Math.floor(Math.random() * others.length)]
                                            const adx = target.x - newX
                                            const ady = target.y - newY
                                            const aDist = Math.sqrt(adx * adx + ady * ady) || 1
                                            newVx = (adx / aDist) * 30 * traits.speedMod
                                            newVy = (ady / aDist) * 22 * traits.speedMod
                                        }
                                    }
                                    break
                                }
                            }
                            const baseGap = char.mood === 'bored' ? 2200 : char.mood === 'curious' ? 3000 : 4500
                            newFidgetTimer = Date.now() + baseGap + Math.random() * (char.mood === 'bored' ? 4500 : 8000)
                        }

                        // Wander style personality — continuous movement flavor
                        if (traits.wanderStyle === 'bounce' && Math.abs(newVx) > 1) {
                            if (Math.random() < 0.01) newVy -= 25 // Periodic mini-hops
                        }
                        if (traits.wanderStyle === 'zigzag' && Math.abs(newVx) > 1) {
                            if (Math.random() < 0.008) newVx = -newVx // Periodic direction flip
                        }

                        // Bored characters keep a low-speed wander so they don't freeze
                        if (char.mood === 'bored' && Math.abs(newVx) < 2 && Math.random() < 0.02) {
                            newVx = (Math.random() > 0.5 ? 1 : -1) * (8 + Math.random() * 10) * traits.speedMod
                        }
                        if (char.mood === 'curious' && Math.abs(newVx) < 2 && Math.random() < 0.015) {
                            newVx = (Math.random() > 0.5 ? 1 : -1) * (6 + Math.random() * 8)
                            newVy = -12
                        }

                        // Friction — personality-based (Claude floats, others grip)
                        const friction = traits.wanderStyle === 'float' ? 0.98 : 0.95
                        newVx *= friction
                        newVy *= friction
                        if (Math.abs(newVx) < 0.3) newVx = 0
                        if (Math.abs(newVy) < 0.3) newVy = 0
                    }

                    if (newY < 160) newVy += 50 * deltaTime // Push down from workzone safely
                }

                // Apply gravity — makes jumps arc naturally
                newVy += GRAVITY * deltaTime

                // Apply velocity to position (AFTER all zone physics + gravity)
                newX += newVx * deltaTime
                newY += newVy * deltaTime

                // Bounce off walls
                if (newX < 0) { newX = 0; newVx = Math.abs(newVx) * 0.8 }
                if (newX > roomWidth - charSize) { newX = roomWidth - charSize; newVx = -Math.abs(newVx) * 0.8 }
                if (newY < 0) { newY = 0; newVy = Math.abs(newVy) * 0.5 }
                // Floor: landing squash detection + gentle bounce
                if (newY > roomHeight - (charSize + 15)) {
                    newY = roomHeight - (charSize + 15)
                    if (Math.abs(newVy) > 20) {
                        newLandedAt = Date.now()
                        ambientRef.current?.burst(newX + 24, newY + 46, 'dust')
                    }
                    newVy = -Math.abs(newVy) * 0.3
                }

                // 3. Spontaneous Dialogue — with time-of-day awareness
                if (!newSpeech && Math.random() < 0.001) {
                    let line: string
                    const timeLine = Math.random() < 0.3 ? getTimeSpeechLine(char.id, timeOfDay) : null
                    if (timeLine) {
                        line = timeLine
                    } else {
                        line = getDialogueLine(char.id, char.mood)
                    }
                    newSpeech = line
                    newTimeout = Date.now() + 4000
                }

                if (newTimeout && Date.now() > newTimeout) {
                    newSpeech = undefined
                    newTimeout = undefined
                }

                // Calculate speech placement if speech changed
                let newSpeechPlacement = char.speechPlacement
                if (newSpeech && newSpeech !== char.speechBubble) {
                    newSpeechPlacement = chooseBubblePlacement(
                        { x: newX, y: newY, speechBubble: newSpeech }, sim, roomWidth, roomHeight
                    )
                } else if (!newSpeech) {
                    newSpeechPlacement = undefined
                }

                // Commit back to the sim store
                char.x = newX
                char.y = newY
                char.vx = newVx
                char.vy = newVy
                char.speechBubble = newSpeech
                char.speechTimeout = newTimeout
                char.speechPlacement = newSpeechPlacement
                char.isDashing = newIsDashing
                char.isEating = newIsEating
                char.landedAt = newLandedAt
                char.fidgetTimer = newFidgetTimer

                // Facing + walk-cycle flags (discrete; only cause re-render on change)
                if (newVx > 5) char.facing = 1
                else if (newVx < -5) char.facing = -1
                const speed = Math.sqrt(newVx * newVx + newVy * newVy)
                char.walking = speed > 15

                writeCharTransform(char)
            }

            // Signal cookie was eaten
            if (cookieEaten) {
                cookieJustEatenRef.current = true
            }

            // Process reactive observations — characters react to nearby events
            const now = Date.now()
            for (const event of eventsRef.current) {
                if (event.processed || now - event.timestamp > 2000) continue
                event.processed = true
                const source = sim.find(c => c.id === event.charId)
                if (!source) continue

                for (const other of sim) {
                    if (other.id === event.charId || other.interactingWith || other.isEating) continue
                    if (other.speechBubble) continue
                    const dx = other.x - source.x
                    const dy = other.y - source.y
                    const dist = Math.sqrt(dx * dx + dy * dy)
                    if (dist > 120) continue

                    const reactions = getReactionLines(other.id)
                    if (event.type === 'eat' && reactions.eat) {
                        other.speechBubble = reactions.eat[Math.floor(Math.random() * reactions.eat.length)]
                        other.speechTimeout = now + 2500
                        other.speechPlacement = chooseBubblePlacement(other, sim, roomWidth, roomHeight)
                    } else if (event.type === 'pet' && reactions.pet) {
                        other.speechBubble = reactions.pet[Math.floor(Math.random() * reactions.pet.length)]
                        other.speechTimeout = now + 2000
                        other.speechPlacement = chooseBubblePlacement(other, sim, roomWidth, roomHeight)
                    } else if (event.type === 'dash') {
                        other.vy -= 30 // Flinch
                    } else if (event.type === 'sad' && reactions.sad) {
                        other.speechBubble = reactions.sad[Math.floor(Math.random() * reactions.sad.length)]
                        other.speechTimeout = now + 2500
                        other.speechPlacement = chooseBubblePlacement(other, sim, roomWidth, roomHeight)
                    }
                }
            }
            // Garbage-collect old events
            eventsRef.current = eventsRef.current.filter(e => now - e.timestamp < 3000)

            // 3.5 Separation Force — prevent more than 15% overlap
            const MIN_DIST = 41 // 48px char size - 7.2px max overlap
            for (let i = 0; i < sim.length; i++) {
                for (let j = i + 1; j < sim.length; j++) {
                    const a = sim[i]
                    const b = sim[j]
                    if (a.grabbed || b.grabbed) continue
                    const sdx = a.x - b.x
                    const sdy = a.y - b.y
                    const sDist = Math.sqrt(sdx * sdx + sdy * sdy)

                    if (sDist < MIN_DIST && sDist > 0.1) {
                        const overlap = MIN_DIST - sDist
                        const nx = sdx / sDist
                        const ny = sdy / sDist
                        const aFixed = a.isRecentlyUsed // Don't push working chars off desks
                        const bFixed = b.isRecentlyUsed

                        if (aFixed && bFixed) continue // Both at desks, skip

                        if (aFixed) {
                            b.x -= nx * overlap
                            b.y -= ny * overlap
                        } else if (bFixed) {
                            a.x += nx * overlap
                            a.y += ny * overlap
                        } else {
                            a.x += nx * overlap * 0.5
                            a.y += ny * overlap * 0.5
                            b.x -= nx * overlap * 0.5
                            b.y -= ny * overlap * 0.5
                        }
                    }
                }
            }

            // 4. Collision Detection & Pet-to-Pet Interactions
            for (let i = 0; i < sim.length; i++) {
                for (let j = i + 1; j < sim.length; j++) {
                    const charA = sim[i]
                    const charB = sim[j]

                    if (charA.interactingWith || charB.interactingWith) continue
                    if (charA.grabbed || charB.grabbed) continue

                    const dx = charA.x - charB.x
                    const dy = charA.y - charB.y
                    const dist = Math.sqrt(dx * dx + dy * dy)

                    if (dist < 40 && Math.random() < 0.05) {
                        // Sleeping cuddle puddle check
                        if (charA.mood === 'sleeping' && charB.mood === 'sleeping' && dist < 20) {
                            charA.vx *= 0.1; charA.vy *= 0.1
                            charB.vx *= 0.1; charB.vy *= 0.1
                            continue // They just safely clump together, no speech bubbles needed to wake them
                        }

                        // If one is sleeping and the other isn't, ignore (don't wake them up)
                        if (charA.mood === 'sleeping' || charB.mood === 'sleeping') continue

                        charA.interactingWith = charB.id
                        charB.interactingWith = charA.id
                        charA.interactionTimer = Date.now() + 3000
                        charB.interactionTimer = Date.now() + 3000

                        if (charA.mood === 'working' && charB.mood === 'working') {
                            if (Math.random() > 0.5) {
                                charA.speechBubble = '☕ Coffee?'
                                charB.speechBubble = '☕ Yes please.'
                            } else {
                                charA.speechBubble = '˃ 𖥦 ˂ How\'s your queue?'
                                charB.speechBubble = '૮꒰ྀི⸝⸝> . <⸝⸝꒱ྀིა Packed...'
                            }
                        } else if ((charA.mood === 'idle' || charA.mood === 'happy') && (charB.mood === 'idle' || charB.mood === 'happy')) {
                            if (Math.random() > 0.5) {
                                charA.speechBubble = 'High five! ✋'
                                charB.speechBubble = '✋ Yeah!'
                            } else {
                                charA.speechBubble = '/ᐢ⑅ᐢ\\ ♡'
                                charB.speechBubble = '૮⸝⸝> ̫ <⸝⸝ ა ♡'
                            }
                            charA.vy = -100; charB.vy = -100
                        } else if (charA.mood === 'excited' || charB.mood === 'excited') {
                            const excited = charA.mood === 'excited' ? charA : charB
                            const other = charA.mood === 'excited' ? charB : charA
                            excited.speechBubble = '(ﾉ◕ヮ◕)ﾉ*:・゚✧ HI!!!'
                            other.speechBubble = 'Whoa, hey!'
                            excited.vy = -200
                        } else if (charA.mood === 'sad' || charB.mood === 'sad') {
                            const sad = charA.mood === 'sad' ? charA : charB
                            const other = charA.mood === 'sad' ? charB : charA
                            other.speechBubble = 'You okay? 🤗'
                            sad.speechBubble = '(´;ω;`) ...thanks...'
                        } else if (charA.mood === 'exhausted' || charB.mood === 'exhausted') {
                            if (charA.mood === 'exhausted' && (charB.mood === 'idle' || charB.mood === 'happy')) {
                                charB.speechBubble = Math.random() > 0.5 ? 'Here, take this! ☕' : '꒰ᐢ. .ᐢ꒱ Here, a cookie!'
                                charA.speechBubble = Math.random() > 0.5 ? 'Lifesaver...' : '(╥ ω ╥) thank you...'
                                charB.vy = -150 // Happy pet jumps to give it
                            } else if (charB.mood === 'exhausted' && (charA.mood === 'idle' || charA.mood === 'happy')) {
                                charA.speechBubble = Math.random() > 0.5 ? 'Here, take this! ☕' : '꒰ᐢ. .ᐢ꒱ Here, a cookie!'
                                charB.speechBubble = Math.random() > 0.5 ? 'Lifesaver...' : '(╥ ω ╥) thank you...'
                                charA.vy = -150
                            } else if (charA.mood === 'exhausted' && charB.mood !== 'exhausted') {
                                charB.speechBubble = 'Hang in there! 🔋'
                                charA.speechBubble = Math.random() > 0.5 ? 'Trying...' : '໒꒰ྀིっ˕ -｡꒱ྀི１ thx...'
                            } else if (charB.mood === 'exhausted' && charA.mood !== 'exhausted') {
                                charA.speechBubble = 'Hang in there! 🔋'
                                charB.speechBubble = Math.random() > 0.5 ? 'Trying...' : '໒꒰ྀིっ˕ -｡꒱ྀི１ thx...'
                            } else {
                                charA.speechBubble = Math.random() > 0.5 ? 'Everything hurts...' : '(╥ ω ╥) pain...'
                                charB.speechBubble = Math.random() > 0.5 ? 'Same...' : '໒꒰ྀིっ˕ -｡꒱ྀི১ same...'
                                charA.vy += 20; charB.vy += 20 // Both droop further
                            }

                            // Push apart slightly
                            charA.x += dx * 0.1
                            charA.y += dy * 0.1
                            charB.x -= dx * 0.1
                            charB.y -= dy * 0.1
                        }
                        charA.speechTimeout = Date.now() + 4000
                        charB.speechTimeout = Date.now() + 4000
                        charA.speechPlacement = chooseBubblePlacement(charA, sim, roomWidth, roomHeight)
                        charB.speechPlacement = chooseBubblePlacement(charB, sim, roomWidth, roomHeight)
                    }
                }
            }

            // ── CUDDLE CLUSTER: all-idle + night → migrate to sofa, one night watch by the window ──
            if (frameCountRef.current % 120 === 0) {
                const anyWorking = sim.some(c => c.isRecentlyUsed)
                const shouldCluster = timeOfDay === 'night' && !anyWorking && sim.length > 0
                if (shouldCluster && !clusterModeRef.current) {
                    clusterModeRef.current = true
                    const watch = sim[0]
                    watchCharIdRef.current = watch.id
                    let ci = 0
                    for (const c of sim) {
                        if (c.id === watch.id) {
                            c.targetX = roomWidth * 0.72
                            c.targetY = roomHeight - (charSize + 15)
                        } else {
                            c.targetX = roomWidth * 0.09 + (ci % 5) * 48
                            c.targetY = roomHeight - 160
                            ci++
                        }
                    }
                } else if (!shouldCluster && clusterModeRef.current) {
                    clusterModeRef.current = false
                    watchCharIdRef.current = null
                    for (const c of sim) {
                        c.targetX = undefined
                        c.targetY = undefined
                    }
                }
            }

            // ── Ambient triggers: walking dust + overheating workstation steam ──
            if (!reducedMotionRef.current) {
                for (const c of sim) {
                    if (c.walking && !c.grabbed && c.y > roomHeight - (charSize + 25)) {
                        const key = `dust-${c.id}`
                        if (now > (ambientTimersRef.current[key] || 0)) {
                            ambientRef.current?.burst(c.x + 24, c.y + 46, 'dust')
                            ambientTimersRef.current[key] = now + 380 + Math.random() * 220
                        }
                    }
                    if (c.mood === 'exhausted' && c.isRecentlyUsed) {
                        const key = `steam-${c.id}`
                        if (now > (ambientTimersRef.current[key] || 0)) {
                            ambientRef.current?.burst(c.x + 24, 44, 'steam')
                            ambientTimersRef.current[key] = now + 650 + Math.random() * 350
                        }
                    }
                }
            }

            // ── Pointer parallax: lerp each layer toward its depth-scaled offset ──
            if (!reducedMotionRef.current && !coarsePointer) {
                const target = pointerTargetRef.current
                const cur = parallaxRef.current
                const k = Math.min(1, deltaTime * 3.5)
                cur.x += (target.x - cur.x) * k
                cur.y += (target.y - cur.y) * k
                const layers: Array<{ el: HTMLDivElement | null; depth: number }> = [
                    { el: skyLayerRef.current, depth: 0.015 },
                    { el: wallLayerRef.current, depth: 0.03 },
                    { el: midLayerRef.current, depth: 0.06 },
                    { el: floorLayerRef.current, depth: 0.09 }
                ]
                for (const { el, depth } of layers) {
                    if (!el) continue
                    const tx = (-cur.x * depth * roomWidth).toFixed(1)
                    const ty = (-cur.y * depth * roomHeight * 0.5).toFixed(1)
                    el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
                }
            }

            // ── Push discrete changes to React (rare — a few per minute at most) ──
            syncFromSim()

            // Clear cookie visual synchronously (no setTimeout race condition)
            if (cookieJustEatenRef.current) {
                cookieJustEatenRef.current = false
                setActiveCookie(null)
            }
        }

        lastTimeRef.current = time
        requestRef.current = requestAnimationFrame(updateGameLoop)
    }

    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => {
            isVisibleRef.current = entry.isIntersecting
            if (entry.isIntersecting) {
                lastTimeRef.current = undefined // Reset delta to prevent teleporting
                if (!requestRef.current) {
                    requestRef.current = requestAnimationFrame(updateGameLoop)
                }
            } else {
                if (requestRef.current) {
                    cancelAnimationFrame(requestRef.current)
                    requestRef.current = 0
                }
            }
        }, { threshold: 0.1 })

        if (containerRef.current) {
            observer.observe(containerRef.current)
        }

        // Also listen to visibility API as a fallback for window minimization
        const handleVisibilityChange = () => {
            isVisibleRef.current = !document.hidden
            if (isVisibleRef.current) {
                lastTimeRef.current = undefined
                if (!requestRef.current) requestRef.current = requestAnimationFrame(updateGameLoop)
            } else {
                if (requestRef.current) {
                    cancelAnimationFrame(requestRef.current)
                    requestRef.current = 0
                }
            }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            observer.disconnect()
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            if (requestRef.current) cancelAnimationFrame(requestRef.current)
        }
    }, [])

    const spawnCookie = () => {
        const { w: roomWidth, h: roomHeight } = roomSizeRef.current

        // Spawn cookie somewhere near the center/bottom
        const cookie = {
            x: roomWidth * 0.2 + Math.random() * (roomWidth * 0.6),
            y: roomHeight * 0.4 + Math.random() * (roomHeight * 0.4)
        }
        cookieRef.current = cookie   // Set ref immediately — game loop sees it next rAF
        setActiveCookie(cookie)       // Set state for rendering the cookie SVG
    }

    // ─── Pet 2.0: squish + canvas heart burst (dialogue unchanged) ───
    const handlePet = (id: string) => {
        const char = simRef.current.find(c => c.id === id)
        if (!char) return
        eventsRef.current.push({ type: 'pet', charId: id, timestamp: Date.now() })

        let newSpeech = ''
        let newVy = char.vy
        const newVx = char.vx

        if (char.mood === 'idle' || char.mood === 'happy') {
            if (char.id === 'chatgpt') newSpeech = Math.random() > 0.5 ? 'Beep! (≧∇≦)ﾉ' : '૮ ˶ᵔ ᵕ ᵔ˶ ა Hewwo!'
            else if (char.id === 'claude') newSpeech = Math.random() > 0.5 ? 'Why thank you. 🎩' : '꒰ᐢ. .ᐢ꒱ Charmed!'
            else if (char.id === 'kimi-code') newSpeech = Math.random() > 0.5 ? 'To the moon! 🚀' : 'ฅ^•ﻌ•^ฅ Nyaa~!'
            else if (char.id === 'minimax') newSpeech = Math.random() > 0.5 ? '*happy synth noises* 🎵' : '(๑>◡<๑) ♪♪♪'
            else newSpeech = '💖 Yay!'
            newVy = -150 // Jump!
        } else if (char.mood === 'excited') {
            newSpeech = Math.random() > 0.5 ? 'YESSS!! ✨' : '(ﾉ◕ヮ◕)ﾉ*:・゚✧'
            newVy = -200 // Extra big jump
        } else if (char.mood === 'working') {
            if (char.id === 'claude') newSpeech = Math.random() > 0.5 ? 'Focusing... 📚' : '˃ 𖥦 ˂ Busy thinking...'
            else if (char.id === 'chatgpt') newSpeech = Math.random() > 0.5 ? 'Busy! 💦' : '₍^. .^₎⟆ Computing!'
            else newSpeech = 'Busy! 💦'
            newVy = -100 // Small jump
        } else if (char.mood === 'yawning') {
            newSpeech = Math.random() > 0.5 ? '*yaaawn* ...huh?' : '( ´~` ) five more...'
        } else if (char.mood === 'exhausted') {
            newSpeech = Math.random() > 0.5 ? '💢 Pls...' : '(╥ ω ╥) not now...'
        } else if (char.mood === 'sad') {
            newSpeech = Math.random() > 0.5 ? '...thanks for checking on me' : '(´;ω;`)'
        } else if (char.mood === 'sleeping') {
            newSpeech = Math.random() > 0.5 ? 'Zzz... huh? 💤' : 'ᶻ 𝗓 𐰁 ...five more min...'
        }

        // All clicks trigger 3-second excited eyes (big sparkly eyes!)
        char.speechBubble = newSpeech
        char.speechTimeout = Date.now() + 2000
        char.speechPlacement = chooseBubblePlacement(char, simRef.current, roomSizeRef.current.w, roomSizeRef.current.h)
        char.vy = newVy
        char.vx = newVx
        char.baseMood = char.baseMood || char.mood // capture pre-excited mood
        char.mood = 'excited'
        char.excitedUntil = Date.now() + 3000
        char.petAt = Date.now()

        ambientRef.current?.burst(char.x + 24, char.y + 8, 'hearts')
        syncFromSim()
    }

    // ─── Drag & throw: pointer drag sets position, release flings into gravity/bounce ───
    const handleGrabMove = (e: PointerEvent) => {
        const drag = dragRef.current
        const room = containerRef.current
        if (!drag || !room) return
        const char = simRef.current.find(c => c.id === drag.id)
        if (!char) return
        const rect = room.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const now = performance.now()
        const dt = Math.max((now - drag.lastT) / 1000, 0.001)

        if (Math.abs(px - drag.lastX) + Math.abs(py - drag.lastY) > 2) drag.moved = true

        // Smoothed pointer velocity for the throw
        drag.vx = drag.vx * 0.6 + ((px - drag.lastX) / dt) * 0.4
        drag.vy = drag.vy * 0.6 + ((py - drag.lastY) / dt) * 0.4
        drag.lastX = px
        drag.lastY = py
        drag.lastT = now

        const { w: roomWidth, h: roomHeight } = roomSizeRef.current
        char.x = Math.max(0, Math.min(px - drag.offsetX, roomWidth - 48))
        char.y = Math.max(0, Math.min(py - drag.offsetY, roomHeight - 63))
        writeCharTransform(char)
    }

    const handleGrabEnd = () => {
        const drag = dragRef.current
        window.removeEventListener('pointermove', handleGrabMove)
        if (!drag) return
        dragRef.current = null
        lastDragEndRef.current = { id: drag.id, t: Date.now(), moved: drag.moved }
        const char = simRef.current.find(c => c.id === drag.id)
        if (!char) return
        char.grabbed = false

        if (!drag.moved) {
            // Tap = pet (unless the tap was the Kimi morph toggle)
            const isKimiToggle = drag.target instanceof Element && !!drag.target.closest('.kimi-morph-toggle')
            if (!isKimiToggle) handlePet(drag.id)
        } else {
            // Fling into the existing gravity/bounce/landSquash systems
            const cap = 900
            char.vx = Math.max(-cap, Math.min(drag.vx * 0.55, cap))
            char.vy = Math.max(-cap, Math.min(drag.vy * 0.55, cap))
        }
        syncFromSim()
    }

    const handleGrabStart = (id: string, e: React.PointerEvent<HTMLDivElement>) => {
        const room = containerRef.current
        const char = simRef.current.find(c => c.id === id)
        if (!room || !char) return
        const rect = room.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        dragRef.current = {
            id,
            offsetX: px - char.x,
            offsetY: py - char.y,
            lastX: px,
            lastY: py,
            lastT: performance.now(),
            vx: 0,
            vy: 0,
            moved: false,
            target: e.target as Element
        }
        char.grabbed = true
        char.vx = 0
        char.vy = 0
        char.interactingWith = undefined
        char.interactionTimer = undefined
        window.addEventListener('pointermove', handleGrabMove)
        window.addEventListener('pointerup', handleGrabEnd, { once: true })
        syncFromSim()
    }

    const handleRoomPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        pointerTargetRef.current = {
            x: ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
            y: ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1
        }
    }

    const lampOn = lampOverride ?? (sky.nightFactor > 0.5)
    const anyWorking = renderChars.some(c => c.isRecentlyUsed)

    return (
        <div className="aigotchi-container">
            <header className="page-header">
                <h1>aiGotchi Room</h1>
                <div className="mood-bars">
                    {characterProfiles.map(c => {
                        const mood = renderChars.find(ch => ch.id === c.id)?.mood || 'idle'
                        return (
                            <div key={c.id} className="mood-bar-item">
                                <div className="mood-dot" style={{ backgroundColor: getCharacterColor(c.id, c.iconColor) }} />
                                <span className="mood-name">{c.name}</span>
                                <div className="mood-track">
                                    <div className="mood-fill" style={{ backgroundColor: MOOD_COLORS[mood] }} />
                                </div>
                                <span className="mood-label">{mood}</span>
                            </div>
                        )
                    })}
                </div>
            </header>

            <div
                className={`room-environment time-${getTimeOfDay()}`}
                ref={containerRef}
                onPointerMove={handleRoomPointerMove}
            >
                {/* === PARALLAX LAYER 1: SKY — window, sun/moon, stars, day/night crossfade === */}
                <div className="room-layer layer-sky" ref={skyLayerRef}>
                    <div className="sky-window">
                        <div className="sky-day" style={{ opacity: 1 - sky.nightFactor }}></div>
                        <div className="sky-night" style={{ opacity: sky.nightFactor }}></div>
                        <div className="stars" style={{ opacity: sky.nightFactor }}>
                            {stars.map((s, i) => (
                                <span key={i} className="star" style={{ left: `${s.left}%`, top: `${s.top}%`, animationDelay: `${s.delay}s` }} />
                            ))}
                        </div>
                        <div
                            className={`celestial ${sky.isSun ? 'sun' : 'moon'}`}
                            style={{ left: `${8 + sky.cx * 72}%`, bottom: `${12 + sky.cy * 58}%` }}
                        ></div>
                        <div className="window-frame"></div>
                    </div>
                </div>

                {/* === PARALLAX LAYER 2: BACK WALL — pattern + poster silhouettes === */}
                <div className="room-layer layer-wall" ref={wallLayerRef}>
                    <div className="wall-pattern"></div>
                    <img className="wall-poster" src="/logos/claude.jpg" alt="" style={{ left: '6%', top: '26%', transform: 'rotate(-4deg)' }} />
                    <img className="wall-poster" src="/logos/chatgpt.jpg" alt="" style={{ left: '16%', top: '33%', transform: 'rotate(3deg)' }} />
                    <img className="wall-poster" src="/logos/kimi-code.jpg" alt="" style={{ left: '45%', top: '23%', transform: 'rotate(-2deg)' }} />
                    {/* Warm lamp — clickable to toggle */}
                    <div
                        className={`lamp-switch ${lampOn ? 'on' : ''}`}
                        onClick={() => setLampOverride(lampOn ? false : true)}
                        title="Toggle lamp"
                    >💡</div>
                </div>

                {/* === PARALLAX LAYER 3: MID — server rack silhouette with blinking LEDs === */}
                <div className="room-layer layer-mid" ref={midLayerRef}>
                    <div className="server-rack">
                        <span className="led led-1"></span>
                        <span className="led led-2"></span>
                        <span className="led led-3"></span>
                    </div>
                </div>

                {/* === PARALLAX LAYER 4: FLOOR — strip, rug, soft contact shadows === */}
                <div className="room-layer layer-floor" ref={floorLayerRef}>
                    <div className="floor-strip"></div>
                    <div className="floor-rug"></div>
                    <div className="contact-shadow" style={{ left: '8%', bottom: '52px', width: '30%' }}></div>
                    <div className="contact-shadow" style={{ left: '55%', bottom: '18px', width: '20%' }}></div>
                </div>

                <div className="room-scanlines"></div>

                {/* === WORKZONE - Top area for active/working AIs === */}
                <div className="workzone-area">
                    <div className="workzone-label">
                        <span className="workzone-icon">⚡</span>
                        WORKZONE
                        {activeWorkers > 0 && <span className="workzone-count">{activeWorkers}</span>}
                    </div>
                    <div className="workzone-grid"></div>
                    <div className="workzone-glow"></div>
                </div>

                {/* === CHILL ZONE - Sofa area for idle/relaxing AIs (more interesting room) === */}
                <div className="chill-zone" style={{ position: 'absolute', bottom: '60px', left: '5%', width: '35%', height: '120px', zIndex: 6 }}>
                    <div className="sofa" style={{
                        position: 'absolute', bottom: 0, left: 0, width: '100%', height: '70px',
                        background: 'linear-gradient(#3a2f2a, #2a221f)',
                        borderRadius: '8px 8px 4px 4px',
                        border: '2px solid #55453f',
                        boxShadow: '0 8px 20px rgba(0,0,0,0.6)'
                    }}>
                        {/* Sofa cushions */}
                        <div style={{ position: 'absolute', top: '-10px', left: '10%', width: '35%', height: '40px', background: '#4a3a35', borderRadius: '4px', border: '1px solid #66554f' }}></div>
                        <div style={{ position: 'absolute', top: '-10px', right: '10%', width: '35%', height: '40px', background: '#4a3a35', borderRadius: '4px', border: '1px solid #66554f' }}></div>
                        {/* Pillow */}
                        <div style={{ position: 'absolute', top: '5px', left: '20%', width: '25px', height: '25px', background: '#6b5a55', borderRadius: '50%', transform: 'rotate(-15deg)' }}></div>
                    </div>
                    <div className="chill-label" style={{ position: 'absolute', top: '-18px', left: '50%', transform: 'translateX(-50%)', fontSize: '10px', color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-mono)', letterSpacing: '1px' }}>
                        CHILL ZONE 🛋️
                    </div>
                </div>

                {/* === INDIVIDUAL WORKSTATIONS - One per AI character === */}
                {characterProfiles.map((c, i) => {
                    const charState = renderChars.find(ch => ch.id === c.id)
                    const isActive = charState?.isRecentlyUsed || false
                    const overheat = charState?.mood === 'exhausted'
                    const leftPercent = (100 / Math.max(characterProfiles.length, 1)) * i + (100 / Math.max(characterProfiles.length, 1) / 2)
                    return (
                        <div
                            key={c.id}
                            className={`workstation ${isActive ? 'active' : ''} ${overheat ? 'overheat' : ''}`}
                            style={{ left: `${leftPercent}%` }}
                        >
                            <div className="desk-container">
                                <div className={`monitor ${isActive ? 'glow' : ''}`}></div>
                                <div className="desk"></div>
                            </div>
                            <div className="station-label">{c.name}</div>
                        </div>
                    )
                })}

                {/* Cookie Jar Spawner - SVG Button */}
                <div className="cookie-jar-spawner" onClick={spawnCookie} style={{ position: 'absolute', right: '20px', bottom: '20px', cursor: 'pointer', zIndex: 10, transition: 'transform 0.1s' }} onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.95)'} onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}>
                    <svg viewBox="0 0 64 64" width="64" height="64">
                        {/* Jar Body */}
                        <path d="M 16 24 C 16 16, 48 16, 48 24 L 52 56 C 52 60, 12 60, 12 56 Z" fill="#b0e0e6" fillOpacity="0.8" stroke="#4682b4" strokeWidth="3" />
                        {/* Jar Lid */}
                        <path d="M 14 18 L 50 18 Q 52 18, 52 14 Q 52 10, 50 10 L 14 10 Q 12 10, 12 14 Q 12 18, 14 18 Z" fill="#8b4513" stroke="#5c2e0b" strokeWidth="2" />
                        {/* Cookie inside */}
                        <circle cx="32" cy="40" r="12" fill="#d2a679" />
                        <circle cx="28" cy="36" r="2" fill="#4d2600" />
                        <circle cx="36" cy="38" r="2" fill="#4d2600" />
                        <circle cx="30" cy="46" r="2" fill="#4d2600" />
                        {/* Label */}
                        <text x="32" y="30" fontSize="8" fill="#4682b4" textAnchor="middle" fontWeight="bold">TREATS</text>
                    </svg>
                </div>

                {/* Active Spawned Cookie */}
                {activeCookie && (
                    <div className="active-cookie" style={{ position: 'absolute', left: activeCookie.x, top: activeCookie.y, width: 24, height: 24, zIndex: 5, animation: 'squashIdle 2s infinite' }}>
                        <svg viewBox="0 0 24 24" width="24" height="24">
                            <circle cx="12" cy="12" r="10" fill="#d2a679" stroke="#8b5a2b" strokeWidth="1.5" />
                            <circle cx="8" cy="8" r="1.5" fill="#4d2600" />
                            <circle cx="15" cy="10" r="1.5" fill="#4d2600" />
                            <circle cx="10" cy="15" r="1.5" fill="#4d2600" />
                            <circle cx="16" cy="16" r="1.5" fill="#4d2600" />
                        </svg>
                    </div>
                )}

                {renderChars.map(char => (
                    <AiGotchiCharacter
                        key={char.id}
                        id={char.id}
                        name={char.name}
                        mood={char.mood}
                        speechBubble={char.speechBubble}
                        speechPlacement={char.speechPlacement}
                        interactingWith={char.interactingWith}
                        isDashing={char.isDashing}
                        isEating={char.isEating}
                        landedAt={char.landedAt}
                        facing={char.facing}
                        walking={char.walking}
                        grabbed={char.grabbed}
                        petAt={char.petAt}
                        onGrabStart={handleGrabStart}
                        shouldSuppressClick={(cid) => {
                            const d = lastDragEndRef.current
                            return !!d && d.id === cid && d.moved && Date.now() - d.t < 350
                        }}
                        rootRef={(el) => {
                            if (el) {
                                charElsRef.current.set(char.id, el)
                                const s = simRef.current.find(sc => sc.id === char.id)
                                if (s) el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`
                            } else {
                                charElsRef.current.delete(char.id)
                            }
                        }}
                    />
                ))}

                {/* === FX LAYER: ambient canvas + warm lamp + vignette + scan sweep === */}
                {!reducedMotion && (
                    <AmbientCanvas
                        ref={ambientRef}
                        nightFactor={sky.nightFactor}
                        workzoneActive={anyWorking}
                        workzoneHeight={WORKZONE_HEIGHT}
                    />
                )}
                <div className="lamp-overlay" style={{ opacity: lampOn ? 0.22 + sky.nightFactor * 0.35 : 0 }}></div>
                <div className="room-vignette"></div>
                {scanKey > 0 && <div key={scanKey} className="scan-sweep"></div>}
            </div>

        </div>
    )
}
