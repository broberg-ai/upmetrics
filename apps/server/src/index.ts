// @upmetrics/server entry point — boots the Hono app on Bun's native server.
import { createApp } from './app';
import { config } from './config';

const app = createApp();

console.log(`@upmetrics/server listening on :${config.port} (${config.nodeEnv})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
