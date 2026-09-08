// F029.1 — retry + loss counter.
//
// These run against the SDK's REAL delivery module with an injected fetch and an
// injected scheduler, not against a stand-in with its own counter. That
// distinction is the whole point: trail hit exactly this trap the same day —
// their first retry test built its own sink with its own counter and PASSED
// after they deleted the real one. A test of your model of the thing is not a
// test of the thing.
import { describe, it, expect, beforeEach } from 'bun:test';
import { deliver, getLostEvents, _queueDepth, _resetDelivery } from '../src/delivery.js';

// A scheduler that runs the callback immediately, so a test never waits out a
// real backoff. Returns a plain object so the unref() guard is exercised too.
const now = (fn: () => void) => {
  fn();
  return {};
};

const ok = { ok: true, status: 200 };
const fail = (status: number) => ({ ok: false, status });

/** Wait for the module's promise chain to settle — no timers involved. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => _resetDelivery());

describe('F029.1 a failed delivery is retried', () => {
  it('retries a network failure and succeeds on the second attempt — nothing counted lost', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      return ok;
    };
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(calls).toBe(2); // it actually tried again
    expect(getLostEvents()).toBe(0);
  });

  it('a 5xx is retried', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return calls === 1 ? fail(503) : ok;
    };
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(calls).toBe(2);
    expect(getLostEvents()).toBe(0);
  });

  // THE NEGATIVE CONTROL. Without it, "retry works" cannot be told apart from
  // "retry always tries again" — and the second is worse than no retry at all:
  // a bad DSN would hammer the server forever, failing identically every time.
  it('a 4xx is NEVER retried, and is counted as lost', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return fail(400);
    };
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(calls).toBe(1); // exactly one attempt
    expect(getLostEvents()).toBe(1);
  });

  // 0.5.0 got this wrong: `status >= 500` treated a 429 as permanent. Our OWN
  // ingest answers 429 when a project trips its rolling rate limit — temporary by
  // construction, and fired during a burst, i.e. exactly when the events matter.
  it('a 429 IS retried — our own ingest returns it when rate-limited', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return calls === 1 ? fail(429) : ok;
    };
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(calls).toBe(2);
    expect(getLostEvents()).toBe(0);
  });

  it('a 408 request-timeout IS retried — transport, not a bad request', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return calls === 1 ? fail(408) : ok;
    };
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(calls).toBe(2);
    expect(getLostEvents()).toBe(0);
  });

  // The exception must stay NARROW. If 429/408 quietly widened into "retry every
  // 4xx", the negative control above would be the only thing left holding the
  // line — so assert the neighbours explicitly.
  it('the other 4xx are still permanent: 401, 403, 404, 422', async () => {
    for (const status of [401, 403, 404, 422]) {
      _resetDelivery();
      let calls = 0;
      const f = async () => {
        calls += 1;
        return fail(status);
      };
      deliver('https://u.test/e', 'body', f as never, now as never);
      await settle();
      expect(calls).toBe(1);
      expect(getLostEvents()).toBe(1);
    }
  });

  it('reads res.ok — a 500 is a FAILED delivery, not a silent success', async () => {
    // The old code only caught a THROW, so this response counted as delivered.
    let calls = 0;
    const f = async () => {
      calls += 1;
      return fail(500);
    };
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(calls).toBe(3); // first attempt + both retries
    expect(getLostEvents()).toBe(1); // and then given up on, visibly
  });
});

describe('F029.1 the queue is bounded and the loss is visible', () => {
  it('never grows past the cap, and every dropped event is counted', async () => {
    // Every send fails forever, so each one wants to sit in the queue. With a
    // cap of 30 and 100 events, the excess must be dropped AND counted — an
    // unbounded queue here is a memory leak that only appears during an outage.
    const f = async () => {
      throw new Error('down');
    };
    // A scheduler that never fires: entries stay queued, which is the state the
    // cap has to survive.
    const never = () => ({});
    for (let i = 0; i < 100; i++) deliver('https://u.test/e', `body${i}`, f as never, never as never);
    await settle();

    // The invariant, asserted directly rather than inferred from a magic number:
    // the queue is BOUNDED, and nothing that left it did so silently.
    const depth = _queueDepth();
    expect(depth).toBeLessThanOrEqual(30);

    // Every event is accounted for exactly once. The `+ 1` is a real thing, not
    // a fudge: one entry is pulled OUT of the queue and held in flight while its
    // retry is pending, so it is retained without being queued. Writing it out
    // is the difference between an assertion that checks the books balance and
    // one that was tuned until it passed.
    const inFlight = 1;
    expect(getLostEvents() + depth + inFlight).toBe(100);
    expect(getLostEvents()).toBe(69);
  });

  it('zero-after-a-failure and zero-without-any-send are different facts', async () => {
    // A counter that is always zero is a default, not a measurement. Prove it
    // can move, in the same test that proves it starts still.
    expect(getLostEvents()).toBe(0); // nothing sent at all

    const f = async () => fail(400);
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    expect(getLostEvents()).toBe(1); // it moved
  });
});

describe('F029.1 telemetry never breaks the host app', () => {
  it('does not throw on any failure path', async () => {
    const paths: Array<() => unknown> = [
      () => deliver('https://u.test/e', 'b', (async () => { throw new Error('boom'); }) as never, now as never),
      () => deliver('https://u.test/e', 'b', (async () => fail(500)) as never, now as never),
      () => deliver('https://u.test/e', 'b', (async () => fail(400)) as never, now as never),
      // Throws on the SECOND attempt, i.e. from inside the retry path itself.
      () => {
        let n = 0;
        const f = async () => {
          n += 1;
          if (n === 1) return fail(503);
          throw new Error('boom on retry');
        };
        return deliver('https://u.test/e', 'b', f as never, now as never);
      },
    ];
    for (const p of paths) {
      expect(() => p()).not.toThrow();
      await settle();
    }
  });
});
