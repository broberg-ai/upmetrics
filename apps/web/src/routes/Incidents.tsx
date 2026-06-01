import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { fmtDate, fmtRel } from '../lib/format';
import { Card, Badge, Button } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { Modal } from '../components/ui/modal';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';
import { useToast } from '../components/ui/toast';

interface Incident {
  id: string;
  projectId: string;
  kind: string;
  status: 'open' | 'acknowledged' | 'resolved';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  openedAt: string;
  resolvedAt: string | null;
  remediationAttempts: {
    token?: string;
    delivered?: boolean;
    attempts?: { at: string; attempt: number; status?: number; ok?: boolean; error?: string }[];
    callbacks?: { at: string; status: string; detail?: string }[];
  } | null;
}
interface Detail {
  incident: Incident;
  trigger_events: { id: string; kind: string; occurredAt: string }[];
}

const SEV_TONE: Record<string, 'down' | 'warn' | 'muted'> = { critical: 'down', high: 'down', medium: 'warn', low: 'muted' };
const STATUS_TONE: Record<string, 'down' | 'warn' | 'ok'> = { open: 'down', acknowledged: 'warn', resolved: 'ok' };

export function Incidents() {
  const { query } = useLocation();
  const [status, setStatus] = useState<string | null>('open');
  // Deep-link from a Discord alert: /incidents?id=<incidentId> opens it (F012).
  const [sel, setSel] = useState<string | null>(query?.id ?? null);
  const qs = status ? `?status=${status}` : '';
  const list = useApi<{ incidents: Incident[] }>(`/dashboard/incidents${qs}`);

  const statusOpts = [
    { value: '', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'acknowledged', label: 'Acknowledged' },
    { value: 'resolved', label: 'Resolved' },
  ];

  return (
    <div data-testid="incidents-root">
      <PageHeader
        title="Incidents"
        subtitle="Correlated incidents + remediation"
        right={<CustomSelect value={status ?? ''} options={statusOpts} onChange={(v) => setStatus(v || null)} />}
      />
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox msg={list.error} />
      ) : !list.data || list.data.incidents.length === 0 ? (
        <Empty msg="No incidents match." />
      ) : (
        <Card class="overflow-x-auto p-0">
          <table class="w-full text-sm">
            <thead class="text-left text-xs text-[var(--muted)]">
              <tr>
                <th class="px-4 py-2 font-medium">Incident</th>
                <th class="px-4 py-2 font-medium">Kind</th>
                <th class="px-4 py-2 font-medium">Severity</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody>
              {list.data.incidents.map((i) => (
                <tr key={i.id} onClick={() => setSel(i.id)} class="cursor-pointer border-t hover:bg-[var(--surface-2)]" style={{ borderColor: 'var(--border)' }}>
                  <td class="px-4 py-2 font-medium">{i.title}</td>
                  <td class="px-4 py-2 text-[var(--muted)]">{i.kind}</td>
                  <td class="px-4 py-2">
                    <Badge tone={SEV_TONE[i.severity] ?? 'muted'}>{i.severity}</Badge>
                  </td>
                  <td class="px-4 py-2">
                    <Badge tone={STATUS_TONE[i.status] ?? 'muted'}>{i.status}</Badge>
                  </td>
                  <td class="px-4 py-2 text-[var(--muted)]">{fmtRel(i.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {sel && <IncidentDetail id={sel} onClose={() => setSel(null)} onChanged={() => list.reload()} />}
    </div>
  );
}

function IncidentDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { loading, data, error, reload } = useApi<Detail>(`/dashboard/incidents/${id}`);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const setStatus = async (status: string) => {
    setBusy(true);
    try {
      await api(`/dashboard/incidents/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      toast(`Incident ${status}`, 'success');
      reload();
      onChanged();
    } catch {
      toast('Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  const remediate = async () => {
    setBusy(true);
    try {
      await api(`/dashboard/incidents/${id}/remediate`, { method: 'POST' });
      toast('Remediation dispatched', 'success');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Remediation failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const ra = data?.incident.remediationAttempts;

  return (
    <Modal open onClose={onClose} title={data?.incident.title ?? 'Incident'}>
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox msg={error ?? 'Not found'} />
      ) : (
        <div class="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <Badge tone={SEV_TONE[data.incident.severity] ?? 'muted'}>{data.incident.severity}</Badge>
            <Badge tone={STATUS_TONE[data.incident.status] ?? 'muted'}>{data.incident.status}</Badge>
            <span class="text-[var(--muted)]">{data.incident.kind} · opened {fmtDate(data.incident.openedAt)}{data.incident.resolvedAt ? ` · resolved ${fmtDate(data.incident.resolvedAt)}` : ''}</span>
          </div>

          {/* remediation timeline */}
          <div>
            <div class="mb-1 text-sm font-medium">Remediation</div>
            {!ra ? (
              <p class="text-xs text-[var(--muted)]">Not dispatched.</p>
            ) : (
              <div class="space-y-1 text-xs">
                <div class={ra.delivered ? '' : 'text-[var(--warn)]'}>Delivered: {String(ra.delivered)}</div>
                {(ra.attempts ?? []).map((a, i) => (
                  <div key={i} class="text-[var(--muted)]">
                    attempt {a.attempt} · {fmtDate(a.at)} · {a.error ? `error: ${a.error}` : `HTTP ${a.status}`}
                  </div>
                ))}
                {(ra.callbacks ?? []).map((cb, i) => (
                  <div key={`cb${i}`} style={{ color: 'var(--ok)' }}>
                    callback · {fmtDate(cb.at)} · {cb.status}
                    {cb.detail ? ` — ${cb.detail}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* trigger events */}
          {data.trigger_events.length > 0 && (
            <div>
              <div class="mb-1 text-sm font-medium">Recent events</div>
              <div class="space-y-1 text-xs text-[var(--muted)]">
                {data.trigger_events.map((e) => (
                  <div key={e.id}>
                    {e.kind} · {fmtRel(e.occurredAt)}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div class="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <Button variant="outline" loading={busy} onClick={() => setStatus('acknowledged')}>
              Acknowledge
            </Button>
            <Button variant="primary" loading={busy} onClick={() => setStatus('resolved')}>
              Resolve
            </Button>
            <Button variant="ghost" loading={busy} onClick={remediate}>
              Re-run remediation
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
