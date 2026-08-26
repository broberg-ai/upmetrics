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

  it('the REAL src/mail.ts resolves to live on a DEPLOYED instance', async () => {
    // Not a mirror of the wiring — the wiring itself, in a subprocess. A mirror
    // test measures its own input: it would stay green while the module lost
    // its `live` argument. FLY_APP_NAME is what makes it "deployed".
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', "const m = await import('./src/mail.ts'); console.log(m.mailer.mode);"],
      cwd: import.meta.dir + '/..',
      env: { ...process.env, FLY_APP_NAME: 'upmetrics', NODE_ENV: 'production', AUTH_SECRET: 'x'.repeat(32), RESEND_API_KEY: 'test-key' },
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    expect(out, `stderr=${new TextDecoder().decode(proc.stderr).trim()}`).toBe('live');
  });

  it('does NOT decide "deployed" from NODE_ENV — the value we set ourselves', async () => {
    // The guard against a circular gate. NODE_ENV is written in BOTH fly.toml
    // and our Dockerfile, so it is the value that drifts; if the gate read it,
    // a drift would close delivery AND silence the check at the same time.
    // Production-looking env, but no platform marker ⇒ must NOT be live.
    const env = { ...process.env, NODE_ENV: 'production', AUTH_SECRET: 'x'.repeat(32), RESEND_API_KEY: 'test-key' };
    delete (env as Record<string, string | undefined>).FLY_APP_NAME;
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', "const m = await import('./src/mail.ts'); console.log(m.mailer.mode);"],
      cwd: import.meta.dir + '/..',
      env,
    });
    expect(new TextDecoder().decode(proc.stdout).trim()).toBe('allowlist-only');
  });

  it('a deployed instance that cannot deliver COMPLAINS instead of booting quietly', async () => {
    // The negative control, and it took three attempts — each failure the same
    // class as the bug it guards:
    //   1. MAIL_DISABLED: read by createMailerFromEnv(), which we do not use.
    //      Green on a lever wired to nothing.
    //   2. deleting RESEND_API_KEY: bun auto-loads .env.local, so the key came
    //      back from the file and the child booted with a real one.
    //   3. this one: an EMPTY key set explicitly wins over the file.
    // Never print the child's env or config — an earlier version of this file
    // printed config.resendApiKey while diagnosing and put a live key in a log.
    const proc = Bun.spawnSync({
      cmd: ['bun', '-e', "const m = await import('./src/mail.ts'); m.assertMailGateSane(); console.log('mode=' + m.mailer.mode);"],
      cwd: import.meta.dir + '/..',
      env: { ...process.env, FLY_APP_NAME: 'upmetrics', NODE_ENV: 'development', AUTH_SECRET: 'x'.repeat(32), RESEND_API_KEY: '' },
    });
    expect(new TextDecoder().decode(proc.stdout).trim()).toBe('mode=no-key');
    expect(new TextDecoder().decode(proc.stderr)).toContain('mail gate closed on a deployed instance');
  });
});
