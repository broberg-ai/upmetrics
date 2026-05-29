// Magic-link email delivery via Resend. From address is upmetrics@webhouse.dk.
import { Resend } from 'resend';
import { config } from '../config';

const resend = new Resend(config.resendApiKey);

export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  // Ensure post-verify lands on the '/' page (302) instead of raw JSON when the
  // caller didn't supply a callbackURL (no frontend yet — see F006).
  const link = url.includes('callbackURL=') ? url : `${url}${url.includes('?') ? '&' : '?'}callbackURL=/`;
  const { error } = await resend.emails.send({
    from: config.authEmailFrom,
    to,
    subject: 'Your Upmetrics sign-in link',
    html: `<p>Click to sign in to Upmetrics:</p><p><a href="${link}">${link}</a></p><p>This link expires shortly. If you didn't request it, ignore this email.</p>`,
    text: `Sign in to Upmetrics: ${link}`,
  });
  if (error) throw new Error(`resend send failed: ${error.message}`);
}
