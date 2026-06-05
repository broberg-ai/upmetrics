// F016 — Lens mint-endpoint (fleet visual-verification standard, cardmem
// docs/LENS-MINT-ENDPOINT.md). A daemon POSTs /api/lens-session with the mint
// Bearer secret and gets back a Playwright storageState carrying a short-lived,
// READ-ONLY lens cookie. requireUser() accepts that cookie on GET only, so the
// lens principal is structurally read-only — it can never satisfy a mutating
// method (POST/PUT/PATCH/DELETE → 401). No standing DB account, never cb@/admin.
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export const LENS_COOKIE = 'upm_lens';
const TTL_MS = 10 * 60_000; // 10 min — matches the fleet contract

// Token = "<expMs>.<hmac(expMs)>", signed with the auth secret (reuses the one
// server secret; the mint Bearer is separate and gates issuance).
function sign(expMs: number): string {
  const sig = createHmac('sha256', config.authSecret).update(`lens.${expMs}`).digest('hex');
  return `${expMs}.${sig}`;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Valid, unexpired lens token in the request cookie? (HttpOnly cookies still
// reach the server — HttpOnly only blocks browser-JS access.)
export function validLensSession(c: Context): boolean {
  const raw = getCookie(c, LENS_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot < 0) return false;
  const expMs = Number(raw.slice(0, dot));
  if (!Number.isFinite(expMs) || Date.now() > expMs) return false;
  return safeEq(raw.slice(dot + 1), sign(expMs).slice(String(expMs).length + 1));
}

// Playwright storageState with just the lens cookie (daemon runs context.addCookies).
function mintStorageState(now: number) {
  const expMs = now + TTL_MS;
  return {
    cookies: [
      {
        name: LENS_COOKIE,
        value: sign(expMs),
        // Leading-dot domain: Playwright's context.addCookies (the mintEndpoint
        // adapter path) needs it to send the cookie back; a host-only domain works
        // via storageState-at-context-creation but not via addCookies.
        domain: `.${new URL(config.authBaseUrl).hostname}`,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
        expires: Math.floor(expMs / 1000),
      },
    ],
    origins: [] as const,
  };
}

export function registerLensRoutes(app: Hono): void {
  app.post('/api/lens-session', (c) => {
    const expected = config.lensMintSecret;
    const header = c.req.header('authorization') ?? '';
    if (!expected || !safeEq(header, `Bearer ${expected}`)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json(mintStorageState(Date.now()));
  });
}
