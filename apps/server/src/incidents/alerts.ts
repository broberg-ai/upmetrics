// Alert engine (F005.2). Runs on the incident worker tick: scans OPEN incidents,
// evaluates each project's enabled alert_rules, and delivers via the rule's
// channels (Resend email / Discord webhook / generic webhook). Per-rule dedup
// keeps it from re-firing the same incident at the same-or-lower severity inside
// a window — escalation (higher severity) breaks dedup and re-alerts.
//
// Scanner design (not a callback) so it uniformly covers probe_down incidents
// opened by F004 AND error_spike/agent_failure_spike opened by F005.1, with no
// coupling to those code paths. alert_history is the dedup + audit store.
import { and, eq, gte } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
type Incident = typeof schema.incidents.$inferSelect;
type AlertRule = typeof schema.alertRules.$inferSelect;
type Project = typeof schema.projects.$inferSelect;

const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export interface AlertResult {
  scannedIncidents: number;
  fired: number;
  deduped: number;
  suppressed: number; // F008.3 — silenced by maintenance/fleet
  digested: number; // F008.3 — diverted to digest by the global rate-limit
}

// F008.3 storm-control hooks. Optional + backward-compatible: when omitted,
// runAlerts behaves exactly as F005.2. storm.ts supplies an implementation.
export interface AlertControl {
  // Non-null reason → silence this incident's alerts entirely (maintenance/fleet).
  suppress(incident: Incident, project: Project): string | null;
  // Called right before a real delivery; false → over the global rate-limit,
  // divert to digest instead of sending now.
  admit(incident: Incident, project: Project): boolean;
  onDiverted?(incident: Incident, project: Project, reason: 'suppressed' | 'digest', detail?: string): void;
}

export async function runAlerts(db: Db, now: Date = new Date(), control?: AlertControl): Promise<AlertResult> {
  const r: AlertResult = { scannedIncidents: 0, fired: 0, deduped: 0, suppressed: 0, digested: 0 };
  const open = db.select().from(schema.incidents).where(eq(schema.incidents.status, 'open')).all();

  for (const incident of open) {
    r.scannedIncidents++;
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, incident.projectId)).get();
    if (!project) continue;

    // F008.3 — fleet roll-up / maintenance suppression (whole incident).
    if (control) {
      const reason = control.suppress(incident, project);
      if (reason) {
        r.suppressed++;
        control.onDiverted?.(incident, project, 'suppressed', reason);
        continue;
      }
    }

    const rules = db
      .select()
      .from(schema.alertRules)
      .where(and(eq(schema.alertRules.projectId, incident.projectId), eq(schema.alertRules.enabled, true)))
      .all();

    for (const rule of rules) {
      if (!ruleMatches(rule, incident)) continue;
      if (isDeduped(db, rule, incident, now)) {
        r.deduped++;
        continue;
      }
      // F008.3 — global rate-limit: divert overflow to the digest.
      if (control && !control.admit(incident, project)) {
        r.digested++;
        control.onDiverted?.(incident, project, 'digest');
        continue;
      }
      const { channelsSent, errors } = await deliver(rule, incident, project);
      db.insert(schema.alertHistory)
        .values({
          id: crypto.randomUUID(),
          alertRuleId: rule.id,
          firedAt: now,
          payload: { incident_id: incident.id, severity: incident.severity, kind: incident.kind },
          channelsSent,
          errors: errors.length ? errors : null,
        })
        .run();
      r.fired++;
    }
  }
  return r;
}

function ruleMatches(rule: AlertRule, incident: Incident): boolean {
  return rule.kind === incident.kind || rule.kind === '*' || rule.kind === 'all';
}

// Deduped if this rule already fired for this incident inside the window at a
// severity >= the current one. A higher (escalated) severity is NOT deduped.
function isDeduped(db: Db, rule: AlertRule, incident: Incident, now: Date): boolean {
  const since = new Date(now.getTime() - config.alertDedupWindowMs);
  const recent = db
    .select()
    .from(schema.alertHistory)
    .where(and(eq(schema.alertHistory.alertRuleId, rule.id), gte(schema.alertHistory.firedAt, since)))
    .all();
  const curRank = SEVERITY_RANK[incident.severity] ?? 0;
  return recent.some((h) => {
    const p = (h.payload ?? {}) as { incident_id?: string; severity?: string };
    return p.incident_id === incident.id && (SEVERITY_RANK[p.severity ?? ''] ?? 0) >= curRank;
  });
}

// ── delivery ──────────────────────────────────────────────────────────────────
async function deliver(
  rule: AlertRule,
  incident: Incident,
  project: Project,
): Promise<{ channelsSent: string[]; errors: string[] }> {
  const channels = (Array.isArray(rule.channels) ? rule.channels : []) as string[];
  const channelsSent: string[] = [];
  const errors: string[] = [];
  const subject = `[${incident.severity.toUpperCase()}] ${project.name}: ${incident.title}`;

  for (const ch of channels) {
    try {
      if (ch === 'email') {
        if (!config.resendApiKey || !project.alertEmail) throw new Error('email channel not configured');
        await sendEmail(project.alertEmail, subject, incident, project);
      } else if (ch === 'discord') {
        // Per-project webhook wins; otherwise fall back to the single fleet
        // webhook (FLEET_ALERT_DISCORD_WEBHOOK) so the URL has one source, not
        // a copy per project.
        const webhook = project.alertDiscordWebhook || config.fleetAlertDiscordWebhook;
        if (!webhook) throw new Error('discord channel not configured');
        await sendDiscord(webhook, subject, incident);
      } else if (ch === 'webhook') {
        const url = ((rule.condition ?? {}) as { webhook_url?: string }).webhook_url;
        if (!url) throw new Error('webhook channel has no condition.webhook_url');
        await sendWebhook(url, incident, project);
      } else {
        throw new Error(`unknown channel "${ch}"`);
      }
      channelsSent.push(ch);
    } catch (err) {
      errors.push(`${ch}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { channelsSent, errors };
}

async function sendEmail(to: string, subject: string, incident: Incident, project: Project): Promise<void> {
  const res = await fetch(`${config.resendApiBase}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: config.authEmailFrom,
      to: [to],
      subject,
      html: `<p><b>${incident.severity.toUpperCase()}</b> incident on ${project.name}</p><p>${incident.title}</p><p>kind: ${incident.kind}</p>`,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}

async function sendDiscord(webhookUrl: string, subject: string, incident: Incident): Promise<void> {
  const color = incident.severity === 'critical' ? 0xef4444 : incident.severity === 'high' ? 0xf59e0b : 0x3b82f6;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Title links straight to the flagged case (no token — the recipient is
    // already authed via cookie; a login token in a Discord channel would be
    // insecure). F012.
    body: JSON.stringify({ embeds: [{ title: subject, url: `${config.authBaseUrl}/incidents?id=${incident.id}`, description: `kind: ${incident.kind}`, color }] }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`discord ${res.status}`);
}

async function sendWebhook(url: string, incident: Incident, project: Project): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'incident_alert',
      incident: {
        id: incident.id,
        kind: incident.kind,
        severity: incident.severity,
        title: incident.title,
        project_id: project.id,
        opened_at: incident.openedAt,
      },
    }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}
