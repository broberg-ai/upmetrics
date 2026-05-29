// Better Auth — magic-link sign-in gated by the email allowlist.
// Tables live in the same bun:sqlite DB (created via `better-auth migrate`).
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { Database } from 'bun:sqlite';
import { config } from '../config';
import { isAllowlisted, roleFor } from './allowlist';
import { sendMagicLinkEmail } from './email';

export const auth = betterAuth({
  database: new Database(config.databasePath),
  baseURL: config.authBaseUrl,
  secret: config.authSecret,
  user: {
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'user', input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({ data: { ...user, role: roleFor(user.email) } }),
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Allowlist gate: non-allowlisted requests get no link and an error.
        if (!isAllowlisted(email)) {
          throw new APIError('FORBIDDEN', { message: 'Email is not allowlisted' });
        }
        await sendMagicLinkEmail(email, url);
      },
    }),
  ],
});

export type Auth = typeof auth;
