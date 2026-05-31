// @upmetrics/server entry point — boots the Hono app on Bun's native server.
import { createApp } from './app';
import { config } from './config';
import { startCorrelationWorker } from './incidents/correlation';
import { startRetentionWorker } from './ops/retention';
import { initDogfood } from './dogfood';

const app = createApp();

// F005.1: background incident-correlation tick (every ~30s).
startCorrelationWorker();

// F007.1: daily retention + compaction (events purge, agent_runs, probe downsample).
startRetentionWorker();

// F009.1: dogfood — self-monitor via @upmetrics/sdk (no-op if SDK/DSN absent).
void initDogfood();

console.log(`@upmetrics/server listening on :${config.port} (${config.nodeEnv})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
