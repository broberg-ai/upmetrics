// F008.8 — every CI job has a time limit. Run: bun test src/ci/workflow-timeouts.test.ts
//
// Without `timeout-minutes` GitHub waits 360 minutes. On the deploy job that is
// the dangerous half of a green failure: it has `concurrency: deploy-upmetrics`,
// so one hung Fly remote-build holds every later deploy in a queue for up to six
// hours while nothing turns red — the job has not failed, it has just not
// finished. Christian's CI order to the fleet, 24/9 2026, via cms.
//
// Reads the REAL workflow files, so a workflow added later (a copy of the
// enroll file, say) is held to the same rule without anyone remembering it.
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = new URL('../../../../.github/workflows', import.meta.url).pathname;

// Every job without a timeout, as "file → job". Empty is the only passing answer.
export function jobsWithoutTimeout(file: string, text: string): string[] {
  const doc = Bun.YAML.parse(text) as { jobs?: Record<string, Record<string, unknown>> };
  return Object.entries(doc.jobs ?? {})
    .filter(([, job]) => typeof job['timeout-minutes'] !== 'number')
    .map(([name]) => `${file} → ${name}`);
}

describe('F008.8 — hvert CI-job har en tidsgrænse', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it('der findes workflows at læse (ellers beviser en tom liste intet)', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('INTET job i nogen workflow mangler timeout-minutes', () => {
    const missing = files.flatMap((f) => jobsWithoutTimeout(f, readFileSync(join(WORKFLOWS, f), 'utf8')));
    // Strict equality prints the offenders by name when it fails.
    expect(missing).toEqual([]);
  });

  // Negative control: without it, "nothing missing" is also what a parser that
  // finds no jobs at all would report.
  it('negativ kontrol: et job uden grænse bliver fanget og navngivet', () => {
    const yml = 'on: push\njobs:\n  good:\n    runs-on: x\n    timeout-minutes: 5\n  hung:\n    runs-on: x\n';
    expect(jobsWithoutTimeout('synthetic.yml', yml)).toEqual(['synthetic.yml → hung']);
  });
});
