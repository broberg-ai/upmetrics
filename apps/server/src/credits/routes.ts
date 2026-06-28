// F022 — provider credit endpoints. F022.2: credit-snapshot ingest (write).
// The export-API (F022.5, read-only) is registered alongside once built.
import type { Context, Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { getDb } from '../db';
import { insertSnapshot } from './store';

// Constant-time compare of a header token against a config secret. Empty config
// secret → always false (ship-dark: the endpoint is unusable until set).
function tokenAuthed(c: Context, header: string, expected: string): boolean {
  const key = c.req.header(header);
  if (!key || !expected) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerCreditRoutes(app: Hono): void {
  // F022.2 — ingest one provider balance reading → append-only snapshot.
  // Authed by CREDIT_INGEST_TOKEN (x-upmetrics-credit-key); never public. Used by
  // mock/manual injection + any external producer; the provider_balance probe
  // (F022.3) writes in-process through the same store.
  app.post('/api/providers/:provider/credit-snapshot', async (c) => {
    if (!tokenAuthed(c, 'x-upmetrics-credit-key', config.creditIngestToken)) {
      return c.json({ error: 'invalid_credit_key' }, 401);
    }
    const provider = c.req.param('provider');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const totalCredits = Number(b.total_credits);
    const totalUsage = Number(b.total_usage);
    // Malformed or negative-balance payloads → 400, no row written.
    if (
      !Number.isFinite(totalCredits) ||
      !Number.isFinite(totalUsage) ||
      totalCredits < 0 ||
      totalUsage < 0 ||
      totalUsage > totalCredits // remaining can't be negative on a prepaid account
    ) {
      return c.json({ error: 'invalid_payload', need: ['total_credits>=0', 'total_usage in [0, total_credits]'] }, 400);
    }
    const snap = insertSnapshot(getDb(), {
      provider,
      totalCredits,
      totalUsage,
      currency: typeof b.currency === 'string' ? b.currency : 'USD',
      raw: b.raw ?? b,
    });
    return c.json({ ok: true, id: snap.id, provider, remaining: snap.remaining, captured_at: snap.capturedAt });
  });
}
