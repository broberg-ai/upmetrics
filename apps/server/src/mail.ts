// Single shared Resend mailer (F021.3) — @broberg/mail, configured from our
// single-source config. Ship-dark when RESEND_API_KEY is unset (a skipped send,
// ok:true, never a crash). Used by magic-link auth + incident alert email.
import { createMailer } from '@broberg/mail';
import { config } from './config';
import { captureSelf } from './dogfood';

// "Are we a DEPLOYED instance?" — answered by the platform, not by us.
// FLY_APP_NAME is injected by fly.io; it appears in no file of ours (verified
// 2026-08-26 on the running machine). NODE_ENV would be the obvious choice and
// is the wrong one: we set it ourselves in BOTH fly.toml and the Dockerfile, so
// it is exactly the value that can drift — a new base image, an override, a
// typo. Deciding "may we deliver" from a value we control, and then checking
// that decision against the same value, is a gate that cannot fail: if
// NODE_ENV stopped saying "production", delivery would close AND the check
// would fall silent with it. cms hit precisely this in their own copy.
const isDeployed = Boolean(process.env.FLY_APP_NAME);

// `live` MUST be passed explicitly. @broberg/mail 0.3.0 flipped its default
// from `!!apiKey` to FALSE, so leaving it out means every recipient outside the
// fleet-admin allowlist gets `{ ok: true, skipped: true }` — a green "sent"
// with nothing delivered. Measured before this upgrade: our two sign-in
// accounts are cb@webhouse.dk (always allowed) and lens@upmetrics.org (NOT), so
// the silent half was real, and a magic-link mail is the one message that must
// never be quietly dropped. Only a deployed instance opts in, so a local run
// still cannot reach a real user by accident — the safety the new default adds.
export const mailer = createMailer({
  apiKey: config.resendApiKey,
  from: config.authEmailFrom,
  live: isDeployed && Boolean(config.resendApiKey),
});

/**
 * Complain — loudly, and into our OWN error board — if a deployed instance came
 * up unable to deliver. A test proves the gate LOGIC; only a startup check
 * catches an environment that lies about itself.
 *
 * Deliberately does NOT throw. This process is the fleet's error tracking;
 * taking it down over a mail misconfiguration would trade a quiet failure for a
 * loud outage that blinds every other repo. cms made the same call for the same
 * reason. Called from index.ts after initDogfood(), so the capture has a sink.
 */
export function assertMailGateSane(): void {
  if (!isDeployed || mailer.mode === 'live') return;
  const msg = `mail gate closed on a deployed instance: mode=${mailer.mode} — sends will report ok and deliver nothing`;
  console.error(`[mail] ${msg}`);
  captureSelf(new Error(msg), { mode: mailer.mode, hasKey: Boolean(config.resendApiKey) });
}
