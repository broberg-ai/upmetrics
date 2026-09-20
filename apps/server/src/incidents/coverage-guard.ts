// F033.2 — a project with no alarm must itself raise one.
//
// F033.1 fills the gap at both creation doors and again at every boot. That
// fixes today's fault; it does not fix the FAULT CLASS. What left 15 projects
// silent was not that the rule was missing — it was that nobody could SEE it was
// missing. Everything looked right until something went down. The day someone
// opens a third door (a script, a migration, a hand-INSERT) exactly the same
// thing happens again, unseen.
//
// So this is the runtime half of the harness contract: F033.1 is the red test,
// this is the probe that shouts when the wire breaks anyway.
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { sendFleet } from './storm';

type Db = ReturnType<typeof getDb>;
type Project = typeof schema.projects.$inferSelect;

/**
 * Projects with ZERO enabled alert rules.
 *
 * The predicate is ENABLED rules — deliberately NOT the same as F033.1's, which
 * asks whether any row exists at all. F033.1 respects a deliberate opt-out by
 * not overwriting it; this refuses to let that opt-out be invisible. Together:
 * you may switch your alarm off, you may just not do it unnoticed.
 */
export function uncoveredProjects(db: Db): Project[] {
  return db
    .select()
    .from(schema.projects)
    .where(sql`not exists (select 1 from alert_rules r where r.project_id = ${schema.projects.id} and r.enabled = 1)`)
    .all();
}

/**
 * ONE message naming them all — never one per project. On the day this was
 * written that would have been 15 messages, making the guard its own noise
 * source on the very channel it exists to keep readable.
 */
export function buildCoverageMessage(projects: Project[]): string {
  const head = `${projects.length} project${projects.length === 1 ? '' : 's'} can raise an incident that reaches NOBODY`;
  const lines = projects
    .slice(0, 20)
    .map((p) => `• ${p.name} (${p.id})`)
    .join('\n');
  return `${head}\n${lines}${projects.length > 20 ? `\n…and ${projects.length - 20} more` : ''}`;
}

/** Identity of the gap: WHICH projects, order-independent. */
export function coverageFingerprint(projects: Project[]): string {
  return projects.map((p) => p.id).sort().join('|');
}

// In-process, best-effort — same posture as storm.ts. Losing it on a restart
// costs one extra message, which is the harmless direction to be wrong in.
let lastSentAt = 0;
let lastFingerprint = '';

export function _resetCoverageGuardState(): void {
  lastSentAt = 0;
  lastFingerprint = '';
}

// Dedup on the SET, not on the clock: a changed set is news and goes out; an
// unchanged one gets the slow heartbeat (same constant as the storm roll-up, so
// "how often may an unchanged situation repeat itself" has ONE answer here).
function shouldSend(fingerprint: string, nowMs: number): boolean {
  if (fingerprint !== lastFingerprint) return true;
  return nowMs - lastSentAt >= config.stormRepeatMs;
}

export interface CoverageResult {
  uncovered: number;
  projectIds: string[];
  sent: boolean;
}

// The sender is injectable — NOT for convenience, but because otherwise the
// negative control cannot exist. sendFleet short-circuits on an empty webhook
// and never reaches fetch, and `config` is read at import time, so a test that
// sets the env in its own module body is already too late (ESM evaluates
// imports first). A suite that cannot count real deliveries can only prove that
// nothing was sent — which is what a permanently broken guard also proves.
export type FleetSender = (webhookUrl: string, message: string, color: number) => Promise<void>;

export async function runCoverageGuard(db: Db, now: Date = new Date(), send: FleetSender = sendFleet): Promise<CoverageResult> {
  const projects = uncoveredProjects(db);
  const projectIds = projects.map((p) => p.id);

  // The empty branch is the important one, and it has its own test: a guard that
  // sends whenever it runs would pass any "it delivers" assertion.
  if (projects.length === 0) {
    lastFingerprint = '';
    return { uncovered: 0, projectIds, sent: false };
  }

  const fingerprint = coverageFingerprint(projects);
  if (!shouldSend(fingerprint, now.getTime())) return { uncovered: projects.length, projectIds, sent: false };

  await send(config.fleetAlertDiscordWebhook, buildCoverageMessage(projects), 0xf59e0b);
  lastFingerprint = fingerprint;
  lastSentAt = now.getTime();
  return { uncovered: projects.length, projectIds, sent: true };
}

/** Per-project coverage for the dashboard: project id → has an enabled rule. */
export function coverageByProject(db: Db): Record<string, boolean> {
  const rules = db
    .select({ projectId: schema.alertRules.projectId })
    .from(schema.alertRules)
    .where(eq(schema.alertRules.enabled, true))
    .all();
  const covered = new Set(rules.map((r) => r.projectId));
  const out: Record<string, boolean> = {};
  for (const p of db.select({ id: schema.projects.id }).from(schema.projects).all()) out[p.id] = covered.has(p.id);
  return out;
}
