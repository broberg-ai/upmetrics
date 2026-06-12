import { describe, it, expect } from 'bun:test';
import { computeVerdict, type RegressionCfg } from './regression';

// 15m after-window, 60m baseline, 3× rate multiplier, floor of 3 after-errors.
const CFG: RegressionCfg = { windowMs: 900_000, baselineMs: 3_600_000, multiplier: 3, minAfter: 3 };
const verdict = (afterCount: number, baselineCount: number, newIssues: number) =>
  computeVerdict({ afterCount, baselineCount, newIssues }, CFG).verdict;

describe('computeVerdict', () => {
  it('healthy when the after-rate tracks the baseline', () => {
    // 2 errors in 15m vs 8 in 60m → same rate → not a regression.
    expect(verdict(2, 8, 0)).toBe('healthy');
  });

  it('regressed on an error-rate spike past the multiplier', () => {
    expect(verdict(20, 5, 0)).toBe('regressed');
  });

  it('regressed when a brand-new issue appears, even with few errors', () => {
    expect(verdict(1, 0, 1)).toBe('regressed');
  });

  it('healthy below the noise floor (2 after-errors on a clean baseline, < minAfter)', () => {
    expect(verdict(2, 0, 0)).toBe('healthy');
  });

  it('regressed when errors appear on a previously-clean surface (baseline 0, ≥ floor)', () => {
    expect(verdict(5, 0, 0)).toBe('regressed');
  });

  it('rate-normalised: a high raw count is healthy if the rate matches baseline', () => {
    // 10 in 15m vs 40 in 60m → identical rate → healthy despite 10 > floor.
    expect(verdict(10, 40, 0)).toBe('healthy');
  });

  it('detail carries the numbers + a reason', () => {
    const r = computeVerdict({ afterCount: 20, baselineCount: 5, newIssues: 0 }, CFG);
    expect(r.detail.after).toBe(20);
    expect(r.detail.baseline).toBe(5);
    expect(r.detail.reason).toContain('spike');
  });
});
