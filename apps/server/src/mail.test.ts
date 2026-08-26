// The mail gate (F021.3 → @broberg/mail 0.7.1). Run: bun test src/mail.test.ts
//
// 0.3.0 flipped `live` from `!!apiKey` to FALSE-unless-opted-in. A mailer
// created without it still returns `{ ok: true }` for a recipient it never
// delivered to — the send path reports what it ATTEMPTED, not what left the
// building. These run against the REAL package with an injected fetch, so a
// future version that changes the semantics again turns them red rather than
// silently swallowing our sign-in mail.
import { describe, it, expect } from 'bun:test';
import { createMailer } from '@broberg/mail';

const KEY = 'test-key';
const FROM = 'Upmetrics <upmetrics@webhouse.dk>';
// A real sign-in account of ours that is NOT a fleet admin — the half that goes
// silent when `live` is left undefined. cb@webhouse.dk would pass either way,
// so testing with it would prove nothing.
const NON_ADMIN = 'lens@upmetrics.org';

function stubFetch(): { calls: number; fetch: typeof fetch } {
  const s = { calls: 0, fetch: (async (_u: any, _o: any) => { s.calls++; return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch };
  return s;
}

describe('mail gate — live must be explicit', () => {
  it('WITHOUT live: a non-admin recipient is skipped, and the result still says ok', () => {
    const s = stubFetch();
    const m = createMailer({ apiKey: KEY, from: FROM, fetch: s.fetch });
    expect(m.mode).toBe('allowlist-only');
    return m.send({ to: NON_ADMIN, subject: 's', html: '<p>x</p>' }).then((res) => {
      expect(res.ok).toBe(true); // <- the trap: success-shaped
      expect(res.skipped).toBe(true); // <- and nothing was delivered
      expect(s.calls).toBe(0); // proven at the wire, not from the return value
    });
  });

  it('WITH live: the same recipient reaches the wire', async () => {
    const s = stubFetch();
    const m = createMailer({ apiKey: KEY, from: FROM, live: true, fetch: s.fetch });
    expect(m.mode).toBe('live');
    const res = await m.send({ to: NON_ADMIN, subject: 's', html: '<p>x</p>' });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBeFalsy();
    expect(s.calls).toBe(1);
  });

  it('no key: ship-dark — a skipped no-op, never a crash', async () => {
    const s = stubFetch();
    const m = createMailer({ apiKey: '', from: FROM, live: true, fetch: s.fetch });
    expect(m.mode).toBe('no-key');
    const res = await m.send({ to: NON_ADMIN, subject: 's', html: '<p>x</p>' });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(s.calls).toBe(0);
  });

  it('the REAL src/mail.ts resolves to live under production env', async () => {
    // Not a mirror of the wiring — the wiring itself, imported in a subprocess
    // with a production environment. A mirror test measures its own input: it
    // would stay green while the actual module lost its `live` argument.
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', "const m = await import('./src/mail.ts'); console.log(m.mailer.mode);"],
      cwd: import.meta.dir + '/..',
      env: { ...process.env, NODE_ENV: 'production', RESEND_API_KEY: 'test-key', AUTH_SECRET: 'x'.repeat(32) },
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    expect(out, `stdout=${out} stderr=${err}`).toBe('live');
  });

  it('production REFUSES to boot when mail could not deliver', async () => {
    // The negative control, rewritten TWICE, and both rewrites were the same
    // class of mistake as the bug it guards:
    //   1st: MAIL_DISABLED — read by createMailerFromEnv(), which we do not
    //        use. The switch never reached our code; the test went green on a
    //        lever connected to nothing.
    //   2nd: deleting RESEND_API_KEY from the child env — bun auto-loads
    //        .env.local, so the key came back from the file and the subprocess
    //        booted with a real one.
    // An EMPTY value set explicitly is the lever that works: it wins over the
    // file, and config.ts refuses to start.
    //
    // It trips productionGuard in config.ts, not the mode check in mail.ts.
    // The mode check is unreachable from any environment today (in production
    // `live` is true whenever a key exists, and without a key config throws
    // first) — it is a tripwire for a future @broberg/mail whose semantics move
    // again. Saying so is better than a test that pretends to exercise it.
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', "await import('./src/mail.ts'); console.log('BOOTED');"],
      cwd: import.meta.dir + '/..',
      env: { ...process.env, NODE_ENV: 'production', AUTH_SECRET: 'x'.repeat(32), RESEND_API_KEY: '' },
    });
    // Never print the child's env or config: an earlier version of this file
    // printed config.resendApiKey while diagnosing, and put a live key in a log.
    expect(new TextDecoder().decode(proc.stdout).trim()).not.toContain('BOOTED');
    expect(proc.exitCode).not.toBe(0);
  });
});
