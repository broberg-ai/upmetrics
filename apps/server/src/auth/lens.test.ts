// F016 Lens mint-endpoint. Run: bun test src/auth/lens.test.ts
// config reads env at import (ESM hoisting), so set secrets before importing.
process.env.DATABASE_PATH = ':memory:';
process.env.LENS_MINT_SECRET = 'mint_test_secret';
process.env.AUTH_SECRET = 'auth_test_secret';
process.env.AUTH_BASE_URL = 'https://upmetrics.org';

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { config } from '../config';
import { registerLensRoutes, validLensSession, LENS_COOKIE } from './lens';

// config snapshots env at import (before this file's top-level runs, ESM
// hoisting) — set the values the routes read at request time here.
Object.assign(config as Record<string, unknown>, {
  lensMintSecret: 'mint_test_secret',
  authSecret: 'auth_test_secret',
  authBaseUrl: 'https://upmetrics.org',
});

const app = new Hono();
registerLensRoutes(app);

function mint(authHeader?: string) {
  return app.request('/api/lens-session', {
    method: 'POST',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

// Build a minimal Context-like object carrying a cookie header, for validLensSession.
function ctxWithCookie(cookie: string | null): Context {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return { req: { raw: { headers }, header: (n: string) => headers.get(n) ?? undefined } } as unknown as Context;
}

describe('POST /api/lens-session', () => {
  it('401 without / with a wrong Bearer secret', async () => {
    expect((await mint()).status).toBe(401);
    expect((await mint('Bearer nope')).status).toBe(401);
  });

  it('200 with the mint secret → Playwright storageState (cookie fields complete)', async () => {
    const res = await mint('Bearer mint_test_secret');
    expect(res.status).toBe(200);
    const b = (await res.json()) as { cookies: any[]; origins: any[] };
    expect(Array.isArray(b.origins)).toBe(true);
    expect(b.cookies.length).toBe(1);
    const ck = b.cookies[0];
    expect(ck.name).toBe(LENS_COOKIE);
    expect(ck.domain).toBe('upmetrics.org');
    expect(ck.path).toBe('/');
    expect(ck.httpOnly).toBe(true);
    expect(ck.secure).toBe(true);
    expect(ck.sameSite).toBe('Lax');
    expect(typeof ck.expires).toBe('number');
    expect(ck.expires * 1000).toBeGreaterThan(Date.now()); // future
  });
});

describe('validLensSession', () => {
  it('accepts a freshly minted token', async () => {
    const b = (await (await mint('Bearer mint_test_secret')).json()) as { cookies: any[] };
    const token = b.cookies[0].value;
    expect(validLensSession(ctxWithCookie(`${LENS_COOKIE}=${token}`))).toBe(true);
  });

  it('rejects missing, malformed, tampered, and expired tokens', () => {
    expect(validLensSession(ctxWithCookie(null))).toBe(false);
    expect(validLensSession(ctxWithCookie(`${LENS_COOKIE}=garbage`))).toBe(false);
    expect(validLensSession(ctxWithCookie(`${LENS_COOKIE}=9999999999999.deadbeef`))).toBe(false); // future exp, bad sig
    expect(validLensSession(ctxWithCookie(`${LENS_COOKIE}=1.abc`))).toBe(false); // expired (exp=1ms)
  });
});
