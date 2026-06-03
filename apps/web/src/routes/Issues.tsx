import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Send, Github, Copy, Check } from 'lucide-preact';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { fmtDate, fmtRel } from '../lib/format';
import { Card, Badge, Button } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { Modal } from '../components/ui/modal';
import { StackTrace } from '../components/StackTrace';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';
import { useToast } from '../components/ui/toast';

interface Issue {
  id: string;
  projectId: string;
  title: string;
  culprit: string | null;
  status: 'unresolved' | 'resolved' | 'ignored';
  level: string;
  eventCount: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  assignee: string | null;
}
interface EventRow {
  id: string;
  occurredAt: string;
  payload: {
    exception?: { values?: { type?: string; value?: string; stacktrace?: { frames?: any[] } }[] };
    breadcrumbs?: { message?: string; category?: string; timestamp?: number }[];
    tags?: Record<string, string>;
  };
}
interface AgentRunRow {
  id: string;
  agentName: string;
  status: string;
  startedAt: string;
}
interface Detail {
  issue: Issue;
  events: EventRow[];
  related_agent_runs: AgentRunRow[];
  github_repo: string | null;
}

const LEVEL_TONE: Record<string, 'down' | 'warn' | 'muted'> = { error: 'down', warning: 'warn', fatal: 'down', info: 'muted' };
const STATUS_TONE: Record<string, 'warn' | 'ok' | 'muted'> = { unresolved: 'warn', resolved: 'ok', ignored: 'muted' };

export function Issues() {
  const { query } = useLocation();
  const projects = useApi<{ projects: { id: string; name: string }[] }>('/dashboard/projects');
  const [project, setProject] = useState<string | null>(query?.project ?? null);
  const projName = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const [status, setStatus] = useState<string | null>('unresolved');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const qs = new URLSearchParams();
  if (project) qs.set('project', project);
  if (status) qs.set('status', status);
  if (q.trim()) qs.set('q', q.trim());
  const list = useApi<{ issues: Issue[] }>(`/dashboard/issues?${qs.toString()}`);

  const projectOpts = [{ value: '', label: 'All projects' }, ...(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))];
  const statusOpts = [
    { value: '', label: 'All statuses' },
    { value: 'unresolved', label: 'Unresolved' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'ignored', label: 'Ignored' },
  ];

  return (
    <div data-testid="issues-root">
      <PageHeader title="Issues" subtitle="Grouped errors across projects" />
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <CustomSelect value={project ?? ''} options={projectOpts} onChange={(v) => setProject(v || null)} />
        <CustomSelect value={status ?? ''} options={statusOpts} onChange={(v) => setStatus(v || null)} />
        <input
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Search title…"
          class="rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
        />
      </div>

      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox msg={list.error} />
      ) : !list.data || list.data.issues.length === 0 ? (
        <Empty msg="No issues match." />
      ) : (
        <>
          {/* mobile: stacked cards */}
          <div class="space-y-2 sm:hidden">
            {list.data.issues.map((i) => (
              <Card key={i.id} onClick={() => setSel(i.id)} class="cursor-pointer overflow-hidden active:scale-[0.99]">
                <div class="break-words font-medium">{i.title}</div>
                {i.culprit && <div class="mb-2 break-all text-xs text-[var(--muted)]">{i.culprit}</div>}
                <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-[var(--muted)]">{projName.get(i.projectId) ?? i.projectId}</span>
                  <Badge tone={LEVEL_TONE[i.level] ?? 'muted'}>{i.level}</Badge>
                  <Badge tone={STATUS_TONE[i.status] ?? 'muted'}>{i.status}</Badge>
                  <span class="text-[var(--muted)]">{i.eventCount} events</span>
                  <span class="ml-auto text-[var(--muted)]">{fmtRel(i.lastSeen)}</span>
                </div>
              </Card>
            ))}
          </div>
          {/* desktop: table */}
          <Card class="hidden overflow-x-auto p-0 sm:block">
          <table class="w-full text-sm">
            <thead class="text-left text-xs text-[var(--muted)]">
              <tr>
                <th class="px-4 py-2 font-medium">Issue</th>
                <th class="px-4 py-2 font-medium">Project</th>
                <th class="px-4 py-2 font-medium">Level</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Events</th>
                <th class="px-4 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {list.data.issues.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setSel(i.id)}
                  class="cursor-pointer border-t hover:bg-[var(--surface-2)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td class="px-4 py-2">
                    <div class="font-medium">{i.title}</div>
                    {i.culprit && <div class="text-xs text-[var(--muted)]">{i.culprit}</div>}
                  </td>
                  <td class="px-4 py-2 text-[var(--muted)]">{projName.get(i.projectId) ?? i.projectId}</td>
                  <td class="px-4 py-2">
                    <Badge tone={LEVEL_TONE[i.level] ?? 'muted'}>{i.level}</Badge>
                  </td>
                  <td class="px-4 py-2">
                    <Badge tone={STATUS_TONE[i.status] ?? 'muted'}>{i.status}</Badge>
                  </td>
                  <td class="px-4 py-2">{i.eventCount}</td>
                  <td class="px-4 py-2 text-[var(--muted)]">{fmtRel(i.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </Card>
        </>
      )}

      {sel && <IssueDetail id={sel} onClose={() => setSel(null)} onChanged={() => list.reload()} />}
    </div>
  );
}

function IssueDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { loading, data, error, reload } = useApi<Detail>(`/dashboard/issues/${id}`);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const [assignee, setAssignee] = useState('');
  const [copied, setCopied] = useState(false);
  const setStatus = async (status: string) => {
    setBusy(true);
    try {
      await api(`/dashboard/issues/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      toast(`Issue ${status}`, 'success');
      reload();
      onChanged();
    } catch {
      toast('Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  const assign = async () => {
    setBusy(true);
    try {
      await api(`/dashboard/issues/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignee: assignee.trim() || null }) });
      toast(assignee.trim() ? `Assigned to ${assignee.trim()}` : 'Unassigned', 'success');
      reload();
      onChanged();
    } catch {
      toast('Assign failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  const pushRemediation = async () => {
    setBusy(true);
    try {
      const r = await api<{ already_claimed?: boolean }>(`/dashboard/issues/${id}/push-remediation`, { method: 'POST' });
      toast(r.already_claimed ? 'Already claimed by a session' : 'Pushed to remediation → Buddy relays it', 'success');
    } catch {
      toast('Push failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const latest = data?.events[0];
  const exc = latest?.payload?.exception?.values?.[0];
  const breadcrumbs = latest?.payload?.breadcrumbs ?? [];
  const tags = latest?.payload?.tags ?? {};

  // Copy the full error context (title + type:value + stack + tags + link) as
  // plain text — paste into a chat / GitHub issue without retyping.
  const copyDetails = async () => {
    if (!data) return;
    const i = data.issue;
    const frames = (exc?.stacktrace?.frames ?? []) as Array<{ function?: string; filename?: string; module?: string; lineno?: number; colno?: number }>;
    const text = [
      i.title,
      exc ? `${exc.type}: ${exc.value ?? ''}` : '',
      ...[...frames].reverse().map((f) => `  ${f.function || '?'} @ ${f.filename || f.module || '?'}${f.lineno ? `:${f.lineno}` : ''}${f.colno ? `:${f.colno}` : ''}`),
      Object.keys(tags).length ? `tags: ${Object.entries(tags).map(([k, v]) => `${k}=${String(v)}`).join(' ')}` : '',
      `${i.eventCount} events · first ${fmtDate(i.firstSeen)} · last ${fmtDate(i.lastSeen)}`,
      `${location.origin}/issues?project=${i.projectId}`,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast('Copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Copy failed', 'error');
    }
  };

  return (
    <Modal open onClose={onClose} title={data?.issue.title ?? 'Issue'}>
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox msg={error ?? 'Not found'} />
      ) : (
        <div class="space-y-4">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={STATUS_TONE[data.issue.status] ?? 'muted'}>{data.issue.status}</Badge>
            <Badge tone={LEVEL_TONE[data.issue.level] ?? 'muted'}>{data.issue.level}</Badge>
            <span class="text-[var(--muted)]">
              {data.issue.eventCount} events · {data.issue.userCount} users · first {fmtDate(data.issue.firstSeen)} · last {fmtDate(data.issue.lastSeen)}
            </span>
          </div>

          {exc && (
            <div>
              <div class="mb-1 text-sm font-medium">
                {exc.type}: <span class="text-[var(--muted)]">{exc.value}</span>
              </div>
              <StackTrace frames={exc.stacktrace?.frames} />
            </div>
          )}

          {breadcrumbs.length > 0 && (
            <div>
              <div class="mb-1 text-sm font-medium">Breadcrumbs</div>
              <div class="space-y-1 text-xs text-[var(--muted)]">
                {breadcrumbs.slice(-8).map((b, i) => (
                  <div key={i}>
                    [{b.category ?? 'log'}] {b.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.keys(tags).length > 0 && (
            <div class="flex flex-wrap gap-1">
              {Object.entries(tags).map(([k, v]) => (
                <Badge key={k} tone="muted">
                  {k}={String(v)}
                </Badge>
              ))}
            </div>
          )}

          {data.related_agent_runs.length > 0 && (
            <div>
              <div class="mb-1 text-sm font-medium">Related agent runs</div>
              <div class="space-y-1 text-xs">
                {data.related_agent_runs.map((r) => (
                  <div key={r.id} class="flex justify-between">
                    <span>{r.agentName}</span>
                    <span class="text-[var(--muted)]">
                      {r.status} · {fmtRel(r.startedAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div class="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <Button variant="primary" loading={busy} onClick={() => setStatus('resolved')}>
              Resolve
            </Button>
            <Button variant="outline" loading={busy} onClick={() => setStatus('ignored')}>
              Ignore
            </Button>
            <Button variant="ghost" loading={busy} onClick={() => setStatus('unresolved')}>
              Reopen
            </Button>
            <Button variant="ghost" onClick={copyDetails} title="Copy the error + stack as text">
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </Button>
            {data.github_repo && (
              <a
                href={`https://github.com/${data.github_repo}/issues/new?title=${encodeURIComponent(data.issue.title)}&body=${encodeURIComponent(`Culprit: ${data.issue.culprit ?? '—'}\nLevel: ${data.issue.level}\nFirst seen: ${data.issue.firstSeen}\n\nupmetrics issue: ${location.origin}/issues?project=${data.issue.projectId}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-[var(--surface-2)] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                style={{ borderColor: 'var(--border)' }}
                title={`Open a prefilled new issue on github.com/${data.github_repo}`}
              >
                <Github size={14} /> Create GitHub issue
              </a>
            )}
            <Button variant="outline" loading={busy} onClick={pushRemediation} class="ml-auto" title="Send this issue to Buddy → a cc session fixes it">
              <Send size={14} /> Push to remediation
            </Button>
          </div>

          <div class="flex items-center gap-2">
            <input
              value={assignee}
              onInput={(e) => setAssignee((e.target as HTMLInputElement).value)}
              placeholder={data.issue.assignee ? `Assigned: ${data.issue.assignee}` : 'Assign to (email)…'}
              class="flex-1 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
            <Button variant="outline" loading={busy} onClick={assign}>
              Assign
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
