// F032 — self-enrollment, and the eight things that must be able to say NO.
//
// The tests sign their OWN tokens against a key set they control. That is the
// only way a negative control can exist here: a suite that cannot mint a valid
// token can prove that garbage is rejected, but never that a good token is
// accepted for the right reason — and "rejects everything" would pass it.
//
// Run: bun test src/enroll/enroll-route.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { getDb, schema } from '../db';
import { registerEnrollRoutes } from './routes';
import { GITHUB_ISSUER } from './oidc';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const AUD = 'https://upmetrics.test';
const OWNERS = ['broberg-ai'];

const app = new Hono();

// GitHub's keys, as far as this suite is concerned…
let githubKey: CryptoKey;
// …and a key that is NOT GitHub's, to prove the signature is actually checked.
let impostorKey: CryptoKey;
let jwks: JWTVerifyGetKey;

let jtiCounter = 0;

type TokenOpts = {
  repository?: string;
  repositoryId?: number;
  owner?: string;
  aud?: string;
  iss?: string;
  expiresIn?: string;
  key?: CryptoKey;
  jti?: string;
  alg?: string;
  omit?: string[];
};

async function token(o: TokenOpts = {}): Promise<string> {
  const repository = o.repository ?? 'broberg-ai/voice-engine';
  const claims: Record<string, unknown> = {
    repository,
    repository_id: String(o.repositoryId ?? 101),
    repository_owner: o.owner ?? repository.split('/')[0],
    ref: 'refs/heads/main',
    sha: 'deadbeef',
    run_id: '12345',
    workflow: 'upmetrics-enroll',
    sub: `repo:${repository}:ref:refs/heads/main`,
  };
  for (const k of o.omit ?? []) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: 'gh-test-key' })
    .setIssuedAt()
    .setIssuer(o.iss ?? GITHUB_ISSUER)
    .setAudience(o.aud ?? AUD)
    .setJti(o.jti ?? `jti-${++jtiCounter}`)
    .setExpirationTime(o.expiresIn ?? '5m')
    .sign(o.key ?? githubKey);
}

const enroll = (bearer: string | null, body: Record<string, unknown> = {}) =>
  app.request('/api/enroll', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'fly-client-ip': `10.0.0.${++ipCounter % 250}`, // a fresh IP per call: the
      // failure budget is a DoS guard, not part of what these tests measure.
    },
    body: JSON.stringify(body),
  });
let ipCounter = 0;

const projectCount = () => getDb().select().from(schema.projects).all().length;
const projectRow = (id: string) => getDb().select().from(schema.projects).where(eq(schema.projects.id, id)).get();

beforeAll(async () => {
  migrate(getDb(), { migrationsFolder: MIGRATIONS });
  const gh = await generateKeyPair('RS256', { extractable: true });
  const impostor = await generateKeyPair('RS256', { extractable: true });
  githubKey = gh.privateKey;
  impostorKey = impostor.privateKey;
  const pub = await exportJWK(gh.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...pub, kid: 'gh-test-key', alg: 'RS256', use: 'sig' }] });
  registerEnrollRoutes(app, { jwks, audience: AUD, allowedOwners: OWNERS });
});

describe('F032.1 a repo enrolls itself', () => {
  it('a valid token creates the project — and the SLUG comes from the token, not the body', async () => {
    // The body asks to be called something else entirely. It must not matter.
    const res = await enroll(await token({ repository: 'broberg-ai/voice-engine', repositoryId: 101 }), {
      id: 'cms',
      name: 'Voice Engine',
      platform: 'node',
      slug: 'bid',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.created).toBe(true);
    expect(body.project.id).toBe('voice-engine'); // NOT 'cms', NOT 'bid'
    expect(body.dsn).toContain('/voice-engine');
    expect(body.api_key).toMatch(/^uk_[0-9a-f]{48}$/);
    expect(body.dsn_numeric).toMatch(/\/\d+$/);
    // Read it back from the database, not from the response we just built.
    const row = projectRow('voice-engine')!;
    expect(row.enrollRepository).toBe('broberg-ai/voice-engine');
    expect(row.enrollRepositoryId).toBe(101);
    expect(row.apiKey).toBe(body.api_key);
  });

  // F033.1 — a repo that enrols itself gets a DSN, a key and monitoring. Until
  // this it also got silence: no alert_rules row, so an incident raised on it
  // reached nobody. Read the rule back from the database, not from the response.
  it('the new project can RING — an enabled alert rule exists the moment it is enrolled', () => {
    const rules = getDb().select().from(schema.alertRules).where(eq(schema.alertRules.projectId, 'voice-engine')).all();
    expect(rules.length).toBe(1);
    expect(rules[0]!.kind).toBe('*');
    expect(rules[0]!.enabled).toBe(true);
    expect(rules[0]!.channels).toEqual(['email', 'discord']);
  });

  it('re-running the workflow is idempotent — SAME dsn, SAME key, no second project', async () => {
    const before = projectCount();
    const first = projectRow('voice-engine')!;
    const res = await enroll(await token({ repository: 'broberg-ai/voice-engine', repositoryId: 101 }));
    expect(res.status).toBe(200); // 200, not 201
    const body = (await res.json()) as any;
    expect(body.created).toBe(false);
    expect(body.dsn).toBe(first.dsn);
    // A rotation here would kill the key in the service that is already running.
    expect(body.api_key).toBe(first.apiKey);
    expect(projectCount()).toBe(before);
  });

  it('a RENAMED repo still reaches its own project — the id is the binding, not the name', async () => {
    const before = projectCount();
    const res = await enroll(await token({ repository: 'broberg-ai/voice-engine-v2', repositoryId: 101 }));
    expect(res.status).toBe(200);
    expect(projectCount()).toBe(before); // no duplicate under the new name
    expect(projectRow('voice-engine')!.enrollRepository).toBe('broberg-ai/voice-engine-v2');
  });

  it('an UNBOUND project (hand-enrolled before this feature) is claimed by its own repo, keeping its key', async () => {
    const now = new Date();
    getDb()
      .insert(schema.projects)
      .values({
        id: 'helpdesk',
        name: 'helpdesk',
        dsn: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@upmetrics.test/helpdesk',
        apiKey: 'uk_existing_key_from_before',
        platform: 'node',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const res = await enroll(await token({ repository: 'broberg-ai/helpdesk', repositoryId: 202 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.created).toBe(false);
    // The "I lost my .env" recovery: the repo gets its EXISTING credentials.
    expect(body.api_key).toBe('uk_existing_key_from_before');
    expect(projectRow('helpdesk')!.enrollRepositoryId).toBe(202);
    // The fixture above has NO numeric alias — a project hand-inserted since the
    // last boot never passed ensureDsnNumericIds. Without filling it here the
    // response carries dsn_numeric: null, and a workflow writes that out as the
    // literal string "null": a value that reads like a DSN and is not one.
    expect(body.dsn_numeric).not.toBeNull();
    expect(body.dsn_numeric).toMatch(/\/\d+$/);
    expect(typeof projectRow('helpdesk')!.dsnNumericId).toBe('number');
  });
});

describe('F032.1 the eight things that must say NO', () => {
  it('1a — no Authorization header → 401, and nothing is created', async () => {
    const before = projectCount();
    const res = await enroll(null);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe('missing_token');
    expect(projectCount()).toBe(before);
  });

  it('1b — nonsense instead of a token → 401, and nothing is created', async () => {
    const before = projectCount();
    const res = await enroll('not-a-jwt-at-all');
    expect(res.status).toBe(401);
    expect(projectCount()).toBe(before);
  });

  // THE decisive one. A well-formed token with every claim right, signed by a
  // key that is not GitHub's. If this passed, the whole feature would be a
  // caller telling us its own name.
  it('2 — a token signed with a key that is NOT GitHub\'s → 401', async () => {
    const before = projectCount();
    const res = await enroll(await token({ repository: 'broberg-ai/impostor', repositoryId: 999, key: impostorKey }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason).toBe('bad_signature');
    expect(projectCount()).toBe(before);
  });

  it('3 — HS256 instead of RS256 → 401 on the ALGORITHM, before any key is consulted', async () => {
    const hs = await new SignJWT({ repository: 'broberg-ai/x', repository_id: '1', repository_owner: 'broberg-ai' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(GITHUB_ISSUER)
      .setAudience(AUD)
      .setJti('hs-1')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-guessable-shared-string-00000000'));
    const res = await enroll(hs);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason).toBe('alg_not_allowed');
  });

  it('4 — the wrong issuer → 401', async () => {
    const res = await enroll(await token({ iss: 'https://evil.example/oidc' }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason).toBe('wrong_issuer');
  });

  // The replay case with a name: our OWN publish-sdk.yml mints GitHub OIDC
  // tokens for npm. Without the audience check, one of those would enroll.
  it('5 — a real GitHub token minted for SOMEONE ELSE (npm) → 401 wrong_audience', async () => {
    const before = projectCount();
    const res = await enroll(await token({ aud: 'https://registry.npmjs.org' }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason).toBe('wrong_audience');
    expect(projectCount()).toBe(before);
  });

  it('6 — an expired token → 401', async () => {
    const res = await enroll(await token({ expiresIn: '-10s' }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason).toBe('token_expired');
  });

  it('7 — a repo outside the org fence → 403, and nothing is created', async () => {
    const before = projectCount();
    const res = await enroll(await token({ repository: 'some-stranger/upmetrics', repositoryId: 777 }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('owner_not_allowed');
    expect(projectCount()).toBe(before);
  });

  // Repo A cannot take repo B's project. The damage this prevents is one repo's
  // errors landing on another repo's board — and its key in another repo's hands.
  it('8 — repo A cannot claim repo B\'s project, and B\'s key is untouched', async () => {
    const bKeyBefore = projectRow('voice-engine')!.apiKey;
    // A different repo whose NAME happens to be voice-engine, under the same org.
    const res = await enroll(await token({ repository: 'broberg-ai/voice-engine', repositoryId: 31337 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe('slug_taken');
    // Read back from the database — the response would not show a silent overwrite.
    expect(projectRow('voice-engine')!.apiKey).toBe(bKeyBefore);
    expect(projectRow('voice-engine')!.enrollRepositoryId).toBe(101);
  });

  it('a token missing the identity claims → 401, never a guess', async () => {
    const res = await enroll(await token({ omit: ['repository_id'] }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).reason).toBe('missing_claims');
  });

  it('a repo whose NAME cannot be a project slug → 400, not a mangled project', async () => {
    const before = projectCount();
    const res = await enroll(await token({ repository: 'broberg-ai/A_Repo.Name', repositoryId: 555 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('invalid_slug');
    expect(projectCount()).toBe(before);
  });
});

describe('F032.2 the audit trail, and a token that can only be spent once', () => {
  const attempts = () => getDb().select().from(schema.enrollAttempts).all();

  it('the SAME token twice → the second is 401 token_replayed and creates nothing', async () => {
    const t = await token({ repository: 'broberg-ai/replay-test', repositoryId: 4242, jti: 'replay-me-once' });
    const first = await enroll(t);
    expect(first.status).toBe(201);
    const before = projectCount();

    const second = await enroll(t);
    expect(second.status).toBe(401);
    expect(((await second.json()) as any).error).toBe('token_replayed');
    expect(projectCount()).toBe(before);
  });

  it('a SUCCESS is recorded with the repo GitHub asserted', async () => {
    const row = attempts().find((a) => a.jti === 'replay-me-once');
    expect(row).toBeTruthy();
    expect(row!.outcome).toBe('created');
    expect(row!.repository).toBe('broberg-ai/replay-test');
    expect(row!.repositoryId).toBe(4242);
    expect(row!.projectId).toBe('replay-test');
    expect(row!.runId).toBe('12345');
    expect(row!.reason).toBeNull();
  });

  // An audit that holds only the successes is anti-correlated with the thing it
  // exists to catch.
  it('a DENIAL is recorded too, with the reason', async () => {
    await enroll(await token({ repository: 'outsider-org/thing', repositoryId: 888, jti: 'denied-owner-1' }));
    const row = attempts().find((a) => a.jti === 'denied-owner-1');
    expect(row).toBeTruthy();
    expect(row!.outcome).toBe('denied');
    expect(row!.reason).toBe('owner_not_allowed');
    expect(row!.projectId).toBeNull();
  });

  it('an UNVERIFIABLE token is recorded WITHOUT its claims — they are the caller\'s text, not GitHub\'s', async () => {
    await enroll(await token({ repository: 'broberg-ai/liar', repositoryId: 31, key: impostorKey }));
    const forged = attempts().filter((a) => a.repository === 'broberg-ai/liar');
    expect(forged.length).toBe(0); // nothing from that token is written down as fact
    expect(attempts().some((a) => a.reason === 'bad_signature' && a.jti === null)).toBe(true);
  });

  it('no token and no api_key ever reaches the audit trail', async () => {
    const dump = JSON.stringify(attempts());
    expect(dump).not.toContain('uk_');
    expect(dump).not.toContain('eyJ'); // the opening of every JWT
  });

  it('a stale attempt is never left reading as in-progress', async () => {
    expect(attempts().some((a) => a.reason === 'in_progress')).toBe(false);
  });
});
