// Magic-link email delivery via @broberg/mail (F021.3). From address is upmetrics@webhouse.dk.
import { mailer } from '../mail';

export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  // Ensure post-verify lands on the '/' page (302) instead of raw JSON when the
  // caller didn't supply a callbackURL (no frontend yet — see F006).
  const link = url.includes('callbackURL=') ? url : `${url}${url.includes('?') ? '&' : '?'}callbackURL=/`;
  const res = await mailer.send({
    to,
    subject: 'Your Upmetrics sign-in link',
    html: `<p>Click to sign in to Upmetrics:</p><p><a href="${link}">${link}</a></p><p>This link expires shortly. If you didn't request it, ignore this email.</p>`,
    text: `Sign in to Upmetrics: ${link}`,
  });
  // A failed sign-in mail must surface (don't silently succeed). A dev ship-dark
  // skip returns ok:true, so this only throws on a real delivery failure.
  if (!res.ok) throw new Error(`magic-link email failed: ${res.error ?? 'unknown error'}`);
}
