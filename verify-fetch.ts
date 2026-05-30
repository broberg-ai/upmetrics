// F003.1 AC1 verify: failed-fetch auto-instrument. SDK DSN → capture server
// (3095); a SEPARATE target server (3094) returns 500 so the failing fetch is
// NOT the SDK's own endpoint. Assert the SDK captured a warning envelope.
// Run: bun verify-fetch.ts
import { init } from './packages/sdk/src/index';

const envelopes: any[] = [];
const capture = Bun.serve({ port: 3095, async fetch(req) { const t = await req.text(); envelopes.push(t.split('\n').map((l) => { try { return JSON.parse(l); } catch { return l; } })); return Response.json({ accepted: 1 }); } });
const target = Bun.serve({ port: 3094, fetch() { return new Response('boom', { status: 500 }); } });

init({ dsn: 'http://pub@localhost:3095/fysiodk', environment: 'test' }); // autoInstrument default ON

// a failing fetch to a DIFFERENT host than the DSN endpoint
await fetch('http://localhost:3094/api/thing');
await new Promise((r) => setTimeout(r, 200));

const warn = envelopes.find((e) => Array.isArray(e) && e[2]?.message?.includes('HTTP 500') && e[2]?.message?.includes('3094'));
const pass = Boolean(warn);
console.log(`${pass ? '✅' : '❌'} F003.1 AC1: failed fetch (500) auto-captured → ${warn ? warn[2].message : 'NOT captured'}`);
// also confirm own-endpoint POST was NOT self-captured (no envelope about /fysiodk/envelope)
const selfLoop = envelopes.some((e) => Array.isArray(e) && e[2]?.message?.includes('/fysiodk/envelope'));
console.log(`${!selfLoop ? '✅' : '❌'} no self-capture of own ingest endpoint (no recursion)`);

capture.stop(true); target.stop(true);
process.exit(pass && !selfLoop ? 0 : 1);
