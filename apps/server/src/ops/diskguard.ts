// F025.1 + F025.3 — disk-guard + WAL safety valve.
//
// Why this exists (2026-07-30 → 08-02 outage): db/index.ts sets
// `wal_autocheckpoint = 0` so the app never checkpoints inline (that inline
// checkpoint was the 2026-06-02 event-loop freeze — see docs/adr/0001), which
// left Litestream as the ONLY checkpointer. But Litestream checkpoints by first
// copying the WAL to a shadow WAL on the SAME volume: it needs free space in
// order to free space. The WAL grew into the last of the headroom, /data hit
// 100%, and that deadlocked — no checkpoint possible, no DELETE possible (a
// DELETE writes to the WAL first), so it could not recover on its own. Every
// write 500'd and the whole fleet's error-tracking went blind for three days.
//
// Two independent guards, both deliberately cheap and both off the request path:
//   1. WAL valve  — cap the WAL so it can never eat the headroom again.
//   2. Disk guard — alarm well before 100%, because AT 100% there is no cheap
//                   way out left, only manual infra work.
import { statfsSync, statSync } from 'node:fs';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db';
import { config } from '../config';

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  /** 0–100, computed the same way `df` reports it. */
  usedPct: number;
}

// Read space via statfs, NOT via SQLite. The guard has to keep answering when
// the database is unwritable — that is precisely the case it exists to catch.
export function diskUsage(path: string = config.dataDir): DiskUsage {
  const s = statfsSync(path);
  const bsize = Number(s.bsize);
  const totalBytes = Number(s.blocks) * bsize;
  const usedBytes = (Number(s.blocks) - Number(s.bfree)) * bsize;
  const availBytes = Number(s.bavail) * bsize;
  const denom = usedBytes + availBytes;
  return { totalBytes, usedBytes, availBytes, usedPct: denom > 0 ? (usedBytes / denom) * 100 : 0 };
}

/** Size of the -wal sidecar; 0 when it does not exist (fresh db / non-WAL). */
export function walSizeBytes(dbPath: string = config.databasePath): number {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

export interface WalCheckpointResult {
  ran: boolean;
  beforeBytes: number;
  afterBytes: number;
  busy?: boolean;
}

// The valve. Only truncates when the WAL is over the cap, so the normal path
// stays exactly as it is today (append-only, no checkpoint stall). A brief
// stall once the WAL is already oversized is orders of magnitude cheaper than
// another three-day outage.
// Takes only "something that can run a PRAGMA" rather than the whole schema-typed
// db — the valve has no business knowing the application's tables.
export interface PragmaRunner {
  get(query: SQL): unknown;
}

export function checkpointWalIfOversized(
  db: PragmaRunner = getDb(),
  capBytes: number = config.walCapBytes,
  dbPath: string = config.databasePath,
): WalCheckpointResult {
  const beforeBytes = walSizeBytes(dbPath);
  if (beforeBytes <= capBytes) return { ran: false, beforeBytes, afterBytes: beforeBytes };

  // (TRUNCATE) both checkpoints and resets the file to zero length, which is
  // what actually returns the bytes to the filesystem — PASSIVE would leave the
  // file at its high-water mark.
  const row = db.get(sql`PRAGMA wal_checkpoint(TRUNCATE)`) as Record<string, unknown> | undefined;
  const busy = Boolean(row && Number(row.busy ?? 0));
  const afterBytes = walSizeBytes(dbPath);
  return { ran: true, beforeBytes, afterBytes, busy };
}

// ── alerting (must not touch the database) ───────────────────────────────────
export type DiskBand = 'ok' | 'warn' | 'critical';

export function bandFor(usedPct: number): DiskBand {
  if (usedPct >= config.diskCriticalPct) return 'critical';
  if (usedPct >= config.diskWarnPct) return 'warn';
  return 'ok';
}

const gb = (n: number) => `${(n / 1_073_741_824).toFixed(2)} GB`;

// Straight to Discord — no DB read, no DB write, no alert_rules lookup. An
// alarm that needs a successful write to be delivered fails at exactly the
// moment it is needed.
// `note` exists so the alarm can be proven on demand without ever touching prod
// config: a temporary threshold change has to be put BACK, and that step can be
// missed — which would leave the guard alarming on everything, a new failure
// introduced by the act of verifying. A marked one-off carries no such step.
export async function sendDiskAlert(
  band: Exclude<DiskBand, 'ok'>,
  u: DiskUsage,
  wal: number,
  webhook: string = config.fleetAlertDiscordWebhook,
  note?: string,
): Promise<boolean> {
  if (!webhook) return false; // ship-dark: inert until the secret is set
  // A drill must be unmistakable at a GLANCE, not on close reading. The first
  // version only appended a disclaimer under an otherwise-real alarm: red bar,
  // "[CRITICAL]", a synthetic percentage in the title, and a live imperative
  // ("Extend the volume now"). Christian read a 9-day-old drill as an emergency
  // — correctly, because everything that carries urgency said it was one. So a
  // drill now differs in the three things read first (colour, title, opening
  // line) and never issues an order; the real wording is QUOTED, not spoken.
  const drill = Boolean(note);
  const action =
    band === 'critical'
      ? 'At 100% SQLite can neither checkpoint nor DELETE — it cannot recover on its own. Extend the volume now.'
      : 'Headroom shrinking. Check retention + WAL before it reaches critical.';
  const facts =
    `${gb(u.usedBytes)} used of ${gb(u.totalBytes)} · ${gb(u.availBytes)} free\n` +
    `WAL: ${(wal / 1_048_576).toFixed(0)} MB (cap ${(config.walCapBytes / 1_048_576).toFixed(0)} MB)`;
  const title = drill
    ? `${note} drill — disk alarm path check · NOT a real alert`
    : `[${band.toUpperCase()}] upmetrics disk ${u.usedPct.toFixed(1)}% full`;
  const body = drill
    ? `Nothing is wrong. This is a rehearsal of the ${band} disk alarm; every number below is invented.\n\n` +
      `A real one would have said:\n` +
      `> **[${band.toUpperCase()}] upmetrics disk ${u.usedPct.toFixed(1)}% full**\n` +
      facts
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n') +
      `\n> ${action}`
    : `${facts}\n${action}`;
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // grey for a drill — never the alarm palette, so it cannot be mistaken
        // for a live alert in a glance at a phone notification.
        embeds: [{ title, description: body, color: drill ? 0x6b7280 : band === 'critical' ? 0xef4444 : 0xf59e0b }],
      }),
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

// ── worker ───────────────────────────────────────────────────────────────────
export interface DiskGuardTickResult {
  usage: DiskUsage;
  band: DiskBand;
  wal: WalCheckpointResult;
  alerted: boolean;
}

// Re-alert state. Only re-fires on escalation, or once per re-alert window, so
// a sustained 80% does not become its own alarm storm.
let lastBand: DiskBand = 'ok';
let lastAlertAt = 0;
let lastUsage: (DiskUsage & { walBytes: number; at: number }) | null = null;

/** Last measurement, for /health to report without paying a syscall per request. */
export function lastDiskUsage(): (DiskUsage & { walBytes: number; at: number }) | null {
  return lastUsage;
}

export function __resetDiskGuardState(): void {
  lastBand = 'ok';
  lastAlertAt = 0;
  lastUsage = null;
}

const RANK: Record<DiskBand, number> = { ok: 0, warn: 1, critical: 2 };

export async function diskGuardTick(now: number = Date.now()): Promise<DiskGuardTickResult> {
  // Valve FIRST, and independently of the disk measurement. It is the one action
  // that can still hand space back, so it must not be skipped just because
  // statfs failed — the two guards deliberately do not depend on each other.
  let wal: WalCheckpointResult;
  try {
    wal = checkpointWalIfOversized();
    if (wal.ran) {
      console.log(
        `[diskguard] wal checkpoint: ${(wal.beforeBytes / 1_048_576).toFixed(0)}MB → ` +
          `${(wal.afterBytes / 1_048_576).toFixed(0)}MB${wal.busy ? ' (busy — partial)' : ''}`,
      );
    }
  } catch (err) {
    console.error('[diskguard] wal checkpoint failed:', err);
    const size = walSizeBytes();
    wal = { ran: false, beforeBytes: size, afterBytes: size };
  }

  let usage: DiskUsage;
  try {
    usage = diskUsage();
  } catch (err) {
    // Never let a failed measurement take the worker (and thus the valve) down.
    console.error('[diskguard] disk measurement failed:', err);
    return { usage: { totalBytes: 0, usedBytes: 0, availBytes: 0, usedPct: 0 }, band: 'ok', wal, alerted: false };
  }
  const band = bandFor(usage.usedPct);

  let alerted = false;
  if (band !== 'ok') {
    const escalated = RANK[band] > RANK[lastBand];
    const windowPassed = now - lastAlertAt >= config.diskAlertRealertMs;
    if (escalated || windowPassed) {
      alerted = await sendDiskAlert(band, usage, wal.afterBytes);
      if (alerted) lastAlertAt = now;
    }
    console.warn(`[diskguard] ${band}: ${usage.usedPct.toFixed(1)}% used, ${gb(usage.availBytes)} free`);
  }
  lastBand = band;
  lastUsage = { ...usage, walBytes: wal.afterBytes, at: now };
  return { usage, band, wal, alerted };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startDiskGuardWorker(): void {
  if (timer) return;
  const tick = () => {
    void diskGuardTick().catch((err) => console.error('[diskguard] tick failed:', err));
  };
  tick(); // run once at boot — a guard that first speaks in an hour is not a guard
  timer = setInterval(tick, config.diskGuardIntervalMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
}
