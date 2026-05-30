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

export const usd = (n: number) => `$${(n ?? 0).toFixed(2)}`;
