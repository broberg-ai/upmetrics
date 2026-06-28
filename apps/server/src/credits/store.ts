// F022.1 — credit_snapshots store. Append-only insert + latest/recent reads.
// The money source (provider prepaid balance); agent_runs stays the spend source.
// Values are stored in full REAL precision (USD); rounding happens once at the
// export/display boundary, same discipline as the cost API.
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

type Db = ReturnType<typeof getDb>;
export type CreditSnapshot = typeof schema.creditSnapshots.$inferSelect;

export interface SnapshotInput {
  provider: string;
  totalCredits: number; // bought (USD)
  totalUsage: number; // used (USD)
  currency?: string; // default USD
  raw?: unknown; // original provider response (audit)
  capturedAt?: Date; // default now
}

// Append one snapshot. remaining is derived (credits − usage) and stored so the
// balance/alarm reads stay a single cheap row lookup.
export function insertSnapshot(db: Db, input: SnapshotInput): CreditSnapshot {
  const row = {
    id: crypto.randomUUID(),
    provider: input.provider,
    totalCredits: input.totalCredits,
    totalUsage: input.totalUsage,
    remaining: input.totalCredits - input.totalUsage,
    currency: input.currency ?? 'USD',
    capturedAt: input.capturedAt ?? new Date(),
    raw: (input.raw ?? null) as unknown,
  };
  db.insert(schema.creditSnapshots).values(row).run();
  return row as CreditSnapshot;
}

// Most-recent snapshot for a provider, or null if none yet (ship-dark state).
export function latestSnapshot(db: Db, provider: string): CreditSnapshot | null {
  return (
    db
      .select()
      .from(schema.creditSnapshots)
      .where(eq(schema.creditSnapshots.provider, provider))
      .orderBy(desc(schema.creditSnapshots.capturedAt))
      .get() ?? null
  );
}

// The N most-recent snapshots (desc) — burn-rate needs the last two.
export function recentSnapshots(db: Db, provider: string, limit = 2): CreditSnapshot[] {
  return db
    .select()
    .from(schema.creditSnapshots)
    .where(eq(schema.creditSnapshots.provider, provider))
    .orderBy(desc(schema.creditSnapshots.capturedAt))
    .limit(limit)
    .all();
}
