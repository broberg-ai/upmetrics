// Event-loop lag gauge (F008 circuit breaker, done right).
//
// bun:sqlite is synchronous: one slow query blocks the ENTIRE event loop. The
// original circuit breaker tried to detect this by timing /health's own handler
// body — which measures nothing, because the lag happens in the queue BEFORE the
// handler runs, not during it. The only way to detect loop pressure is a timer
// that notices it fired late: schedule every SAMPLE_MS, and the amount it overran
// its schedule IS the event-loop lag.
//
// We keep an exponentially-decaying max so a stall is visible on the NEXT
// readiness check (the timer fires late once the block clears) and then recovers
// on its own over a few samples — no manual reset, no stuck-degraded state.

const SAMPLE_MS = 1000;
const DECAY = 0.5; // halve the tracked max each clean sample → recover in a few s

// Exported pure step so the decay/recovery behaviour is unit-testable without
// real timers: given the previous tracked max and a fresh lag sample, return the
// new tracked max.
export function nextTrackedLag(prev: number, sampleLagMs: number): number {
  return Math.max(Math.max(0, sampleLagMs), prev * DECAY);
}

let trackedLagMs = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function startLagGauge(): void {
  if (timer) return;
  let last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - SAMPLE_MS; // overrun = how late the timer fired
    last = now;
    trackedLagMs = nextTrackedLag(trackedLagMs, lag);
  }, SAMPLE_MS);
  // Never keep the process alive just for this gauge.
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
}

export function eventLoopLagMs(): number {
  return trackedLagMs;
}

// test-only: stop the timer + clear state between tests.
export function _resetLagGauge(): void {
  if (timer) clearInterval(timer);
  timer = null;
  trackedLagMs = 0;
}

// test-only: force a lag reading so /ready's degraded branch is deterministic.
export function _setTrackedLagForTest(ms: number): void {
  trackedLagMs = ms;
}
