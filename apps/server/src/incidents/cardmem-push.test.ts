// F005.4 cardmem incident push + signed claim. Run: bun test src/incidents/cardmem-push.test.ts
// Isolated: own createDb(':memory:') + injected config (no global config / singleton),
// so it can't contaminate or be contaminated by sibling test files. The claim-route
// ?t= path is exercised in the live e2e (prod has REMEDIATION_RELAY_TOKEN).
import { describe, it, expect } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../db';
import { pushPendingToCardmem, signClaim, verifyClaim } from './cardmem-push';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const NOW = new Date('2026-06-02T12:00:00Z');
const OPTS = { url: 'https://cardmem.test/api/incidents', key: 'pi_test', projects: ['cardmem'], now: NOW };

function seed(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  db.insert(schema.projects).values({ id: 'cardmem', name: 'Cardmem', dsn: 'https://k@upmetrics.org/cardmem', apiKey: 'uk_cardmem', platform: 'web', repo: 'broberg-ai/cardmem', createdAt: NOW, updatedAt: NOW }).run();
  db.insert(schema.projects).values({ id: 'p2', name: 'P2', dsn: 'https://k@upmetrics.org/p2', apiKey: 'uk_p2', platform: 'web', createdAt: NOW, updatedAt: NOW }).run();
  db.insert(schema.issues).values({ id: 'iss1', projectId: 'cardmem', fingerprint: 'fp1', title: 'TypeError: boom', culprit: 'src/x.ts', level: 'error', firstSeen: NOW, lastSeen: NOW, eventCount: 7 }).run();
  db.insert(schema.incidents).values({ id: 'inc1', projectId: 'cardmem', kind: 'error_spike', status: 'open', severity: 'high', title: 'error spike in cardmem', openedAt: NOW, triggerRef: 'iss1' }).run();
  db.insert(schema.incidents).values({ id: 'inc2', projectId: 'p2', kind: 'error_spike', status: 'open', severity: 'high', title: 'p2 spike', openedAt: NOW, triggerRef: 'x' }).run();
  return db;
}

function mockFetch(captured: any[]) {
  return (async (url: any, o: any) => {
    captured.push({ url: String(url), body: JSON.parse(o.body), auth: o.headers?.authorization });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

describe('pushPendingToCardmem', () => {
  it('pushes the cardmem incident once with the contract body + sets pushed_at; scope excludes other projects', async () => {
    const db = seed();
    const captured: any[] = [];
    const n = await pushPendingToCardmem(db, { ...OPTS, fetchFn: mockFetch(captured) });
    expect(n).toBe(1);
    expect(captured.length).toBe(1);
    const { url, body, auth } = captured[0]!;
    expect(url).toBe('https://cardmem.test/api/incidents');
    expect(auth).toBe('Bearer pi_test');
    expect(body.fingerprint).toBe('inc1');
    expect(body.incident_id).toBe('inc1');
    expect(body.source).toBe('upmetrics');
    expect(body.severity).toBe('high');
    expect(body.title).toBe('error spike in cardmem');
    expect(body.github_repo_full_name).toBe('broberg-ai/cardmem');
    expect(body.detail).toContain('src/x.ts');
    expect(body.claim_url).toContain('/api/remediation/inc1/claim?t=');
    expect(db.select().from(schema.incidents).where(eq(schema.incidents.id, 'inc1')).get()!.cardmemPushedAt).not.toBeNull();
  });

  it('is idempotent — a second tick pushes nothing (one card per incident)', async () => {
    const db = seed();
    await pushPendingToCardmem(db, { ...OPTS, fetchFn: mockFetch([]) });
    const n = await pushPendingToCardmem(db, { ...OPTS, fetchFn: mockFetch([]) });
    expect(n).toBe(0);
  });

  it('disabled (no-op) when key is empty', async () => {
    const db = seed();
    const n = await pushPendingToCardmem(db, { ...OPTS, key: '', fetchFn: mockFetch([]) });
    expect(n).toBe(0);
  });

  it('does NOT stamp pushed_at on a non-2xx (retries next tick)', async () => {
    const db = seed();
    const failFetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const n = await pushPendingToCardmem(db, { ...OPTS, fetchFn: failFetch });
    expect(n).toBe(0);
    expect(db.select().from(schema.incidents).where(eq(schema.incidents.id, 'inc1')).get()!.cardmemPushedAt).toBeNull();
  });
});

describe('signed claim token', () => {
  it('roundtrips with the secret + rejects tampering / wrong id / empty secret', () => {
    expect(verifyClaim('inc1', signClaim('inc1', 'sec'), 'sec')).toBe(true);
    expect(verifyClaim('inc1', 'deadbeef', 'sec')).toBe(false);
    expect(verifyClaim('inc1', signClaim('OTHER', 'sec'), 'sec')).toBe(false);
    expect(verifyClaim('inc1', signClaim('inc1', 'sec'), '')).toBe(false); // no secret configured → reject
  });
});
