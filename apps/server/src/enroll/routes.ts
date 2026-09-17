// F032 — self-enrollment. A repo's own CI proves which repo it is, and gets
// that repo's DSN + api_key back. No agent in the loop, no shared enrollment
// key anywhere in the fleet.
//
// THE ORDER OF THE CHECKS IS THE SECURITY, so it is written out once here:
//
//   no bearer            → 401 missing_token
//   signature/iss/aud/exp→ 401 <reason>        (audited WITHOUT a jti — we do
//                                               not trust claims we could not verify)
//   jti seen before      → 401 token_replayed
//   owner outside fence  → 403 owner_not_allowed
//   slug owned by other  → 409 slug_taken
//   already enrolled     → 200 (same dsn, same key — a re-run must not rotate
//                               a key out from under a running service)
//   new                  → 201
import type { Context, Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema } from '../db';
import { config } from '../config';
import { verifyGithubOidc, slugFromRepository, ownerAllowed, type GithubClaims } from './oidc';
import { genApiKey, buildDsn, numericDsn, nextDsnNumericId, SLUG_RE } from '../dashboard/routes';

const PLATFORMS = new Set(['web', 'node', 'capacitor', 'native']);

// Write-amplification guard. This endpoint is reachable without any shared
// secret (by design), and every attempt writes an audit row — so a flood of
// junk tokens would be an unauthenticated way to grow the database. One noisy
// sender once became 96% of this database (F025.2); that is not a theoretical
// failure here. Only FAILED verifications spend budget: a caller holding a
// genuine GitHub token is never throttled.
const FAIL_WINDOW_MS = 600_000; // 10 min
const FAIL_LIMIT = 20;
const failures = new Map<string, { n: number; resetAt: number }>();

function tooManyFailures(ip: string, now: number): boolean {
  const b = failures.get(ip);
  if (!b || now >= b.resetAt) return false;
  return b.n >= FAIL_LIMIT;
}

function noteFailure(ip: string, now: number): void {
  const b = failures.get(ip);
  if (!b || now >= b.resetAt) {
    failures.set(ip, { n: 1, resetAt: now + FAIL_WINDOW_MS });
    // Bounded on write so the map itself cannot become the leak.
    if (failures.size > 5_000) for (const [k, v] of failures) if (now >= v.resetAt) failures.delete(k);
    return;
  }
  b.n += 1;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e?.message ?? '');
}

function clientIp(c: Context): string {
  // `fly-client-ip` ONLY. x-forwarded-for is caller-supplied, so using it as a
  // rate-limit key lets the caller pick its own bucket and rotate out of the
  // limit at will — a budget an attacker controls is not a budget. Everything
  // without the Fly header shares one bucket, which is safe here because only
  // FAILED verifications spend it: a real GitHub token is never throttled.
  return c.req.header('fly-client-ip') ?? 'unknown';
}

type AttemptFields = {
  jti?: string | null;
  claims?: GithubClaims | null;
  outcome: 'created' | 'enrolled' | 'denied';
  reason?: string | null;
  projectId?: string | null;
};

// Never receives the token or the api_key — only what GitHub asserted and what
// we decided. A denial is recorded exactly like a success: an audit that only
// holds the successes is anti-correlated with what it exists to catch.
function audit(f: AttemptFields): string {
  const id = randomUUID();
  getDb()
    .insert(schema.enrollAttempts)
    .values({
      id,
      at: new Date(),
      jti: f.jti ?? null,
      repository: f.claims?.repository ?? null,
      repositoryId: f.claims?.repositoryId ?? null,
      owner: f.claims?.owner ?? null,
      ref: f.claims?.ref ?? null,
      sha: f.claims?.sha ?? null,
      runId: f.claims?.runId ?? null,
      workflow: f.claims?.workflow ?? null,
      outcome: f.outcome,
      reason: f.reason ?? null,
      projectId: f.projectId ?? null,
    })
    .run();
  return id;
}

function setOutcome(id: string, outcome: AttemptFields['outcome'], reason: string | null, projectId: string | null) {
  getDb().update(schema.enrollAttempts).set({ outcome, reason, projectId }).where(eq(schema.enrollAttempts.id, id)).run();
}

function credentials(p: typeof schema.projects.$inferSelect, created: boolean) {
  return {
    created,
    project: { id: p.id, name: p.name, platform: p.platform },
    repository: p.enrollRepository,
    dsn: p.dsn,
    dsn_numeric: numericDsn(p.dsn, p.dsnNumericId),
    api_key: p.apiKey,
  };
}

// The three verification parameters are injectable — NOT as a convenience, but
// because otherwise the negative controls cannot exist. A test that cannot sign
// its own token can only ever prove that a bad token is rejected, never that a
// good one is accepted for the right reason.
export type EnrollOptions = {
  jwks?: JWTVerifyGetKey;
  audience?: string;
  allowedOwners?: readonly string[];
};

export function registerEnrollRoutes(app: Hono, opts: EnrollOptions = {}): void {
  const audience = opts.audience ?? config.enrollAudience;
  app.post('/api/enroll', async (c) => {
    const now = Date.now();
    const ip = clientIp(c);
    if (tooManyFailures(ip, now)) return c.json({ error: 'too_many_failed_attempts' }, 429);

    const header = c.req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      noteFailure(ip, now);
      audit({ outcome: 'denied', reason: 'missing_token' });
      return c.json(
        {
          error: 'missing_token',
          hint: 'Send a GitHub Actions OIDC token: Authorization: Bearer $(core.getIDToken("<audience>"))',
          audience,
        },
        401,
      );
    }

    const verified = await verifyGithubOidc(token, { jwks: opts.jwks, audience });
    if (!verified.ok) {
      noteFailure(ip, now);
      // No jti: the claims in an unverified token are the attacker's text, not
      // GitHub's, so none of them are recorded as if they were facts.
      audit({ outcome: 'denied', reason: verified.reason });
      return c.json({ error: 'invalid_token', reason: verified.reason, audience }, 401);
    }

    const claims = verified.claims;

    // Claim the token. The unique index on jti is the replay guard: a token
    // that leaked into a CI log is spent, not reusable until it expires.
    let attemptId: string;
    try {
      attemptId = audit({ jti: claims.jti, claims, outcome: 'denied', reason: 'in_progress' });
    } catch (err) {
      // ONLY a unique-constraint failure means "this token was already spent".
      // Catching everything would report a disk-full or a schema fault as a
      // replay — a wrong answer that looks like a security decision, which is
      // the worst way for this particular line to be wrong.
      if (!isUniqueViolation(err)) throw err;
      audit({ claims, outcome: 'denied', reason: 'token_replayed' });
      return c.json({ error: 'token_replayed' }, 401);
    }

    if (!ownerAllowed(claims.owner, opts.allowedOwners)) {
      setOutcome(attemptId, 'denied', 'owner_not_allowed', null);
      return c.json({ error: 'owner_not_allowed', owner: claims.owner }, 403);
    }

    const slug = slugFromRepository(claims.repository);
    if (!SLUG_RE.test(slug)) {
      setOutcome(attemptId, 'denied', 'invalid_slug', null);
      return c.json({ error: 'invalid_slug', message: 'the repository name must be [a-z0-9-], 2–39 chars', slug }, 400);
    }

    const db = getDb();

    // Bound by repository_id, not by name: a renamed repo keeps reaching its own
    // project, and a deleted-and-recreated repo gets a new id from GitHub and
    // therefore cannot silently inherit the old project's key.
    const byRepo = db.select().from(schema.projects).where(eq(schema.projects.enrollRepositoryId, claims.repositoryId)).get();
    if (byRepo) {
      // Idempotent on purpose. A re-run gets the SAME key back; rotating here
      // would kill the key in the service that is already running.
      db.update(schema.projects)
        .set({ enrollRepository: claims.repository, updatedAt: new Date() })
        .where(eq(schema.projects.id, byRepo.id))
        .run();
      setOutcome(attemptId, 'enrolled', null, byRepo.id);
      return c.json(credentials({ ...byRepo, enrollRepository: claims.repository }, false), 200);
    }

    const body = (await c.req.json().catch(() => ({}))) as { platform?: string; name?: string };
    const platform = PLATFORMS.has(String(body.platform)) ? String(body.platform) : 'node';
    const name = String(body.name ?? '').trim() || slug;

    const bySlug = db.select().from(schema.projects).where(eq(schema.projects.id, slug)).get();
    if (bySlug) {
      if (bySlug.enrollRepositoryId !== null) {
        // Someone else's project. Never an overwrite, never a rotation.
        setOutcome(attemptId, 'denied', 'slug_taken', null);
        return c.json({ error: 'slug_taken', message: `project "${slug}" is bound to another repository` }, 409);
      }
      // An UNBOUND project — every repo enrolled by hand before this feature
      // existed. Binding it hands the repo its existing credentials back, which
      // is exactly the "I lost my .env" recovery. The namespace is what makes
      // this safe: a repo name is unique inside a GitHub org, so `<org>/X` maps
      // one-to-one onto project X, and claiming one needs write access to the
      // org itself.
      // A project hand-inserted since the last boot never passed
      // ensureDsnNumericIds, so it can still be missing its numeric alias — and
      // then the response hands back dsn_numeric: null, which a workflow writes
      // out as the literal string "null". Fill it here rather than leave the
      // caller a value that reads as a DSN and is not one.
      const dsnNumericId = bySlug.dsnNumericId ?? nextDsnNumericId(db);
      const bound = { ...bySlug, dsnNumericId, enrollRepository: claims.repository, enrollRepositoryId: claims.repositoryId };
      db.update(schema.projects)
        .set({
          dsnNumericId,
          enrollRepository: claims.repository,
          enrollRepositoryId: claims.repositoryId,
          enrolledAt: new Date(),
          githubRepo: bySlug.githubRepo ?? claims.repository,
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, bySlug.id))
        .run();
      setOutcome(attemptId, 'enrolled', null, bySlug.id);
      return c.json(credentials(bound, false), 200);
    }

    const dsn = buildDsn(slug);
    const apiKey = genApiKey();
    const dsnNumericId = nextDsnNumericId(db);
    const at = new Date();
    const row = {
      id: slug,
      name,
      dsn,
      apiKey,
      platform,
      dsnNumericId,
      githubRepo: claims.repository,
      repo: slug,
      enrollRepository: claims.repository,
      enrollRepositoryId: claims.repositoryId,
      enrolledAt: at,
      createdAt: at,
      updatedAt: at,
    };
    db.insert(schema.projects).values(row).run();
    setOutcome(attemptId, 'created', null, slug);
    return c.json(credentials(db.select().from(schema.projects).where(eq(schema.projects.id, slug)).get()!, true), 201);
  });
}
