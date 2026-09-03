// F027 — fill in the price when the sender did not send one.
//
// MEASURED on prod 2026-09-03: 229 of 36,048 agent runs carried real tokens and
// a cost of 0. Not free calls — unpriced ones. The worst single group was
// buddy's mistral-small: 84 calls, 112,542,231 input tokens, recorded as costing
// nothing. `cost_usd` defaults to 0 at ingest, so "this call was free" and "the
// sender never told us what it cost" were the same number, and the bill reads
// lower than it is. A burn-rate alarm built on that sum fires late.
//
// Rates come from @broberg/ai-sdk/pricing — the fleet's single source. We do NOT
// keep our own table: a second copy of the rates is a copy that goes stale
// silently, and the whole point of being the cost sink is that the number can be
// trusted.
import { priceCall } from '@broberg/ai-sdk/pricing';

/**
 * Where a run's cost came from. FOUR states, not two, because "0" has three
 * different meanings and only one of them is "this was free":
 *
 *   reported      the sender priced it — we changed nothing
 *   computed      the sender sent 0, we derived it from the fleet price list
 *   unpriced      real tokens, but the price list does not know this model.
 *                 Cost stays 0 AND says so, so a total can be read as a floor
 *                 rather than as a fact.
 *   unaccountable neither tokens nor a cost. Not "this was free" — the sender
 *                 gave us nothing to account WITH.
 *
 * The last one was called `untokened` for a few hours, and the name was the same
 * mistake this whole file exists to fix: it read as "there was nothing to price"
 * when it means "we cannot say". Named by ai-sdk; the measurement settles it.
 *
 * MEASURED on prod 2026-09-03:
 *   0 tokens AND 0 cost   60 runs, every one of them anthropic/claude-code
 *   0 tokens WITH a cost  305 runs, $5.12 (fal image/video, azure speech)
 *
 * The second row is why the predicate is not "has no tokens". Those senders
 * price per image or per second and report a real number; they are `reported`
 * and fully accounted for. Zero tokens alone says nothing.
 *
 * claude-code is the case: it runs on Christian's subscription and reports
 * neither token counts nor a price, so its usage is invisible in every total we
 * publish. $0 is not wrong as a bill — no API is invoiced — but it is wrong as
 * a measurement, and a total that silently contains 60 such runs should say so.
 */
export type CostSource = 'reported' | 'computed' | 'unpriced' | 'unaccountable';

export interface CostInput {
  costUsd: number;
  model: string | null | undefined;
  inputTokens: number;
  outputTokens: number;
}

export function resolveCost(inp: CostInput): { costUsd: number; source: CostSource } {
  // A sender-supplied price always wins. It knows things we cannot: a negotiated
  // rate, a cached-token discount, a provider surcharge.
  if (inp.costUsd > 0) return { costUsd: inp.costUsd, source: 'reported' };

  const tokens = (inp.inputTokens || 0) + (inp.outputTokens || 0);
  if (tokens <= 0) return { costUsd: 0, source: 'unaccountable' };
  if (!inp.model) return { costUsd: 0, source: 'unpriced' };

  const priced = priceCall(inp.model, inp.inputTokens || 0, inp.outputTokens || 0);
  // `undefined` means the registry does not know this model — NOT that it is
  // free. Returning 0 with the honest label keeps the difference readable
  // instead of quietly widening the same lie this file exists to close.
  if (priced === undefined || !Number.isFinite(priced)) return { costUsd: 0, source: 'unpriced' };
  return { costUsd: priced, source: 'computed' };
}
