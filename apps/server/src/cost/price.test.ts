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
    // A model the price list cannot know, ON PURPOSE. The first version of this
    // test used claude-sonnet-4-20250514, measured as unknown on 2026-09-03 —
    // and went red hours later when ai-sdk 0.37.3 added it. That was the test
    // working: pinning a REAL gap makes the test a clock, not a contract. The
    // contract is "an id the list does not know must never read as free", so the
    // fixture is now an id that cannot become known.
    const r = R({ model: 'no-such-model-in-any-catalogue-v9', inputTokens: 31_427, outputTokens: 6_750 });
    expect(r).toEqual({ costUsd: 0, source: 'unpriced' });
  });

  it('no model id at all is also unpriced, not free', () => {
    expect(R({ model: null, inputTokens: 100, outputTokens: 10 }).source).toBe('unpriced');
    expect(R({ model: 'unknown', inputTokens: 100, outputTokens: 10 }).source).toBe('unpriced');
  });

  it('neither tokens nor cost is "unaccountable" — NOT "this was free"', () => {
    // Measured on prod 2026-09-03: this bucket is 60 runs, every one of them
    // anthropic/claude-code. It runs on a subscription and reports neither
    // token counts nor a price, so its usage is invisible in every total we
    // publish. $0 is right as a bill and wrong as a measurement.
    const r = R({ model: 'claude-code', inputTokens: 0, outputTokens: 0 });
    expect(r).toEqual({ costUsd: 0, source: 'unaccountable' });
  });

  it('zero tokens is NOT enough to be unaccountable — a priced call is accounted for', () => {
    // The row that decides the predicate. 305 prod runs have 0 tokens and a real
    // cost ($5.12): fal prices per image or per second, azure per character.
    // Those senders CAN account for themselves, so "has no tokens" would have
    // swept 305 fully-known calls into the unknown pile.
    const r = R({ model: 'fal-ai/flux/schnell', costUsd: 0.003, inputTokens: 0, outputTokens: 0 });
    expect(r).toEqual({ costUsd: 0.003, source: 'reported' });
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
