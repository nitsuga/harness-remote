/**
 * Pure persistence helpers for the attention-inbox dismissed/notified sets (issue #9).
 *
 * The storage key is an opaque hash of the profile/config namespace — never raw configKey values,
 * which include server credentials — mirroring the session-tombstone technique in App.tsx
 * (tombstoneNamespaceKey). Only type imports, so the node test runner can load this file directly.
 */

export type AttentionState = { dismissed: string[]; notified: string[] }

/**
 * `opencode.remote.attention.<hash>`: the hash is FNV-1a 32-bit over the namespace, exactly like the
 * session-tombstone keys — never put server credentials (part of the config key) into localStorage
 * keys.
 */
export function attentionStorageKey(namespace: string): string {
  let hash = 2166136261
  for (const char of namespace) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `opencode.remote.attention.${(hash >>> 0).toString(16)}`
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length < 512)
}

export function loadAttentionState(storageKey: string): AttentionState {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(storageKey)
    if (!raw) return { dismissed: [], notified: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { dismissed: [], notified: [] }
    const state = parsed as { dismissed?: unknown; notified?: unknown }
    return { dismissed: readStrings(state.dismissed), notified: readStrings(state.notified) }
  } catch {
    // Corrupt or unavailable storage is treated as empty.
    return { dismissed: [], notified: [] }
  }
}

export function saveAttentionState(storageKey: string, state: AttentionState): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // Storage can be disabled or full; in-memory protections still apply.
  }
}

/**
 * Drop persisted entries whose id no longer has a live occurrence, so the storage never grows
 * without bound:
 *  - Generation-form entries (`f:<sid>@<at>`, `c:<sid>@<at>`) survive only while that exact
 *    generation is live — a dismissed failure re-alerts after a re-failure (new generation).
 *  - Bare `q:<rid>` / `p:<rid>` entries survive while ANY live item carries that id (their
 *    generation is session.updated, which changes on unrelated activity, so only the id is stable).
 * Anything else — including bare f:/c: entries, which are never the storage format — is dropped.
 */
export function pruneAttentionState(state: AttentionState, liveGenerations: ReadonlySet<string>): AttentionState {
  const keep = (entry: string): boolean => {
    if (liveGenerations.has(entry)) return true
    if (entry.startsWith("q:") || entry.startsWith("p:")) {
      for (const generation of liveGenerations) {
        if (generation.startsWith(`${entry}@`)) return true
      }
    }
    return false
  }
  return {
    dismissed: state.dismissed.filter(keep),
    notified: state.notified.filter(keep)
  }
}
