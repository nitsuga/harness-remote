import type {
  AgentOption,
  CommandInfo,
  DiffFile,
  FileEntry,
  MessageEnvelope,
  MessagePart,
  ModelOption,
  QuestionRequest,
  Session,
  ToolState
} from "./types"

/**
 * Pure shape mappers from the OpenCode 2 (beta) wire format back into the app's existing types.
 *
 * Kept free of runtime sibling imports — everything here is either pure data transformation or a
 * type-only import — so the node test runner (which cannot resolve extensionless specifiers) can
 * load this file directly.
 */

export type V2Session = {
  id: string
  title?: string
  time: { created: number; updated: number }
  location?: { directory?: string }
  subpath?: string
  model?: { id?: string; providerID?: string; variant?: string }
  projectID?: string
  parentID?: string
  fork?: { sessionID?: string; parentID?: string }
  revert?: { messageID?: string; partID?: string }
  files?: Array<{ file: string; patch?: string; additions?: number; deletions?: number; status?: string }>
}

export function toSession(session: V2Session): Session {
  const mapped: Session = {
    id: session.id,
    title: session.title ?? "",
    directory: session.location?.directory ?? "",
    time: { created: session.time.created, updated: session.time.updated },
    model: session.model && session.model.id
      ? { id: session.model.id, providerID: session.model.providerID ?? "", variant: session.model.variant }
      : undefined,
    project: session.projectID ? { id: session.projectID, worktree: session.location?.directory ?? "" } : undefined,
    revert: session.revert?.messageID ? { messageID: session.revert.messageID, partID: session.revert.partID } : undefined,
    summary: session.files?.length
      ? {
          files: session.files.length,
          additions: session.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: session.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
        }
      : undefined,
    external: false,
  }
  const parentID = session.parentID ?? session.fork?.parentID ?? session.fork?.sessionID
  if (parentID) Object.defineProperty(mapped, "parentID", { value: parentID, enumerable: false })
  return mapped
}

/**
 * One `GET /api/session/{sessionID}/inbox` entry (`SessionInbox.Info`): durable enqueued session
 * work that has not been delivered yet. The message list does not carry delivery state — a queued
 * prompt is admitted here first and only reaches the transcript once it is delivered — so this is
 * the authoritative source for the app's queued indicators.
 */
export type V2InboxItem = {
  id: string
  sessionID: string
  timeCreated: number
  type: "user" | "synthetic" | "compaction" | "move"
  payload?: Record<string, unknown>
  delivery?: "steer" | "queue"
}

/**
 * Overlay the server's inbox delivery metadata onto a fetched transcript. A message that the inbox
 * still lists as queued keeps its "Queued · waiting to send" indicator across reconciliation; once
 * the item is delivered it leaves the inbox and the overlay stops applying, so the indicator
 * disappears exactly when the server says the prompt was sent.
 */
export function applyInboxDelivery(messages: MessageEnvelope[], inbox: V2InboxItem[]): MessageEnvelope[] {
  if (!inbox || inbox.length === 0) return messages
  const deliveryByID = new Map<string, "steer" | "queue">()
  for (const item of inbox) {
    if (item.delivery && (item.type === "user" || item.type === "synthetic")) deliveryByID.set(item.id, item.delivery)
  }
  if (deliveryByID.size === 0) return messages
  return messages.map((message) => {
    const delivery = deliveryByID.get(message.info.id)
    if (!delivery || message.info.delivery === delivery) return message
    return { ...message, info: { ...message.info, delivery } }
  })
}

/** A structured error as carried by v2 (`Session.StructuredError`): `{ type, message, status? }`.
 *  Field names mirror the wire; only `type`/`message` are surfaced onto the app's tool states. */
export type V2SessionError = {
  type?: string
  message?: string
  status?: number
}

/** One `Tool.Content` entry: text output or a produced file. Both ride onto `ToolState` — text as
 *  the joined `output`, files as `outputFiles` — so the rendered tool card gets the full picture. */
export type V2ToolContent =
  | { type: "text"; text?: string }
  | { type: "file"; uri?: string; mime?: string; name?: string }

/** One v2 `Session.Message.ToolState`: `streaming` carries a STRING input, every other state a
 *  record. `completed`/`error` may carry `content`; `error` also carries a structured error. */
export type V2ToolState = {
  status?: string
  input?: unknown
  content?: V2ToolContent[]
  error?: V2SessionError
  time?: { created?: number; ran?: number; completed?: number }
  metadata?: Record<string, unknown>
}

export function toToolState(state: V2ToolState, tool?: string): ToolState {
  const status = state?.status ?? "pending"
  const textOutput = (state?.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
  const outputFiles = (state?.content ?? [])
    .filter((part): part is { type: "file"; uri: string; mime?: string; name?: string } => part.type === "file" && typeof part.uri === "string")
    .map((part) => ({ uri: part.uri, mime: part.mime ?? "", name: part.name }))
  const rawInput = state?.input
  const metadata = state?.metadata
  // Shells run as TOOL CALLS on the wire, with the outcome in `state.metadata` (`exit` for the exit
  // code, `timeout: true` when the shell was stopped by its timeout) — not as `type:"shell"`
  // messages. Lift those onto the tool state so the exit-code and timeout badges fire for real
  // shell usage. Both fields stay ABSENT otherwise (non-shell tools, no exit/timeout metadata), so
  // strict shape fixtures see no new fields where they do not belong.
  const exitCode = tool === "shell" && typeof metadata?.exit === "number" ? metadata.exit : undefined
  const timedOut = tool === "shell" && status === "completed" && metadata?.timeout === true
  return {
    status: timedOut ? "timeout" : status,
    // The streaming state's input is a plain string (a one-line description of the in-flight
    // invocation), not a JSON record — wrap it as `{ command }` so it stays record-shaped for
    // consumers that render `state.input` generically.
    input: typeof rawInput === "string" ? { command: rawInput } : (rawInput ?? {}) as Record<string, unknown>,
    output: textOutput || undefined,
    error: state?.error?.message,
    time: state?.time
      ? { start: state.time.created ?? 0, end: state.time.completed }
      : undefined,
    metadata,
    // Only surface `outputFiles` when a tool actually produced files, so consumers doing strict
    // field-level comparisons against older parts see no shape change.
    ...(outputFiles.length > 0 ? { outputFiles } : {}),
    ...(exitCode !== undefined ? { exitCode } : {})
  }
}

/** One `Tool.Content` entry of type `file`: `{ type: "file", uri, mime, name? }`. The tool state
 *  carries these as `outputFiles`; this builder turns one into a standalone transcript part for
 *  callers (the renderer lane) that want the file rendered as its own row. */
export function toFileContentPart(file: { uri: string; mime: string; name?: string }, messageID: string, callID?: string): MessagePart {
  return {
    id: `${messageID}:file:${file.uri}`,
    messageID,
    callID,
    type: "file-content",
    uri: file.uri,
    mime: file.mime,
    name: file.name
  }
}

/**
 * Any key whose name matches these is treated as a credential by `sanitizeForFallback` and stripped
 * from the fallback payload before it reaches the transcript (never persist, render or log secrets).
 */
const FALLBACK_SECRET_KEY = /key|token|secret|password|credential/i

/**
 * Deep-copy an unknown wire payload for a `fallback` part, stripping anything that could be a
 * credential: the tool bookkeeping keys `providerState`/`providerResultState` (which routinely carry
 * base64 tool input) and any key whose name matches /key|token|secret|password|credential/i at any
 * depth. The source object is never mutated.
 */
export function sanitizeForFallback(raw: unknown): Record<string, unknown> {
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub)
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (key === "providerState" || key === "providerResultState" || FALLBACK_SECRET_KEY.test(key)) continue
        out[key] = scrub(child)
      }
      return out
    }
    return value
  }
  return scrub(raw) as Record<string, unknown>
}

/** A v2 `Model.Ref`: `{ id, providerID?, variant? }` — used by `model-switched` and `assistant`. */
export type V2ModelRef = { id?: string; providerID?: string; variant?: string }

/** A v2 `Location.Ref` as it appears on `location-switched` messages: `{ directory?, workspaceID? }`. */
export type V2LocationRef = { directory?: string; workspaceID?: string }

/** The `previous` member of a `location-switched` message: the same location shape plus the old
 *  project id/subpath. */
export type V2LocationPrevious = { location?: V2LocationRef; projectID?: string; subpath?: string }

/** A v2 `TokenUsage.Info`: the wire also carries `cache: { read, write }`, which the app's info
 *  shape does not model — the assistant mapping keeps `input`/`output`/`reasoning` only. */
export type V2TokenUsage = { input?: number; output?: number; reasoning?: number }

/** One v2 `Session.Message.Assistant.Content` member: text, reasoning or a tool invocation. */
export type V2AssistantContent =
  | { type: "text"; text?: string; state?: Record<string, unknown> }
  | { type: "reasoning"; text?: string; state?: Record<string, unknown>; time?: { created?: number; completed?: number } }
  | { type: "tool"; id?: string; name?: string; executed?: boolean; state?: V2ToolState; time?: { created?: number; ran?: number; completed?: number } }

/** Fields every `Session.Message.Info` member shares: `id`, `time` and optional `metadata`. */
export type V2MessageBase = {
  id: string
  type: string
  time: { created: number; completed?: number }
  metadata?: Record<string, unknown>
}

export type V2AgentSwitched = V2MessageBase & { type: "agent-switched"; agent?: string; previous?: string }
export type V2ModelSwitched = V2MessageBase & { type: "model-switched"; model?: V2ModelRef; previous?: V2ModelRef }
export type V2LocationSwitched = V2MessageBase & { type: "location-switched"; location?: V2LocationRef; projectID?: string; subpath?: string; previous?: V2LocationPrevious }
export type V2UserMessage = V2MessageBase & { type: "user"; text?: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] }
/** A v2 `Session.Message.Synthetic`: `{ text, description? }`. Delegated-subagent completions
 *  additionally carry `metadata: { source: "subagent", childID, agent, state }` — injected by the
 *  opencode `subagent` tool when its child session finishes, with `state` one of "completed" |
 *  "error" | "cancelled". The mapper surfaces that terminal signal on `info.subagent`; the
 *  `<subagent ...>` text block remains the part payload. */
export type V2Synthetic = V2MessageBase & { type: "synthetic"; text?: string; description?: string }
export type V2SystemMessage = V2MessageBase & { type: "system"; text?: string; description?: string }
export type V2SkillMessage = V2MessageBase & { type: "skill"; skill?: string; name?: string; text?: string }

/** A v2 `Session.Message.Shell`: `{ shellID, command, status, exit?, output? }`. The three terminal
 *  statuses are mapped onto the app's tool lifecycle — `exited` → completed, `timeout`/`killed`
 *  keep their own statuses — and `exit` rides on the tool state's `exitCode`. */
export type V2ShellMessage = V2MessageBase & {
  type: "shell"
  shellID?: string
  command?: string
  status?: "running" | "exited" | "timeout" | "killed"
  exit?: number
  output?: { output?: string; cursor?: number; size?: number; truncated?: boolean }
}

export type V2AssistantMessage = V2MessageBase & {
  type: "assistant"
  agent?: string
  model?: V2ModelRef
  content?: V2AssistantContent[]
  snapshot?: unknown
  finish?: string
  cost?: number
  tokens?: V2TokenUsage
  error?: V2SessionError
  retry?: { attempt?: number; at?: number; error?: V2SessionError }
}

/** A v2 `Session.Message.Compaction`: the wire further splits this into running/completed/failed by
 *  `status`, but the reader treats them as one shape — running/completed carry `summary`/`recent`, a
 *  failed compaction carries only `error`. */
export type V2Compaction = V2MessageBase & {
  type: "compaction"
  status?: "running" | "completed" | "failed"
  reason?: "auto" | "manual"
  summary?: string
  recent?: string
  error?: V2SessionError
}

/**
 * One `GET /api/session/{sessionID}/message` entry. The wire format is a discriminated union of ten
 * members (`Session.Message.Info`), all sharing `id`/`time` and optionally `metadata`; this
 * reader type mirrors that union exactly so `toMessageEnvelope` can dispatch on `type` and read each
 * member's fields directly:
 *
 *  1. `agent-switched`    `{ agent, previous? }`                          → `switch` part (agent)
 *  2. `model-switched`    `{ model, previous? }` (both `Model.Ref`)       → `switch` part (model)
 *  3. `location-switched` `{ location, projectID?, subpath?, previous? }` → `switch` part (location)
 *  4. `user`              `{ text, files, agents, skills }`               → text part
 *  5. `synthetic`         `{ text, description? }`                        → text/system part (+ `info.subagent` on subagent completions)
 *  6. `system`            `{ text, description? }`                        → system part
 *  7. `skill`             `{ skill, name, text }`                         → skill-activation part
 *  8. `shell`             `{ shellID, command, status, exit?, output? }`  → tool part (shell)
 *  9. `assistant`         `{ agent, model, content[], snapshot?, finish?, cost?, tokens?, error?, retry? }`
 *                                                                            → parts + info metadata
 * 10. `compaction`        `{ status, reason, summary?, recent?, error? }` → text part + info
 *
 * Anything the server grows beyond these ten lands on a `fallback` part with a sanitized payload —
 * never silently dropped.
 */
export type V2Message =
  | V2AgentSwitched
  | V2ModelSwitched
  | V2LocationSwitched
  | V2UserMessage
  | V2Synthetic
  | V2SystemMessage
  | V2SkillMessage
  | V2ShellMessage
  | V2AssistantMessage
  | V2Compaction

/** A plain-English summary line for a `switch` part (e.g. "Switched agent: build → orchestrator").
 *  Kept on the part so text extraction and message-equality checks keep working; the renderer lane
 *  localizes display separately. The arrow is dropped when the previous value equals the new one
 *  (e.g. a model variant change reuses the same ref id). */
function switchPartText(kind: string, value: string, previous?: string): string {
  return previous && previous !== value ? `Switched ${kind}: ${previous} → ${value}` : `Switched ${kind}: ${value}`
}

/** Flattens one v2 message (a discriminated union) into the app's `MessageEnvelope` shape. Every
 *  known member maps explicitly; anything unknown becomes a `fallback` part instead of vanishing. */
export function toMessageEnvelope(message: V2Message, sessionID: string): MessageEnvelope {
  const role = message.type === "user" ? "user" : message.type === "assistant" ? "assistant" : "system"
  const info: MessageEnvelope["info"] = {
    id: message.id,
    role,
    sessionID,
    time: { created: message.time.created, completed: message.time.completed },
    type: message.type
  }

  const parts: MessagePart[] = []
  if (message.type === "user") {
    parts.push({ id: `${message.id}:text`, type: "text", text: message.text ?? "" })
  } else if (message.type === "assistant") {
    // Assistant-level metadata (agent/model/finish/error/cost/tokens/retry) rides on `info` so the
    // transcript header and error banner can show it; `snapshot` is deliberately not rendered yet.
    if (message.agent) info.agent = message.agent
    if (message.model?.id) info.model = { id: message.model.id, providerID: message.model.providerID, variant: message.model.variant }
    if (message.finish) info.finish = message.finish
    if (message.error) info.error = { type: message.error.type, message: message.error.message }
    if (message.cost !== undefined) info.cost = message.cost
    if (message.tokens) info.tokens = { input: message.tokens.input, output: message.tokens.output, reasoning: message.tokens.reasoning }
    if (message.retry) info.retry = { attempt: message.retry.attempt ?? 0, at: message.retry.at ?? 0, error: message.retry.error }
    for (const [index, part] of (message.content ?? []).entries()) {
      if (part.type === "text") {
        parts.push({ id: `${message.id}:part:${index}`, messageID: message.id, type: "text", text: typeof part.text === "string" ? part.text : "" })
      } else if (part.type === "reasoning") {
        parts.push({ id: `${message.id}:part:${index}`, messageID: message.id, type: "reasoning", text: typeof part.text === "string" ? part.text : "" })
      } else if (part.type === "tool") {
        // Only tool content carries its own wire id (`Assistant.Tool.id`); text/reasoning parts are
        // referenced positionally, exactly as before the typed content union.
        const partID = part.id ?? `${message.id}:part:${index}`
        parts.push({
          id: partID,
          messageID: message.id,
          type: "tool",
          tool: part.name ?? "tool",
          callID: part.id,
          state: toToolState(part.state ?? {}, part.name)
        })
      }
    }
  } else if (message.type === "agent-switched") {
    // Switches carry their own fields on the part; `info` metadata stays reserved for assistant
    // messages so switch indications never get confused with the assistant that follows them.
    parts.push({
      id: `${message.id}:switch`,
      messageID: message.id,
      type: "switch",
      kind: "agent",
      value: message.agent ?? "",
      text: switchPartText("agent", message.agent ?? "", message.previous),
      ...(message.previous ? { previous: message.previous } : {})
    })
  } else if (message.type === "model-switched") {
    // The `previous` member is a full `Model.Ref` on the wire; the part keeps the previous ref id
    // as its `previous` string and the new ref (with provider/variant) as `model` for rich display.
    parts.push({
      id: `${message.id}:switch`,
      messageID: message.id,
      type: "switch",
      kind: "model",
      value: message.model?.id ?? "",
      text: switchPartText("model", message.model?.id ?? "", message.previous?.id),
      ...(message.previous?.id ? { previous: message.previous.id } : {}),
      ...(message.model?.id ? { model: { id: message.model.id, providerID: message.model.providerID, variant: message.model.variant } } : {})
    })
  } else if (message.type === "location-switched") {
    parts.push({
      id: `${message.id}:switch`,
      messageID: message.id,
      type: "switch",
      kind: "location",
      value: message.location?.directory ?? "",
      text: switchPartText("location", message.location?.directory ?? "", message.previous?.location?.directory),
      ...(message.previous?.location?.directory ? { previous: message.previous.location.directory } : {}),
      ...(message.subpath ? { subpath: message.subpath } : {})
    })
  } else if (message.type === "synthetic") {
    // A synthetic message can carry delegated-subagent completion metadata
    // (`{ source: "subagent", childID, agent, state }`, injected by the opencode v2 `subagent`
    // tool when its child finishes — see the V2Synthetic contract above). Surface that terminal
    // signal on `info.subagent` (purely optional; v2 mapper only) so consumers can render the
    // delegated task. The `<subagent ...>` text part below stays exactly as before — the
    // structured signal now rides on `info` — and a synthetic without the metadata maps as
    // today, with no `info.subagent`.
    const subagent = message.metadata
    if (subagent?.source === "subagent" && typeof subagent.childID === "string" && subagent.childID.length > 0) {
      const state = subagent.state
      info.subagent = {
        childID: subagent.childID,
        ...(typeof subagent.agent === "string" ? { agent: subagent.agent } : {}),
        // Only the three documented completion states are valid; anything else (absent or
        // unknown) falls back to "completed" so the envelope never fabricates an error.
        state: state === "error" || state === "cancelled" ? state : "completed"
      }
    }
    if (message.description) {
      // Synthetic messages carry a model-facing prompt plus a short human summary; with a
      // description they render like `system` messages (structured), otherwise as plain text.
      parts.push({ id: `${message.id}:system`, messageID: message.id, type: "system", text: message.text ?? "", description: message.description })
    } else {
      parts.push({ id: `${message.id}:text`, type: "text", text: message.text ?? "" })
    }
  } else if (message.type === "system") {
    parts.push({
      id: `${message.id}:system`,
      messageID: message.id,
      type: "system",
      text: message.text ?? "",
      ...(message.description ? { description: message.description } : {})
    })
  } else if (message.type === "skill") {
    parts.push({ id: `${message.id}:skill`, messageID: message.id, type: "skill-activation", skillId: message.skill, name: message.name, text: message.text ?? "" })
  } else if (message.type === "shell") {
    // Shell status maps onto the app's tool lifecycle: `running` stays running, `exited` becomes
    // completed, and the `timeout`/`killed` outcomes keep their own distinct statuses so the UI can
    // tell a finished shell from an interrupted one. The exit code rides on `state.exitCode`.
    const stateStatus = message.status === "running" ? "running"
      : message.status === "timeout" ? "timeout"
      : message.status === "killed" ? "killed"
      : "completed"
    parts.push({
      id: `${message.id}:shell`,
      messageID: message.id,
      type: "tool",
      tool: "shell",
      callID: message.id,
      state: {
        status: stateStatus,
        input: message.command ? { command: message.command } : undefined,
        output: message.output?.output,
        time: { start: message.time.created, end: message.time.completed },
        ...(message.exit !== undefined ? { exitCode: message.exit } : {})
      }
    })
  } else if (message.type === "compaction") {
    info.compactionStatus = message.status === "running" || message.status === "completed" || message.status === "failed"
      ? message.status
      : undefined
    const text = `${message.summary ?? ""}${message.recent ? `\n\n${message.recent}` : ""}`
    if (text) parts.push({ id: `${message.id}:text`, type: "text", text })
    // A failed compaction carries no summary/recent — only a structured error. Surface it through
    // `info.error` (same field an errored assistant uses) so the renderer can show why it failed.
    if (message.status === "failed" && message.error) info.error = { type: message.error.type, message: message.error.message }
  } else {
    // Unknown future wire variant — `message` has narrowed to `never` here: keep it visible instead
    // of silently dropping it. The payload is sanitized so tool bookkeeping and any
    // credential-looking keys never reach the transcript.
    const unknown = message as unknown as { id?: string; type?: string; text?: string }
    parts.push({
      id: `${unknown.id ?? "unknown"}:fallback`,
      messageID: unknown.id,
      type: "fallback",
      typeName: unknown.type ?? "unknown",
      ...(unknown.text ? { text: unknown.text } : {}),
      raw: sanitizeForFallback(message)
    })
  }

  return { info, parts }
}

/** v2 returns messages newest-first by default; the app renders oldest-first. */
export function chronological(messages: V2Message[], sessionID: string): MessageEnvelope[] {
  return [...messages].reverse().map((message) => toMessageEnvelope(message, sessionID))
}

export function toModelOption(model: {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
  description?: string
  status?: string
  enabled?: boolean
  limit?: { context?: number; input?: number; output?: number }
  capabilities?: { tools?: boolean; input?: string[] }
  variants?: Array<{ id?: string }>
}, defaultModelID?: string): ModelOption[] {
  const providerID = model.providerID ?? ""
  const modelID = model.modelID ?? model.id ?? ""
  if (!providerID || !modelID) return []
  const base: ModelOption = {
    providerID,
    providerName: providerID,
    modelID,
    modelName: model.name ?? modelID,
    description: model.description,
    status: model.status,
    contextLimit: model.limit?.context,
    outputLimit: model.limit?.output,
    tools: Boolean(model.capabilities?.tools),
    attachments: Boolean(model.capabilities?.input?.includes("image") || model.capabilities?.input?.includes("video")),
    // v2 model entries commonly carry only `id`; compare against the same id we resolved above so the
    // default flag survives when `modelID` is absent.
    isDefault: Boolean(modelID) && modelID === defaultModelID
  }
  const variants = (model.variants ?? []).map((variant) => variant.id).filter(Boolean) as string[]
  return [base, ...variants.map((variant) => ({ ...base, variant, isDefault: false }))]
}

export function toAgentOption(agent: { id: string; name?: string; description?: string; mode?: string; hidden?: boolean }): AgentOption {
  return {
    id: agent.id,
    name: agent.name ?? agent.id,
    description: agent.description,
    mode: (agent.mode as AgentOption["mode"]) ?? "all",
    hidden: agent.hidden
  }
}

export function toCommandOption(command: { name: string; description?: string }): CommandInfo {
  // v2 `/api/command` entries carry no source of their own, so classify them explicitly — the UI
  // groups the picker by source and offers a skill-only filter (the OMP bridge does the same).
  return { name: command.name, description: command.description, source: "command" }
}

/**
 * One `GET /api/skill` entry (`SkillV2.Info`). The live contract requires `id`, `name`, `location`
 * and `content`; `description`, `slash` and `autoinvoke` are optional. `id` is the skill's stable
 * identity in the catalog (used to activate it), while `name` is its user-facing slash name.
 */
export type V2Skill = {
  id: string
  name: string
  location: string
  content: string
  description?: string
  /** `false` hides the skill from the V2 slash-command catalog. */
  slash?: boolean
  /** Skills the server activates on its own; not a picker-visibility control (`slash` is). */
  autoinvoke?: boolean
}

/**
 * Map one v2 `/api/skill` entry into the app's command representation. A skill's user-facing slash
 * name is its `name`; entries with `slash: false` (or no name) are hidden from the slash catalog and
 * map to `null`. The skill's stable `id` and `autoinvoke` flag ride along on the mapped entry so
 * activation and filtering stay possible after the merge (see {@link mergeCommandCatalog}).
 */
export function toSkillCommand(skill: V2Skill): CommandInfo | null {
  if (!skill.name || skill.slash === false) return null
  return {
    name: skill.name,
    description: skill.description,
    source: "skill",
    id: skill.id,
    autoinvoke: skill.autoinvoke
  }
}

/**
 * The exact wire body for `POST /api/session/{sessionID}/skill` (`v2.session.skill`): the endpoint
 * takes `{ skill, resume?, id? }`, forbids extra properties, and answers 204. Activation appends a
 * skill message and resumes execution, so the client always posts `resume: true` and omits the
 * optional `id`.
 */
export function toSkillActivationBody(skill: string): { skill: string; resume: boolean } {
  return { skill, resume: true }
}

/**
 * Whether a v2 fetch failure is a confirmed route absence rather than a real server fault. The v2
 * router answers unknown paths with an empty 404, and the shared error contract surfaces that as the
 * literal message "HTTP 404" (the `HTTP {status}` fallback used when the body carries no detail) on
 * every transport — web fetch, Capacitor and the desktop bridge. A 404 carrying a parseable body, or
 * any other status, is not treated as route absence.
 */
export function isV2RouteAbsent(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)) === "HTTP 404"
}

/**
 * Fetch the v2 skill catalog, degrading to an empty list only when the `/api/skill` route is
 * confirmed absent (see {@link isV2RouteAbsent}). Any other failure — a 4xx/5xx carrying a body, an
 * auth rejection, a network error — is a real fault and is rethrown so callers surface it instead
 * of silently presenting an empty skills list.
 */
export async function fetchSkillCatalog(fetchSkills: () => Promise<V2Skill[]>): Promise<V2Skill[]> {
  try {
    return await fetchSkills()
  } catch (error) {
    if (isV2RouteAbsent(error)) return []
    throw error
  }
}

/**
 * Combine the command and skill catalogs into one slash-name catalog. Both classifications are kept
 * even when a server command and a skill share a display name: the skill's entry stays classified as
 * a skill (with its stable `id`) so the UI's skill filter still shows it and activation still works.
 * Commands are listed first, so a slash-name lookup (the app resolves a typed `/name` with `find`)
 * lands on the server command — OpenCode's own slash precedence — while the colliding skill remains
 * reachable through its activate action, which uses the stable `id`. Duplicates are dropped only
 * *within* one source, where two entries with the same name would be ambiguous.
 */
export function mergeCommandCatalog(commands: CommandInfo[], skills: CommandInfo[]): CommandInfo[] {
  const merged: CommandInfo[] = []
  const seenCommands = new Set<string>()
  for (const entry of commands) {
    if (!entry.name || seenCommands.has(entry.name)) continue
    seenCommands.add(entry.name)
    merged.push(entry)
  }
  const seenSkills = new Set<string>()
  for (const entry of skills) {
    if (!entry.name || seenSkills.has(entry.name)) continue
    seenSkills.add(entry.name)
    merged.push(entry)
  }
  return merged
}

export function toFileEntry(entry: { path: string; type: "file" | "directory" }, root: string): FileEntry {
  const name = entry.path.split("/").filter(Boolean).pop() ?? entry.path
  const absolute = entry.path.startsWith("/") ? entry.path : `${root.replace(/\/$/, "")}/${entry.path}`
  return { name, path: absolute, absolute, type: entry.type }
}

export function toDiffFile(file: { file: string; patch?: string; additions?: number; deletions?: number; status?: string }): DiffFile {
  return {
    file: file.file,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: file.patch,
    status: file.status as DiffFile["status"]
  }
}

export type V2FormValue = string | number | boolean | string[]
export type V2FormOption = { value: string; label: string; description?: string }
export type V2FormWhen = { key: string; op: "eq" | "neq"; value: string | number | boolean }
export type V2FormField = {
  key: string
  title?: string
  description?: string
  // Documented v2 field types: string | number | integer | boolean | multiselect | external
  // (plus `select` for single-choice option fields). Unknown types fall back to a plain text input.
  type?: string
  options?: V2FormOption[]
  custom?: boolean
  required?: boolean
  when?: V2FormWhen[]
  url?: string
}
export type V2Form = { id: string; sessionID: string; title?: string; fields: V2FormField[] }

const BOOLEAN_OPTIONS: V2FormOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" }
]

function isBooleanField(field: V2FormField): boolean {
  return field.type === "boolean" || field.type === "confirm"
}

/** The choices the UI should render: real options, or synthesized Yes/No for a boolean field. */
function effectiveOptions(field: V2FormField): V2FormOption[] {
  if (field.options && field.options.length > 0) return field.options
  if (isBooleanField(field)) return BOOLEAN_OPTIONS
  return []
}

/** Plain-input fields (string/number/integer and unknown types) carry no choices and need a text box. */
function isFreeTextField(field: V2FormField): boolean {
  return effectiveOptions(field).length === 0 && field.type !== "external"
}

function isOptionalField(field: V2FormField): boolean {
  // `required` is optional in the v2 schema and only the literal value true makes a field required.
  // External fields are different: the protocol requires an explicit `true` acknowledgement.
  return field.type !== "external" && field.required !== true
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * v2 "forms" replace the v1 question flow. The app UI only understands the flat `QuestionInfo`
 * shape and selects options by their display label, so we surface one question per field, synthesize
 * controls for the option-less types (a text box for string/number/integer, Yes/No for boolean), and
 * keep the protocol's `key`/`value`/`type` metadata for the reply step (see {@link toFormAnswer}).
 */
export function toQuestionRequest(form: V2Form): QuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: (form.fields ?? []).map((field) => {
      const options = effectiveOptions(field)
      return {
        question: field.title ?? field.key,
        header: form.title ?? field.title ?? field.key,
        options: options.map((option) => ({
          label: option.label,
          description: option.description ?? "",
          value: option.value
        })),
        multiple: field.type === "multiselect",
        // Free-text fields must expose the "other" input — it is their only control; option fields
        // expose it only when the protocol permits a custom value.
        custom: isFreeTextField(field) ? true : (field.custom ?? false),
        optional: isOptionalField(field),
        key: field.key,
        answerType: field.type as "string" | "number" | "integer" | "boolean" | "multiselect" | "external",
        when: field.when,
        externalUrl: field.type === "external" ? safeExternalUrl(field.url) : undefined
      }
    })
  }
}

/** Shape one field's answer by its declared type (v2 accepts string | number | integer | boolean | string[]). */
function shapeFieldValue(field: V2FormField, values: string[]): V2FormValue {
  if (field.type === "multiselect") return values
  const first = values[0] ?? ""
  if (field.type === "number") {
    const parsed = Number(first)
    return Number.isFinite(parsed) ? parsed : first
  }
  if (field.type === "integer") {
    const parsed = Number(first)
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : first
  }
  if (isBooleanField(field)) return first === "true" || first === "yes"
  return first
}

function isActive(field: V2FormField, answer: Record<string, V2FormValue>): boolean {
  if (!field.when) return true
  return field.when.every((condition) => {
    const value = answer[condition.key]
    // This matches v2: an unanswered dependency makes both eq and neq conditions false.
    if (value === undefined) return false
    const hit = Array.isArray(value)
      ? value.some((item) => item === condition.value)
      : value === condition.value
    return condition.op === "eq" ? hit : !hit
  })
}

/** Resolve one mapped question's current value for conditional visibility in the shared UI. */
function questionValue(question: QuestionRequest["questions"][number], labels: string[]): V2FormValue | undefined {
  if (labels.length === 0) return undefined
  const values = labels.map((label) => question.options.find((option) => option.label === label)?.value ?? label)
  if (question.answerType === "multiselect") return values
  const first = values[0]
  if (question.answerType === "number") {
    const parsed = Number(first)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (question.answerType === "integer") {
    const parsed = Number(first)
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : undefined
  }
  if (question.answerType === "boolean") return first === "true"
  if (question.answerType === "external") return true
  return first
}

/** Whether a mapped question applies to the answers currently entered for earlier questions. */
export function isQuestionActive(request: QuestionRequest, index: number, answersByIndex: string[][]): boolean {
  const question = request.questions[index]
  if (!question?.when) return true
  return question.when.every((condition) => {
    const dependencyIndex = request.questions.findIndex((candidate) => candidate.key === condition.key)
    if (dependencyIndex < 0) return false
    const value = questionValue(request.questions[dependencyIndex], answersByIndex[dependencyIndex] ?? [])
    if (value === undefined) return false
    const hit = Array.isArray(value)
      ? value.some((item) => item === condition.value)
      : value === condition.value
    return condition.op === "eq" ? hit : !hit
  })
}

/**
 * Translate the app's per-question answers (arrays of the selected option *labels*, indexed to match
 * `form.fields`) back into v2's answer object: keyed by `field.key`, submitting each option's `value`
 * rather than its label, and typed per field. Free-text/custom answers with no matching option pass
 * through unchanged. Optional or inactive fields left blank are omitted, while an external field is
 * sent as `true` only after the user explicitly acknowledges its out-of-band step.
 */
export function toFormAnswer(form: V2Form, answersByIndex: string[][]): Record<string, V2FormValue> {
  const answer: Record<string, V2FormValue> = {}
  ;(form.fields ?? []).forEach((field, index) => {
    const labels = answersByIndex[index] ?? []
    if (field.type === "external") {
      if (labels.length > 0) answer[field.key] = true
      return
    }
    // Conditions reference earlier fields, so the incrementally built answer is sufficient and
    // ensures stale UI values from fields that became inactive are never submitted.
    if (!isActive(field, answer) || labels.length === 0) return
    const options = effectiveOptions(field)
    const values = labels.map((label) => {
      const option = options.find((candidate) => candidate.label === label || candidate.value === label)
      return option ? option.value : label
    })
    answer[field.key] = shapeFieldValue(field, values)
  })
  return answer
}
