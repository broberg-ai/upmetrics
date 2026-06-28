// Probe CRUD + cronjobs sync (F004.1). Authed by X-Upmetrics-Key. Creating a
// probe registers a cronjobs trigger job that calls /api/probes/:id/run on
// schedule; deleting removes that job. The actual check logic lives in the run
// endpoint (F004.2) — here it is a guarded stub.
import type { Context, Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { createProbeJob, deleteProbeJob } from './cronjobs';
import { runCheck } from './check';
import { parseTiers, severityForFailures, escalatedSeverity } from './escalation';
import { insertSnapshot } from '../credits/store';
import { evalCreditAlarm } from '../credits/alarms';

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

function runUrl(probeId: string): string {
  return `${config.authBaseUrl}/api/probes/${probeId}/run`;
}

export function registerProbeRoutes(app: Hono): void {
  // Create
  app.post('/api/probes', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    if (!b.name || !b.kind || !b.target || !b.interval_seconds) {
      return c.json({ error: 'missing_fields', need: ['name', 'kind', 'target', 'interval_seconds'] }, 400);
    }
    const db = getDb();
    const id = crypto.randomUUID();
    const runToken = crypto.randomUUID().replace(/-/g, '');
    db.insert(schema.probes)
      .values({
        id,
        projectId: project.id,
        name: b.name,
        kind: b.kind, // http | tcp | keyword | ssl
        target: b.target,
        config: { ...(b.config ?? {}), runToken },
        intervalSeconds: Number(b.interval_seconds),
        status: 'paused',
        consecutiveFailures: 0,
      })
      .run();

    let cronjobsJobId: string | null = null;
    try {
      cronjobsJobId = await createProbeJob(b.name, Number(b.interval_seconds), runUrl(id), runToken);
      db.update(schema.probes).set({ cronjobsJobId }).where(eq(schema.probes.id, id)).run();
    } catch (err) {
      return c.json({ id, cronjobs_synced: false, error: `probe saved but cronjobs sync failed: ${(err as Error).message}` }, 502);
    }
    return c.json({ id, cronjobs_job_id: cronjobsJobId, cronjobs_synced: true });
  });

  // List (project-scoped)
  app.get('/api/probes', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const rows = getDb().select().from(schema.probes).where(eq(schema.probes.projectId, project.id)).all();
    return c.json({ probes: rows });
  });

  // Delete (removes the cronjobs job too)
  app.delete('/api/probes/:id', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const probe = db
      .select()
      .from(schema.probes)
      .where(and(eq(schema.probes.id, c.req.param('id')), eq(schema.probes.projectId, project.id)))
      .get();
    if (!probe) return c.json({ error: 'unknown_probe' }, 404);
    if (probe.cronjobsJobId) await deleteProbeJob(probe.cronjobsJobId).catch(() => {});
    // probe_results FK-references the probe; clear history before deleting the probe.
    db.delete(schema.probeResults).where(eq(schema.probeResults.probeId, probe.id)).run();
    db.delete(schema.probes).where(eq(schema.probes.id, probe.id)).run();
    return c.json({ ok: true });
  });

  // Run trigger — called by cronjobs on schedule (F004.2). Performs the actual
  // check, records the result, updates status, opens/auto-resolves probe_down.
  app.get('/api/probes/:id/run', async (c) => {
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'unknown_probe' }, 404);
    const cfg = (probe.config ?? {}) as Record<string, any>;
    if (c.req.header('x-upmetrics-run-key') !== cfg.runToken) return c.json({ error: 'bad_run_key' }, 401);

    const result = await runCheck(probe);
    const now = new Date();
    const threshold = Number(cfg.failure_threshold ?? 3);

    db.insert(schema.probeResults)
      .values({
        id: crypto.randomUUID(),
        probeId: probe.id,
        checkedAt: now,
        ok: result.ok,
        responseMs: result.responseMs ?? null,
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
      })
      .run();

    if (result.ok) {
      db.update(schema.probes)
        .set({ status: 'up', consecutiveFailures: 0, lastCheckAt: now, lastResponseMs: result.responseMs ?? null })
        .where(eq(schema.probes.id, probe.id))
        .run();
      // Auto-resolve any open probe_down incident for this probe.
      db.update(schema.incidents)
        .set({ status: 'resolved', resolvedAt: now })
        .where(
          and(
            eq(schema.incidents.triggerRef, probe.id),
            eq(schema.incidents.kind, 'probe_down'),
            eq(schema.incidents.status, 'open'),
          ),
        )
        .run();
    } else {
      const failures = probe.consecutiveFailures + 1;
      db.update(schema.probes)
        .set({ status: failures >= threshold ? 'down' : 'degraded', consecutiveFailures: failures, lastCheckAt: now })
        .where(eq(schema.probes.id, probe.id))
        .run();

      if (failures >= threshold) {
        // F019.2 — derive severity from the escalation ladder; default to 'high'
        // (the F004 baseline) when the failure count is below the first tier.
        const tiers = parseTiers(config.probeEscalateTiers);
        const tierSeverity = severityForFailures(failures, tiers);
        const open = db
          .select()
          .from(schema.incidents)
          .where(
            and(
              eq(schema.incidents.triggerRef, probe.id),
              eq(schema.incidents.kind, 'probe_down'),
              eq(schema.incidents.status, 'open'),
            ),
          )
          .get();
        if (!open) {
          db.insert(schema.incidents)
            .values({
              id: crypto.randomUUID(),
              projectId: probe.projectId,
              kind: 'probe_down',
              status: 'open',
              severity: tierSeverity ?? 'high',
              title: `${probe.name} is down`,
              openedAt: now,
              triggerRef: probe.id,
              eventsAtOpen: { consecutive_failures: failures, last_error: result.error ?? null },
            })
            .run();
        } else {
          // F019.2 — escalate an already-open incident when a higher tier is now
          // reached. Only ever raises; the alert engine re-fires on the higher
          // severity (isDeduped breaks on a severity bump). Never downgrades.
          const raised = escalatedSeverity(open.severity, tierSeverity);
          if (raised) {
            db.update(schema.incidents).set({ severity: raised }).where(eq(schema.incidents.id, open.id)).run();
          }
        }
      }
    }

    // F022.3/F022.4 — provider_balance: on a successful poll, persist the
    // credit_snapshot + evaluate the low-balance alarm. This is separate from the
    // probe_down reachability incident above: probe_down = "balance unreadable",
    // credit_low = "balance read fine, but it's running low".
    if (probe.kind === 'provider_balance' && result.ok && result.balance) {
      const provider = String((cfg.provider as string | undefined) ?? 'openrouter');
      const snap = insertSnapshot(db, {
        provider,
        totalCredits: result.balance.totalCredits,
        totalUsage: result.balance.totalUsage,
        raw: result.balance.raw,
        capturedAt: now,
      });
      evalCreditAlarm(db, probe.projectId, snap, now);
    }

    return c.json({ ok: result.ok, status_code: result.statusCode, response_ms: result.responseMs, error: result.error });
  });
}
