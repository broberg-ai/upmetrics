// F023 — fx_rates store. Append a fetched rate, prune to the last 5 per pair
// (continuous roll), and average the last ≤5 for the API-down fallback.
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

type Db = ReturnType<typeof getDb>;
export const KEEP = 5;

// Insert one rate, then keep only the KEEP newest rows for the pair.
export function insertRate(db: Db, pair: string, rate: number, fetchedAt: Date = new Date()): void {
  db.insert(schema.fxRates).values({ id: crypto.randomUUID(), pair, rate, fetchedAt }).run();
  const ids = db
    .select({ id: schema.fxRates.id })
    .from(schema.fxRates)
    .where(eq(schema.fxRates.pair, pair))
    .orderBy(desc(schema.fxRates.fetchedAt))
    .all()
    .map((r) => r.id);
  for (const id of ids.slice(KEEP)) db.delete(schema.fxRates).where(eq(schema.fxRates.id, id)).run();
}

// Average of the last ≤KEEP stored rates for a pair; null if none stored yet.
export function last5avg(db: Db, pair: string): number | null {
  const rows = db
    .select()
    .from(schema.fxRates)
    .where(eq(schema.fxRates.pair, pair))
    .orderBy(desc(schema.fxRates.fetchedAt))
    .limit(KEEP)
    .all();
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + r.rate, 0) / rows.length;
}
