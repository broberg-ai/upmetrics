// F029.1 — a telemetry send that fails must not vanish silently.
//
// Until this existed the SDK did `void fetch(url, {...}).catch(() => {})`: one
// attempt, no retry, no counter, and `res.ok` was never read — so a 500 from the
// server was indistinguishable from a successful delivery. Nothing threw, so
// nothing was noticed.
//
// The cost is not symmetric with a normal dropped request. This client carries
// ERROR events, and it fails precisely when Upmetrics is down or slow — so the
// events we lose are exactly the ones from the window where something was wrong.
// The error tracker goes blind during its own outage, which is the outage we
// have actually had (30 July – 2 Aug, /data 100% full, three days).
//
// Retrying is only safe because the receiving end is idempotent: `events.id` IS
// the sender's `event_id`, it is the primary key, and the insert is
// `.onConflictDoNothing()`. A re-delivered error cannot become two. Without that
// this module would trade "we lose measurements" for "we double-count", which is
// not an improvement.

/** Attempt 1 is immediate; these are the waits before attempts 2 and 3. */
const RETRY_DELAYS_MS = [1_000, 5_000];

/**
 * Hard ceiling on queued retries. An UNBOUNDED queue inside a process that
 * cannot reach its server is a memory leak waiting for an outage — and this
 * library is not allowed to be the thing that takes the host app down. On
 * overflow the OLDEST entry is dropped: during an incident the earliest events
 * are the ones nearest the cause, but a bounded queue that keeps them would have
 * to drop the newest forever, which hides an ongoing failure. Dropping the
 * oldest keeps the queue moving and keeps the loss counted.
 */
const MAX_QUEUE = 30;

export interface Pending {
  url: string;
  body: string;
  attempt: number; // 0 = the first retry is next
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>;
type ScheduleLike = (fn: () => void, ms: number) => unknown;

const queue: Pending[] = [];
let lostEvents = 0;
let deliveredEvents = 0;
let draining = false;

// F029.2 — every attempt currently in the air. flush() awaits these; deliver()
// stays fire-and-forget for everyone who does not care.
const inFlight = new Set<Promise<void>>();

// F029.2 — the ONE entry drain() has pulled out of the queue and is holding
// while its backoff elapses. It has to live somewhere flush() can see: without
// this it was invisible to both the queue and the in-flight set, so a shutdown
// flush silently skipped the very retry it existed to drive. Found by the test,
// not by reading the code.
let parked: Pending | null = null;

/**
 * Events this client gave up on: the queue overflowed, or every attempt failed.
 *
 * A number that is only ever zero is not a measurement. Read it together with
 * whether anything was ever sent — "0 after a failed delivery" and "0 because
 * nothing was ever sent" are different facts, and the tests assert both.
 */
export function getLostEvents(): number {
  return lostEvents;
}

/**
 * Test seam only. Exposes the invariant that matters — the queue is BOUNDED —
 * so a test can assert it directly instead of inferring it from an eviction
 * count. Note that one entry can be in flight OUTSIDE the queue while a retry
 * is pending, so depth alone does not account for everything retained.
 */
export function _queueDepth(): number {
  return queue.length;
}

/** Test seam only — never called by the SDK itself. */
export function _resetDelivery(): void {
  queue.length = 0;
  lostEvents = 0;
  deliveredEvents = 0;
  draining = false;
  parked = null;
  inFlight.clear();
}

export interface FlushResult {
  /** Attempts that reached the server with an ok response. */
  delivered: number;
  /** Events given up on: a permanent status, attempts exhausted, or evicted. */
  lost: number;
  /**
   * Still queued or in the air when the deadline passed.
   *
   * This is deliberately NOT folded into `lost`, and the distinction is the
   * whole reason the field exists: `lost` means WE GAVE UP, `pending` means WE
   * DO NOT KNOW. A shutdown that reports 3 lost when it actually ran out of time
   * is a worse answer than one that says so.
   */
  pending: number;
}

/**
 * F029.2 — wait for outstanding telemetry before the process dies.
 *
 * `deliver()` is fire-and-forget, which is right for a long-lived server and
 * wrong for anything that stops: a Fly machine that suspends the moment its cron
 * route answers kills whatever was still in the air. Without this, a consumer
 * has to keep the process alive on a magic number that matches OUR retry
 * schedule — and fd-sundhed measured exactly that breaking when 0.5.0 added
 * retries: their 2s budget, correct under 0.4.1, silently stopped covering the
 * third attempt. Nothing went red. The whole point of this function is that a
 * caller never has to know `RETRY_DELAYS_MS` exists.
 *
 * REMAINING BACKOFF IS SKIPPED. Waiting out a 5-second pause is pointless when
 * the process is shutting down, so queued entries are attempted immediately.
 * `timeoutMs` is then purely the caller's own answer to "how long am I willing
 * to wait", not a guess at our internals.
 *
 * Never throws. Never outlives `timeoutMs`.
 */
export async function flush(timeoutMs = 5_000, fetchImpl?: FetchLike): Promise<FlushResult> {
  const startedDelivered = deliveredEvents;
  const startedLost = lostEvents;
  const impl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      // Claiming the parked entry kills the drain chain that was waiting on it,
      // so the flag it set has to come down with it. Left true, `enqueue` stops
      // starting a drain — and every later failed delivery would sit in the
      // queue until the NEXT flush, retrying on its own never again. A telemetry
      // client that quietly stops retrying after one shutdown flush is the same
      // silent failure this card exists to remove.
      const claimed = parked;
      parked = null;
      if (claimed) draining = false;
      const pendingNow = queue.splice(0, queue.length);
      if (claimed) pendingNow.unshift(claimed);
      const runners = pendingNow.map((p) => track(attempt({ ...p, attempt: p.attempt + 1 }, impl, immediate)));
      const outstanding = [...inFlight, ...runners];
      if (outstanding.length === 0) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await Promise.race([Promise.allSettled(outstanding), sleep(left)]);
    }
  } catch {
    // A flush must never become the reason a shutdown fails.
  }

  return {
    delivered: deliveredEvents - startedDelivered,
    lost: lostEvents - startedLost,
    pending: queue.length + inFlight.size + (parked ? 1 : 0),
  };
}

/**
 * Runs a scheduled callback now, so a retry raised INSIDE flush() does not sit
 * out a backoff while the process is shutting down.
 *
 * Honest about its own weight: this is belt-and-braces, not the guarantee.
 * Neutering it to a no-op leaves every test green, because flush()'s loop
 * re-claims the queue on the next pass anyway — measured, not assumed. Kept for
 * the latency (one fewer pass inside a deadline the caller chose) and because it
 * states the intent at the point where a reader would otherwise wonder which
 * scheduler applies. If you are relying on it for correctness, you are relying
 * on the wrong thing: the loop is what makes the skip work.
 */
const immediate: ScheduleLike = (fn) => {
  fn();
  return null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (t && typeof (t as unknown as { unref?: () => void }).unref === 'function') {
      (t as unknown as { unref: () => void }).unref();
    }
  });
}

function track(p: Promise<void>): Promise<void> {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/**
 * Most 4xx are the SENDER's own mistake — a bad DSN, a malformed envelope, a
 * rejected status. Re-sending one fails identically forever and hammers a server
 * that may already be struggling.
 *
 * TWO 4xx ARE THE EXCEPTION, and missing them was a real bug in 0.5.0:
 *
 * - **429 Too Many Requests.** Upmetrics' own ingest answers 429 when a project
 *   trips its rolling per-minute rate limit (`guardIngest` → `ingest/routes.ts`).
 *   That is temporary BY CONSTRUCTION — the window rolls — and it fires during a
 *   burst, which is exactly when the events matter. Treating it as permanent
 *   dropped precisely the flood we were trying to capture.
 * - **408 Request Timeout.** A timeout says the request RAN OUT — it does not
 *   say the server declined to process it. So a retry after 408 can genuinely
 *   duplicate. It is safe HERE, and only here, because the receiver is always an
 *   Upmetrics ingest (this client cannot be pointed anywhere else) and that
 *   ingest keys `events.id` on the sender's own `event_id` with
 *   `.onConflictDoNothing()`. The duplicate is absorbed.
 *
 * DO NOT COPY THIS LIST WITHOUT THAT PRECONDITION. `components` made the point
 * with their own package: `@broberg/sms` deliberately does NOT retry 408,
 * because there a duplicate is a second real SMS to a real phone, billed, read
 * by an annoyed human. Same status code, opposite correct decision. The rule is
 * not "429 + 5xx + 408" — it is *what provably did not run, plus what the
 * receiver can deduplicate*, and the second half is a property of the
 * deployment, not of HTTP. (429 needs no such argument: a refusal on a rate
 * limit means the call never executed, so there is nothing to duplicate.)
 *
 * Found by the Discovery reuse check rather than by a test: `@broberg/sms`
 * 0.10.0 already classifies retryable (429, 5xx) against permanent (400/401/
 * 403/404/422), and comparing our rule to theirs is what exposed it. The fleet
 * has no shared retry primitive to adopt, so the classification is borrowed even
 * though the code cannot be.
 */
function isRetryable(status: number | null): boolean {
  if (status === null) return true; // the fetch threw: network, DNS, abort
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Deliver one envelope. Never throws, never returns a rejected promise —
 * telemetry must not be able to break the host app.
 */
export function deliver(url: string, body: string, fetchImpl: FetchLike, schedule: ScheduleLike = setTimeout): void {
  void track(attempt({ url, body, attempt: 0 }, fetchImpl, schedule));
}

async function attempt(p: Pending, fetchImpl: FetchLike, schedule: ScheduleLike): Promise<void> {
  let status: number | null = null;
  try {
    const res = await fetchImpl(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body: p.body,
      keepalive: true,
    });
    // Reading res.ok is half the fix on its own: without it a 500 and a
    // successful delivery produce the same outcome here, because only a THROW
    // was ever caught.
    if (res && res.ok) {
      deliveredEvents += 1;
      return;
    }
    status = res ? res.status : null;
  } catch {
    status = null; // threw → treat as a network failure
  }

  if (!isRetryable(status) || p.attempt >= RETRY_DELAYS_MS.length) {
    lostEvents += 1;
    return;
  }
  enqueue(p, schedule, fetchImpl);
}

function enqueue(p: Pending, schedule: ScheduleLike, fetchImpl: FetchLike): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    lostEvents += 1;
  }
  queue.push(p);
  if (!draining) drain(schedule, fetchImpl);
}

function drain(schedule: ScheduleLike, fetchImpl: FetchLike): void {
  const next = queue.shift();
  if (!next) {
    draining = false;
    return;
  }
  draining = true;
  parked = next;
  const wait = RETRY_DELAYS_MS[next.attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  const t = schedule(() => {
    // flush() may have claimed it in the meantime. Sending it twice here would
    // be a duplicate WE created, which is the one thing retry must not add.
    if (parked !== next) return;
    parked = null;
    void track(attempt({ ...next, attempt: next.attempt + 1 }, fetchImpl, schedule)).then(() => drain(schedule, fetchImpl));
  }, wait);
  // Don't hold a Node/Bun process open just to retry telemetry.
  if (t && typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
}
