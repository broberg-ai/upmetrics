// F025.2 — the one-time switch that lets the retention job give space back.
//
// A DELETE in SQLite only moves pages onto the freelist; the file keeps its
// high-water mark. Measured on prod 24/9 2026: 165,360 of 189,730 pages were
// free — 677 MB of a 777 MB file — because the per-project cap had pruned the
// rows and the disk never saw it. auto_vacuum was NONE, so there was no way to
// hand pages back short of rewriting the whole file.
//
// INCREMENTAL makes `PRAGMA incremental_vacuum(N)` possible: the retention tick
// returns a bounded number of pages per run instead of one big rewrite. Turning
// it on for an EXISTING database requires one VACUUM. That runs here, from
// migrate.ts, i.e. BEFORE the server listens and before Litestream starts — so
// there is no event loop to freeze and no replicator to contend with. Measured
// on a prod-shaped copy (928 MB file, ~200 MB live): 4.6 s, well inside Fly's
// 30 s health-check grace period. VACUUM copies only live pages, so prod's
// ~100 MB of live data should be faster still.
import type { Database } from 'bun:sqlite';

const INCREMENTAL = 2; // PRAGMA auto_vacuum: 0 NONE · 1 FULL · 2 INCREMENTAL

export interface VacuumState {
  autoVacuum: number;
  pageCount: number;
  freelistCount: number;
}

export interface VacuumConversion {
  converted: boolean;
  ms: number;
  before: VacuumState;
  after: VacuumState;
}

export function vacuumState(sqlite: Database): VacuumState {
  const read = (p: string) => Number((sqlite.query(`PRAGMA ${p}`).get() as Record<string, unknown>)[p]);
  return { autoVacuum: read('auto_vacuum'), pageCount: read('page_count'), freelistCount: read('freelist_count') };
}

// Idempotent: a database already in INCREMENTAL is left untouched, so this is a
// no-op on every boot after the first. The caller decides what a failure means;
// migrate.ts logs it and lets the server start, because a boot that dies over
// reclaiming space would trade wasted disk for an outage.
export function ensureIncrementalAutoVacuum(sqlite: Database): VacuumConversion {
  const before = vacuumState(sqlite);
  if (before.autoVacuum === INCREMENTAL) return { converted: false, ms: 0, before, after: before };

  const t0 = performance.now();
  sqlite.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  sqlite.exec('VACUUM;');
  // Litestream is not running yet, so this checkpoint cannot contend with it —
  // and it is what makes the file on disk actually shrink now, not at some
  // later checkpoint.
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const ms = Math.round(performance.now() - t0);

  const after = vacuumState(sqlite);
  // The mode is the whole point; a VACUUM that ran without flipping it would
  // leave every later reclaim a silent no-op.
  if (after.autoVacuum !== INCREMENTAL) {
    throw new Error(`auto_vacuum er ${after.autoVacuum} efter VACUUM, ikke INCREMENTAL (${INCREMENTAL})`);
  }
  return { converted: true, ms, before, after };
}
