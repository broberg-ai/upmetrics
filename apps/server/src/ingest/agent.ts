// Agent-run ingest (F002.3). POST /api/agent authed by X-Upmetrics-Key (project
// api_key). Modes: start (status=running, returns run_id), finish (final state),
// record (one-shot completed run). Writes agent_runs (PLAN §5/§8).
import type { Context, Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

type Body = Record<string, any>;

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

// Common metric fields shared by finish/record.
function metrics(b: Body) {
  return {
    inputTokens: Number(b.input_tokens ?? 0),
    outputTokens: Number(b.output_tokens ?? 0),
    cacheReadTokens: Number(b.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(b.cache_creation_tokens ?? 0),
    costUsd: Number(b.cost_usd ?? 0),
    toolCalls: b.tool_calls ?? null,
    artifacts: b.artifacts ?? null,
    promptExcerpt: b.prompt_excerpt ?? null,
    responseExcerpt: b.response_excerpt ?? null,
    errorIssueId: b.error_issue_id ?? null,
    tags: b.tags ?? null,
  };
}

export function registerAgentRoutes(app: Hono): void {
  app.post('/api/agent', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);

    const db = getDb();
    const b = (await c.req.json().catch(() => ({}))) as Body;
    const mode = String(b.mode ?? 'record');
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
          tags: b.tags ?? null,
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
          ...metrics(b),
        })
        .where(eq(schema.agentRuns.id, run.id))
        .run();
      return c.json({ ok: true, run_id: run.id });
    }

    // record — one-shot completed run.
    if (!b.agent_kind || !b.agent_name || !b.provider || !b.model) {
      return c.json({ error: 'missing_fields', need: ['agent_kind', 'agent_name', 'provider', 'model'] }, 400);
    }
    const startedAt = b.started_at ? new Date(b.started_at) : now;
    const endedAt = b.ended_at ? new Date(b.ended_at) : now;
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
        ...metrics(b),
      })
      .run();
    return c.json({ run_id: id });
  });
}
