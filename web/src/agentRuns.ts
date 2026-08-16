import type { BackendKind, MessagePart, PermissionRequest, QuestionRequest, SessionView } from "./types"

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
  /** The session's active agent id when the session model carried one (v2 sessions). */
  agent?: string
  startedAt?: number
  updatedAt?: number
}

export type AgentRunSignals = {
  questions?: readonly Pick<QuestionRequest, "id" | "sessionID">[]
  permissions?: readonly Pick<PermissionRequest, "id" | "sessionID">[]
  terminalStatus?: Extract<AgentRunStatus, "completed" | "failed" | "stopped">
  /** The v2 status derivation flagged the session as needing attention (a crash with no terminal
   *  status), so the run should demand user attention like a failed run. */
  needsAttention?: boolean
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

  if (signals.needsAttention) return { reason: "failure" }
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
  // Only when present, so strict-shape fixtures without an agent stay stable (issue #9).
  if (session.agent) run.agent = session.agent
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

/** Whether a delegated run is still in flight. Only these statuses keep the live elapsed clock
 *  ticking and the live output window following the child; terminal runs (completed/failed/stopped)
 *  and idle freeze at their own timestamps. */
export function isLiveSubagentStatus(status: AgentRunStatus): boolean {
  return status === "working" || status === "waiting" || status === "retrying"
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
 * session id lives on `state.metadata.sessionID` (only the terminal tool metadata carries it — the
 * streaming/running parts ship `metadata:{}`, so a run card appears exactly when the server has
 * real correlation data). Agent/description come from the tool input.
 *
 * Run status is derived from the JOB signal on `state.metadata.status`, NEVER from the tool part's
 * own terminal state alone: the part goes `completed`/`error` the moment the tool call returns,
 * but a background launch returns with `metadata.status:"running"` (the job keeps going until the
 * injected completion lands) and a foreground failure returns with the part `error` while the job
 * metadata still says `running`. So the rule is: a part `error` is failed (the tool's own failure
 * is the source of truth — foreground failures never get an injected completion), else a running
 * job is working whatever the part says, else the metadata word maps onto the shared terminal
 * vocabulary, else the part's own status falls through the shared normalizer.
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

  const partStatus = part.state?.status
  const jobStatus = metadata?.status
  const run: SubagentRun = {
    childID,
    status: partStatus === "error"
      ? "failed"
      : jobStatus === "running"
        ? "working"
        : normalizeAgentRunStatus(partStatus ?? "", terminalSubagentStatus(jobStatus))
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

/**
 * The card-headline summary a synthetic completion envelope carries, read off its parts. A
 * subagent completion always ships a `description` on the wire (opencode `subagent.ts` injects it),
 * so the v2 mapper emits a structured `system` part with the child's short description on
 * `description` and the model-facing `<subagent ...>` block on `text`; a completion without a
 * description keeps the plain text part with the whole block on `text`. Either way the wrapper
 * tags are stripped and payloads too long to read as a headline are rejected — long payloads stay
 * in the transcript's own part, which still renders as before. Returns undefined when the envelope
 * carries nothing usable.
 */
export function subagentCompletionDescription(parts: readonly MessagePart[]): string | undefined {
  const system = parts.find((part) => part.type === "system")
  const raw = system
    ? (system.description ?? system.text)
    : parts
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim()
  if (!raw) return undefined
  const stripped = raw.replace(/^\s*<subagent\b[^>]*>/i, "").replace(/<\/subagent>\s*$/i, "").trim()
  if (!stripped || stripped.length > 140) return undefined
  return stripped
}

/** Whether a text string is exactly the synthetic completion block the opencode `subagent` tool
 *  injects when a child finishes: an opening `<subagent ...>` tag through a closing `</subagent>`
 *  with nothing else around it. Only such complete wrappers are the injected payload — any other
 *  occurrence of the tags is ordinary content and must keep rendering as before. */
export function isSubagentCompletionWrapper(text: string | undefined | null): boolean {
  if (!text) return false
  return /^\s*<subagent\b[^>]*>[\s\S]*<\/subagent>\s*$/i.test(text)
}

/** The wrapper text a synthetic completion message carries, read off its parts. The v2 mapper
 *  emits the block on a structured `system` part's `text` when the completion has a description,
 *  and on a plain `text` part otherwise — the same shapes `subagentCompletionDescription` reads. */
function subagentCompletionBlock(parts: readonly MessagePart[]): string | undefined {
  const system = parts.find((part) => part.type === "system")
  const raw = system
    ? (system.text ?? "")
    : parts
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim()
  return raw.length > 0 ? raw : undefined
}

/** The child's actual final output inside a synthetic subagent completion wrapper (issue #47):
 *  only the outer `<subagent ...>`/`</subagent>` tags are stripped, so the run card can show the
 *  real result instead of the launch notice a background tool part carries. Returns undefined when
 *  the parts carry no complete wrapper, or the wrapper is empty — those parts are ordinary content
 *  and stay untouched. */
export function subagentCompletionOutput(parts: readonly MessagePart[]): string | undefined {
  const raw = subagentCompletionBlock(parts)
  if (!raw || !isSubagentCompletionWrapper(raw)) return undefined
  const inner = raw.replace(/^\s*<subagent\b[^>]*>/i, "").replace(/<\/subagent>\s*$/i, "").trim()
  return inner.length > 0 ? inner : undefined
}
