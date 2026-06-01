import { useApi } from '../lib/useApi';
import { Card, Badge } from '../components/ui/controls';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';
import { fmtRel } from '../lib/format';

interface Pending {
  incident_id: string;
  project: string;
  repo: string;
  severity: string;
  manual: boolean;
  opened_at: string;
  issue: { id: string; title: string; release: string | null; occurrences: number };
}
interface History {
  incident_id: string;
  project: string;
  project_name: string;
  title: string;
  kind: string;
  severity: string;
  status: string;
  manual: boolean;
  relay_session: string | null;
  requested_at: string | null;
  claimed_at: string | null;
  opened_at: string;
}

const SEV_TONE: Record<string, 'down' | 'warn' | 'muted'> = { critical: 'down', high: 'down', medium: 'warn', low: 'muted' };

export function Remediation() {
  const { loading, data, error } = useApi<{ pending: Pending[]; history: History[] }>('/dashboard/remediation');

  return (
    <div data-testid="remediation-root">
      <PageHeader title="Remediation" subtitle="Issues relayed to Buddy → the responsible cc session fixes the root cause" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data ? (
        <ErrorBox msg="Could not load remediation." />
      ) : (
        <div class="space-y-6">
          {/* awaiting a session to claim */}
          <Card>
            <div class="mb-1 text-sm font-medium">Awaiting a session ({data.pending.length})</div>
            <div class="mb-3 text-xs text-[var(--muted)]">In the feed Buddy polls. It relays each to the responsible repo's live cc session, then claims it.</div>
            {data.pending.length === 0 ? (
              <Empty msg="Nothing waiting. Push an issue from its detail, or a high-severity spike lands here automatically." />
            ) : (
              <div class="divide-y" style={{ borderColor: 'var(--border)' }}>
                {data.pending.map((p) => (
                  <div key={p.incident_id} class="flex items-center justify-between gap-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
                    <div class="min-w-0">
                      <div class="truncate text-sm font-medium">{p.issue.title}</div>
                      <div class="text-xs text-[var(--muted)]">{p.repo}{p.issue.release ? ` · ${p.issue.release}` : ''} · {p.issue.occurrences} events</div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2 text-xs">
                      {p.manual && <Badge tone="primary">manual</Badge>}
                      <Badge tone={SEV_TONE[p.severity] ?? 'muted'}>{p.severity}</Badge>
                      <span class="text-[var(--muted)]">{fmtRel(p.opened_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* pushed / claimed history */}
          <Card class="overflow-x-auto p-0">
            <div class="px-4 pt-4 text-sm font-medium">History</div>
            <div class="px-4 pb-3 text-xs text-[var(--muted)]">Everything relayed — manual pushes and auto spikes — with the session that claimed it.</div>
            {data.history.length === 0 ? (
              <div class="px-4 pb-4"><Empty msg="No remediations yet." /></div>
            ) : (
              <table class="w-full text-sm">
                <thead class="text-left text-xs text-[var(--muted)]">
                  <tr>
                    <th class="px-4 py-2 font-medium">Issue</th>
                    <th class="px-4 py-2 font-medium">Project</th>
                    <th class="px-4 py-2 font-medium">Trigger</th>
                    <th class="px-4 py-2 font-medium">Claimed by</th>
                    <th class="px-4 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.incident_id} class="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td class="px-4 py-2">
                        <div class="font-medium">{h.title}</div>
                        <Badge tone={SEV_TONE[h.severity] ?? 'muted'}>{h.severity}</Badge>
                      </td>
                      <td class="px-4 py-2">{h.project_name}</td>
                      <td class="px-4 py-2">
                        <Badge tone={h.manual ? 'primary' : 'muted'}>{h.manual ? 'manual' : 'auto'}</Badge>
                      </td>
                      <td class="px-4 py-2">
                        {h.relay_session ? <Badge tone="ok">{h.relay_session}</Badge> : <span class="text-[var(--muted)]">awaiting</span>}
                      </td>
                      <td class="px-4 py-2 text-[var(--muted)]">{fmtRel(h.claimed_at ?? h.requested_at ?? h.opened_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
