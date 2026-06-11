import { useState } from 'preact/hooks';
import { useApi } from '../lib/useApi';
import { fmtRel } from '../lib/format';
import { Card, Badge } from '../components/ui/controls';
import { CustomSelect } from '../components/ui/select';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';

// F019.6 — DeployStatus: read-only, sortable + searchable log of observed
// deploy_events. upmetrics WATCHES + REPORTS deploys (and relays), never triggers one.
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

type SortKey = 'site' | 'status' | 'version' | 'sha' | 'originator' | 'provider' | 'updatedAt';

const tone = (s: Deploy['status']): 'ok' | 'down' | 'primary' | 'muted' =>
  s === 'success' ? 'ok' : s === 'failure' ? 'down' : s === 'running' ? 'primary' : 'muted';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortSha = (d: Deploy) => (d.sha ? d.sha.slice(0, 7) : '—');

const STATUS_OPTS = [
  { value: '', label: 'All statuses' },
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
  { value: 'running', label: 'Running' },
  { value: 'pending', label: 'Pending' },
];

const sortVal = (d: Deploy, k: SortKey): string | number =>
  k === 'updatedAt' ? Date.parse(d.updatedAt) || 0 : String(d[k] ?? '').toLowerCase();

export function Deploys() {
  const { loading, data, error } = useApi<{ deploys: Deploy[] }>('/dashboard/deploys');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir(k === 'updatedAt' ? 'desc' : 'asc');
    }
  };

  const all = data?.deploys ?? [];
  const term = q.trim().toLowerCase();
  const rows = all
    .filter((d) => !status || d.status === status)
    .filter((d) => !term || [d.site, d.originator, d.sha, d.version, d.provider].some((v) => (v ?? '').toLowerCase().includes(term)))
    .sort((a, b) => {
      const av = sortVal(a, sortKey);
      const bv = sortVal(b, sortKey);
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? c : -c;
    });

  const sortHeader = (k: SortKey, label: string) => (
    <th class="px-4 py-2 font-medium">
      <button
        onClick={() => toggleSort(k)}
        data-testid={`deploys-sort-${k}`}
        class="inline-flex items-center gap-1 transition hover:text-[var(--text)] active:scale-95"
      >
        {label}
        <span class="w-2 text-[var(--primary)]">{sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span>
      </button>
    </th>
  );

  return (
    <div data-testid="deploys-root">
      <PageHeader title="Deploys" subtitle="Observed deploy + release status across the fleet (watch / report / relay)" />

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : all.length === 0 ? (
        <Empty msg="No deploys observed yet. The execution side reports them via POST /api/deploys." />
      ) : (
        <>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              placeholder="Search site / originator / commit…"
              data-testid="deploys-search"
              class="w-64 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
            <CustomSelect value={status ?? ''} options={STATUS_OPTS} onChange={(v) => setStatus(v || null)} testid="deploys-status-filter" />
            <span class="ml-auto text-xs text-[var(--muted)]">{rows.length} of {all.length}</span>
          </div>

          {rows.length === 0 ? (
            <Empty msg="No deploys match this filter." />
          ) : (
            <>
              {/* mobile: stacked cards */}
              <div class="space-y-2 sm:hidden" data-testid="deploys-list">
                {rows.map((d) => (
                  <Card key={d.id} data-testid="deploy-card">
                    <div class="mb-1.5 flex items-center justify-between gap-2">
                      <span class="truncate font-medium">{d.site}</span>
                      <Badge tone={tone(d.status)}>{cap(d.status)}</Badge>
                    </div>
                    <div class="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                      <span class="font-mono">{d.version ?? shortSha(d)}</span>
                      {d.provider && <span>{d.provider}</span>}
                      {d.originator && <span>↪ {d.originator}</span>}
                      <span class="ml-auto">{fmtRel(d.updatedAt)}</span>
                    </div>
                  </Card>
                ))}
              </div>
              {/* desktop: sortable log table */}
              <Card class="hidden overflow-x-auto p-0 sm:block" data-testid="deploys-table">
                <table class="w-full text-sm">
                  <thead class="text-left text-xs text-[var(--muted)]">
                    <tr>
                      {sortHeader('site', 'Site')}
                      {sortHeader('status', 'Status')}
                      {sortHeader('version', 'Version')}
                      {sortHeader('sha', 'Commit')}
                      {sortHeader('originator', 'Originator')}
                      {sortHeader('provider', 'Provider')}
                      {sortHeader('updatedAt', 'Deployed')}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d.id} data-testid="deploy-row" class="border-t hover:bg-[var(--surface-2)]" style={{ borderColor: 'var(--border)' }}>
                        <td class="px-4 py-2 font-medium">{d.site}</td>
                        <td class="px-4 py-2">
                          <Badge tone={tone(d.status)}>{cap(d.status)}</Badge>
                        </td>
                        <td class="px-4 py-2 text-[var(--muted)]">{d.version ?? '—'}</td>
                        <td class="px-4 py-2 font-mono text-[var(--muted)]">{shortSha(d)}</td>
                        <td class="px-4 py-2 text-[var(--muted)]">{d.originator ?? '—'}</td>
                        <td class="px-4 py-2 text-[var(--muted)]">{d.provider ?? '—'}</td>
                        <td class="px-4 py-2 text-[var(--muted)]">{fmtRel(d.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
