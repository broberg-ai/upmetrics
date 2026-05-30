import { AlertTriangle } from 'lucide-preact';
import { useApi } from '../lib/useApi';

interface OpenInc {
  id: string;
  severity: string;
  title: string;
}

// Open-incidents bar shown on every page (F015). Hidden when nothing is open.
export function IncidentsBar() {
  const { data } = useApi<{ incidents: OpenInc[] }>('/dashboard/incidents/open');
  const open = data?.incidents ?? [];
  if (open.length === 0) return null;

  const worst = open.some((i) => i.severity === 'critical' || i.severity === 'high');
  const color = worst ? 'var(--down)' : 'var(--warn)';
  return (
    <a
      href="/incidents"
      class="flex items-center gap-2 border-b px-6 py-2 text-sm hover:brightness-110"
      style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, borderColor: 'var(--border)' }}
    >
      <AlertTriangle size={15} color={color} />
      <span class="font-medium" style={{ color }}>
        {open.length} open incident{open.length > 1 ? 's' : ''}
      </span>
      <span class="text-[var(--muted)]">
        — {open[0].title}
        {open.length > 1 ? ` +${open.length - 1} more` : ''}
      </span>
    </a>
  );
}
