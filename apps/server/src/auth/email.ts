// Magic-link email delivery via Resend. From address is upmetrics@webhouse.dk.
import { Resend } from 'resend';
import { config } from '../config';

const resend = new Resend(config.resendApiKey);

export async function sendMagicLinkEmail(to: string, url: string): Promise<void> {
  const { error } = await resend.emails.send({
    from: config.authEmailFrom,
    to,
    subject: 'Your Upmetrics sign-in link',
    html: `<p>Click to sign in to Upmetrics:</p><p><a href="${url}">${url}</a></p><p>This link expires shortly. If you didn't request it, ignore this email.</p>`,
    text: `Sign in to Upmetrics: ${url}`,
  });
  if (error) throw new Error(`resend send failed: ${error.message}`);
}
