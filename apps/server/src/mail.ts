// Single shared Resend mailer (F021.3) — @broberg/mail, configured from our
// single-source config. Ship-dark when RESEND_API_KEY is unset (a skipped send,
// ok:true, never a crash). Used by magic-link auth + incident alert email.
import { createMailer } from '@broberg/mail';
import { config } from './config';

// `live` MUST be passed explicitly. 0.3.0 flipped its default from `!!apiKey`
// to FALSE, so leaving it out means every recipient outside the fleet-admin
// allowlist gets `{ ok: true, skipped: true }` — a green "sent" with nothing
// delivered. Measured before this upgrade: our two sign-in accounts are
// cb@webhouse.dk (always allowed) and lens@upmetrics.org (NOT), so the silent
// half was real, and a magic-link mail is the one message that must never be
// quietly dropped. Opted in only in production, so a dev run still cannot
// reach a real user by accident — which is the safety the new default is for.
export const mailer = createMailer({
  apiKey: config.resendApiKey,
  from: config.authEmailFrom,
  live: config.nodeEnv === 'production' && Boolean(config.resendApiKey),
});

// A test proves the gate LOGIC; only a boot check catches an environment that
// lies about itself. productionGuard already refuses to boot without
// RESEND_API_KEY, so this can fire only if the package's semantics move again
// — which is exactly the regression that would otherwise be invisible until a
// user could not sign in.
if (config.nodeEnv === 'production' && mailer.mode !== 'live') {
  throw new Error(`mail gate closed in production: mode=${mailer.mode} — mail would be silently skipped`);
}
