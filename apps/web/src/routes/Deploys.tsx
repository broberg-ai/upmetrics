import { useApi } from '../lib/useApi';
import { fmtRel } from '../lib/format';
import { Card, Badge, StatusDot } from '../components/ui/controls';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';

// F019.6 — DeployStatus: read-only display of observed deploy_events. upmetrics
// WATCHES + REPORTS deploys (and relays), it never triggers one.
interface Deploy {
  id: string;
  project: string;
  site: string;
  status: 'pending' | 'running' | 'success' | 'failure';
  provider: string | null;
  sha: string | null;
  version: string | null;
  originator: string | null;
  relayed: boolean;
  updatedAt: string;
}

const STATUS_TONE: Record<Deploy['status'], 'ok' | 'down' | 'warn' | 'muted'> = {
  success: 'ok',
  failure: 'down',
  running: 'warn',
  pending: 'muted',
};

export function Deploys() {
  const { loading, data, error } = useApi<{ deploys: Deploy[] }>('/dashboard/deploys');

  return (
    <div data-testid="deploys-root">
      <PageHeader title="Deploys" subtitle="Observed deploy + release status across the fleet (watch / report / relay)" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data || data.deploys.length === 0 ? (
        <Empty msg="No deploys observed yet. The execution side reports them via POST /api/deploys." />
      ) : (
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="deploys-list">
          {data.deploys.map((d) => (
            <Card key={d.id} data-testid="deploy-card">
              <div class="mb-2 flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <StatusDot tone={STATUS_TONE[d.status]} />
                  <span class="truncate font-medium">{d.site}</span>
                </div>
                {d.provider && <Badge tone="muted">{d.provider}</Badge>}
              </div>
              <div class="flex items-center justify-between text-xs text-[var(--muted)]">
                <span class="capitalize">{d.status}</span>
                <span class="font-mono">{d.version ?? (d.sha ? d.sha.slice(0, 7) : '—')}</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
                <span class="truncate">{d.originator ? `↪ ${d.originator}` : 'no originator'}</span>
                <span class="shrink-0">{fmtRel(d.updatedAt)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
