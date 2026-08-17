import type { SubagentRun } from "./agentRuns"

/** A reap candidate is simply a child session id whose terminal completion has landed. */
export type ReapCandidate = string

/** Upper bound for the per-connection reaped ledger (issue #63): terminal completions keep
 *  arriving as long as the parent transcript grows, so the ledger is bounded FIFO to keep memory
 *  flat across long-lived connections. */
export const REAPED_SET_CAP = 200

/**
 * Decide which completed child sessions should be deleted right now. `completions` holds the
 * terminal completion signals keyed by child id (completed/error/cancelled by construction —
 * collectSubagentCompletions only records terminal states), so every key is a reap candidate
 * unless it is already reaped, already mid-delete, the very session the user is viewing, or the
 * feature is disabled. Candidates preserve the completions map's iteration order.
 */
export function reapCandidates(input: {
  completions: ReadonlyMap<string, SubagentRun>
  reaped: ReadonlySet<string>
  inFlight: ReadonlySet<string>
  selectedSessionID: string | null
  enabled: boolean
}): string[] {
  if (!input.enabled) return []
  const candidates: string[] = []
  for (const childID of input.completions.keys()) {
    if (input.reaped.has(childID)) continue
    if (input.inFlight.has(childID)) continue
    if (childID === input.selectedSessionID) continue
    candidates.push(childID)
  }
  return candidates
}

/** Fold newly reaped child ids into the bounded per-connection ledger, evicting the oldest entries
 *  (FIFO by insertion order) once it exceeds REAPED_SET_CAP. Re-adding an id already present is a
 *  Set no-op, so callers may re-report ids freely without growing the ledger twice. */
export function rememberReaped(current: ReadonlySet<string>, newly: readonly string[]): Set<string> {
  const next = new Set(current)
  for (const id of newly) next.add(id)
  const excess = next.size - REAPED_SET_CAP
  if (excess <= 0) return next
  let dropped = 0
  for (const id of next) {
    if (dropped >= excess) break
    next.delete(id)
    dropped += 1
  }
  return next
}