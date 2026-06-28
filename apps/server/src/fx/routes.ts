// F023 — public live FX rate endpoint. A USD→DKK reference rate is public info
// (not sensitive), so no auth: the dashboard + any consumer that only needs the
// rate reads this. cost/credits responses already embed usd_to_dkk so callers
// needn't make a second request.
import type { Hono } from 'hono';
import { usdToDkk } from './rate';

export function registerFxRoutes(app: Hono): void {
  app.get('/api/fx/usd-dkk', (c) => c.json({ pair: 'USD_DKK', rate: usdToDkk() }));
}
