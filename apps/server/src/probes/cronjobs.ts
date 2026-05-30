// cronjobs.webhouse.net client (F004.1, Model A). cronjobs is a pure scheduler:
// it calls a URL on a cron schedule. We point that URL at our own
// /api/probes/:id/run endpoint, so Upmetrics performs the actual check when up.
import { config } from '../config';

function cj(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${config.cronjobsApiBase}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.cronjobsApiToken}`,
      ...(init.headers ?? {}),
    },
  });
}

// Map an interval in seconds to a cron expression (minute granularity).
export function intervalToCron(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes >= 60) {
    const hours = Math.max(1, Math.round(minutes / 60));
    return hours >= 24 ? '0 0 * * *' : `0 */${hours} * * *`;
  }
  return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
}

export async function createProbeJob(
  name: string,
  intervalSeconds: number,
  runUrl: string,
  runToken: string,
): Promise<string> {
  const res = await cj('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: `upmetrics-probe: ${name}`,
      schedule: intervalToCron(intervalSeconds),
      timezone: 'Europe/Copenhagen',
      protocol: 'https',
      method: 'GET',
      url: runUrl,
      // Run-token travels in a header (not the URL) so it never lands in stored
      // job URLs or request logs. cronjobs forwards stored headers verbatim.
      headers: JSON.stringify({ 'X-Upmetrics-Run-Key': runToken }),
      timeout: 30000,
      enabled: true,
      tags: ['upmetrics-probe'],
    }),
  });
  if (!res.ok) throw new Error(`cronjobs create failed: ${res.status}`);
  const job = (await res.json()) as { id: string };
  return job.id;
}

export async function deleteProbeJob(jobId: string): Promise<void> {
  await cj(`/api/jobs/${jobId}`, { method: 'DELETE' });
}
