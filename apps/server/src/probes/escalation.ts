// F019.2 — tiered severity escalation for probe outages. A sustained probe
// failure escalates the open probe_down incident's severity across configured
// tiers (e.g. 3 consecutive failures → high, 10 → critical). Escalation only ever
// RAISES severity: a higher severity breaks the alert engine's per-incident dedup
// (see incidents/alerts.ts isDeduped), so a worsening outage re-alerts instead of
// sitting silent. Recovery still resolves the incident via the existing F004 path.
// Pure logic here; the wiring lives in probes/routes.ts.

export type Severity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export interface EscalationTier {
  failures: number; // consecutive failures at/after which this severity applies
  severity: Severity;
}

function isSeverity(s: string): s is Severity {
  return s === 'low' || s === 'medium' || s === 'high' || s === 'critical';
}

export function severityRank(s: string): number {
  return SEVERITY_RANK[s as Severity] ?? 0;
}

// Parse "3:high,10:critical" → [{failures:3,severity:'high'},{failures:10,severity:'critical'}]
// sorted ascending by failures. Invalid entries (bad count or unknown severity)
// are skipped; empty/garbage input → []. Single source: config.probeEscalateTiers.
export function parseTiers(raw: string): EscalationTier[] {
  const tiers: EscalationTier[] = [];
  for (const part of raw.split(',')) {
    const [countRaw, sevRaw] = part.split(':');
    const failures = Number((countRaw ?? '').trim());
    const severity = (sevRaw ?? '').trim();
    if (!Number.isInteger(failures) || failures < 1) continue;
    if (!isSeverity(severity)) continue;
    tiers.push({ failures, severity });
  }
  return tiers.sort((a, b) => a.failures - b.failures);
}

// Highest tier whose threshold is met by `failures`, or null if below the first.
export function severityForFailures(failures: number, tiers: EscalationTier[]): Severity | null {
  let match: Severity | null = null;
  for (const t of tiers) {
    if (failures >= t.failures) match = t.severity;
  }
  return match;
}

// The new severity if `candidate` outranks `current`, else null (never lowers,
// never churns on an equal severity).
export function escalatedSeverity(current: string, candidate: Severity | null): Severity | null {
  if (!candidate) return null;
  return severityRank(candidate) > severityRank(current) ? candidate : null;
}
