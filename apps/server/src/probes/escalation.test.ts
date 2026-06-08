import { describe, it, expect } from 'bun:test';
import { parseTiers, severityForFailures, severityRank, escalatedSeverity } from './escalation';

describe('parseTiers', () => {
  it('parses and sorts ascending by failure count', () => {
    expect(parseTiers('10:critical,3:high')).toEqual([
      { failures: 3, severity: 'high' },
      { failures: 10, severity: 'critical' },
    ]);
  });

  it('tolerates whitespace and skips invalid entries', () => {
    expect(parseTiers(' 3 : high , junk, 5:nope, 8:critical ')).toEqual([
      { failures: 3, severity: 'high' },
      { failures: 8, severity: 'critical' },
    ]);
  });

  it('empty input → []', () => {
    expect(parseTiers('')).toEqual([]);
  });
});

describe('severityForFailures', () => {
  const tiers = parseTiers('3:high,10:critical');

  it('below the first tier → null', () => {
    expect(severityForFailures(2, tiers)).toBeNull();
  });

  it('at the first tier → high', () => {
    expect(severityForFailures(3, tiers)).toBe('high');
  });

  it('between tiers stays at the lower tier', () => {
    expect(severityForFailures(9, tiers)).toBe('high');
  });

  it('at/over the second tier → critical', () => {
    expect(severityForFailures(10, tiers)).toBe('critical');
    expect(severityForFailures(50, tiers)).toBe('critical');
  });
});

describe('escalatedSeverity (only ever raises)', () => {
  it('raises high → critical', () => {
    expect(escalatedSeverity('high', 'critical')).toBe('critical');
  });

  it('never lowers critical → high', () => {
    expect(escalatedSeverity('critical', 'high')).toBeNull();
  });

  it('equal severity → null (no churn / no re-alert)', () => {
    expect(escalatedSeverity('high', 'high')).toBeNull();
  });

  it('null candidate → null', () => {
    expect(escalatedSeverity('high', null)).toBeNull();
  });
});

describe('severityRank', () => {
  it('orders low < medium < high < critical', () => {
    expect(severityRank('low')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });

  it('unknown → 0', () => {
    expect(severityRank('bogus')).toBe(0);
  });
});
