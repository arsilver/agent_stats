import { existsSync } from 'fs'
import { join } from 'path'
import type { ScrapedUsageData } from './baseScraper'

interface ProtoField {
  field: number
  wireType: number
  value: number | Buffer
}

interface AntigravityQuotaRow {
  name: string
  usedPercent: number
  resetsAt: string | null
}

interface SQLiteStatement {
  get(...params: unknown[]): { value?: string | Buffer } | undefined
}

interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement
  close(): void
}

function readVarint(buffer: Buffer, start: number): { value: number; offset: number } {
  let value = 0
  let multiplier = 1
  let offset = start

  while (offset < buffer.length) {
    const byte = buffer[offset]
    offset += 1
    value += (byte & 0x7f) * multiplier

    if ((byte & 0x80) === 0) {
      return { value, offset }
    }

    multiplier *= 128
    if (multiplier > Number.MAX_SAFE_INTEGER / 128) break
  }

  throw new Error('Invalid protobuf varint')
}

function parseFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0

  while (offset < buffer.length) {
    const key = readVarint(buffer, offset)
    offset = key.offset
    const field = Math.floor(key.value / 8)
    const wireType = key.value % 8

    if (field <= 0) throw new Error('Invalid protobuf field')

    if (wireType === 0) {
      const parsed = readVarint(buffer, offset)
      offset = parsed.offset
      fields.push({ field, wireType, value: parsed.value })
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error('Invalid fixed64 field')
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + 8) })
      offset += 8
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset)
      offset = length.offset
      if (offset + length.value > buffer.length) throw new Error('Invalid length-delimited field')
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + length.value) })
      offset += length.value
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error('Invalid fixed32 field')
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + 4) })
      offset += 4
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`)
    }
  }

  return fields
}

function getLengthFields(buffer: Buffer, fieldNumber: number): Buffer[] {
  try {
    return parseFields(buffer)
      .filter((field) => field.field === fieldNumber && field.wireType === 2 && Buffer.isBuffer(field.value))
      .map((field) => field.value as Buffer)
  } catch {
    return []
  }
}

function getFirstStringField(buffer: Buffer, fieldNumber: number): string | null {
  const field = getLengthFields(buffer, fieldNumber)[0]
  if (!field) return null

  const value = field.toString('utf8').replace(/\0/g, '').trim()
  return value || null
}

function looksLikeBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, '')
  return normalized.length >= 24 && normalized.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
}

function decodeBase64(value: string): Buffer | null {
  const normalized = value.replace(/\s+/g, '')
  if (!looksLikeBase64(normalized)) return null

  try {
    return Buffer.from(normalized + '='.repeat((4 - (normalized.length % 4)) % 4), 'base64')
  } catch {
    return null
  }
}

function collectDecodedStateCandidates(stateValue: string | Buffer): Buffer[] {
  const rawText = Buffer.isBuffer(stateValue) ? stateValue.toString('utf8') : stateValue
  const outer = decodeBase64(rawText)
  if (!outer) return []

  const candidates: Buffer[] = [outer]
  const queue: Buffer[] = [outer]
  const seen = new Set<string>([outer.toString('base64')])

  while (queue.length > 0 && candidates.length < 20) {
    const current = queue.shift()
    if (!current) continue

    let fields: ProtoField[]
    try {
      fields = parseFields(current)
    } catch {
      continue
    }

    for (const field of fields) {
      if (field.wireType !== 2 || !Buffer.isBuffer(field.value)) continue

      const rawKey = field.value.toString('base64')
      if (!seen.has(rawKey)) {
        seen.add(rawKey)
        queue.push(field.value)
      }

      const text = field.value.toString('utf8').trim()
      const decoded = decodeBase64(text)
      if (decoded) {
        const decodedKey = decoded.toString('base64')
        if (seen.has(decodedKey)) continue
        seen.add(decodedKey)
        candidates.push(decoded)
        queue.push(decoded)
      }
    }
  }

  return candidates
}

function readQuota(modelMessage: Buffer): { usedPercent: number; resetsAt: string | null } | null {
  const quotaMessage = getLengthFields(modelMessage, 15)[0]
  if (!quotaMessage) return null

  let availableFraction: number | null = null
  let resetUnixSeconds: number | null = null

  for (const field of parseFields(quotaMessage)) {
    if (field.field === 1 && field.wireType === 5 && Buffer.isBuffer(field.value)) {
      availableFraction = field.value.readFloatLE(0)
    }

    if (field.field === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      for (const resetField of parseFields(field.value)) {
        if (resetField.field === 1 && resetField.wireType === 0 && typeof resetField.value === 'number') {
          resetUnixSeconds = resetField.value
        }
      }
    }
  }

  if (availableFraction === null || !Number.isFinite(availableFraction)) return null

  const clampedAvailable = Math.min(1, Math.max(0, availableFraction))
  const usedPercent = Math.round((1 - clampedAvailable) * 100)
  const resetsAt =
    resetUnixSeconds && Number.isFinite(resetUnixSeconds)
      ? new Date(resetUnixSeconds * 1000).toISOString()
      : null

  return { usedPercent, resetsAt }
}

function extractRowsFromUserStatusPayload(payload: Buffer): AntigravityQuotaRow[] {
  const modelContainers = getLengthFields(payload, 33)
  const rows: AntigravityQuotaRow[] = []

  for (const container of modelContainers) {
    const modelMessages = getLengthFields(container, 1)

    for (const modelMessage of modelMessages) {
      const name = getFirstStringField(modelMessage, 1)
      if (!name || !/^Gemini\b/i.test(name)) continue

      const quota = readQuota(modelMessage)
      if (!quota) continue

      rows.push({
        name,
        usedPercent: quota.usedPercent,
        resetsAt: quota.resetsAt
      })
    }
  }

  return rows
}

export function parseAntigravityGeminiUsageFromStateValue(
  stateValue: string | Buffer
): ScrapedUsageData | null {
  const candidates = collectDecodedStateCandidates(stateValue)
  const rows = candidates.flatMap((candidate) => extractRowsFromUserStatusPayload(candidate))

  if (rows.length === 0) return null

  const subModels = rows
    .sort((a, b) => b.usedPercent - a.usedPercent)
    .map((row) => ({
      name: row.name,
      count: row.usedPercent,
      total: 100,
      resetsAt: row.resetsAt
    }))

  const primary = subModels[0]

  return {
    currentUsage: primary.count ?? 0,
    usageLimit: 100,
    percentUsed: primary.count ?? 0,
    usageUnit: '% quota used',
    resetsAt: primary.resetsAt ?? null,
    weeklyUsage: null,
    weeklyLimit: null,
    weeklyPercentUsed: null,
    renewalDate: null,
    renewalKind: null,
    detectedPlanTier: 'Antigravity',
    subModels
  }
}

export function getDefaultAntigravityStateDbPath(): string | null {
  const appData = process.env.APPDATA
  if (!appData) return null

  return join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
}

export function readAntigravityGeminiUsageFromDisk(
  dbPath = getDefaultAntigravityStateDbPath()
): ScrapedUsageData | null {
  if (!dbPath || !existsSync(dbPath)) {
    throw new Error('Antigravity state database was not found. Open and sign into Antigravity, then refresh.')
  }

  const Database = require('better-sqlite3') as new (
    path: string,
    options: { readonly: boolean; fileMustExist: boolean }
  ) => SQLiteDatabase

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('select value from ItemTable where key = ?')
      .get('antigravityUnifiedStateSync.userStatus')

    if (!row?.value) {
      throw new Error('Antigravity is not signed in yet. Open Antigravity, sign in, then refresh.')
    }

    const usage = parseAntigravityGeminiUsageFromStateValue(row.value)
    if (!usage) {
      throw new Error('Antigravity quota data was not available yet. Open Settings > Models in Antigravity, then refresh.')
    }

    return usage
  } finally {
    db.close()
  }
}
