// @upmetrics/server entry point — boots the Hono app on Bun's native server.
import { createApp } from './app';
import { config } from './config';
import { startCorrelationWorker } from './incidents/correlation';

const app = createApp();

// F005.1: background incident-correlation tick (every ~30s).
startCorrelationWorker();

console.log(`@upmetrics/server listening on :${config.port} (${config.nodeEnv})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
