interface Frame {
  function?: string;
  filename?: string;
  module?: string;
  lineno?: number;
  colno?: number;
}

// Sentry orders frames oldest-first (crashing frame last) — show most-relevant first.
export function StackTrace({ frames }: { frames?: Frame[] }) {
  if (!frames || frames.length === 0) {
    return <p class="text-sm text-[var(--muted)]">No stack frames.</p>;
  }
  return (
    <div class="overflow-hidden rounded-md border font-mono text-xs" style={{ borderColor: 'var(--border)' }}>
      {[...frames].reverse().map((f, i) => (
        <div key={i} class="border-b px-3 py-1.5 last:border-b-0 break-all" style={{ borderColor: 'var(--border)' }}>
          <span class="font-semibold">{f.function || '?'}</span>
          <span class="text-[var(--muted)]">
            {' @ '}
            {f.filename || f.module || '?'}
            {f.lineno ? `:${f.lineno}` : ''}
            {f.colno ? `:${f.colno}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
