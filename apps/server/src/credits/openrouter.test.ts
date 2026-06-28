// F022.3 OpenRouter adapter + provider_balance check. Run: bun test src/credits/openrouter.test.ts
import { describe, it, expect, afterEach } from 'bun:test';
import { parseOpenRouterCredits } from './openrouter';
import { runCheck } from '../probes/check';
import { config } from '../config';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  (config as { openrouterManagementKey: string }).openrouterManagementKey = '';
});

describe('parseOpenRouterCredits', () => {
  it('maps { data: { total_credits, total_usage } }', () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 50, total_usage: 12.5 } })).toEqual({ totalCredits: 50, totalUsage: 12.5 });
  });
  it('throws on missing/non-numeric fields (bad response must not write a garbage snapshot)', () => {
    expect(() => parseOpenRouterCredits({ data: { total_credits: 'x', total_usage: 1 } })).toThrow();
    expect(() => parseOpenRouterCredits({})).toThrow();
  });
});

describe('provider_balance check (runCheck)', () => {
  const probe = { kind: 'provider_balance', config: {}, target: '' } as unknown as Parameters<typeof runCheck>[0];

  it('ship-dark: no management key → ok:false, NO throw', async () => {
    (config as { openrouterManagementKey: string }).openrouterManagementKey = '';
    const r = await runCheck(probe);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('disarmed');
  });

  it('with key + a good response → ok:true + parsed balance', async () => {
    (config as { openrouterManagementKey: string }).openrouterManagementKey = 'sk-test';
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 40 } }), { status: 200 })) as unknown as typeof fetch;
    const r = await runCheck(probe);
    expect(r.ok).toBe(true);
    expect(r.balance).toMatchObject({ totalCredits: 100, totalUsage: 40 });
  });

  it('a non-2xx from OpenRouter → ok:false (→ probe_down reachability)', async () => {
    (config as { openrouterManagementKey: string }).openrouterManagementKey = 'sk-test';
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const r = await runCheck(probe);
    expect(r.ok).toBe(false);
    expect(r.balance).toBeUndefined();
  });
});
