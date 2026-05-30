// Probe check execution (F004.2). Runs the actual HTTP/keyword/tcp/ssl check
// against probe.target. Called from the run endpoint (triggered by cronjobs).
import type { schema } from '../db';

type Probe = typeof schema.probes.$inferSelect;

export interface CheckResult {
  ok: boolean;
  responseMs?: number;
  statusCode?: number;
  error?: string;
}

export async function runCheck(probe: Probe): Promise<CheckResult> {
  const cfg = (probe.config ?? {}) as Record<string, any>;
  const timeoutMs = Number(cfg.timeout_ms ?? 10000);
  const start = Date.now();

  try {
    if (probe.kind === 'tcp') return await tcpCheck(probe.target, timeoutMs, start);

    // http | keyword | ssl all go over an HTTP(S) request.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(probe.target, { redirect: 'follow', signal: ctrl.signal });
      const responseMs = Date.now() - start;
      const statusCode = res.status;

      if (probe.kind === 'keyword') {
        const body = await res.text();
        const kw = String(cfg.keyword ?? '');
        const present = kw !== '' && body.includes(kw);
        const wantAbsent = Boolean(cfg.keyword_absent);
        const ok = wantAbsent ? !present : present;
        return { ok, responseMs, statusCode, error: ok ? undefined : `keyword ${wantAbsent ? 'present' : 'not found'}` };
      }

      const expected = cfg.expected_status as number | undefined;
      const ok = expected ? statusCode === expected : statusCode >= 200 && statusCode < 400;
      return { ok, responseMs, statusCode, error: ok ? undefined : `unexpected status ${statusCode}` };
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    return { ok: false, responseMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function tcpCheck(target: string, timeoutMs: number, start: number): Promise<CheckResult> {
  const [host, portStr] = target.replace(/^\w+:\/\//, '').split(':');
  const port = Number(portStr ?? 0);
  if (!host || !port) return { ok: false, error: `invalid tcp target "${target}" (expected host:port)` };
  return await new Promise<CheckResult>((resolve) => {
    let settled = false;
    const done = (r: CheckResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => done({ ok: false, responseMs: Date.now() - start, error: 'tcp timeout' }), timeoutMs);
    // Bun.connect — opens a TCP socket; success on open, failure on error.
    (globalThis as any).Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket: any) {
          clearTimeout(timer);
          socket.end();
          done({ ok: true, responseMs: Date.now() - start });
        },
        error(_s: any, err: Error) {
          clearTimeout(timer);
          done({ ok: false, responseMs: Date.now() - start, error: err.message });
        },
      },
    }).catch((err: Error) => {
      clearTimeout(timer);
      done({ ok: false, responseMs: Date.now() - start, error: err.message });
    });
  });
}
