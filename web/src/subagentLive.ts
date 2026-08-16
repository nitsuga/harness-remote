import type { MessageEnvelope, MessagePart } from "./types"
// Explicit `.ts` extension: this module is exercised by the Node strip-types test runner, whose
// ESM resolver does not search for extensionless files (the app's Vite bundler resolves both).
import { isLiveSubagentStatus, subagentRunFromTool } from "./agentRuns.ts"

/** Live output captured for one running child session (issue #47). The lines are the tail of the
 *  child transcript's text parts (bounded). Kept in component state keyed by child session id,
 *  with each entry held referentially stable across refreshes that change nothing. */
export type ChildOutput = {
  lines: string[]
}

/** Merge the metadata of an ephemeral `session.tool.progress` event into the matching tool part of
 *  the parent transcript, immutably. The opencode v2 `subagent` tool publishes this event once at
 *  launch with `metadata: { sessionID: <childID>, status: "running" }` — the ONLY place the child
 *  session id exists while the child runs: durable transcript state carries it only after the
 *  terminal tool success lands, so without this the run card could not appear until the child
 *  finished. The event's `id` is the tool-call id, which is the part's `callID`; the event's
 *  `assistantMessageID` is the assistant message holding that call. Returns the same array when
 *  nothing matched (the part is not in the transcript yet) or nothing changed. */
export function applyStreamedToolProgress(
  messages: MessageEnvelope[],
  sessionID: string,
  assistantMessageID: string,
  callID: string,
  metadata: Record<string, unknown>
): MessageEnvelope[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.info.sessionID !== sessionID || message.info.id !== assistantMessageID) return message
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.callID !== callID) return part
      changed = true
      return {
        ...part,
        state: {
          ...(part.state ?? { status: "pending" }),
          metadata: { ...part.state?.metadata, ...metadata }
        }
      }
    })
    return changed ? { ...message, parts } : message
  })
  return changed ? next : messages
}

/** Normalize the `metadata` field of a v2 `session.tool.progress` event to the flat correlation
 *  record the run derivation reads (`{ sessionID, status }`). The opencode `subagent` plugin
 *  publishes `context.progress({ metadata: { sessionID, status: "running" } })`, so the event
 *  nests the record: `data.metadata = { metadata: { sessionID, status } }` — unlike a shell
 *  tool's flat `{ shellID }` update. Accept both shapes defensively (older captures used the flat
 *  one); return undefined when neither carries a sessionID, so a non-subagent progress update is
 *  never mistaken for a child correlation. */
export function subagentProgressMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  if (typeof metadata.sessionID === "string") return metadata
  const inner = metadata.metadata
  if (inner && typeof inner === "object" && !Array.isArray(inner) && typeof (inner as Record<string, unknown>).sessionID === "string") {
    return inner as Record<string, unknown>
  }
  return undefined
}

/** Flatten a child session's transcript into a bounded list of recent output lines for the live
 *  window. Messages arrive oldest-first (as rendered); only the tail matters, so when the cap cuts
 *  in the newest lines survive. Blank lines are dropped — the window is a few lines tall and the
 *  markdown spacing between paragraphs would otherwise eat the whole view. Text parts only: the
 *  assistant's actual output is what the window follows, and tool/reasoning internals stay out of
 *  the running summary (they remain visible when the run completes and the result card takes over). */
export function extractChildOutputLines(messages: readonly MessageEnvelope[], maxLines = 200): string[] {
  const lines: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "text" || !part.text) continue
      for (const line of part.text.split("\n")) {
        if (line.length === 0) continue
        lines.push(line)
      }
    }
  }
  return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
}

/** The child session ids of every delegated-subagent run currently in flight in a single message's
 *  parts, deduplicated and in transcript order. Only these children get a live-output fetch:
 *  terminal runs keep their result card and idle parts have no child work to follow. Shared by the
 *  transcript-wide scan below and by the memoized bubble renderers, which must agree on exactly
 *  which articles can be affected by a live child-output update (issue #47). */
export function liveSubagentChildIDsFromParts(parts: readonly MessagePart[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.type !== "tool") continue
    const run = subagentRunFromTool(part)
    if (run && isLiveSubagentStatus(run.status) && !seen.has(run.childID)) {
      seen.add(run.childID)
      ids.push(run.childID)
    }
  }
  return ids
}

/** The child session ids of every delegated-subagent run currently in flight in a transcript,
 *  deduplicated and in transcript order — the per-message scan above across every message. Only
 *  these children get a live-output fetch: terminal runs keep their result card and idle parts
 *  have no child work to follow. */
export function liveSubagentChildIDs(messages: readonly MessageEnvelope[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const childID of liveSubagentChildIDsFromParts(message.parts)) {
      if (seen.has(childID)) continue
      seen.add(childID)
      ids.push(childID)
    }
  }
  return ids
}
