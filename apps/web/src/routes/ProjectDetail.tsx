import { useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, ArrowLeft } from 'lucide-preact';
import { useApi } from '../lib/useApi';
import { Card, Badge, StatusDot, Spinner } from '../components/ui/controls';
import { Loading, ErrorBox, PageHeader } from '../components/PageState';
import { fmtRel, fmtDate, usd } from '../lib/format';

interface Component {
  release: string;
  environment: string | null;
  total: number;
  errors: number;
  last_seen: number | null;
}
interface Detail {
  project: { id: string; name: string; platform: string };
  open_issues: number;
  open_incidents: number;
  total_events: number;
  cost_today: number;
  cost_total: number;
  components: Component[];
}
interface CompError {
  event_id: string;
  issue_id: string | null;
  title: string;
  type: string | null;
  value: string | null;
  status: string | null;
  occurred_at: string;
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' | 'down' }) {
  return (
    <div>
      <div class="text-lg font-semibold" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      <div class="text-xs text-[var(--muted)]">{label}</div>
    </div>
  );
}

// The actual errors behind a component's count — lazy-loaded on expand so the
// "22 err" number is drillable, not just a dead figure.
function ComponentErrors({ id, release }: { id: string; release: string }) {
  const rel = release === '(untagged)' ? '__none__' : release;
  const { loading, data, error } = useApi<{ errors: CompError[] }>(`/dashboard/projects/${id}/component-errors?release=${encodeURIComponent(rel)}`);
  if (loading) return <div class="flex items-center gap-2 py-2 pl-6 text-xs text-[var(--muted)]"><Spinner size={14} /> Loading errors…</div>;
  if (error) return <div class="py-2 pl-6 text-xs" style={{ color: 'var(--down)' }}>{error}</div>;
  const errors = data?.errors ?? [];
  if (errors.length === 0) return <div class="py-2 pl-6 text-xs text-[var(--muted)]">No error events.</div>;
  return (
    <div class="space-y-1 py-2 pl-6">
      {errors.map((e) => (
        <a key={e.event_id} href={`/issues?project=${id}`} class="block rounded-md px-2 py-1.5 transition hover:bg-[var(--surface-2)]">
          <div class="flex items-baseline justify-between gap-3">
            <span class="truncate text-sm font-medium">{e.title}</span>
            <span class="shrink-0 text-xs text-[var(--muted)]">{fmtRel(e.occurred_at)}</span>
          </div>
          {e.value && <div class="truncate text-xs text-[var(--muted)]" title={fmtDate(e.occurred_at)}>{e.value}</div>}
        </a>
      ))}
      {errors.length === 50 && <div class="px-2 pt-1 text-xs text-[var(--muted)]">Showing latest 50.</div>}
    </div>
  );
}

export function ProjectDetail({ id }: { id?: string }) {
  const { loading, data, error } = useApi<Detail>(`/dashboard/projects/${id}`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div>
      <a href="/" class="mb-3 inline-flex items-center gap-1 text-sm text-[var(--muted)] transition hover:text-[var(--text)]">
        <ArrowLeft size={14} /> Overview
      </a>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data ? (
        <ErrorBox msg="Project not found." />
      ) : (
        <div class="space-y-6">
          <PageHeader title={data.project.name} subtitle={`${data.project.id} · ${data.project.platform}`} />

          {/* summary */}
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card><Metric label="Open issues" value={data.open_issues} tone={data.open_issues ? 'warn' : undefined} /></Card>
            <Card><Metric label="Open incidents" value={data.open_incidents} tone={data.open_incidents ? 'down' : undefined} /></Card>
            <Card><Metric label="Events captured" value={data.total_events} /></Card>
            <Card><Metric label="Agent cost (today / total)" value={`${usd(data.cost_today)} / ${usd(data.cost_total)}`} /></Card>
          </div>

          {/* components */}
          <Card>
            <div class="mb-1 text-sm font-medium">Components</div>
            <div class="mb-3 text-xs text-[var(--muted)]">Surfaces reporting under this repo (the SDK <code>release</code> each sets). Click to see its errors.</div>
            {data.components.length === 0 ? (
              <div class="py-3 text-sm text-[var(--muted)]">Nothing has reported yet. Point an SDK at this project to populate it.</div>
            ) : (
              <div class="divide-y" style={{ borderColor: 'var(--border)' }}>
                {data.components.map((comp) => {
                  const isOpen = open === comp.release;
                  return (
                    <div key={comp.release + comp.environment} style={{ borderColor: 'var(--border)' }}>
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : comp.release)}
                        aria-expanded={isOpen}
                        class="flex w-full items-center justify-between gap-2 py-2.5 text-left transition hover:opacity-80 active:scale-[0.997] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                      >
                        <div class="flex min-w-0 items-center gap-2">
                          {isOpen ? <ChevronDown size={16} class="shrink-0 text-[var(--muted)]" /> : <ChevronRight size={16} class="shrink-0 text-[var(--muted)]" />}
                          <StatusDot tone={comp.errors > 0 ? 'warn' : 'ok'} />
                          <span class="truncate font-medium">{comp.release}</span>
                          {comp.environment && comp.environment !== 'production' && <Badge tone="muted">{comp.environment}</Badge>}
                        </div>
                        <div class="flex shrink-0 items-center gap-3 text-xs text-[var(--muted)]">
                          {comp.errors > 0 && <span style={{ color: 'var(--warn)' }}>{comp.errors} err</span>}
                          <span>{comp.total} events</span>
                          <span>{fmtRel(comp.last_seen)}</span>
                        </div>
                      </button>
                      {isOpen && <ComponentErrors id={data.project.id} release={comp.release} />}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
