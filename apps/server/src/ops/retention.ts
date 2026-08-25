// F007.1 — retention + daily compaction. Per project: purge events past
// retention_days, purge agent_runs past agent_retention_days (kept longer for
// analytics), and downsample probe_results older than PROBE_COMPACTION_DAYS into
// one hourly aggregate row (avg responseMs, sample_count = N). All deletes are
// batched so a big purge never holds a long write lock against live ingest.
import { and, eq, lt, inArray, asc, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { rowsChanged } from '../db/changes';
import { captureSelf } from '../dogfood';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
type AnyTable = typeof schema.events | typeof schema.agentRuns | typeof schema.probeResults;

export interface RetentionResult {
  eventsDeleted: number;
  agentRunsDeleted: number;
  probeResultsCompacted: number;
  /** F025.2 — events dropped by the per-project cap, not by age. */
  eventsCapped: number;
  /**
   * F025.2 — one line per write whose effect could not be confirmed: it removed
   * fewer rows than it selected, or the driver gave no readable count. Empty is
   * the ONLY reading of "the prune worked"; every count above is otherwise just
   * a number this job produced about itself.
   */
  anomalies: string[];
}

const DAY_MS = 86_400_000;

// Delete in fixed-size batches until the predicate matches nothing — keeps each
// transaction short so live ingest is not locked out (AC2).
//
// F025.2: the count returned is the DELETE's own `.changes`, not the size of
// the SELECT that chose the rows. Those are different numbers the moment the
// delete stops working, and the old code reported the SELECT — so a prune that
// removed nothing at all would still have logged a confident "1000 deleted"
// while the disk filled. A shortfall also ENDS the loop: re-selecting rows a
// delete refuses to remove is an infinite loop on a synchronous driver, which
// would freeze the whole server rather than merely under-report.
function batchedDelete(
  db: Db,
  table: AnyTable,
  where: ReturnType<typeof and>,
  batch: number,
  anomalies: string[],
  label: string,
): number {
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
    const changed = rowsChanged(
      db
        .delete(table)
        .where(inArray((table as { id: typeof schema.events.id }).id, ids))
        .run(),
    );
    if (changed === null) {
      anomalies.push(`${label}: sletningen svarede uden et læsbart antal — kan ikke bekræfte at ${ids.length} rækker forsvandt`);
      return total;
    }
    total += changed;
    if (changed < ids.length) {
      anomalies.push(`${label}: valgte ${ids.length} rækker til sletning, men kun ${changed} forsvandt`);
      break;
    }
    if (ids.length < batch) break;
  }
  return total;
}

export interface RetentionOptions {
  /** Override the per-project event cap (tests inject a small one; prod uses config). */
  maxEventsPerProject?: number;
}

export function runRetention(db: Db, now: Date = new Date(), opts: RetentionOptions = {}): RetentionResult {
  const r: RetentionResult = { eventsDeleted: 0, agentRunsDeleted: 0, probeResultsCompacted: 0, eventsCapped: 0, anomalies: [] };
  const batch = config.retentionBatchSize;
  const cap = opts.maxEventsPerProject ?? config.maxEventsPerProject;

  for (const p of db.select().from(schema.projects).all()) {
    const evCut = new Date(now.getTime() - p.retentionDays * DAY_MS);
    r.eventsDeleted += batchedDelete(
      db,
      schema.events,
      and(eq(schema.events.projectId, p.id), lt(schema.events.receivedAt, evCut)),
      batch,
      r.anomalies,
      `events (projekt "${p.id}", forældede)`,
    );
    r.eventsCapped += capProjectEvents(db, p.id, batch, cap, r.anomalies);
    const arCut = new Date(now.getTime() - p.agentRetentionDays * DAY_MS);
    r.agentRunsDeleted += batchedDelete(
      db,
      schema.agentRuns,
      and(eq(schema.agentRuns.projectId, p.id), lt(schema.agentRuns.startedAt, arCut)),
      batch,
      r.anomalies,
      `agent_runs (projekt "${p.id}")`,
    );
  }

  r.probeResultsCompacted += compactProbeResults(db, now, r.anomalies);
  return r;
}

// F025.2 — enforce the per-project event ceiling. Time-based retention bounds
// AGE, not SIZE: a project can flood its whole window and still be "within
// retention" (buddy: 163k events / 552 MB inside 30 days = 96% of the database,
// which crowded out every other project's history). This drops the OLDEST
// events past the cap so a single noisy sender cannot evict the fleet.
function capProjectEvents(db: Db, projectId: string, batch: number, cap: number, anomalies: string[]): number {
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
    const changed = rowsChanged(db.delete(schema.events).where(inArray(schema.events.id, ids)).run());
    if (changed === null) {
      anomalies.push(`loft (projekt "${projectId}"): sletningen svarede uden et læsbart antal — kan ikke bekræfte at ${ids.length} rækker forsvandt`);
      break;
    }
    removed += changed;
    excess -= ids.length;
    if (changed < ids.length) {
      anomalies.push(`loft (projekt "${projectId}"): valgte ${ids.length} rækker til sletning, men kun ${changed} forsvandt`);
      break;
    }
    if (ids.length < take) break;
  }
  if (removed) console.warn(`[retention] project "${projectId}" over cap ${cap} — pruned ${removed} oldest events`);
  return removed;
}

// Collapse raw (sample_count=1) probe_results older than the cutoff into one row
// per (probe, hour): avg responseMs, ok by majority, sample_count = N.
function compactProbeResults(db: Db, now: Date, anomalies: string[]): number {
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

    const updated = rowsChanged(
      db
        .update(schema.probeResults)
        .set({ responseMs: avgMs, ok: okCount > n / 2, statusCode: null, error: null, sampleCount: n })
        .where(eq(schema.probeResults.id, keep.id))
        .run(),
    );
    // The kept row must actually become the aggregate before its siblings are
    // dropped — otherwise compaction destroys the samples and keeps a row that
    // still claims to be a single measurement.
    if (updated !== 1) {
      anomalies.push(`probe_results: aggregatrækken "${keep.id}" blev ikke opdateret (${updated ?? 'uden læsbart antal'}) — de ${n - 1} søskende-rækker blev IKKE slettet`);
      continue;
    }
    const deleteIds = rows.slice(1).map((x) => x.id);
    const changed = rowsChanged(db.delete(schema.probeResults).where(inArray(schema.probeResults.id, deleteIds)).run());
    if (changed === null) {
      anomalies.push(`probe_results: sletningen svarede uden et læsbart antal — kan ikke bekræfte at ${deleteIds.length} rækker forsvandt`);
      continue;
    }
    removed += changed;
    if (changed < deleteIds.length) {
      anomalies.push(`probe_results: valgte ${deleteIds.length} rækker til sletning, men kun ${changed} forsvandt`);
    }
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
      // An unconfirmed write is louder than a busy tick, and it is reported
      // even on an otherwise silent run — that silence is precisely what a
      // stalled prune looks like from outside. It also goes into our OWN error
      // board, because a log line on one machine is not something anyone reads
      // before the disk is full (30 July – 2 Aug: three days blind).
      for (const a of res.anomalies) console.error('[retention] UBEKRÆFTET SLETNING —', a);
      if (res.anomalies.length) {
        captureSelf(new Error(`retention: ${res.anomalies.length} ubekræftet(e) sletning(er)`), {
          anomalies: res.anomalies,
          result: { ...res, anomalies: undefined },
        });
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
