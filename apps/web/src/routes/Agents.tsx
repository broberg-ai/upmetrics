import { useState } from 'preact/hooks';
import * as Recharts from 'recharts';
// recharts ships React component types that don't satisfy Preact's JSX element
// types; treat them as `any` (they render fine at runtime via preact/compat).
const { ResponsiveContainer, BarChart, Bar, XAxis, Tooltip } = Recharts as any;
import { useApi } from '../lib/useApi';
import { fmtRel, usd } from '../lib/format';
import { Card, Badge, Button } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { DatePicker } from '../components/ui/datepicker';
import { Modal } from '../components/ui/modal';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';

interface Run {
  id: string;
  projectId: string;
  sessionId: string | null;
  agentKind: string;
  agentName: string;
  task: string;
  provider: string;
  model: string;
  tier: string | null;
  status: string;
  startedAt: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  toolCalls: { name: string; count: number; error_count?: number }[] | null;
}
interface Aggregates {
  overall: { total_runs: number; success_rate: number | null; avg_duration_ms: number; p95_duration_ms: number; max_duration_ms: number; total_cost: number };
  cost_per_day: { day: string; cost: number }[];
  runs_per_agent: { agent_name: string; runs: number; success_rate: number; avg_duration_ms: number; cost: number }[];
}

const FAIL = new Set(['error', 'timeout', 'max_turns', 'abandoned']);
const statusTone = (s: string) => (FAIL.has(s) ? 'down' : s === 'running' ? 'primary' : 'ok');
const ms = (n: number | null) => (n == null ? '—' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'down' }) {
  return (
    <Card>
      <div class="text-lg font-semibold" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      <div class="text-xs text-[var(--muted)]">{label}</div>
    </Card>
  );
}

interface Breakdown {
  group_by?: string;
  by_group?: { key: string; micro_usd: number; run_count: number }[];
}
const GROUP_DIMS = [
  { value: 'tenantId', label: 'tenant' },
  { value: 'kbId', label: 'knowledge base' },
];

// F017 — operator cost breakdown by a tag dimension (tenant/kb). Mounted only when
// a project is selected (costSummary is project-scoped). The whole dashboard is
// admin-login-only, so this is inherently operator-scoped — no cross-tenant leak.
function CostByGroup({ project }: { project: string }) {
  const [groupBy, setGroupBy] = useState('tenantId');
  const data = useApi<Breakdown>(`/dashboard/cost?project=${project}&groupBy=${groupBy}&window=week`);
  const rows = data.data?.by_group ?? [];
  const label = GROUP_DIMS.find((d) => d.value === groupBy)?.label ?? groupBy;
  return (
    <Card class="overflow-x-auto" data-testid="cost-by-group">
      <div class="mb-3 flex items-center justify-between gap-2">
        <div class="text-sm font-medium">Cost by {label} (7d)</div>
        <CustomSelect value={groupBy} options={GROUP_DIMS.map((d) => ({ value: d.value, label: d.label }))} onChange={(v) => setGroupBy(v || 'tenantId')} />
      </div>
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorBox msg={data.error} />
      ) : rows.length === 0 ? (
        <Empty msg="No tagged cost in this window." />
      ) : (
        <table class="w-full text-sm">
          <thead class="text-left text-xs text-[var(--muted)]">
            <tr>
              <th class="pb-2 font-medium capitalize">{label}</th>
              <th class="pb-2 font-medium">Runs</th>
              <th class="pb-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} class="border-t" style={{ borderColor: 'var(--border)' }}>
                <td class="py-2">{r.key}</td>
                <td class="py-2">{r.run_count}</td>
                <td class="py-2">{usd(r.micro_usd / 1_000_000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function Agents() {
  const projects = useApi<{ projects: { id: string; name: string }[] }>('/dashboard/projects');
  const [project, setProject] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [selRun, setSelRun] = useState<string | null>(null);
  const [selSession, setSelSession] = useState<string | null>(null);

  const pq = project ? `?project=${project}` : '';
  const agg = useApi<Aggregates>(`/dashboard/agents/aggregates${pq}`);

  const lq = new URLSearchParams();
  if (project) lq.set('project', project);
  if (agent) lq.set('agent', agent);
  if (status) lq.set('status', status);
  if (kind) lq.set('kind', kind);
  if (since) lq.set('since', since);
  if (until) lq.set('until', until);
  const list = useApi<{ runs: Run[] }>(`/dashboard/agents?${lq.toString()}`);

  const kindOpts = [
    { value: '', label: 'All kinds' },
    { value: 'cc', label: 'cc' },
    { value: 'subagent', label: 'subagent' },
    { value: 'chatbot', label: 'chatbot' },
    { value: 'rag', label: 'rag' },
    { value: 'embedding', label: 'embedding' },
  ];

  const projectOpts = [{ value: '', label: 'All projects' }, ...(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))];
  const agentOpts = [{ value: '', label: 'All agents' }, ...(agg.data?.runs_per_agent ?? []).map((a) => ({ value: a.agent_name, label: a.agent_name }))];
  const statusOpts = [
    { value: '', label: 'All statuses' },
    { value: 'success', label: 'Success' },
    { value: 'error', label: 'Error' },
    { value: 'timeout', label: 'Timeout' },
    { value: 'running', label: 'Running' },
  ];

  return (
    <div data-testid="agents-root">
      <PageHeader title="Agents" subtitle="AI agent telemetry — cost, sessions, tool failures" right={<CustomSelect value={project ?? ''} options={projectOpts} onChange={(v) => setProject(v || null)} />} />

      {agg.loading ? (
        <Loading />
      ) : agg.error ? (
        <ErrorBox msg={agg.error} />
      ) : agg.data ? (
        <div class="space-y-6">
          {/* overall (last 14 days) */}
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Runs (14d)" value={agg.data.overall.total_runs} />
            <Stat label="Success rate" value={agg.data.overall.success_rate == null ? '—' : `${agg.data.overall.success_rate}%`} tone={agg.data.overall.success_rate != null && agg.data.overall.success_rate < 90 ? 'warn' : undefined} />
            <Stat label="Avg duration" value={ms(agg.data.overall.avg_duration_ms)} />
            <Stat label="p95 duration" value={ms(agg.data.overall.p95_duration_ms)} tone={agg.data.overall.p95_duration_ms > 120000 ? 'warn' : undefined} />
            <Stat label="Cost (14d)" value={usd(agg.data.overall.total_cost)} />
          </div>

          {/* cost per day */}
          <Card>
            <div class="mb-2 text-sm font-medium">Cost per day (14d)</div>
            <div style={{ height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agg.data.cost_per_day}>
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--muted)' }} tickFormatter={(d: string) => d.slice(5)} />
                  <Tooltip formatter={(v: number) => usd(v)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} />
                  <Bar dataKey="cost" fill="var(--primary)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* per-agent */}
          <Card class="overflow-x-auto">
            <div class="mb-3 text-sm font-medium">Per agent (14d)</div>
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th class="pb-2 font-medium">Agent</th>
                  <th class="pb-2 font-medium">Runs</th>
                  <th class="pb-2 font-medium">Success</th>
                  <th class="pb-2 font-medium">Avg</th>
                  <th class="pb-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {agg.data.runs_per_agent.map((a) => (
                  <tr key={a.agent_name} class="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td class="py-2">{a.agent_name}</td>
                    <td class="py-2">{a.runs}</td>
                    <td class="py-2" style={{ color: a.success_rate < 90 ? 'var(--warn)' : undefined }}>{a.success_rate}%</td>
                    <td class="py-2">{ms(a.avg_duration_ms)}</td>
                    <td class="py-2">{usd(a.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* F017 — operator cost breakdown by tag dimension (tenant/kb). Project-scoped. */}
          {project ? <CostByGroup project={project} /> : (
            <Card><div class="text-sm text-[var(--muted)]">Select a project to break cost down by tenant.</div></Card>
          )}
        </div>
      ) : null}

      {/* runs list */}
      <div class="mt-8">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h2 class="mr-2 text-sm font-medium">Recent runs</h2>
          <CustomSelect value={agent ?? ''} options={agentOpts} onChange={(v) => setAgent(v || null)} />
          <CustomSelect value={status ?? ''} options={statusOpts} onChange={(v) => setStatus(v || null)} />
          <CustomSelect value={kind ?? ''} options={kindOpts} onChange={(v) => setKind(v || null)} />
          <DatePicker value={since} onChange={setSince} placeholder="From…" />
          <DatePicker value={until} onChange={setUntil} placeholder="To…" />
        </div>
        {list.loading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox msg={list.error} />
        ) : !list.data || list.data.runs.length === 0 ? (
          <Empty msg="No agent runs match." />
        ) : (
          <>
            {/* mobile: stacked cards */}
            <div class="space-y-2 sm:hidden">
              {list.data.runs.map((r) => (
                <Card key={r.id} onClick={() => setSelRun(r.id)} class="cursor-pointer active:scale-[0.99]">
                  <div class="flex items-center justify-between gap-2">
                    <span class="break-words font-medium">{r.agentName}</span>
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  </div>
                  <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                    <span>{r.model}</span>
                    <span>{ms(r.durationMs)}</span>
                    <span>{usd(r.costUsd)}</span>
                    <span class="ml-auto">{fmtRel(r.startedAt)}</span>
                  </div>
                </Card>
              ))}
            </div>
            {/* desktop: table */}
            <Card class="hidden overflow-x-auto p-0 sm:block">
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th class="px-4 py-2 font-medium">Agent</th>
                  <th class="px-4 py-2 font-medium">Model</th>
                  <th class="px-4 py-2 font-medium">Status</th>
                  <th class="px-4 py-2 font-medium">Duration</th>
                  <th class="px-4 py-2 font-medium">Cost</th>
                  <th class="px-4 py-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {list.data.runs.map((r) => (
                  <tr key={r.id} onClick={() => setSelRun(r.id)} class="cursor-pointer border-t hover:bg-[var(--surface-2)]" style={{ borderColor: 'var(--border)' }}>
                    <td class="px-4 py-2">{r.agentName}</td>
                    <td class="px-4 py-2 text-[var(--muted)]">{r.model}</td>
                    <td class="px-4 py-2">
                      <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    </td>
                    <td class="px-4 py-2">{ms(r.durationMs)}</td>
                    <td class="px-4 py-2">{usd(r.costUsd)}</td>
                    <td class="px-4 py-2 text-[var(--muted)]">{fmtRel(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </Card>
          </>
        )}
      </div>

      {selRun && <RunDetail id={selRun} onClose={() => setSelRun(null)} onSession={(sid) => { setSelRun(null); setSelSession(sid); }} />}
      {selSession && <SessionView sid={selSession} onClose={() => setSelSession(null)} />}
    </div>
  );
}

function RunDetail({ id, onClose, onSession }: { id: string; onClose: () => void; onSession: (sid: string) => void }) {
  const { loading, data, error } = useApi<{ run: Run }>(`/dashboard/agents/run/${id}`);
  return (
    <Modal open onClose={onClose} title="Agent run">
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox msg={error ?? 'Not found'} />
      ) : (
        <div class="space-y-4 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{data.run.agentName}</span>
            <Badge tone={statusTone(data.run.status)}>{data.run.status}</Badge>
            <span class="text-[var(--muted)]">{data.run.provider}/{data.run.model}{data.run.tier ? ` · ${data.run.tier}` : ''}</span>
          </div>
          <div class="text-[var(--muted)]">{data.run.task}</div>
          <div class="grid grid-cols-3 gap-3">
            <Stat label="Duration" value={ms(data.run.durationMs)} />
            <Stat label="Cost" value={usd(data.run.costUsd)} />
            <Stat label="Tokens in/out" value={`${data.run.inputTokens}/${data.run.outputTokens}`} />
            <Stat label="Cache read" value={data.run.cacheReadTokens} />
            <Stat label="Cache create" value={data.run.cacheCreationTokens} />
          </div>
          {data.run.toolCalls && data.run.toolCalls.length > 0 && (
            <div>
              <div class="mb-1 text-sm font-medium">Tool calls</div>
              <div class="space-y-1 text-xs">
                {data.run.toolCalls.map((t) => (
                  <div key={t.name} class="flex justify-between">
                    <span>{t.name}</span>
                    <span class="text-[var(--muted)]">
                      {t.count}×{t.error_count ? ` · ${t.error_count} err` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.run.sessionId && (
            <Button variant="outline" onClick={() => onSession(data.run.sessionId!)}>
              View session ({data.run.sessionId.slice(0, 8)}…)
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}

function SessionView({ sid, onClose }: { sid: string; onClose: () => void }) {
  const { loading, data, error } = useApi<{ runs: Run[] }>(`/dashboard/agents/session/${sid}`);
  return (
    <Modal open onClose={onClose} title={`Session ${sid.slice(0, 8)}…`}>
      {loading ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox msg={error ?? 'Not found'} />
      ) : (
        <div class="max-h-[60vh] space-y-2 overflow-y-auto text-sm">
          {data.runs.map((r) => (
            <div key={r.id} class="flex items-center justify-between border-b pb-2" style={{ borderColor: 'var(--border)' }}>
              <div>
                <span class="font-medium">{r.agentName}</span> <span class="text-[var(--muted)]">{r.model}</span>
              </div>
              <div class="flex items-center gap-2">
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                <span class="text-[var(--muted)]">{ms(r.durationMs)} · {usd(r.costUsd)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
