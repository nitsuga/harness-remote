export type BackendKind = "opencode" | "opencode2" | "omp" | "pi" | "claude" | "codex"

export type ServerConfig = {
  backend: BackendKind
  host: string
  port: number
  username: string
  password: string
  /** Present when this profile targets one agent exposed by a Harness machine daemon. */
  agentId?: string
}

export type HarnessCapabilities = {
  sessions: boolean
  prompt: boolean
  abort: boolean
  streaming: boolean
  models: boolean
  agents: boolean
  todos: boolean
  diff: boolean
  filesystemBrowser: boolean
  questions: boolean
  permissions: boolean
  commands: boolean
  actions: boolean
  sessionRename: boolean
  sessionDelete: boolean
  attachments: boolean
  /** Native session compaction (OpenCode 2 `/api/session/{id}/compact`). */
  compactSession: boolean
  /** Native session forking (OpenCode 2 `/api/session/{id}/fork`). */
  forkSession: boolean
}

export type MachineAgentHost = {
  id: string
  label: string
  backend: string
  transport: string
  managed: boolean
  state: "configured" | "available" | "unavailable" | string
  capabilities: Partial<HarnessCapabilities> & Record<string, unknown>
  processID?: number
}

export type MachineSnapshot = {
  machine: {
    id: string
    name: string
    createdAt?: string
  }
  agents: MachineAgentHost[]
}

export type HealthResponse = {
  healthy: boolean
  version: string
  backend?: BackendKind
}

export type ModelSelection = {
  providerID: string
  modelID: string
  variant?: string
}

export type AgentOption = {
  id: string
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
}

export type ModelOption = ModelSelection & {
  providerName: string
  modelName: string
  /** Present when the harness describes its models, as the ACP adapters do; OpenCode does not. */
  description?: string
  status?: string
  contextLimit?: number
  outputLimit?: number
  tools?: boolean
  attachments?: boolean
  isDefault?: boolean
}

export type Session = {
  id: string
  title: string
  directory: string
  time: {
    created: number
    updated: number
  }
  summary?: {
    additions: number
    deletions: number
    files: number
  }
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  project?: {
    id: string
    name?: string
    worktree: string
  } | null
  revert?: {
    messageID: string
    partID?: string
  }
  external?: boolean
  parentID?: string
  /** The active agent id (v2 sessions carry it on the wire; v1/bridge sessions do not). */
  agent?: string
}

export type SessionStatus = {
  type: string
  attempt?: number
  message?: string
  next?: number
}

export type ToolState = {
  status: string
  /** Tool input as a plain record. The OpenCode 2 wire carries a STRING input on `streaming` state;
   *  the v2 mapper wraps that string as `{ command }` so this field stays record-shaped. */
  input?: Record<string, unknown>
  title?: string
  output?: string
  error?: string
  time?: { start: number; end?: number }
  metadata?: { answers?: string[][] }
  /** Exit code of a finished shell tool (v2 shell messages; `state.metadata.exit` on v1 shells). */
  exitCode?: number
  /** Files a tool produced (`type:"file"` v2 tool content), kept with the tool part so the rendered
   *  tool card can offer them without re-deriving them from the raw wire payload. */
  outputFiles?: Array<{ uri: string; mime: string; name?: string }>
}

/** The part kinds the transcript understands. The legacy `file` / `patch` / `step-start` /
 *  `step-finish` kinds come from the v1/bridge backends; OpenCode 2's richer message types map onto
 *  the structured `switch` / `system` / `skill-activation` / `file-content` kinds, and anything the
 *  v2 wire grows later lands on `fallback` instead of being silently dropped. */
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "file"
  | "patch"
  | "step-start"
  | "step-finish"
  | "switch"
  | "system"
  | "skill-activation"
  | "file-content"
  | "fallback"

export type MessagePart = {
  id: string
  messageID?: string
  type: MessagePartType
  text?: string
  tool?: string
  callID?: string
  state?: ToolState
  hash?: string
  files?: string[]
  mime?: string
  url?: string
  filename?: string
  time?: { start: number; end?: number }
  // --- OpenCode 2 structured part fields (only set by the v2 mapper) --------------------------
  /** `switch`: which kind of switch — agent, model or location. */
  kind?: "agent" | "model" | "location"
  /** `switch`: the new value (agent id / model ref id / location directory). */
  value?: string
  /** `switch`: the previous value, when the wire carried it. */
  previous?: string
  /** `switch` (model): the full new model ref so the renderer can show provider/variant detail. */
  model?: { id: string; providerID?: string; variant?: string }
  /** `switch` (location): the new project subpath the switch moved to. */
  subpath?: string
  /** `system`: the short human-readable summary the wire paired with the model-facing text. */
  description?: string
  /** `skill-activation`: the activated skill's stable catalog id. */
  skillId?: string
  /** `skill-activation`: the skill's user-facing name. */
  name?: string
  /** `file-content`: the file's URI. */
  uri?: string
  /** `fallback`: the (unknown) wire message type this part stands in for. */
  typeName?: string
  /** `fallback`: the sanitized wire payload (secrets scrubbed) so unknown future message types
   *  stay inspectable instead of vanishing from the transcript. */
  raw?: Record<string, unknown>
}

export type MessageEnvelope = {
  info: {
    id: string
    role: string
    sessionID: string
    time: {
      created: number
      completed?: number
    }
    /** V2 synthetic message metadata used by asynchronous compaction actions. */
    type?: string
    compactionStatus?: "running" | "completed" | "failed"
    delivery?: "queue" | "steer"
    /** Server-confirmed durable message id on optimistic rows: the admission response returns the
     *  exact id the message will carry in history (and the inbox), so the optimistic bubble can be
     *  retired by id instead of by text once the server confirms admission. */
    durableID?: string
    /** OpenCode 2 assistant-level metadata (only ever set by the v2 mapper; the v1/bridge
     *  backends never populate these). Consumed by the transcript header and error rendering. */
    agent?: string
    model?: { id: string; providerID?: string; variant?: string }
    finish?: string
    error?: { type?: string; message?: string }
    cost?: number
    tokens?: { input?: number; output?: number; reasoning?: number }
    retry?: { attempt: number; at: number; error?: { type?: string; message?: string } }
    /** OpenCode 2 delegated-subagent terminal completion (only ever set by the v2 mapper from
     *  the synthetic message the `subagent` tool injects; the v1/bridge backends never populate
     *  this). This is the terminal signal for a child session spawned as a delegated task. */
    subagent?: { childID: string; agent?: string; state: "completed" | "error" | "cancelled" }
  }
  parts: MessagePart[]
}

export type TodoItem = {
  content: string
  status: string
  priority: string
  id: string
}

export type QuestionOption = {
  label: string
  description: string
  /** Backend value represented by the display label; absent for legacy question backends. */
  value?: string
}

export type QuestionCondition = {
  key: string
  op: "eq" | "neq"
  value: string | number | boolean
}

export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
  /** Optional fields may be left blank without blocking submission of the rest of the form. */
  optional?: boolean
  /** OpenCode 2 metadata used to evaluate conditional visibility against earlier answers. */
  key?: string
  answerType?: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  when?: QuestionCondition[]
  externalUrl?: string
}

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: {
    messageID: string
    callID: string
  }
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

/** One durable allow-always grant (`GET /api/permission/saved`), for the revoke UI. */
export type SavedPermission = {
  id: string
  projectID: string
  action: string
  resource: string
}

export type DiffFile = {
  file: string
  additions: number
  deletions: number
  patch?: string
  status?: "added" | "deleted" | "modified"
}

export type ProjectCurrent = Record<string, unknown> & {
  name?: string
  path?: string
  directory?: string
  root?: string
}

export type VcsStatus = Record<string, unknown> & {
  branch?: string
  status?: string
  ahead?: number
  behind?: number
}

export type FileStatusEntry = Record<string, unknown> & {
  path?: string
  file?: string
  status?: string
}

export type FileEntry = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored?: boolean
}

export type PathInfo = {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

export type ProjectDashboard = {
  project: ProjectCurrent | null
  vcs: VcsStatus | null
  files: FileStatusEntry[]
}

export type SessionView = {
  id: string
  title: string
  directory: string
  updated: number
  status: string
  files: number
  additions: number
  deletions: number
  model?: ModelSelection
  revertMessageID?: string
  external?: boolean
  /** The active agent id; only the v2 mapper lane populates it (see toSessionView in App.tsx). */
  agent?: string
}

export type CommandInfo = {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
  /** Stable skill id from the v2 skill catalog (`SkillV2.Info.id`); skills only. */
  id?: string
  /** v2 skills the server activates on its own; carried so callers can exclude them from manual invocation. */
  autoinvoke?: boolean
}

export type HarnessAction = {
  id: string
  source?: string
  enabled: boolean
}

export type HarnessActionResult = {
  action: string
  applied: boolean | null
  actions: HarnessAction[]
  sessionRevision?: string
}
