import type { BackendKind, PermissionRequest, QuestionRequest, SessionView } from "./types"

export type AgentRunStatus =
  | "idle"
  | "working"
  | "waiting"
  | "retrying"
  | "completed"
  | "failed"
  | "stopped"

export type AgentAttention =
  | { reason: "permission"; requestId: string }
  | { reason: "question"; requestId: string }
  | { reason: "failure" }
  | { reason: "completion" }

export type AgentRun = {
  id: string
  backend: BackendKind
  sessionId: string
  title: string
  directory: string
  status: AgentRunStatus
  attention?: AgentAttention
  projectId?: string
  machineId?: string
  startedAt?: number
  updatedAt?: number
}

export type AgentRunSignals = {
  questions?: readonly Pick<QuestionRequest, "id" | "sessionID">[]
  permissions?: readonly Pick<PermissionRequest, "id" | "sessionID">[]
  terminalStatus?: Extract<AgentRunStatus, "completed" | "failed" | "stopped">
  projectId?: string
  machineId?: string
  startedAt?: number
}

const WORKING_STATUSES = new Set(["busy", "working", "running"])
const RETRYING_STATUSES = new Set(["retry", "retrying"])
const WAITING_STATUSES = new Set(["waiting"])

/**
 * Normalize the status vocabulary exposed by currently supported harnesses into the operational
 * states used by the control-plane layer. Terminal states are deliberately supplied only through
 * the explicit terminalStatus signal: inferring them from raw harness words such as "error" or
 * "done" could turn transient or backend-specific states into false terminal runs in the Inbox.
 */
export function normalizeAgentRunStatus(status: string, terminalStatus?: AgentRunSignals["terminalStatus"]): AgentRunStatus {
  if (terminalStatus) return terminalStatus

  const normalized = status.trim().toLowerCase()
  if (WORKING_STATUSES.has(normalized)) return "working"
  if (RETRYING_STATUSES.has(normalized)) return "retrying"
  if (WAITING_STATUSES.has(normalized)) return "waiting"
  return "idle"
}

function attentionFor(
  sessionId: string,
  status: AgentRunStatus,
  signals: AgentRunSignals
): AgentAttention | undefined {
  const permission = signals.permissions?.find((request) => request.sessionID === sessionId)
  if (permission) return { reason: "permission", requestId: permission.id }

  const question = signals.questions?.find((request) => request.sessionID === sessionId)
  if (question) return { reason: "question", requestId: question.id }

  if (status === "failed") return { reason: "failure" }
  if (status === "completed") return { reason: "completion" }
  return undefined
}

/**
 * Convert an existing session into the backend-agnostic representation consumed by cross-agent
 * operational views. This deliberately retains backend/session identity: AgentRun is a projection,
 * not a replacement for the underlying session and its harness-specific capabilities.
 */
export function toAgentRun(
  session: SessionView,
  backend: BackendKind,
  signals: AgentRunSignals = {}
): AgentRun {
  const status = normalizeAgentRunStatus(session.status, signals.terminalStatus)
  const run: AgentRun = {
    id: `${backend}:${session.id}`,
    backend,
    sessionId: session.id,
    title: session.title,
    directory: session.directory,
    status,
    updatedAt: session.updated
  }

  const attention = attentionFor(session.id, status, signals)
  if (attention) run.attention = attention
  if (signals.projectId) run.projectId = signals.projectId
  if (signals.machineId) run.machineId = signals.machineId
  if (signals.startedAt !== undefined) run.startedAt = signals.startedAt

  return run
}

/** Correlation data for a delegated subagent run, derived from tool metadata
 *  and/or the child session, using the shared status vocabulary. */
export type SubagentRun = {
  childID: string
  agent?: string
  description?: string
  status: AgentRunStatus          // from the shared vocabulary
  startedAt?: number
  endedAt?: number
  output?: string
  error?: string
  model?: { id: string; providerID?: string; variant?: string }
}

/** Map the v2 subagent tool's completion vocabulary onto the shared terminal states:
 *  "completed" → completed, "error" → failed, "cancelled" → stopped. Anything else (notably
 *  the in-flight "running") yields no terminal status, so `normalizeAgentRunStatus` keeps
 *  reporting the run as working — a terminal state is never invented from an unknown word. */
function terminalSubagentStatus(status: unknown): AgentRunSignals["terminalStatus"] | undefined {
  if (status === "completed") return "completed"
  if (status === "error") return "failed"
  if (status === "cancelled") return "stopped"
  return undefined
}

/**
 * Derive a delegated-subagent run from the parent transcript's `subagent` tool part. The child
 * session id lives on `state.metadata.sessionID` (both the running-progress and the completed
 * tool metadata carry it); agent/description come from the tool input; the terminal state comes
 * from `metadata.status` mapped onto the shared vocabulary.
 *
 * Returns null when the correlation data is missing — a non-subagent tool, or a subagent part
 * without a non-empty `metadata.sessionID` — the "degrades gracefully" case where the caller
 * falls back to generic tool rendering instead of guessing a run identity.
 */
export function subagentRunFromTool(part: {
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    time?: { start?: number; end?: number }
    metadata?: Record<string, unknown>
  }
}): SubagentRun | null {
  if (part.tool !== "subagent") return null
  const metadata = part.state?.metadata
  const childID = metadata?.sessionID
  if (typeof childID !== "string" || childID.length === 0) return null

  const rawStatus = part.state?.status
  const run: SubagentRun = {
    childID,
    // The run is "working" while the server reports it in flight: the tool's own state is then
    // "running" (already mapped by the shared vocabulary) or still "pending" (created, queued).
    // A "pending" state with no running signal stays idle rather than being promoted, and a
    // terminal state only ever comes from the server's own `metadata.status`.
    status: rawStatus === "pending" && metadata?.status === "running"
      ? "working"
      : normalizeAgentRunStatus(rawStatus ?? "", terminalSubagentStatus(metadata?.status))
  }

  const input = part.state?.input
  if (typeof input?.agent === "string") run.agent = input.agent
  if (typeof input?.description === "string") run.description = input.description
  const time = part.state?.time
  if (time?.start !== undefined) run.startedAt = time.start
  if (time?.end !== undefined) run.endedAt = time.end
  if (part.state?.output) run.output = part.state.output
  if (part.state?.error) run.error = part.state.error
  return run
}

/**
 * Derive a delegated-subagent run from the terminal completion signal the parent transcript
 * carries on `info.subagent` (set by the v2 mapper from the synthetic message the opencode
 * `subagent` tool injects when its child finishes). The completion state is the server's word
 * and maps one-to-one onto the shared vocabulary. Returns null when the envelope carries no
 * such signal.
 */
export function subagentRunFromCompletion(info: {
  subagent?: { childID: string; agent?: string; state: "completed" | "error" | "cancelled" }
}): SubagentRun | null {
  const completion = info?.subagent
  if (!completion) return null
  const run: SubagentRun = {
    childID: completion.childID,
    // The synthetic mapper already normalizes the state, so this fallback is purely defensive.
    status: terminalSubagentStatus(completion.state) ?? "completed"
  }
  if (typeof completion.agent === "string") run.agent = completion.agent
  return run
}
