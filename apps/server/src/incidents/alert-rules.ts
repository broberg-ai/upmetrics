// F033.1 — every project gets an alert rule, including the 15 that never got one.
//
// An alert hangs on a row in alert_rules. No row ⇒ no channel ⇒ no message, even
// when the incident is raised perfectly. Measured on production 2026-09-20:
// 24 projects, 9 with a rule, 15 without — and the 15 are the ones nobody ever
// touched, i.e. exactly where a silent outage would last longest.
//
// Same shape as the 9 rules that already work (kind '*', no condition, falling
// back to the single fleet webhook) — this is not a new invention, it is the row
// that already exists nine times, given to the other fifteen. Owner's words the
// same day: "Både mail + Discord her i starten - push - alle 15".
//
// Deliberately a boot-time sweep rather than a migration, for the same reason
// ensureDsnNumericIds (F031) is: a migration runs ONCE and hand-inserted rows
// keep arriving afterwards — which is how most fleet repos were actually
// enrolled.
import { sql } from 'drizzle-orm';
import { getDb, schema } from '../db';

type Db = ReturnType<typeof getDb>;

// Both channels from the start (owner, 2026-09-20). Discord resolves to the one
// fleet webhook; email needs FLEET_ALERT_EMAIL — until that is set the email leg
// records "email channel not configured" in alert_history.errors and Discord
// still delivers. Ships dark, never crashes.
export const DEFAULT_ALERT_CHANNELS = ['email', 'discord'] as const;

/**
 * Give every project without ANY alert rule the default one. Idempotent; returns
 * how many rows it inserted.
 *
 * The predicate is "has no row", not "has no ENABLED row", on purpose: a disabled
 * rule is a CHOICE somebody made, and inserting a fresh enabled row beside it
 * would silently undo that choice. The cost — a deliberately silent project looks
 * covered in a row count — is what F033.2's guard exists to surface.
 */
export function ensureDefaultAlertRules(db: Db = getDb()): number {
  const uncovered = db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(sql`not exists (select 1 from alert_rules r where r.project_id = ${schema.projects.id})`)
    .all();
  if (uncovered.length === 0) return 0;

  const now = new Date();
  for (const p of uncovered) {
    db.insert(schema.alertRules)
      .values({
        id: crypto.randomUUID(),
        projectId: p.id,
        kind: '*',
        condition: null,
        channels: [...DEFAULT_ALERT_CHANNELS],
        enabled: true,
        createdAt: now,
      })
      .run();
  }
  console.log(`[alerts] default rule created for ${uncovered.length} project(s): ${uncovered.map((p) => p.id).join(', ')}`);
  return uncovered.length;
}
