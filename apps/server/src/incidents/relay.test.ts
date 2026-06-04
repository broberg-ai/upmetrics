// F010 auto-remediation relay. Run: bun test src/incidents/relay.test.ts
import { describe, it, expect } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../db';
import { pendingRemediations, claimRemediation, unclaimedEscalations, enrollmentView, buildEnrollmentPatch, applyEnrollment } from './relay';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const NOW = new Date('2026-05-31T12:00:00Z');
let seq = 0;

function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string, opts: Partial<typeof schema.projects.$inferInsert>): void {
  db.insert(schema.projects)
    .values({
      id,
      name: id,
      dsn: `https://k_${id}@upmetrics.org/${id}`,
      apiKey: `uk_${id}`,
      platform: 'web',
      createdAt: NOW,
      updatedAt: NOW,
      ...opts,
    })
    .run();
}
function addIssue(db: Db, id: string, projectId: string, opts: Partial<typeof schema.issues.$inferInsert> = {}): void {
  db.insert(schema.issues)
    .values({
      id,
      projectId,
      fingerprint: `fp_${id}`,
      title: opts.title ?? `Error: boom ${id}`,
      culprit: opts.culprit ?? 'src/x.ts',
      level: 'error',
      firstSeen: NOW,
      lastSeen: NOW,
      eventCount: opts.eventCount ?? 3,
      ...opts,
    })
    .run();
}
function addIncident(db: Db, projectId: string, opts: Partial<typeof schema.incidents.$inferInsert>): string {
  const id = `inc_${++seq}`;
  db.insert(schema.incidents)
    .values({
      id,
      projectId,
      kind: opts.kind ?? 'manual_remediation', // auto-relay removed 2026-06-04 — only manual relays
      status: opts.status ?? 'open',
      severity: opts.severity ?? 'high',
      title: opts.title ?? 'manual remediation',
      openedAt: opts.openedAt ?? NOW,
      triggerRef: opts.triggerRef ?? 'iss_x',
      relayRequestedAt: opts.relayRequestedAt ?? NOW, // manual incidents carry this
      ...opts,
    })
    .run();
  return id;
}
function addEvent(db: Db, issueId: string, projectId: string, release: string, frames: unknown[]): void {
  db.insert(schema.events)
    .values({
      id: `ev_${++seq}`,
      projectId,
      kind: 'error',
      receivedAt: NOW,
      occurredAt: NOW,
      payload: { exception: { values: [{ stacktrace: { frames } }] } },
      issueId,
      release,
    })
    .run();
}

describe('F010 remediation relay (pull feed)', () => {
  it('feed lists an eligible incident with repo, stack frames, dashboard link', () => {
    const db = freshDb();
    addProject(db, 'cardmem', { remediationRelay: true, repo: 'cardmem' });
    addIssue(db, 'iss_1', 'cardmem', { title: 'Error: webhookSecret not configured', eventCount: 16 });
    addEvent(db, 'iss_1', 'cardmem', 'cardmem-server', [{ f: 1 }, { f: 2 }, { f: 3 }, { f: 4 }, { f: 5 }, { f: 6 }]);
    addIncident(db, 'cardmem', { kind: 'manual_remediation', severity: 'high', triggerRef: 'iss_1', relayRequestedAt: NOW });

    const pending = pendingRemediations(db);
    expect(pending.length).toBe(1);
    const r = pending[0]!;
    expect(r.project).toBe('cardmem');
    expect(r.repo).toBe('cardmem');
    expect(r.repo_path).toBe('/Users/cb/Apps/broberg/cardmem');
    expect(r.issue.title).toContain('webhookSecret');
    expect(r.issue.release).toBe('cardmem-server');
    expect(r.issue.occurrences).toBe(16);
    expect(r.issue.top_stack_frames.length).toBe(5); // slice(-5) of 6
    expect(r.issue.dashboard_url).toContain('/issues/iss_1');
  });

  it('resolves a correlation incident (trigger_ref="kind:project") to the project top issue', () => {
    const db = freshDb();
    addProject(db, 'cardmem', { remediationRelay: true, repo: 'cardmem' });
    addIssue(db, 'iss_top', 'cardmem', { title: 'Error: real spike', eventCount: 12 });
    addEvent(db, 'iss_top', 'cardmem', 'cardmem-server', [{ f: 'a' }, { f: 'b' }]);
    // a manual push whose trigger_ref isn't an issue id → falls back to the project top issue
    addIncident(db, 'cardmem', { kind: 'manual_remediation', severity: 'high', triggerRef: 'manual:cardmem', relayRequestedAt: NOW });

    const pending = pendingRemediations(db);
    expect(pending.length).toBe(1);
    expect(pending[0]!.issue.id).toBe('iss_top');
    expect(pending[0]!.issue.title).toContain('real spike');
  });

  it('manual push (relay_requested_at) bypasses opt-in + severity gates', () => {
    const db = freshDb();
    // project NOT opted in, no repo, and the incident is only medium severity —
    // all gates that would normally exclude it.
    addProject(db, 'cardmem', { remediationRelay: false });
    addIssue(db, 'iss_m', 'cardmem', { title: 'Error: pushed by hand' });
    addEvent(db, 'iss_m', 'cardmem', 'cardmem-server', [{ f: 1 }]);
    addIncident(db, 'cardmem', { kind: 'manual_remediation', severity: 'medium', triggerRef: 'iss_m', relayRequestedAt: NOW });

    const pending = pendingRemediations(db);
    expect(pending.length).toBe(1);
    expect(pending[0]!.manual).toBe(true);
    expect(pending[0]!.repo).toBe('cardmem'); // falls back to project id when repo unset
    expect(pending[0]!.issue.title).toContain('pushed by hand');
  });

  it('only manual_remediation relays — auto error_spike / agent_failure_spike / probe_down never do', () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss_e', 'on');
    // auto-relay removed 2026-06-04: auto-detected kinds + infra never enter the feed
    addIncident(db, 'on', { kind: 'error_spike', triggerRef: 'iss_e', relayRequestedAt: null });
    addIncident(db, 'on', { kind: 'agent_failure_spike', triggerRef: 'iss_e', relayRequestedAt: null });
    addIncident(db, 'on', { kind: 'probe_down', triggerRef: 'iss_e', relayRequestedAt: null });
    expect(pendingRemediations(db).length).toBe(0);
    // a deliberate manual push on the SAME project IS relayed
    addIncident(db, 'on', { kind: 'manual_remediation', triggerRef: 'iss_e', relayRequestedAt: NOW });
    expect(pendingRemediations(db).length).toBe(1);
  });

  it('claim marks the incident, drops it from the feed, and is idempotent', () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss_c', 'on');
    const id = addIncident(db, 'on', { triggerRef: 'iss_c' });
    expect(pendingRemediations(db).length).toBe(1);

    const c1 = claimRemediation(db, id, 'cardmem');
    expect(c1).toEqual({ ok: true, alreadyClaimed: false });
    expect(pendingRemediations(db).length).toBe(0); // dropped out
    // claim moves the incident out of the raw "open" alarm into acknowledged
    expect(db.select().from(schema.incidents).where(eq(schema.incidents.id, id)).get()!.status).toBe('acknowledged');

    const c2 = claimRemediation(db, id, 'cardmem'); // idempotent
    expect(c2).toEqual({ ok: true, alreadyClaimed: true });
    expect(claimRemediation(db, 'nope', 'x').ok).toBe(false); // unknown
  });

  it('escalation surfaces eligible incidents unclaimed past the window', () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss_old', 'on');
    addIssue(db, 'iss_new', 'on');
    addIncident(db, 'on', { triggerRef: 'iss_old', openedAt: new Date(NOW.getTime() - 60 * 60_000) }); // 60m old
    addIncident(db, 'on', { triggerRef: 'iss_new', openedAt: NOW }); // fresh
    const esc = unclaimedEscalations(db, NOW); // default window 30m
    expect(esc.length).toBe(1);
    expect(esc[0]!.issue.id).toBe('iss_old');
  });
});

describe('F010.5 self-service enrollment', () => {
  // NOTE: the per-project severity GATE only ever applied to AUTO error_spike
  // relaying, which was removed 2026-06-04 (only manual relays now). The
  // enrollment helpers below still exist (repo/github_repo routing + the field).

  it('enrollmentView exposes enabled/repo/severity + effective_severity', () => {
    const db = freshDb();
    addProject(db, 'v', { remediationRelay: true, repo: 'v', remediationRelaySeverity: null });
    const p = db.select().from(schema.projects).where(eq(schema.projects.id, 'v')).get()!;
    const view = enrollmentView(p);
    expect(view).toMatchObject({ project: 'v', enabled: true, repo: 'v', severity: null, effective_severity: 'high' });
  });

  it('buildEnrollmentPatch validates severity + maps fields; applyEnrollment persists', () => {
    const db = freshDb();
    addProject(db, 'w', {}); // defaults: relay off, no repo
    expect('error' in buildEnrollmentPatch({ severity: 'bananas' })).toBe(true);
    const patch = buildEnrollmentPatch({ enabled: true, repo: ' w ', severity: 'critical' });
    expect(patch).toEqual({ remediationRelay: true, repo: 'w', remediationRelaySeverity: 'critical' });
    const view = applyEnrollment(db, 'w', patch as any);
    expect(view).toMatchObject({ enabled: true, repo: 'w', severity: 'critical', effective_severity: 'critical' });
    // empty severity string clears back to inherit-global
    const cleared = applyEnrollment(db, 'w', buildEnrollmentPatch({ severity: '' }) as any);
    expect(cleared.severity).toBe(null);
    expect(cleared.effective_severity).toBe('high');
  });
});
