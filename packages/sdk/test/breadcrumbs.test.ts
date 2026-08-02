// F025.4 — breadcrumb payload amplification + the beforeSend valve.
// Lives outside src/ so tsc (rootDir:src) never compiles it into dist.
//
// The bug this seals: the breadcrumb buffer is scope-GLOBAL and was attached to
// EVERY event with a hardcoded 50-entry cap. In a flood those 50 slots fill with
// the SAME repeated error, so each event carries ~50 redundant copies of its own
// neighbours — self-reinforcing: the worse the flood, the fatter each event.
// Measured fallout (2026-07-05): 163,051 events × ~3.4 KB = 552 MB, which was
// 96% of the entire server database and filled its 1 GB disk.
// Run: bun test test/breadcrumbs.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { init, addBreadcrumb, captureException, captureMessage } from '../src/index';

const DSN = 'https://pub@upmetrics.org/proj';
const APP_URL = 'https://peer.example/relay';

interface Rec {
  envelopes: string[];
  events(): Array<Record<string, any>>;
}

// Stub fetch: record our own envelope POSTs; fail any app fetch so the
// auto-instrument catch path fires.
function setup(opts: Partial<Parameters<typeof init>[0]> = {}, appError: unknown = new Error('boom')): Rec {
  const envelopes: string[] = [];
  const g = globalThis as any;
  g.fetch = async (url: any, o: any) => {
    const u = typeof url === 'string' ? url : (url?.url ?? '');
    if (u.includes('/envelope/')) {
      envelopes.push(String(o?.body ?? ''));
      return new Response(null, { status: 200 });
    }
    throw appError;
  };
  g.__upmetricsFetchWrapped = false;
  g.__upmetricsInitSent = false;
  init({ dsn: DSN, autoInstrument: true, ...opts });
  return {
    envelopes,
    // envelope = 3 newline-separated JSON lines; the event is the last.
    events: () =>
      envelopes.map((b) => {
        const lines = b.split('\n');
        return JSON.parse(lines[lines.length - 1]!);
      }),
  };
}

beforeEach(() => {
  const g = globalThis as any;
  g.__upmetricsFetchWrapped = false;
  g.__upmetricsInitSent = false;
});

describe('F025.4 — breadcrumb cap', () => {
  it('defaults to 10, not the old hardcoded 50', () => {
    const r = setup();
    for (let i = 0; i < 40; i++) addBreadcrumb({ message: `distinct-${i}` });
    captureException(new Error('real failure'));

    const ev = r.events().find((e) => e.exception)!;
    expect(ev.breadcrumbs.length).toBe(10);
    // Keeps the MOST RECENT — the ones nearest the failure are the useful ones.
    expect(ev.breadcrumbs[9].message).toBe('distinct-39');
    expect(ev.breadcrumbs[0].message).toBe('distinct-30');
  });

  it('honours an explicit maxBreadcrumbs', () => {
    const r = setup({ maxBreadcrumbs: 3 });
    for (let i = 0; i < 20; i++) addBreadcrumb({ message: `m-${i}` });
    captureException(new Error('x'));

    expect(r.events().find((e) => e.exception)!.breadcrumbs.length).toBe(3);
  });

  it('maxBreadcrumbs: 0 drops the trail entirely', () => {
    const r = setup({ maxBreadcrumbs: 0 });
    for (let i = 0; i < 10; i++) addBreadcrumb({ message: `m-${i}` });
    captureException(new Error('x'));

    expect(r.events().find((e) => e.exception)!.breadcrumbs).toBeUndefined();
  });

  it('collapses repeats of the same crumb into one entry with a count', () => {
    // The flood shape: the same line over and over. Without this the trail is
    // N identical copies, which is where the ×7 payload bloat came from.
    const r = setup();
    for (let i = 0; i < 25; i++) addBreadcrumb({ message: 'HTTP 502 on https://buddycloud.cc/api/x' });
    captureException(new Error('x'));

    const crumbs = r.events().find((e) => e.exception)!.breadcrumbs;
    expect(crumbs.length).toBe(1); // 25 identical → ONE
    expect(crumbs[0].count).toBe(25); // occurrences preserved, bytes not
  });

  it('does not collapse crumbs that merely look similar', () => {
    const r = setup();
    addBreadcrumb({ message: 'a' });
    addBreadcrumb({ message: 'b' });
    addBreadcrumb({ message: 'a' });
    captureException(new Error('x'));

    expect(r.events().find((e) => e.exception)!.breadcrumbs.length).toBe(3);
  });
});

describe('F025.4 — auto-captured events carry no trail', () => {
  it('an auto-captured 5xx attaches NO breadcrumbs — this is the flood shape', async () => {
    // Uses the deterministic 5xx auto-capture path (a thrown transient fetch
    // error is benign-by-default since 0.3.0 and rate-sampled, which would make
    // this test flaky for the wrong reason). "HTTP 502 on <url>" repeated 163k
    // times IS the event that filled the disk.
    const envelopes: string[] = [];
    const g = globalThis as any;
    g.fetch = async (url: any, o: any) => {
      const u = typeof url === 'string' ? url : (url?.url ?? '');
      if (u.includes('/envelope/')) {
        envelopes.push(String(o?.body ?? ''));
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 502 }); // app endpoint is failing
    };
    g.__upmetricsFetchWrapped = false;
    g.__upmetricsInitSent = false;
    init({ dsn: DSN, autoInstrument: true });

    for (let i = 0; i < 5; i++) addBreadcrumb({ message: `noise-${i}` });
    await g.fetch(APP_URL, { method: 'POST' });

    const events = envelopes.map((b) => {
      const lines = b.split('\n');
      return JSON.parse(lines[lines.length - 1]!);
    });
    const auto = events.filter((e) => String(e.message ?? '').startsWith('HTTP 502'));
    expect(auto.length).toBeGreaterThan(0);
    for (const e of auto) expect(e.breadcrumbs).toBeUndefined();
  });

  it('a MANUAL captureException still gets its trail (context that actually helps)', () => {
    const r = setup();
    addBreadcrumb({ message: 'user clicked save' });
    captureException(new Error('save failed'));

    const ev = r.events().find((e) => e.exception)!;
    expect(ev.breadcrumbs.length).toBe(1);
    expect(ev.breadcrumbs[0].message).toBe('user clicked save');
  });

  it('a MANUAL captureMessage still gets its trail', () => {
    const r = setup();
    addBreadcrumb({ message: 'ctx' });
    captureMessage('deliberate note', 'warning');

    const ev = r.events().find((e) => e.message === 'deliberate note')!;
    expect(ev.breadcrumbs.length).toBe(1);
  });
});

describe('F025.4 — beforeSend valve', () => {
  it('lets a consumer veto an event entirely', () => {
    const r = setup({ beforeSend: (e) => (String(e.message).includes('drop me') ? null : e) });
    captureMessage('drop me please', 'warning');
    captureMessage('keep me', 'warning');

    const msgs = r.events().map((e) => e.message);
    expect(msgs).not.toContain('drop me please');
    expect(msgs).toContain('keep me');
  });

  it('lets a consumer trim the payload themselves', () => {
    const r = setup({
      beforeSend: (e) => ({ ...e, breadcrumbs: undefined }),
    });
    addBreadcrumb({ message: 'ctx' });
    captureException(new Error('x'));

    expect(r.events().find((e) => e.exception)!.breadcrumbs).toBeUndefined();
  });

  it('a throwing hook never breaks capture — the event still sends', () => {
    // Telemetry must never be the thing that takes the host app down.
    const r = setup({
      beforeSend: () => {
        throw new Error('consumer bug');
      },
    });
    captureMessage('still gets through', 'warning');

    expect(r.events().map((e) => e.message)).toContain('still gets through');
  });
});
