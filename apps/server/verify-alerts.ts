// Local verification for F005.2 alert engine (no prod / no real email/Discord).
// A local capture server stands in for Resend + Discord + generic webhook so all
// 3 channels deliver for real over HTTP and we can assert. Then dedup + escalate.
// Run: RESEND_API_BASE=http://localhost:3099 RESEND_API_KEY=test bun apps/server/verify-alerts.ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import * as schema from './src/db/schema';
import { runAlerts } from './src/incidents/alerts';

// ── capture server (Resend /emails, Discord /discord, generic /webhook) ──
const captured: { path: string }[] = [];
const server = Bun.serve({
  port: 3099,
  async fetch(req) {
    captured.push({ path: new URL(req.url).pathname });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

const sqlite = new Database(`/tmp/upm-alerts-${Date.now()}.db`);
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec(readFileSync(import.meta.dir + '/src/db/migrations/0000_far_lake.sql', 'utf8'));
const db = drizzle(sqlite, { schema });
const now = new Date();

db.insert(schema.projects)
  .values({
    id: 'p1',
    name: 'Proj One',
    dsn: 'dsn1',
    apiKey: 'k1',
    platform: 'web',
    alertEmail: 'ops@example.com',
    alertDiscordWebhook: 'http://localhost:3099/discord',
    createdAt: now,
    updatedAt: now,
  })
  .run();
db.insert(schema.alertRules)
  .values({
    id: 'r1',
    projectId: 'p1',
    kind: 'error_spike',
    condition: { webhook_url: 'http://localhost:3099/webhook' },
    channels: ['email', 'discord', 'webhook'],
    enabled: true,
    createdAt: now,
  })
  .run();
db.insert(schema.incidents)
  .values({ id: 'i1', projectId: 'p1', kind: 'error_spike', status: 'open', severity: 'medium', title: 'Error spike', openedAt: now, triggerRef: 'error_spike:p1' })
  .run();

const history = () => db.select().from(schema.alertHistory).all();
let pass = true;
const check = (name: string, cond: boolean, detail = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) pass = false; };

// (1) first run → fires all 3 channels, 1 history row
const r1 = await runAlerts(db, now);
const h1 = history();
check('AC0/AC1: rule evaluated + fired once', r1.fired === 1, JSON.stringify(r1));
check('AC1: all 3 channels delivered (real HTTP capture)', ['/emails', '/discord', '/webhook'].every((p) => captured.some((c) => c.path === p)), JSON.stringify(captured.map((c) => c.path)));
check('AC1: alert_history row with channelsSent=[email,discord,webhook]', h1.length === 1 && JSON.stringify(h1[0].channelsSent) === '["email","discord","webhook"]', JSON.stringify(h1[0]?.channelsSent));

// (2) second run, same severity, inside window → deduped, no new sends
const capCount = captured.length;
const r2 = await runAlerts(db, new Date(now.getTime() + 1000));
check('AC2: dedup suppresses duplicate inside window', r2.fired === 0 && r2.deduped === 1, JSON.stringify(r2));
check('AC2: no new channel sends after dedup', captured.length === capCount, `before=${capCount} after=${captured.length}`);
check('AC2: no new alert_history row', history().length === 1, `rows=${history().length}`);

// (3) escalate severity → dedup broken, re-fires
db.update(schema.incidents).set({ severity: 'critical' }).where(eq(schema.incidents.id, 'i1')).run();
const r3 = await runAlerts(db, new Date(now.getTime() + 2000));
check('escalation (higher severity) breaks dedup → re-fires', r3.fired === 1, JSON.stringify(r3));
check('escalation produced a 2nd alert_history row', history().length === 2, `rows=${history().length}`);

server.stop(true);
console.log(pass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(pass ? 0 : 1);
