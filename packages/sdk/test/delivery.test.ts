// F029.1 — retry + loss counter.
//
// These run against the SDK's REAL delivery module with an injected fetch and an
// injected scheduler, not against a stand-in with its own counter. That
// distinction is the whole point: trail hit exactly this trap the same day —
// their first retry test built its own sink with its own counter and PASSED
// after they deleted the real one. A test of your model of the thing is not a
// test of the thing.
import { describe, it, expect, beforeEach } from 'bun:test';
import { deliver, flush, getLostEvents, _queueDepth, _resetDelivery } from '../src/delivery.js';

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

// F029.2 — flush(), so a dying process does not have to guess our retry schedule.
//
// Reported by fd-sundhed with a measurement, and the bug was OURS: their 2s
// send-budget was correct under 0.4.1 (one attempt) and silently stopped
// covering the third attempt when 0.5.0 added retries totalling 6s. Nothing went
// red on their side. A caller must never need to know RETRY_DELAYS_MS exists.
describe('F029.2 flush() waits for outstanding telemetry', () => {
  it('resolves only AFTER the in-flight fetch actually ran', async () => {
    let resolveFetch: ((v: unknown) => void) | null = null;
    let called = false;
    const f = () =>
      new Promise((r) => {
        called = true;
        resolveFetch = r;
      });
    deliver('https://u.test/e', 'body', f as never, now as never);

    // The point of the assertion: not "a call was started" but "the call
    // completed before flush handed control back".
    let flushed = false;
    const p = flush(1_000, f as never).then((r) => {
      flushed = true;
      return r;
    });
    expect(called).toBe(true);
    expect(flushed).toBe(false); // still waiting on the fetch

    resolveFetch!(ok);
    const res = await p;
    expect(flushed).toBe(true);
    expect(res.deliveredDuringFlush).toBe(1);
  });

  // The scheduler NEVER fires. Without skipping the remaining backoff this hangs
  // — which is exactly what a suspending machine experiences.
  it('skips the remaining backoff — a queued retry is attempted immediately', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      return calls === 1 ? fail(503) : ok;
    };
    const never = () => ({});
    deliver('https://u.test/e', 'body', f as never, never as never);
    await settle();
    expect(calls).toBe(1); // parked behind a backoff that will never elapse

    const res = await flush(1_000, f as never);
    expect(calls).toBe(2); // flush drove it without waiting
    expect(res.deliveredDuringFlush).toBe(1);
    expect(res.pending).toBe(0);
  });

  // `lost` = we gave up. `pending` = we ran out of time. Folding the second into
  // the first turns "unknown" into a confident wrong answer at shutdown.
  it('pending is NOT lost: a fetch that never answers times out as pending', async () => {
    const f = () => new Promise(() => {}); // never settles
    deliver('https://u.test/e', 'body', f as never, now as never);

    const res = await flush(50, f as never);
    expect(res.pending).toBeGreaterThan(0);
    expect(res.lost).toBe(0); // nothing was given up on — we just don't know yet
    expect(res.deliveredDuringFlush).toBe(0);
  });

  it('and a genuinely permanent failure IS lost, not pending', async () => {
    const f = async () => fail(400);
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    const res = await flush(200, f as never);
    expect(res.lost + getLostEvents()).toBeGreaterThan(0);
    expect(res.pending).toBe(0);
  });

  it('an empty queue flushes instantly with zeros — measured, not defaulted', async () => {
    const res = await flush(1_000, (async () => ok) as never);
    expect(res).toEqual({ ok: true, deliveredDuringFlush: 0, lost: 0, pending: 0 });

    // The same call on a NON-empty queue must not produce zeros, or the test
    // above proves nothing.
    deliver('https://u.test/e', 'body', (async () => ok) as never, now as never);
    const res2 = await flush(1_000, (async () => ok) as never);
    expect(res2.deliveredDuringFlush).toBe(1);
  });

  it('never throws — fetch that throws, a 500, and a throw from inside the flush', async () => {
    for (const f of [
      async () => {
        throw new Error('boom');
      },
      async () => fail(500),
    ]) {
      _resetDelivery();
      deliver('https://u.test/e', 'b', f as never, now as never);
      await expect(flush(100, f as never)).resolves.toBeDefined();
    }

    _resetDelivery();
    let n = 0;
    const throwsOnRetry = async () => {
      n += 1;
      if (n === 1) return fail(503);
      throw new Error('boom during flush');
    };
    const never2 = () => ({});
    deliver('https://u.test/e', 'b', throwsOnRetry as never, never2 as never);
    await settle();
    await expect(flush(200, throwsOnRetry as never)).resolves.toBeDefined();
  });
});

// Found by mutation, not by design: replacing `immediate` with a never-firing
// scheduler left all 16 tests green, because flush()'s loop re-claims the queue
// each pass. So the skip is NOT what `immediate` protects. What it protects is
// the state AFTER a flush — the drain chain has to complete, or `draining` stays
// true forever and every later deliver() enqueues into a queue nothing drains.
// A telemetry client that goes quiet after one shutdown flush would be a silent
// failure of exactly the kind this whole card exists to remove.
describe('F029.2 a flush leaves the client usable', () => {
  it('normal delivery still works after a flush that drove a queued retry', async () => {
    const never = () => ({});
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      return calls === 1 ? fail(503) : ok;
    };
    deliver('https://u.test/e', 'first', flaky as never, never as never);
    await settle();
    await flush(500, flaky as never);

    // Now a fresh event, again with a scheduler that never fires. It must be
    // ATTEMPTED — if the drain chain were stuck, this never leaves the queue.
    let later = 0;
    const f2 = async () => {
      later += 1;
      return ok;
    };
    deliver('https://u.test/e', 'second', f2 as never, never as never);
    await settle();
    expect(later).toBe(1);

    // And a failing one must still reach flush afterwards.
    let third = 0;
    const f3 = async () => {
      third += 1;
      return third === 1 ? fail(503) : ok;
    };
    deliver('https://u.test/e', 'third', f3 as never, never as never);
    await settle();
    const res = await flush(500, f3 as never);
    expect(third).toBe(2);
    expect(res.deliveredDuringFlush).toBe(1);
  });
});

// The defect the mutation hunt actually turned up: flush() claims the parked
// entry, which kills the drain chain — but `draining` stayed true, so afterwards
// enqueue() never started a new one. Every later failed delivery would sit in
// the queue retrying never, until some future flush happened to rescue it.
describe('F029.2 retrying still works ON ITS OWN after a flush', () => {
  it('a delivery that fails AFTER a flush is retried without another flush', async () => {
    const never = () => ({});
    const flaky = async () => fail(503);
    deliver('https://u.test/e', 'parks-one', flaky as never, never as never);
    await settle();
    await flush(300, flaky as never); // claims the parked entry

    // Now a normal failing delivery with a scheduler that DOES fire. Nothing
    // flushes it — the client must drive its own retry.
    let calls = 0;
    const f = async () => {
      calls += 1;
      return calls === 1 ? fail(503) : ok;
    };
    deliver('https://u.test/e', 'after', f as never, now as never);
    await settle();

    expect(calls).toBe(2); // it retried by itself
    expect(_queueDepth()).toBe(0);
  });
});

// F029.3 — the trap fd-sundhed found in an API one hour old.
//
// `deliveredDuringFlush` counts what the FLUSH did. A send that succeeded on its
// first attempt was already counted before flush() ran, so the delta is 0 in
// exactly the healthy case — and `delivered > 0`, the natural reading of the old
// name, reported failure on every successful alarm. A false negative on the
// happy path. These tests pin the trap itself, not just the rename: without the
// first one, "the field got a longer name" would look like a fix.
describe('F029.3 ok is the predicate; the delta is not', () => {
  it('a delivery that SUCCEEDED before flush leaves the delta at 0 — and ok true', async () => {
    const f = async () => ok;
    deliver('https://u.test/e', 'body', f as never, now as never);
    await settle();

    const res = await flush(500, f as never);
    expect(res.deliveredDuringFlush).toBe(0); // the trap, asserted head-on
    expect(res.ok).toBe(true); // and the field a caller should read
  });

  it('ok is false when something was LOST', async () => {
    const f = async () => fail(400);
    deliver('https://u.test/e', 'body', f as never, now as never);
    const res = await flush(300, f as never);
    expect(res.lost).toBeGreaterThan(0);
    expect(res.ok).toBe(false);
  });

  it('ok is false when something is still PENDING — not only when it is lost', async () => {
    const f = () => new Promise(() => {}); // never settles
    deliver('https://u.test/e', 'body', f as never, now as never);
    const res = await flush(50, f as never);
    expect(res.lost).toBe(0); // nothing given up on
    expect(res.pending).toBeGreaterThan(0);
    expect(res.ok).toBe(false); // still not "it worked"
  });

  it('ok is false when BOTH happened', async () => {
    const dead = async () => fail(400);
    deliver('https://u.test/e', 'lost-one', dead as never, now as never);
    const hang = () => new Promise(() => {});
    deliver('https://u.test/e', 'pending-one', hang as never, now as never);
    const res = await flush(50, hang as never);
    expect(res.lost).toBeGreaterThan(0);
    expect(res.pending).toBeGreaterThan(0);
    expect(res.ok).toBe(false);
  });
});
