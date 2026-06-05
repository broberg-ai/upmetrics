// F016 — Lens mint-endpoint (fleet visual-verification standard, cardmem
// docs/LENS-MINT-ENDPOINT.md). A daemon POSTs /api/lens-session with the mint
// Bearer secret and gets a Playwright storageState carrying a REAL, short-lived
// Better Auth session cookie for a dedicated read-only lens user
// (lens@upmetrics.org, never cb@/admin).
//
// Why a real session (not a synthetic cookie): the SPA gates rendering on
// better-auth's /api/auth/get-session (App.tsx → useSession). A synthetic cookie
// authenticates the API endpoints but the SPA bounces to login. So we mint a
// genuine session for the lens user; requireUser then denies that user any
// mutating method (read-only — see dashboard/routes.ts).
import type { Context, Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { auth } from './index';
import { config } from '../config';

export const LENS_EMAIL = 'lens@upmetrics.org';
const TTL_MS = 10 * 60_000; // 10 min — matches the fleet contract

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Reproduce better-call's signed-cookie value (the format better-auth's
// getSession verifies): encodeURIComponent(`${token}.${base64(HMAC-SHA256(token, secret))}`).
// base64 of the 32-byte HMAC is 44 chars ending in '=' (the verifier asserts this).
export function signSessionCookie(token: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(token).digest('base64');
  return encodeURIComponent(`${token}.${sig}`);
}

// Mint a real Better Auth session for the dedicated lens user and return it as a
// Playwright storageState (the daemon runs context.addCookies). The cookie name +
// host-only domain mirror a genuine login cookie so the SPA's session check passes.
async function mintStorageState(now: number) {
  const ctx = await auth.$context;
  const ia = ctx.internalAdapter;
  const existing = await ia.findUserByEmail(LENS_EMAIL);
  const userId = existing?.user?.id ?? (await ia.createUser({ email: LENS_EMAIL, name: 'Lens (read-only)', emailVerified: true })).id;
  const session = await ia.createSession(userId, false);
  // Note: the session row keeps better-auth's rolling ~7d TTL (getSession
  // auto-refreshes expiry, so a shorter override/update is futile). Harmless:
  // the cookie we hand out expires in 10 min, and the row is read-only +
  // mint-gated. (deleteSessions-before-create broke auth, so we don't prune here.)
  const name = ctx.authCookies?.sessionToken?.name ?? '__Secure-better-auth.session_token';
  return {
    cookies: [
      {
        name,
        value: signSessionCookie(session.token, ctx.secret ?? config.authSecret),
        domain: new URL(config.authBaseUrl).hostname, // host-only, like the real login cookie
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
        expires: Math.floor((now + TTL_MS) / 1000),
      },
    ],
    origins: [] as const,
  };
}

export function registerLensRoutes(app: Hono): void {
  app.post('/api/lens-session', async (c) => {
    const expected = config.lensMintSecret;
    const header = c.req.header('authorization') ?? '';
    if (!expected || !safeEq(header, `Bearer ${expected}`)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      return c.json(await mintStorageState(Date.now()));
    } catch (err) {
      console.error('[lens-mint] failed:', err);
      return c.json({ error: 'mint_failed' }, 500);
    }
  });
}
