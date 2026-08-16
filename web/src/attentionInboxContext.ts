import { createContext } from "react"
import type { AttentionItem } from "./attentionInbox"
import type { SavedPermission } from "./types"
import type { V2InboxItem } from "./opencode2-mappers"

/**
 * Cross-session attention inbox (issue #9). App.tsx owns the derivation, persistence, and
 * notifications; this module owns the CONTEXT so the panel components can import it without a
 * module cycle (App.tsx already imports the session list, which renders the panel — importing the
 * context back from App.tsx would create App → session-list → panel → App).
 */
export type AttentionInboxContextValue = {
  items: readonly AttentionItem[]
  queuedBySession: ReadonlyMap<string, V2InboxItem[]>
  badge: number
  dismiss(item: AttentionItem): void
  /** Open the item's session (navigating profiles if needed is out of scope — the item is always
   *  from the active machine; the panel shows only the active machine). */
  open(item: AttentionItem): void
  /** Queued-prompt operations (v2 only): cancel/steer/queue an undelivered inbox item. */
  cancelQueued(sessionID: string, inboxID: string): void
  steerQueued(sessionID: string, inboxID: string): void
  queueQueued(sessionID: string, inboxID: string): void
  /** Saved allow-always grants (v2 only); load on demand, empty until loaded. */
  savedPermissions: readonly SavedPermission[]
  loadSavedPermissions(): void
  revokeSavedPermission(id: string): void
}

export const AttentionInboxContext = createContext<AttentionInboxContextValue | null>(null)
