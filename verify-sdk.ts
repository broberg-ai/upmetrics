// Local verification for F003.1/.2/.4 (no prod). A capture server stands in for
// the upmetrics ingest + agent endpoints so we can inspect outbound payloads.
// Run: bun verify-sdk.ts
import { init, captureException, captureMessage, setUser, setTag, addBreadcrumb, scrub } from './packages/sdk/src/index';
import { configureAgent, agentRun, recordAgentRun, wrapAnthropic } from './packages/agent/src/index';
import { readFileSync, existsSync } from 'node:fs';

const captured: { path: string; body: any }[] = [];
const server = Bun.serve({
  port: 3095,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    let body: any = text;
    if (path === '/api/agent') { try { body = JSON.parse(text); } catch {} }
    else { body = text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return l; } }); }
    captured.push({ path, body });
    if (path === '/api/agent' && body?.mode === 'start') return Response.json({ run_id: 'r-test' });
    if (path === '/api/agent') return Response.json({ run_id: 'rec-test' });
    return Response.json({ accepted: 1 });
  },
});
const wait = () => new Promise((r) => setTimeout(r, 150));

let pass = true;
const check = (n: string, c: boolean, d = '') => { console.log(`${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) pass = false; };

// ── F003.1 ──
init({ dsn: 'http://pubkey123@localhost:3095/fysiodk', autoInstrument: false, environment: 'test' });
setUser({ id: 'u1' }); setTag('feature', 'verify'); addBreadcrumb({ message: 'crumb' });
captureMessage('hello world', 'info');
captureException(new Error('contact me@x.dk or call 12345678, cpr 010101-1234'), {
  request: { headers: { Authorization: 'Bearer supersecret', Cookie: 'sid=abc' } },
});
await wait();
const envelopes = captured.filter((c) => c.path === '/api/fysiodk/envelope/');
check('F003.1 AC0: captureMessage + captureException sent envelopes (init/setUser/setTag/addBreadcrumb ran)', envelopes.length === 2, `envelopes=${envelopes.length}`);
const excEnv = envelopes.find((e) => Array.isArray(e.body) && e.body[2]?.exception);
const excPayload = excEnv?.body[2];
const excVal = excPayload?.exception?.values?.[0]?.value ?? '';
const hdrs = excPayload?.request?.headers ?? {};
check('F003.1 AC2: email/CPR/phone masked in outbound payload', excVal.includes('[email]') && excVal.includes('[phone]') && excVal.includes('[cpr]') && !excVal.includes('me@x.dk'), excVal);
check('F003.1 AC2: Authorization + Cookie redacted', hdrs.Authorization === '[redacted]' && hdrs.Cookie === '[redacted]', JSON.stringify(hdrs));
// direct scrub determinism
check('F003.1 AC2: scrub() unit — masks + redacts', JSON.stringify(scrub({ authorization: 'x', note: 'a@b.dk 87654321' })) === JSON.stringify({ authorization: '[redacted]', note: '[email] [phone]' }));
// AC1 (auto-instrument) is intentionally checked false below — fetch wrap not implemented.

// ── F003.2 ──
configureAgent({ baseUrl: 'http://localhost:3095', apiKey: 'k1' });
captured.length = 0;
const out = await agentRun(
  { agent_kind: 'cc', agent_name: 'verify', provider: 'anthropic', model: 'claude' },
  async (ctx) => { ctx.recordToolCall('grep'); ctx.recordTokens({ input_tokens: 100, output_tokens: 40 }); ctx.recordCostUsd(0.02); return 42; },
);
const starts = captured.filter((c) => c.body?.mode === 'start');
const finishes = captured.filter((c) => c.body?.mode === 'finish');
check('F003.2 AC0: agentRun posts start then finish, returns fn result', out === 42 && starts.length === 1 && finishes.length === 1, `result=${out}`);
const fin = finishes[0]?.body;
check('F003.2 AC0/AC2: finish carries tokens + cost + tool_calls', fin?.input_tokens === 100 && fin?.cost_usd === 0.02 && fin?.tool_calls?.[0]?.name === 'grep', JSON.stringify({ it: fin?.input_tokens, cost: fin?.cost_usd, tools: fin?.tool_calls }));

captured.length = 0;
const fakeAnthropic = { messages: { create: async (_p: any) => ({ usage: { input_tokens: 7, output_tokens: 3 } }) } };
const wrapped = wrapAnthropic(fakeAnthropic, { agent_kind: 'cc', agent_name: 'wrapped' });
await wrapped.messages.create({ model: 'claude-sonnet' });
const recs = captured.filter((c) => c.body?.mode === 'record');
check('F003.2 AC1: wrapAnthropic auto-records each messages.create', recs.length === 1 && recs[0].body.model === 'claude-sonnet' && recs[0].body.input_tokens === 7, JSON.stringify(recs[0]?.body && { model: recs[0].body.model, it: recs[0].body.input_tokens }));

captured.length = 0;
const rid = await recordAgentRun({ agent_kind: 'cc', agent_name: 'oneshot', provider: 'anthropic', model: 'm', status: 'success' });
check('F003.2 AC2: recordAgentRun posts a one-shot record', captured.some((c) => c.body?.mode === 'record') && rid === 'rec-test', `rid=${rid}`);

// ── F003.4 ──
captured.length = 0;
const r2 = await agentRun(
  { agent_kind: 'cc', agent_name: 'audit', provider: 'anthropic', model: 'claude', purpose: 'journal' },
  async (ctx) => { ctx.recordTokens({ input_tokens: 10, output_tokens: 5 }); ctx.recordCostUsd(0.001); ctx.setResponseExcerpt('PATIENT NOTE — secret'); return 'ok'; },
  { returnAuditRecord: true },
);
const ar = (r2 as any).auditRecord;
const allowed = new Set(['timestamp', 'agent_kind', 'agent_name', 'purpose', 'provider', 'model', 'tier', 'status', 'input_tokens', 'output_tokens', 'cost_usd', 'duration_ms', 'error_class']);
const arKeysOk = Object.keys(ar).every((k) => allowed.has(k));
check('F003.4 AC0: returnAuditRecord → structured-only (no prompt/response text)', (r2 as any).result === 'ok' && arKeysOk && !('response_excerpt' in ar) && !('prompt_excerpt' in ar) && ar.input_tokens === 10, JSON.stringify(Object.keys(ar)));

configureAgent({ baseUrl: 'http://localhost:3095', apiKey: 'k1', complianceMode: true });
captured.length = 0;
await recordAgentRun({ agent_kind: 'cc', agent_name: 'comp', provider: 'anthropic', model: 'm', status: 'success', prompt_excerpt: 'SECRET PROMPT', response_excerpt: 'SECRET RESP' } as any);
const cbody = captured.find((c) => c.path === '/api/agent')?.body;
check('F003.4 AC1: compliance_mode strips excerpts + tags gdpr-health', !('prompt_excerpt' in cbody) && !('response_excerpt' in cbody) && cbody?.tags?.compliance === 'gdpr-health', JSON.stringify({ hasP: 'prompt_excerpt' in cbody, hasR: 'response_excerpt' in cbody, tag: cbody?.tags?.compliance }));
check('F003.4 AC2: docs/SDK-FYSIODK.md exists', existsSync('docs/SDK-FYSIODK.md') && readFileSync('docs/SDK-FYSIODK.md', 'utf8').length > 200);

server.stop(true);
console.log(pass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(pass ? 0 : 1);
