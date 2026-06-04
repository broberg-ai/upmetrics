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

// Single source for the USD→DKK display rate. Approximate, static (set 2026-06-04);
// the dashboard shows DKK only as an at-a-glance companion to the authoritative
// USD, so a fixed rate is fine — bump this ONE constant if it drifts too far.
export const USD_TO_DKK = 6.9;

// DKK companion to usd(): "56 kr". Mirrors usd()'s adaptive precision so a
// sub-øre fleet cost doesn't collapse to "0 kr".
export function dkk(n: number): string {
  const v = (n ?? 0) * USD_TO_DKK;
  if (v === 0) return '0 kr';
  if (v >= 100) return `${Math.round(v).toLocaleString('da-DK')} kr`;
  if (v >= 1) return `${v.toFixed(0)} kr`;
  if (v >= 0.01) return `${v.toFixed(2)} kr`;
  return `${v.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '')} kr`;
}
