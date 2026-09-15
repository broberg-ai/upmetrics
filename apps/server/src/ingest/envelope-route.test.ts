// F031 — the DSN path segment resolves by slug OR numeric alias.
//
// Sentry's own DSN parser refuses a non-integer project segment, so
// `sentry_sdk.init()` throws `BadDsn` before sending anything. voice-engine
// measured that on 2026-09-15; the numeric alias is what lets every Python
// service in the fleet use the official maintained client instead of copying raw
// envelope code into each repo.
//
// Run: bun test src/ingest/envelope-route.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq, or } from 'drizzle-orm';
import { getDb, schema, ensureDsnNumericIds } from '../db';
import { registerIngestRoutes } from './routes';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const NOW = new Date('2026-09-15T12:00:00Z');
const app = new Hono();

// Public keys differ per project so a cross-project hit cannot pass auth by luck.
const P = {
  alpha: { id: 'alpha', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', num: 7 },
  // A project whose SLUG IS NUMERIC — the case the lookup order exists for.
  numeric: { id: '7', key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', num: 99 },
};

function project(id: string, key: string, num: number) {
  getDb()
    .insert(schema.projects)
    .values({
      id,
      name: id,
      dsn: `https://${key}@upmetrics.org/${id}`,
      apiKey: `uk_${id}`,
      platform: 'node',
      dsnNumericId: num,
      retentionDays: 30,
      agentRetentionDays: 90,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

beforeAll(() => {
  migrate(getDb(), { migrationsFolder: MIGRATIONS });
  project(P.alpha.id, P.alpha.key, P.alpha.num);
  project(P.numeric.id, P.numeric.key, P.numeric.num);
  registerIngestRoutes(app);
});

let n = 0;
function envelope(): string {
  // padEnd on a counter COLLIDES: 'ev1' padded to 32 with '0' is byte-identical
  // to 'ev10' padded to 32. The route then answers accepted:1 for an event it
  // already had (onConflictDoNothing — correct, a re-delivery is idempotent
  // success), and the test's row-count assertion failed while nothing was wrong
  // with the server. Found by that failure; the id is now padded on the LEFT so
  // distinct counters stay distinct.
  const id = `ev${String(++n).padStart(29, '0')}`;
  return (
    JSON.stringify({ event_id: id, sent_at: NOW.toISOString() }) +
    '\n' +
    JSON.stringify({ type: 'event' }) +
    '\n' +
    JSON.stringify({ event_id: id, exception: { values: [{ type: 'E', value: 'v' }] } })
  );
}

const post = (segment: string, key: string) =>
  app.request(`/api/${segment}/envelope/`, {
    method: 'POST',
    headers: {
      'X-Sentry-Auth': `Sentry sentry_key=${key}, sentry_version=7`,
      'content-type': 'application/x-sentry-envelope',
    },
    body: envelope(),
  });

const eventsFor = (id: string) =>
  getDb().select().from(schema.events).where(eq(schema.events.projectId, id)).all().length;

describe('F031 a DSN path segment is either the slug or the numeric alias', () => {
  it('the SLUG form still works — a new way in must not close the old one', async () => {
    const before = eventsFor('alpha');
    const res = await post('alpha', P.alpha.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1, dropped: 0 });
    expect(eventsFor('alpha')).toBe(before + 1);
  });

  it('an alias with no slug collision reaches its project', async () => {
    const before = eventsFor('7');
    const res = await post('99', P.numeric.key);
    expect(res.status).toBe(200);
    expect(eventsFor('7')).toBe(before + 1);
  });

  // THE LOOKUP ORDER IS THE GUARD, not a preference. A project whose slug is
  // numeric must always reach ITS OWN project and can never be captured by
  // whichever project holds that number as an alias.
  it('SLUG WINS over an alias with the same value', async () => {
    const beforeNumeric = eventsFor('7');
    const beforeAlpha = eventsFor('alpha');
    // Segment '7' is P.numeric's slug AND P.alpha's alias. It must be P.numeric.
    const res = await post('7', P.numeric.key);
    expect(res.status).toBe(200);
    expect(eventsFor('7')).toBe(beforeNumeric + 1);
    expect(eventsFor('alpha')).toBe(beforeAlpha);
  });

  // THE NEGATIVE CONTROL. Without it, "the alias works" cannot be told apart
  // from "the route accepts anything" — and the second would land one repo's
  // errors on another repo's board, the exact damage helpdesk measured from the
  // other side the same day.
  it('an UNKNOWN numeric id is 404 — it never falls through to some project', async () => {
    const res = await post('424242', P.alpha.key);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown_project' });
  });

  it('an unknown SLUG is still 404', async () => {
    const res = await post('no-such-project', P.alpha.key);
    expect(res.status).toBe(404);
  });

  // The alias identifies the project; it does not authenticate. The DSN's public
  // key still has to match, or a known number would be a way in.
  it('the alias does not bypass the key check', async () => {
    const res = await post('99', P.alpha.key); // right project, wrong key
    expect(res.status).toBe(401);
  });
});

describe('F031 every project has an alias', () => {
  // Scoped to the projects THIS file created. The suite shares one in-memory
  // database, and other files insert projects straight through the ORM without
  // an alias — asserting over every row would measure their fixtures, not our
  // behaviour, and would go red for a reason that has nothing to do with F031.
  it('assigns a unique alias, and ensureDsnNumericIds fills a hand-inserted row', () => {
    const mine = getDb()
      .select()
      .from(schema.projects)
      .where(or(eq(schema.projects.id, 'alpha'), eq(schema.projects.id, '7')))
      .all();
    expect(mine.length).toBe(2);
    const ids = mine.map((r) => r.dsnNumericId);
    expect(ids.every((v) => typeof v === 'number')).toBe(true);
    expect(new Set(ids).size).toBe(2);

    // The real gap: a project inserted BY HAND (how fleet repos are actually
    // enrolled) never passes the route that hands out aliases.
    getDb()
      .insert(schema.projects)
      .values({
        id: 'hand-enrolled',
        name: 'hand-enrolled',
        dsn: 'https://cccccccccccccccccccccccccccccccc@upmetrics.org/hand-enrolled',
        apiKey: 'uk_hand',
        platform: 'node',
        retentionDays: 30,
        agentRetentionDays: 90,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const before = getDb().select().from(schema.projects).where(eq(schema.projects.id, 'hand-enrolled')).get();
    expect(before!.dsnNumericId).toBeNull(); // the gap is real, asserted

    ensureDsnNumericIds(getDb());
    const after = getDb().select().from(schema.projects).where(eq(schema.projects.id, 'hand-enrolled')).get();
    expect(typeof after!.dsnNumericId).toBe('number');
  });
});

// F031.2 — every official Sentry client gzips, and a body we cannot read must
// not answer 200.
//
// Reported by voice-engine the same hour F031.1 shipped: the alias worked, and
// it uncovered the next layer. Their point is the load-bearing one — the danger
// is not gzip, it is the 200. An official client does not read the body of a
// 2xx, so `accepted:0` is delivered on a channel nobody listens to.
describe('F031.2 gzip, and a body we could not read', () => {
  const gz = (s: string) => Bun.gzipSync(new TextEncoder().encode(s));

  const postRaw = (segment: string, key: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
    app.request(`/api/${segment}/envelope/`, {
      method: 'POST',
      headers: {
        'X-Sentry-Auth': `Sentry sentry_key=${key}, sentry_version=7`,
        'content-type': 'application/x-sentry-envelope',
        ...headers,
      },
      body,
    });

  it('a GZIPPED envelope lands exactly like the uncompressed one', async () => {
    // The SAME body in both forms, so compression is the only difference.
    const body = envelope();
    const before = eventsFor('alpha');

    const plain = await postRaw('alpha', P.alpha.key, body);
    expect(await plain.json()).toMatchObject({ accepted: 1, dropped: 0 });

    const gzipped = await postRaw('alpha', P.alpha.key, gz(envelope()), { 'content-encoding': 'gzip' });
    expect(gzipped.status).toBe(200);
    expect(await gzipped.json()).toMatchObject({ accepted: 1, dropped: 0 });

    expect(eventsFor('alpha')).toBe(before + 2);
  });

  it('a gzipped body sent WITHOUT the header is 400 — the shape that caused this', async () => {
    const res = await postRaw('alpha', P.alpha.key, gz(envelope()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'malformed_envelope' });
  });

  it('plain nonsense is 400', async () => {
    const res = await postRaw('alpha', P.alpha.key, 'this is not an envelope at all');
    expect(res.status).toBe(400);
  });

  // THE NEGATIVE CONTROL. "We could not READ it" and "we read it and it was not
  // for us" must never collapse — otherwise we trade one silent failure for a
  // noisy one, and sentry-sdk's sessions would start failing every send.
  it('a VALID envelope whose items we do not store is still 200 with dropped:N', async () => {
    const body =
      JSON.stringify({ event_id: 'a'.repeat(32), sent_at: NOW.toISOString() }) +
      '\n' +
      JSON.stringify({ type: 'session' }) +
      '\n' +
      JSON.stringify({ sid: 'x', status: 'ok' });
    const res = await postRaw('alpha', P.alpha.key, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 0, dropped: 1 });
  });

  it('an uncompressed envelope with no Content-Encoding still works', async () => {
    const before = eventsFor('alpha');
    const res = await postRaw('alpha', P.alpha.key, envelope());
    expect(res.status).toBe(200);
    expect(eventsFor('alpha')).toBe(before + 1);
  });
});
