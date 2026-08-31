// F019.9 — deploy regression detection. After a SUCCESS deploy's observation
// window elapses, compare the project's error rate AFTER the deploy against a
// baseline BEFORE it (deploy↔error correlation, the Sentry "Releases" pattern).
// A material rise — or a brand-new issue — → "regressed", which opens a
// deploy_regression incident. OBSERVE/REPORT only: we never auto-rollback.
// Runs on the existing correlation worker tick; no new daemon.
import { and, eq, gt, gte, lte, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
type Deploy = typeof schema.deployEvents.$inferSelect;

export interface RegressionCfg {
  windowMs: number;
  baselineMs: number;
  multiplier: number;
  minAfter: number;
}
export interface RegressionInput {
  afterCount: number; // errors in the after-window
  baselineCount: number; // errors in the baseline (before) window
  newIssues: number; // new fingerprints first-seen in the after-window past the per-issue floor
}
export interface RegressionResult {
  verdict: 'healthy' | 'regressed';
  detail: {
    after: number;
    baseline: number;
    after_rate: number; // errors per ms
    baseline_rate: number;
    new_issues: number;
    reason: string;
  };
}

// PURE — the whole verdict decision, unit-tested. Rates normalise the unequal
// window lengths. A baseline of 0 means any after-errors past the floor flag
// (errors appeared on a previously-clean surface).
export function computeVerdict(inp: RegressionInput, cfg: RegressionCfg): RegressionResult {
  const afterRate = inp.afterCount / cfg.windowMs;
  const baselineRate = inp.baselineCount / cfg.baselineMs;
  const rateSpike = inp.afterCount >= cfg.minAfter && afterRate >= baselineRate * cfg.multiplier;
  const newIssue = inp.newIssues >= 1;
  const regressed = rateSpike || newIssue;
  const reason = regressed
    ? [
        rateSpike ? `error-rate spike (${inp.afterCount} after vs ${inp.baselineCount} baseline)` : '',
        newIssue ? `${inp.newIssues} new issue(s)` : '',
      ]
        .filter(Boolean)
        .join(' + ')
    : 'no material error rise';
  return {
    verdict: regressed ? 'regressed' : 'healthy',
    detail: { after: inp.afterCount, baseline: inp.baselineCount, after_rate: afterRate, baseline_rate: baselineRate, new_issues: inp.newIssues, reason },
  };
}

function evalCfg(): RegressionCfg {
  return {
    windowMs: config.deployRegressionWindowMs,
    baselineMs: config.deployRegressionBaselineMs,
    multiplier: config.deployRegressionMultiplier,
    minAfter: config.deployRegressionMinAfter,
  };
}

// SUCCESS deploys whose after-window has elapsed, not yet evaluated, within the
// recency bound (never retroactively judge ancient deploys).
export function pendingEvaluations(db: Db, now: Date = new Date()): Deploy[] {
  const nowMs = now.getTime();
  const windowEnd = new Date(nowMs - config.deployRegressionWindowMs);
  const floor = new Date(nowMs - config.deployRegressionMaxAgeMs);
  return db
    .select()
    .from(schema.deployEvents)
    .where(
      and(
        eq(schema.deployEvents.status, 'success'),
        isNull(schema.deployEvents.evaluatedAt),
        lte(schema.deployEvents.updatedAt, windowEnd),
        gte(schema.deployEvents.updatedAt, floor),
      ),
    )
    .all();
}

// Evaluate one deploy: count errors after vs before, find new issues, stamp the
// verdict, and on "regressed" open one idempotent deploy_regression incident.
export function evaluateDeploy(db: Db, d: Deploy, now: Date = new Date()): RegressionResult {
  const deployMs = d.updatedAt.getTime();
  const afterStart = new Date(deployMs);
  const afterEnd = new Date(deployMs + config.deployRegressionWindowMs);
  const baseStart = new Date(deployMs - config.deployRegressionBaselineMs);

  const countErrors = (from: Date, to: Date): number =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.events)
      .where(and(eq(schema.events.projectId, d.projectId), eq(schema.events.kind, 'error'), gt(schema.events.receivedAt, from), lte(schema.events.receivedAt, to)))
      .get()?.n ?? 0;

  const afterCount = countErrors(afterStart, afterEnd);
  const baselineCount = countErrors(baseStart, afterStart);
  const newIssues =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.issues)
      .where(and(eq(schema.issues.projectId, d.projectId), gt(schema.issues.firstSeen, afterStart), lte(schema.issues.firstSeen, afterEnd), gte(schema.issues.eventCount, config.deployRegressionNewIssueMin)))
      .get()?.n ?? 0;

  const res = computeVerdict({ afterCount, baselineCount, newIssues }, evalCfg());

  db.update(schema.deployEvents)
    .set({ regressionVerdict: res.verdict, evaluatedAt: now, regressionDetail: res.detail })
    .where(eq(schema.deployEvents.id, d.id))
    .run();

  if (res.verdict !== 'regressed') {
    // A clean verdict is the only thing that may retire an older alarm for this
    // site. See resolveSupersededRegressions for why "newer" alone is not it.
    resolveSupersededRegressions(db, d, now);
  }

  if (res.verdict === 'regressed') {
    const open = db
      .select()
      .from(schema.incidents)
      .where(and(eq(schema.incidents.triggerRef, d.id), eq(schema.incidents.kind, 'deploy_regression')))
      .get();
    if (!open) {
      db.insert(schema.incidents)
        .values({
          id: crypto.randomUUID(),
          projectId: d.projectId,
          kind: 'deploy_regression',
          status: 'open',
          severity: 'high',
          title: `${d.site} deploy regressed (${d.version ?? (d.sha ?? '').slice(0, 7)})`,
          openedAt: now,
          triggerRef: d.id,
          eventsAtOpen: res.detail,
        })
        .run();
    }
  }
  return res;
}

// Worker pass — evaluate every pending deploy. Returns the count evaluated.
// F026.1 — close a deploy_regression once a LATER deploy of the same site has
// earned its own healthy verdict.
//
// Why this is not "a newer deploy exists": a newer deploy can be just as sick,
// and closing on its mere arrival would silence the alarm exactly when it is
// still true. The condition is a newer deploy that has been MEASURED and came
// back clean — which is why this is only ever called from the healthy branch of
// evaluateDeploy, after the verdict is stamped.
//
// Scoped to the SITE, not the project. fysiodk ships web, ios and android under
// one project; a healthy web deploy says nothing about the android build, and
// resolving across them would close an alarm nobody has answered.
//
// The cost of not having this, measured: "webhouse.app deploy regressed
// (f6063b7)" opened 26 Aug and fired every hour for five days about a release
// replaced within the hour — 124 alerts, all about the same dead deploy. An
// alarm that outlives its own subject teaches the owner to scroll past alarms.
export function resolveSupersededRegressions(db: Db, healthy: Deploy, now: Date = new Date()): number {
  const open = db
    .select()
    .from(schema.incidents)
    .where(and(eq(schema.incidents.projectId, healthy.projectId), eq(schema.incidents.kind, 'deploy_regression'), eq(schema.incidents.status, 'open')))
    .all();

  let closed = 0;
  for (const inc of open) {
    // triggerRef points at the deploy the incident was opened for. No ref, or a
    // deploy we can no longer read, means we cannot prove this incident is
    // superseded — leave it open. An alarm we cannot reason about stays.
    if (!inc.triggerRef) continue;
    const origin = db.select().from(schema.deployEvents).where(eq(schema.deployEvents.id, inc.triggerRef)).get();
    if (!origin) continue;
    if (origin.site !== healthy.site) continue;
    // Strictly older. Equal timestamps would let a deploy resolve its own
    // incident, and "not newer" is not the same as "superseded".
    if (origin.updatedAt.getTime() >= healthy.updatedAt.getTime()) continue;

    db.update(schema.incidents).set({ status: 'resolved', resolvedAt: now }).where(eq(schema.incidents.id, inc.id)).run();
    closed++;
    console.log(`[regression] resolved ${inc.id} — ${healthy.site} deploy ${(healthy.sha ?? '').slice(0, 7)} measured healthy after it`);
  }
  return closed;
}

export function evaluateDeployRegressions(db: Db, now: Date = new Date()): number {
  const pending = pendingEvaluations(db, now);
  for (const d of pending) evaluateDeploy(db, d, now);
  return pending.length;
}
