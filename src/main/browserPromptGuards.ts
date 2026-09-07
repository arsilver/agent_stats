import type { BrowserWindow } from 'electron'

type CdpCommandSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>

interface WebAuthnBlockerInstallOptions {
  timeoutMs?: number
}

const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 1500

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  void promise.catch(() => undefined)

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function sendCdpCommandWithTimeout(
  sendCommand: CdpCommandSender,
  method: string,
  params: Record<string, unknown> | undefined,
  label: string,
  timeoutMs: number
): Promise<unknown> {
  const command = params === undefined ? sendCommand(method) : sendCommand(method, params)
  return withTimeout(command, timeoutMs, `${label} ${method}`)
}

export const WEB_AUTHN_BLOCKER_SCRIPT = String.raw`
(() => {
  const FLAG = '__agentStatsWebAuthnBlockerInstalled';
  const root = globalThis;
  if (root[FLAG]) return;

  try {
    Object.defineProperty(root, FLAG, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });
  } catch {
    root[FLAG] = true;
  }

  const blockMessage = 'WebAuthn passkey prompts are disabled in Agent Stats browser sessions.';
  const makeNotAllowedError = () => {
    try {
      return new DOMException(blockMessage, 'NotAllowedError');
    } catch {
      const err = new Error(blockMessage);
      err.name = 'NotAllowedError';
      return err;
    }
  };

  const isPublicKeyCredentialRequest = (options) => {
    return !!(
      options &&
      typeof options === 'object' &&
      Object.prototype.hasOwnProperty.call(options, 'publicKey') &&
      options.publicKey
    );
  };

  const credentials = navigator && navigator.credentials;
  if (credentials && typeof credentials.get === 'function' && !credentials.get.__agentStatsWebAuthnBlocked) {
    const originalGet = credentials.get.bind(credentials);
    const patchedGet = function(options) {
      if (isPublicKeyCredentialRequest(options)) {
        return Promise.reject(makeNotAllowedError());
      }
      return originalGet(options);
    };
    Object.defineProperty(patchedGet, '__agentStatsWebAuthnBlocked', { value: true });
    Object.defineProperty(credentials, 'get', {
      value: patchedGet,
      configurable: true,
      writable: true
    });
  }

  if (credentials && typeof credentials.create === 'function' && !credentials.create.__agentStatsWebAuthnBlocked) {
    const originalCreate = credentials.create.bind(credentials);
    const patchedCreate = function(options) {
      if (isPublicKeyCredentialRequest(options)) {
        return Promise.reject(makeNotAllowedError());
      }
      return originalCreate(options);
    };
    Object.defineProperty(patchedCreate, '__agentStatsWebAuthnBlocked', { value: true });
    Object.defineProperty(credentials, 'create', {
      value: patchedCreate,
      configurable: true,
      writable: true
    });
  }

  const publicKeyCredential = root.PublicKeyCredential;
  if (publicKeyCredential) {
    if (typeof publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      Object.defineProperty(publicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', {
        value: () => Promise.resolve(false),
        configurable: true,
        writable: true
      });
    }
    if (typeof publicKeyCredential.isConditionalMediationAvailable === 'function') {
      Object.defineProperty(publicKeyCredential, 'isConditionalMediationAvailable', {
        value: () => Promise.resolve(false),
        configurable: true,
        writable: true
      });
    }
  }
})();
`

export async function installWebAuthnBlockerWithCdp(
  sendCommand: CdpCommandSender,
  label: string,
  options: WebAuthnBlockerInstallOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS

  try {
    await sendCdpCommandWithTimeout(sendCommand, 'Page.enable', undefined, label, timeoutMs)
      .catch(() => undefined)
    await sendCdpCommandWithTimeout(
      sendCommand,
      'Page.addScriptToEvaluateOnNewDocument',
      { source: WEB_AUTHN_BLOCKER_SCRIPT },
      label,
      timeoutMs
    )

    await sendCdpCommandWithTimeout(
      sendCommand,
      'Runtime.evaluate',
      {
        expression: WEB_AUTHN_BLOCKER_SCRIPT,
        awaitPromise: true,
        returnByValue: true
      },
      label,
      timeoutMs
    ).catch(() => undefined)

    await sendCdpCommandWithTimeout(
      sendCommand,
      'WebAuthn.enable',
      { enableUI: false },
      label,
      timeoutMs
    ).catch(() => undefined)
  } catch (err) {
    console.warn(`[${label}] Failed to install WebAuthn passkey prompt guard:`, err)
  }
}

export async function installWebAuthnBlockerInWindow(
  win: BrowserWindow,
  label: string,
  options: WebAuthnBlockerInstallOptions = {}
): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return

  try {
    const { debugger: debugSession } = win.webContents
    if (!debugSession.isAttached()) {
      debugSession.attach('1.3')
    }

    await installWebAuthnBlockerWithCdp(
      (method, params) => debugSession.sendCommand(method, params),
      label,
      options
    )
  } catch (err) {
    console.warn(`[${label}] Failed to attach WebAuthn passkey prompt guard:`, err)
  }
}
