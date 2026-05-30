// Incident routes (F005.3). The remediation receiver POSTs status back here so
// the outcome is recorded on the incident timeline. Authed by the per-dispatch
// remediation_token (in the X-Upmetrics-Remediation-Token header or the body).
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

export function registerIncidentRoutes(app: Hono): void {
  app.post('/api/incidents/:id/remediation-callback', async (c) => {
    const db = getDb();
    const inc = db.select().from(schema.incidents).where(eq(schema.incidents.id, c.req.param('id'))).get();
    if (!inc) return c.json({ error: 'unknown_incident' }, 404);

    const ra = (inc.remediationAttempts ?? null) as { token?: string; callbacks?: unknown[] } | null;
    if (!ra?.token) return c.json({ error: 'no_remediation_dispatched' }, 409);

    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const token = c.req.header('x-upmetrics-remediation-token') ?? (b.remediation_token as string | undefined);
    if (token !== ra.token) return c.json({ error: 'bad_remediation_token' }, 401);

    const callbacks = Array.isArray(ra.callbacks) ? ra.callbacks : [];
    callbacks.push({ at: new Date().toISOString(), status: b.status ?? 'unknown', detail: b.detail ?? null });
    db.update(schema.incidents)
      .set({ remediationAttempts: { ...ra, callbacks } })
      .where(eq(schema.incidents.id, inc.id))
      .run();
    return c.json({ ok: true });
  });
}
