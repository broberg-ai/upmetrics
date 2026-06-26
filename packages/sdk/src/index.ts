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
  /**
   * Drop events whose message/exception text matches any entry — known-benign
   * noise you can't suppress at source (e.g. Capacitor's
   * "capacitorDidRegisterForRemoteNotifications not called", which fires even
   * though push works). Strings match case-insensitively as a substring;
   * RegExp matches as written. Applies to EVERY capture path — auto-instrument
   * and manual captureException/captureMessage — so the event is never sent.
   */
  ignoreErrors?: Array<string | RegExp>;
  /**
   * Skip AUTO-capture (failed-fetch + 5xx) for requests whose URL matches any
   * entry — for known-transient endpoints an app already handles itself (health
   * polls, relay/heartbeat POSTs). String matches case-insensitively as a
   * substring; RegExp matches as written. Only affects auto-instrument; a manual
   * captureException()/captureMessage() is unaffected. Cleaner than ignoreErrors
   * for this case: it scopes by endpoint, so a real timeout elsewhere still surfaces.
   */
  denyUrls?: Array<string | RegExp>;
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

// User-declared noise filter (InitOptions.ignoreErrors). A matched event is
// dropped entirely — never sent, on any path. String entries match
// case-insensitively as a substring; RegExp entries match as written.
function isIgnored(text: string): boolean {
  return matchesAny(config?.ignoreErrors, text);
}

// URL-scoped auto-capture suppressor (InitOptions.denyUrls). Same match rules as
// ignoreErrors; only consulted on the auto-instrument fetch path.
function isDenied(url: string): boolean {
  return matchesAny(config?.denyUrls, url);
}

function matchesAny(patterns: Array<string | RegExp> | undefined, text: string): boolean {
  if (!patterns?.length || !text) return false;
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (typeof p === 'string') {
      if (p && lower.includes(p.toLowerCase())) return true;
    } else if (p.test(text)) {
      return true;
    }
  }
  return false;
}

export function captureException(err: unknown, ctx?: Record<string, unknown>): string | null {
  const e = err instanceof Error ? err : new Error(String(err));
  if (isIgnored(`${e.name}: ${e.message}`)) return null;
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
  if (isIgnored(message)) return null;
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

// Transient network failures dominate error volume but are almost never bugs: a
// deploy restart, a user going offline, a navigation that aborts an in-flight
// fetch, a stale code-split chunk, or — on a Node/Bun daemon — a relay/heartbeat
// POST that times out against a momentarily-unreachable peer. The app already
// handles these; auto-capturing each floods the project + trips false error-spikes
// (cardmem deploy-noise 2026-06-02; buddy relay/poll TimeoutError storm 2026-06-26).
// Policy: drop them from AUTO-capture (genuine downtime is caught by uptime probes),
// keep a breadcrumb for context, and sample at most one per minute as a low-severity
// warning so a really-broken endpoint (sustained) still trickles in — never as an
// 'error', so it can't trip an error-spike. Manual captureException() is unaffected.
// Covers: browser fetch/chunk failures; Node fetch failures ("fetch failed");
// timeouts/aborts (TimeoutError/AbortError, AbortSignal.timeout); and the undici +
// libuv transient codes carried on err.code / err.cause.
const BENIGN_NETWORK_RE =
  /failed to fetch|fetch failed|load failed|networkerror when attempting to fetch|fetch dynamically imported module|loading chunk \d+ failed|loading css chunk|importing a module script failed|operation (was aborted|timed out)|timeouterror|aborterror|und_err_(connect_timeout|headers_timeout|body_timeout|socket)|econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up/i;
let lastBenignSentAt = 0;
// Flatten an error to matchable text: name + message + code, plus the same for a
// one-level cause (Node wraps the real reason — e.g. TypeError "fetch failed"
// whose .cause carries `Error: connect ECONNREFUSED` / code UND_ERR_CONNECT_TIMEOUT).
function errText(x: unknown): string {
  if (!(x instanceof Error)) return String(x);
  const code = (x as { code?: unknown }).code;
  return `${x.name}: ${x.message}${code ? ` ${String(code)}` : ''}`;
}
function handledAsBenign(x: unknown): boolean {
  const cause = x instanceof Error ? (x as { cause?: unknown }).cause : undefined;
  const text = errText(x) + (cause ? ` ${errText(cause)}` : '');
  if (!BENIGN_NETWORK_RE.test(text)) return false;
  addBreadcrumb({ category: 'network', level: 'warning', message: errText(x) });
  const now = Date.now();
  if (now - lastBenignSentAt > 60_000) {
    lastBenignSentAt = now;
    captureMessage(`client network error (sampled; others suppressed): ${errText(x)}`, 'warning');
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
      // Never instrument our OWN ingest POST (infinite recursion), nor a
      // denyUrls endpoint the app has opted out of (known-transient relay/poll).
      const skip = Boolean(config && url.includes(config.parsed.endpoint)) || isDenied(url);
      try {
        const res = await orig(...args);
        // Only flag genuine server failures (5xx). Expected client statuses
        // (401/403/404) and opaque/no-cors responses (status 0) are normal app
        // traffic, not errors — capturing them floods the project with noise.
        if (!skip && res && res.status >= 500) captureMessage(`HTTP ${res.status} on ${url}`, 'warning');
        return res;
      } catch (err) {
        if (!skip && !handledAsBenign(err)) captureException(err);
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
