// F023 — live USD→DKK rate with a rolling-5 fallback. usdToDkk() is the single
// SYNC source every DKK conversion reads (cost-API + credits). A background
// worker refreshes it; the request path never makes a network call and never throws.
import { config } from '../config';
import { getDb } from '../db';
import { insertRate, last5avg } from './store';

const PAIR = 'USD_DKK';
// Free, no-key, daily-updated (rates.DKK). fetch follows redirects by default.
const SOURCE = 'https://open.er-api.com/v6/latest/USD';

let current: number | null = null;

// SYNC getter for request handlers. Always returns a usable number: the cached
// live rate → the avg of the last ≤5 stored → the config default.
export function usdToDkk(): number {
  return current ?? last5avg(getDb(), PAIR) ?? config.usdToDkk;
}

// Fetch the live rate; success → store (roll-to-5) + set current; ANY failure →
// current = last-5 avg (or config default). Never throws into the caller.
export async function refreshFxRate(): Promise<number> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let rate: number;
    try {
      const res = await fetch(SOURCE, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`fx HTTP ${res.status}`);
      const j = (await res.json()) as { result?: string; rates?: { DKK?: number } };
      rate = Number(j?.rates?.DKK);
      if (j?.result !== 'success' || !Number.isFinite(rate) || rate <= 0) throw new Error('fx: bad payload');
    } finally {
      clearTimeout(timer);
    }
    insertRate(getDb(), PAIR, rate);
    current = rate;
    return rate;
  } catch (err) {
    current = last5avg(getDb(), PAIR) ?? config.usdToDkk;
    if (typeof console !== 'undefined') {
      console.warn('[fx] live refresh failed, using fallback', (err as Error).message, '→', current);
    }
    return current;
  }
}

let interval: ReturnType<typeof setInterval> | null = null;
// Boot refresh + periodic roll (default 12h; the source is daily).
export function startFxWorker(): void {
  void refreshFxRate();
  if (interval) clearInterval(interval);
  interval = setInterval(() => void refreshFxRate(), config.fxRefreshIntervalMs);
  (interval as { unref?: () => void }).unref?.();
}
