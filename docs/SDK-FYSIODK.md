# FysioDK / compliance integration (F003.4)

Upmetrics is **operational observability**, never a compliance audit log. For
regulated apps (FysioDK, health sector) the app owns its own legally-binding
audit log; Upmetrics receives only sanitized operational telemetry. `@upmetrics/
agent` gives you one code path with two outputs.

| Aspect            | App audit log (source of truth) | Upmetrics agent_runs        |
| ----------------- | ------------------------------- | --------------------------- |
| Legally binding   | Yes                             | No (telemetry copy)         |
| Storage           | App's own DB                    | Upmetrics DB                |
| Retention         | 5–10 years                      | 30 days (default)           |
| Failure mode      | Synchronous, blocks request     | Fire-and-forget, may drop   |
| Cleartext PII     | Per app's legal basis           | **Never**                   |

## Compliance mode

```ts
import { configureAgent } from '@upmetrics/agent';

configureAgent({
  baseUrl: 'https://upmetrics.org',
  apiKey: process.env.UPMETRICS_API_KEY!,
  complianceMode: true, // force-strips prompt/response excerpts; tags compliance:'gdpr-health'
});
```

When `complianceMode: true`, the SDK **never** sends `prompt_excerpt` /
`response_excerpt` (even if a caller passes them) and tags every run
`compliance: 'gdpr-health'` so they can be filtered/exported on a DSAR.

## One code path, two outputs

```ts
import { agentRun } from '@upmetrics/agent';

const { result, auditRecord } = await agentRun(
  {
    agent_kind: 'chatbot',
    agent_name: 'fysiodk-symptom-checker',
    purpose: 'symptom_screening', // formål
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    tier: 'smart',
    session_id: requestId,
  },
  async (ctx) => {
    const res = await anthropic.messages.create({ /* ... */ });
    ctx.recordTokens({ input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens });
    return res;
  },
  { returnAuditRecord: true },
);

// App side: persist the audit record SYNCHRONOUSLY before responding to the user.
await db.insert(aiAuditLog).values({ user_id, request_id, ...auditRecord });
// (Upmetrics already received the same sanitized telemetry async.)
```

`auditRecord` contains **only**: `timestamp`, `agent_kind`, `agent_name`,
`purpose`, `provider`, `model`, `tier`, `status`, `input_tokens`,
`output_tokens`, `cost_usd`, `duration_ms`, `error_class?`. **Never** prompt/
response text, never cleartext user data.

## What this helper is NOT

It does not give you tamper-evidence, hash-chaining, or GDPR export — those are
the app's responsibility on its own audit-log table. `@upmetrics/agent` only
provides the structured fields + the sanitized-telemetry side.
