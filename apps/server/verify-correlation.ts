// Local verification for F005.1 incident correlation (no prod needed).
// Seeds 4 isolated projects in a temp sqlite, runs the worker once, asserts.
// Run: bun apps/server/verify-correlation.ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { and, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import * as schema from './src/db/schema';
import { runCorrelation } from './src/incidents/correlation';

const dbPath = `/tmp/upm-corr-${Date.now()}.db`;
const sqlite = new Database(dbPath);
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec(readFileSync(import.meta.dir + '/src/db/migrations/0000_far_lake.sql', 'utf8'));
const db = drizzle(sqlite, { schema });

const now = new Date();
const inWindow = new Date(now.getTime() - 60_000); // 1 min ago (< 5 min window)

function project(id: string) {
  db.insert(schema.projects)
    .values({ id, name: id, dsn: `dsn-${id}`, apiKey: `key-${id}`, platform: 'web', createdAt: now, updatedAt: now })
    .run();
}
function errorEvents(projectId: string, n: number) {
  for (let i = 0; i < n; i++) {
    db.insert(schema.events)
      .values({ id: `${projectId}-e${i}`, projectId, kind: 'error', receivedAt: inWindow, occurredAt: inWindow, payload: { i } })
      .run();
  }
}
function agentFailures(projectId: string, n: number) {
  for (let i = 0; i < n; i++) {
    db.insert(schema.agentRuns)
      .values({ id: `${projectId}-a${i}`, projectId, agentKind: 'cc', agentName: 'x', task: 't', provider: 'anthropic', model: 'm', status: 'error', startedAt: inWindow })
      .run();
  }
}
function releaseEvent(projectId: string, release: string) {
  db.insert(schema.events)
    .values({ id: `${projectId}-rel`, projectId, kind: 'message', receivedAt: inWindow, occurredAt: inWindow, payload: {}, release })
    .run();
}
function probeDown(projectId: string) {
  db.insert(schema.incidents)
    .values({ id: `${projectId}-pd`, projectId, kind: 'probe_down', status: 'open', severity: 'high', title: 'down', openedAt: inWindow, triggerRef: 'probe-x' })
    .run();
}
function incidentsFor(projectId: string) {
  return db.select().from(schema.incidents).where(eq(schema.incidents.projectId, projectId)).all();
}

// Scenarios
project('p_merge'); probeDown('p_merge'); errorEvents('p_merge', 12); // AC0: merge → critical
project('p_err'); errorEvents('p_err', 12);                           // AC0 standalone error_spike (medium)
project('p_agent'); agentFailures('p_agent', 6); releaseEvent('p_agent', 'v9'); // AC1: agent_failure_spike + recent deploy → high
project('p_quiet'); errorEvents('p_quiet', 2);                        // below threshold → nothing

const result = runCorrelation(db, now);

// ── assertions ──
let pass = true;
const check = (name: string, cond: boolean, detail = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) pass = false; };

const merge = incidentsFor('p_merge');
const pd = merge.find((i) => i.kind === 'probe_down')!;
check('AC0 merge: single probe_down incident (no dup error_spike)', merge.length === 1 && pd.kind === 'probe_down', `count=${merge.length}`);
check('AC0 merge: probe_down escalated to critical', pd.severity === 'critical', `sev=${pd.severity}`);
check('AC0 merge: correlated=[error_spike] tagged', JSON.stringify((pd.eventsAtOpen as any)?.correlated) === '["error_spike"]', JSON.stringify(pd.eventsAtOpen));

const err = incidentsFor('p_err');
check('AC0 standalone: one error_spike incident opened', err.length === 1 && err[0].kind === 'error_spike', `count=${err.length}`);
check('AC2 severity: standalone error_spike = medium', err[0]?.severity === 'medium', `sev=${err[0]?.severity}`);

const ag = incidentsFor('p_agent');
check('AC1: agent_failure_spike incident opened', ag.length === 1 && ag[0].kind === 'agent_failure_spike', `count=${ag.length}`);
check('AC1: tagged recent_deploy + release captured', (ag[0]?.eventsAtOpen as any)?.recent_deploy === 'v9' && JSON.stringify((ag[0]?.eventsAtOpen as any)?.correlated) === '["recent_deploy"]', JSON.stringify(ag[0]?.eventsAtOpen));
check('AC2 severity: agent_failure_spike after deploy = high', ag[0]?.severity === 'high', `sev=${ag[0]?.severity}`);

const quiet = incidentsFor('p_quiet');
check('below-threshold project opens NO incident', quiet.length === 0, `count=${quiet.length}`);

console.log('\nrunCorrelation result:', JSON.stringify(result));
console.log(pass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(pass ? 0 : 1);
