const assert = require('assert')
const esbuild = require('esbuild')

require.extensions['.ts'] = function loadTs(module, filename) {
  const fs = require('fs')
  const source = fs.readFileSync(filename, 'utf8')
  const output = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18'
  })
  module._compile(output.code, filename)
}

const {
  parseGeminiUsageText,
  parseHiggsfieldUsageText,
  parseCursorUsageText,
  parseCursorPeriodUsageJson,
  mergeCursorDomWithApi,
  parseKimiMembershipText,
  parseClaudeUsageText,
  parseClaudeResetTime,
  parseChatgptUsageText,
  parseGrokUsageDialogText,
  parseGrokBotSandJson,
  parseGeminiWebUsageText,
  parseQwenSubscriptionText,
  parseQwenUsageJson,
  qwenStructuredParseIsIncomplete
} = require('../src/main/scrapers/usageTextParsers.ts')
const {
  parseRenewalDate,
  parseRenewalFromJson
} = require('../src/main/scrapers/baseScraper.ts')
const {
  parseAntigravityGeminiUsageFromStateValue
} = require('./antigravityQuotaReader.ts')

function encodeVarint(value) {
  const bytes = []
  let n = value >>> 0
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  bytes.push(n)
  return Buffer.from(bytes)
}

function encodeKey(field, wireType) {
  return encodeVarint((field << 3) | wireType)
}

function encodeLengthDelimited(field, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  return Buffer.concat([encodeKey(field, 2), encodeVarint(body.length), body])
}

function encodeFixed32(field, value) {
  const body = Buffer.alloc(4)
  body.writeFloatLE(value, 0)
  return Buffer.concat([encodeKey(field, 5), body])
}

function encodeAntigravityModel(name, availableFraction, resetUnixSeconds) {
  const reset = Buffer.concat([
    encodeKey(1, 0),
    encodeVarint(resetUnixSeconds)
  ])
  const quota = Buffer.concat([
    encodeFixed32(1, availableFraction),
    encodeLengthDelimited(2, reset)
  ])
  return encodeLengthDelimited(1, Buffer.concat([
    encodeLengthDelimited(1, name),
    encodeLengthDelimited(15, quota)
  ]))
}

function makeAntigravityUserStatusValue(models) {
  const modelContainer = Buffer.concat(models)
  const innerUserStatus = Buffer.concat([
    encodeLengthDelimited(3, 'Michi Ubis'),
    encodeLengthDelimited(33, modelContainer)
  ])
  const outerState = Buffer.concat([
    encodeLengthDelimited(1, 'userStatusSentinelKey'),
    encodeLengthDelimited(2, innerUserStatus.toString('base64'))
  ])
  return outerState.toString('base64')
}

function testGeminiRateLimitTable() {
  const sample = `
Google AI Studio
Gemini API Rate Limit Free tier
Project openclaw
Time Range 28 Days
Rate limits by model
Peak usage per model compared to its limit over the last 28 days
Model Category RPM TPM
Gemini 2.5 Flash Text-out models 0 / 5 0 / 250K
Gemini 2.5 Pro Text-out models 0 / 0 0 / 0
Gemini 2 Flash Text-out models 2 / 15 1.2K / 1M
Gemini 2 Flash Lite Text-out models 1 / 30 0 / 1M
Gemini 2.5 Flash TTS Multi-modal generative models 0 / 3 0 / 10K
`

  const parsed = parseGeminiUsageText(sample)

  assert(parsed, 'expected Gemini parser to return usage data')
  assert.strictEqual(parsed.detectedPlanTier, 'Free')
  assert.strictEqual(parsed.currentUsage, 2)
  assert.strictEqual(parsed.usageLimit, 15)
  assert.strictEqual(parsed.percentUsed, 13)
  assert.strictEqual(parsed.usageUnit, 'rate limits')
  assert(parsed.subModels.length >= 3, 'expected Gemini submodels for visible rate-limit rows')
  assert.deepStrictEqual(parsed.subModels[0], {
    name: 'Gemini 2 Flash RPM',
    count: 2,
    total: 15
  })
}

function testGeminiDoesNotTruncateModelRows() {
  const sample = `
Gemini API Rate Limit Free tier
Gemini 2.5 Flash Text-out models 1 / 10 0 / 1M
Gemini 2.5 Pro Text-out models 2 / 10 0 / 1M
Gemini 2 Flash Text-out models 3 / 10 0 / 1M
Gemini 2 Flash Lite Text-out models 4 / 10 0 / 1M
Gemini 1.5 Flash Text-out models 5 / 10 0 / 1M
Gemini 1.5 Pro Text-out models 6 / 10 0 / 1M
`

  const parsed = parseGeminiUsageText(sample)
  assert(parsed, 'expected Gemini parser to return usage data')
  assert(parsed.subModels.length >= 6, 'expected Gemini parser to keep all visible model rows')
}

function testHiggsfieldRemainingCreditsOnly() {
  const sample = `
Higgsfield
Profile
Pro plan
Credits
850 credits
Subscription active
Renews May 26, 2026
`

  const parsed = parseHiggsfieldUsageText(sample)

  assert(parsed, 'expected Higgsfield parser to return usage data')
  assert.strictEqual(parsed.detectedPlanTier, 'Pro')
  assert.strictEqual(parsed.currentUsage, 850)
  assert.strictEqual(parsed.usageLimit, null)
  assert.strictEqual(parsed.percentUsed, null)
  assert.strictEqual(parsed.usageUnit, 'credits')
  assert.strictEqual(parsed.renewalDate, '2026-05-26')
}

function testHiggsfieldRemainingAndTotalCredits() {
  const sample = `
Account
Creator
Credits remaining
850 of 1000 credits
Next billing date June 1, 2026
`

  const parsed = parseHiggsfieldUsageText(sample)

  assert(parsed, 'expected Higgsfield parser to return usage data')
  assert.strictEqual(parsed.detectedPlanTier, 'Creator')
  assert.strictEqual(parsed.currentUsage, 150)
  assert.strictEqual(parsed.usageLimit, 1000)
  assert.strictEqual(parsed.percentUsed, 15)
  assert.strictEqual(parsed.renewalDate, '2026-06-01')
}

function testAntigravityGeminiQuotaPayload() {
  const stateValue = makeAntigravityUserStatusValue([
    encodeAntigravityModel('Gemini 3.1 Pro (High)', 0.2, 1778103347),
    encodeAntigravityModel('Gemini 3 Flash', 1.0, 1777610872),
    encodeAntigravityModel('Claude Sonnet 4.6 (Thinking)', 0.0, 1777748018)
  ])

  const parsed = parseAntigravityGeminiUsageFromStateValue(stateValue)

  assert(parsed, 'expected Antigravity parser to return Gemini usage data')
  assert.strictEqual(parsed.detectedPlanTier, 'Antigravity')
  assert.strictEqual(parsed.currentUsage, 80)
  assert.strictEqual(parsed.usageLimit, 100)
  assert.strictEqual(parsed.percentUsed, 80)
  assert.strictEqual(parsed.usageUnit, '% quota used')
  assert.strictEqual(parsed.resetsAt, '2026-05-06T21:35:47.000Z')
  assert.deepStrictEqual(parsed.subModels, [
    {
      name: 'Gemini 3.1 Pro (High)',
      count: 80,
      total: 100,
      resetsAt: '2026-05-06T21:35:47.000Z'
    },
    {
      name: 'Gemini 3 Flash',
      count: 0,
      total: 100,
      resetsAt: '2026-05-01T04:47:52.000Z'
    }
  ])
}

function testHiggsfieldCreditsAvailablePhrase() {
  const sample = `
Higgsfield
Michi Ubis
Plus Plan
1010 credits available
Top-up credits Buy
87% discount on Welcome Bundle
Claim Discount
`

  const parsed = parseHiggsfieldUsageText(sample)

  assert(parsed, 'expected Higgsfield parser to read available credits')
  assert.strictEqual(parsed.currentUsage, 1010)
  assert.strictEqual(parsed.usageLimit, null)
  assert.strictEqual(parsed.percentUsed, null)
  assert.strictEqual(parsed.usageUnit, 'credits')
  assert.strictEqual(parsed.subModels[0].name, 'Credits remaining')
  assert.strictEqual(parsed.subModels[0].count, 1010)
}

testGeminiRateLimitTable()
testGeminiDoesNotTruncateModelRows()
testHiggsfieldRemainingCreditsOnly()
testHiggsfieldRemainingAndTotalCredits()
testAntigravityGeminiQuotaPayload()
testHiggsfieldCreditsAvailablePhrase()

function testCursorIncludedUsageLayout() {
  // Post-June-2025 usage-based dashboard: percent + $ ratio + on-demand spend.
  const sample = `
Dashboard
Usage
Current Plan
Pro $20/mo
Resets on 15 August 2026
Included usage
37%
$7.32 of $20.00
Usage-based spend
$3.21
`

  const parsed = parseCursorUsageText(sample)

  assert(parsed, 'expected Cursor parser to return usage data')
  assert.strictEqual(parsed.percentUsed, 37)
  assert.strictEqual(parsed.currentUsage, 37)
  assert.strictEqual(parsed.usageLimit, 100)
  assert.strictEqual(parsed.detectedPlanTier, 'Pro')
  assert.strictEqual(parsed.renewalDate, '2026-08-15')
  assert.strictEqual(parsed.resetsAt, '2026-08-15T00:00:00.000Z')
  assert.strictEqual(parsed.weeklyBarLabel, undefined)
  const onDemand = (parsed.subModels || []).find((row) => row.name === 'On-demand spend')
  assert(!onDemand, 'unbounded on-demand $ must not become a card row')
  const included = parsed.subModels.find((row) => row.name === 'Included usage')
  assert(included, 'expected an Included usage sub-model row')
  assert.strictEqual(included.count, 7.32)
  assert.strictEqual(included.total, 20)
}

function testCursorDollarRatioWithoutPercent() {
  // Same layout but only the $ ratio is visible — percent derives from it.
  const sample = `
Current Plan
Ultra
Included usage
$41.00 of $200.00
Resets on 26. august 2026
`

  const parsed = parseCursorUsageText(sample)

  assert(parsed, 'expected Cursor parser to return usage data from the $ ratio')
  assert.strictEqual(parsed.percentUsed, 21)
  assert.strictEqual(parsed.detectedPlanTier, 'Ultra')
  assert.strictEqual(parsed.renewalDate, '2026-08-26')
}

function testCursorRetiredAutoComposerLayout() {
  // Pre-June-2025 layout (kept as fallback): dual Auto/API percentage rows.
  const sample = `
CURRENT PLAN
Pro $20/mo
Resets on 26. mai 2027 (30 days)
Total
9%
1% Auto and 33% API used
Auto + Composer
1%
API
33%
`

  const parsed = parseCursorUsageText(sample)

  assert(parsed, 'expected Cursor parser to return usage data for the retired layout')
  // Primary bar = the overall "Total" quota figure; Auto/API stay as breakdown rows.
  assert.strictEqual(parsed.percentUsed, 9)
  assert.strictEqual(parsed.weeklyPercentUsed, 33)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.totalPercent, 9)
  assert.strictEqual(parsed.renewalDate, '2027-05-26')
  const auto = parsed.subModels.find((row) => row.name === 'Cursor Models')
  assert(auto && auto.count === 1, 'expected a Cursor Models breakdown row')
  const api = parsed.subModels.find((row) => row.name === 'Other Models')
  assert(api && api.count === 33, 'expected an Other Models breakdown row')
}

function testCursorRealSpendingLayout() {
  // Actual cursor.com/dashboard/spending layout (verified by screenshot
  // 2026-07-17): "Included in Pro / Total 13%", localized Norwegian reset
  // string, credit balance with decimal comma, "Credits expire" line that
  // must NOT hijack the plan's reset date.
  const sample = `
Back to Agents
Overview
Settings
Members
Usage
Spending
Billing & Invoices
Refer friends
CURRENT PLAN
Pro $20/mo
Resets on 26. juli
(9 days remaining)
Adjust plan
UPGRADE AVAILABLE
Pro+ $60/mo
Unlock 3x more usage on Agent & more
Upgrade
Credits
Your account has a credit balance that will be automatically applied to Cursor usage.
Credits expire on July 19, 2026 at 1:02 AM
20,00 USD
remaining
Included in Pro
Total
13%
1% First-party models and 100% API used
On-Demand Usage
On-Demand Spending
On-demand spending is currently disabled
Disabled
Monthly Limit
Set a fixed amount or make it unlimited.
Disabled
Save
`

  const parsed = parseCursorUsageText(sample)

  assert(parsed, 'expected Cursor parser to return usage data for the real spending layout')
  assert.strictEqual(parsed.percentUsed, 13)
  assert.strictEqual(parsed.detectedPlanTier, 'Pro')
  assert.strictEqual(parsed.weeklyPercentUsed, 100)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  const firstParty = parsed.subModels.find((row) => row.name === 'Cursor Models')
  assert(firstParty && firstParty.count === 1, 'expected a Cursor Models row at 1%')
  const api = parsed.subModels.find((row) => row.name === 'Other Models')
  assert(api && api.count === 100, 'expected an Other Models row at 100%')
  const onDemand = (parsed.subModels || []).find((row) => row.name === 'On-demand spend')
  assert(!onDemand, 'disabled on-demand must not become a spend row')

  // Reset must come from "Resets on 26. juli", NOT from "Credits expire on July 19".
  const now = new Date()
  let expectedYear = now.getFullYear()
  if (new Date(expectedYear, 6, 26).getTime() < now.getTime() - 24 * 60 * 60 * 1000) expectedYear += 1
  assert.strictEqual(parsed.renewalDate, `${expectedYear}-07-26`)

  // Decimal-comma credit balance.
  assert(parsed.agentCredits, 'expected agentCredits from the USD balance')
  assert.strictEqual(parsed.agentCredits.balance, 20)
}

function testCursorUltraCursorAndOtherModelsLayout() {
  // 2026 Ultra spending page: two named bars, on-demand disabled, $400 is an
  // included API allowance — not spend — and Cancels on is the plan end date.
  const sample = `
Current Plan
Ultra
$200/mo
Cancels on September 12, 2026
Adjust Plan
Included in Ultra
Cursor Models
Includes Cursor Grok and Composer
0% used
Additional usage beyond limits consumes Other Models quota or on-demand spend.
Other Models
0% used
Additional usage beyond limits consumes on-demand spend. Your plan includes at least $400 of API usage.
On-Demand Usage
On-Demand Spending
Disabled
Monthly Limit
Set a fixed amount or make it unlimited
Disabled
Save
`

  const parsed = parseCursorUsageText(sample)

  assert(parsed, 'expected Cursor parser to return usage data for the Ultra split layout')
  assert.strictEqual(parsed.detectedPlanTier, 'Ultra')
  assert.strictEqual(parsed.percentUsed, 0)
  assert.strictEqual(parsed.currentUsage, 0)
  assert.strictEqual(parsed.weeklyPercentUsed, 0)
  assert.strictEqual(parsed.weeklyUsage, 0)
  assert.strictEqual(parsed.weeklyLimit, 100)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.totalPercent, null, 'Included in Ultra is not a Total row')
  assert.strictEqual(parsed.renewalDate, '2026-09-12')
  assert.strictEqual(parsed.renewalKind, 'cancelled')

  const cursorModels = parsed.subModels.find((row) => row.name === 'Cursor Models')
  assert(cursorModels && cursorModels.count === 0, 'expected Cursor Models at 0%')
  const otherModels = parsed.subModels.find((row) => row.name === 'Other Models')
  assert(otherModels && otherModels.count === 0, 'expected Other Models at 0%')
  const onDemand = (parsed.subModels || []).find((row) => row.name === 'On-demand spend')
  assert(!onDemand, '$400 included API allowance must not be scraped as on-demand spend')
}

function testCursorNamedPoolsKeepDistinctPercents() {
  // Guard against the Cursor Models window swallowing Other Models' figure
  // (or the reverse) when both bars are present with different values.
  const sample = `
Current Plan
Pro $20/mo
Included in Pro
Cursor Models
Includes Cursor Grok and Composer
12% used
Other Models
47% used
On-Demand Spending
Disabled
`

  const parsed = parseCursorUsageText(sample)
  assert(parsed, 'expected Cursor parser to split distinct named pools')
  assert.strictEqual(parsed.percentUsed, 12)
  assert.strictEqual(parsed.weeklyPercentUsed, 47)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.totalPercent, null)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 12)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Other Models').count, 47)
}

function testCursorFlattenedSpendingTextKeepsBothPools() {
  // Managed Chrome innerText is often one wrapped paragraph. Headings must
  // still match without requiring a newline before "Cursor Models".
  const sample =
    'Current Plan Ultra $200/mo Cancels on September 12, 2026 Included in Ultra ' +
    'Cursor Models Includes Cursor Grok and Composer 1% used ' +
    'Additional usage beyond limits consumes Other Models quota or on-demand spend. ' +
    'Other Models 0% used Additional usage beyond limits consumes on-demand spend. ' +
    'Your plan includes at least $400 of API usage. On-Demand Spending Disabled'

  const parsed = parseCursorUsageText(sample)
  assert(parsed, 'expected Cursor parser to read flattened spending text')
  assert.strictEqual(parsed.percentUsed, 1)
  assert.strictEqual(parsed.weeklyPercentUsed, 0)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 1)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Other Models').count, 0)
  const onDemand = (parsed.subModels || []).find((row) => row.name === 'On-demand spend')
  assert(!onDemand, 'flattened $400 allowance must not become on-demand spend')
}

function testCursorPlanAndUsageFirstPartyApiLayout() {
  // Live Ultra Plan & Usage page (screenshot 2026-08-14): Total Usage plus
  // First-party / API meters. "Resets on Sep 12 (29 days remaining)" is the
  // plan card — not a cancellation.
  const sample = `
Plan & Usage
Current Plan
Ultra $200/mo
Resets on Sep 12 (29 days remaining)
Manage
Included in Ultra Usage
Total Usage
2%
1% First-party models and 7% API used
First-party models
1%
Additional usage beyond limits consumes API quota or on-demand spend.
API
7%
Additional usage beyond limits consumes on-demand spend. Your plan includes at least $400 of API usage.
On-Demand Usage
On-Demand Spending
Disabled
Monthly Limit
Disabled
Save
`

  const parsed = parseCursorUsageText(sample)
  assert(parsed, 'expected Cursor parser to return usage data for Plan & Usage')
  assert.strictEqual(parsed.detectedPlanTier, 'Ultra')
  assert.strictEqual(parsed.percentUsed, 2, 'Total Usage headlines the card')
  assert.strictEqual(parsed.currentUsage, 2)
  assert.strictEqual(parsed.totalPercent, 2)
  assert.strictEqual(parsed.totalBarLabel, 'Total')
  assert.strictEqual(parsed.weeklyPercentUsed, 7)
  assert.strictEqual(parsed.weeklyUsage, 7)
  assert.strictEqual(parsed.weeklyLimit, 100)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.renewalKind, 'renewing')
  const now = new Date()
  let expectedYear = now.getFullYear()
  if (new Date(expectedYear, 8, 12).getTime() < now.getTime() - 24 * 60 * 60 * 1000) expectedYear += 1
  assert.strictEqual(parsed.renewalDate, `${expectedYear}-09-12`)
  const cursorModels = parsed.subModels.find((row) => row.name === 'Cursor Models')
  assert(cursorModels && cursorModels.count === 1, 'expected Cursor Models at 1%')
  const otherModels = parsed.subModels.find((row) => row.name === 'Other Models')
  assert(otherModels && otherModels.count === 7, 'expected Other Models at 7% (API)')
  const onDemand = (parsed.subModels || []).find((row) => row.name === 'On-demand spend')
  assert(!onDemand, '$400 included API allowance must not be scraped as on-demand spend')
}

function testCursorSummaryOverridesStaleOtherModelsZero() {
  // Same live page, plus a leftover "Other Models 0%" (stale SPA / chart).
  // The breakdown summary is the page's own combined readout and must win.
  const sample = `
Current Plan
Ultra $200/mo
Resets on September 12 (29 days remaining)
Included in Ultra Usage
Total Usage
2%
1% First-party models and 7% API used
First-party models
1%
Other Models
0% used
API
7%
Your plan includes at least $400 of API usage.
On-Demand Spending
Disabled
`

  const parsed = parseCursorUsageText(sample)
  assert(parsed, 'expected Cursor parser to keep the summary API percent')
  assert.strictEqual(parsed.percentUsed, 2)
  assert.strictEqual(parsed.weeklyPercentUsed, 7)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 1)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Other Models').count, 7)
  assert.strictEqual(parsed.renewalKind, 'renewing')
}

function testCursorFlattenedPlanAndUsageKeepsApiPercent() {
  const sample =
    'Current Plan Ultra $200/mo Resets on Sep 12 (29 days remaining) ' +
    'Included in Ultra Usage Total Usage 2% ' +
    '1% First-party models and 7% API used ' +
    'First-party models 1% Additional usage beyond limits consumes API quota or on-demand spend. ' +
    'API 7% Additional usage beyond limits consumes on-demand spend. ' +
    'Your plan includes at least $400 of API usage. On-Demand Spending Disabled'

  const parsed = parseCursorUsageText(sample)
  assert(parsed, 'expected Cursor parser to read flattened Plan & Usage text')
  assert.strictEqual(parsed.percentUsed, 2)
  assert.strictEqual(parsed.weeklyPercentUsed, 7)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 1)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Other Models').count, 7)
  assert.strictEqual(parsed.renewalKind, 'renewing')
  const onDemand = (parsed.subModels || []).find((row) => row.name === 'On-demand spend')
  assert(!onDemand, 'flattened $400 allowance must not become on-demand spend')
}

function testCursorPeriodUsageJsonMatchesPlanAndUsage() {
  // Same fields the IDE Plan & Usage bars read (forum + OpenUsage samples).
  const parsed = parseCursorPeriodUsageJson({
    billingCycleEnd: '2026-09-12T00:00:00.000Z',
    planUsage: {
      autoPercentUsed: 1,
      apiPercentUsed: 7,
      totalPercentUsed: 2
    }
  })
  assert(parsed, 'expected Cursor API parser to return usage data')
  assert.strictEqual(parsed.percentUsed, 2)
  assert.strictEqual(parsed.totalPercent, 2)
  assert.strictEqual(parsed.weeklyPercentUsed, 7)
  assert.strictEqual(parsed.weeklyBarLabel, 'Other Models')
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 1)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Other Models').count, 7)
  assert.strictEqual(parsed.renewalDate, '2026-09-12')
  assert.strictEqual(parsed.renewalKind, 'renewing')
}

function testCursorPeriodUsageJsonConnectWrapperAndUnixMs() {
  const parsed = parseCursorPeriodUsageJson({
    result: {
      billingCycleEnd: '1771077734000',
      planUsage: {
        autoPercentUsed: 0,
        apiPercentUsed: 46.444,
        totalPercentUsed: 15.48
      }
    }
  })
  assert(parsed, 'expected Connect-wrapped planUsage to parse')
  assert.strictEqual(parsed.percentUsed, 15)
  assert.strictEqual(parsed.weeklyPercentUsed, 46)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 0)
  assert.strictEqual(parsed.renewalDate, '2026-02-14')
  assert.strictEqual(parsed.renewalKind, 'renewing')
}

function testCursorLivePlanAndUsageJsonHeadlinesOfficialTotal() {
  // Live GetCurrentPeriodUsage shape (2026-08-15 Ultra): Total 11%,
  // First-party 4%, API 42%. Spending-page DOM can still say 2% / 14%.
  const parsed = parseCursorPeriodUsageJson({
    billingCycleStart: '1786501298000',
    billingCycleEnd: '1789179698000',
    planUsage: {
      limit: 40000,
      autoPercentUsed: 3.606,
      apiPercentUsed: 42.004,
      totalPercentUsed: 11.2856
    }
  })
  assert(parsed, 'expected live Plan & Usage JSON to parse')
  assert.strictEqual(parsed.percentUsed, 11, 'official Total headlines the card')
  assert.strictEqual(parsed.totalPercent, 11)
  assert.strictEqual(parsed.totalBarLabel, 'Total')
  assert.strictEqual(parsed.weeklyPercentUsed, 42)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Cursor Models').count, 4)
  assert.strictEqual(parsed.subModels.find((row) => row.name === 'Other Models').count, 42)
  assert.strictEqual(parsed.renewalDate, '2026-09-12')
  assert.strictEqual(parsed.renewalKind, 'renewing')
}

function testCursorApiOverridesStaleDomTwoAndFourteen() {
  const dom = parseCursorUsageText(`
Current Plan
Ultra $200/mo
Cancels on September 12, 2026
Cursor Models
2% used
Other Models
14% used
On-Demand Spending
Disabled
`)
  const api = parseCursorPeriodUsageJson({
    billingCycleEnd: '1789179698000',
    cancelAtPeriodEnd: false,
    planUsage: { autoPercentUsed: 3.606, apiPercentUsed: 42.004, totalPercentUsed: 11.2856 }
  })
  const merged = mergeCursorDomWithApi(dom, api)
  assert(merged, 'expected live API to overlay stale 2%/14% DOM')
  assert.strictEqual(merged.percentUsed, 11)
  assert.strictEqual(merged.totalPercent, 11)
  assert.strictEqual(merged.weeklyPercentUsed, 42)
  assert.strictEqual(merged.subModels.find((row) => row.name === 'Cursor Models').count, 4)
  assert.strictEqual(merged.subModels.find((row) => row.name === 'Other Models').count, 42)
  assert.strictEqual(merged.renewalKind, 'renewing')
  assert.strictEqual(merged.detectedPlanTier, 'Ultra')
}

function testCursorApiOverridesStaleDomOtherModelsZero() {
  const dom = parseCursorUsageText(`
Current Plan
Ultra $200/mo
Cancels on September 12, 2026
Cursor Models
1% used
Other Models
0% used
On-Demand Spending
Disabled
`)
  const api = parseCursorPeriodUsageJson({
    billingCycleEnd: '2026-09-12T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    planUsage: { autoPercentUsed: 1, apiPercentUsed: 7, totalPercentUsed: 2 }
  })
  const merged = mergeCursorDomWithApi(dom, api)
  assert(merged, 'expected merge of stale DOM + live API')
  assert.strictEqual(merged.percentUsed, 2)
  assert.strictEqual(merged.totalPercent, 2)
  assert.strictEqual(merged.weeklyPercentUsed, 7)
  assert.strictEqual(merged.subModels.find((row) => row.name === 'Other Models').count, 7)
  assert.strictEqual(merged.renewalKind, 'renewing')
  assert.strictEqual(merged.detectedPlanTier, 'Ultra')
}

function testCursorLoginPageReturnsNull() {
  const sample = `
Cursor
Sign in
Continue with Google
Continue with GitHub
Welcome back
Create account
`

  const parsed = parseCursorUsageText(sample)
  assert.strictEqual(parsed, null, 'expected null for a signed-out login page')
}

function testCursorChallengePageReturnsNull() {
  const sample = `
Just a moment...
Verify you are human
cursor.com
`

  const parsed = parseCursorUsageText(sample)
  assert.strictEqual(parsed, null, 'expected null for a Cloudflare challenge page')
}

function testKimiMembershipQuotaPage() {
  // Actual kimi.ai/membership/subscription?tab=quota layout (verified by
  // screenshot 2026-07-17 on the then-current host; path is unchanged):
  // monthly total + 5-hour/7-day Code buckets with absolute reset times,
  // plan tier, auto-renewal date.
  const sample = `
Allegro
Quota reset monthly
Next auto-renewal date: 2026-08-17
Subscription Info
My Quota
Usage Details
Billing & Invoices
Usage Progress
Total usage 48.75%
Kimi Code
Resets in 2026-08-17
5-hour usage
Code 0.9%
Resets in 07-17 15:41
7-day usage
Code 2.75%
Resets in 07-24 00:41
Extra Usage
Not enabled yet
Enable Extra Usage to purchase additional quota on top of your current plan
`

  const parsed = parseKimiMembershipText(sample)

  assert(parsed, 'expected Kimi membership parser to return usage data')
  assert.strictEqual(parsed.percentUsed, 48.75)
  assert.strictEqual(parsed.currentUsage, 48.75)
  assert.strictEqual(parsed.usageLimit, 100)
  assert.strictEqual(parsed.detectedPlanTier, 'Allegro')
  assert.strictEqual(parsed.resetsAt, '2026-08-17T00:00:00.000Z')
  assert.strictEqual(parsed.renewalDate, '2026-08-17')
  assert.strictEqual(parsed.renewalKind, 'renewing')
  assert.strictEqual(parsed.weeklyPercentUsed, 2.75)
  assert.strictEqual(parsed.weeklyBarLabel, '7-day')
  assert(parsed.weeklyResetsAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(parsed.weeklyResetsAt),
    'expected a concrete ISO 7-day reset timestamp')
  const fiveHour = parsed.subModels.find((row) => row.name === '5-hour usage (Code)')
  assert(fiveHour, 'expected a 5-hour usage sub-model row')
  assert.strictEqual(fiveHour.count, 0.9)
  assert(fiveHour.resetsAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(fiveHour.resetsAt),
    'expected a concrete ISO 5-hour reset timestamp')
}

function testKimiMembershipWithoutQuotaReturnsNull() {
  const sample = `
Sign in
Welcome back
Continue with Google
`

  const parsed = parseKimiMembershipText(sample)
  assert.strictEqual(parsed, null, 'expected null when no quota figures are present')
}

function testKimiMembershipLogInWithGoogleShellReturnsNull() {
  const sample = `
KIMI
Log in with Google
Phone number login
Verification code
Agree to Terms of Service and Privacy Policy
`

  const parsed = parseKimiMembershipText(sample)
  assert.strictEqual(parsed, null, 'expected null for the international Google login shell')
}

function testKimiMembershipVivacePlan() {
  const sample = `
Vivace
Quota reset monthly
Next auto-renewal date: 2026-09-17
Usage Progress
Total usage 12.5%
Kimi Code
Resets in 2026-09-17
5-hour usage
Code 1.2%
Resets in 08-29 15:41
7-day usage
Code 3.4%
Resets in 09-05 00:41
`

  const parsed = parseKimiMembershipText(sample)
  assert(parsed, 'expected Kimi membership parser to return usage data for Vivace')
  assert.strictEqual(parsed.detectedPlanTier, 'Vivace')
  assert.strictEqual(parsed.percentUsed, 12.5)
  assert.strictEqual(parsed.weeklyPercentUsed, 3.4)
}

// ── Gemini web app ────────────────────────────────────────────────────────
const GEMINI_NOW = new Date(2026, 6, 19, 17, 30, 0)

// gemini.google.com/u/1/usage — the consumer plan panel. Two bars, two
// separately-scoped reset phrases, no per-model breakdown.
const GEMINI_WEB_PAGE = `Gemini
Usage limits
PRO
Your plan's limits determine how much you can use Gemini over time. Advanced models and features can take up more usage. Learn more
Updated just now
Current usage
9% used
Resets at 7:21 PM
Weekly limit
0% used
Resets Jul 26 at 2:21 PM
Get 5x more usage with AI Ultra
NOK 1,059/month
Upgrade
`

function testGeminiWebUsagePanel() {
  const parsed = parseGeminiWebUsageText(GEMINI_WEB_PAGE, GEMINI_NOW)

  assert(parsed, 'expected Gemini web parser to return usage data')
  assert.strictEqual(parsed.detectedPlanTier, 'PRO')
  assert.strictEqual(parsed.percentUsed, 9)
  assert.strictEqual(parsed.currentUsage, 9)
  assert.strictEqual(parsed.weeklyPercentUsed, 0)
  assert.strictEqual(parsed.usageLimit, 100)
  assert.strictEqual(parsed.usageUnit, '% current usage')
  // This page has no per-model rows; the old Antigravity source invented five.
  assert.strictEqual(parsed.subModels, undefined)
}

function testGeminiWebResetsAreScopedToTheirOwnSection() {
  const parsed = parseGeminiWebUsageText(GEMINI_WEB_PAGE, GEMINI_NOW)

  // "Resets at 7:21 PM" belongs to Current usage: today, since 19:21 is still
  // ahead of the 17:30 reference time.
  const current = new Date(parsed.resetsAt)
  assert.strictEqual(current.getDate(), 19)
  assert.strictEqual(current.getHours(), 19)
  assert.strictEqual(current.getMinutes(), 21)

  // "Resets Jul 26 at 2:21 PM" belongs to Weekly limit — an unscoped search
  // would have handed one of these timestamps to both bars.
  const weekly = new Date(parsed.weeklyResetsAt)
  assert.strictEqual(weekly.getMonth(), 6)
  assert.strictEqual(weekly.getDate(), 26)
  assert.strictEqual(weekly.getHours(), 14)
  assert.strictEqual(weekly.getMinutes(), 21)

  assert.notStrictEqual(parsed.resetsAt, parsed.weeklyResetsAt)
}

function testGeminiWebTimeOnlyResetRollsToTomorrow() {
  // Same page read at 20:00: 7:21 PM has passed, so the next one is tomorrow.
  const parsed = parseGeminiWebUsageText(GEMINI_WEB_PAGE, new Date(2026, 6, 19, 20, 0, 0))
  const current = new Date(parsed.resetsAt)
  assert.strictEqual(current.getDate(), 20, 'elapsed time-only reset must roll forward a day')
  assert(new Date(parsed.resetsAt).getTime() > new Date(2026, 6, 19, 20, 0, 0).getTime(),
    'reset must never be in the past — that is what rendered as "now"')
}

function testGeminiWebSignedOutReturnsNull() {
  const parsed = parseGeminiWebUsageText('Sign in to continue Use your Google Account', GEMINI_NOW)
  assert.strictEqual(parsed, null, 'expected null on the Google sign-in page')
}

// ── Qwen Cloud ────────────────────────────────────────────────────────────
// Captured from home.qwencloud.com/billing/subscription/token-plan-individual.
// Two windows reported as "Remaining N%" against a "Total" pool.
const QWEN_SUBSCRIPTION_TEXT =
  'Subscription Management View subscription usage details and historical orders ' +
  'Individual Team Individual Plan Standard Last updated 00:17:08 ' +
  'Status Active Auto-renew Remaining days 31 days Expiry date 2026-09-06 18:00:00 ' +
  '5 Hours Usage Limit Reset time 2026-08-06 04:34:00 Remaining 81.4% Total 3,000 ' +
  '7 Days Usage Limit Reset time 2026-08-12 23:34:00 Remaining 94.4% Total 10,000 ' +
  'Upgrade Renew Credit Pack'

// Live/docs variants use hyphens and "quota" instead of spaced "Usage Limit".
const QWEN_HYPHEN_TEXT =
  'Token Plan Individual Plan Standard Expiry date 2026-09-06 ' +
  '5-Hour Usage Limit Reset time 2026-08-06 04:34:00 Remaining 81.4% Total 3,000 Credits ' +
  '7-Day Usage Limit Reset time 2026-08-12 23:34:00 Remaining 94.4% Total 10,000 Credits'

const QWEN_QUOTA_TEXT =
  'Subscription Management 5-hour quota Reset time 2026-08-06 04:34:00 Remaining 81.4% Total 3000 ' +
  '7-day quota Reset time 2026-08-12 23:34:00 Remaining 94.4% Total 10000'

function assertQwenDualWindows(parsed, label) {
  assert(parsed, `expected Qwen parser to return usage data (${label})`)
  // Primary = 5-hour: remaining 81.4% => used 18.6% of 3,000 = 558.
  assert.strictEqual(parsed.usageLimit, 3000, `${label}: 5h limit`)
  assert.strictEqual(parsed.percentUsed, 18.6, `${label}: 5h used%`)
  assert.strictEqual(parsed.currentUsage, 558, `${label}: 5h used`)
  assert.strictEqual(parsed.usageUnit, 'credits', `${label}: unit credits`)
  assert(parsed.resetsAt && /^\d{4}-\d{2}-\d{2}T/.test(parsed.resetsAt), `${label}: ISO 5h reset`)
  // Weekly = 7-day: remaining 94.4% => used 5.6% of 10,000 = 560.
  assert.strictEqual(parsed.weeklyLimit, 10000, `${label}: 7d limit`)
  assert.strictEqual(parsed.weeklyPercentUsed, 5.6, `${label}: 7d used%`)
  assert.strictEqual(parsed.weeklyUsage, 560, `${label}: 7d used`)
  assert.strictEqual(parsed.weeklyBarLabel, '7-day', `${label}: weekly label`)
  assert(parsed.weeklyResetsAt && /^\d{4}-\d{2}-\d{2}T/.test(parsed.weeklyResetsAt), `${label}: ISO 7d reset`)
}

function testQwenSubscriptionWindows() {
  const parsed = parseQwenSubscriptionText(QWEN_SUBSCRIPTION_TEXT)
  assertQwenDualWindows(parsed, 'spaced headers')
  assert.strictEqual(parsed.detectedPlanTier, 'Individual · Standard')
  assert.strictEqual(parsed.renewalDate, '2026-09-06')
  console.log('[qwen] Parsed: 5h=18.6% (558/3000), 7d=5.6% (560/10000), plan=Individual · Standard')
}

function testQwenHyphenatedHeaders() {
  const parsed = parseQwenSubscriptionText(QWEN_HYPHEN_TEXT)
  assertQwenDualWindows(parsed, 'hyphen headers')
  console.log('[qwen] Hyphen headers: 5h=18.6%, 7d=5.6%')
}

function testQwenQuotaHeaders() {
  const parsed = parseQwenSubscriptionText(QWEN_QUOTA_TEXT)
  assertQwenDualWindows(parsed, 'quota headers')
  console.log('[qwen] Quota headers: 5h=18.6%, 7d=5.6%')
}

function testQwenLoginShellReturnsNull() {
  const parsed = parseQwenSubscriptionText('Sign in to QwenCloud Create account Log in')
  assert.strictEqual(parsed, null, 'expected null on the login shell')
}

function testQwenBareRemainingWithoutWindowsReturnsNull() {
  // Must not invent a 81.4/100 "used" bar from a lone Remaining percent.
  const parsed = parseQwenSubscriptionText(
    'Subscription Management Remaining 81.4% Total 3000 some other junk'
  )
  assert.strictEqual(parsed, null, 'expected null without 5h/7d window headers')
}

function testQwenSevenDayOnlyDoesNotDuplicateBars() {
  // Live failure mode: only 7-day parsed → must NOT clone into primary + weekly
  // (that produced two identical 6020/10000 dual bars labeled 5h + 7d).
  const parsed = parseQwenSubscriptionText(
    'Subscription Management Individual Plan Standard Expiry date 2026-09-06 ' +
    '7 Days Usage Limit Reset time 2026-08-12 23:34:00 Remaining 39.8% Total 10,000'
  )
  assert(parsed, 'expected 7-day-only parse')
  assert.strictEqual(parsed.usageLimit, 10000, '7d-only: primary limit is 7d pool')
  assert.strictEqual(parsed.percentUsed, 60.2, '7d-only: used% from remaining 39.8')
  assert.strictEqual(parsed.currentUsage, 6020, '7d-only: used credits')
  assert.strictEqual(parsed.weeklyPercentUsed, null, '7d-only: weekly must be null (no dual clone)')
  assert.strictEqual(parsed.weeklyUsage, null, '7d-only: weeklyUsage null')
  assert.strictEqual(parsed.weeklyLimit, null, '7d-only: weeklyLimit null')
  assert.strictEqual(parsed.usageUnit, '7d credits', '7d-only: honest unit label')
  console.log('[qwen] 7d-only: single bar 6020/10000, weekly=null')
}

function testQwenFiveHourOnlyDoesNotInventWeekly() {
  const parsed = parseQwenSubscriptionText(
    'Token Plan Individual Plan Standard Expiry date 2026-09-06 ' +
    '5 Hours Usage Limit Reset time 2026-08-06 04:34:00 Remaining 81.4% Total 3,000'
  )
  assert(parsed, 'expected 5h-only parse')
  assert.strictEqual(parsed.usageLimit, 3000, '5h-only: limit')
  assert.strictEqual(parsed.percentUsed, 18.6, '5h-only: used%')
  assert.strictEqual(parsed.currentUsage, 558, '5h-only: used')
  assert.strictEqual(parsed.weeklyPercentUsed, null, '5h-only: weekly null')
  assert.strictEqual(parsed.usageUnit, '5h credits', '5h-only: honest unit label')
  console.log('[qwen] 5h-only: single bar 558/3000, weekly=null')
}

function testQwenCloneWindowsCollapseToSingleBar() {
  // Both headers present but same remaining/total/reset → one meter only.
  // Matches the live 6020/10000 dual-clone failure mode.
  const parsed = parseQwenSubscriptionText(
    'Subscription Management Individual Plan Standard Expiry date 2026-09-06 ' +
    '5 Hours Usage Limit Reset time 2026-08-12 23:34:00 Remaining 39.8% Total 10,000 ' +
    '7 Days Usage Limit Reset time 2026-08-12 23:34:00 Remaining 39.8% Total 10,000'
  )
  assert(parsed, 'expected clone-window parse')
  assert.strictEqual(parsed.usageLimit, 10000, 'clone: primary limit')
  assert.strictEqual(parsed.percentUsed, 60.2, 'clone: used%')
  assert.strictEqual(parsed.currentUsage, 6020, 'clone: used')
  assert.strictEqual(parsed.weeklyPercentUsed, null, 'clone: weekly must be null')
  assert.strictEqual(parsed.weeklyUsage, null, 'clone: weeklyUsage null')
  assert.strictEqual(parsed.usageUnit, '7d credits', 'clone: honest 7d unit')
  console.log('[qwen] clone windows: collapsed to single 6020/10000, weekly=null')
}

function assertQwenLiftedDual(parsed, label) {
  assert(parsed, `expected lifted-5h dual parse (${label})`)
  assert.strictEqual(parsed.usageUnit, '5h lifted', `${label}: unit`)
  assert.strictEqual(parsed.currentUsage, 0, `${label}: 5h used=0`)
  assert.strictEqual(parsed.usageLimit, null, `${label}: 5h limit null (∞)`)
  assert.strictEqual(parsed.percentUsed, 0, `${label}: 5h used% 0`)
  assert.strictEqual(parsed.resetsAt, null, `${label}: no 5h reset`)
  assert.strictEqual(parsed.weeklyLimit, 10000, `${label}: 7d limit`)
  assert.strictEqual(parsed.weeklyPercentUsed, 60.2, `${label}: 7d used%`)
  assert.strictEqual(parsed.weeklyUsage, 6020, `${label}: 7d used`)
  assert(parsed.weeklyResetsAt && /^\d{4}-\d{2}-\d{2}T/.test(parsed.weeklyResetsAt), `${label}: 7d reset ISO`)
  assert.strictEqual(parsed.weeklyBarLabel, '7-day', `${label}: weekly label`)
}

function testQwenFiveHourTemporarilyLiftedDualBars() {
  // Live page 2026-08-07: 5h Temporarily Lifted + Remaining ♾️, 7d metered.
  const liveText =
    'Subscription Management View subscription usage details and historical orders ' +
    'Individual Team Individual Plan Standard Last updated 06:46:03 ' +
    'Status Active Auto-renew Remaining days 30 days Expiry date 2026-09-06 18:00:00 ' +
    '5 Hours Usage Limit Temporarily Lifted Reset time - Remaining ♾️ ' +
    '7 Days Usage Limit Reset time 2026-08-12 23:34:00 Remaining 39.8% Total 10,000 ' +
    'Upgrade Renew Credit Pack'
  const parsed = parseQwenSubscriptionText(liveText)
  assertQwenLiftedDual(parsed, 'flat lifted dual')
  console.log('[qwen] live lifted: 5h=LIFTED(∞) + 7d=6020/10000 @60.2%')
}

function testQwenMultilineLiftedPageText() {
  // Real DOM innerText keeps hard newlines between labels (tmp/qwen-page-text.txt).
  const multiline =
    'Subscription Management\n' +
    'View subscription usage details and historical orders\n' +
    'Individual Plan\nStandard\n' +
    'Expiry date\n2026-09-06 18:00:00\n' +
    '5 Hours Usage Limit\nTemporarily Lifted\nReset time -\nRemaining\n♾️\n' +
    '7 Days Usage Limit\nReset time 2026-08-12 23:34:00\nRemaining\n39.8%\nTotal\n10,000\n'
  const parsed = parseQwenSubscriptionText(multiline)
  assertQwenLiftedDual(parsed, 'multiline live')
  console.log('[qwen] multiline lifted: 5h=LIFTED(∞) + 7d=6020/10000 @60.2%')
}

function testQwenLoginChromeWithLiftedUsageStillParses() {
  // Footer/chrome may include "Log in" even when usage cards are visible.
  const text =
    'Subscription Management Log in Create account Individual Plan Standard ' +
    '5 Hours Usage Limit Temporarily Lifted Reset time - Remaining ♾️ ' +
    '7 Days Usage Limit Reset time 2026-08-12 23:34:00 Remaining 39.8% Total 10,000'
  const parsed = parseQwenSubscriptionText(text)
  assertQwenLiftedDual(parsed, 'login chrome + lifted')
  console.log('[qwen] login chrome + lifted: still dual bars')
}

function testQwenTemporarilyRemovedDualBars() {
  // Live page 2026-08-07 evening: "Temporarily Removed" + Remaining "-" (not ∞).
  const liveText =
    'Subscription Management View subscription usage details and historical orders ' +
    'Individual Team Individual Plan Standard Last updated 16:53:51 ' +
    'Status Active Auto-renew Remaining days 30 days Expiry date 2026-09-06 18:00:00 ' +
    '5 Hours Usage Limit Temporarily Removed Reset time - Remaining - ' +
    '7 Days Usage Limit Reset time 2026-08-12 23:34:00 Remaining 35.3% Total 10,000 ' +
    'Upgrade Renew Credit Pack'
  const parsed = parseQwenSubscriptionText(liveText)
  assert(parsed, 'expected temporarily-removed dual parse')
  assert.strictEqual(parsed.usageUnit, '5h lifted', 'removed dual: unit 5h lifted')
  assert.strictEqual(parsed.currentUsage, 0, 'removed dual: 5h used=0')
  assert.strictEqual(parsed.usageLimit, null, 'removed dual: 5h limit null')
  assert.strictEqual(parsed.percentUsed, 0, 'removed dual: 5h used% 0')
  assert.strictEqual(parsed.weeklyLimit, 10000, 'removed dual: 7d limit')
  assert.strictEqual(parsed.weeklyPercentUsed, 64.7, 'removed dual: 7d used%')
  assert.strictEqual(parsed.weeklyUsage, 6470, 'removed dual: 7d used')
  assert.strictEqual(parsed.weeklyBarLabel, '7-day', 'removed dual: weekly label')
  console.log('[qwen] temporarily removed: 5h=LIFTED + 7d=6470/10000 @64.7%')
}

function testQwenLiveSevenDayOnlyFrom20260815() {
  // Live reconnect 2026-08-15 22:08: 7d Remaining 88.7% of 10,000. No 5h header.
  const text =
    'Subscription Management Individual Plan Standard Last updated 22:08:07 ' +
    'Status Active Auto-renew Remaining days 21 days Expiry date 2026-09-06 18:00:00 ' +
    '7 Days Usage Limit Reset time 2026-08-21 20:09:00 Remaining 88.7% Total 10,000'
  const parsed = parseQwenSubscriptionText(text)
  assert(parsed, 'expected 7d-only live parse')
  assert.strictEqual(parsed.usageUnit, '7d credits')
  assert.strictEqual(parsed.usageLimit, 10000)
  assert.strictEqual(parsed.percentUsed, 11.3)
  assert.strictEqual(parsed.currentUsage, 1130)
  assert.strictEqual(parsed.weeklyPercentUsed, null)
  assert.strictEqual(qwenStructuredParseIsIncomplete(text, parsed), false)
  console.log('[qwen] live 7d-only 2026-08-15: 1130/10000 @11.3%')
}

function testQwenBothHeadersLoneSevenDayIsIncomplete() {
  const both =
    '5 Hours Usage Limit Temporarily Removed Reset time - Remaining - ' +
    '7 Days Usage Limit Reset time 2026-08-21 20:09:00 Remaining 88.7% Total 10,000'
  const sevenOnly = parseQwenSubscriptionText(
    '7 Days Usage Limit Reset time 2026-08-21 20:09:00 Remaining 88.7% Total 10,000'
  )
  assert.strictEqual(
    qwenStructuredParseIsIncomplete(both, sevenOnly),
    true,
    '5h header on the page + 7d-only parse must be refused'
  )
  const dual = parseQwenSubscriptionText(both)
  assert.strictEqual(dual.usageUnit, '5h lifted')
  assert.strictEqual(dual.weeklyPercentUsed, 11.3)
  assert.strictEqual(dual.weeklyUsage, 1130)
  assert.strictEqual(qwenStructuredParseIsIncomplete(both, dual), false)
  console.log('[qwen] both headers + 7d-only parse is incomplete; dual lifted+7d is complete')
}

function testQwenUsageJsonDualWindows() {
  const parsed = parseQwenUsageJson({
    data: {
      quotas: [
        { quotaType: '5_HOUR', remainingPercent: 81.4, total: 3000, resetTime: '2026-08-06 04:34:00' },
        { quotaType: '7_DAY', remainingPercent: 94.4, total: 10000, resetTime: '2026-08-12 23:34:00' }
      ]
    }
  })
  assertQwenDualWindows(parsed, 'json dual')
  console.log('[qwen] JSON dual: 5h=18.6% + 7d=5.6%')
}

function testQwenScraperForceReloadsParkedTab() {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/main/scrapers/qwenScraper.ts'), 'utf8')
  assert.match(src, /forceReload:\s*true/, 'Qwen must reload the parked SPA')
  assert.match(src, /qwenStructuredParseIsIncomplete/, 'incomplete dual must be refused')
  assert.doesNotMatch(
    src,
    /reapOrphanManagedChromes\('qwen'\)/,
    'scrape must not reap the live Qwen Chrome (that killed CDP and stamped stale)'
  )
  const fetcher = fs.readFileSync(path.join(__dirname, '../src/main/usageFetcher.ts'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '../src/main/refreshCoordinator.ts'), 'utf8')
  assert.match(fetcher, /keepFreshCacheOnTransientMiss/, 'fresh Qwen success must survive CDP timeout')
  const chrome = fs.readFileSync(path.join(__dirname, '../src/main/managedChrome.ts'), 'utf8')
  assert.match(
    chrome,
    /managedPipeBrowsers\.has\(serviceId\)/,
    'orphan reap must skip a live tracked Chrome'
  )
  console.log('[qwen] scraper force-reloads parked tab and refuses incomplete dual')
}

function testQwenMultilineTemporarilyRemovedPageText() {
  const multiline =
    'Subscription Management\n' +
    'Individual Plan\nStandard\n' +
    '5 Hours Usage Limit\nTemporarily Removed\nReset time -\nRemaining\n-\n' +
    '7 Days Usage Limit\nReset time 2026-08-12 23:34:00\nRemaining\n35.3%\nTotal\n10,000\n'
  const parsed = parseQwenSubscriptionText(multiline)
  assert(parsed, 'expected multiline temporarily-removed parse')
  assert.strictEqual(parsed.usageUnit, '5h lifted', 'multiline removed: unit')
  assert.strictEqual(parsed.weeklyPercentUsed, 64.7, 'multiline removed: 7d used%')
  assert.strictEqual(parsed.weeklyUsage, 6470, 'multiline removed: 7d used')
  console.log('[qwen] multiline temporarily removed: dual bars')
}

// ── Grok ──────────────────────────────────────────────────────────────────
const GROK_NOW = new Date(2026, 6, 19, 17, 30, 0)

// Captured live from grok.com/?_s=usage in offscreen managed Chrome on
// 2026-07-19. Note "Heavy Limit used" — the headline percentage is a
// rAF-driven counter and rAF is throttled offscreen, so that node is empty
// while the static product breakdown below it is intact.
const GROK_DIALOG_TEXT =
  'Dialog Account Appearance Behavior Customize Data Controls Billing Usage Usage ' +
  'Weekly SuperGrok Heavy Limit used Resets July 24, 2026 at 4:42 PM ' +
  'Grok Build 18% API 5% Chat 1% ' +
  'Extra Usage Credits Additional Credits Buy Credits Auto Top-Up ' +
  'Automatically top-up when your credit balance runs low. Set up'

// 2026-07-24 live website layout at zero usage: headline states "0% used",
// product breakdown is omitted, reset moved to July 31. This is what the
// user's grok.com/?_s=usage panel shows — the card must headline this weekly
// percent, NOT the rolling grok-4 0/140 / 2h pool.
const GROK_DIALOG_TEXT_ZERO_NO_PRODUCTS =
  'Dialog Account Appearance Behavior Customize Data Controls Billing Usage Usage ' +
  'Weekly SuperGrok Heavy Limit 0% used Resets July 31, 2026 at 4:42 PM ' +
  'Extra Usage Credits $0.00 Additional Credits Buy Credits Auto Top-Up ' +
  'Automatically top-up when your credit balance runs low. Set up'

function testGrokReconstructsWeeklyTotalFromProducts() {
  const parsed = parseGrokUsageDialogText(GROK_DIALOG_TEXT, GROK_NOW)

  assert(parsed, 'expected Grok parser to return usage data despite the missing headline')
  assert.ok(!parsed.renewalDate, 'weekly quota reset must not become the subscription renew date')
  // 18 + 5 + 1 = 24, matching what grok.com renders in a visible browser.
  assert.strictEqual(parsed.percentUsed, 24)
  assert.strictEqual(parsed.currentUsage, 24)
  assert.strictEqual(parsed.usageUnit, 'weekly used')
  assert.strictEqual(parsed.detectedPlanTier, 'SuperGrok Heavy')

  // "API" was absent from the product list, so that row was silently dropped.
  const names = parsed.subModels.map((s) => s.name).sort()
  assert.deepStrictEqual(names, ['API', 'Chat', 'Grok Build'])
  assert.strictEqual(parsed.subModels.find((s) => s.name === 'API').count, 5)

  const reset = new Date(parsed.resetsAt)
  assert.strictEqual(reset.getMonth(), 6)
  assert.strictEqual(reset.getDate(), 24)
  assert.strictEqual(reset.getHours(), 16)
  assert.strictEqual(reset.getMinutes(), 42)
}

function testGrokPrefersTheStatedTotalOverTheSum() {
  // When the dialog renders fully with a HIGHER stated total than the product
  // sum (incomplete breakdown), the page's own number still wins.
  const text = GROK_DIALOG_TEXT.replace('Heavy Limit used', 'Heavy Limit 31% used')
  const parsed = parseGrokUsageDialogText(text, GROK_NOW)
  assert.strictEqual(parsed.percentUsed, 31, 'higher stated total must win over a lower product sum')
  assert.strictEqual(parsed.subModels.length, 3, 'breakdown rows still surface')
}

function testGrokStalledHeadlineDefersToProductSum() {
  // Live bug 2026-07-31 → 2026-08-01: rAF headline freezes at 1% while static
  // product rows keep climbing (Grok Build 8% + Chat 1%). Healthy history
  // shows weekly total === product sum when the breakdown is present.
  const text =
    'Dialog Account Appearance Behavior Customize Data Controls Billing Usage Usage ' +
    'Weekly SuperGrok Heavy Limit 1% used Resets August 7, 2026 at 4:42 PM ' +
    'Grok Build 8% Chat 1% ' +
    'Extra Usage Credits $0.00 Additional Credits Buy Credits'
  const parsed = parseGrokUsageDialogText(text, new Date(2026, 7, 1, 20, 0, 0))
  assert(parsed, 'expected stalled-headline parse to succeed')
  assert.strictEqual(parsed.percentUsed, 9, 'product sum must replace stalled 1% headline')
  assert.strictEqual(parsed.currentUsage, 9)
  assert.strictEqual(parsed.usageUnit, 'weekly used')
  assert.strictEqual(parsed.detectedPlanTier, 'SuperGrok Heavy')
  const names = parsed.subModels.map((s) => s.name).sort()
  assert.deepStrictEqual(names, ['Chat', 'Grok Build'])
}

function testGrokMatchesObservedFourteenPercentDialog() {
  const text =
    'Dialog Account Appearance Behavior Customize Data Controls Billing Usage Usage ' +
    'Weekly SuperGrok Heavy Limit 1% used Resets August 7, 2026 at 4:42 PM ' +
    'Grok Build 13% Chat 1% ' +
    'Extra Usage Credits $0.00 Additional Credits Buy Credits'
  const parsed = parseGrokUsageDialogText(text, new Date(2026, 7, 2, 3, 0, 0))

  assert(parsed, 'expected the observed Grok dialog to parse')
  assert.strictEqual(parsed.currentUsage, 14)
  assert.strictEqual(parsed.percentUsed, 14)
  assert.deepStrictEqual(
    parsed.subModels.map((row) => [row.name, row.count]),
    [['Grok Build', 13], ['Chat', 1]]
  )
}

function testGrokZeroWeeklyWithoutProducts() {
  const parsed = parseGrokUsageDialogText(GROK_DIALOG_TEXT_ZERO_NO_PRODUCTS, GROK_NOW)
  assert(parsed, 'expected Grok parser to handle 0% used with no product rows')
  assert.strictEqual(parsed.percentUsed, 0, 'weekly SuperGrok Heavy must read 0%')
  assert.strictEqual(parsed.currentUsage, 0)
  assert.strictEqual(parsed.usageLimit, 100)
  assert.strictEqual(parsed.usageUnit, 'weekly used')
  assert.strictEqual(parsed.detectedPlanTier, 'SuperGrok Heavy')
  assert.strictEqual(parsed.subModels, undefined, 'no product rows when the dialog omits them')
  assert(parsed.agentCredits, 'expected Extra Usage Credits $0.00')
  assert.strictEqual(parsed.agentCredits.balance, 0)

  const reset = new Date(parsed.resetsAt)
  assert.strictEqual(reset.getMonth(), 6)
  assert.strictEqual(reset.getDate(), 31)
  assert.strictEqual(reset.getHours(), 16)
  assert.strictEqual(reset.getMinutes(), 42)
}

function testGrokDomHintRecoversRafEmptyHeadline() {
  // rAF-empty headline AND no products — after a weekly reset this is the
  // normal zero-usage layout. Prefer 0% weekly (with the parsed Resets date)
  // over falling back to rolling 2h pools.
  const empty =
    'Dialog Account Appearance Behavior Customize Data Controls Billing Usage Usage ' +
    'Weekly SuperGrok Heavy Limit used Resets July 31, 2026 at 4:42 PM ' +
    'Extra Usage Credits Additional Credits Buy Credits'
  const zeroDefault = parseGrokUsageDialogText(empty, GROK_NOW)
  assert(zeroDefault, 'header + Resets + no products ⇒ post-reset 0% used')
  assert.strictEqual(zeroDefault.percentUsed, 0, 'empty headline after reset must read 0%, not invent 100')
  assert.strictEqual(zeroDefault.usageUnit, 'weekly used')
  assert(zeroDefault.resetsAt, 'reset date must still parse')

  const parsed = parseGrokUsageDialogText(empty, GROK_NOW, { weeklyPct: 0, creditsUsd: 0 })
  assert(parsed, 'DOM hint must unlock the weekly parse')
  assert.strictEqual(parsed.percentUsed, 0)
  assert.strictEqual(parsed.usageUnit, 'weekly used')
  assert.strictEqual(parsed.agentCredits.balance, 0)
}

function testGrokDistrustsUncorroboratedHundredPctHint() {
  // Live bug 2026-07-31: weekly reset advanced resetsAt correctly, but the
  // CSS track (width:100%) was scraped as weeklyPct=100 with no "100% used"
  // text and no product rows → card stuck at 100% after a fresh week.
  const empty =
    'Dialog Account Appearance Behavior Customize Data Controls Billing Usage Usage ' +
    'Weekly SuperGrok Heavy Limit used Resets August 7, 2026 at 4:42 PM ' +
    'Extra Usage Credits $0.00 Additional Credits Buy Credits'
  const parsed = parseGrokUsageDialogText(empty, new Date(2026, 6, 31, 15, 0, 0), {
    weeklyPct: 100
  })
  assert(parsed, 'expected a weekly parse')
  assert.strictEqual(
    parsed.percentUsed,
    0,
    'uncorroborated 100% DOM/CSS track hint must NOT win over post-reset zero layout'
  )
  const reset = new Date(parsed.resetsAt)
  assert.strictEqual(reset.getMonth(), 7) // August
  assert.strictEqual(reset.getDate(), 7)
}

function testGrokAcceptsCorroboratedHundredPct() {
  const text =
    'Dialog Usage Weekly SuperGrok Heavy Limit 100% used Resets August 7, 2026 at 4:42 PM ' +
    'Grok Build 80% Chat 20% Extra Usage Credits $0.00'
  const parsed = parseGrokUsageDialogText(text, new Date(2026, 6, 31, 15, 0, 0))
  assert(parsed)
  assert.strictEqual(parsed.percentUsed, 100, 'real "100% used" headline must still win')
}

function testGrokDoesNotGrabDistantPctUsedAsWeeklyTotal() {
  // rAF-empty headline + an unrelated later "100% used" (not a product row)
  // must not become the weekly total via a wide non-greedy window. Post-reset
  // zero layout applies instead.
  const text =
    'Dialog Usage Weekly SuperGrok Heavy Limit used Resets August 7, 2026 at 4:42 PM ' +
    'Something else on the page 100% used Extra Usage Credits $0.00'
  const parsed = parseGrokUsageDialogText(text, new Date(2026, 6, 31, 15, 0, 0))
  assert(parsed)
  assert.strictEqual(
    parsed.percentUsed,
    0,
    'distant "100% used" must not leak into the weekly SuperGrok total'
  )
}

function testGrokWithoutWeeklySectionReturnsNull() {
  const parsed = parseGrokUsageDialogText(
    'Dialog Account Appearance Behavior Customize Data Controls Billing Usage',
    GROK_NOW
  )
  assert.strictEqual(parsed, null, 'expected null when the weekly section is absent')
}

// Live 2026-08-28 GetSandUsageStatus against Cursor Ultra + SuperGrok Heavy.
const GROK_BOT_SAND_LIVE = {
  currentPeriodStart: '2026-08-26T17:22:03.913Z',
  nextResetTimestampUtc: '2026-09-02T02:25:37.520Z',
  usagePercent: 15.46571,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
  onDemandSettings: {
    visible: true,
    eligible: true,
    dashboardUrl: 'https://cursor.com/dashboard/spending'
  },
  grokPlanLabel: 'Grok Bot Plan'
}

function testGrokBotSandLiveFifteenPercent() {
  const parsed = parseGrokBotSandJson(GROK_BOT_SAND_LIVE)
  assert(parsed)
  assert.strictEqual(parsed.kind, 'usage')
  assert.strictEqual(parsed.percentUsed, 15.46571)
  assert.strictEqual(parsed.resetsAt, '2026-09-02T02:25:37.520Z')
}

function testGrokBotSandHidesWhenNoIncludedLimit() {
  const parsed = parseGrokBotSandJson({
    usagePercent: 0,
    hasNonZeroIncludedLimit: false,
    hasAvailableUsage: false
  })
  assert.deepStrictEqual(parsed, { kind: 'none' })
}

function testGrokBotSandAcceptsSnakeCase() {
  const parsed = parseGrokBotSandJson({
    usage_percent: 8,
    next_reset_timestamp_utc: '2026-09-02T02:25:37.520Z',
    has_non_zero_included_limit: true
  })
  assert(parsed)
  assert.strictEqual(parsed.kind, 'usage')
  assert.strictEqual(parsed.percentUsed, 8)
  assert.strictEqual(parsed.resetsAt, '2026-09-02T02:25:37.520Z')
}

function testGrokBotSandRejectsEmptyPayload() {
  assert.strictEqual(parseGrokBotSandJson({}), null)
  assert.strictEqual(parseGrokBotSandJson(null), null)
}

// ── ChatGPT Codex ─────────────────────────────────────────────────────────
const CHATGPT_NOW = new Date(2026, 6, 19, 17, 30, 0)

// Captured live from chatgpt.com/codex/cloud/settings/analytics on 2026-07-19.
// Codex now draws on a single shared weekly limit — there is no 5-hour block
// on the page at all.
const CHATGPT_WEEKLY_ONLY_PAGE =
  'Code App Docs PLUS Settings General Environments Code review Connectors Analytics ' +
  'Data controls Codex Analytics 7D 1M Custom Group by: Day Usage Code review Balance ' +
  'Codex usage draws from your shared agentic usage limit Weekly usage limit 98% remaining ' +
  'Resets Jul 26, 2026 4:43 PM Credits remaining 0 Credits extend usage beyond your plan limits. ' +
  'Auto reload Loading auto reload settings... Usage breakdown Personal usage Credits usage history ' +
  'Credits remaining 0 Add more Date Service Credits used 0-0 of 0 usage events Previous Next'

// The older two-block layout, from tmp/logs/chatgpt_debug.txt.
const CHATGPT_TWO_BLOCK_PAGE = `Settings
Docs
PLUS
5 hour usage limit

40%
remaining

Weekly usage limit

75%
remaining

Code review

100%
remaining

Credits remaining
0
`

function testChatgptDoesNotInventAFiveHourReading() {
  const parsed = parseChatgptUsageText(CHATGPT_WEEKLY_ONLY_PAGE, CHATGPT_NOW)

  assert(parsed, 'expected ChatGPT parser to return usage data')
  // The regression: an untethered "(\d+)% remaining" fallback matched the
  // WEEKLY bar and reported 98 as the 5-hour reading, so the card showed one
  // number twice with one copy mislabelled "5-HOUR LIMIT".
  assert.strictEqual(parsed.usageUnit, '% weekly limit', 'weekly must not be relabelled as 5-hour')
  assert.strictEqual(parsed.percentUsed, 98)
  assert.strictEqual(parsed.isRemainingTracker, true)
  assert.strictEqual(parsed.weeklyPercentUsed, null, 'no second bar when weekly IS the primary')
  assert.ok(!parsed.renewalDate, 'analytics usage reset must not be treated as subscription renewal')

  const d = new Date(parsed.resetsAt)
  assert.strictEqual(d.getFullYear(), 2026)
  assert.strictEqual(d.getMonth(), 6)
  assert.strictEqual(d.getDate(), 26)
  assert.strictEqual(d.getHours(), 16)
  assert.strictEqual(d.getMinutes(), 43)
}

function testChatgptTwoBlockLayoutKeepsBothBars() {
  const parsed = parseChatgptUsageText(CHATGPT_TWO_BLOCK_PAGE, CHATGPT_NOW)

  assert(parsed, 'expected ChatGPT parser to return usage data')
  assert.strictEqual(parsed.usageUnit, '% 5-hour limit')
  assert.strictEqual(parsed.percentUsed, 40, '5-hour bar takes the 5-hour block')
  assert.strictEqual(parsed.weeklyPercentUsed, 75, 'weekly bar takes the weekly block')
  assert.strictEqual(parsed.weeklyBarLabel, 'Weekly Limit')
  assert.strictEqual(parsed.isRemainingTracker, true)
  // Verbatim from the page chip, which renders all-caps.
  assert.strictEqual(parsed.detectedPlanTier, 'PLUS')

  // Neither bar may borrow the other's block, and the third "Code review"
  // block (also "100% remaining") belongs to neither.
  assert.notStrictEqual(parsed.percentUsed, parsed.weeklyPercentUsed)
  assert.notStrictEqual(parsed.percentUsed, 100)
}

function testChatgptFiveHourNeverBorrowsTheWeeklyReset() {
  const parsed = parseChatgptUsageText(CHATGPT_TWO_BLOCK_PAGE, CHATGPT_NOW)
  // This layout carries no reset timestamps. The 5-hour row used to fall back
  // to globalResetsAt - the weekly reset - so the card rendered a multi-day
  // countdown next to a five-hour window.
  assert.strictEqual(parsed.resetsAt, null, '5-hour reset must not fall back to the weekly one')
}

function testChatgptResetTimeSkipsWordsEndingInAm() {
  // "(.+?(?:AM|PM|am|pm))" under /i matched the "am" inside "Team" and
  // truncated the capture before reaching the real clock value.
  const parsed = parseChatgptUsageText(
    'Weekly usage limit 10% remaining Resets at Team plan holders 10:42 AM',
    CHATGPT_NOW
  )
  assert(parsed, 'expected usage data')
  assert(parsed.resetsAt, 'expected a parsed reset time, not a null from matching "Team"')
  assert.strictEqual(new Date(parsed.resetsAt).getHours(), 10)
  assert.strictEqual(new Date(parsed.resetsAt).getMinutes(), 42)
}

function testChatgptNoLimitsReturnsNull() {
  const parsed = parseChatgptUsageText('Settings Docs General Environments Connectors', CHATGPT_NOW)
  assert.strictEqual(parsed, null, 'expected null when the page carries no limits')
}

// Captured shape matching %APPDATA%/agent-stats/usage-cache.json on 2026-08-20:
// 5-hour 100% remaining + weekly 96% remaining + Spark carve-out. Must keep
// BOTH windows — the card used to drop 5-hour because DualWindow excluded chatgpt.
const CHATGPT_LIVE_2026_08_20_PAGE =
  'Code App Docs PRO Settings General Environments Code review Connectors Analytics ' +
  'Data controls Codex Analytics Usage Code review Balance ' +
  '5 hour usage limit 100% remaining ' +
  'Weekly usage limit 96% remaining Resets Aug 27, 2026 1:55 PM ' +
  'GPT-5.3-Codex-Spark 100% remaining ' +
  'Credits remaining 0 Credits extend usage beyond your plan limits.'

function testChatgptLiveTwoBlockKeepsFiveHourAndWeekly() {
  const parsed = parseChatgptUsageText(CHATGPT_LIVE_2026_08_20_PAGE, new Date(2026, 7, 20, 12, 0, 0))
  assert(parsed, 'expected ChatGPT parser to return usage data')
  assert.strictEqual(parsed.usageUnit, '% 5-hour limit')
  assert.strictEqual(parsed.percentUsed, 100, '5-hour remaining stays on the 5-hour field')
  assert.strictEqual(parsed.weeklyPercentUsed, 96, 'weekly remaining stays on the weekly field')
  assert.strictEqual(parsed.weeklyBarLabel, 'Weekly Limit')
  assert.strictEqual(parsed.isRemainingTracker, true)
  assert.notStrictEqual(parsed.percentUsed, parsed.weeklyPercentUsed)
  const spark = (parsed.subModels || []).find((row) => /spark/i.test(row.name || row.modelName || ''))
  assert(spark, 'expected GPT-5.3-Codex-Spark carve-out')
  assert.strictEqual(spark.count, 100)
}

function testChatgptScraperForceReloadsAndWaitsForBothWindows() {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/main/scrapers/chatgptScraper.ts'), 'utf8')
  assert.match(src, /forceReload:\s*true/, 'ChatGPT analytics is a parked SPA — must reload')
  assert.match(src, /has5 && hasWeekly/, 'must wait for 5-hour AND weekly meters when both exist')
  assert.doesNotMatch(
    src,
    /reapOrphanManagedChromes\('chatgpt'\)/,
    'scrape must not reap the live ChatGPT Chrome'
  )
  const card = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/UsageCard.tsx'), 'utf8')
  assert.match(card, /hasDualWindowBars/, 'Codex dual bars go through DualWindow, not the weekly mini-bar')
}

// ── Claude ────────────────────────────────────────────────────────────────
// Sunday 2026-07-19 15:20 local. Fixed so the "Resets Thu 6:00 PM" bucket
// arithmetic (next Thursday = the 23rd) is deterministic.
const CLAUDE_NOW = new Date(2026, 6, 19, 15, 20, 0)

// Real claude.ai/new#settings/usage innerText: the settings panel over the
// chat shell, with the temporary-boost paragraph and a chat-shell
// conversation title carrying its own percentage.
const CLAUDE_USAGE_PAGE = `Claude
New chat
Chats
Projects
Search
Settings
General
Account
Privacy
Billing
Usage
Capabilities
Claude Code
Cowork
Claude in Chrome
Skills
Connectors
Plugins
Memory
Plan usage limits
Max (20x)
Current session
Starts when a message is sent
0% used
Weekly limits
Your limits are temporarily boosted. Your weekly Claude Code limit is 50% higher through August 19, and your Cowork limit is 100% higher through August 5. When each promotion ends, limits return to your plan's standard amounts.
Learn more about usage limits
All models
Resets Thu 6:00 PM
52% used
Fable
Resets Thu 6:00 PM
78% used
Last updated: 1 minute ago
How can I help you today?
Opus benchmark: 91% used vs baseline
Sonnet refactor notes
`

function testClaudeCapturesEveryWeeklyBucket() {
  const parsed = parseClaudeUsageText(CLAUDE_USAGE_PAGE, CLAUDE_NOW)

  assert(parsed, 'expected Claude parser to return usage data')
  assert.strictEqual(parsed.detectedPlanTier, 'Max (20x)')
  assert.strictEqual(parsed.percentUsed, 0)
  assert.strictEqual(parsed.usageUnit, 'session used')
  assert.strictEqual(parsed.weeklyPercentUsed, 52, 'aggregate "All models" drives the weekly bar')

  // The regression: "Fable" was absent from the hardcoded bucket allowlist
  // (All models|Sonnet|Opus|Haiku), so this bar never reached the card.
  assert(parsed.subModels, 'expected per-model weekly buckets')
  const fable = parsed.subModels.find((s) => s.name === 'Fable')
  assert(fable, 'expected a Fable weekly bucket')
  assert.strictEqual(fable.count, 78)
  assert.strictEqual(fable.total, 100)

  // "All models" is the weekly bar, never also a sub-row.
  assert(
    !parsed.subModels.some((s) => /all models/i.test(s.name)),
    'aggregate bucket must not be duplicated as a sub-row'
  )
  assert.strictEqual(parsed.subModels.length, 1, 'exactly one per-model bucket on this page')
}

function testClaudeIgnoresBoostParagraphAndChatShell() {
  const parsed = parseClaudeUsageText(CLAUDE_USAGE_PAGE, CLAUDE_NOW)
  const counts = parsed.subModels.map((s) => s.count)

  // "...limit is 50% higher... Cowork limit is 100% higher..." must never be
  // read as a usage bar.
  assert(!counts.includes(50), 'boost paragraph 50% leaked into a bucket')
  assert(!counts.includes(100), 'boost paragraph 100% leaked into a bucket')

  // A conversation title behind the modal ("Opus benchmark: 91% used") sits
  // outside the panel; slicing to end-of-page used to invent a bucket for it.
  assert(!counts.includes(91), 'chat-shell percentage leaked into a bucket')
  assert(
    !parsed.subModels.some((s) => /opus|sonnet/i.test(s.name)),
    'chat-shell model names must not become weekly buckets'
  )
}

function testClaudeWeeklyResetAndNoSessionResetBleed() {
  const parsed = parseClaudeUsageText(CLAUDE_USAGE_PAGE, CLAUDE_NOW)

  // "Resets Thu 6:00 PM" from Sunday the 19th → Thursday the 23rd, 18:00.
  const weekly = new Date(parsed.weeklyResetsAt)
  assert.strictEqual(weekly.getDay(), 4, 'weekly reset should land on a Thursday')
  assert.strictEqual(weekly.getDate(), 23)
  assert.strictEqual(weekly.getHours(), 18)

  // This page has no session reset ("Starts when a message is sent"). The
  // forward scan used to run into the Weekly block and report the weekly
  // reset as the session's.
  assert.strictEqual(parsed.resetsAt, null, 'session reset must not borrow the weekly one')
}

function testClaudeResetTimeIsCaseInsensitive() {
  // The capture regex is /i but the day lookup was not, so "THU" resolved to
  // index -1 and produced a date in the wrong week instead of failing.
  const upper = parseClaudeResetTime('THU 6:00 PM', CLAUDE_NOW)
  const mixed = parseClaudeResetTime('Thu 6:00 PM', CLAUDE_NOW)
  assert.strictEqual(upper, mixed, 'day-of-week lookup must be case-insensitive')
  assert.strictEqual(new Date(upper).getDay(), 4)
}

function testClaudeLoginPageReturnsNull() {
  const parsed = parseClaudeUsageText('Log in\nSign up\nContinue with Google\n', CLAUDE_NOW)
  assert.strictEqual(parsed, null, 'expected null on the signed-out page')
}

function testRenewalDateChatgptPlusCopy() {
  const parsed = parseRenewalDate(
    'Plus plan. Your ChatGPT Plus subscription renews on September 12, 2026. Manage subscription'
  )
  assert(parsed, 'expected ChatGPT Plus renewal copy to parse')
  assert.strictEqual(parsed.date, '2026-09-12')
  assert.strictEqual(parsed.kind, 'renewing')
}

function testRenewalDateNextBillingAndPeriodEnd() {
  const billing = parseRenewalDate('Account Next billing date: Sep 12, 2026 Manage subscription')
  assert(billing, 'expected next billing date to parse')
  assert.strictEqual(billing.date, '2026-09-12')
  assert.strictEqual(billing.kind, 'renewing')

  const period = parseRenewalDate('Current period ends September 12, 2026')
  assert(period, 'expected current period end to parse as renewing, not cancelled')
  assert.strictEqual(period.date, '2026-09-12')
  assert.strictEqual(period.kind, 'renewing')
}

function testRenewalDateGrokBillingCopy() {
  const parsed = parseRenewalDate(
    'Billing SuperGrok Your SuperGrok plan renews on September 1, 2026 Manage Subscription'
  )
  assert(parsed, 'expected SuperGrok billing copy to parse')
  assert.strictEqual(parsed.date, '2026-09-01')
  assert.strictEqual(parsed.kind, 'renewing')
}

function testRenewalDateIgnoresGrokWeeklyReset() {
  const parsed = parseRenewalDate(GROK_DIALOG_TEXT)
  assert.strictEqual(parsed, null, 'usage-dialog "Resets July 24" is not a subscription date')
}

function testRenewalDateCancelledAmericanSpelling() {
  const parsed = parseRenewalDate('Your plan is canceled September 12, 2026. Access continues until then.')
  assert(parsed, 'expected canceled (one L) copy to parse')
  assert.strictEqual(parsed.date, '2026-09-12')
  assert.strictEqual(parsed.kind, 'cancelled')
}

function testRenewalFromJsonPeriodEnd() {
  const parsed = parseRenewalFromJson({
    plan_type: 'plus',
    will_renew: true,
    current_period_end: '2026-09-12T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z'
  })
  assert(parsed, 'expected JSON current_period_end to parse')
  assert.strictEqual(parsed.date, '2026-09-12')
  assert.strictEqual(parsed.kind, 'renewing')
}

function testRenewalFromJsonCancelAtPeriodEnd() {
  const parsed = parseRenewalFromJson({
    cancel_at_period_end: true,
    current_period_end: Math.floor(Date.parse('2026-09-12T00:00:00Z') / 1000)
  })
  assert(parsed, 'expected unix current_period_end to parse')
  assert.strictEqual(parsed.kind, 'cancelled')
  assert.strictEqual(parsed.date, '2026-09-12')
}

function testChatgptSettingsCopyStampsRenewalOnUsageParse() {
  const parsed = parseChatgptUsageText(
    'Weekly usage limit 98% remaining Resets Jul 26, 2026 4:43 PM ' +
      'Your Plus plan renews on September 12, 2026',
    CHATGPT_NOW
  )
  assert(parsed, 'expected usage+billing combined text to parse')
  assert.strictEqual(parsed.renewalDate, '2026-09-12')
  assert.strictEqual(parsed.renewalKind, 'renewing')
}

testCursorIncludedUsageLayout()
testCursorDollarRatioWithoutPercent()
testCursorRetiredAutoComposerLayout()
testCursorRealSpendingLayout()
testCursorUltraCursorAndOtherModelsLayout()
testCursorNamedPoolsKeepDistinctPercents()
testCursorFlattenedSpendingTextKeepsBothPools()
testCursorPlanAndUsageFirstPartyApiLayout()
testCursorSummaryOverridesStaleOtherModelsZero()
testCursorFlattenedPlanAndUsageKeepsApiPercent()
testCursorPeriodUsageJsonMatchesPlanAndUsage()
testCursorPeriodUsageJsonConnectWrapperAndUnixMs()
testCursorLivePlanAndUsageJsonHeadlinesOfficialTotal()
testCursorApiOverridesStaleDomTwoAndFourteen()
testCursorApiOverridesStaleDomOtherModelsZero()
testCursorLoginPageReturnsNull()
testCursorChallengePageReturnsNull()
testKimiMembershipQuotaPage()
testKimiMembershipWithoutQuotaReturnsNull()
testKimiMembershipLogInWithGoogleShellReturnsNull()
testKimiMembershipVivacePlan()
testClaudeCapturesEveryWeeklyBucket()
testClaudeIgnoresBoostParagraphAndChatShell()
testClaudeWeeklyResetAndNoSessionResetBleed()
testClaudeResetTimeIsCaseInsensitive()
testClaudeLoginPageReturnsNull()
testChatgptDoesNotInventAFiveHourReading()
testChatgptTwoBlockLayoutKeepsBothBars()
testChatgptFiveHourNeverBorrowsTheWeeklyReset()
testChatgptResetTimeSkipsWordsEndingInAm()
testChatgptNoLimitsReturnsNull()
testChatgptLiveTwoBlockKeepsFiveHourAndWeekly()
testChatgptScraperForceReloadsAndWaitsForBothWindows()
testGrokReconstructsWeeklyTotalFromProducts()
testGrokPrefersTheStatedTotalOverTheSum()
testGrokStalledHeadlineDefersToProductSum()
testGrokMatchesObservedFourteenPercentDialog()
testGrokZeroWeeklyWithoutProducts()
testGrokDomHintRecoversRafEmptyHeadline()
testGrokDistrustsUncorroboratedHundredPctHint()
testGrokAcceptsCorroboratedHundredPct()
testGrokDoesNotGrabDistantPctUsedAsWeeklyTotal()
testGrokWithoutWeeklySectionReturnsNull()
testGrokBotSandLiveFifteenPercent()
testGrokBotSandHidesWhenNoIncludedLimit()
testGrokBotSandAcceptsSnakeCase()
testGrokBotSandRejectsEmptyPayload()
testGeminiWebUsagePanel()
testGeminiWebResetsAreScopedToTheirOwnSection()
testGeminiWebTimeOnlyResetRollsToTomorrow()
testGeminiWebSignedOutReturnsNull()
testQwenSubscriptionWindows()
testQwenHyphenatedHeaders()
testQwenQuotaHeaders()
testQwenLoginShellReturnsNull()
testQwenBareRemainingWithoutWindowsReturnsNull()
testQwenSevenDayOnlyDoesNotDuplicateBars()
testQwenFiveHourOnlyDoesNotInventWeekly()
testQwenCloneWindowsCollapseToSingleBar()
testQwenFiveHourTemporarilyLiftedDualBars()
testQwenMultilineLiftedPageText()
testQwenLoginChromeWithLiftedUsageStillParses()
testQwenTemporarilyRemovedDualBars()
testQwenMultilineTemporarilyRemovedPageText()
testQwenLiveSevenDayOnlyFrom20260815()
testQwenBothHeadersLoneSevenDayIsIncomplete()
testQwenUsageJsonDualWindows()
testQwenScraperForceReloadsParkedTab()

testRenewalDateChatgptPlusCopy()
testRenewalDateNextBillingAndPeriodEnd()
testRenewalDateGrokBillingCopy()
testRenewalDateIgnoresGrokWeeklyReset()
testRenewalDateCancelledAmericanSpelling()
testRenewalFromJsonPeriodEnd()
testRenewalFromJsonCancelAtPeriodEnd()
testChatgptSettingsCopyStampsRenewalOnUsageParse()

console.log('usage text parser tests passed')
