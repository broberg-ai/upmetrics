// F022.4 — credit threshold alarms + burn-rate (pure logic). The export-API's
// /alarms + /burn-rate read these; the proactive firing (Discord/webhook on a
// band crossing) layers on top in the snapshot-write path.
import { config } from '../config';
import type { CreditSnapshot } from './store';

export type AlarmState = 'ok' | 'warn' | 'critical';

export interface AlarmThresholds {
  warn_below: number;
  critical_below: number;
}

// v1: global config thresholds for every provider (a per-provider config map
// can replace this without touching call sites).
export function thresholdsFor(_provider: string): AlarmThresholds {
  return { warn_below: config.creditWarnBelowUsd, critical_below: config.creditCriticalBelowUsd };
}

export function alarmState(remaining: number, t: AlarmThresholds): AlarmState {
  if (remaining <= t.critical_below) return 'critical';
  if (remaining <= t.warn_below) return 'warn';
  return 'ok';
}

export interface BurnRate {
  per_day: number | null; // USD/day spend (null if not derivable)
  days_left: number | null; // remaining / per_day (null if burn ≤ 0 or unknown)
}

// Burn-rate from the two most-recent snapshots (newest first). Spend/day comes
// from the usage delta over the time delta; days_left projects when remaining
// hits zero. null when <2 snapshots, a non-positive time delta, or no spend
// (a flat/negative usage delta means no meaningful burn to project).
export function burnRate(recent: CreditSnapshot[]): BurnRate {
  if (recent.length < 2) return { per_day: null, days_left: null };
  const newest = recent[0]!;
  const older = recent[1]!;
  const dtMs = newest.capturedAt.getTime() - older.capturedAt.getTime();
  const usageDelta = newest.totalUsage - older.totalUsage;
  if (dtMs <= 0 || usageDelta <= 0) return { per_day: null, days_left: null };
  const perDay = usageDelta / (dtMs / 86_400_000);
  return { per_day: perDay, days_left: newest.remaining / perDay };
}
