// @upmetrics/sdk — error capture for browser/node/bun. Sends Sentry-format
// envelopes to the Upmetrics ingest endpoint. PII-scrubbed by default.
import { scrub } from './scrub';
import { SDK_VERSION } from './version';

export interface InitOptions {
  dsn: string;
  environment?: string;
  release?: string;
  /** Disable window.onerror / unhandledrejection / fetch hooks. Default: auto. */
  autoInstrument?: boolean;
  /** Disable PII scrubbing (NOT recommended). Default: false. */
  disableScrub?: boolean;
}

interface Dsn {
  endpoint: string;
  publicKey: string;
  projectId: string;
}

interface Scope {
  user?: Record<string, unknown>;
  tags: Record<string, string>;
  breadcrumbs: Array<Record<string, unknown>>;
}

let config: (InitOptions & { parsed: Dsn }) | null = null;
const scope: Scope = { tags: {}, breadcrumbs: [] };

function parseDsn(dsn: string): Dsn {
  const u = new URL(dsn);
  return {
    endpoint: `${u.protocol}//${u.host}`,
    publicKey: u.username,
    projectId: u.pathname.replace(/^\//, ''),
  };
}

export function init(options: InitOptions): void {
  config = { ...options, parsed: parseDsn(options.dsn) };
  if (options.autoInstrument !== false) installAutoInstrument();
  // Emit one lightweight startup event per JS context so a surface + its SDK
  // version show up in the dashboard from boot — even if it never errors.
  // Without this, a healthy surface stamps no version (F012). info-level →
  // kind='message' on ingest → never grouped into an issue or counted as error.
  const g = globalThis as any;
  if (!g.__upmetricsInitSent) {
    g.__upmetricsInitSent = true;
    captureMessage('upmetrics: sdk initialised', 'info');
  }
}

export function setUser(user: Record<string, unknown> | undefined): void {
  scope.user = user;
}

export function setTag(key: string, value: string): void {
  scope.tags[key] = value;
}

export function addBreadcrumb(crumb: Record<string, unknown>): void {
  scope.breadcrumbs.push({ timestamp: Date.now() / 1000, ...crumb });
  if (scope.breadcrumbs.length > 50) scope.breadcrumbs.shift();
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function parseStack(stack: string | undefined): Array<Record<string, unknown>> {
  if (!stack) return [];
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/at (.+?) \(?(.+?):(\d+):(\d+)\)?$/);
    if (m) frames.push({ function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  // Sentry orders frames oldest-first (crashing frame last).
  return frames.reverse();
}

function baseEvent(): Record<string, unknown> {
  return {
    event_id: uuid(),
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    environment: config?.environment,
    release: config?.release,
    // Self-stamp the SDK version (Sentry-style) so the dashboard can show which
    // @upmetrics/sdk each surface runs + surface fleet drift (F012).
    sdk: { name: '@upmetrics/sdk', version: SDK_VERSION },
    tags: { ...scope.tags },
    user: scope.user,
    breadcrumbs: scope.breadcrumbs.length ? [...scope.breadcrumbs] : undefined,
  };
}

export function captureException(err: unknown, ctx?: Record<string, unknown>): string | null {
  const e = err instanceof Error ? err : new Error(String(err));
  const event = {
    ...baseEvent(),
    level: 'error',
    exception: {
      values: [{ type: e.name, value: e.message, stacktrace: { frames: parseStack(e.stack) } }],
    },
    ...ctx,
  };
  return send(event);
}

export function captureMessage(message: string, level = 'info'): string | null {
  return send({ ...baseEvent(), level, message });
}

function send(event: Record<string, unknown>): string | null {
  if (!config) {
    if (typeof console !== 'undefined') console.warn('[upmetrics] not initialized; call init() first');
    return null;
  }
  const payload = config.disableScrub ? event : scrub(event);
  const { endpoint, publicKey, projectId } = config.parsed;
  const url = `${endpoint}/api/${projectId}/envelope/?sentry_key=${publicKey}`;
  const body =
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }) +
    '\n' +
    JSON.stringify({ type: 'event' }) +
    '\n' +
    JSON.stringify(payload);

  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body,
    keepalive: true,
  }).catch(() => {
    // fire-and-forget — telemetry must never throw into the host app.
  });
  return event.event_id as string;
}

// Benign client-side network/chunk failures dominate browser error volume but are
// almost never bugs: a deploy restart, a user going offline, a navigation that
// aborts an in-flight fetch, or a stale code-split chunk after a deploy. Capturing
// each floods the project + trips false error-spikes (cardmem deploy-noise, 2026-06-02).
// Policy: drop them from AUTO-capture (genuine downtime is caught by uptime probes),
// keep a breadcrumb for context, and sample at most one per minute as a low-severity
// warning so a really-broken endpoint (sustained) still trickles in — never as an
// 'error', so it can't trip an error-spike. Manual captureException() is unaffected.
const BENIGN_NETWORK_RE =
  /failed to fetch|load failed|networkerror when attempting to fetch|fetch dynamically imported module|loading chunk \d+ failed|loading css chunk|importing a module script failed/i;
let lastBenignSentAt = 0;
function handledAsBenign(x: unknown): boolean {
  const msg = x instanceof Error ? `${x.name}: ${x.message}` : String(x);
  if (!BENIGN_NETWORK_RE.test(msg)) return false;
  addBreadcrumb({ category: 'network', level: 'warning', message: msg });
  const now = Date.now();
  if (now - lastBenignSentAt > 60_000) {
    lastBenignSentAt = now;
    captureMessage(`client network error (sampled; others suppressed): ${msg}`, 'warning');
  }
  return true;
}

function installAutoInstrument(): void {
  const g = globalThis as any;

  // window.onerror + unhandledrejection (browser; node/bun may lack these).
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('error', (e: any) => {
      if (e?.error) {
        if (!handledAsBenign(e.error)) captureException(e.error);
      } else if (e?.message) {
        if (!handledAsBenign(e.message)) captureMessage(String(e.message), 'error');
      }
    });
    g.addEventListener('unhandledrejection', (e: any) => {
      const reason = e?.reason ?? new Error('unhandledrejection');
      if (!handledAsBenign(reason)) captureException(reason);
    });
  }

  // Failed-fetch capture (browser/node/bun). Wrap once; skip our OWN ingest
  // endpoint to avoid infinite recursion on the envelope POST.
  if (typeof g.fetch === 'function' && !g.__upmetricsFetchWrapped) {
    const orig = g.fetch.bind(g);
    g.__upmetricsFetchWrapped = true;
    g.fetch = async (...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      const own = Boolean(config && url.includes(config.parsed.endpoint));
      try {
        const res = await orig(...args);
        // Only flag genuine server failures (5xx). Expected client statuses
        // (401/403/404) and opaque/no-cors responses (status 0) are normal app
        // traffic, not errors — capturing them floods the project with noise.
        if (!own && res && res.status >= 500) captureMessage(`HTTP ${res.status} on ${url}`, 'warning');
        return res;
      } catch (err) {
        if (!own && !handledAsBenign(err)) captureException(err);
        throw err;
      }
    };
  }

  // Node/bun daemons: uncaught errors surface via `process`, not `window`, so the
  // browser listeners above never fire. Install process-level handlers so a pure
  // local service (Tailscale-only, no browser, no public ingress) is fully tracked
  // from just init() — outbound POST to ingest needs only egress, which it has.
  const proc = g.process;
  if (proc && typeof proc.on === 'function' && !g.__upmetricsNodeWrapped) {
    g.__upmetricsNodeWrapped = true;
    proc.on('unhandledRejection', (reason: any) => {
      captureException(reason instanceof Error ? reason : new Error(`unhandledRejection: ${String(reason)}`));
    });
    // Only own uncaughtException if the host isn't already handling it — never
    // preempt a daemon's own graceful-shutdown logic.
    if (proc.listenerCount('uncaughtException') === 0) {
      proc.on('uncaughtException', (err: any) => {
        captureException(err instanceof Error ? err : new Error(String(err)));
        // Preserve crash semantics: let the fire-and-forget POST flush, then exit
        // so a supervisor restarts the daemon — exactly as an unhandled crash would.
        setTimeout(() => proc.exit(1), 150);
      });
    }
  }
}

export { scrub, maskString } from './scrub';
