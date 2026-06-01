// Agent-run ingest (F002.3). POST /api/agent authed by X-Upmetrics-Key (project
// api_key). Modes: start (status=running, returns run_id), finish (final state),
// record (one-shot completed run). Writes agent_runs (PLAN §5/§8).
//
// Validation posture (Postel: strict shape, liberal values) — the sink contract
// for @broberg/ai-sdk's upmetricsSink (docs/AGENT-SCHEMA.md):
//   • types + required fields are validated (cost_usd:"abc" → 400, not NaN stored);
//   • identity/tier/status stay FREE STRINGS, never z.enum — so any new
//     provider/model/tier/capability the SDK grows never 400s a telemetry run;
//   • unknown top-level keys are swept into `tags` so no cost dimension is ever
//     silently dropped (transport/capability/future fields survive without a
//     schema migration).
import type { Context, Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db';

// Coerce-then-require-finite: catches NaN/Infinity (e.g. cost_usd:"abc") instead
// of silently persisting garbage. .default() short-circuits undefined to a valid
// finite value, so omitted metrics still default to 0.
const finiteNum = z.coerce.number().refine(Number.isFinite, { message: 'must be a finite number' });
const toolCall = z.object({ name: z.string(), count: finiteNum, error_count: finiteNum.optional() });
const artifact = z.object({ type: z.string(), ref: z.string() });

const bodySchema = z.object({
  mode: z.string().default('record'),
  run_id: z.string().optional(),
  // identity — free strings (open value-space); per-mode required check below.
  agent_kind: z.string().optional(),
  agent_name: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  task: z.string().optional(),
  purpose: z.string().nullish(),
  tier: z.string().nullish(),
  status: z.string().optional(),
  session_id: z.string().nullish(),
  parent_run_id: z.string().nullish(),
  started_at: z.union([z.string(), z.number()]).optional(),
  ended_at: z.union([z.string(), z.number()]).optional(),
  duration_ms: finiteNum.optional(),
  input_tokens: finiteNum.default(0),
  output_tokens: finiteNum.default(0),
  cache_read_tokens: finiteNum.default(0),
  cache_creation_tokens: finiteNum.default(0),
  cost_usd: finiteNum.default(0),
  tool_calls: z.array(toolCall).nullish(),
  artifacts: z.array(artifact).nullish(),
  prompt_excerpt: z.string().nullish(),
  response_excerpt: z.string().nullish(),
  error_issue_id: z.string().nullish(),
  tags: z.record(z.string(), z.unknown()).nullish(),
});
type ParsedBody = z.infer<typeof bodySchema>;
const KNOWN_KEYS = new Set(Object.keys(bodySchema.shape));

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

// Common metric fields shared by finish/record. `tags` already carries swept extras.
function metrics(b: ParsedBody, tags: Record<string, unknown> | null) {
  return {
    inputTokens: b.input_tokens,
    outputTokens: b.output_tokens,
    cacheReadTokens: b.cache_read_tokens,
    cacheCreationTokens: b.cache_creation_tokens,
    costUsd: b.cost_usd,
    toolCalls: b.tool_calls ?? null,
    artifacts: b.artifacts ?? null,
    promptExcerpt: b.prompt_excerpt ?? null,
    responseExcerpt: b.response_excerpt ?? null,
    errorIssueId: b.error_issue_id ?? null,
    tags,
  };
}

export function registerAgentRoutes(app: Hono): void {
  app.post('/api/agent', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);

    const db = getDb();
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_body', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        400,
      );
    }
    const b = parsed.data;

    // Sweep unknown top-level keys into tags — nothing is silently dropped, and a
    // new SDK field never needs a schema migration. Explicit `tags` win on clash.
    const extras: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) extras[k] = raw[k];
    const tags = Object.keys(extras).length || b.tags ? { ...extras, ...(b.tags ?? {}) } : null;

    const mode = b.mode;
    const now = new Date();

    if (mode === 'start') {
      if (!b.agent_kind || !b.agent_name || !b.provider || !b.model) {
        return c.json({ error: 'missing_fields', need: ['agent_kind', 'agent_name', 'provider', 'model'] }, 400);
      }
      const id = crypto.randomUUID();
      db.insert(schema.agentRuns)
        .values({
          id,
          projectId: project.id,
          sessionId: b.session_id ?? null,
          parentRunId: b.parent_run_id ?? null,
          agentKind: b.agent_kind,
          agentName: b.agent_name,
          task: b.task ?? '',
          purpose: b.purpose ?? null,
          provider: b.provider,
          model: b.model,
          tier: b.tier ?? null,
          status: 'running',
          startedAt: now,
          tags,
        })
        .run();
      return c.json({ run_id: id });
    }

    if (mode === 'finish') {
      if (!b.run_id) return c.json({ error: 'missing_run_id' }, 400);
      const run = db
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.id, b.run_id), eq(schema.agentRuns.projectId, project.id)))
        .get();
      if (!run) return c.json({ error: 'unknown_run' }, 404);
      const endedAt = now;
      db.update(schema.agentRuns)
        .set({
          status: b.status ?? 'success',
          endedAt,
          durationMs: endedAt.getTime() - run.startedAt.getTime(),
          ...metrics(b, tags),
        })
        .where(eq(schema.agentRuns.id, run.id))
        .run();
      return c.json({ ok: true, run_id: run.id });
    }

    // record — one-shot completed run.
    if (!b.agent_kind || !b.agent_name || !b.provider || !b.model) {
      return c.json({ error: 'missing_fields', need: ['agent_kind', 'agent_name', 'provider', 'model'] }, 400);
    }
    const startedAt = b.started_at != null ? new Date(b.started_at) : now;
    const endedAt = b.ended_at != null ? new Date(b.ended_at) : now;
    const id = crypto.randomUUID();
    db.insert(schema.agentRuns)
      .values({
        id,
        projectId: project.id,
        sessionId: b.session_id ?? null,
        parentRunId: b.parent_run_id ?? null,
        agentKind: b.agent_kind,
        agentName: b.agent_name,
        task: b.task ?? '',
        purpose: b.purpose ?? null,
        provider: b.provider,
        model: b.model,
        tier: b.tier ?? null,
        status: b.status ?? 'success',
        startedAt,
        endedAt,
        durationMs: b.duration_ms ?? endedAt.getTime() - startedAt.getTime(),
        ...metrics(b, tags),
      })
      .run();
    return c.json({ run_id: id });
  });
}
