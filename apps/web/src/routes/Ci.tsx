import { useApi } from '../lib/useApi';
import { fmtRel } from '../lib/format';
import { Card, Badge, StatusDot } from '../components/ui/controls';
import { Loading, ErrorBox, Empty, PageHeader } from '../components/PageState';

// F019.5 — CI runs viewer. Observe-only display of GitHub Actions workflow runs
// per fleet repo (backed by GET /api/dashboard/ci). upmetrics never triggers a run.
interface CiRun {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | ... | null while running
  event: string;
  branch: string | null;
  sha: string;
  createdAt: string;
  url: string;
}
interface RepoRuns {
  repo: string;
  project: string;
  runs: CiRun[];
  error?: string;
}

const tone = (r: CiRun): 'ok' | 'down' | 'warn' | 'muted' => {
  if (r.status !== 'completed') return 'warn'; // queued / in_progress
  if (r.conclusion === 'success') return 'ok';
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out') return 'down';
  return 'muted'; // cancelled / skipped / neutral
};
const label = (r: CiRun) => (r.status !== 'completed' ? r.status.replace('_', ' ') : (r.conclusion ?? '—'));

export function Ci() {
  const { loading, data, error } = useApi<{ configured: boolean; repos: RepoRuns[] }>('/dashboard/ci');

  return (
    <div data-testid="ci-root">
      <PageHeader title="CI" subtitle="GitHub Actions runs across the fleet (observe-only)" />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox msg={error} />
      ) : !data?.configured ? (
        <Empty msg="CI watching is off — set a GITHUB_TOKEN secret to enable it." />
      ) : data.repos.length === 0 ? (
        <Empty msg="No projects have a GitHub repo configured." />
      ) : (
        <div class="grid gap-3 lg:grid-cols-2" data-testid="ci-list">
          {data.repos.map((r) => (
            <Card key={r.repo} data-testid="ci-repo">
              <div class="mb-2 flex items-center justify-between gap-2">
                <span class="truncate font-medium">{r.repo}</span>
                <Badge tone="muted">{r.project}</Badge>
              </div>
              {r.error ? (
                <div class="text-xs" style={{ color: 'var(--down)' }}>error: {r.error}</div>
              ) : r.runs.length === 0 ? (
                <div class="text-xs text-[var(--muted)]">no runs</div>
              ) : (
                <div class="space-y-1">
                  {r.runs.map((run) => (
                    <a
                      key={run.id}
                      href={run.url}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="ci-run"
                      class="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs transition hover:bg-[var(--surface-2)] active:scale-[0.99]"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <StatusDot tone={tone(run)} />
                        <span class="truncate">{run.name}</span>
                      </span>
                      <span class="flex shrink-0 items-center gap-2 text-[var(--muted)]">
                        <span class="capitalize">{label(run)}</span>
                        <span class="font-mono">{run.sha}</span>
                        <span>{fmtRel(run.createdAt)}</span>
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
