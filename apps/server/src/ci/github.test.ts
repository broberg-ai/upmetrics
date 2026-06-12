import { describe, it, expect } from 'bun:test';
import { mapRun, ciTargets } from './github';

describe('mapRun', () => {
  it('shapes a GitHub workflow_run into a CiRun (short sha, nulls handled)', () => {
    expect(
      mapRun({
        id: 123,
        name: 'publish-sdk',
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        head_branch: 'main',
        head_sha: 'eb0bb42abc123',
        created_at: '2026-06-04T10:59:34Z',
        html_url: 'https://github.com/broberg-ai/upmetrics/actions/runs/1',
      }),
    ).toEqual({
      id: 123,
      name: 'publish-sdk',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      branch: 'main',
      sha: 'eb0bb42',
      createdAt: '2026-06-04T10:59:34Z',
      url: 'https://github.com/broberg-ai/upmetrics/actions/runs/1',
    });
  });

  it('falls back to display_title and tolerates a running run (null conclusion)', () => {
    const r = mapRun({ id: 9, display_title: 'CI', status: 'in_progress', event: 'pull_request', head_sha: 'abcdef0', created_at: 't' });
    expect(r.name).toBe('CI');
    expect(r.conclusion).toBeNull();
    expect(r.branch).toBeNull();
    expect(r.sha).toBe('abcdef0');
  });
});

describe('ciTargets', () => {
  const projects = [
    { repo: 'broberg-ai/upmetrics', project: 'Upmetrics' },
    { repo: 'broberg-ai/trail', project: 'Trail' },
  ];

  it('appends watch-only repos as "library" after the project repos', () => {
    const out = ciTargets(projects, ['broberg-ai/ai-sdk', 'broberg-ai/components']);
    expect(out).toEqual([
      { repo: 'broberg-ai/upmetrics', project: 'Upmetrics' },
      { repo: 'broberg-ai/trail', project: 'Trail' },
      { repo: 'broberg-ai/ai-sdk', project: 'library' },
      { repo: 'broberg-ai/components', project: 'library' },
    ]);
  });

  it('de-dupes a watch-only repo that is already an enrolled project (project label wins)', () => {
    const out = ciTargets(projects, ['broberg-ai/Trail', 'broberg-ai/ai-sdk']);
    expect(out.filter((t) => t.repo.toLowerCase() === 'broberg-ai/trail')).toHaveLength(1);
    expect(out.find((t) => t.repo.toLowerCase() === 'broberg-ai/trail')!.project).toBe('Trail');
    expect(out).toHaveLength(3); // 2 projects + ai-sdk only
  });

  it('drops empty entries and is a no-op with no watch-only repos', () => {
    expect(ciTargets(projects, [])).toEqual(projects);
    expect(ciTargets(projects, ['']).filter((t) => t.project === 'library')).toHaveLength(0);
  });
});
