import type { AgentRun, AgentAttention } from "./agentRuns"
import type { BackendKind, PermissionRequest, QuestionRequest } from "./types"

/**
 * Pure projection of agent runs onto cross-session attention inbox items (issue #9).
 *
 * An inbox item is one attention-worthy fact about one session: a pending question, a pending
 * permission request, a failed run, or a completed run. Every item carries everything the card
 * renderer needs without further lookups — session title, working directory (for
 * `openSession(sessionID, directory)`), backend and machine — plus a short message summarizing the
 * fact (the action name for permissions, the first question label for questions, failure text when
 * the caller has it). Messages are hard-capped at 140 characters.
 *
 * One item PER REQUEST for questions and permissions (a session with two pending forms shows two
 * items, each resolving independently — `AgentRun.attention` only ever carries the first matching
 * request, so the projection enumerates the request signals directly), and one item per (session,
 * kind) for failures and completions (superseded in place, keyed by session id). The result is
 * sorted newest-first by occurrence time `at`. The module is deliberately free of runtime sibling
 * imports (only type-only imports), so the node test runner can load it directly.
 */

export type AttentionItemKind = "question" | "permission" | "failure" | "completion"

export type AttentionItem = {
  /** Dedup key: `q:<requestId>` | `p:<requestId>` | `f:<sessionId>` | `c:<sessionId>`. */
  id: string
  kind: AttentionItemKind
  sessionId: string
  sessionTitle: string
  /** REQUIRED — `openSession(sessionID, directory)` needs it. */
  directory: string
  backend: BackendKind
  machineId?: string
  agent?: string
  /** Present on question | permission items: the server request id the reply/cancel targets. */
  requestId?: string
  /** Failure message | permission action name | short question label. Never permission patterns. */
  message?: string
  /** Occurrence generation: F/C = execution-memory latest.at (passed in); Q/P = session.updated. */
  at: number
}

export function attentionItemId(kind: AttentionItemKind, sessionId: string, requestId?: string): string {
  if (kind === "question") return `q:${requestId ?? ""}`
  if (kind === "permission") return `p:${requestId ?? ""}`
  if (kind === "failure") return `f:${sessionId}`
  return `c:${sessionId}`
}

export type AttentionItemSignals = {
  questions?: readonly QuestionRequest[]
  permissions?: readonly PermissionRequest[]
}

/**
 * The occurrence time an inbox item is generated at. Questions and permissions are keyed to the
 * session's own update time (their lifecycle is server-side), while failures and completions are
 * keyed to the execution-memory generation the caller passes in — a NEW failure gets a NEW `at`,
 * which is what lets a re-failure re-alert after a dismissal.
 */
export function attentionItemAt(run: AgentRun, kind: AttentionItemKind, attentionAt?: (sessionId: string) => number | undefined): number {
  if (kind === "question" || kind === "permission") return run.updatedAt ?? 0
  return attentionAt?.(run.sessionId) ?? run.updatedAt ?? 0
}

export type AttentionItemDraft = {
  run: AgentRun
  attention: AgentAttention
  itemAt: number
  message?: string
  requestId?: string
}

/** Hard cap for every inbox-item message (the card is a summary, the session reveals the detail). */
const ATTENTION_MESSAGE_MAX = 140

function truncateMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  return message.length <= ATTENTION_MESSAGE_MAX ? message : message.slice(0, ATTENTION_MESSAGE_MAX)
}

export function attentionItemFromDraft(draft: AttentionItemDraft): AttentionItem {
  const { run, attention, itemAt, message, requestId } = draft
  const kind: AttentionItemKind = attention.reason
  const truncated = truncateMessage(message)
  return {
    id: attentionItemId(kind, run.sessionId, requestId),
    kind,
    sessionId: run.sessionId,
    sessionTitle: run.title,
    directory: run.directory,
    backend: run.backend,
    ...(run.machineId ? { machineId: run.machineId } : {}),
    ...(run.agent ? { agent: run.agent } : {}),
    ...(requestId ? { requestId } : {}),
    ...(truncated ? { message: truncated } : {}),
    at: itemAt
  }
}

/**
 * Project every pending request and terminal attention fact into inbox items.
 *
 *  - question / permission: ONE ITEM PER REQUEST, enumerated directly from the request signals —
 *    `AgentRun.attention` only ever names the first matching request for a session, so it cannot
 *    represent two pending forms. Each request resolves independently, so each gets its own item
 *    (`q:<requestId>` / `p:<requestId>`).
 *  - failure / completion: one item per (session, kind), from runs whose attention reason is
 *    failure or completion (`f:<sessionId>` / `c:<sessionId>`).
 *
 * Every item gets `machineId` when the option is provided; the result is sorted by `at` descending.
 *
 * Message resolution (criterion 6 — the inbox summarizes, the card reveals):
 *  - permission: the ACTION NAME (`permissionAction` override, else the request's `permission`),
 *    NEVER the patterns.
 *  - question: the first question's label (`questionLabel` override, else `questions[0].question`).
 *  - failure: undefined by default — the session-status `message` field is not part of AgentRun;
 *    Lane B passes it through the options when it has it.
 *  - completion: undefined.
 */
export function collectAttentionItems(
  runs: readonly AgentRun[],
  signals: AttentionItemSignals,
  options?: {
    attentionAt?: (sessionId: string) => number | undefined
    machineId?: string
    permissionAction?: (requestId: string) => string | undefined
    questionLabel?: (requestId: string) => string | undefined
    failureMessage?: (sessionId: string) => string | undefined
  }
): AttentionItem[] {
  const runsBySession = new Map<string, AgentRun>()
  for (const run of runs) runsBySession.set(run.sessionId, run)

  const items: AttentionItem[] = []
  // Pending questions and permissions: one item per request, resolved only when its session has a
  // run (a request for a session absent from the list cannot be opened, so it stays out).
  for (const request of signals.permissions ?? []) {
    const run = runsBySession.get(request.sessionID)
    if (!run) continue
    const message = options?.permissionAction?.(request.id) ?? request.permission
    items.push(attentionItemFromDraft({
      run,
      attention: { reason: "permission", requestId: request.id },
      itemAt: attentionItemAt(run, "permission", options?.attentionAt),
      message,
      requestId: request.id
    }))
  }
  for (const request of signals.questions ?? []) {
    const run = runsBySession.get(request.sessionID)
    if (!run) continue
    const message = options?.questionLabel?.(request.id) ?? request.questions[0]?.question
    items.push(attentionItemFromDraft({
      run,
      attention: { reason: "question", requestId: request.id },
      itemAt: attentionItemAt(run, "question", options?.attentionAt),
      message,
      requestId: request.id
    }))
  }
  // Failures and completions: one item per (session, kind) from the run's terminal attention.
  for (const run of runs) {
    const attention = run.attention
    if (attention?.reason !== "failure" && attention?.reason !== "completion") continue
    const message = attention.reason === "failure" ? options?.failureMessage?.(run.sessionId) : undefined
    items.push(attentionItemFromDraft({
      run,
      attention,
      itemAt: attentionItemAt(run, attention.reason, options?.attentionAt),
      message
    }))
  }

  if (options?.machineId) for (const item of items) item.machineId = options.machineId
  return items.sort((a, b) => b.at - a.at)
}

/** The occurrence-scoped dismissal key for an item: `${item.id}@${item.at}`. */
export function itemGeneration(item: AttentionItem): string {
  return `${item.id}@${item.at}`
}

/**
 * Hide items the user has dismissed. Dismissal semantics differ by kind:
 *  - f:/c: items are dismissed by GENERATION (`f:<sid>@<at>`): a later re-failure gets a new `at`
 *    and re-alerts even though the bare id was dismissed before.
 *  - q:/p: items are dismissed by BARE ID (`q:<rid>` / `p:<rid>`): their `at` is session.updated,
 *    which changes on unrelated activity and would invalidate a generation-scoped dismissal. They
 *    resolve server-side, so a bare-id dismissal is the only form ever used for them.
 * A bare id in the set therefore dismisses the item regardless of generation (only used for q/p);
 * f/c always use the generation form. Unknown ids are kept.
 */
export function filterDismissed(items: readonly AttentionItem[], dismissed: ReadonlySet<string>): AttentionItem[] {
  return items.filter((item) => {
    if (item.kind === "failure" || item.kind === "completion") return !dismissed.has(itemGeneration(item))
    return !dismissed.has(item.id)
  })
}
