const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const guardPath = path.join(root, 'src', 'main', 'browserPromptGuards.ts')

if (!fs.existsSync(guardPath)) {
  throw new Error(`Missing browser prompt guard module: ${guardPath}`)
}

const source = fs.readFileSync(guardPath, 'utf8')
const match = source.match(/export const WEB_AUTHN_BLOCKER_SCRIPT = String\.raw`([\s\S]*?)`\s*(?:\n|$)/)

if (!match) {
  throw new Error('WEB_AUTHN_BLOCKER_SCRIPT export was not found')
}

const script = match[1]

class FakeDOMException extends Error {
  constructor(message, name) {
    super(message)
    this.name = name
  }
}

async function assertRejectsNotAllowed(promise, label) {
  try {
    await promise
  } catch (err) {
    assert.strictEqual(err.name, 'NotAllowedError', `${label} should reject with NotAllowedError`)
    return
  }

  throw new Error(`${label} unexpectedly resolved`)
}

async function main() {
  let getCalls = 0
  let createCalls = 0

  const context = {
    DOMException: FakeDOMException,
    console,
    window: {},
    navigator: {
      credentials: {
        get: async () => {
          getCalls += 1
          return { type: 'password' }
        },
        create: async () => {
          createCalls += 1
          return { type: 'password' }
        }
      }
    },
    PublicKeyCredential: {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      isConditionalMediationAvailable: async () => true
    }
  }
  context.window.navigator = context.navigator
  context.window.PublicKeyCredential = context.PublicKeyCredential

  vm.runInNewContext(script, context)
  vm.runInNewContext(script, context)

  await assertRejectsNotAllowed(
    context.navigator.credentials.get({ publicKey: { challenge: 'abc' } }),
    'navigator.credentials.get(publicKey)'
  )
  await assertRejectsNotAllowed(
    context.navigator.credentials.create({ publicKey: { challenge: 'abc' } }),
    'navigator.credentials.create(publicKey)'
  )

  assert.deepStrictEqual(
    await context.navigator.credentials.get({ password: true }),
    { type: 'password' },
    'non-WebAuthn get requests should delegate to the original implementation'
  )
  assert.deepStrictEqual(
    await context.navigator.credentials.create({ password: true }),
    { type: 'password' },
    'non-WebAuthn create requests should delegate to the original implementation'
  )

  assert.strictEqual(getCalls, 1, 'publicKey get requests should not reach the original implementation')
  assert.strictEqual(createCalls, 1, 'publicKey create requests should not reach the original implementation')
  assert.strictEqual(
    await context.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
    false,
    'platform authenticator availability should be suppressed'
  )
  assert.strictEqual(
    await context.PublicKeyCredential.isConditionalMediationAvailable(),
    false,
    'conditional mediation availability should be suppressed'
  )

  console.log('WebAuthn guard smoke test passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
