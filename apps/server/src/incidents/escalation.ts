// F010.5 — escalate remediation incidents that stayed UNCLAIMED past the window
// (no cc session picked them up: Buddy down, no live session for the repo, or a
// claim that failed silently). One fleet-Discord alert per incident, deduped on
// escalation_alerted_at. This is the safety net behind the silent-stall failure
// mode — a pending remediation nobody actions now SHOUTS instead of sitting open.
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { unclaimedEscalations } from './relay';
import { sendFleet } from './storm';

type Db = ReturnType<typeof getDb>;

export interface EscalateOpts {
  now?: Date;
  webhookUrl?: string;
  // Injectable Discord sender (defaults to the shared storm fleet sender).
  send?: (url: string, message: string, color: number) => Promise<void>;
}

// Send a fleet-Discord alert for each remediation that's been eligible + unclaimed
// past REMEDIATION_ESCALATE_MS and not yet alerted. Returns the count escalated.
export async function escalateUnclaimed(db: Db, opts: EscalateOpts = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const webhookUrl = opts.webhookUrl ?? config.fleetAlertDiscordWebhook;
  const send = opts.send ?? sendFleet;

  const fresh = unclaimedEscalations(db, now).filter((i) => {
    const row = db
      .select({ a: schema.incidents.escalationAlertedAt })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, i.incident_id))
      .get();
    return row != null && row.a == null; // not yet alerted → one alert per incident
  });
  if (!fresh.length) return 0;

  const mins = Math.round(config.remediationEscalateMs / 60_000);
  const lines = fresh.map((i) => `• [${i.severity}] ${i.issue.title} — ${i.repo} · ${i.issue.dashboard_url}`);
  const message = `⚠️ Remediation unclaimed >${mins}m — no cc session has picked up ${fresh.length} incident(s):\n${lines.join('\n')}`;
  await send(webhookUrl, message, 0xef4444); // red (matches storm rollup)

  // Stamp AFTER a successful send, so a failed alert retries on the next tick
  // instead of being silently swallowed.
  for (const i of fresh) {
    db.update(schema.incidents).set({ escalationAlertedAt: now }).where(eq(schema.incidents.id, i.incident_id)).run();
  }
  return fresh.length;
}
