// App factory infra routes. Run: bun test src/app.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect } from 'bun:test';
import { createApp } from './app';

const app = createApp();
const json = (r: Response) => r.json() as Promise<any>;

describe('GET /health', () => {
  it('returns 200 ok (Fly health check contract)', async () => {
    const r = await app.request('/health');
    expect(r.status).toBe(200);
    expect((await json(r)).status).toBe('ok');
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
