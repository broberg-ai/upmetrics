export function fmtDate(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtRel(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const t = new Date(v).getTime();
  if (isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Adaptive USD: per-call AI costs are often sub-cent ($0.0000286), so a flat
// 2-decimal format collapses them all to "$0.00" (looks like a bug). Show 2 sig
// figs for sub-cent, more decimals near $1, separators for large fleet totals.
export function usd(n: number): string {
  const v = n ?? 0;
  if (v === 0) return '$0';
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`; // 1¢–$1 → e.g. $0.046
  return `$${v.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '')}`; // sub-cent → $0.000029
}

// USD→DKK display rate. The server is the single source of truth (F023 live rate
// → rolling-5 avg → default); the dashboard fetches it via loadUsdToDkk() on boot
// and dkk() reads the cached value. 6.9 is only the pre-load default.
let usdToDkkRate = 6.9;

export function setUsdToDkk(rate: number): void {
  if (Number.isFinite(rate) && rate > 0) usdToDkkRate = rate;
}

// Pull the live rate from the server once (call on app boot). Silent on failure —
// keeps the current value, so the dashboard never breaks if the endpoint is down.
export async function loadUsdToDkk(): Promise<void> {
  try {
    const res = await fetch('/api/fx/usd-dkk');
    if (res.ok) setUsdToDkk(Number((await res.json())?.rate));
  } catch {
    /* keep the current rate */
  }
}

// DKK companion to usd(): "DKK 120,00". Prefix (like usd's "$") for consistency,
// Danish formatting — period thousands + comma decimal, always 2 decimals.
export function dkk(n: number): string {
  const v = (n ?? 0) * usdToDkkRate;
  return `DKK ${v.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
