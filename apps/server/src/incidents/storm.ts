// Fleet-scale alert-storm control (F008.3). Layers on top of F005.2's per-rule
// dedup — it does NOT replace it. Four behaviours, all driven off the set of
// currently-open incidents on each worker tick:
//
//   1. Roll-up      — N simultaneous incidents across projects collapse into ONE
//                     alert carrying a count, instead of N per-site messages.
//   2. Dependency   — a region/upmetrics-down (watchdog) incident is a suppressor
//      suppression    signal: while one is open, downstream per-site alerts are
//                     folded into the roll-up for the window.
//   3. Maintenance  — a configured window silences matching alerts (project/kind
//      windows        wildcards via NULL).
//   4. Rate-limit   — a global token bucket; overflow is diverted into a single
//      → digest       periodic digest instead of N individual sends.
//
// Why in-process state (token bucket, roll-up dedup): the server is a single bun
// process and storm-control is best-effort — losing a little of this state on a
// restart is acceptable (epic constraint: don't over-engineer toward five-nines).
import { and, eq, gte, lte } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { runAlerts, type AlertControl, type AlertResult } from './alerts';

type Db = ReturnType<typeof getDb>;
type Incident = typeof schema.incidents.$inferSelect;
type Project = typeof schema.projects.$inferSelect;

export interface StormPlan {
  mode: 'normal' | 'fleet';
  openCount: number;
  projectCount: number;
  suppressorKinds: string[]; // active region/upmetrics-down signals (AC2)
  rollupTitle: string | null;
}

// ── pure decision logic (no network, no mutation) — unit-tested ──────────────

// Decide fleet vs normal from the currently-open incidents. Fleet mode triggers
// when a suppressor signal is open (AC2) OR enough distinct projects / incidents
// are simultaneously open (AC1).
export function planStorm(db: Db): StormPlan {
  const open = db.select().from(schema.incidents).where(eq(schema.incidents.status, 'open')).all();
  const projects = new Set(open.map((i) => i.projectId));
  const suppressorKinds = [...new Set(open.filter((i) => config.fleetOutageKinds.includes(i.kind)).map((i) => i.kind))];
  const fleet =
    suppressorKinds.length > 0 ||
    projects.size >= config.stormProjectThreshold ||
    open.length >= config.stormIncidentThreshold;
  return {
    mode: fleet ? 'fleet' : 'normal',
    openCount: open.length,
    projectCount: projects.size,
    suppressorKinds,
    rollupTitle: fleet
      ? suppressorKinds.length
        ? `Region/upmetrics outage (${suppressorKinds.join(', ')}) — ${open.length} incidents across ${projects.size} projects`
        : `Major outage: ${open.length} incidents across ${projects.size} projects`
      : null,
  };
}

// Active maintenance windows at `now`. project/kind NULL = wildcard.
export function activeMaintenance(db: Db, now: Date) {
  return db
    .select()
    .from(schema.maintenanceWindows)
    .where(and(lte(schema.maintenanceWindows.startsAt, now), gte(schema.maintenanceWindows.endsAt, now)))
    .all();
}

export function maintenanceMatch(
  windows: Array<typeof schema.maintenanceWindows.$inferSelect>,
  incident: Incident,
): string | null {
  const w = windows.find(
    (m) => (m.projectId == null || m.projectId === incident.projectId) && (m.kind == null || m.kind === incident.kind),
  );
  return w ? `maintenance:${w.reason}` : null;
}

export function buildRollupMessage(plan: StormPlan): string {
  return plan.rollupTitle ?? 'Fleet outage';
}

export function buildDigestMessage(items: Array<{ incident: Incident; project: Project }>): string {
  const head = `Alert digest — ${items.length} alerts rate-limited`;
  const lines = items
    .slice(0, 20)
    .map((it) => `• [${it.incident.severity}] ${it.project.name}: ${it.incident.title}`)
    .join('\n');
  return `${head}\n${lines}${items.length > 20 ? `\n…and ${items.length - 20} more` : ''}`;
}

// ── in-process best-effort state ─────────────────────────────────────────────

const bucket = { tokens: config.alertRateCapacity, windowStart: 0 };
// Exposed for tests to get a clean bucket per case.
export function _resetStormState(): void {
  bucket.tokens = config.alertRateCapacity;
  bucket.windowStart = 0;
  lastRollupAt = 0;
  lastRollupCount = 0;
  lastDigestAt = 0;
}

function takeToken(nowMs: number): boolean {
  if (nowMs - bucket.windowStart >= config.stormWindowMs) {
    bucket.windowStart = nowMs;
    bucket.tokens = config.alertRateCapacity;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

let lastRollupAt = 0;
let lastRollupCount = 0;
let lastDigestAt = 0;

// Re-send the roll-up only when the window has elapsed OR the outage grew
// materially (escalation) — never every 30s tick.
function shouldSendRollup(plan: StormPlan, nowMs: number): boolean {
  if (nowMs - lastRollupAt >= config.stormWindowMs) return true;
  return plan.openCount > Math.ceil(lastRollupCount * 1.5);
}

// ── orchestrator (called by the worker tick) ─────────────────────────────────

export interface StormResult extends AlertResult {
  storm: StormPlan;
  rollupSent: boolean;
  digestSent: number; // count folded into a digest this tick (0 if none sent)
}

export async function runAlertsStorm(db: Db, now: Date = new Date()): Promise<StormResult> {
  const nowMs = now.getTime();
  const plan = planStorm(db);
  const windows = activeMaintenance(db, now);
  const digestQueue: Array<{ incident: Incident; project: Project }> = [];

  const control: AlertControl = {
    suppress(incident) {
      const mw = maintenanceMatch(windows, incident);
      if (mw) return mw;
      if (plan.mode === 'fleet') return 'fleet-rollup';
      return null;
    },
    admit() {
      return takeToken(nowMs);
    },
    onDiverted(incident, project, reason) {
      if (reason === 'digest') digestQueue.push({ incident, project });
    },
  };

  let rollupSent = false;
  if (plan.mode === 'fleet' && shouldSendRollup(plan, nowMs)) {
    await sendFleet(config.fleetAlertDiscordWebhook, buildRollupMessage(plan), 0xef4444);
    lastRollupAt = nowMs;
    lastRollupCount = plan.openCount;
    rollupSent = true;
  }

  const res = await runAlerts(db, now, control);

  let digestSent = 0;
  if (digestQueue.length > 0 && nowMs - lastDigestAt >= config.alertDigestIntervalMs) {
    await sendFleet(config.fleetAlertDiscordWebhook, buildDigestMessage(digestQueue), 0xf59e0b);
    lastDigestAt = nowMs;
    digestSent = digestQueue.length;
  }

  return { ...res, storm: plan, rollupSent, digestSent };
}

// Thin delivery to the fleet/deadman Discord webhook. No-ops (logs) when the
// webhook isn't configured — the decision logic above is what's unit-tested.
export async function sendFleet(webhookUrl: string, message: string, color: number): Promise<void> {
  if (!webhookUrl) {
    console.warn('[storm] FLEET_ALERT_DISCORD_WEBHOOK unset; would have sent:', message.split('\n')[0]);
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: message.split('\n')[0], description: message, color }] }),
    });
    if (!res.ok && res.status !== 204) console.error('[storm] fleet webhook', res.status);
  } catch (err) {
    console.error('[storm] fleet webhook failed:', err instanceof Error ? err.message : err);
  }
}
