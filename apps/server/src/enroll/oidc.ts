// F032 — verifying a GitHub Actions OIDC token.
//
// THE POINT OF THE WHOLE FEATURE IS IN ONE SENTENCE: the repository name comes
// out of a token GitHub signed, not out of the request body. A caller can ask
// for anything it likes; it cannot make GitHub say it is a repo it is not.
//
// Everything cryptographic is `jose` (zero dependencies), deliberately. A
// hand-rolled verifier is where algorithm-confusion and a forgotten `exp` live,
// and this is not the feature to save a dependency on.
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { config } from '../config';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS_URL = new URL('https://token.actions.githubusercontent.com/.well-known/jwks');

// The claims GitHub asserts that we care about. `repository` and
// `repository_id` are the identity; the rest is for the audit trail.
export type GithubClaims = {
  jti: string;
  repository: string; // "broberg-ai/voice-engine"
  repositoryId: number;
  owner: string; // lowercased
  ref: string | null;
  sha: string | null;
  runId: string | null;
  workflow: string | null;
};

export type VerifyResult = { ok: true; claims: GithubClaims } | { ok: false; reason: string };

// jose caches the key set and re-fetches on an unknown `kid`, so this is one
// module-level instance rather than a fetch per request.
let remoteJwks: JWTVerifyGetKey | null = null;
function githubJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(GITHUB_JWKS_URL);
  return remoteJwks;
}

// A claim GitHub always sends as a string; `repository_id` is a string in the
// token even though it is a number. Parsed strictly — a non-numeric value means
// this is not the token we think it is, not a value to coerce.
function numericClaim(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function stringClaim(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Verify an OIDC token minted by GitHub Actions.
 *
 * `jwks` is injectable so the tests can sign their own tokens against a key set
 * they control — the alternative is a test that proves nothing because it never
 * exercises the verification path at all.
 */
export async function verifyGithubOidc(
  token: string,
  opts: { jwks?: JWTVerifyGetKey; audience?: string } = {},
): Promise<VerifyResult> {
  let payload: JWTPayload;
  try {
    // `algorithms` is not decoration. Without it a token could arrive claiming
    // `alg: none`, or HS256 signed with a public value, and be "verified".
    // `issuer` and `audience` are enforced by jose itself, so they cannot be
    // forgotten further down.
    ({ payload } = await jwtVerify(token, opts.jwks ?? githubJwks(), {
      algorithms: ['RS256'],
      issuer: GITHUB_ISSUER,
      audience: opts.audience ?? config.enrollAudience,
      // exp/nbf are checked by default; a GitHub token lives minutes.
    }));
  } catch (err) {
    // The reason is a code, never the exception text: an error string can carry
    // parts of the token, and this value is written to the audit trail.
    return { ok: false, reason: reasonFor(err) };
  }

  const jti = stringClaim(payload.jti);
  const repository = stringClaim(payload.repository);
  const repositoryId = numericClaim(payload.repository_id);
  const owner = stringClaim(payload.repository_owner);

  // A token that passes the signature but is missing the identity claims is not
  // a GitHub Actions token — it is some other token from the same issuer. There
  // is nothing to enroll, and guessing would be the whole vulnerability.
  if (!jti || !repository || repositoryId === null || !owner) return { ok: false, reason: 'missing_claims' };
  if (!repository.toLowerCase().startsWith(`${owner.toLowerCase()}/`)) return { ok: false, reason: 'missing_claims' };

  return {
    ok: true,
    claims: {
      jti,
      repository,
      repositoryId,
      owner: owner.toLowerCase(),
      ref: stringClaim(payload.ref),
      sha: stringClaim(payload.sha),
      runId: stringClaim(payload.run_id),
      workflow: stringClaim(payload.workflow),
    },
  };
}

function reasonFor(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === 'ERR_JWT_EXPIRED') return 'token_expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const claim = (err as { claim?: string })?.claim;
    if (claim === 'aud') return 'wrong_audience';
    if (claim === 'iss') return 'wrong_issuer';
    return 'claim_rejected';
  }
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'bad_signature';
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'alg_not_allowed';
  if (code === 'ERR_JWKS_NO_MATCHING_KEY') return 'unknown_key';
  return 'invalid_token';
}

/** `broberg-ai/voice-engine` → `voice-engine`. The project slug, never from the body. */
export function slugFromRepository(repository: string): string {
  return (repository.split('/')[1] ?? '').toLowerCase();
}

export function ownerAllowed(owner: string, allowed: readonly string[] = config.enrollAllowedOwners): boolean {
  return allowed.includes(owner.toLowerCase());
}
