// F016 — Lens mint-endpoint (fleet visual-verification standard). Migrated to
// @broberg/lens (F021.1): the package owns the Bearer gate, TTL-clamp, rate-limit,
// the 0.0.0.0 cookie-domain trap guard, and the Playwright storageState shape.
// We supply only the auth-specific 20% via the createSession hook.
//
// Why a real session (not a synthetic cookie): the SPA gates rendering on
// better-auth's /api/auth/get-session (App.tsx → useSession). A synthetic cookie
// authenticates the API endpoints but the SPA bounces to login. So createSession
// mints a genuine Better Auth session for the dedicated read-only lens user
// (lens@upmetrics.org, never cb@/admin); requireUser then denies that user any
// mutating method (read-only — see dashboard/routes.ts).
import type { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { lensSessionHandler } from '@broberg/lens/hono';
import { auth } from './index';
import { config } from '../config';

export const LENS_EMAIL = 'lens@upmetrics.org';

// Reproduce better-call's signed-cookie value (the format better-auth's
// getSession verifies): encodeURIComponent(`${token}.${base64(HMAC-SHA256(token, secret))}`).
// base64 of the 32-byte HMAC is 44 chars ending in '=' (the verifier asserts this).
export function signSessionCookie(token: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(token).digest('base64');
  return encodeURIComponent(`${token}.${sig}`);
}

export function registerLensRoutes(app: Hono): void {
  app.post(
    '/api/lens-session',
    lensSessionHandler({
      secret: config.lensMintSecret,
      principal: LENS_EMAIL,
      // Host-only domain from our single config source — never the bound socket
      // (0.0.0.0 on Fly), which the package also guards against.
      cookieDomain: new URL(config.authBaseUrl).hostname,
      // Mint a REAL Better Auth session for the lens user and hand back its signed
      // cookie; the package wraps it into the 10-min storageState response.
      createSession: async () => {
        const ctx = await auth.$context;
        const ia = ctx.internalAdapter;
        const existing = await ia.findUserByEmail(LENS_EMAIL);
        const userId =
          existing?.user?.id ??
          (await ia.createUser({ email: LENS_EMAIL, name: 'Lens (read-only)', emailVerified: true })).id;
        const session = await ia.createSession(userId, false);
        const name = ctx.authCookies?.sessionToken?.name ?? '__Secure-better-auth.session_token';
        return {
          name,
          value: signSessionCookie(session.token, ctx.secret ?? config.authSecret),
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
          path: '/',
        };
      },
    }),
  );
}
