// F022.4 alarm + burn-rate logic. Run: bun test src/credits/alarms.test.ts
import { describe, it, expect } from 'bun:test';
import { alarmState, burnRate } from './alarms';
import type { CreditSnapshot } from './store';

const T = { warn_below: 10, critical_below: 2 };

function snap(totalUsage: number, remaining: number, capturedAtMs: number): CreditSnapshot {
  return {
    id: `s_${capturedAtMs}`,
    provider: 'openrouter',
    totalCredits: remaining + totalUsage,
    totalUsage,
    remaining,
    currency: 'USD',
    capturedAt: new Date(capturedAtMs),
    raw: null,
  } as CreditSnapshot;
}

describe('alarmState bands', () => {
  it('ok above warn, warn at/below warn, critical at/below critical', () => {
    expect(alarmState(50, T)).toBe('ok');
    expect(alarmState(10, T)).toBe('warn'); // boundary = warn
    expect(alarmState(5, T)).toBe('warn');
    expect(alarmState(2, T)).toBe('critical'); // boundary = critical
    expect(alarmState(0, T)).toBe('critical');
  });
});

describe('burnRate', () => {
  it('null with fewer than two snapshots', () => {
    expect(burnRate([])).toEqual({ per_day: null, days_left: null });
    expect(burnRate([snap(5, 45, 1000)])).toEqual({ per_day: null, days_left: null });
  });

  it('derives spend/day + days-left from two snapshots', () => {
    const DAY = 86_400_000;
    // older: usage 10; newest one day later: usage 15 → $5/day; remaining 20 → 4 days left
    const recent = [snap(15, 20, DAY * 2), snap(10, 25, DAY * 1)];
    const b = burnRate(recent);
    expect(b.per_day).toBeCloseTo(5, 6);
    expect(b.days_left).toBeCloseTo(4, 6);
  });

  it('null per_day when usage is flat (no burn to project)', () => {
    const DAY = 86_400_000;
    expect(burnRate([snap(10, 20, DAY * 2), snap(10, 20, DAY * 1)])).toEqual({ per_day: null, days_left: null });
  });
});
