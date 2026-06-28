// F022 — provider credit endpoints. F022.2: credit-snapshot ingest (write).
// The export-API (F022.5, read-only) is registered alongside once built.
import type { Context, Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { and, sql } from 'drizzle-orm';
import { config } from '../config';
import { getDb, schema } from '../db';
import { insertSnapshot, latestSnapshot, recentSnapshots } from './store';
import { alarmState, burnRate, thresholdsFor } from './alarms';
import { usdToDkk } from '../fx/rate';

const usd2 = (n: number): number => Math.round(n * 100) / 100; // money → cents, once
// Live USD→DKK (F023; usdToDkk() = live → rolling-5 avg → config default). Called
// per-request so external callers always get the current rate.
const dkk2 = (usd: number): number => Math.round(usd * usdToDkk() * 100) / 100;
const MICRO = 1_000_000;

// Constant-time compare. Empty expected secret → always false (ship-dark: the
// endpoint is unusable until the secret is set).
function tokenAuthedValue(key: string, expected: string): boolean {
  if (!key || !expected) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function tokenAuthed(c: Context, header: string, expected: string): boolean {
  return tokenAuthedValue(c.req.header(header) ?? '', expected);
}

export function registerCreditRoutes(app: Hono): void {
  // F022.2 — ingest one provider balance reading → append-only snapshot.
  // Authed by CREDIT_INGEST_TOKEN (x-upmetrics-credit-key); never public. Used by
  // mock/manual injection + any external producer; the provider_balance probe
  // (F022.3) writes in-process through the same store.
  app.post('/api/providers/:provider/credit-snapshot', async (c) => {
    if (!tokenAuthed(c, 'x-upmetrics-credit-key', config.creditIngestToken)) {
      return c.json({ error: 'invalid_credit_key' }, 401);
    }
    const provider = c.req.param('provider');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const totalCredits = Number(b.total_credits);
    const totalUsage = Number(b.total_usage);
    // Malformed or negative-balance payloads → 400, no row written.
    if (
      !Number.isFinite(totalCredits) ||
      !Number.isFinite(totalUsage) ||
      totalCredits < 0 ||
      totalUsage < 0 ||
      totalUsage > totalCredits // remaining can't be negative on a prepaid account
    ) {
      return c.json({ error: 'invalid_payload', need: ['total_credits>=0', 'total_usage in [0, total_credits]'] }, 400);
    }
    const snap = insertSnapshot(getDb(), {
      provider,
      totalCredits,
      totalUsage,
      currency: typeof b.currency === 'string' ? b.currency : 'USD',
      raw: b.raw ?? b,
    });
    return c.json({ ok: true, id: snap.id, provider, remaining: snap.remaining, captured_at: snap.capturedAt });
  });

  // ── F022.5 — export-API (read-only, scoped Bearer) ───────────────────────────
  // A consumer (Cardmem) reads balance/usage but can NEVER write probes/alarms:
  // these are gated on EXPORT_READ_TOKEN, a token distinct from the write-capable
  // project uk_. No OpenRouter detail leaks — pure Upmetrics contract.
  const exportAuthed = (c: Context): boolean => {
    const h = c.req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    return tokenAuthedValue(token, config.exportReadToken);
  };
  const guard = (c: Context) => (exportAuthed(c) ? null : c.json({ error: 'invalid_export_token' }, 401));

  // Latest balance. No snapshot yet (ship-dark / not armed) → 200 has_data:false
  // so a consumer can wire against the empty state without special-casing a 404.
  app.get('/api/v1/providers/:provider/balance', (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const provider = c.req.param('provider');
    const snap = latestSnapshot(getDb(), provider);
    if (!snap) return c.json({ provider, has_data: false, usd_to_dkk: usdToDkk() });
    return c.json({
      provider,
      has_data: true,
      total_credits_usd: usd2(snap.totalCredits),
      total_usage_usd: usd2(snap.totalUsage),
      remaining_usd: usd2(snap.remaining),
      remaining_dkk: dkk2(snap.remaining),
      usd_to_dkk: usdToDkk(),
      currency: snap.currency,
      captured_at: snap.capturedAt,
      alarm: alarmState(snap.remaining, thresholdsFor(provider)),
    });
  });

  // Snapshot time-series for the history graph. ?from&to (ISO/epoch-ms); default
  // last 30d. granularity is accepted for forward-compat; v1 returns raw points.
  app.get('/api/v1/providers/:provider/balance/history', (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const provider = c.req.param('provider');
    const now = Date.now();
    const toMs = parseTime(c.req.query('to')) ?? now;
    const fromMs = parseTime(c.req.query('from')) ?? toMs - 2_592_000_000; // 30d
    const rows = getDb()
      .select()
      .from(schema.creditSnapshots)
      .where(
        and(
          sql`provider = ${provider}`,
          sql`captured_at >= ${fromMs}`,
          sql`captured_at <= ${toMs}`,
        ),
      )
      .orderBy(sql`captured_at ASC`)
      .all();
    return c.json({
      provider,
      window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      points: rows.map((r) => ({
        captured_at: r.capturedAt,
        total_credits_usd: usd2(r.totalCredits),
        total_usage_usd: usd2(r.totalUsage),
        remaining_usd: usd2(r.remaining),
      })),
    });
  });

  // Burn-rate: spend/day + estimated "empty in N days" from the last two snapshots.
  app.get('/api/v1/providers/:provider/burn-rate', (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const provider = c.req.param('provider');
    const recent = recentSnapshots(getDb(), provider, 2);
    const b = burnRate(recent);
    return c.json({
      provider,
      per_day_usd: b.per_day == null ? null : usd2(b.per_day),
      days_left: b.days_left == null ? null : Math.round(b.days_left * 10) / 10,
      based_on_snapshots: recent.length,
    });
  });

  // Current alarm badge state (ok/warn/critical) from the latest snapshot.
  app.get('/api/v1/providers/:provider/alarms', (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const provider = c.req.param('provider');
    const t = thresholdsFor(provider);
    const snap = latestSnapshot(getDb(), provider);
    return c.json({
      provider,
      state: snap ? alarmState(snap.remaining, t) : 'unknown',
      remaining_usd: snap ? usd2(snap.remaining) : null,
      thresholds: t,
      captured_at: snap?.capturedAt ?? null,
    });
  });

  // Spend breakdown from agent_runs (where the money went). group_by=model|project
  // |day; optional provider filter; ?from&to. micro_usd, matching the cost API.
  app.get('/api/v1/usage/breakdown', (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const now = Date.now();
    const toMs = parseTime(c.req.query('to')) ?? now;
    const fromMs = parseTime(c.req.query('from')) ?? toMs - 604_800_000; // 7d
    const gb = c.req.query('group_by') ?? 'model';
    const keyExpr =
      gb === 'project' ? sql`project_id` : gb === 'day' ? sql`strftime('%Y-%m-%dT00:00:00Z', started_at / 1000, 'unixepoch')` : sql`model`;
    const parts = [sql`started_at >= ${fromMs}`, sql`started_at <= ${toMs}`];
    const provider = c.req.query('provider');
    if (provider) parts.push(sql`provider = ${provider}`);
    const rows = getDb().all(sql`
      SELECT ${keyExpr} AS key, COUNT(*) AS run_count,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM agent_runs WHERE ${sql.join(parts, sql` AND `)} GROUP BY key ORDER BY cost_usd DESC
    `) as Array<{ key: string; run_count: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
    return c.json({
      generated_at: new Date(now).toISOString(),
      group_by: gb === 'project' || gb === 'day' ? gb : 'model',
      provider: provider ?? null,
      window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      by_group: rows.map((r) => ({
        key: r.key,
        micro_usd: Math.round(Number(r.cost_usd) * MICRO),
        run_count: Number(r.run_count),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
      })),
    });
  });
}

// epoch-ms from an ISO-8601 string or epoch-ms number string; undefined if unparseable.
function parseTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}
