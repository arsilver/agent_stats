# Aigotchi Room - System Overview

A gamified virtual pet room that transforms AI service usage statistics into living, breathing characters. Each tracked AI service (ChatGPT/Codex, Claude, Kimi, MiniMax, RunwayML, fal.ai, OpenRouter, and logo-rendered Cursor, Gemini, Higgsfield, Grok) becomes a pet whose mood, movement, and personality reflect real-time usage data.

---

## Architecture

```
AiGotchi.tsx (Page)                    AiGotchiCharacter.tsx (Component)
  |                                       |
  |-- Game Loop (rAF, refs not state)     |-- SVG Rendering per Character
  |-- Physics Engine                      |-- Mood-based Eyes
  |-- Delta Detection (Activity)          |-- Kimi Box/Sphere Morphing
  |-- Mood Determination                  |-- Status FX Overlays
  |-- Seated-at-Desk Physics              |-- Speech Bubbles
  |-- Collision Detection                 |-- Logo Fallback (no custom art)
  |-- Dialogue System                     |
  |-- Cookie Mechanics                    |
  |-- Drag & Throw (grab/fling)           |
  |-- World Events (PAYDAY/SCAN)          |
  |                                       |
  AmbientCanvas.tsx (Canvas overlay)
  |-- Dust motes / night fireflies        |
  |-- Data rain behind active desks       |
  |-- burst() particle pool               |
  |                                       |
  aigotchi.css                            aigotchi-character.css
  (Room, Parallax, Day/Night, Workzone)   (46 Keyframe Animations)
```

### Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/renderer/src/pages/AiGotchi.tsx` | ~1850 | Game loop, physics, delta detection, mood logic, seated-at-desk mechanics, cookie system, drag & throw, parallax + day/night room, world events |
| `src/renderer/src/components/AiGotchiCharacter.tsx` | ~530 | Character SVG rendering (7 custom art sets + logo fallback), mood-based eyes, Kimi morphing |
| `src/renderer/src/components/AmbientCanvas.tsx` | ~250 | Canvas particle overlay: dust motes/fireflies, workzone data rain, pooled burst() effects |
| `src/renderer/src/styles/aigotchi.css` | ~720 | Room environment, parallax layers, day/night cycle, workzone, individual workstations |
| `src/renderer/src/styles/aigotchi-character.css` | ~1920 | All character animations, 46 keyframes, status effects |

### Tech Stack
- **Framework**: React 19 + TypeScript (Electron app)
- **Animation**: Pure CSS keyframes (no external animation libraries)
- **Game Loop**: `requestAnimationFrame` with delta-time physics
- **State**: Physics lives entirely in `simRef` (mutable ref, zero per-frame re-renders — positions are written to the DOM via direct `translate3d` style writes); React state is reserved for discrete UI changes (mood, speech bubbles, world events)
- **Activity Detection**: Delta-based usage tracking via `useRef` comparisons
- **Accessibility**: `prefers-reduced-motion` drops the loop to ~4fps, disables Kimi auto-morph, and unmounts the ambient canvas

---

## Characters

### Codex (ChatGPT)
- **SVG**: OpenAI spiral logo geometry
- **Unique trait**: Static inner logo (no rotation)
- **Color**: `#10a37f` (OpenAI green)

### Claude
- **SVG**: 8-bit pixel art brown retro character with arms, legs, and body
- **Unique trait**: Legs animate with `walkLegs` - 0.5s happy stroll, 0.15s working hustle
- **Color**: `#b87352` (warm brown)
- **Size**: 54x54px (35% bigger than others)

### Kimi
- **SVG**: Dual-form avatar that morphs between **Box** and **Sphere**
- **Unique trait**: Auto-toggles form every 10 seconds + clickable manual toggle
- **Morph animation**: Elastic cubic-bezier(0.68, -0.55, 0.265, 1.55) with 0.6-0.8s transitions
- **Color**: `#4a8eff` (Kimi blue)
- **Sphere exhausted**: SVG path morphs to a melting blob shape
- **Sphere sleeping**: SVG path morphs to a flat puddle

### MiniMax
- **SVG**: App "SD Card" M-shaped logo with cutout slots
- **Unique trait**: Cutout slots animate with `mmDataRead` when working (scales vertically)
- **Color**: `#fff` body (white cubic box), `#ccc` border stroke, `#ff9ca8` exhausted bg (overheats to red)
- **Eyes**: Dark (`#333` happy/working, `#999` exhausted/sleeping) for contrast on white body

### RunwayML
- **SVG**: Film clapperboard that snaps shut while working
- **Animations**: `rwClapFast` 0.5s (working), `rwClapSlow` 4s (happy), `idleFloat`, `workBounce`
- **Color**: `#6366f1` (indigo)

### fal.ai
- **SVG**: Lightning bolt
- **Animations**: `idleFloat`, `workBounce`
- **Color**: `#ec4899` (pink)

### OpenRouter
- **SVG**: Network router node with antennae and blinking lights
- **Animations**: `antennaWiggle` 0.5-3s, `blinkRandom` 0.5-2s (lights), `idleFloat`, `workBounce`
- **Color**: `#93c5fd` (light blue)

### Logo-fallback characters (Cursor, Gemini, Higgsfield, Grok)
Services without custom SVG art render via `LogoFallback` — the circular service logo
(`/logos/<id>.jpg`) with the same mood eyes, status FX, and physics as everyone else.
They still get full personality (wander style, speed, social distance, curiosity) from
the per-service personality tables in `AiGotchi.tsx`.

---

## Activity Detection (Delta System)

The Aigotchi room detects which AI services are actively in use via a **delta detection** pattern. The data pipeline (`usageFetcher.ts` -> IPC -> renderer) only provides `percentUsed` and `lastFetched` (scrape timestamp), not real-time activity timestamps. The delta system works entirely in the renderer.

### How It Works

```
Fetch N:    percentUsed = 45%     (stored in prevUsageRef)
Fetch N+1:  percentUsed = 48%     (comparison: 48 > 45 = ACTIVE!)
                                   -> lastActiveRef[id] = Date.now()
```

### Implementation

Two refs track state across fetches:

```typescript
const prevUsageRef = useRef<Record<string, number | null>>({})   // Previous percentUsed per service
const lastActiveRef = useRef<Record<string, number>>({})          // Timestamp of last detected activity
```

**Detection logic** (runs inside `fetchUsage` every 30s):
1. Compare current `percentUsed` with previous value
2. If increased -> mark service as active (`lastActiveRef[id] = Date.now()`)
3. First-load heuristic: services with `percentUsed > 0` on first fetch are treated as "potentially active"
4. Activity window: **10 minutes** - `isRecentlyUsed = (Date.now() - lastActive) < 10 * 60 * 1000`

### Activity vs Mood

`isRecentlyUsed` and `mood` serve different purposes:

| Concept | Controls | Source |
|---------|----------|--------|
| `isRecentlyUsed` | Workzone access, workstation glow, physics gating | Delta detection (percentUsed changes) |
| `mood` | Visual expression, animation style, eyes, status FX | `determineMood()` based on percentUsed + status + isRecentlyUsed |

A character can have `mood = 'working'` (because percentUsed >= 25%) but NOT be in the workzone if it hasn't been actively used in the last 10 minutes.

---

## Mood System

Moods are determined from live API usage data via `determineMood()`:

```
               Usage Data
                   |
    +--------------+--------------+
    |              |              |
 Status Check   % Used       Activity transition
    |              |         (delta + 60s excited window)
 error/login     |              |
 not_configured  |              |
    |           >= 95%          |
    v              |          just became active →
 'sad'         >= 75%        'excited' (~60s) → 'working'
                   |          just stopped → 'yawning'
               >= 25%           |
                   |           stale ≥10 min → 'idle'
               'exhausted'
                   |
                < 25%
                   |
                'idle'
```

### Mood Determination Rules

```typescript
function determineMood(percent, status, isRecentlyUsed, wasRecentlyUsed, excitedUntil): Mood {
    // Error states → sad
    if (status === 'error' || 'login_required' || 'not_configured' || 'cookies_expired') return 'sad'
    // No data yet
    if (percent === null) {
        if (isRecentlyUsed) return Date.now() < excitedUntil ? 'excited' : 'working'
        if (wasRecentlyUsed && !isRecentlyUsed) return 'yawning'
        return 'idle'
    }
    if (percent >= 95) return isRecentlyUsed ? 'exhausted' : 'sleeping'
    if (percent >= 75) return 'exhausted'
    if (isRecentlyUsed) return Date.now() < excitedUntil ? 'excited' : 'working'
    if (wasRecentlyUsed && !isRecentlyUsed) return 'yawning'
    if (percent >= 25) return 'working'
    return 'idle'
}
```

### Mood Types
| Mood | Trigger | Visual | Behavior |
|------|---------|--------|----------|
| `idle` | usage < 25%, not recently active | Calm, gentle breathing | Free wandering, personality-driven idle moves |
| `happy` | legacy/alias of low-usage state | Bright, bouncy, curved smile eyes | Free wandering in room |
| `excited` | just became active (first ~60s) | Sparkle/wide eyes, energetic | Hops, dashes to desk |
| `working` | recently used OR usage >= 25% | Fast bounce, sweat drops, code particles | Seated at personal workstation |
| `yawning` | just stopped being active (transition) | Yawn face | Winding down from desk |
| `exhausted` | usage >= 75% | Grayscale filter, slow sway, droopy | Slow movement, high friction; workstation monitor overheats with steam |
| `sleeping` | usage >= 95% (not active) | Flat/squished, very dim, closed eyes | Sleeps on sofa cushions; cuddle clusters at night |
| `sad` | error / login_required / not_configured / cookies_expired | Droopy, tear | Low energy wandering |
| `unknown` | fallback | Minimal | Neutral |

---

## Animation Engine

### Core Animation Styles per Mood

| Mood | Animation | Duration | Easing | Effect |
|------|-----------|----------|--------|--------|
| Happy | `squashIdle` | 3s | cubic-bezier(0.445, 0.05, 0.55, 0.95) | Organic squash-and-stretch float |
| Working | `stretchBounce` | 0.4s | cubic-bezier(0.28, 0.84, 0.42, 1) | Fast energetic bounce |
| Exhausted | `exhaustSway` | 3s | ease-in-out alternate | Slow side-to-side sway |
| Sleeping | (static) | - | transition 1s | Flattened, dimmed, no motion |

### All Keyframe Animations

| Animation | Duration | Use Case | Notes |
|-----------|----------|----------|-------|
| `squashIdle` | 3s | Happy idle breathing | Scale 1.05/0.95 squash-stretch cycle |
| `stretchBounce` | 0.4s | Working energy | Extreme 1.15/0.85 squash at impact |
| `exhaustSway` | 3s | Tired wobble | -4px to +4px, -5deg to +5deg |
| `startleDash` | N/A | Dash startup | Jump prep -> vault -> land |
| `typeVibrate` | 0.05-0.1s | Working jitter | Micro-shake on body parts |
| `walkLegs` | 0.15-0.5s | Claude legs | scaleY alternation |
| `blink` | 2-4s | Eye blink | 96% open, 98% closed, 100% open |
| `jitterSpin` | 1s | Codex exhausted | Stepped 90deg rotations |
| `rotateQuarterly` | 2-5s | (unused - Codex logo now static) | Smooth quarterly rotation |
| `spinSmooth` | - | Smooth rotation | 0-360deg linear |
| `spinSlow` | - | Slow rotation | 0-360deg linear |
| `pulseBreathe` | - | Breathing pulse | Scale 1 -> 1.1, opacity 1 -> 0.8 |
| `mmDataRead` | 0.2s | MiniMax working | Cutout vertical scale |
| `idleFloat` | 1-2.5s | Kimi sphere / Runway / Fal / Router happy | Gentle vertical float |
| `workBounce` | 0.25-0.4s | Runway / Router working | Quick work bounce |
| `munchBounce` | 0.3s | Eating state | Nom-nom vertical bounce |
| `curiousTilt` | 1.5s | Curious state | Head tilt with rotation |
| `rwClapFast` | 0.5s | Runway working | Fast clapperboard snap |
| `rwClapSlow` | 4s | Runway happy | Slow lazy clap |
| `antennaWiggle` | 0.5-3s | Router antennae | -10deg to +10deg |
| `blinkRandom` | 0.5-2s | Router lights | Opacity 0.3 -> 1 with glow |
| `floatUpZ` | 2s | Zzz sleep indicator | Float up + scale + fade |
| `dropSweat` | 1s | Sweat drops | Fall down + fade |
| `floatUpNote` | 2s | Music notes (happy) | Float up + fade |
| `floatSide` | 1s | Panting (exhausted) | Horizontal oscillation |
| `floatHeart` | 1s | Interaction hearts | Float up with red glow |
| `floatCode` | 1.5s | Code particles (working) | Float up + scale + fade |
| `startlePop` | 0.5s | Startle exclamation | Spring pop-in |
| `popIn` | 0.3s | Speech bubbles | Scale 0.5->1, elastic spring |
| `monitorFlicker` | 4s | Workstation monitor glow | Green glow flicker when active |
| `barrierPulse` | 1.5s | Workzone energy barrier | Pulsing blue line at workzone bottom |
| `gridScroll` | 20s | Workzone grid | Diagonal scrolling 40px grid pattern |
| `glowPulse` | 3s | Workzone top glow | Bright blue horizontal glow |

### Anti-Sync System
Each character gets a random `animationDelay` between 0-0.5s to prevent all pets from bouncing in perfect unison:
```typescript
const animDelay = `${(Math.random() * 0.5).toFixed(2)}s`
```

---

## Behavioral Zones

```
+---------------------------------------------------+
|  WORKZONE (0-150px)                                |
|  Blue gradient, energy barrier, scrolling grid     |
|                                                     |
|  [Codex Desk] [Claude Desk] [Kimi Desk] [MM Desk] |
|  Each character has a personal workstation          |
|  Only isRecentlyUsed characters are seated here     |
+---==ENERGY BARRIER (pulsing blue line)===-----------+
|                                                     |
|              FREE ROAM AREA                         |
|     Idle characters wander freely                   |
|                                                     |
|                                                     |
|                                    [COOKIE JAR]     |
+-----------------------------------------------------+
```

### Zone Mechanics
- **Workzone** (top 150px): Only `isRecentlyUsed` characters are allowed here. Each character has a personal workstation (monitor + desk) at an evenly spaced position. Characters dash to their desk and stay seated with magnetic pull physics.
- **Free Roam** (below 150px): All non-active characters wander freely. Happy characters pick random targets with 1% chance/frame, walk toward them with steering force. Exhausted/sleeping characters slow via friction.

### Individual Workstations

Each character has a dedicated workstation positioned evenly across the workzone. The count is dynamic — it follows the number of enabled character profiles, not a hardcoded 4:

```
leftPercent = (100 / N) * index + (100 / N / 2)   // N = characterProfiles.length
```

With the original 4 characters this gave 12.5% / 37.5% / 62.5% / 87.5%; the same formula now spreads however many services are enabled.

**Workstation states:**
- **Inactive** (`opacity: 0.35`): Dimmed desk and monitor, faded label
- **Active** (`opacity: 1`): Full brightness, monitor has green glow (`monitorFlicker` 4s), label glows blue with text-shadow

---

## Physics System

### Core Loop
- **Engine**: `requestAnimationFrame` with delta-time (`deltaTime = (time - lastTime) / 1000`)
- **Update**: Position = Position + (Velocity * deltaTime)
- **Friction**: Varies by mood (working: none, exhausted: 0.99, sleeping in zone: 0.95)

### Dash Mechanics
When a character's `isRecentlyUsed` transitions to `true`:
1. `isDashing = true` triggers
2. Velocity set to: `vx = +-300px/s`, `vy = -400px/s` (sprint toward desk)
3. Status FX: `!` startle indicator + `startleDash` animation
4. Snaps to personal workstation position (`targetX`, `deskY = 90`) when within 20px
5. Speech bubble: "Ready!"
6. `isDashing = false`, transitions to **seated-at-desk** mode

### Seated-at-Desk Physics (Spring-Damper)

Once a character finishes dashing and `isRecentlyUsed` remains true, it enters **seated mode** with magnetic pull to its desk:

```typescript
// Spring force toward desk position
const dxToDesk = targetX - newX
const dyToDesk = deskY - newY      // deskY = 90 (just below monitor+desk)
newVx += dxToDesk * 5 * deltaTime  // Attraction proportional to distance
newVy += dyToDesk * 5 * deltaTime

// Friction damping prevents oscillation
newVx *= 0.85
newVy *= 0.85

// Hard snap when very close - character sits perfectly still
if (Math.abs(dxToDesk) < 3 && Math.abs(dyToDesk) < 3) {
    newX = targetX; newY = deskY
    newVx = 0; newVy = 0
}
```

**Key behaviors:**
- Random velocity kicks are **skipped** for `isRecentlyUsed` characters (prevents drift)
- Spring constant: `5` (strong enough for quick convergence, soft enough for smooth arrival)
- Friction coefficient: `0.85` (heavy damping prevents jitter)
- Snap threshold: `3px` (character locks to exact desk position when close enough)

### Wall Bouncing
```
if (x < 0) { x = 0; vx = |vx| * 0.8 }        // Left wall
if (x > roomWidth - 48) { ... }                  // Right wall
if (y < 0) { y = 0; vy = |vy| * 0.8 }          // Ceiling
if (y > roomHeight - 63) { ... }                  // Floor
```
Energy loss on bounce: 20% (multiply by 0.8)

### Collision Detection
- **Pet-to-pet**: Distance check between all pairs, trigger interaction at < 40px with 5% probability
- **Sleeping cuddle puddle**: At < 20px, both sleeping pets clamp velocity to 0.1x (no waking)
- **Sleeping protection**: If one pet is sleeping and the other isn't, interaction is skipped

---

## Dialogue System

### Spontaneous Speech
- **Trigger**: 0.05% chance per frame (Math.random() < 0.0005)
- **Duration**: 4 seconds
- **Source**: Character-specific `DIALOGUE_POOLS` organized by mood
- **Visual**: White speech bubble with popIn animation, black border, pointer arrow

### Character Dialogue Pools

**Codex**: `'Hello, World!'`, `'Ready to assist!'`, `'All systems nominal.'`, `'O((>ω< ))O'` ...
**Claude**: `'A beautiful day for analysis.'`, `'How may I help you?'`, `'Fascinating!'` ...
**Kimi**: `'Kimi is here!'`, `'Let\'s write some code!'`, `'Moonshot!'` ...
**MiniMax**: `'Music to my ears!'`, `'Vibing~'`, `'Sound check: OK.'` ...

### Interaction Dialogues (Character-to-Character)

| Mood Combo | Character A | Character B | Effect |
|-----------|-------------|-------------|--------|
| working + working | "Coffee? ☕" | "Yes please. ☕" | - |
| happy + happy | "High five! ✋" | "Yeah! ✋" | Both jump (vy = -100) |
| exhausted + happy | "Lifesaver..." | "Here, take this! ☕" | Happy jumps (vy = -150) |
| exhausted + other | "Trying..." | "Hang in there! &#x1f50b;" | - |
| exhausted + exhausted | "Everything hurts..." | "Same..." | Both droop (vy += 20) |

### Pet Click Responses

| Character | Happy | Working | Exhausted | Sleeping |
|-----------|-------|---------|-----------|----------|
| Codex | `Beep! (≧∇≦)ﾉ` | `Busy! 💦` | `💢 Pls...` | `Zzz... huh? 💤` |
| Claude | `Why thank you. 🎩` | `Focusing... 📚` | `💢 Pls...` | `Zzz... huh? 💤` |
| Kimi | `To the moon! 🚀` | `Busy! 💦` | `💢 Pls...` | `Zzz... huh? 💤` |
| MiniMax | `*happy synth noises* 🎵` | `Busy! 💦` | `💢 Pls...` | `Zzz... huh? 💤` |

---

## Status Effects

Visual overlays rendered above each character:

| Effect | Element | Animation | Trigger |
|--------|---------|-----------|---------|
| `Zzz` | Text "Zzz" | `floatUpZ` 2s - float up, scale, fade | Sleeping mood |
| 💧 | Sweat drop | `dropSweat` 1s - fall down, fade | Working mood |
| 💨 | Panting cloud | `floatSide` 1s - horizontal sway | Exhausted mood |
| ♪ | Music note | `floatUpNote` 2s - float up, fade | Happy mood |
| ❤️ | Heart | `floatHeart` 1s - float up with glow | Character interaction |
| ❗ | Exclamation | `startlePop` 0.5s - spring pop | Dashing state |
| `{ }` / `</>` | Code text | `floatCode` 1.5s - float up | Working mood (50% chance each) |

---

## Cookie / Treat System

### Spawning
- Click the **Cookie Jar** (bottom-right SVG button) to spawn a cookie
- Cookie appears at random position in center-bottom area
- Uses `squashIdle` animation for a lively floating effect
- Expires after **10 seconds** (checked every 1s interval)

### Cookie State
```typescript
interface CookieState {
    x: number
    y: number
    spawnTime: number
}
```

### Character Eating
- `isEating` flag on CharacterState
- When eating: velocity = 0 (complete stop)
- When cookie despawns while eating: `isEating = false`

---

## Interaction Systems

### Click-to-Pet 2.0
Clicking a character squishes it (squash-and-stretch) and bursts hearts via the pooled
`burst('hearts')` particle API, plus a mood-specific speech line (see Pet Click Responses).

### Drag & Throw
Characters can be grabbed with the pointer and flung. Release velocity feeds straight
into the existing gravity/bounce/land-squash physics — a hard throw bounces them off
walls and ends in a landing squash.

---

## World Events (usage-driven)

Global room events triggered by the data pipeline:

| Event | Trigger | Effect |
|-------|---------|--------|
| **PAYDAY** | Any service's `percentUsed` drops >20 between fetches (quota reset) | Confetti `burst()`, every character hops, one shared "PAYDAY! Quota reset! 🎉" line |
| **SCAN** | Every background data refresh | Keyed-remount sweep animation crosses the room |
| **Overheat** | Character at ≥75% usage seated at desk | Their workstation monitor steams (`overheat` class) |
| **Night cuddle** | All characters idle at night | Everyone clusters on the sofa; one character stays up as night watch |

---

## Parallax Room & Day/Night Cycle

- **4 parallax layers** (sky window / wall / workzone / floor) lerp toward the pointer at
  different depth scales for a diorama effect.
- **Real day/night cycle** follows the local clock: sun/moon arc across the sky window,
  crossfading sky gradient, 20 twinkling stars at night, and a clickable warm lamp.
- Wall posters use the service logos.

---

## Ambient Canvas

`AmbientCanvas.tsx` is a DPR-capped 30fps canvas overlay (unmounted entirely under
`prefers-reduced-motion`):

- **Dust motes**: 35 drifting particles; they become fireflies at night.
- **Data rain**: Matrix-style glyph rain behind workstations whose service is actively used.
- **`burst()` pool**: Pooled particle API for crumbs (cookies), hearts (petting),
  confetti (PAYDAY), and steam (overheating desks).

---

## Visual Environment

### Room
- Dark background (`#0c0c0c`) with inset shadow
- Rounded corners (12px border-radius)
- CRT scanline overlay (4px striped pattern) for retro aesthetic

### Workzone (Top)
- Blue gradient overlay (rgba(0, 100, 255, 0.15) fading down)
- **Energy Barrier**: 4px pulsing blue line at bottom edge (`barrierPulse` 1.5s)
- **Scrolling Grid**: 40px grid pattern animating diagonally (`gridScroll` 20s)
- **Top Glow Line**: Bright blue horizontal glow (`glowPulse` 3s)
- **Label**: "WORKZONE" with count badge showing number of active workers

### Individual Workstations
Each character has a personal workstation inside the workzone:
- **Monitor**: 50x36px dark box (`#111`) with 3px solid `#333` border, green glow when active (`monitorFlicker` 4s)
- **Desk**: 65x14px gray gradient with 2px `#444` border, two leg supports via `::before`/`::after` pseudo-elements
- **Station Label**: Character name below desk in mono font, glows blue when active
- **Inactive state**: Entire workstation at 35% opacity
- **Active state**: Full opacity with monitor glow and illuminated label

---

## CSS Performance

### Hardware Acceleration
- `will-change: transform` on character containers
- Animations use only `transform` and `opacity` (compositor-only properties)
- `transform-origin` and `transform-box: fill-box` for precise SVG transformations

### SVG Eye Fix
All eye elements use `transform-box: fill-box` to prevent eyes from flying out during squash/stretch animations:
```css
.claude-eye, .kimi-box-eye, .kimi-sphere-eye, .mm-eye, .rw-eye, .fal-eye {
    transform-box: fill-box;
    transform-origin: center;
}
```

---

## Design Tokens

The app uses the "Warm Instrument" palette (see `global.css` `:root`); the aigotchi room
inherits these variables:

```css
--bg-0: #0d0c0a              /* deepest surface */
--bg-2: #1a1715              /* room panel */
--text-1: #f0ebe1
--text-2: #a89e8e
--accent: #e2a04a            /* honey amber */
--ok: #84a878                /* sage */
--warn: #d9a441              /* amber */
--danger: #cf6f5c            /* terracotta */
--border: rgba(237, 228, 214, .08)
--font-mono: 'Fira Code', monospace stack
```

### Character Colors
| Character | Primary | Exhausted |
|-----------|---------|-----------|
| Codex | `#10a37f` (green stroke) | hue-rotate(-60deg) saturate(2) |
| Claude | `#b87352` (brown fill) | rotate(10deg) scaleY(0.9) |
| Kimi | `#4a8eff` (blue) | `#6b9fff` (desaturated) |
| MiniMax | `#fff` (white body, `#ccc` border) | `#ff9ca8` (red bg overheat) |
