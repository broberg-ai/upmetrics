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
let draining = false;

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
  draining = false;
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
 * - **408 Request Timeout.** A transport-level timeout, not a bad request.
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
  void attempt({ url, body, attempt: 0 }, fetchImpl, schedule);
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
    if (res && res.ok) return;
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
  const wait = RETRY_DELAYS_MS[next.attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  const t = schedule(() => {
    void attempt({ ...next, attempt: next.attempt + 1 }, fetchImpl, schedule).then(() => drain(schedule, fetchImpl));
  }, wait);
  // Don't hold a Node/Bun process open just to retry telemetry.
  if (t && typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
}
