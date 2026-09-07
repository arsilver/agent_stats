import { ipcMain, app } from 'electron'
import * as keytar from 'keytar'
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const SERVICE_NAME = 'AgentStats'
const KEYCHAIN_ACCOUNT = 'master-encryption-key'

class SimpleEncryptedStore {
  private path: string;
  private key: Buffer;
  private data: any = {};

  constructor(name: string, hexKey: string) {
    this.path = join(app.getPath('userData'), `${name}.json`);
    this.key = Buffer.from(hexKey, 'hex');
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) {
      this.data = {};
      return;
    }
    try {
      const encrypted = readFileSync(this.path, 'utf8');
      if (!encrypted) return;

      const [ivHex, authTagHex, contentHex] = encrypted.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(contentHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      this.data = JSON.parse(decrypted);
    } catch (e) {
      console.error('Failed to decrypt store:', e);
      this.data = {};
    }
  }

  private save() {
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const text = JSON.stringify(this.data);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();

      writeFileSync(this.path, `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`, 'utf8');
    } catch (e) {
      console.error('Failed to save store:', e);
    }
  }

  get(keyPath: string): any {
    const parts = keyPath.split('.');
    let obj = this.data;
    for (const p of parts) {
      if (obj === undefined || obj === null) return undefined;
      obj = obj[p];
    }
    return obj;
  }

  set(keyPath: string, value: any) {
    const parts = keyPath.split('.');
    const last = parts.pop()!;
    let obj = this.data;
    for (const p of parts) {
      if (!obj[p] || typeof obj[p] !== 'object') obj[p] = {};
      obj = obj[p];
    }
    obj[last] = value;
    this.save();
  }

  delete(keyPath: string) {
    const parts = keyPath.split('.');
    const last = parts.pop()!;
    let obj = this.data;
    for (const p of parts) {
      if (!obj[p] || typeof obj[p] !== 'object') return;
      obj = obj[p];
    }
    delete obj[last];
    this.save();
  }
}

let encryptedStore: SimpleEncryptedStore | null = null

/**
 * Get or generate the master encryption key from the OS keychain.
 * On Windows this uses Windows Credential Manager.
 * The key never touches disk — only the OS keychain.
 */
async function getMasterKey(): Promise<string> {
  let key = await keytar.getPassword(SERVICE_NAME, KEYCHAIN_ACCOUNT)

  if (!key) {
    // First run: generate a random 256-bit key and store it in the OS keychain
    key = randomBytes(32).toString('hex')
    await keytar.setPassword(SERVICE_NAME, KEYCHAIN_ACCOUNT, key)
  }

  return key
}

/**
 * Initialize the encrypted store with the master key from OS keychain.
 */
async function getStore(): Promise<SimpleEncryptedStore> {
  if (encryptedStore) return encryptedStore

  const masterKey = await getMasterKey()

  encryptedStore = new SimpleEncryptedStore('agent-stats-credentials', masterKey)

  return encryptedStore
}

/**
 * Mask a credential value for display: "sk-abc...xyz"
 */
function maskValue(value: string): string {
  if (!value || value.length < 8) return '****'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

// ─── ENV Fallback ────────────────────────────────────────────
const ENV_KEY_MAP: Record<string, string> = {
  chatgpt: 'CHATGPT_API_KEY',
  claude: 'CLAUDE_API_KEY',
  'kimi-code': 'KIMI_CODE_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  runwayml: 'RUNWAYML_API_KEY',
  'fal-ai': 'FAL_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
}

const PUBLIC_VALUE_KEYS = new Set(['renewalDate'])

function getEnvFallback(service: string): string | null {
  const envKey = ENV_KEY_MAP[service]
  if (!envKey) return null
  const value = process.env[envKey]
  return value && value.trim() !== '' ? value : null
}

// ─── IPC Handlers ────────────────────────────────────────────

/**
 * Internal helper to retrieve a credential without IPC overhead.
 */
export async function getCredentialInternal(service: string, key: string): Promise<string | null> {
  const store = await getStore()
  const stored = store.get(`credentials.${service}.${key}`) as string | undefined

  if (stored) return stored

  // Fallback to .env for api_key only
  if (key === 'api_key') {
    return getEnvFallback(service)
  }

  return null
}

export function registerCredentialHandlers(): void {

  /**
   * Retrieve a credential. Falls back to .env if not in encrypted store.
   */
  ipcMain.handle(
    'credentials:get',
    async (_event, service: string, key: string) => {
      return getCredentialInternal(service, key)
    }
  )

  /**
   * Retrieve a non-secret user preference stored alongside credentials.
   * This keeps raw secret reads out of the renderer while preserving small
   * per-service UI overrides such as renewal dates.
   */
  ipcMain.handle(
    'credentials:getPublicValue',
    async (_event, service: string, key: string) => {
      if (!PUBLIC_VALUE_KEYS.has(key)) return null
      const store = await getStore()
      return (store.get(`credentials.${service}.${key}`) as string | undefined) ?? null
    }
  )

  /**
   * Set a credential.
   */
  ipcMain.handle(
    'credentials:set',
    async (_event, service: string, key: string, value: string) => {
      const store = await getStore()
      store.set(`credentials.${service}.${key}`, value)
      return { success: true }
    }
  )

  /**
   * Delete a credential.
   */
  ipcMain.handle(
    'credentials:delete',
    async (_event, service: string, key: string) => {
      const store = await getStore()
      store.delete(`credentials.${service}.${key}` as any)
      return { success: true }
    }
  )

  /**
   * List all configured services with masked credential values.
   */
  ipcMain.handle('credentials:list', async () => {
    const store = await getStore()
    const credentials = (store.get('credentials') || {}) as Record<
      string,
      Record<string, string>
    >

    const result: Array<{
      service: string
      keys: Array<{ key: string; masked: string }>
    }> = []

    // Include stored credentials
    for (const [service, keys] of Object.entries(credentials)) {
      const keyList = Object.entries(keys).map(([k, v]) => ({
        key: k,
        masked: maskValue(v as string)
      }))
      result.push({ service, keys: keyList })
    }

    // Include .env fallbacks that aren't in the store
    for (const [service, envKey] of Object.entries(ENV_KEY_MAP)) {
      const envValue = process.env[envKey]
      if (envValue && envValue.trim() !== '') {
        const existing = result.find((r) => r.service === service)
        if (!existing) {
          result.push({
            service,
            keys: [{ key: 'api_key', masked: maskValue(envValue) }]
          })
        }
      }
    }

    return result
  })
}
