// F022.3 — OpenRouter balance adapter. Maps GET /api/v1/credits → a snapshot
// input. The management key is required by /credits and is read from config
// (OPENROUTER_MANAGEMENT_KEY, an Upmetrics secret) — never hardcoded. Pure parse
// is split out so it's unit-testable without a network call.

export interface ParsedBalance {
  totalCredits: number;
  totalUsage: number;
}

// OpenRouter shape: { data: { total_credits, total_usage } }. Throws on a
// missing/non-numeric field so a bad response fails the check (→ probe_down)
// instead of silently writing a garbage snapshot.
export function parseOpenRouterCredits(json: unknown): ParsedBalance {
  const data = (json as { data?: { total_credits?: unknown; total_usage?: unknown } })?.data;
  const totalCredits = Number(data?.total_credits);
  const totalUsage = Number(data?.total_usage);
  if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) {
    throw new Error('openrouter /credits: missing/non-numeric total_credits or total_usage');
  }
  return { totalCredits, totalUsage };
}

// Fetch + parse the account balance. baseUrl is overridable for tests; default is
// OpenRouter prod. Throws on non-2xx or a malformed body.
export async function fetchOpenRouterBalance(
  managementKey: string,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<{ balance: ParsedBalance; raw: unknown }> {
  const baseUrl = opts.baseUrl ?? 'https://openrouter.ai';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${baseUrl}/api/v1/credits`, {
      headers: { authorization: `Bearer ${managementKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`openrouter /credits HTTP ${res.status}`);
    const raw = await res.json();
    return { balance: parseOpenRouterCredits(raw), raw };
  } finally {
    clearTimeout(t);
  }
}
