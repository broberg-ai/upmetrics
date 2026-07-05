// F008 event-loop lag gauge — decay/recovery behaviour. Run: bun test src/ops/lag-gauge.test.ts
import { describe, it, expect } from 'bun:test';
import { nextTrackedLag } from './lag-gauge';

describe('nextTrackedLag (decaying max)', () => {
  it('a clean sample (no lag) with no history stays 0', () => {
    expect(nextTrackedLag(0, 0)).toBe(0);
  });

  it('a negative sample (timer slightly early) never goes below 0', () => {
    expect(nextTrackedLag(0, -5)).toBe(0);
  });

  it('a big stall is captured immediately', () => {
    expect(nextTrackedLag(0, 16000)).toBe(16000);
  });

  it('recovers by halving on each clean sample (not stuck degraded)', () => {
    let v = nextTrackedLag(0, 16000); // 16000
    v = nextTrackedLag(v, 0); // 8000
    v = nextTrackedLag(v, 0); // 4000
    v = nextTrackedLag(v, 0); // 2000
    expect(v).toBe(2000);
    v = nextTrackedLag(v, 0); // 1000 — now below the 2000ms degraded threshold
    expect(v).toBeLessThan(2000);
  });

  it('a fresh larger stall overrides the decaying max', () => {
    const decaying = nextTrackedLag(nextTrackedLag(0, 4000), 0); // 2000
    expect(nextTrackedLag(decaying, 9000)).toBe(9000);
  });
});
