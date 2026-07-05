// App factory infra routes. Run: bun test src/app.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, afterEach } from 'bun:test';
import { createApp } from './app';
import { _resetLagGauge, _setTrackedLagForTest } from './ops/lag-gauge';

const app = createApp();
const json = (r: Response) => r.json() as Promise<any>;

afterEach(() => _resetLagGauge());

describe('GET /health (Fly liveness — never 503 for pressure)', () => {
  it('returns 200 ok even when the event loop is lagging badly', async () => {
    _setTrackedLagForTest(30_000); // simulate a severe stall
    const r = await app.request('/health');
    expect(r.status).toBe(200); // liveness must NOT 503 — that would pull our only instance
    expect((await json(r)).status).toBe('ok');
  });
});

describe('GET /ready (F008 circuit breaker — degraded → defer, not page)', () => {
  it('healthy loop → 200 ready, no Retry-After', async () => {
    _setTrackedLagForTest(0);
    const r = await app.request('/ready');
    expect(r.status).toBe(200);
    expect(r.headers.get('retry-after')).toBeNull();
    expect((await json(r)).status).toBe('ready');
  });

  it('event-loop lag past threshold → 503 + Retry-After (poller defers)', async () => {
    _setTrackedLagForTest(5000); // > 2000ms degraded threshold
    const r = await app.request('/ready');
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('15');
    const b = await json(r);
    expect(b.status).toBe('degraded');
    expect(b.lag_ms).toBe(5000);
  });
});

describe('GET /api/test/retry-after-503 (fleet Retry-After fixture, cronjobs F007)', () => {
  it('returns 503 with a parseable Retry-After: 30 header', async () => {
    const r = await app.request('/api/test/retry-after-503');
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('30');
    expect((await json(r)).retry_after).toBe(30);
  });
});
