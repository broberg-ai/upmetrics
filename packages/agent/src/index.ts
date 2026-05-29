// @upmetrics/agent — AI agent telemetry. Posts to the /api/agent ingest
// endpoint (F002.3). Three patterns: agentRun (lifecycle wrapper),
// wrapAnthropic (auto-instrument), recordAgentRun (one-shot).
export interface AgentConfig {
  baseUrl: string; // e.g. https://upmetrics.org
  apiKey: string; // project api_key (X-Upmetrics-Key)
  /**
   * Compliance mode (F003.4 / FysioDK). When true, NEVER send prompt/response
   * excerpts to Upmetrics and tag every run compliance:'gdpr-health'. The app
   * keeps its own legally-binding audit log; Upmetrics holds sanitized telemetry.
   */
  complianceMode?: boolean;
}

let config: AgentConfig | null = null;
export function configureAgent(cfg: AgentConfig): void {
  config = cfg;
}

// Structured-only record the app persists synchronously in its OWN audit log.
// Never contains prompt/response text or cleartext user data.
export interface AuditRecord {
  timestamp: string;
  agent_kind: string;
  agent_name: string;
  purpose?: string;
  provider: string;
  model: string;
  tier?: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  error_class?: string;
}

export interface AgentMeta {
  agent_kind: string; // cc | subagent | chatbot | rag | embedding
  agent_name: string;
  task?: string;
  purpose?: string;
  provider: string;
  model: string;
  tier?: string;
  session_id?: string;
  parent_run_id?: string;
  tags?: Record<string, unknown>;
}

export interface AgentMetrics {
  status?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
  tool_calls?: Array<{ name: string; count: number; error_count?: number }>;
  artifacts?: Array<{ type: string; ref: string }>;
  prompt_excerpt?: string;
  response_excerpt?: string;
  error_issue_id?: string;
}

async function post(body: Record<string, unknown>): Promise<any> {
  if (!config) throw new Error('@upmetrics/agent: call configureAgent() first');
  let payload = body;
  if (config.complianceMode) {
    // Force-strip excerpts and tag as gdpr-health, regardless of caller input.
    const { prompt_excerpt, response_excerpt, tags, ...rest } = body as Record<string, unknown>;
    void prompt_excerpt;
    void response_excerpt;
    payload = { ...rest, tags: { ...((tags as Record<string, unknown>) ?? {}), compliance: 'gdpr-health' } };
  }
  const res = await fetch(`${config.baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upmetrics-key': config.apiKey },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

export async function recordAgentRun(run: AgentMeta & AgentMetrics & { started_at?: string; ended_at?: string }): Promise<string | null> {
  const r = await post({ mode: 'record', ...run });
  return (r?.run_id as string) ?? null;
}

export interface AgentRunCtx {
  recordToolCall(name: string, opts?: { error?: boolean }): void;
  recordTokens(usage: Partial<Pick<AgentMetrics, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>>): void;
  recordCostUsd(cost: number): void;
  setResponseExcerpt(text: string): void;
}

// Lifecycle wrapper: start → run fn → finish (success/error). Returns fn result,
// or { result, auditRecord } when opts.returnAuditRecord is set (F003.4) — the
// auditRecord is structured-only (no prompt/response) for the app's own log.
export async function agentRun<T>(meta: AgentMeta, fn: (ctx: AgentRunCtx) => Promise<T>): Promise<T>;
export async function agentRun<T>(
  meta: AgentMeta,
  fn: (ctx: AgentRunCtx) => Promise<T>,
  opts: { returnAuditRecord: true },
): Promise<{ result: T; auditRecord: AuditRecord }>;
export async function agentRun<T>(
  meta: AgentMeta,
  fn: (ctx: AgentRunCtx) => Promise<T>,
  opts?: { returnAuditRecord?: boolean },
): Promise<T | { result: T; auditRecord: AuditRecord }> {
  const startedAtMs = Date.now();
  const started = await post({ mode: 'start', ...meta });
  const runId = started?.run_id as string | undefined;

  const tools = new Map<string, { name: string; count: number; error_count: number }>();
  const acc: AgentMetrics = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 };

  const ctx: AgentRunCtx = {
    recordToolCall(name, opts) {
      const t = tools.get(name) ?? { name, count: 0, error_count: 0 };
      t.count++;
      if (opts?.error) t.error_count++;
      tools.set(name, t);
    },
    recordTokens(u) {
      acc.input_tokens! += u.input_tokens ?? 0;
      acc.output_tokens! += u.output_tokens ?? 0;
      acc.cache_read_tokens! += u.cache_read_tokens ?? 0;
      acc.cache_creation_tokens! += u.cache_creation_tokens ?? 0;
    },
    recordCostUsd(cost) {
      acc.cost_usd! += cost;
    },
    setResponseExcerpt(text) {
      acc.response_excerpt = text;
    },
  };

  const finish = (status: string, extra: Partial<AgentMetrics> = {}) =>
    post({ mode: 'finish', run_id: runId, status, ...acc, tool_calls: [...tools.values()], ...extra });

  const buildAudit = (status: string, errorClass?: string): AuditRecord => ({
    timestamp: new Date(startedAtMs).toISOString(),
    agent_kind: meta.agent_kind,
    agent_name: meta.agent_name,
    purpose: meta.purpose,
    provider: meta.provider,
    model: meta.model,
    tier: meta.tier,
    status,
    input_tokens: acc.input_tokens ?? 0,
    output_tokens: acc.output_tokens ?? 0,
    cost_usd: acc.cost_usd ?? 0,
    duration_ms: Date.now() - startedAtMs,
    error_class: errorClass,
  });

  try {
    const result = await fn(ctx);
    await finish('success');
    if (opts?.returnAuditRecord) return { result, auditRecord: buildAudit('success') };
    return result;
  } catch (err) {
    // In compliance mode never send the error message; only status=error is recorded.
    await finish('error', config?.complianceMode ? {} : { response_excerpt: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// Auto-instrument an Anthropic SDK client: each messages.create is recorded.
export function wrapAnthropic<C extends { messages: { create: (...a: any[]) => Promise<any> } }>(
  client: C,
  opts: Omit<AgentMeta, 'model' | 'provider'> & { provider?: string },
): C {
  const orig = client.messages.create.bind(client.messages);
  client.messages.create = async (params: any) => {
    const startedAt = new Date().toISOString();
    try {
      const res = await orig(params);
      const u = res?.usage ?? {};
      await recordAgentRun({
        provider: opts.provider ?? 'anthropic',
        model: params?.model ?? 'unknown',
        ...opts,
        status: 'success',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        cache_creation_tokens: u.cache_creation_input_tokens,
      });
      return res;
    } catch (err) {
      await recordAgentRun({
        provider: opts.provider ?? 'anthropic',
        model: params?.model ?? 'unknown',
        ...opts,
        status: 'error',
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        response_excerpt: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
  return client;
}
