import { useState } from 'preact/hooks';
import * as Recharts from 'recharts';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { fmtDate, fmtRel } from '../lib/format';
import { Card, Badge, Button, StatusDot } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { Modal } from '../components/ui/modal';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';
import { useToast } from '../components/ui/toast';

// recharts React types don't satisfy Preact JSX; use as any (renders via compat).
const { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } = Recharts as any;

interface Result {
  ok: boolean;
  responseMs: number | null;
  checkedAt: string;
}
interface Probe {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  target: string;
  status: 'up' | 'down' | 'degraded' | 'paused';
  lastResponseMs: number | null;
  consecutiveFailures: number;
  recent: Result[];
}

const STATUS_TONE: Record<Probe['status'], 'ok' | 'down' | 'warn' | 'muted'> = { up: 'ok', down: 'down', degraded: 'warn', paused: 'muted' };

function Sparkline({ data }: { data: Result[] }) {
  if (data.length === 0) return <div class="h-6 text-xs text-[var(--muted)]">no data</div>;
  const max = Math.max(...data.map((d) => d.responseMs ?? 0), 1);
  return (
    <div class="flex h-6 items-end gap-0.5">
      {data.map((d, i) => (
        <div
          key={i}
          class="w-1 rounded-sm"
          style={{ height: `${Math.max(10, ((d.responseMs ?? 0) / max) * 100)}%`, background: d.ok ? 'var(--ok)' : 'var(--down)' }}
          title={`${d.ok ? 'ok' : 'fail'} ${d.responseMs ?? '—'}ms`}
        />
      ))}
    </div>
  );
}

export function Probes() {
  const { loading, data, error, reload } = useApi<{ probes: Probe[] }>('/dashboard/probes');
  const [sel, setSel] = useState<string | null>(null);

  return (
    <div data-testid="probes-root">
      <PageHeader title="Probes" subtitle="Uptime checks (executed by cronjobs, Model A)" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data || data.probes.length === 0 ? (
        <Empty msg="No probes yet. Create one via POST /api/probes." />
      ) : (
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.probes.map((p) => (
            <Card key={p.id} class="cursor-pointer hover:brightness-105" onClick={() => setSel(p.id)}>
              <div class="mb-2 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <StatusDot tone={STATUS_TONE[p.status]} />
                  <span class="font-medium">{p.name}</span>
                </div>
                <Badge tone="muted">{p.kind}</Badge>
              </div>
              <div class="mb-2 truncate text-xs text-[var(--muted)]">{p.target}</div>
              <div class="flex items-end justify-between">
                <Sparkline data={p.recent} />
                <span class="text-xs text-[var(--muted)]">{p.lastResponseMs != null ? `${p.lastResponseMs}ms` : '—'}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
      {sel && <ProbeDetail id={sel} onClose={() => setSel(null)} onChanged={() => reload()} />}
    </div>
  );
}

function ProbeDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { loading, data, error, reload } = useApi<{ probe: Probe; history: Result[]; last_failure: Result | null }>(`/dashboard/probes/${id}`);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', target: '', interval: '300', expected: '' });
  const toast = useToast();

  const INTERVALS = [
    { value: '60', label: 'Every 1 min' },
    { value: '300', label: 'Every 5 min' },
    { value: '600', label: 'Every 10 min' },
    { value: '1800', label: 'Every 30 min' },
    { value: '3600', label: 'Every hour' },
  ];
  const openEdit = (p: Probe) => {
    const raw = p as unknown as { intervalSeconds?: number; config?: { expected_status?: number } };
    setForm({
      name: p.name,
      target: p.target,
      interval: String(raw.intervalSeconds ?? 300),
      expected: raw.config?.expected_status != null ? String(raw.config.expected_status) : '',
    });
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api(`/dashboard/probes/${id}`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          target: form.target,
          interval_seconds: Number(form.interval),
          ...(form.expected.trim() ? { config: { expected_status: Number(form.expected) } } : {}),
        }),
      });
      toast('Probe updated', 'success');
      setEditing(false);
      reload();
      onChanged();
    } catch {
      toast('Update failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async (path: string, method = 'POST') => {
    setBusy(true);
    try {
      await api(`/dashboard/probes/${id}${path}`, { method });
      toast('Done', 'success');
      reload();
      onChanged();
    } catch {
      toast('Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api(`/dashboard/probes/${id}`, { method: 'DELETE' });
      toast('Probe deleted', 'success');
      onChanged();
      onClose();
    } catch {
      toast('Delete failed', 'error');
      setBusy(false);
    }
  };

  const chartData = (data?.history ?? []).map((r) => ({ t: new Date(r.checkedAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }), ms: r.responseMs ?? 0 }));

  return (
    <Modal open onClose={onClose} title={data?.probe.name ?? 'Probe'}>
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox msg={error ?? 'Not found'} />
      ) : (
        <div class="space-y-4 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <StatusDot tone={STATUS_TONE[data.probe.status]} />
            <span class="font-medium capitalize">{data.probe.status}</span>
            <Badge tone="muted">{data.probe.kind}</Badge>
            <span class="text-[var(--muted)] truncate">{data.probe.target}</span>
          </div>

          {chartData.length > 0 && (
            <div style={{ height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--muted)' }} minTickGap={30} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} width={36} />
                  <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Line type="monotone" dataKey="ms" stroke="var(--primary)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {data.last_failure && (
            <div class="rounded-md border p-2 text-xs" style={{ borderColor: 'var(--down)' }}>
              <span style={{ color: 'var(--down)' }}>Last failure</span> · {fmtDate(data.last_failure.checkedAt)} · {(data.last_failure as any).error ?? `HTTP ${(data.last_failure as any).statusCode ?? '?'}`}
            </div>
          )}

          {editing && (
            <div class="space-y-2 rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
              <div class="text-sm font-medium">Edit probe</div>
              <input
                value={form.name}
                onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
                placeholder="Name"
                class="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              />
              <input
                value={form.target}
                onInput={(e) => setForm({ ...form, target: (e.target as HTMLInputElement).value })}
                placeholder="Target URL"
                class="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              />
              <div class="flex flex-wrap gap-2">
                <CustomSelect value={form.interval} options={INTERVALS} onChange={(v) => setForm({ ...form, interval: v })} />
                <input
                  value={form.expected}
                  onInput={(e) => setForm({ ...form, expected: (e.target as HTMLInputElement).value })}
                  placeholder="Expected status (e.g. 200)"
                  class="w-40 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                />
              </div>
              <div class="flex gap-2">
                <Button variant="primary" loading={busy} onClick={save}>
                  Save changes
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div class="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            {data.probe.status === 'paused' ? (
              <Button variant="primary" loading={busy} onClick={() => act('/resume')}>
                Resume
              </Button>
            ) : (
              <Button variant="outline" loading={busy} onClick={() => act('/pause')}>
                Pause
              </Button>
            )}
            {!editing && (
              <Button variant="outline" onClick={() => openEdit(data.probe)}>
                Edit
              </Button>
            )}
            {confirmDel ? (
              <Button variant="danger" loading={busy} onClick={del}>
                Confirm delete
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDel(true)}>
                Delete
              </Button>
            )}
            <span class="ml-auto self-center text-xs text-[var(--muted)]">last checked {fmtRel(data.history[data.history.length - 1]?.checkedAt)}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
