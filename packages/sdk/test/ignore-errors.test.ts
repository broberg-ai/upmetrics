// ignoreErrors filter (v0.2.0). Run: bun test test/ignore-errors.test.ts
// Lives outside src/ so tsc (rootDir:src) never compiles it into dist.
import { describe, it, expect, beforeEach } from 'bun:test';
import { init, captureException, captureMessage } from '../src/index';

const DSN = 'https://pub@upmetrics.org/proj';

// Spy on the envelope POST. init() with autoInstrument:false leaves global
// fetch untouched, so the only calls are our own send() envelopes.
function spyFetch(): { count: number; bodies: string[] } {
  const stat = { count: 0, bodies: [] as string[] };
  (globalThis as any).fetch = async (_url: any, opts: any) => {
    stat.count++;
    stat.bodies.push(String(opts?.body ?? ''));
    return new Response(null, { status: 200 });
  };
  return stat;
}

beforeEach(() => {
  // init() guards a one-time startup message per JS context; clear it so each
  // test gets a fresh init + predictable send count.
  (globalThis as any).__upmetricsInitSent = false;
});

describe('ignoreErrors', () => {
  it('drops a captureException whose "name: message" matches a string entry (case-insensitive substring)', () => {
    init({ dsn: DSN, autoInstrument: false, ignoreErrors: ['capacitorDidRegisterForRemoteNotifications'] });
    const spy = spyFetch();
    const id = captureException(new Error('CapacitorDidRegisterForRemoteNotifications not called'));
    expect(id).toBeNull();
    expect(spy.count).toBe(0);
  });

  it('drops a captureMessage matching a RegExp entry', () => {
    init({ dsn: DSN, autoInstrument: false, ignoreErrors: [/not called$/] });
    const spy = spyFetch();
    expect(captureMessage('capacitorDidRegisterForRemoteNotifications not called', 'error')).toBeNull();
    expect(spy.count).toBe(0);
  });

  it('lets a non-matching error through (filter is opt-in, not a blanket mute)', () => {
    init({ dsn: DSN, autoInstrument: false, ignoreErrors: ['benign noise'] });
    const spy = spyFetch();
    const id = captureException(new Error('TypeError: real bug'));
    expect(id).not.toBeNull();
    expect(spy.count).toBe(1);
  });

  it('no ignoreErrors configured → nothing is filtered', () => {
    init({ dsn: DSN, autoInstrument: false });
    const spy = spyFetch();
    expect(captureException(new Error('anything'))).not.toBeNull();
    expect(spy.count).toBe(1);
  });

  it('an empty-string entry never matches (would otherwise mute everything)', () => {
    init({ dsn: DSN, autoInstrument: false, ignoreErrors: [''] });
    const spy = spyFetch();
    expect(captureException(new Error('still sent'))).not.toBeNull();
    expect(spy.count).toBe(1);
  });
});
