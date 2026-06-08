// F019.4 — GitHub Actions CI watcher. Reads recent workflow runs for fleet repos
// via a read-only token (config.githubToken, classic PAT scope repo). OBSERVE
// only — upmetrics never triggers a run. A short in-memory cache keeps the
// dashboard from hammering the API on every load (one set of runs per repo per
// minute is plenty for a status view).
import { config } from '../config';

export interface CiRun {
  id: number;
  name: string; // workflow name
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | ... | null while running
  event: string; // push | pull_request | workflow_dispatch | ...
  branch: string | null;
  sha: string; // short (7)
  createdAt: string; // ISO
  url: string; // html_url
}

// Shape one GitHub workflow_run API object into our CiRun. Pure → unit-tested.
export function mapRun(r: Record<string, any>): CiRun {
  return {
    id: r.id,
    name: r.name ?? r.display_title ?? 'workflow',
    status: r.status,
    conclusion: r.conclusion ?? null,
    event: r.event,
    branch: r.head_branch ?? null,
    sha: String(r.head_sha ?? '').slice(0, 7),
    createdAt: r.created_at,
    url: r.html_url,
  };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; runs: CiRun[] }>();

// Latest workflow runs for "owner/repo". Throws on a missing token or a non-2xx
// GitHub response so the caller can surface a per-repo error (one bad repo must
// not break the whole view).
export async function fetchWorkflowRuns(repo: string, limit = 5, now = Date.now()): Promise<CiRun[]> {
  if (!config.githubToken) throw new Error('github_token_not_configured');
  const hit = cache.get(repo);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.runs;

  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=${limit}`, {
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`github ${res.status}`);
  const data = (await res.json()) as { workflow_runs?: Array<Record<string, any>> };
  const runs = (data.workflow_runs ?? []).map(mapRun);
  cache.set(repo, { at: now, runs });
  return runs;
}
