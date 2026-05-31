// F008.2 — pure watchdog decision logic (no I/O, unit-tested). Given the previous
// persisted state + this tick's reachability, decide whether to fire ONE alert.
//
// Alerting rules (AC1 "exactly one alert"):
//  - A service transitioning up→down fires one alert. If BOTH go down together,
//    it's ONE consolidated "arn region unreachable" alert, not two.
//  - While still down, stay quiet until `realertMs` elapses (then one reminder).
//  - A service coming back fires one recovery notice.

export type Status = 'up' | 'down';
export interface TargetState {
  status: Status;
  since: number;
}
export interface WatchState {
  upmetrics: TargetState;
  cronjobs: TargetState;
  lastAlertAt: number;
}
export interface CheckResult {
  upmetrics: Status;
  cronjobs: Status;
}
export interface Decision {
  alert: string | null;
  state: WatchState;
}

export const DEFAULT_STATE: WatchState = {
  upmetrics: { status: 'up', since: 0 },
  cronjobs: { status: 'up', since: 0 },
  lastAlertAt: 0,
};

const REALERT_MS = 30 * 60_000; // remind at most every 30 min while still down

function step(prev: TargetState, status: Status, now: number): TargetState {
  return prev.status === status ? prev : { status, since: now };
}

export function decide(prev: WatchState, check: CheckResult, now: number, realertMs = REALERT_MS): Decision {
  const state: WatchState = {
    upmetrics: step(prev.upmetrics, check.upmetrics, now),
    cronjobs: step(prev.cronjobs, check.cronjobs, now),
    lastAlertAt: prev.lastAlertAt,
  };

  const downNow = (['upmetrics', 'cronjobs'] as const).filter((k) => check[k] === 'down');
  const downPrev = (['upmetrics', 'cronjobs'] as const).filter((k) => prev[k].status === 'down');
  const newlyDown = downNow.filter((k) => !downPrev.includes(k));
  const recovered = downPrev.filter((k) => !downNow.includes(k));

  let alert: string | null = null;
  if (newlyDown.length > 0) {
    alert =
      downNow.length === 2
        ? '🔴 arn region unreachable — upmetrics AND cronjobs down (off-fly watchdog)'
        : `🔴 ${downNow.join(' + ')} unreachable (off-fly watchdog)`;
    state.lastAlertAt = now;
  } else if (downNow.length > 0 && now - prev.lastAlertAt >= realertMs) {
    alert = `🔴 still down: ${downNow.join(' + ')} (off-fly watchdog)`;
    state.lastAlertAt = now;
  } else if (recovered.length > 0 && downNow.length === 0) {
    alert = `✅ recovered: ${recovered.join(' + ')} back up`;
  }

  return { alert, state };
}
