// F027 — a missing price must not read as a free call.
// Run: bun test src/cost/price.test.ts
//
// Against the REAL @broberg/ai-sdk/pricing, not a stub: the whole point is that
// the rates are the fleet's, so a test on a stub would prove only that our own
// arithmetic works while the numbers came from nowhere.
import { describe, it, expect } from 'bun:test';
import { resolveCost } from './price';

const R = (o: Partial<Parameters<typeof resolveCost>[0]>) =>
  resolveCost({ costUsd: 0, model: 'mistral/mistral-small-latest', inputTokens: 0, outputTokens: 0, ...o });

describe('resolveCost — four states, because "0" has three meanings', () => {
  it('a sender-supplied price wins and is left untouched', () => {
    // The sender knows things we cannot: a negotiated rate, a cache discount.
    const r = R({ costUsd: 0.0042, inputTokens: 999_999, outputTokens: 1 });
    expect(r).toEqual({ costUsd: 0.0042, source: 'reported' });
  });

  it('computes from the fleet price list when the sender sent nothing', () => {
    // mistral-small is $0.10/M in, $0.30/M out (curated).
    const r = R({ inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(r.source).toBe('computed');
    expect(r.costUsd).toBeCloseTo(0.13, 6);
  });

  it('an UNKNOWN model stays 0 but says "unpriced" — never "free"', () => {
    // Measured 2026-09-03: the price list knows mistral, and does NOT know
    // claude-sonnet-4-20250514, pixtral-large-latest, or the openrouter/deepseek
    // ids. 92 of our 229 zero-cost rows land here. They must be readable as a
    // FLOOR on the bill, not as a fact about it.
    const r = R({ model: 'claude-sonnet-4-20250514', inputTokens: 31_427, outputTokens: 6_750 });
    expect(r).toEqual({ costUsd: 0, source: 'unpriced' });
  });

  it('no model id at all is also unpriced, not free', () => {
    expect(R({ model: null, inputTokens: 100, outputTokens: 10 }).source).toBe('unpriced');
    expect(R({ model: 'unknown', inputTokens: 100, outputTokens: 10 }).source).toBe('unpriced');
  });

  it('zero tokens AND zero cost is "untokened" — genuinely nothing to price', () => {
    // 60 claude-code runs on prod report no token counts at all. Lumping these
    // in with "unpriced" would make the unknown pile look bigger than it is.
    const r = R({ model: 'claude-code', inputTokens: 0, outputTokens: 0 });
    expect(r).toEqual({ costUsd: 0, source: 'untokened' });
  });

  it('the four states are distinguishable from each other — the negative control', () => {
    // If any two collapsed, the field would be decoration. Assert all four are
    // reachable and distinct from the same function.
    const seen = new Set([
      R({ costUsd: 1, inputTokens: 5, outputTokens: 5 }).source,
      R({ inputTokens: 1_000, outputTokens: 100 }).source,
      R({ model: 'no-such-model-anywhere', inputTokens: 1_000, outputTokens: 100 }).source,
      R({ inputTokens: 0, outputTokens: 0 }).source,
    ]);
    expect(seen.size).toBe(4);
  });

  it('the real prod shape: 112M mistral tokens is not $0', () => {
    // buddy's worst group, exactly as it sits in the database.
    const r = R({ inputTokens: 112_542_231, outputTokens: 3_831_672 });
    expect(r.source).toBe('computed');
    expect(r.costUsd).toBeGreaterThan(10); // was recorded as 0
  });
});
