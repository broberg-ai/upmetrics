import { useState } from 'preact/hooks';
import { Plus } from 'lucide-preact';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { usd, dkk } from '../lib/format';
import { Card, Badge, StatusDot, Button } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { Modal } from '../components/ui/modal';
import { useToast } from '../components/ui/toast';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';

const PLATFORMS = [
  { value: 'web', label: 'Web' },
  { value: 'node', label: 'Node' },
  { value: 'capacitor', label: 'Capacitor' },
  { value: 'native', label: 'Native' },
];

function CredField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div>
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-[var(--muted)]">{label}</span>
        <button
          type="button"
          onClick={async () => {
            try { await navigator.clipboard.writeText(value); toast('Copied', 'success'); } catch { toast('Copy failed', 'error'); }
          }}
          class="rounded-md border px-2 py-0.5 text-xs transition hover:bg-[var(--surface-2)] active:scale-95"
          style={{ borderColor: 'var(--border)' }}
        >
          Copy
        </button>
      </div>
      <code class="block break-all rounded-md border px-3 py-1.5 text-xs" style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>{value}</code>
    </div>
  );
}

// F015 — create a project ("customer") from the UI. On success the key is shown
// ONCE for copying into the repo's secret.
function NewProject({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [idRaw, setIdRaw] = useState('');
  const [platform, setPlatform] = useState('web');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ project: { id: string }; dsn: string; api_key: string } | null>(null);
  const slug = (idRaw || name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const input = 'mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]';

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ project: { id: string }; dsn: string; api_key: string }>('/dashboard/projects', {
        method: 'POST',
        body: JSON.stringify({ id: slug, name: name.trim() || slug, platform }),
      });
      setCreated(r);
      toast('Project created', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={created ? `Project “${created.project.id}” created` : 'New project'}>
      {created ? (
        <div data-testid="new-project-created" class="space-y-3 text-sm">
          <p class="text-[var(--muted)]">Copy these into the repo. The API key is a secret — store it as the repo's <code>UPMETRICS_API_KEY</code> (Fly secret / .env). You can re-reveal it later on the project page.</p>
          <CredField label="DSN → UPMETRICS_DSN" value={created.dsn} />
          <CredField label="API key → UPMETRICS_API_KEY" value={created.api_key} />
          <div class="flex justify-end gap-2 pt-1">
            <a href={`/projects/${created.project.id}`} class="inline-flex items-center rounded-md border px-3 py-1.5 text-sm transition hover:bg-[var(--surface-2)]" style={{ borderColor: 'var(--border)' }}>Go to project</a>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div class="space-y-3">
          <label class="block">
            <span class="text-sm font-medium">Name</span>
            <input data-testid="new-project-name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Acme Corp" class={input} style={{ background: 'var(--bg)', borderColor: 'var(--border)' }} />
          </label>
          <label class="block">
            <span class="text-sm font-medium">Slug (project id)</span>
            <input data-testid="new-project-slug" value={idRaw} onInput={(e) => setIdRaw((e.target as HTMLInputElement).value)} placeholder={slug || 'acme-corp'} class={input} style={{ background: 'var(--bg)', borderColor: 'var(--border)' }} />
            <span class="mt-1 block text-xs text-[var(--muted)]">lowercase [a-z0-9-]; used in the DSN + as the project id{slug ? ` → "${slug}"` : ''}.</span>
          </label>
          <div>
            <span class="text-sm font-medium">Platform</span>
            <div class="mt-1"><CustomSelect value={platform} options={PLATFORMS} onChange={setPlatform} /></div>
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="new-project-create" loading={busy} disabled={!slug} onClick={create}>Create</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface Proj {
  id: string;
  name: string;
  platform: string;
  probe_up_pct: number | null;
  probe_total: number;
  open_issues: number;
  open_incidents: number;
  agent_cost_today: number;
  agent_cost_total: number;
  status: 'ok' | 'degraded' | 'down';
}
interface OverviewData {
  projects: Proj[];
  totals: { projects: number; open_issues: number; open_incidents: number; agent_cost_today: number; agent_cost_total: number };
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
  const [newOpen, setNewOpen] = useState(false);

  return (
    <div data-testid="overview-root">
      <PageHeader
        title="Overview"
        subtitle="Health across all projects"
        right={<Button data-testid="new-project-btn" onClick={() => setNewOpen(true)}><Plus size={14} /> New project</Button>}
      />
      {newOpen && <NewProject onClose={() => setNewOpen(false)} />}
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data || data.projects.length === 0 ? (
        <Empty msg="No projects yet. Point an SDK at upmetrics to start." />
      ) : (
        <div class="space-y-6">
          {/* totals strip */}
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <Metric label="Projects" value={data.totals.projects} />
            </Card>
            <Card>
              <Metric label="Open issues" value={data.totals.open_issues} tone={data.totals.open_issues ? 'warn' : undefined} />
            </Card>
            <Card>
              <Metric label="Open incidents" value={data.totals.open_incidents} tone={data.totals.open_incidents ? 'down' : undefined} />
            </Card>
            <Card>
              <Metric label="Fleet agent cost" value={`${usd(data.totals.agent_cost_total)} · ${dkk(data.totals.agent_cost_total)}`} />
              <div class="mt-0.5 text-xs text-[var(--muted)]">{usd(data.totals.agent_cost_today)} · {dkk(data.totals.agent_cost_today)} today</div>
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
                  <div class="mt-3 flex items-center justify-between border-t pt-2 text-xs" style={{ borderColor: 'var(--border)' }}>
                    <span class="text-[var(--muted)]">Agent cost</span>
                    <span class="font-medium">{usd(p.agent_cost_total)}</span>
                  </div>
                </Card>
              </a>
            ))}
          </div>

          {/* global matrix — desktop only; the stacked project cards above cover it on mobile */}
          <Card class="hidden overflow-x-auto sm:block">
            <div class="mb-3 text-sm font-medium">Global matrix</div>
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th class="pb-2 font-medium">Project</th>
                  <th class="pb-2 font-medium">Status</th>
                  <th class="pb-2 font-medium">Probes</th>
                  <th class="pb-2 font-medium">Issues</th>
                  <th class="pb-2 font-medium">Incidents</th>
                  <th class="pb-2 font-medium">Agent cost</th>
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
                    <td class="py-2">{usd(p.agent_cost_total)}</td>
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
