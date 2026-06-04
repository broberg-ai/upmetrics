import { useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, ArrowLeft, Copy, Check, Eye, EyeOff } from 'lucide-preact';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { Card, Badge, StatusDot, Spinner, Button, Toggle } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { Modal } from '../components/ui/modal';
import { useToast } from '../components/ui/toast';
import { Loading, ErrorBox, PageHeader } from '../components/PageState';
import { fmtRel, fmtDate, usd } from '../lib/format';

interface Component {
  release: string;
  environment: string | null;
  total: number;
  errors: number;
  last_seen: number | null;
  sdk_version: string | null;
}
interface Enrollment {
  enabled: boolean;
  repo: string | null;
  github_repo: string | null;
  severity: string | null; // null = inherit global
  effective_severity: string;
}
interface Detail {
  project: { id: string; name: string; platform: string };
  open_issues: number;
  open_incidents: number;
  total_events: number;
  cost_today: number;
  cost_total: number;
  latest_sdk_version: string | null;
  components: Component[];
  remediation: Enrollment;
  credentials: { dsn: string; api_key: string };
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

const SEVERITY_OPTIONS = [
  { value: '', label: 'Inherit global default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

// F010.5 — self-service remediation enrollment. Toggle the auto-relay opt-in, set
// the repo basename Buddy routes on, and override the severity gate per project.
function RemediationSettings({ id, initial }: { id: string; initial: Enrollment }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [repo, setRepo] = useState(initial.repo ?? '');
  const [severity, setSeverity] = useState(initial.severity ?? '');
  const [effective, setEffective] = useState(initial.effective_severity);
  const [busy, setBusy] = useState(false);
  const dirty = enabled !== initial.enabled || repo !== (initial.repo ?? '') || severity !== (initial.severity ?? '');

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<Enrollment>(`/dashboard/projects/${id}/remediation`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled, repo: repo.trim() || null, severity: severity || null }),
      });
      setEnabled(r.enabled);
      setRepo(r.repo ?? '');
      setSeverity(r.severity ?? '');
      setEffective(r.effective_severity);
      toast('Remediation settings saved', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div class="mb-1 text-sm font-medium">Auto-remediation</div>
      <div class="mb-4 text-xs text-[var(--muted)]">
        When enabled, qualifying error spikes here are relayed to Buddy → a cc session in the repo below. “Push to remediation” on an issue always works regardless of this.
      </div>
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-medium">Auto-relay enabled</div>
            <div class="text-xs text-[var(--muted)]">Off → only manual pushes relay.</div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="Auto-relay enabled" />
        </div>

        <div>
          <div class="text-sm font-medium">Repo</div>
          <div class="mb-1.5 text-xs text-[var(--muted)]">Basename Buddy routes on (e.g. <code>trail</code>, <code>fysiodk-aalborg-sport</code>).</div>
          <input
            value={repo}
            onInput={(e) => setRepo((e.target as HTMLInputElement).value)}
            placeholder="repo-basename"
            class="w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          />
        </div>

        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-medium">Min severity to auto-relay</div>
            <div class="text-xs text-[var(--muted)]">Effective: {effective}</div>
          </div>
          <CustomSelect value={severity} options={SEVERITY_OPTIONS} onChange={setSeverity} placeholder="Inherit global default" />
        </div>

        {enabled && !repo.trim() && (
          <div class="text-xs" style={{ color: 'var(--warn)' }}>Set a repo or auto-relay can’t route — nothing fires.</div>
        )}

        <div class="flex justify-end">
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CopyBtn({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast(`${label} copied`, 'success');
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast('Copy failed', 'error');
        }
      }}
      class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition hover:bg-[var(--surface-2)] active:scale-95"
      style={{ borderColor: 'var(--border)' }}
      title={`Copy ${label}`}
    >
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

// F015 — DSN (public, error/RUM) + api_key (secret, the X-Upmetrics-Key for
// cost/issues/enrollment). Reveal/copy/rotate. Session-authed page, so the secret
// is safe to reveal to the logged-in operator.
function Credentials({ id, initial }: { id: string; initial: { dsn: string; api_key: string } }) {
  const toast = useToast();
  const [key, setKey] = useState(initial.api_key);
  const [revealed, setRevealed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const masked = `${key.slice(0, 7)}${'•'.repeat(16)}`;
  const btn = 'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition hover:bg-[var(--surface-2)] active:scale-95';

  const rotate = async () => {
    setBusy(true);
    try {
      const r = await api<{ api_key: string }>(`/dashboard/projects/${id}/rotate-key`, { method: 'POST' });
      setKey(r.api_key);
      setRevealed(true);
      setConfirm(false);
      toast('API key rotated — update the repo secret', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Rotate failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="credentials-card">
      <div class="mb-1 text-sm font-medium">Credentials</div>
      <div class="mb-4 text-xs text-[var(--muted)]">
        <b>DSN</b> = error/RUM capture (public, safe client-side). <b>API key</b> = <code>X-Upmetrics-Key</code> for cost, issues + enrollment — a secret; store it in the repo's <code>.env</code> / Fly secret as <code>UPMETRICS_API_KEY</code>.
      </div>
      <div class="space-y-3">
        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-sm font-medium">DSN</span>
            <CopyBtn value={initial.dsn} label="DSN" />
          </div>
          <code class="block break-all rounded-md border px-3 py-1.5 text-xs text-[var(--muted)]" style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>{initial.dsn}</code>
        </div>
        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-sm font-medium">API key</span>
            <div class="flex items-center gap-2">
              <button type="button" data-testid="cred-reveal-btn" onClick={() => setRevealed((r) => !r)} class={btn} style={{ borderColor: 'var(--border)' }}>
                {revealed ? <EyeOff size={12} /> : <Eye size={12} />} {revealed ? 'Hide' : 'Reveal'}
              </button>
              <CopyBtn value={key} label="API key" />
              <button type="button" data-testid="cred-rotate-btn" onClick={() => setConfirm(true)} class={btn} style={{ borderColor: 'var(--border)', color: 'var(--down)' }}>
                Rotate
              </button>
            </div>
          </div>
          <code class="block break-all rounded-md border px-3 py-1.5 text-xs" style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>{revealed ? key : masked}</code>
        </div>
      </div>
      {confirm && (
        <Modal open onClose={() => setConfirm(false)} title="Rotate API key?">
          <p class="text-sm text-[var(--muted)]">
            The current key stops working immediately. Update the repo's <code>UPMETRICS_API_KEY</code> secret with the new value right after.
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={rotate}>
              Rotate key
            </Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export function ProjectDetail({ id }: { id?: string }) {
  const { loading, data, error } = useApi<Detail>(`/dashboard/projects/${id}`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div data-testid="project-detail-root">
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
                          {comp.sdk_version ? (
                            <span
                              style={data.latest_sdk_version && comp.sdk_version !== data.latest_sdk_version ? { color: 'var(--warn)' } : undefined}
                              title={data.latest_sdk_version && comp.sdk_version !== data.latest_sdk_version ? `outdated — newest is ${data.latest_sdk_version}` : 'SDK version'}
                            >
                              sdk {comp.sdk_version}
                            </span>
                          ) : (
                            <span title="no SDK version stamped (pre-0.1.3)">sdk —</span>
                          )}
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

          <RemediationSettings id={data.project.id} initial={data.remediation} />

          <Credentials id={data.project.id} initial={data.credentials} />
        </div>
      )}
    </div>
  );
}
