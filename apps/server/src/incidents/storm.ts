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

// F026.4 — the roll-up must say WHICH. It returned only its own title, so the
// Discord embed carried the same sentence as heading AND body: "Major outage: 4
// incidents across 3 projects", twice, naming nothing. Christian's first question
// on seeing it was "hvilke projekter" — which is the question the alarm exists to
// answer. buildDigestMessage, twenty lines down in this same file, had listed
// project + title per incident all along; the roll-up had the strictly worse
// version of a message it sends far more often.
//
// Kind and severity are on the line because they are what decides whether to get
// up: a five-day-old credit warning and a deploy that regressed ten minutes ago
// are not the same news, and "4 incidents" renders them identical.
export function buildRollupMessage(plan: StormPlan, items: Array<{ incident: Incident; project: Project }> = []): string {
  const head = plan.rollupTitle ?? 'Fleet outage';
  if (items.length === 0) return head;
  const lines = items
    .slice(0, 15)
    .map((it) => `• [${it.incident.severity}] ${it.project.name} — ${it.incident.kind}: ${it.incident.title}`)
    .join('\n');
  return `${head}\n${lines}${items.length > 15 ? `\n…and ${items.length - 15} more` : ''}`;
}

/** The open incidents behind a roll-up, joined to their project for the message. */
export function rollupItems(db: Db): Array<{ incident: Incident; project: Project }> {
  const open = db.select().from(schema.incidents).where(eq(schema.incidents.status, 'open')).all();
  const out: Array<{ incident: Incident; project: Project }> = [];
  for (const incident of open) {
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, incident.projectId)).get();
    // A project we cannot read is still an incident worth naming — fall back to
    // the id rather than dropping the row. Silence about one is worse than an
    // ugly name for it.
    out.push({ incident, project: project ?? ({ id: incident.projectId, name: incident.projectId } as Project) });
  }
  // Newest first: the thing that just broke is the reason the message arrived.
  return out.sort((a, b) => b.incident.openedAt.getTime() - a.incident.openedAt.getTime());
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
  lastRollupFingerprint = '';
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
let lastRollupFingerprint = '';
let lastDigestAt = 0;

// Re-send the roll-up when the outage CHANGES, not merely because time passed.
//
// The old rule re-sent whenever stormWindowMs (5 min) had elapsed, for as long
// as the incidents stayed open — so an unchanged situation produced the same
// sentence every few minutes, indefinitely. Measured 2026-09-04: the same "Major
// outage: 4 incidents across 3 projects" arrived at 10:05, 10:05 and 10:15 about
// a set that had not moved since the night before, one of whose members was a
// five-day-old low-balance warning. That is the alarm teaching its reader to
// scroll past alarms — the same fault F026 opened for, one layer up.
//
// So: a NEW or DEPARTED incident is news and goes out at once (subject to the
// window). An unchanged set gets a much slower heartbeat, so an ongoing outage
// is still visible without being repeated at you.
function shouldSendRollup(plan: StormPlan, nowMs: number, fingerprint: string): boolean {
  if (lastRollupAt === 0) return true; // first one always goes
  const changed = fingerprint !== lastRollupFingerprint;
  if (changed && nowMs - lastRollupAt >= config.stormWindowMs) return true;
  // Growth is an escalation even inside the window.
  if (plan.openCount > Math.ceil(lastRollupCount * 1.5)) return true;
  return nowMs - lastRollupAt >= config.stormRepeatMs;
}

/** Identity of an outage: which incidents, at which severity. Order-independent. */
export function rollupFingerprint(items: Array<{ incident: Incident }>): string {
  return items
    .map((it) => `${it.incident.id}:${it.incident.severity}`)
    .sort()
    .join('|');
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
  const items = plan.mode === 'fleet' ? rollupItems(db) : [];
  if (plan.mode === 'fleet' && shouldSendRollup(plan, nowMs, rollupFingerprint(items))) {
    await sendFleet(config.fleetAlertDiscordWebhook, buildRollupMessage(plan, items), 0xef4444);
    lastRollupFingerprint = rollupFingerprint(items);
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
