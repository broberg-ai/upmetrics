import { useApi } from '../lib/useApi';
import { Card, Badge, StatusDot } from '../components/ui/controls';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';

interface Proj {
  id: string;
  name: string;
  platform: string;
  probe_up_pct: number | null;
  probe_total: number;
  open_issues: number;
  open_incidents: number;
  agent_cost_today: number;
  status: 'ok' | 'degraded' | 'down';
}
interface OverviewData {
  projects: Proj[];
  totals: { projects: number; open_issues: number; open_incidents: number; agent_cost_today: number };
}

const TONE = { ok: 'ok', degraded: 'warn', down: 'down' } as const;
const STATUS_LABEL = { ok: 'Healthy', degraded: 'Degraded', down: 'Down' } as const;

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'down' }) {
  return (
    <div>
      <div class="text-lg font-semibold" style={tone ? { color: `var(--${tone === 'warn' ? 'warn' : tone})` } : undefined}>
        {value}
      </div>
      <div class="text-xs text-[var(--muted)]">{label}</div>
    </div>
  );
}

export function Overview() {
  const { loading, data, error } = useApi<OverviewData>('/dashboard/overview');

  return (
    <div>
      <PageHeader title="Overview" subtitle="Health across all projects" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data || data.projects.length === 0 ? (
        <Empty msg="No projects yet. Point an SDK at upmetrics to start." />
      ) : (
        <div class="space-y-6">
          {/* totals strip */}
          <div class="grid grid-cols-3 gap-3">
            <Card>
              <Metric label="Projects" value={data.totals.projects} />
            </Card>
            <Card>
              <Metric label="Open issues" value={data.totals.open_issues} tone={data.totals.open_issues ? 'warn' : undefined} />
            </Card>
            <Card>
              <Metric label="Open incidents" value={data.totals.open_incidents} tone={data.totals.open_incidents ? 'down' : undefined} />
            </Card>
          </div>

          {/* per-project health cards — click through to the project page */}
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.projects.map((p) => (
              <a
                key={p.id}
                href={`/projects/${p.id}`}
                class="block rounded-xl transition hover:brightness-110 active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <Card>
                  <div class="mb-3 flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <StatusDot tone={TONE[p.status]} />
                      <span class="font-medium">{p.name}</span>
                    </div>
                    <Badge tone="muted">{p.platform}</Badge>
                  </div>
                  <div class="grid grid-cols-3 gap-3">
                    <Metric label={`Probes up (${p.probe_total})`} value={p.probe_up_pct === null ? '—' : `${p.probe_up_pct}%`} tone={p.probe_up_pct !== null && p.probe_up_pct < 100 ? 'down' : undefined} />
                    <Metric label="Open issues" value={p.open_issues} tone={p.open_issues ? 'warn' : undefined} />
                    <Metric label="Incidents" value={p.open_incidents} tone={p.open_incidents ? 'down' : undefined} />
                  </div>
                </Card>
              </a>
            ))}
          </div>

          {/* global matrix */}
          <Card class="overflow-x-auto">
            <div class="mb-3 text-sm font-medium">Global matrix</div>
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th class="pb-2 font-medium">Project</th>
                  <th class="pb-2 font-medium">Status</th>
                  <th class="pb-2 font-medium">Probes</th>
                  <th class="pb-2 font-medium">Issues</th>
                  <th class="pb-2 font-medium">Incidents</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.id} class="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td class="py-2">
                      <a href={`/projects/${p.id}`} class="hover:underline">{p.name}</a>
                    </td>
                    <td class="py-2">
                      <Badge tone={TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </td>
                    <td class="py-2">{p.probe_up_pct === null ? '—' : `${p.probe_up_pct}%`}</td>
                    <td class="py-2">{p.open_issues}</td>
                    <td class="py-2">{p.open_incidents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
