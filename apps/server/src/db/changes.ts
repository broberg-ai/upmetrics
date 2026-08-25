// F025.2 — how many rows a write ACTUALLY touched.
//
// drizzle's `.run()` is TYPED `void` on bun:sqlite, but at runtime it returns
// the driver's `{ changes, lastInsertRowid }`. So the count is there, it is
// simply invisible to the type-checker — which is exactly why every call-site
// in this repo discarded it (measured 2026-08-25: zero readers).
//
// The distinction that matters: a job that never asks how many rows it removed
// cannot tell "there was nothing to delete" from "deleting stopped working".
// Both look like silence, and only one of them fills the disk.
export function rowsChanged(result: unknown): number | null {
  if (typeof result !== 'object' || result === null) return null;
  const changes = (result as { changes?: unknown }).changes;
  // Deliberately null — never a guess at 0 or 1. A guessed 0 would make a prune
  // report "nothing to do" forever, which is the failure this exists to catch,
  // and the caller would have no way to know it was guessing. Returning null
  // forces the call-site to decide what an unreadable answer means.
  return typeof changes === 'number' ? changes : null;
}
