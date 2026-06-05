// F016 Lens mint-endpoint. Run: bun test src/auth/lens.test.ts
// The 200 mint path creates a real Better Auth session (user/session tables that
// `better-auth migrate` makes, NOT drizzle) — so the full mint is proven on prod
// (curl /api/auth/get-session + Lens). Here: the Bearer gate + the cookie-signing
// format (deterministic, no DB).
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { config } from '../config';
import { registerLensRoutes, signSessionCookie, LENS_EMAIL } from './lens';

(config as Record<string, unknown>).lensMintSecret = 'mint_test_secret';

const app = new Hono();
registerLensRoutes(app);

function mint(authHeader?: string) {
  return app.request('/api/lens-session', { method: 'POST', headers: authHeader ? { authorization: authHeader } : {} });
}

describe('POST /api/lens-session — Bearer gate', () => {
  it('401 without a Bearer secret', async () => {
    expect((await mint()).status).toBe(401);
  });
  it('401 with the wrong Bearer secret', async () => {
    expect((await mint('Bearer nope')).status).toBe(401);
  });
  // correct-secret path mints a real Better Auth session → needs the auth tables;
  // proven on prod (see card F016). A wrong secret never reaches the DB.
});

describe('signSessionCookie — better-call signed-cookie format', () => {
  it('produces encodeURIComponent(`token.<base64 HMAC>`), sig 44 chars ending =', () => {
    const out = signSessionCookie('sometoken', 'secret');
    const decoded = decodeURIComponent(out);
    const [val, sig] = [decoded.slice(0, decoded.lastIndexOf('.')), decoded.slice(decoded.lastIndexOf('.') + 1)];
    expect(val).toBe('sometoken');
    const expected = createHmac('sha256', 'secret').update('sometoken').digest('base64');
    expect(sig).toBe(expected);
    expect(sig.length).toBe(44);
    expect(sig.endsWith('=')).toBe(true);
  });
  it('is deterministic + URL-encodes base64 specials (+/=)', () => {
    expect(signSessionCookie('t', 's')).toBe(signSessionCookie('t', 's'));
    expect(signSessionCookie('t', 's')).not.toContain('='); // = → %3D
  });
});

describe('LENS_EMAIL', () => {
  it('is the dedicated read-only identity, never cb@/admin', () => {
    expect(LENS_EMAIL).toBe('lens@upmetrics.org');
  });
});
