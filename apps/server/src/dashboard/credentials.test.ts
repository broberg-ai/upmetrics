// F015 — credential generation contract. Run: bun test src/dashboard/credentials.test.ts
import { describe, it, expect } from 'bun:test';
import { genApiKey, buildDsn, SLUG_RE } from './routes';
import { extractPublicKey } from '../ingest/envelope';

describe('F015 credential generation', () => {
  it('genApiKey → uk_<48 hex>', () => {
    const k = genApiKey();
    expect(k).toMatch(/^uk_[0-9a-f]{48}$/);
    expect(genApiKey()).not.toBe(k); // random
  });

  it('buildDsn is a valid Sentry DSN whose public key the ingest path can extract', () => {
    const dsn = buildDsn('acme');
    const url = new URL(dsn);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/acme'); // projectId in the path
    // the ingest envelope route validates extractPublicKey(project.dsn) === incoming key
    expect(extractPublicKey(dsn)).toMatch(/^[0-9a-f]{32}$/);
    expect(extractPublicKey(dsn)).toBe(url.username);
  });

  it('SLUG_RE: accepts good slugs, rejects bad ones', () => {
    for (const ok of ['acme', 'trail', 'fysiodk-aalborg-sport', 'a1', 'x-9']) expect(SLUG_RE.test(ok)).toBe(true);
    for (const bad of ['', 'a', 'A', '-x', 'has space', 'UPPER', 'sym!', 'x'.repeat(40)]) expect(SLUG_RE.test(bad)).toBe(false);
  });
});
