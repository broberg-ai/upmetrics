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
