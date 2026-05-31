// F007.1 — retention + daily compaction. Per project: purge events past
// retention_days, purge agent_runs past agent_retention_days (kept longer for
// analytics), and downsample probe_results older than PROBE_COMPACTION_DAYS into
// one hourly aggregate row (avg responseMs, sample_count = N). All deletes are
// batched so a big purge never holds a long write lock against live ingest.
import { and, eq, lt, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
type AnyTable = typeof schema.events | typeof schema.agentRuns | typeof schema.probeResults;

export interface RetentionResult {
  eventsDeleted: number;
  agentRunsDeleted: number;
  probeResultsCompacted: number;
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

export function runRetention(db: Db, now: Date = new Date()): RetentionResult {
  const r: RetentionResult = { eventsDeleted: 0, agentRunsDeleted: 0, probeResultsCompacted: 0 };
  const batch = config.retentionBatchSize;

  for (const p of db.select().from(schema.projects).all()) {
    const evCut = new Date(now.getTime() - p.retentionDays * DAY_MS);
    r.eventsDeleted += batchedDelete(
      db,
      schema.events,
      and(eq(schema.events.projectId, p.id), lt(schema.events.receivedAt, evCut)),
      batch,
    );
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
      if (res.eventsDeleted || res.agentRunsDeleted || res.probeResultsCompacted) {
        console.log('[retention]', JSON.stringify(res));
      }
    } catch (err) {
      console.error('[retention] tick failed:', err);
    }
  };
  timer = setInterval(tick, config.retentionIntervalMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
}
