// @upmetrics/sdk — error capture for browser/node/bun. Sends Sentry-format
// envelopes to the Upmetrics ingest endpoint. PII-scrubbed by default.
import { scrub } from './scrub';

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

function installAutoInstrument(): void {
  const g = globalThis as any;

  // window.onerror + unhandledrejection (browser; node/bun may lack these).
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('error', (e: any) => {
      if (e?.error) captureException(e.error);
      else if (e?.message) captureMessage(String(e.message), 'error');
    });
    g.addEventListener('unhandledrejection', (e: any) => {
      captureException(e?.reason ?? new Error('unhandledrejection'));
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
        if (!own && res && res.ok === false) captureMessage(`HTTP ${res.status} on ${url}`, 'warning');
        return res;
      } catch (err) {
        if (!own) captureException(err);
        throw err;
      }
    };
  }
}

export { scrub, maskString } from './scrub';
