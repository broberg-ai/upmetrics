// PII scrubbing (F003.1). On by default: drop sensitive headers/keys, mask
// email / Danish CPR / phone patterns in any string before send.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CPR = /\b\d{6}-?\d{4}\b/g; // ddmmyy-xxxx
const PHONE = /(?<!\d)(?:\+45[\s-]?)?\d{8}(?!\d)/g;

const DROP_KEY = /^(authorization|cookie|set-cookie|x-api-key|x-upmetrics-key|x-sentry-auth|proxy-authorization)$/i;

export function maskString(s: string): string {
  return s.replace(EMAIL, '[email]').replace(CPR, '[cpr]').replace(PHONE, '[phone]');
}

export function scrub<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return maskString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => scrub(v, seen)) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = DROP_KEY.test(k) ? '[redacted]' : scrub(v, seen);
  }
  return out as unknown as T;
}
