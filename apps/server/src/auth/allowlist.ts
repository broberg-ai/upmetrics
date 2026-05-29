// Single-org email allowlist (PLAN F16). Only these addresses may sign in.
// cb@webhouse.dk is permanent admin and must never be demoted.
const ALLOWLIST = new Set(['cb@webhouse.dk', 'mb@webhouse.dk']);
const ADMINS = new Set(['cb@webhouse.dk']);

export function isAllowlisted(email: string): boolean {
  return ALLOWLIST.has(email.trim().toLowerCase());
}

export function roleFor(email: string): 'admin' | 'user' {
  return ADMINS.has(email.trim().toLowerCase()) ? 'admin' : 'user';
}
