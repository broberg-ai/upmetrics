import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

// Dashboard SPA. In dev, /api is proxied to the upmetrics server (default
// localhost:8080; override with VITE_API_TARGET, e.g. https://upmetrics.org).
// In prod the same-origin server serves the built bundle, so the relative /api
// paths the client uses just work.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  resolve: {
    // recharts is React — alias to preact/compat.
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: true, secure: true } },
  },
});
