# AI Services Usage/Billing API Research Report

**Date:** 2026-02-21  
**Researcher:** AI Agent  
**Purpose:** Evaluate official API availability for usage/billing data across major AI services

---

## Executive Summary

| Service | Usage/Billing API | Authentication | Priority |
|---------|------------------|----------------|----------|
| **OpenAI** | ✅ YES (Official) | Admin API Key | HIGH |
| **RunwayML** | ✅ YES (Official) | Bearer Token | HIGH |
| **Fal.ai** | ✅ YES (Official) | Admin API Key | HIGH |
| **Anthropic Claude** | ⚠️ Partial/Limited | API Key | MEDIUM |
| **Google AI Studio** | ⚠️ Partial (Cloud Monitoring) | Service Account | MEDIUM |
| **Kimi/Moonshot** | ❌ NO | N/A | LOW |
| **MiniMax** | ❌ NO | N/A | LOW |

---

## 1. OpenAI (ChatGPT)

### API Availability: ✅ YES

**Official Documentation:** https://platform.openai.com/docs/api-reference/usage

### Endpoints Available

| Endpoint | Description |
|----------|-------------|
| `GET /v1/organization/usage/completions` | Completions usage details |
| `GET /v1/organization/usage/embeddings` | Embeddings usage details |
| `GET /v1/organization/usage/moderations` | Moderations usage details |
| `GET /v1/organization/usage/images` | Image generation usage |
| `GET /v1/organization/usage/audio_speeches` | TTS usage |
| `GET /v1/organization/usage/audio_transcriptions` | Whisper usage |
| `GET /v1/organization/usage/code_interpreter` | Code interpreter sessions |
| `GET /v1/organization/costs` | Cost breakdown by invoice line items |

### Authentication

```http
Authorization: Bearer $OPENAI_ADMIN_KEY
Content-Type: application/json
```

**Note:** Requires an **Admin API Key** (different from standard API key). Organization owners can generate Admin keys from the dashboard.

### Rate Limits

- Varies by organization tier
- Usage API has separate rate limits from inference API
- Supports pagination with `limit` and `next_page` parameters

### Sample Response Structure

```json
{
    "object": "page",
    "data": [
        {
            "object": "bucket",
            "start_time": 1730419200,
            "end_time": 1730505600,
            "results": [
                {
                    "object": "organization.usage.completions.result",
                    "input_tokens": 1000,
                    "output_tokens": 500,
                    "input_cached_tokens": 800,
                    "input_audio_tokens": 0,
                    "output_audio_tokens": 0,
                    "num_model_requests": 5,
                    "project_id": null,
                    "user_id": null,
                    "api_key_id": null,
                    "model": "gpt-4o-mini-2024-07-18",
                    "batch": false,
                    "service_tier": "default"
                }
            ]
        }
    ],
    "has_more": true,
    "next_page": "page_AAAAAGdGxdEiJdKOAAAAAGcqsYA="
}
```

### Implementation Notes

- **Time bucketing:** Supports `1m`, `1h`, `1d` bucket widths
- **Grouping:** Can group by `project_id`, `user_id`, `api_key_id`, `model`, `batch`, `service_tier`
- **Costs endpoint:** Use for financial reconciliation (matches invoices)

### SDKs Available

- Official Python SDK: `openai`
- Official Node.js SDK: `openai`

---

## 2. RunwayML

### API Availability: ✅ YES

**Official Documentation:** https://docs.dev.runwayml.com/api

### Endpoints Available

| Endpoint | Description |
|----------|-------------|
| `GET /v1/organization` | Get organization info (tier, credit balance) |
| `POST /v1/organization/usage` | Query credit usage by model and day |

### Authentication

```http
Authorization: Bearer {API_KEY}
X-Runway-Version: 2024-11-06
```

**API Key Source:** Generated from RunwayML Developer Portal (https://dev.runwayml.com/)

### Data Returned

- **Credit balance** (current available credits)
- **Usage tier** (max monthly spend, model limits)
- **Daily credit usage** by model
- **Daily generation counts** by model

### Sample Response: Organization Info

```json
{
    "tier": {
        "maxMonthlyCreditSpend": 9007199254740991,
        "models": {
            "gen4.5": {
                "maxConcurrentGenerations": 9007199254740991,
                "maxDailyGenerations": 9007199254740991
            }
        }
    },
    "creditBalance": 9007199254740991,
    "usage": {
        "models": {
            "gen4.5": {
                "dailyGenerations": 9007199254740991
            }
        }
    }
}
```

### Sample Response: Usage Query

```json
{
    "results": [
        {
            "date": "2019-08-24",
            "usedCredits": [
                {"model": "gen4.5", "amount": 9007199254740991}
            ]
        }
    ],
    "models": ["gen4.5"]
}
```

### Implementation Notes

- Credits purchased at $0.01 per credit
- Different from web app credits (API credits are separate)
- Supports up to 90 days of usage data per query
- Date format: ISO-8601 (YYYY-MM-DD)

### Rate Limits

- Tier-based rate limits
- Max 90 days per usage query

### SDKs Available

- Official Node.js SDK: `@runwayml/sdk`
- Official Python SDK available

---

## 3. Fal.ai

### API Availability: ✅ YES

**Official Documentation:** https://docs.fal.ai/platform-apis/v1/models/usage

### Endpoints Available

| Endpoint | Description |
|----------|-------------|
| `GET /v1/models/usage` | Usage statistics with time series data |
| `GET /v1/models/pricing` | Pricing information per endpoint |

### Authentication

```http
Authorization: Key YOUR_ADMIN_API_KEY
```

**Note:** Requires **Admin Scope API Key** (different from regular API key). Available from dashboard at fal.ai/dashboard/keys

### Query Parameters

| Parameter | Description |
|-----------|-------------|
| `start_date` | ISO8601 format (e.g., '2025-01-01T00:00:00Z') |
| `end_date` | ISO8601 format |
| `timeframe` | Aggregation: `minute`, `hour`, `day`, `week`, `month` |
| `endpoint_id` | Filter by specific endpoint(s) |
| `expand` | Include `time_series`, `summary`, `auth_method` |

### Response Structure

```json
{
    "next_cursor": "string",
    "has_more": true,
    "time_series": [
        {
            "timestamp": "2025-01-01T00:00:00Z",
            "endpoint_id": "model_name",
            "requests": 100,
            "credits_used": 500
        }
    ],
    "summary": {
        "total_requests": 1000,
        "total_credits": 5000
    }
}
```

### Implementation Notes

- Admin scope required for usage data
- Supports filtering by up to 50 endpoint IDs
- Timezone support for date aggregation
- Auto-detection of timeframe based on date range

### Rate Limits

- 2 concurrent tasks per user (default)
- Upgraded to 40 concurrent tasks with $1,000+ in credits

### SDKs Available

- Python SDK available
- JavaScript/TypeScript SDK available

---

## 4. Anthropic Claude

### API Availability: ⚠️ PARTIAL / LIMITED

**Official Documentation:** https://platform.claude.com/docs/en/api/overview

### Current Status

Anthropic **does NOT** provide a public API for fetching organization usage/billing data. The API reference only covers inference (messages API), not usage analytics.

### What IS Available

- **Inference API:** https://api.anthropic.com/v1/messages
- **API Key Management:** Limited admin endpoints (may require special access)

### Authentication for Inference

```http
x-api-key: YOUR_API_KEY
anthropic-version: 2023-06-01
Content-Type: application/json
```

### Workarounds

1. **Track usage manually:** Count tokens from API responses (response includes `usage` field)
2. **Console scraping:** Access billing data through web console (requires session cookie)
3. **Admin API (limited):** Some organization endpoints exist but require special permissions

### Response Includes Usage (Per Request)

```json
{
    "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
    "type": "message",
    "role": "assistant",
    "content": [...],
    "model": "claude-sonnet-4-5-20250929",
    "usage": {
        "input_tokens": 15,
        "output_tokens": 9
    }
}
```

### Recommendation

**MUST USE SCRAPING** - No official usage/billing API available. Must track manually per-request or scrape console.

---

## 5. Google AI Studio / Gemini API

### API Availability: ⚠️ PARTIAL (via Cloud Monitoring)

**Official Documentation:** 
- https://ai.google.dev/gemini-api/docs/billing
- https://cloud.google.com/apis/docs/monitoring

### Current Status

Google AI Studio itself does not have a direct usage API. Usage data is available through:

1. **Google Cloud Monitoring API** (for paid tier projects)
2. **Google Cloud Billing API** (for cost data)

### Endpoints (via Cloud Monitoring)

| Endpoint | Description |
|----------|-------------|
| Cloud Console API Dashboard | Manual viewing only |
| `serviceruntime.googleapis.com/api/request_count` | Request count metrics |
| `serviceruntime.googleapis.com/api/request_latencies` | Latency metrics |
| Cloud Billing API | Cost/invoice data |

### Authentication

```http
Authorization: Bearer {GCP_ACCESS_TOKEN}
```

Requires Google Cloud Service Account with appropriate permissions:
- `monitoring.metricDescriptors.list`
- `monitoring.timeSeries.list`
- `billing.accounts.get`

### Data Available via Cloud Monitoring

- Request counts (by response code)
- Latency metrics (p50, p95, p99)
- Error rates
- Quota usage

### Implementation Notes

- Requires Cloud Billing enabled on project
- Free tier usage is NOT available via API
- Must use Google Cloud Monitoring API (separate from Gemini API)
- Complex setup requiring GCP project

### Recommendation

**PARTIAL API** - Requires GCP integration. For simple usage tracking, scraping may be more practical.

---

## 6. Kimi / Moonshot AI

### API Availability: ❌ NO

**Official Documentation:** https://platform.moonshot.cn/docs/api/chat

### Current Status

Moonshot AI provides an OpenAI-compatible inference API but **NO official usage/billing API**.

### What IS Available

- Inference API: https://api.moonshot.ai/v1/chat/completions
- Console dashboard for manual viewing

### Authentication

```http
Authorization: Bearer $MOONSHOT_API_KEY
```

### Workarounds

1. **Per-request tracking:** API responses include usage field:

```json
{
    "usage": {
        "prompt_tokens": 8,
        "completion_tokens": 183,
        "total_tokens": 191
    }
}
```

2. **Console scraping:** Must scrape platform.moonshot.cn for balance/usage

### Recommendation

**MUST USE SCRAPING** - No official usage/billing API available.

---

## 7. MiniMax

### API Availability: ❌ NO

**Official Documentation:** https://platform.minimax.io/

### Current Status

MiniMax provides OpenAI-compatible and Anthropic-compatible inference APIs but **NO official usage/billing API**.

### What IS Available

- Text generation API: https://api.minimax.io/v1
- Speech synthesis API: https://api.minimax.io/v1/audio/synthesis
- Console dashboard for manual viewing

### Authentication

```http
Authorization: Bearer YOUR_MINIMAX_API_KEY
```

### Pricing Model

- **Pay-as-you-go:** $0.3 per million input tokens, $1.2 per million output tokens
- **Subscription plans:** Starter ($10/month), Plus ($20/month), Max ($50/month)

### Rate Limits

| Tier | RPM | TPM |
|------|-----|-----|
| Free tier | 20 | 1,000,000 |
| M2-Stable | 500 | 20,000,000 |

### Workarounds

Must track usage manually per request or scrape console at platform.minimax.io

### Recommendation

**MUST USE SCRAPING** - No official usage/billing API available.

---

## Priority Ranking for Implementation

### Tier 1: Implement First (Official APIs Available)

| Rank | Service | Ease | Reason |
|------|---------|------|--------|
| 1 | **OpenAI** | Easy | Full-featured official API, Admin keys available, comprehensive data |
| 2 | **RunwayML** | Easy | Simple REST API, clear credit-based system, good documentation |
| 3 | **Fal.ai** | Easy | Admin API available, time-series data, flexible queries |

### Tier 2: Secondary Priority (Limited or Complex APIs)

| Rank | Service | Ease | Reason |
|------|---------|------|--------|
| 4 | **Google AI Studio** | Medium | Requires GCP integration, Cloud Monitoring API |
| 5 | **Anthropic Claude** | Hard | No official API, must scrape or track manually |

### Tier 3: Last Priority (No APIs - Must Scrape)

| Rank | Service | Ease | Reason |
|------|---------|------|--------|
| 6 | **Kimi/Moonshot** | Hard | No API, requires scraping |
| 7 | **MiniMax** | Hard | No API, requires scraping |

---

## Recommended Authentication Approach for Electron App

### Secure Storage

```typescript
// Main process only - never expose in renderer
interface ServiceCredentials {
  openai?: {
    adminKey: string;  // sk-admin-...
  };
  runwayml?: {
    apiKey: string;  // Bearer token
  };
  fal?: {
    adminKey: string;  // Key xxx
  };
  // For services requiring scraping
  anthropic?: {
    sessionCookie: string;  // HttpOnly cookie
  };
  moonshot?: {
    sessionCookie: string;
  };
  minimax?: {
    sessionCookie: string;
  };
  googleAIStudio?: {
    gcpServiceAccount: object;  // JSON key file
  };
}
```

### Best Practices

1. **Store credentials in main process only** using `electron-store` or `keytar`
2. **Use contextBridge** to expose limited APIs to renderer
3. **Implement encrypted storage** for sensitive tokens
4. **Support credential rotation** - allow users to update keys
5. **Validate keys on save** - test API connectivity before storing

---

## Implementation Summary

### Services with Official APIs (MUST IMPLEMENT)

```
✅ OpenAI      → /v1/organization/usage/*
✅ RunwayML    → /v1/organization, /v1/organization/usage
✅ Fal.ai      → /v1/models/usage
```

### Services Requiring Scraping (FALLBACK)

```
⚠️ Anthropic Claude  → console.anthropic.com
⚠️ Google AI Studio  → aistudio.google.com OR Cloud Monitoring API
❌ Kimi/Moonshot     → platform.moonshot.cn
❌ MiniMax           → platform.minimax.io
```

---

## Documentation Links

| Service | API Docs | Usage/Billing Docs |
|---------|----------|-------------------|
| OpenAI | https://platform.openai.com/docs/api-reference | https://platform.openai.com/docs/api-reference/usage |
| RunwayML | https://docs.dev.runwayml.com/api | https://docs.dev.runwayml.com/guides/pricing/ |
| Fal.ai | https://docs.fal.ai/model-apis | https://docs.fal.ai/platform-apis/v1/models/usage |
| Anthropic | https://platform.claude.com/docs/en/api/overview | N/A (no usage API) |
| Google AI Studio | https://ai.google.dev/gemini-api/docs | https://ai.google.dev/gemini-api/docs/billing |
| Kimi/Moonshot | https://platform.moonshot.cn/docs/api/chat | N/A (no usage API) |
| MiniMax | https://platform.minimax.io/ | N/A (no usage API) |

---

*Report generated by AI Agent on 2026-02-21*
