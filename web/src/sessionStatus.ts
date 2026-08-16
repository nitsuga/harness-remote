import type { SessionStatus } from "./types"

/** The wire event kinds that carry execution lifecycle facts for an OpenCode 2 session. */
export type ExecutionEventKind = "started" | "succeeded" | "failed" | "interrupted" | "retry" | "error"

export type ExecutionEvent = {
  kind: ExecutionEventKind
  at: number            // ARRIVAL time (Date.now() at reduce), never payload timestamps
  sessionID: string
  error?: { message?: string }
  attempt?: number
  next?: number         // retry.scheduled `at` (epoch when retry fires)
}

/** Per-session execution facts reduced from the SSE stream. `latest` holds the newest non-error
 *  event by arrival time; `error` events only record `lastError` (never `latest`), so a crash that
 *  follows a `started` keeps both halves of the "crashed while running" story. */
export type SessionExecutionMemory = {
  latest?: { kind: Exclude<ExecutionEventKind, "error">; at: number }
  /** The failed event's own error message, kept alongside `latest` so the failed status can surface it. */
  latestError?: { message?: string }
  lastError?: { message?: string; at: number }
  retry?: { attempt?: number; at?: number; error?: { message?: string } }
}

/** Map an SSE event type onto an execution-event kind; anything outside the v2 lifecycle yields
 *  undefined so unrelated events never touch the execution memory. */
export function executionEventKind(type: string): ExecutionEventKind | undefined {
  switch (type) {
    case "session.execution.started": return "started"
    case "session.execution.succeeded": return "succeeded"
    case "session.execution.failed": return "failed"
    case "session.execution.interrupted": return "interrupted"
    case "session.retry.scheduled": return "retry"
    case "session.error": return "error"
    default: return undefined
  }
}

/**
 * Fold one execution event into the session's memory, returning a NEW object (never mutating the
 * input). Every non-error event replaces `latest` by arrival time — a newer event supersedes an
 * older one regardless of word (failed → retry → started is a single monotonically newer line).
 * `error` updates `lastError` only; `retry` additionally records its scheduling; `interrupted`
 * resets the session to idle by clearing every remembered error/retry fact.
 */
export function reduceExecutionEvent(memory: SessionExecutionMemory | undefined, event: ExecutionEvent): SessionExecutionMemory {
  const previous = memory ?? {}
  const next: SessionExecutionMemory = { ...previous }
  if (event.kind === "error") {
    next.lastError = { message: event.error?.message, at: event.at }
    return next
  }
  next.latest = { kind: event.kind, at: event.at }
  if (event.kind === "failed") {
    next.latestError = { message: event.error?.message }
  } else {
    delete next.latestError
  }
  if (event.kind === "retry") {
    next.retry = { attempt: event.attempt, at: event.next, error: event.error }
  }
  if (event.kind === "interrupted") {
    // Interrupted resets everything to idle: the interruption itself is the newest fact, and any
    // remembered error or retry must not resurface afterwards.
    delete next.lastError
    delete next.retry
  }
  return next
}

/** The per-refresh signals the derivation combines with the execution memory. */
export type SessionStatusSignals = {
  active: ReadonlySet<string>
  pendingForms: readonly { sessionID?: string }[]
  pendingPermissions: readonly { sessionID?: string }[]
}

/**
 * Derive the session's activity status from execution memory plus live signals, first match wins:
 * waiting (blocked on a form/permission) > completed > failed > retrying > busy / needs-attention
 * > idle. A `started` with no active-set membership and no newer error is idle — the agent is
 * neither running here nor crashed — and `interrupted` always means idle.
 */
export function deriveSessionStatus(
  sessionID: string,
  signals: SessionStatusSignals,
  memory: SessionExecutionMemory | undefined
): SessionStatus | undefined {
  // A pending form or permission for this session outranks everything: the agent is blocked on the
  // user right now.
  if (
    signals.pendingForms.some((form) => form.sessionID === sessionID)
    || signals.pendingPermissions.some((request) => request.sessionID === sessionID)
  ) {
    return { type: "waiting" }
  }
  const latest = memory?.latest
  if (latest?.kind === "succeeded") return { type: "completed" }
  if (latest?.kind === "failed") {
    const result: SessionStatus = { type: "failed" }
    if (memory?.latestError?.message) result.message = memory.latestError.message
    return result
  }
  if (latest?.kind === "retry") {
    const result: SessionStatus = { type: "retrying" }
    if (memory?.retry?.attempt !== undefined) result.attempt = memory.retry.attempt
    if (memory?.retry?.at !== undefined) result.next = memory.retry.at
    if (memory?.retry?.error?.message) result.message = memory.retry.error.message
    return result
  }
  if (latest?.kind === "started") {
    if (signals.active.has(sessionID)) return { type: "busy" }
    // Not running here: an error that arrived AFTER the start means the run crashed mid-flight.
    if (memory?.lastError && memory.lastError.at > latest.at) {
      const result: SessionStatus = { type: "needs-attention" }
      if (memory.lastError.message) result.message = memory.lastError.message
      return result
    }
    return undefined
  }
  if (latest?.kind === "interrupted") return undefined
  // No execution facts yet: fall back to the active-set signal, or a remembered error.
  if (signals.active.has(sessionID)) return { type: "busy" }
  if (memory?.lastError) {
    const result: SessionStatus = { type: "needs-attention" }
    if (memory.lastError.message) result.message = memory.lastError.message
    return result
  }
  return undefined
}
