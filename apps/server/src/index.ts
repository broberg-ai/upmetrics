// @upmetrics/server entry point — boots the Hono app on Bun's native server.
import { createApp } from './app';
import { config } from './config';
import { startCorrelationWorker } from './incidents/correlation';
import { startRetentionWorker } from './ops/retention';
import { startFxWorker } from './fx/rate';
import { startLagGauge } from './ops/lag-gauge';
import { initDogfood } from './dogfood';

const app = createApp();

// F008: event-loop lag gauge — powers /ready's degraded signal (circuit breaker).
startLagGauge();

// F005.1: background incident-correlation tick (every ~30s).
startCorrelationWorker();

// F007.1: daily retention + compaction (events purge, agent_runs, probe downsample).
startRetentionWorker();

// F023: live USD→DKK rate — refresh on boot + every 12h (rolling-5 fallback).
startFxWorker();

// F009.1: dogfood — self-monitor via @upmetrics/sdk (no-op if SDK/DSN absent).
void initDogfood();

console.log(`@upmetrics/server listening on :${config.port} (${config.nodeEnv})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
