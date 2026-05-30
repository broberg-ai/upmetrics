// F003.3 (re-scoped per decision b): the real @upmetrics/sdk — the same code a
// Capacitor webview runs — captures a JS error and ships it to PROD upmetrics
// for the cms-mobile project. Run: UPM_DSN=... bun verify-cms-mobile.ts
import { init, captureException, setTag } from './packages/sdk/src/index';

init({ dsn: process.env.UPM_DSN!, environment: 'capacitor-test', release: 'cms-mobile@verify', autoInstrument: false });
setTag('app', 'cms-mobile');
const id = captureException(new Error('CmsMobileBoom: simulated JS error from the cms-mobile Capacitor app'));
console.log('sent event_id:', id);
await new Promise((r) => setTimeout(r, 1200)); // let the fire-and-forget POST + async grouping complete
