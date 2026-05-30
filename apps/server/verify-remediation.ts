// Local verification for F005.3 remediation dispatcher + callback.
// Migrate a temp DB first, then run from repo root:
//   DATABASE_PATH=<tmp> REMEDIATION_BACKOFF_MS=10 AUTH_SECRET=x bun apps/server/verify-remediation.ts
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './src/db';
import { runRemediation } from './src/incidents/remediation';
import { createApp } from './src/app';

const SECRET = 'testsecret';
const received: { attempt: number; sigOk: boolean; hasIncident: boolean; hasToken: boolean; hasRecent: boolean }[] = [];
let n = 0;
const capture = Bun.serve({
  port: 3088,
  async fetch(req) {
    n++;
    const raw = await req.text();
    const sig = (req.headers.get('x-upmetrics-signature') ?? '').replace('sha256=', '');
    const expected = createHmac('sha256', SECRET).update(raw).digest('hex');
    let p: any = {};
    try { p = JSON.parse(raw); } catch {}
    received.push({ attempt: n, sigOk: sig === expected, hasIncident: !!p.incident?.id, hasToken: !!p.remediation_token, hasRecent: Array.isArray(p.recent_events) });
    return new Response('', { status: n < 3 ? 500 : 200 }); // fail twice, succeed on 3rd → tests retry
  },
});

const db = getDb();
const now = new Date();
db.insert(schema.projects).values({ id: 'p1', name: 'P1', dsn: 'd1', apiKey: 'k1', platform: 'web', remediationWebhookUrl: 'http://localhost:3088/hook', remediationWebhookSecret: SECRET, createdAt: now, updatedAt: now }).run();
db.insert(schema.incidents).values({ id: 'inc1', projectId: 'p1', kind: 'probe_down', status: 'open', severity: 'high', title: 'down', openedAt: now, triggerRef: 'probe-x' }).run();
db.insert(schema.events).values({ id: 'ev1', projectId: 'p1', kind: 'error', receivedAt: now, occurredAt: now, payload: {} }).run();

let pass = true;
const check = (nm: string, c: boolean, d = '') => { console.log(`${c ? '✅' : '❌'} ${nm}${d ? ' — ' + d : ''}`); if (!c) pass = false; };

const res = await runRemediation(db, now);
const inc = db.select().from(schema.incidents).where(eq(schema.incidents.id, 'inc1')).get();
const ra = inc!.remediationAttempts as any;

check('AC0: HMAC-signed payload POSTed with incident + token + recent context', received.length > 0 && received[0].sigOk && received[0].hasIncident && received[0].hasToken && received[0].hasRecent, JSON.stringify(received[0]));
check('AC1: retried 3x (2 failures→1 success), every attempt logged, delivered', received.length === 3 && ra?.attempts?.length === 3 && ra?.delivered === true, `captureHits=${received.length} logged=${ra?.attempts?.length} delivered=${ra?.delivered}`);
check('AC3: dispatcher only fetched (no exec) — 1 dispatched', res.dispatched === 1, JSON.stringify(res));

// AC2: callback via the REAL Hono app (in-process)
const app = createApp();
const token = ra.token;
const okRes = await app.fetch(new Request('http://x/api/incidents/inc1/remediation-callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-upmetrics-remediation-token': token }, body: JSON.stringify({ status: 'remediated', detail: 'cardmem opened a card' }) }));
const badRes = await app.fetch(new Request('http://x/api/incidents/inc1/remediation-callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-upmetrics-remediation-token': 'wrong' }, body: JSON.stringify({ status: 'x' }) }));
const inc2 = db.select().from(schema.incidents).where(eq(schema.incidents.id, 'inc1')).get();
const cbs = (inc2!.remediationAttempts as any).callbacks;
check('AC2: callback with valid token (200) records status to timeline', okRes.status === 200 && cbs?.length === 1 && cbs[0].status === 'remediated', `status=${okRes.status} callbacks=${JSON.stringify(cbs)}`);
check('AC2: callback with wrong token rejected (401)', badRes.status === 401, `status=${badRes.status}`);

capture.stop(true);
console.log(pass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(pass ? 0 : 1);
