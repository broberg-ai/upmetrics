// F025.1 + F025.3 — RED harness for the disk-guard and the WAL safety valve.
// These are the seal on a load-bearing chain: when upmetrics' write path dies,
// the whole fleet goes blind (2026-07-30 → 08-02, three days). Each test fails
// if the guard that would have caught it stops working.
// Run: bun test src/ops/diskguard.test.ts
process.env.DATABASE_PATH = ':memory:';
process.env.FLEET_ALERT_DISCORD_WEBHOOK = 'https://discord.test/webhook';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { sql } from 'drizzle-orm';
import {
  diskUsage,
  walSizeBytes,
  checkpointWalIfOversized,
  bandFor,
  sendDiskAlert,
  __resetDiskGuardState,
} from './diskguard';
import { config } from '../config';

const origFetch = globalThis.fetch;
let dir: string;

// A real on-disk WAL database that mirrors prod: autocheckpoint OFF, so the WAL
// only ever grows — which is precisely the condition that filled the volume.
function makeWalDb(path: string) {
  const sqlite = new Database(path);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA wal_autocheckpoint = 0;');
  sqlite.exec('CREATE TABLE blob_rows (id INTEGER PRIMARY KEY, body TEXT);');
  return drizzle(sqlite);
}

function growWal(db: ReturnType<typeof makeWalDb>, rows: number) {
  const chunk = 'x'.repeat(4096);
  for (let i = 0; i < rows; i++) db.run(sql`INSERT INTO blob_rows (body) VALUES (${chunk})`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upm-diskguard-'));
  __resetDiskGuardState();
});
afterEach(() => {
  globalThis.fetch = origFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe('F025.3 — WAL safety valve', () => {
  it('truncates the WAL once it grows past the cap (the 2026-07-30 failure mode)', () => {
    const path = join(dir, 'valve.db');
    const db = makeWalDb(path);
    growWal(db, 400); // ~1.6MB of 4KB rows, autocheckpoint off → WAL holds it all

    const before = walSizeBytes(path);
    expect(before).toBeGreaterThan(64 * 1024); // WAL really did grow

    const res = checkpointWalIfOversized(db, 64 * 1024, path); // cap well below `before`
    expect(res.ran).toBe(true);
    // The whole point: bytes actually returned to the filesystem, not just
    // marked reusable. A PASSIVE checkpoint would leave the file at high-water.
    expect(res.afterBytes).toBeLessThan(res.beforeBytes);
    expect(statSync(`${path}-wal`).size).toBeLessThan(before);
  });

  it('does NOT checkpoint while the WAL is under the cap (no needless stalls)', () => {
    const path = join(dir, 'quiet.db');
    const db = makeWalDb(path);
    growWal(db, 5);

    const res = checkpointWalIfOversized(db, 64 * 1024 * 1024, path); // 64MB cap
    expect(res.ran).toBe(false);
    expect(res.afterBytes).toBe(res.beforeBytes);
  });

  it('reports 0 for a database with no WAL sidecar instead of throwing', () => {
    expect(walSizeBytes(join(dir, 'nope.db'))).toBe(0);
  });
});

describe('F025.1 — disk-guard bands', () => {
  it('classifies ok / warn / critical around the configured thresholds', () => {
    expect(bandFor(config.diskWarnPct - 0.1)).toBe('ok');
    expect(bandFor(config.diskWarnPct)).toBe('warn');
    expect(bandFor(config.diskCriticalPct - 0.1)).toBe('warn');
    expect(bandFor(config.diskCriticalPct)).toBe('critical');
    expect(bandFor(100)).toBe('critical');
  });

  it('fires well below 100% — at 100% there is no cheap recovery left', () => {
    // Guards the intent, not just the arithmetic: if someone "tunes" the
    // thresholds up to 95/99 this fails, because that is too late to act.
    expect(config.diskWarnPct).toBeLessThanOrEqual(80);
    expect(config.diskCriticalPct).toBeLessThanOrEqual(90);
    expect(config.diskWarnPct).toBeLessThan(config.diskCriticalPct);
  });

  it('measures real free space via statfs, not via the database', () => {
    const u = diskUsage(dir);
    expect(u.totalBytes).toBeGreaterThan(0);
    expect(u.usedPct).toBeGreaterThanOrEqual(0);
    expect(u.usedPct).toBeLessThanOrEqual(100);
    expect(u.availBytes).toBeGreaterThanOrEqual(0);
  });
});

describe('F025.1 — the alarm must survive an unwritable database', () => {
  it('delivers the alert with NO database access at all', async () => {
    // The failure this guards: an alert that needs a successful DB write fails
    // at exactly the moment it is needed, because the disk being full is what
    // broke writing in the first place. Nothing here touches the db.
    let posted: { url: string; body: string } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posted = { url: String(url), body: String(init?.body ?? '') };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const ok = await sendDiskAlert(
      'critical',
      { totalBytes: 1e9, usedBytes: 0.99e9, availBytes: 0.01e9, usedPct: 99 },
      226 * 1024 * 1024,
      'https://discord.test/webhook',
    );

    expect(ok).toBe(true);
    expect(posted).not.toBeNull();
    expect(posted!.url).toBe('https://discord.test/webhook');
    expect(posted!.body).toContain('CRITICAL');
    expect(posted!.body).toContain('99.0%');
  });

  // A drill that LOOKS like an alarm is worse than no drill: Christian read a
  // 9-day-old one as a live emergency because the colour, the "[CRITICAL]" and
  // the imperative all said it was real, and only a footer said otherwise.
  // These assertions fail if anyone makes a drill wear the alarm's clothes again.
  it('a drill is unmistakable: never the alarm colour, never a live order', async () => {
    let posted = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted = String(init?.body ?? '');
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await sendDiskAlert(
      'critical',
      { totalBytes: 3e9, usedBytes: 2.7e9, availBytes: 0.3e9, usedPct: 90 },
      200 * 1024 * 1024,
      'https://discord.test/webhook',
      '[TEST]',
    );
    const embed = JSON.parse(posted).embeds[0];

    expect(embed.color).toBe(0x6b7280); // grey — NOT 0xef4444 red, not amber
    expect(embed.color).not.toBe(0xef4444);
    expect(embed.title).toContain('NOT a real alert');
    expect(embed.title).not.toContain('90.0%'); // no synthetic number stated as fact
    expect(embed.description).toMatch(/^Nothing is wrong\./); // disclaimer FIRST, not a footer
    // the real wording may appear only as a quote, never as an instruction
    for (const line of String(embed.description).split('\n')) {
      if (line.includes('Extend the volume now')) expect(line.startsWith('>')).toBe(true);
    }
  });

  it('a REAL alert still carries the alarm colour and the order', async () => {
    let posted = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted = String(init?.body ?? '');
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await sendDiskAlert(
      'critical',
      { totalBytes: 3e9, usedBytes: 2.7e9, availBytes: 0.3e9, usedPct: 90 },
      200 * 1024 * 1024,
      'https://discord.test/webhook',
    );
    const embed = JSON.parse(posted).embeds[0];

    expect(embed.color).toBe(0xef4444);
    expect(embed.title).toContain('[CRITICAL]');
    expect(embed.title).toContain('90.0%');
    expect(embed.description).toContain('Extend the volume now.');
    expect(embed.description).not.toContain('>'); // not quoted — this one is real
  });

  it('reports failure instead of throwing when the webhook is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const ok = await sendDiskAlert(
      'warn',
      { totalBytes: 1e9, usedBytes: 0.75e9, availBytes: 0.25e9, usedPct: 75 },
      0,
      'https://discord.test/webhook',
    );
    expect(ok).toBe(false); // never let the guard itself crash the worker
  });
});
