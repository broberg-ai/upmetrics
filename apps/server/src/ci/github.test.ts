import { describe, it, expect } from 'bun:test';
import { mapRun } from './github';

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
