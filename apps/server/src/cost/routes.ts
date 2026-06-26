// F014 — Cost read-API. Project-scoped read surface over agent_runs so each
// enrolled app can show its OWN accumulated LLM/agent cost in its own UI.
// Auth: header X-Upmetrics-Key = the project's api_key (same per-project key as
// ingest; reused read-side for v1). Money is ALWAYS integer micro-USD ($1 =
// 1_000_000): SUM(cost_usd) in full REAL precision, round ONCE at the boundary
// (trail pitfall #3). USD is source-of-truth; the summary ALSO publishes
// usd_to_dkk (config single-source) so clients convert from one rate instead of
// hardcoding their own FX.
// metered: a run is "free" when transport=subprocess OR cost_usd=0 (Max-Plan).
import type { Context, Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;

const WINDOW_MS: Record<string, number> = {
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  // friendly aliases so callers can pass 1d/24h/7d/30d (buddy's fleet digest uses 1d)
  '1d': 86_400_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};
const MICRO = 1_000_000;
const microUsd = (usd: unknown): number => Math.round(Number(usd ?? 0) * MICRO);

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

// epoch-ms from an ISO-8601 string or an epoch-ms number string; undefined if unparseable.
function parseTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

function resolveWindow(q: Record<string, string | undefined>, now: number) {
  const toMs = parseTime(q.to) ?? now;
  const fromExplicit = parseTime(q.from);
  const span = WINDOW_MS[q.window ?? 'week'] ?? 604_800_000; // default 7d
  const fromMs = fromExplicit ?? toMs - span;
  return { fromMs, toMs };
}

// A tag key safe to embed in a json path / group label. The SDK merges generic
// `labels` (tenantId, kbId, …) into tags (ai-sdk #2676), so cost can be sliced
// per tenant within ONE project — no per-tenant api_key. Identifier-only keys
// keep the json-path bind injection-safe and reject malformed query params.
const TAG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const tagPath = (key: string) => `$.${key}`;

// Composable WHERE: project + window + optional filters. transport lives in the
// tags JSON, so it's matched via json_extract. Any `?tag.<key>=<value>` param
// becomes a generic tag match (the per-tenant filter trail's panel queries with).
function buildWhere(projectId: string, fromMs: number, toMs: number, q: Record<string, string | undefined>) {
  const parts = [
    sql`project_id = ${projectId}`,
    sql`started_at >= ${fromMs}`,
    sql`started_at < ${toMs}`,
  ];
  if (q.provider) parts.push(sql`provider = ${q.provider}`);
  if (q.model) parts.push(sql`model = ${q.model}`);
  if (q.tier) parts.push(sql`tier = ${q.tier}`);
  if (q.agent_name) parts.push(sql`agent_name = ${q.agent_name}`);
  if (q.transport) parts.push(sql`json_extract(tags, '$.transport') = ${q.transport}`);
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith('tag.') || v == null) continue;
    const key = k.slice(4);
    if (TAG_KEY.test(key)) parts.push(sql`json_extract(tags, ${tagPath(key)}) = ${v}`);
  }
  return sql.join(parts, sql` AND `);
}

interface BreakdownRow { key: string; run_count: number; cost_usd: number; input_tokens: number; output_tokens: number }
const FREE = sql`(json_extract(tags, '$.transport') = 'subprocess' OR cost_usd = 0)`;

function breakdown(db: Db, where: ReturnType<typeof buildWhere>, keyExpr: ReturnType<typeof sql>) {
  const rows = db.all(sql`
    SELECT ${keyExpr} AS key, COUNT(*) AS run_count,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM agent_runs WHERE ${where} GROUP BY ${keyExpr} ORDER BY cost_usd DESC
  `) as BreakdownRow[];
  return rows.map((r) => ({
    key: r.key,
    micro_usd: microUsd(r.cost_usd),
    input_tokens: Number(r.input_tokens),
    output_tokens: Number(r.output_tokens),
    run_count: Number(r.run_count),
  }));
}

export function costSummary(db: Db, projectId: string, q: Record<string, string | undefined>, now: number) {
  const { fromMs, toMs } = resolveWindow(q, now);
  const where = buildWhere(projectId, fromMs, toMs, q);
  // db.all(raw sql) yields keyed-object rows in drizzle-bun-sqlite (db.get yields
  // a positional array for raw SQL) — use all()[0] for a single keyed row.
  const t = (db.all(sql`
    SELECT
      COUNT(*) AS run_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(CASE WHEN ${FREE} THEN 0 ELSE cost_usd END), 0) AS metered_cost_usd,
      COALESCE(SUM(CASE WHEN ${FREE} THEN 1 ELSE 0 END), 0) AS free_run_count
    FROM agent_runs WHERE ${where}
  `) as Record<string, number>[])[0] ?? {};
  const summary = {
    generated_at: new Date(now).toISOString(),
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    total_micro_usd: microUsd(t.cost_usd),
    // DKK companion off the single config rate. usd_to_dkk lets clients convert
    // ANY micro_usd field (e.g. a ?tag.capability=tts slice); total_dkk is the
    // ready headline, rounded ONCE to øre from the raw REAL sum.
    usd_to_dkk: config.usdToDkk,
    total_dkk: Math.round(Number(t.cost_usd ?? 0) * config.usdToDkk * 100) / 100,
    input_tokens: Number(t.input_tokens),
    output_tokens: Number(t.output_tokens),
    cache_read_tokens: Number(t.cache_read_tokens),
    cache_creation_tokens: Number(t.cache_creation_tokens),
    run_count: Number(t.run_count),
    metered: { metered_micro_usd: microUsd(t.metered_cost_usd), free_run_count: Number(t.free_run_count) },
    by_provider: breakdown(db, where, sql`provider`),
    by_model: breakdown(db, where, sql`model`),
    by_tier: breakdown(db, where, sql`COALESCE(tier, '(none)')`),
    by_capability: breakdown(db, where, sql`COALESCE(json_extract(tags, '$.capability'), '(none)')`),
  };
  // ?groupBy=<tagKey> → cost per tag value (e.g. groupBy=tenantId → cost per tenant).
  if (q.groupBy && TAG_KEY.test(q.groupBy)) {
    return { ...summary, group_by: q.groupBy, by_group: breakdown(db, where, sql`COALESCE(json_extract(tags, ${tagPath(q.groupBy)}), '(none)')`) };
  }
  return summary;
}

export function costTimeseries(db: Db, projectId: string, q: Record<string, string | undefined>, now: number) {
  const { fromMs, toMs } = resolveWindow(q, now);
  const where = buildWhere(projectId, fromMs, toMs, q);
  const bucket = q.bucket === 'hour' ? 'hour' : 'day';
  // started_at is epoch-ms; strftime works on seconds. GROUP BY only emits
  // buckets that have rows → non-zero buckets only (clients pad zeros).
  const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%dT00:00:00Z';
  const points = db.all(sql`
    SELECT strftime(${fmt}, started_at / 1000, 'unixepoch') AS ts,
      COUNT(*) AS run_count,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM agent_runs WHERE ${where} GROUP BY ts ORDER BY ts ASC
  `) as Array<{ ts: string; run_count: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
  return {
    generated_at: new Date(now).toISOString(),
    bucket,
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    points: points.map((p) => ({
      ts: p.ts,
      micro_usd: microUsd(p.cost_usd),
      input_tokens: Number(p.input_tokens),
      output_tokens: Number(p.output_tokens),
      run_count: Number(p.run_count),
    })),
  };
}

// Cross-project per-agent cost for the org-wide fleet digest (buddy's daily
// Discord report). NO project filter — aggregates every project's runs by
// agent_name over the window. Default window = 1 day (the digest is "yesterday").
// Per-agent micro_usd rounds at each agent boundary; the fleet total rounds once
// from the raw SUM (round-once-at-boundary, trail pitfall #3).
export function costFleet(db: Db, q: Record<string, string | undefined>, now: number) {
  const { fromMs, toMs } = resolveWindow({ ...q, window: q.window ?? 'day' }, now);
  const span = sql`started_at >= ${fromMs} AND started_at < ${toMs}`;
  const rows = db.all(sql`
    SELECT agent_name AS agent_name, COUNT(*) AS run_count,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(CASE WHEN ${FREE} THEN 0 ELSE cost_usd END), 0) AS metered_cost_usd,
      COALESCE(SUM(CASE WHEN ${FREE} THEN 1 ELSE 0 END), 0) AS free_run_count
    FROM agent_runs WHERE ${span} GROUP BY agent_name ORDER BY cost_usd DESC
  `) as Array<{ agent_name: string; run_count: number; cost_usd: number; metered_cost_usd: number; free_run_count: number }>;
  const total = (db.all(sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd, COUNT(*) AS run_count
    FROM agent_runs WHERE ${span}
  `) as Array<{ cost_usd: number; run_count: number }>)[0] ?? { cost_usd: 0, run_count: 0 };
  return {
    generated_at: new Date(now).toISOString(),
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    total_usd: Number(total.cost_usd),
    total_micro_usd: microUsd(total.cost_usd),
    run_count: Number(total.run_count),
    by_agent: rows.map((r) => ({
      agent_name: r.agent_name,
      runs: Number(r.run_count),
      cost_usd: Number(r.cost_usd),
      micro_usd: microUsd(r.cost_usd),
      metered_micro_usd: microUsd(r.metered_cost_usd),
      free_runs: Number(r.free_run_count),
    })),
  };
}

// Org read-token check (timing-safe). Distinct header from the project key so a
// project api_key can never accidentally satisfy a cross-project read.
function fleetAuthed(c: Context): boolean {
  const key = c.req.header('x-upmetrics-fleet-key');
  const expected = config.fleetReadKey;
  if (!key || !expected) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerCostRoutes(app: Hono): void {
  app.get('/api/cost/summary', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    return c.json(costSummary(getDb(), project.id, c.req.query(), Date.now()));
  });

  app.get('/api/cost/timeseries', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    return c.json(costTimeseries(getDb(), project.id, c.req.query(), Date.now()));
  });

  app.get('/api/cost/fleet', (c) => {
    if (!fleetAuthed(c)) return c.json({ error: 'invalid_fleet_key' }, 401);
    return c.json(costFleet(getDb(), c.req.query(), Date.now()));
  });
}
