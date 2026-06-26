// Transient-network benign-by-default + denyUrls (v0.3.0). Exercises the
// auto-instrument fetch wrapper directly. Run: bun test test/transient-network.test.ts
// Lives outside src/ so tsc (rootDir:src) never compiles it into dist.
import { describe, it, expect, beforeEach } from 'bun:test';
import { init } from '../src/index';

const DSN = 'https://pub@upmetrics.org/proj';
const APP_URL = 'https://peer.example/relay'; // an outbound app fetch (NOT our ingest)

interface Recorder {
  envelopes: string[];
  errorEnvelopes(): string[]; // those carrying an 'error'-level event (an issue)
}

// Build a stub `fetch` that: records our own envelope POSTs, and for any other
// (app) URL throws `appError` to drive the wrapper's catch path. Then init() so
// the wrapper installs around this stub.
function setup(appError: unknown, opts: Partial<Parameters<typeof init>[0]> = {}): Recorder {
  const envelopes: string[] = [];
  const stub = async (url: any, o: any) => {
    const u = typeof url === 'string' ? url : (url?.url ?? '');
    if (u.includes('/envelope/')) {
      envelopes.push(String(o?.body ?? ''));
      return new Response(null, { status: 200 });
    }
    throw appError; // simulate the app's transient outbound fetch failing
  };
  const g = globalThis as any;
  g.fetch = stub;
  g.__upmetricsFetchWrapped = false; // force re-wrap around THIS stub
  g.__upmetricsInitSent = false; // re-emit a fresh startup message
  init({ dsn: DSN, autoInstrument: true, ...opts });
  return { envelopes, errorEnvelopes: () => envelopes.filter((b) => b.includes('"level":"error"')) };
}

async function callApp(): Promise<unknown> {
  try {
    await (globalThis as any).fetch(APP_URL, { method: 'POST' });
    return null;
  } catch (e) {
    return e; // wrapper re-throws — the app still sees its own error
  }
}

beforeEach(() => {
  (globalThis as any).__upmetricsInitSent = false;
});

describe('transient fetch failures are benign-by-default (no consumer config)', () => {
  it('a TimeoutError (AbortSignal.timeout) is NOT captured as an error issue', async () => {
    const e = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    const rec = setup(e);
    const thrown = await callApp();
    expect((thrown as Error).name).toBe('TimeoutError'); // app still sees the throw
    expect(rec.errorEnvelopes().length).toBe(0); // …but no error-issue was sent
  });

  it("Node's `TypeError: fetch failed` (cause ECONNREFUSED) is NOT captured", async () => {
    const e = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }),
    });
    const rec = setup(e);
    await callApp();
    expect(rec.errorEnvelopes().length).toBe(0);
  });

  it('an AbortError is NOT captured', async () => {
    const e = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const rec = setup(e);
    await callApp();
    expect(rec.errorEnvelopes().length).toBe(0);
  });

  it('a GENUINE app error (no network signature) IS still captured — not a blanket mute', async () => {
    const rec = setup(new Error('totally real logic bug'));
    await callApp();
    expect(rec.errorEnvelopes().length).toBe(1);
  });
});

describe('denyUrls scopes auto-capture off for known-transient endpoints', () => {
  it('a non-benign error on a denyUrls endpoint is NOT captured', async () => {
    const rec = setup(new Error('totally real logic bug'), { denyUrls: ['peer.example/relay'] });
    await callApp();
    expect(rec.errorEnvelopes().length).toBe(0);
  });

  it('the SAME error on a non-denied URL still IS captured', async () => {
    const rec = setup(new Error('totally real logic bug'), { denyUrls: ['some.other.host'] });
    await callApp();
    expect(rec.errorEnvelopes().length).toBe(1);
  });
});
