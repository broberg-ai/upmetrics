// Single shared Resend mailer (F021.3) — @broberg/mail, configured from our
// single-source config. Ship-dark when RESEND_API_KEY is unset (a skipped send,
// ok:true, never a crash). Used by magic-link auth + incident alert email.
import { createMailer } from '@broberg/mail';
import { config } from './config';

export const mailer = createMailer({ apiKey: config.resendApiKey, from: config.authEmailFrom });
