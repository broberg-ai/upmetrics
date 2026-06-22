# F021 — Fleet-package consolidation (lens · config · mail)

**Status:** approved 2026-06-22 (Christian: “kør hele passet”). One verified pass.

## Motivation

upmetrics hand-rolled three cross-cutting capabilities before the fleet packages
existed. They now exist, are shipped, and are used by sibling repos — a
hand-rolled copy is drift waiting to happen (broberg.ai house rule: **reuse >
re-roll**). This pass swaps the three for their fleet packages, with tests + a
prod deploy as proof.

Grounded in the Discovery inventory (`discovery.broberg.ai`):

| Hand-rolled today | Fleet package | Fit |
|---|---|---|
| `auth/lens.ts` — F016 mint-endpoint | `@broberg/lens@0.1.2` (`/hono`) | clean — an **upgrade** |
| `config.ts` — `int()`/`num()` + prod guard | `@broberg/config@0.1.1` | **partial** (see caveat) |
| `auth/email.ts` (resend SDK) + `incidents/alerts.ts` (raw REST) | `@broberg/mail@0.1.0` | clean — drops `resend` dep |

## Stories

### F021.1 — Lens mint-endpoint → @broberg/lens
`@broberg/lens/hono`'s `lensSessionHandler` owns the Bearer gate, TTL-clamp,
rate-limit, the **0.0.0.0 cookie-domain trap guard**, and the storageState shape.
We supply only the auth-specific 20% via the `createSession` callback — the SAME
real Better Auth session mint we have today (`internalAdapter.createUser/createSession`
for `lens@upmetrics.org`). A synthetic cookie would bounce the SPA to login (the
bug F016 commit aae5e18 fixed), so the real-session mint is non-negotiable.
`signSessionCookie` + `LENS_EMAIL` stay exported (test + callback use them).

### F021.2 — Adopt @broberg/config (carefully)
`coerceInt` replaces our `int()` 1:1 (identical: fallback when absent/empty,
throw on non-integer). Two honest caveats drive a *careful* adoption, not a
blind one:
- **No float coercer** for our single `num()` call (`DEPLOY_REGRESSION_MULTIPLIER`,
  a float) — keep `num()` local; report the gap to `components`.
- **`productionGuard` is truthy-only.** Our guard also rejects the dev-default
  `AUTH_SECRET` sentinel (`'dev-only-secret-change-in-prod'`, which is truthy) —
  `productionGuard` would let that boot. So: keep the explicit AUTH_SECRET
  sentinel+empty check, use `productionGuard` for the plain falsy keys
  (RESEND_API_KEY). Adopting the package must not weaken the boot guard.

The `config` object **shape is unchanged** — no downstream consumer (50+ sites) is touched.

### F021.3 — Mail → @broberg/mail; drop resend SDK
One shared `mailer` (`src/mail.ts`) built from single-source `config`
(`createMailer({ apiKey, from })`). Both send-paths route through it:
- `auth/email.ts` magic-link — throw on `!ok` (a failed sign-in mail must surface).
- `incidents/alerts.ts` alert email — keep the `email channel not configured`
  guard; throw on `!ok` so `deliver()` records it.

Removes the `resend` npm dependency (the package uses raw fetch). Ship-dark in
dev (no key → `skipped`, never a crash). `live` defaults to `!!apiKey`, so prod
delivers to all real recipients (no allowlist surprise); `MAIL_ALLOWLIST` stays unset.

## Non-goals

- No switch to `parseEnv` (Zod) for the full ~60-key config — that's a churny
  rewrite of a working file; the escape-hatch (`coerceInt`) is the surgical path.
- No change to mail **templates** (per-brand HTML stays local — F023 boundary).
- No behavioural change to alerting / auth flows — pure dependency swap.

## Rollout & verification

1. `pnpm add -E @broberg/lens@0.1.2 @broberg/config@0.1.1 @broberg/mail@0.1.0 --filter @upmetrics/server`; `pnpm remove resend --filter @upmetrics/server`.
2. Implement the three swaps. `pnpm --filter @upmetrics/server typecheck` + `bun test src/` green.
3. `fly deploy -a upmetrics --ha=false`; prod boots.
4. Live proof: `POST /api/lens-session` → 401 (no bearer) / 200 + full cookie shape (correct bearer); Lens runtime-verify authenticates + renders the dashboard; `/release` + CORS unaffected.
5. Enroll `@broberg/lens` + `@broberg/config` + `@broberg/mail` on Discovery (`role:'uses'`). Report the float-coercer gap to `components`.
