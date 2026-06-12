// F019.7 — deploy-complete relay (PULL model). upmetrics is cloud; buddy is
// Tailscale-local and NOT cloud-reachable, so upmetrics cannot push an intercom.
// Same shape as the remediation pull-feed (incidents/relay.ts): upmetrics exposes
// terminal deploys that carry an originator and haven't been relayed yet; buddy's
// poll-loop consumes the feed, sends the intercom to the originating cc-session,
// then stamps relayed_at here. Idempotent — exactly one relay per deploy row. A
// terminal deploy with NO originator cannot be routed, so it never enters the feed
// (it is logged at ingest for visibility — see deploys/routes.ts).
import type { Context, Hono } from 'hono';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
const TERMINAL = ['success', 'failure'];

export interface DeployRelayItem {
  deploy_row_id: string; // the deploy_events.id buddy stamps after relaying
  deploy_id: string | null; // external deploy id (may be null)
  project: string;
  site: string;
  status: string; // success | failure
  sha: string | null;
  version: string | null;
  originator: string; // the cc-session/repo to ping (never null in the feed)
  verdict: 'healthy' | 'regressed' | null; // F019.9 post-deploy health (null until evaluated)
  verdictReason: string | null;
  deployed_at: string; // ISO
}

// Eligible = terminal (success|failure) + has an originator + not yet relayed.
// Oldest first so buddy relays in deploy order.
export function pendingDeployRelays(db: Db): DeployRelayItem[] {
  const rows = db
    .select()
    .from(schema.deployEvents)
    .where(
      and(
        inArray(schema.deployEvents.status, TERMINAL),
        isNotNull(schema.deployEvents.originator),
        isNull(schema.deployEvents.relayedAt),
      ),
    )
    .orderBy(asc(schema.deployEvents.updatedAt))
    .all();
  return rows.map((r) => ({
    deploy_row_id: r.id,
    deploy_id: r.deployId,
    project: r.projectId,
    site: r.site,
    status: r.status,
    sha: r.sha,
    version: r.version,
    originator: r.originator!, // guaranteed by the isNotNull filter above
    verdict: r.regressionVerdict as DeployRelayItem['verdict'],
    verdictReason: (r.regressionDetail as { reason?: string } | null)?.reason ?? null,
    deployed_at: r.updatedAt.toISOString(),
  }));
}

export interface RelayStampResult {
  ok: boolean;
  alreadyRelayed: boolean;
}

// Idempotent: stamping an already-relayed deploy is a 200 no-op (1 relay per
// deploy). Unknown row → ok:false so the route can 404.
export function stampRelayed(db: Db, rowId: string, now: Date = new Date()): RelayStampResult {
  const row = db.select().from(schema.deployEvents).where(eq(schema.deployEvents.id, rowId)).get();
  if (!row) return { ok: false, alreadyRelayed: false };
  if (row.relayedAt) return { ok: true, alreadyRelayed: true };
  db.update(schema.deployEvents).set({ relayedAt: now }).where(eq(schema.deployEvents.id, rowId)).run();
  return { ok: true, alreadyRelayed: false };
}

// Reuses the remediation relay Bearer token — buddy's poll-loop already holds it,
// and both feeds are the same trust boundary (outbound pull by the orchestrator).
function authed(c: Context): boolean {
  const token = config.remediationRelayToken;
  if (!token) return false; // disabled until a token is configured
  return (c.req.header('authorization') ?? '') === `Bearer ${token}`;
}

// ── F019.11 push-relay ────────────────────────────────────────────────────────
// Build the intercom text + severity for a deploy-complete ping to the originating
// cc-session. Enriched with the F019.9 health verdict when it has been evaluated
// (usually null on the immediate ping — the deploy just landed; the verdict comes
// ~15m later, so a deploy that sat unrelayed long enough carries it). Pure → tested.
type Severity = 'info' | 'warn' | 'critical';
export function deployRelayMessage(item: DeployRelayItem): { message: string; severity: Severity } {
  const ver = item.version ?? (item.sha ? item.sha.slice(0, 7) : '?');
  if (item.status === 'failure') {
    return { message: `❌ Deploy af ${item.site} fejlede (${ver}).`, severity: 'warn' };
  }
  if (item.verdict === 'regressed') {
    const why = item.verdictReason ?? 'fejlrate steg efter deploy';
    return {
      message: `⚠️ Deploy af ${item.site} er live (${ver}) MEN regredierede — ${why}. Tjek https://upmetrics.org/deploys`,
      severity: 'warn',
    };
  }
  if (item.verdict === 'healthy') {
    return { message: `✅ Deploy af ${item.site} live (${ver}) — health-check OK efter deploy.`, severity: 'info' };
  }
  return { message: `✅ Deploy af ${item.site} live (${ver}). Du kan fortsætte.`, severity: 'info' };
}

export interface DeployPushResult {
  pushed: number; // routed + stamped relayed
  offline: number; // 404 no_edge_for_session — left unstamped for retry / pull-feed
  failed: number; // other non-2xx / network error — left unstamped
  suppressed: number; // too old to be useful — stamped without pinging (anti-storm)
}

// Push every pending deploy-relay to buddycloud.cc, which routes it to the
// originating cc-session (same routing as ask_peer). Only a 200 stamps relayed_at
// (idempotent, exactly one relay per deploy). A 404 means the target session is
// offline — leave it unstamped so the next tick (or buddy's pull-feed) retries. A
// deploy older than deployRelayMaxAgeMs is suppressed (stamped, not pinged) so a
// backlog can't storm the fleet. Disabled (no-op) until BUDDY_CLOUD_DISPATCH_TOKEN
// is set → the pull-feed remains the path.
export async function pushDeployRelays(db: Db, now: Date = new Date()): Promise<DeployPushResult> {
  const res: DeployPushResult = { pushed: 0, offline: 0, failed: 0, suppressed: 0 };
  if (!config.buddyCloudDispatchToken) return res;
  const cutoff = now.getTime() - config.deployRelayMaxAgeMs;
  for (const item of pendingDeployRelays(db)) {
    if (Date.parse(item.deployed_at) < cutoff) {
      stampRelayed(db, item.deploy_row_id, now); // stale → suppress, never ping
      res.suppressed++;
      continue;
    }
    const { message, severity } = deployRelayMessage(item);
    try {
      const r = await fetch(config.buddyCloudDispatchUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.buddyCloudDispatchToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: item.originator, message, from: 'upmetrics', severity }),
      });
      if (r.ok) {
        stampRelayed(db, item.deploy_row_id, now);
        res.pushed++;
      } else if (r.status === 404) {
        res.offline++; // target offline — do NOT stamp; retry next tick / pull-feed
      } else {
        res.failed++;
        console.error(`[deploy-relay] push ${item.site}→${item.originator} HTTP ${r.status}`);
      }
    } catch (err) {
      res.failed++;
      console.error(`[deploy-relay] push ${item.site}→${item.originator} failed:`, err);
    }
  }
  return res;
}

export function registerDeployRelayRoutes(app: Hono): void {
  // Buddy polls this outbound, then sends the intercom to each item's originator.
  app.get('/api/deploys/pending-relays', (c) => {
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ deploys: pendingDeployRelays(getDb()) });
  });

  // Buddy stamps a deploy as relayed after it has pinged the originator.
  app.post('/api/deploys/:id/relayed', (c) => {
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
    const res = stampRelayed(getDb(), c.req.param('id'));
    if (!res.ok) return c.json({ error: 'unknown_deploy' }, 404);
    return c.json({ ok: true, already_relayed: res.alreadyRelayed });
  });
}
