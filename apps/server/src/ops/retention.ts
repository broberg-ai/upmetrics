// F007.1 — retention + daily compaction. Per project: purge events past
// retention_days, purge agent_runs past agent_retention_days (kept longer for
// analytics), and downsample probe_results older than PROBE_COMPACTION_DAYS into
// one hourly aggregate row (avg responseMs, sample_count = N). All deletes are
// batched so a big purge never holds a long write lock against live ingest.
import { and, eq, lt, inArray, asc, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
type AnyTable = typeof schema.events | typeof schema.agentRuns | typeof schema.probeResults;

export interface RetentionResult {
  eventsDeleted: number;
  agentRunsDeleted: number;
  probeResultsCompacted: number;
  /** F025.2 — events dropped by the per-project cap, not by age. */
  eventsCapped: number;
}

const DAY_MS = 86_400_000;

// Delete in fixed-size batches until the predicate matches nothing — keeps each
// transaction short so live ingest is not locked out (AC2).
function batchedDelete(db: Db, table: AnyTable, where: ReturnType<typeof and>, batch: number): number {
  let total = 0;
  for (;;) {
    const ids = db
      .select({ id: (table as { id: typeof schema.events.id }).id })
      .from(table)
      .where(where)
      .limit(batch)
      .all()
      .map((r) => r.id as string);
    if (ids.length === 0) break;
    db.delete(table)
      .where(inArray((table as { id: typeof schema.events.id }).id, ids))
      .run();
    total += ids.length;
    if (ids.length < batch) break;
  }
  return total;
}

export interface RetentionOptions {
  /** Override the per-project event cap (tests inject a small one; prod uses config). */
  maxEventsPerProject?: number;
}

export function runRetention(db: Db, now: Date = new Date(), opts: RetentionOptions = {}): RetentionResult {
  const r: RetentionResult = { eventsDeleted: 0, agentRunsDeleted: 0, probeResultsCompacted: 0, eventsCapped: 0 };
  const batch = config.retentionBatchSize;
  const cap = opts.maxEventsPerProject ?? config.maxEventsPerProject;

  for (const p of db.select().from(schema.projects).all()) {
    const evCut = new Date(now.getTime() - p.retentionDays * DAY_MS);
    r.eventsDeleted += batchedDelete(
      db,
      schema.events,
      and(eq(schema.events.projectId, p.id), lt(schema.events.receivedAt, evCut)),
      batch,
    );
    r.eventsCapped += capProjectEvents(db, p.id, batch, cap);
    const arCut = new Date(now.getTime() - p.agentRetentionDays * DAY_MS);
    r.agentRunsDeleted += batchedDelete(
      db,
      schema.agentRuns,
      and(eq(schema.agentRuns.projectId, p.id), lt(schema.agentRuns.startedAt, arCut)),
      batch,
    );
  }

  r.probeResultsCompacted += compactProbeResults(db, now);
  return r;
}

// F025.2 — enforce the per-project event ceiling. Time-based retention bounds
// AGE, not SIZE: a project can flood its whole window and still be "within
// retention" (buddy: 163k events / 552 MB inside 30 days = 96% of the database,
// which crowded out every other project's history). This drops the OLDEST
// events past the cap so a single noisy sender cannot evict the fleet.
function capProjectEvents(db: Db, projectId: string, batch: number, cap: number): number {
  if (cap <= 0) return 0; // disabled

  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.events)
    .where(eq(schema.events.projectId, projectId))
    .get();
  let excess = (total?.n ?? 0) - cap;
  if (excess <= 0) return 0;
  // Bound the work per tick. bun:sqlite is synchronous, so a huge one-shot
  // prune blocks the event loop — the same stall class that caused the
  // 2026-06-02 flap. A large backlog drains over several ticks instead.
  excess = Math.min(excess, config.retentionCapBudgetPerTick);

  let removed = 0;
  while (excess > 0) {
    const take = Math.min(excess, batch);
    const ids = db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.projectId, projectId))
      .orderBy(asc(schema.events.receivedAt)) // oldest first
      .limit(take)
      .all()
      .map((x) => x.id);
    if (ids.length === 0) break;
    db.delete(schema.events).where(inArray(schema.events.id, ids)).run();
    removed += ids.length;
    excess -= ids.length;
    if (ids.length < take) break;
  }
  if (removed) console.warn(`[retention] project "${projectId}" over cap ${cap} — pruned ${removed} oldest events`);
  return removed;
}

// Collapse raw (sample_count=1) probe_results older than the cutoff into one row
// per (probe, hour): avg responseMs, ok by majority, sample_count = N.
function compactProbeResults(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - config.probeCompactionDays * DAY_MS);
  const raw = db
    .select()
    .from(schema.probeResults)
    .where(and(lt(schema.probeResults.checkedAt, cutoff), eq(schema.probeResults.sampleCount, 1)))
    .all();

  const buckets = new Map<string, typeof raw>();
  for (const row of raw) {
    const hour = Math.floor(row.checkedAt.getTime() / 3_600_000);
    const key = `${row.probeId}:${hour}`;
    const arr = buckets.get(key);
    if (arr) arr.push(row);
    else buckets.set(key, [row]);
  }

  let removed = 0;
  for (const rows of buckets.values()) {
    if (rows.length <= 1) continue; // already effectively hourly
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    const keep = rows[0]!;
    const n = rows.length;
    const okCount = rows.filter((x) => x.ok).length;
    const msVals = rows.map((x) => x.responseMs).filter((v): v is number => v != null);
    const avgMs = msVals.length ? Math.round(msVals.reduce((a, b) => a + b, 0) / msVals.length) : null;

    db.update(schema.probeResults)
      .set({ responseMs: avgMs, ok: okCount > n / 2, statusCode: null, error: null, sampleCount: n })
      .where(eq(schema.probeResults.id, keep.id))
      .run();
    const deleteIds = rows.slice(1).map((x) => x.id);
    db.delete(schema.probeResults).where(inArray(schema.probeResults.id, deleteIds)).run();
    removed += deleteIds.length;
  }
  return removed;
}

// ── daily worker ─────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
export function startRetentionWorker(): void {
  if (timer) return;
  const tick = () => {
    try {
      const res = runRetention(getDb());
      if (res.eventsDeleted || res.agentRunsDeleted || res.probeResultsCompacted || res.eventsCapped) {
        console.log('[retention]', JSON.stringify(res));
      }
    } catch (err) {
      console.error('[retention] tick failed:', err);
    }
  };
  // Run shortly after boot, not only on the interval. With interval-only, the
  // first pass landed 24h after start — so a server restarting more often than
  // daily would never prune at all, and nobody would notice until the disk was
  // full. The delay lets the server come up and start serving first.
  const boot = setTimeout(tick, config.retentionBootDelayMs);
  if (typeof boot === 'object' && 'unref' in boot) (boot as { unref: () => void }).unref();
  timer = setInterval(tick, config.retentionIntervalMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
}
