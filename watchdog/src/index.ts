// F008.2 — external off-fly watchdog. A Cloudflare Worker (cron-triggered) that
// pings upmetrics + cronjobs from the EDGE and fires a single Discord alert when
// arn/upmetrics is unreachable. Zero runtime dependency on fly/arn (AC2/AC3):
// it runs on Cloudflare and only talks to the deadman Discord webhook.
//
// State (last status, to dedup to one alert) lives in Workers KV.
import { decide, DEFAULT_STATE, type Status, type WatchState } from './decide';

interface Env {
  WATCHDOG_KV: KVNamespace;
  DISCORD_WEBHOOK: string; // secret (wrangler secret put)
  UPMETRICS_URL: string;
  CRONJOBS_URL: string;
}

// Reachable = the edge+app answered at all (status < 500). A throw/timeout or a
// 5xx means the region/service is down — distinguishes "outage" from "404/login".
async function probe(url: string): Promise<Status> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.status < 500 ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

async function run(env: Env, now: number): Promise<{ upmetrics: Status; cronjobs: Status; alert: string | null }> {
  const [upmetrics, cronjobs] = await Promise.all([probe(env.UPMETRICS_URL), probe(env.CRONJOBS_URL)]);
  const prev = ((await env.WATCHDOG_KV.get('state', 'json')) as WatchState | null) ?? DEFAULT_STATE;
  const { alert, state } = decide(prev, { upmetrics, cronjobs }, now);
  await env.WATCHDOG_KV.put('state', JSON.stringify(state));

  if (alert && env.DISCORD_WEBHOOK) {
    await fetch(env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `${alert}\nupmetrics=${upmetrics} cronjobs=${cronjobs} @ ${new Date(now).toISOString()}`,
      }),
    });
  }
  return { upmetrics, cronjobs, alert };
}

export default {
  // Cron trigger (every 2 min — see wrangler.jsonc).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env, Date.now()));
  },
  // Manual trigger / debug: GET the Worker URL to run a check + see current status.
  async fetch(_req: Request, env: Env): Promise<Response> {
    return Response.json(await run(env, Date.now()));
  },
};
