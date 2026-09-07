import { copyFileSync, existsSync, unlinkSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { ScrapedUsageData } from './baseScraper'
import { parseCursorPeriodUsageJson, parseGrokBotSandJson, type GrokBotSandParse } from './usageTextParsers'

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType'
const SUB_STATUS_KEY = 'cursorAuth/stripeSubscriptionStatus'
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const SAND_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const TOKEN_CACHE_MS = 30 * 60 * 1000
const SAND_TIMEOUT_MS = 5000

export type GrokBotSandFetch = GrokBotSandParse | { kind: 'miss' }

let cachedAccessToken: { value: string; at: number } | null = null

function cursorStateDbPath(): string | null {
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(roaming, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

function readStateValueFromPath(dbPath: string, key: string): string | null {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 8000 })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value?: unknown } | undefined
    return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

async function readCursorStateValue(key: string): Promise<string | null> {
  const dbPath = cursorStateDbPath()
  if (!dbPath) {
    console.log('[cursor] IDE state.vscdb not found')
    return null
  }
  const label = key.slice(key.lastIndexOf('/') + 1)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Plain readonly path works under Electron while Cursor has the 1.8GB
      // DB open. file:?mode=ro URIs fail to open on Windows better-sqlite3.
      return readStateValueFromPath(dbPath, key)
    } catch (err) {
      const message = (err as Error).message || ''
      if (/busy|locked/i.test(message) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        continue
      }
      console.log(`[cursor] IDE state read failed (${label}): ${message}`)
      break
    }
  }

  const tmpPath = join(tmpdir(), `agent-stats-cursor-state-${process.pid}.vscdb`)
  try {
    copyFileSync(dbPath, tmpPath)
    const copied = readStateValueFromPath(tmpPath, key)
    if (copied) console.log(`[cursor] IDE state read via temp copy (${label})`)
    return copied
  } catch (err) {
    console.log(`[cursor] IDE state copy-read failed (${label}): ${(err as Error).message}`)
    return null
  } finally {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

async function readAccessToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedAccessToken && Date.now() - cachedAccessToken.at < TOKEN_CACHE_MS) {
    return cachedAccessToken.value
  }
  const token = await readCursorStateValue(ACCESS_TOKEN_KEY)
  if (token) cachedAccessToken = { value: token, at: Date.now() }
  return token
}

function formatMembership(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (/pro\s*\+|pro[_\s-]?plus/i.test(s)) return 'Pro+'
  if (/ultra/i.test(s)) return 'Ultra'
  if (/^pro$/i.test(s)) return 'Pro'
  if (/business|teams?/i.test(s)) return 'Business'
  if (/enterprise/i.test(s)) return 'Enterprise'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function renewalKindFromStatus(status: string | null): 'renewing' | 'cancelled' | null {
  if (!status) return null
  if (/cancel/i.test(status)) return 'cancelled'
  if (/active|trialing|past_due|unpaid/i.test(status)) return 'renewing'
  return null
}

async function postPeriodUsage(token: string): Promise<unknown | null> {
  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      },
      body: '{}'
    })
  } catch (err) {
    console.log(`[cursor] GetCurrentPeriodUsage network error: ${(err as Error).message}`)
    return null
  }

  if (!response.ok) {
    console.log(`[cursor] GetCurrentPeriodUsage returned ${response.status}`)
    if (response.status === 401 || response.status === 403) cachedAccessToken = null
    return null
  }

  try {
    return await response.json()
  } catch (err) {
    console.log(`[cursor] GetCurrentPeriodUsage JSON parse failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Same source as Cursor Settings → Plan & Usage. Reads the IDE access token
 * from state.vscdb (never logged) and calls GetCurrentPeriodUsage.
 */
export async function fetchCursorUsageFromIde(): Promise<ScrapedUsageData | null> {
  let token = await readAccessToken()
  if (!token) {
    console.log('[cursor] No IDE access token — cannot use Plan & Usage API')
    return null
  }

  let json = await postPeriodUsage(token)
  if (!json) {
    token = await readAccessToken(true)
    if (!token) return null
    json = await postPeriodUsage(token)
  }
  if (!json) return null

  const parsed = parseCursorPeriodUsageJson(json)
  if (!parsed || parsed.totalPercent == null) {
    console.log('[cursor] GetCurrentPeriodUsage response had no planUsage.totalPercentUsed')
    return null
  }

  const membership = formatMembership(await readCursorStateValue(MEMBERSHIP_KEY))
  const statusKind = renewalKindFromStatus(await readCursorStateValue(SUB_STATUS_KEY))
  if (membership) parsed.detectedPlanTier = membership
  if (statusKind) parsed.renewalKind = statusKind

  const cursorModels = parsed.subModels?.find((row) => row.name === 'Cursor Models')?.count
  console.log(
    `[cursor] IDE API: total=${parsed.totalPercent}%, cursorModels=${cursorModels}%, ` +
    `otherModels=${parsed.weeklyPercentUsed}%, plan=${parsed.detectedPlanTier}, ` +
    `renewal=${parsed.renewalDate} (${parsed.renewalKind ?? 'none'})`
  )
  return parsed
}

/** Same RPC as the website; used when managed Chrome cannot start. */
export async function refreshCursorUsage(): Promise<ScrapedUsageData | null> {
  const parsed = await fetchCursorUsageFromIde()
  if (!parsed || parsed.totalPercent == null) return null
  if (!parsed.renewalKind && parsed.renewalDate) parsed.renewalKind = 'renewing'
  return Object.assign(parsed, { cursorFetchSource: 'ide-api' as const })
}

async function postSandUsage(token: string): Promise<unknown | null> {
  let response: Response
  try {
    response = await fetch(SAND_USAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      },
      body: '{}',
      signal: AbortSignal.timeout(SAND_TIMEOUT_MS)
    })
  } catch (err) {
    console.log(`[grok] GetSandUsageStatus network error: ${(err as Error).message}`)
    return null
  }

  if (!response.ok) {
    console.log(`[grok] GetSandUsageStatus returned ${response.status}`)
    if (response.status === 401 || response.status === 403) cachedAccessToken = null
    return null
  }

  try {
    return await response.json()
  } catch (err) {
    console.log(`[grok] GetSandUsageStatus JSON parse failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Grok Bot weekly included allowance on the Cursor account (Sand).
 * Same IDE token as GetCurrentPeriodUsage. Fail-soft: miss never throws.
 */
export async function fetchGrokBotSandFromIde(): Promise<GrokBotSandFetch> {
  let token = await readAccessToken()
  if (!token) {
    console.log('[grok] No IDE access token — cannot read Grok Bot Sand usage')
    return { kind: 'miss' }
  }

  let json = await postSandUsage(token)
  if (!json) {
    token = await readAccessToken(true)
    if (!token) return { kind: 'miss' }
    json = await postSandUsage(token)
  }
  if (!json) return { kind: 'miss' }

  const parsed = parseGrokBotSandJson(json)
  if (!parsed) {
    console.log('[grok] GetSandUsageStatus response had no usable Grok Bot fields')
    return { kind: 'miss' }
  }
  return parsed
}
