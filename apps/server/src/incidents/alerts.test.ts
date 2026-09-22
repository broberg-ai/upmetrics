// Alert engine (F005.2) dedup window — proves credit_low gets a longer,
// once/day window instead of the default hourly re-alert. Run: bun test src/incidents/alerts.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDb, schema, type Db } from '../db';
import { runAlerts } from './alerts';
import { runAlertsStorm } from './storm';
import { mailer } from '../mail';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const origFetch = globalThis.fetch;

let seq = 0;
function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string): void {
  db.insert(schema.projects)
    .values({ id, name: id, dsn: `https://k@upmetrics.org/${id}`, apiKey: `uk_${id}`, platform: 'web', retentionDays: 30, createdAt: new Date(), updatedAt: new Date() })
    .run();
}
function addIncident(db: Db, projectId: string, kind: string, severity = 'high'): string {
  const id = `inc_${++seq}`;
  db.insert(schema.incidents)
    .values({ id, projectId, kind, status: 'open', severity, title: `${kind} on ${projectId}`, openedAt: new Date(), triggerRef: `ref_${id}` })
    .run();
  return id;
}
function addRule(db: Db, projectId: string, kind: string, channels: string[] = ['discord']): void {
  db.insert(schema.alertRules)
    .values({ id: `rule_${++seq}`, projectId, kind, condition: null, channels, enabled: true, createdAt: new Date() })
    .run();
}

beforeEach(() => {
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('credit_low alert dedup window (once/day, no hourly nagging)', () => {
  it('an unchanged credit_low incident is NOT re-alerted 2h later (still within the 24h window)', async () => {
    const db = freshDb();
    addProject(db, 'p1');
    addIncident(db, 'p1', 'credit_low');
    addRule(db, 'p1', 'credit_low');
    const t0 = new Date(0);
    const first = await runAlerts(db, t0);
    expect(first.fired).toBe(1);
    const t1 = new Date(2 * 3_600_000); // +2h
    const second = await runAlerts(db, t1);
    expect(second.fired).toBe(0);
    expect(second.deduped).toBe(1);
  });

  it('a probe_down incident (default 1h window) DOES re-alert 2h later — other kinds unaffected', async () => {
    const db = freshDb();
    addProject(db, 'p2');
    addIncident(db, 'p2', 'probe_down');
    addRule(db, 'p2', 'probe_down');
    const t0 = new Date(0);
    const first = await runAlerts(db, t0);
    expect(first.fired).toBe(1);
    const t1 = new Date(2 * 3_600_000); // +2h, past the default 1h window
    const second = await runAlerts(db, t1);
    expect(second.fired).toBe(1);
    expect(second.deduped).toBe(0);
  });
});

// F034 — Christian, 22/9 2026: «Stop med mails helt» + «Jeg vil have blod røde
// alerts ikke ubetydelige warnings». Begge spærrer sidder i LEVERINGEN; en
// medium incident rejses stadig og står i dashboardet.
describe('F034 — alarm-levering: mail slukket, og kun blodrødt slipper igennem', () => {
  it('en MEDIUM error_spike leveres ikke — den samme incident på HIGH gør', async () => {
    const db = freshDb();
    addProject(db, 'p3');
    addRule(db, 'p3', '*');
    const id = addIncident(db, 'p3', 'error_spike', 'medium');

    // Præcis hans mail: «MEDIUM incident on Trail — Error spike — 14 errors in window».
    const quiet = await runAlerts(db, new Date(0));
    expect(quiet.fired).toBe(0);
    expect(quiet.suppressed).toBe(1);
    expect(db.select().from(schema.alertHistory).all().length).toBe(0);

    // Samme incident eskalerer til high (≥30 fejl i vinduet) → den SKAL ringe.
    db.update(schema.incidents).set({ severity: 'high' }).where(eq(schema.incidents.id, id)).run();
    const loud = await runAlerts(db, new Date(0));
    expect(loud.fired).toBe(1);
    expect(loud.suppressed).toBe(0);
  });

  it('gulvet gælder også gennem storm-kontrollen — den vej produktionen faktisk bruger', async () => {
    const db = freshDb();
    addProject(db, 'p4');
    addRule(db, 'p4', '*');
    addIncident(db, 'p4', 'error_spike', 'medium');
    const res = await runAlertsStorm(db, new Date(0));
    expect(res.fired).toBe(0);
    expect(db.select().from(schema.alertHistory).all().length).toBe(0);
  });

  it('en incident med en UKENDT severity ringer — gulvet må ikke tie den ihjel', async () => {
    const db = freshDb();
    addProject(db, 'p7');
    addRule(db, 'p7', '*');
    addIncident(db, 'p7', 'probe_down', 'urgent'); // en art ingen har set før
    const res = await runAlerts(db, new Date(0));
    expect(res.fired).toBe(1);
    expect(res.suppressed).toBe(0);
  });

  it('en regel hvis ENESTE kanal er email leverer intet — og forgifter ikke dedup-vinduet', async () => {
    const db = freshDb();
    addProject(db, 'p6');
    addRule(db, 'p6', '*', ['email']);
    addIncident(db, 'p6', 'probe_down', 'critical');
    const res = await runAlerts(db, new Date(0));
    expect(res.fired).toBe(0);
    expect(res.suppressed).toBe(1);
    // Ingen række: alert_history ER dedup-lageret, så en «levering» der aldrig
    // skete ville lukke munden på den ægte alarm en time frem.
    expect(db.select().from(schema.alertHistory).all().length).toBe(0);
  });

  it('en regel med email+discord leverer KUN discord, og mailer bliver aldrig kaldt', async () => {
    const db = freshDb();
    addProject(db, 'p5');
    // Giv projektet en rigtig Discord-webhook, så kanalen faktisk kan levere
    // (globalThis.fetch er stubbet til 204). Ellers ville discord fejle af egne
    // grunde og testen kunne ikke se forskel på «mail filtreret fra» og
    // «ingen kanal virkede».
    db.update(schema.projects).set({ alertDiscordWebhook: 'https://discord.test/hook' }).where(eq(schema.projects.id, 'p5')).run();
    addRule(db, 'p5', '*', ['email', 'discord']);
    addIncident(db, 'p5', 'probe_down', 'critical');

    const origSend = mailer.send;
    let mailCalls = 0;
    (mailer as { send: unknown }).send = async () => {
      mailCalls++;
      return { ok: true };
    };
    try {
      const res = await runAlerts(db, new Date(0));
      expect(res.fired).toBe(1);
    } finally {
      (mailer as { send: unknown }).send = origSend;
    }

    // Streng lighed, ikke «indeholder»: ['discord'] og ['email','discord'] ville
    // begge bestå en contains-test.
    const rows = db.select().from(schema.alertHistory).all();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.channelsSent).toEqual(['discord']);
    // Og gulvet under dét: et FORSØGT mail-kald der fejler ville også efterlade
    // channelsSent=['discord']. De to skelnes kun her — ingen fejl-linje, og
    // mailer aldrig rørt.
    expect(row.errors).toBe(null);
    expect(mailCalls).toBe(0);
  });
});
