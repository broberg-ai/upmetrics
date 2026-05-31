// F008.2 watchdog decision logic. Run: bun test src/decide.test.ts
import { describe, it, expect } from 'bun:test';
import { decide, DEFAULT_STATE, type WatchState } from './decide';

const T = 1_000_000;

describe('F008.2 watchdog decide()', () => {
  it('AC1+AC2: a full arn outage (both down) fires exactly ONE consolidated alert', () => {
    const { alert, state, changed } = decide(DEFAULT_STATE, { upmetrics: 'down', cronjobs: 'down' }, T);
    expect(alert).toContain('arn region unreachable');
    expect(alert).toContain('upmetrics AND cronjobs');
    expect(changed).toBe(true); // transition → KV write
    // next tick, still down → no second alert AND no KV write (within re-alert window)
    const next = decide(state, { upmetrics: 'down', cronjobs: 'down' }, T + 60_000);
    expect(next.alert).toBeNull();
    expect(next.changed).toBe(false); // steady-state → skip the write
  });

  it('a single service down fires one alert naming just that service', () => {
    const { alert } = decide(DEFAULT_STATE, { upmetrics: 'down', cronjobs: 'up' }, T);
    expect(alert).toBe('🔴 upmetrics unreachable (off-fly watchdog)');
  });

  it('a prolonged outage reminds at most once per realert window', () => {
    let s: WatchState = decide(DEFAULT_STATE, { upmetrics: 'down', cronjobs: 'up' }, T).state;
    // 10 min later, still down, realert=30min → quiet
    const quiet = decide(s, { upmetrics: 'down', cronjobs: 'up' }, T + 10 * 60_000);
    expect(quiet.alert).toBeNull();
    // 31 min after the last alert → one reminder
    const remind = decide(s, { upmetrics: 'down', cronjobs: 'up' }, T + 31 * 60_000);
    expect(remind.alert).toContain('still down');
  });

  it('recovery fires a single recovered notice', () => {
    const down = decide(DEFAULT_STATE, { upmetrics: 'down', cronjobs: 'up' }, T).state;
    const { alert } = decide(down, { upmetrics: 'up', cronjobs: 'up' }, T + 5 * 60_000);
    expect(alert).toBe('✅ recovered: upmetrics back up');
  });

  it('steady-state up → silence AND no KV write', () => {
    const { alert, changed } = decide(DEFAULT_STATE, { upmetrics: 'up', cronjobs: 'up' }, T);
    expect(alert).toBeNull();
    expect(changed).toBe(false); // the common case: zero KV writes
  });
});
