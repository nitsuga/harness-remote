import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { App as CapacitorApp } from "@capacitor/app"
import { Capacitor, type PluginListenerHandle } from "@capacitor/core"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, isValidServerConfig } from "./api"
import {
  createMessageRequestID,
  createSessionRequestID,
  isAdmissionConflict,
  isIndeterminateDeliveryError
} from "./opencode2-client"
import {
  subagentCompletionDescription,
  subagentRunFromCompletion,
  subagentRunFromTool,
  type AgentRunStatus,
  type SubagentRun
} from "./agentRuns"
import { deriveSessionStatus, executionEventKind, reduceExecutionEvent, type SessionExecutionMemory } from "./sessionStatus"
import {
  createDesktopOpenCodeEventSubscription,
  desktopProfileID,
  isAndroidPlatform,
  isDesktopPlatform,
  notifyDesktopCompletion,
  openDesktopExternalUrl,
  desktopUsesNativeMenu,
  setDesktopApplicationMenu,
  subscribeDesktopMenuCommands,
  syncDesktopProfiles
} from "./desktopBridge"
import {
  createFetchOpenCodeEventSubscription,
  createNativeOpenCodeEventSubscription,
  eventPayload,
  eventType,
  isNativeEventTransport,
  type EventStreamStatus
} from "./opencode-events"
import { createTranslator, languageOptions, normalizeLanguage, type LanguageCode } from "./i18n"
import { stripMarkdownDirectives } from "./markdownDirectives"
import { isQuestionActive, applyInboxDelivery, type V2InboxItem } from "./opencode2-mappers"
import { DEFAULT_HARNESS_CAPABILITIES } from "./backendCapabilities"
import { BACKEND_CLIENTS } from "./backendClient"
import { copyToClipboard } from "./clipboard"
import { backendDisplayName, isBridgeBackend } from "./backendSetup"
import { type AttachmentPart } from "./attachments"
import { CommandPalette, MenuBar, ServerSwitcher, type MenuDefinition, type MenuEntry, type PaletteCommand } from "./components/shell"
import { ConnectServerWizard, NewSessionDialog } from "./components/panels"
import { SessionComposer } from "./components/session-composer"
import { createSessionMutationCoordinator, type MutationKind, type MutationLease, type SessionMutationCoordinator } from "./session-mutation-coordinator"
import { SessionSidebar, SessionsPanel, formatTime, projectLabel, shortDirectory, type SessionRenameState } from "./components/session-list"
import { createServerProfile, loadActiveServerProfile, loadServerProfiles, persistServerProfiles, type SavedServerProfile } from "./serverProfiles"
import type { DesktopMenuCommand, DesktopMenuTemplate } from "../electron/ipc-contract"
import type { AgentOption, CommandInfo, DiffFile, FileEntry, FileStatusEntry, HarnessAction, HarnessCapabilities, MessageEnvelope, MessagePart, ModelOption, ModelSelection, PathInfo, PermissionRequest, ProjectDashboard, QuestionInfo, QuestionRequest, ServerConfig, Session, SessionStatus, SessionView, TodoItem } from "./types"
import {
  SettingsIcon,
  ArrowLeftIcon,
  FolderIcon,
  ChatIcon,
  CommandIcon,
  JumpToTopIcon,
  JumpToBottomIcon,
  HelpIcon,
  PanelRightIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  TrashIcon,
  StopCircleIcon,
  SaveIcon,
  TestIcon,
  LoadingIcon,
  RefreshIcon,
  PencilIcon,
  CloseIcon,
  MoreVerticalIcon
} from "./Icons"

const REMARK_PLUGINS = [remarkGfm]

const LANGUAGE_STORAGE_KEY = "opencode.remote.language"
const MODEL_STORAGE_KEY = "opencode.remote.model"
const AGENT_STORAGE_KEY = "opencode.remote.agent"
const THEME_STORAGE_KEY = "opencode.remote.theme"
// Each wider sidebar baseline gets its own preference version so installations that persisted the
// previous, cramped default receive the new baseline once, while every subsequent manual resize
// sticks. Bump the key only when the baseline itself changes, never for a drag-once tweak.
const SIDEBAR_WIDTH_STORAGE_KEY = "opencode.remote.desktopSidebarWidth.v4"
const INSPECTOR_WIDTH_STORAGE_KEY = "opencode.remote.desktopInspectorWidth"
const INSPECTOR_OPEN_STORAGE_KEY = "opencode.remote.desktopInspectorOpen"
const NEW_SESSION_DIRECTORY_STORAGE_KEY = "opencode.remote.newSessionDirectory"
const REMOVED_SESSION_STORAGE_KEY = "opencode.remote.sessionTombstones.v1"

function tombstoneNamespaceKey(profileID: string, namespace: string): string {
  // Do not put server credentials (which are part of configKey) in localStorage keys.
  let hash = 2166136261
  for (const char of `${profileID}\u0000${namespace}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(16)
}

function readSessionTombstones(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REMOVED_SESSION_STORAGE_KEY) ?? "null")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result
    const namespaces = (parsed as { namespaces?: unknown }).namespaces
    if (!namespaces || typeof namespaces !== "object" || Array.isArray(namespaces)) return result
    for (const [key, value] of Object.entries(namespaces)) {
      if (!/^[0-9a-f]+$/.test(key) || !Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 512)
      if (ids.length) result.set(key, new Set(ids))
    }
  } catch { /* Corrupt or unavailable storage is treated as empty. */ }
  return result
}

function persistSessionTombstones(tombstones: Map<string, Set<string>>): void {
  try {
    const namespaces: Record<string, string[]> = {}
    // Raw in-memory namespace keys are retained for ABA checks, but never written: configKey
    // includes credentials. Persisted keys are the opaque hashes populated by this module.
    for (const [key, ids] of tombstones) if (!key.includes("\u0000") && ids.size) namespaces[key] = [...ids]
    localStorage.setItem(REMOVED_SESSION_STORAGE_KEY, JSON.stringify({ version: 1, namespaces }))
  } catch { /* Storage can be disabled or full; memory protections still apply. */ }
}

function mergedSessionTombstones(
  tombstones: Map<string, Set<string>>,
  runtimeKey: string,
  persistedKey: string
): Set<string> {
  // Hydrated state uses opaque keys while live ABA checks use the raw namespace key. They are
  // two representations of one namespace, never alternatives where one can shadow the other.
  const merged = new Set([...(tombstones.get(runtimeKey) ?? []), ...(tombstones.get(persistedKey) ?? [])])
  if (merged.size) {
    tombstones.set(runtimeKey, merged)
    tombstones.set(persistedKey, merged)
  }
  return merged
}

type Translator = ReturnType<typeof createTranslator>

/** One pixel past the stylesheet's `@media (max-width: 780px)` block, so the JS layout switches on
 *  exactly the width the CSS does. Named because the Help page quotes the number back to the user. */
const DESKTOP_MIN_WIDTH = 781
const DESKTOP_MEDIA_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`

const SIDEBAR_WIDTH_MIN = 220
const SIDEBAR_WIDTH_MAX = 960
const SIDEBAR_WIDTH_DEFAULT = 320
/** Full-screen desktop windows get the sidebar doubled from the previous wide baseline: a session
 *  list is the main workspace there, not a thin rail, and the extra width keeps row actions usable. */
const SIDEBAR_WIDTH_WIDE_DEFAULT = 768
const WIDE_DESKTOP_MIN_WIDTH = 1600
const INSPECTOR_WIDTH_MIN = 260
const INSPECTOR_WIDTH_MAX = 480
const INSPECTOR_WIDTH_DEFAULT = 320
/** The narrowest the main pane may be squeezed to before a side panel has to stop growing. */
const MAIN_WIDTH_MIN = 420
/** Below this the inspector is folded away automatically: three panes in less room than this turns
 *  the conversation into a gutter, and the same content is one click away in the context chips. */
const INSPECTOR_MIN_WINDOW_WIDTH = 1180

/** How long a compaction whose admission (or terminal message) could not be confirmed may keep its
 *  pending state before resolving with a retryable notice. Bounded so the menu never blocks forever. */
const COMPACTION_PENDING_MAX_MS = 45_000

/** Fork reconciliation after a lost acknowledgement: how many authoritative child listings to try,
 *  and how long to wait between them, before giving up on confirming the child. */
const FORK_RECONCILE_MAX_ATTEMPTS = 5
const FORK_RECONCILE_ATTEMPT_DELAY_MS = 800

// The shared `api` proxy is typed to the v1 clients' surface; the v2 client implements richer
// signatures (stable request ids, admission ids, child listings). These casts expose only the
// extra parameters/returns the call sites below need, never the transport itself.
const compactSessionV2 = api.compactSession as unknown as (
  config: ServerConfig, sessionID: string, directory: string, requestID: string
) => Promise<{ id?: string; requestID?: string }>
const sendPromptV2 = api.sendPrompt as unknown as (
  config: ServerConfig, sessionID: string, text: string, directory: string | undefined,
  model: ModelSelection | undefined, agentID: string | undefined,
  attachments: AttachmentPart[], delivery: "steer" | "queue", requestID: string
) => Promise<{ admitted: boolean; requestID?: string; messageID?: string; delivery?: "steer" | "queue" }>
const sendCommandV2 = api.sendCommand as unknown as (
  config: ServerConfig, sessionID: string, command: string, argumentsText: string,
  directory: string | undefined, model: ModelSelection | undefined, agentID: string | undefined,
  requestID: string
) => Promise<{ admitted: boolean; requestID?: string; messageID?: string; delivery?: "steer" | "queue" }>
const sendSkillV2 = api.sendSkill as unknown as (
  config: ServerConfig, sessionID: string, skill: string, directory: string | undefined, requestID: string
) => Promise<unknown>
const listChildSessionsV2 = (api as unknown as {
  listChildSessions(config: ServerConfig, parentID: string): Promise<Session[]>
}).listChildSessions
const getSessionV2 = (api as unknown as {
  getSession(config: ServerConfig, sessionID: string): Promise<Session>
}).getSession
const listInboxV2 = (api as unknown as {
  listInbox(config: ServerConfig, sessionID: string, directory?: string): Promise<V2InboxItem[]>
}).listInbox

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The widest a side panel may be dragged: its own maximum, or less on a window too narrow to give
 *  the main pane its floor as well. `otherPanel` is whatever the opposite edge is already using. */
function maxPanelWidth(max: number, min: number, otherPanel: number): number {
  return Math.max(min, Math.min(max, window.innerWidth - MAIN_WIDTH_MIN - otherPanel))
}

function maxSidebarWidth(otherPanel = 0): number {
  return maxPanelWidth(SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, otherPanel)
}

function maxInspectorWidth(otherPanel = 0): number {
  return maxPanelWidth(INSPECTOR_WIDTH_MAX, INSPECTOR_WIDTH_MIN, otherPanel)
}

function defaultSidebarWidth(): number {
  return window.innerWidth >= WIDE_DESKTOP_MIN_WIDTH ? SIDEBAR_WIDTH_WIDE_DEFAULT : SIDEBAR_WIDTH_DEFAULT
}

/** "Ctrl" everywhere except macOS, which reads ⌘ — the palette hint and every menu accelerator has
 *  to say the one the user's keyboard actually has. */
const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Touch-primary devices have no Shift key on the soft keyboard, so the composer's
 *  "Enter sends, Shift+Enter for a new line" model must flip there: Enter inserts a new line,
 *  Ctrl/Cmd+Enter sends, and the send button covers soft-keyboard-only devices. Desktop and
 *  any device with a fine pointer (including hybrid laptops whose primary pointer is a mouse)
 *  keep the physical-keyboard behaviour untouched. */
const SOFT_KEYBOARD_DEVICE =
  isAndroidPlatform(Capacitor.getPlatform()) ||
  (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches)

function shortcut(key: string): string {
  return IS_APPLE ? `⌘${key}` : `Ctrl+${key}`
}

/**
 * One place binding a command to a key. Three consumers read from it and previously each spelled the
 * binding out for itself: the label shown in menus and the palette, the accelerator the platform
 * menu registers, and the in-app keydown handler. Keeping them derived is what stops a menu from
 * advertising a shortcut the handler does not implement — and it is what fixes "Ctrl+N+Shift",
 * which was written by hand in the wrong order.
 */
const KEY_BINDINGS: Record<string, { key: string; shift?: boolean; desktopOnly?: boolean }> = {
  "view.palette": { key: "k" },
  "session.new": { key: "n" },
  "server.add": { key: "n", shift: true },
  // Reload and find-in-page belong to the browser, and a page that takes them is a page that
  // misbehaves: the user loses the two keys they reach for when something looks stuck. The packaged
  // app has no such owner for them, so there they are ours.
  "focus.search": { key: "f", desktopOnly: true },
  "session.refresh": { key: "r", desktopOnly: true },
  "server.settings": { key: "," },
  "view.inspector": { key: "b" }
}

/** Whether a binding applies here. Fixed for the life of the process: it is a property of the
 *  build, not of the window, so nothing has to react to it changing. */
function bindingApplies(binding: { desktopOnly?: boolean }): boolean {
  return !binding.desktopOnly || isDesktopPlatform()
}

function bindingKeyLabel(binding: { key: string }): string {
  return binding.key.length === 1 && /[a-z]/.test(binding.key) ? binding.key.toUpperCase() : binding.key
}

function displayShortcut(command: string): string | undefined {
  const binding = KEY_BINDINGS[command]
  // A shortcut the build does not bind must not be advertised either: a menu promising Ctrl+F while
  // the browser keeps find-in-page is worse than a menu item with no shortcut at all.
  if (!binding || !bindingApplies(binding)) return undefined
  const shift = binding.shift ? (IS_APPLE ? "⇧" : "Shift+") : ""
  return IS_APPLE ? `⌘${shift}${bindingKeyLabel(binding)}` : `Ctrl+${shift}${bindingKeyLabel(binding)}`
}

/** Electron's own accelerator grammar, which is neither the label nor the DOM key name. */
function electronAccelerator(command: string): string | undefined {
  const binding = KEY_BINDINGS[command]
  if (!binding) return undefined
  return `CmdOrCtrl+${binding.shift ? "Shift+" : ""}${bindingKeyLabel(binding)}`
}

/** The command a keystroke means, or null. Shared by the in-app handler so it can never disagree
 *  with what the menus say. */
function commandForKeyEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase()
  for (const [command, binding] of Object.entries(KEY_BINDINGS)) {
    if (!bindingApplies(binding)) continue
    if (binding.key === key && Boolean(binding.shift) === event.shiftKey) return command
  }
  return null
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? clamp(raw, min, max) : fallback
}

/** Drags a horizontal panel border: reports the pointer's horizontal movement since the previous
 *  event (not since drag start), so callers can just add/subtract the delta from their own state
 *  without tracking a separate drag-start snapshot. */
function useHorizontalDrag(onDeltaX: (deltaX: number) => void): (event: React.PointerEvent) => void {
  return useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    let lastX = event.clientX
    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - lastX
      lastX = moveEvent.clientX
      if (deltaX !== 0) onDeltaX(deltaX)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }, [onDeltaX])
}

function isSessionWorking(status: string): boolean {
  return status === "busy" || status === "retry" || status === "waiting"
}

function extractText(msg: MessageEnvelope): string {
  return msg.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/** Wraps a message with its extracted text, reusing the previous wrapper when the underlying message object is
 *  unchanged. applyStreamedPartUpdate/applyStreamedPartDelta already keep unrelated messages referentially
 *  identical across streamed updates — without this cache, mapping over the whole array would create a brand
 *  new wrapper object for every message on every token, defeating memoization of per-message rendering. */
const renderedMessageCache = new WeakMap<MessageEnvelope, MessageEnvelope & { text: string }>()

function toRenderedMessage(message: MessageEnvelope): MessageEnvelope & { text: string } {
  const cached = renderedMessageCache.get(message)
  if (cached) return cached
  const wrapped = { ...message, text: extractText(message) }
  renderedMessageCache.set(message, wrapped)
  return wrapped
}

function sameModelRef(
  left: MessageEnvelope["info"]["model"],
  right: MessageEnvelope["info"]["model"]
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.id === right.id && left.providerID === right.providerID && left.variant === right.variant
}

function sameErrorRef(
  left: MessageEnvelope["info"]["error"],
  right: MessageEnvelope["info"]["error"]
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.type === right.type && left.message === right.message
}

/** Shallow `info.subagent` comparison: childID/agent/state arrive wholesale with each poll, like
 *  the other assistant-level metadata above. */
function sameSubagentRef(
  left: MessageEnvelope["info"]["subagent"],
  right: MessageEnvelope["info"]["subagent"]
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.childID === right.childID && left.agent === right.agent && left.state === right.state
}

/** Whether two envelopes carry the same OpenCode 2 assistant-level metadata (agent/model/finish/
 *  error/cost/tokens/retry/subagent). Shallow by design: these fields arrive wholesale with each
 *  poll, and a field-level comparison keeps reconciliation from churning message references — and
 *  the per-message render cache — whenever nothing a renderer could show actually changed. */
export function sameEnvelopeMetadata(left: MessageEnvelope["info"], right: MessageEnvelope["info"]): boolean {
  return left.agent === right.agent
    && sameModelRef(left.model, right.model)
    && left.finish === right.finish
    && sameErrorRef(left.error, right.error)
    && left.cost === right.cost
    && left.tokens?.input === right.tokens?.input
    && left.tokens?.output === right.tokens?.output
    && left.tokens?.reasoning === right.tokens?.reasoning
    && left.retry?.attempt === right.retry?.attempt
    && left.retry?.at === right.retry?.at
    && sameErrorRef(left.retry?.error, right.retry?.error)
    && sameSubagentRef(left.subagent, right.subagent)
}

function messagesHaveSameContent(left: MessageEnvelope[], right: MessageEnvelope[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const candidate = right[index]
    return candidate?.info.role === message.info.role && candidate?.info.type === message.info.type
      && candidate?.info.compactionStatus === message.info.compactionStatus && extractText(candidate) === extractText(message)
      && sameEnvelopeMetadata(candidate.info, message.info)
  })
}

/**
 * Polling refetches the whole set of side lists every few seconds, and handing React a fresh array
 * each time is a state change even when the contents are identical. That re-rendered the transcript
 * — re-parsing every message's markdown — six times per poll for data nobody had changed, which is
 * what made a busy chat lock the app up for seconds on a phone. These lists are short, so comparing
 * them is far cheaper than the render it avoids.
 */
function keepIfUnchanged<T>(previous: T[], next: T[]): T[] {
  if (previous === next) return previous
  if (previous.length !== next.length) return next
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

function messagesExtendContent(current: MessageEnvelope[], next: MessageEnvelope[]): boolean {
  if (next.length < current.length) return false
  return current.every((message, index) => {
    const candidate = next[index]
    return candidate?.info.role === message.info.role && extractText(candidate).startsWith(extractText(message))
  })
}

function normalizeMessageMarkdown(text: string): string {
  const stripped = stripMarkdownDirectives(text)
  return stripped.includes("\n") ? stripped : stripped.replace(/\s-\s(?=\S)/g, "\n- ")
}

function capitalizeFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

const MODAL_TITLE_MAX_LENGTH = 80
/**
 * How long the open session may go without an SSE event before the poll treats the stream as not
 * covering it. Comfortably above opencode's 10s server heartbeat so a merely idle session isn't
 * mistaken for a broken one the instant it stops streaming.
 */
const SESSION_STREAM_QUIET_MS = 12_000

function truncateForTitle(text: string, maxLength: number = MODAL_TITLE_MAX_LENGTH): string {
  const singleLine = text.replace(/\s+/g, " ").trim()
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine
}

function toolCommandLabel(part: MessagePart): string {
  const input = part.state?.input
  if (!input) return part.tool || "tool"
  if (typeof input.command === "string") return input.command
  if (typeof input.filePath === "string") return `${part.tool}: ${input.filePath}`
  return `${part.tool}(${JSON.stringify(input)})`
}

/** Counts changed lines between two strings using an LCS-based line diff. Skipped (returns null) for inputs large
 *  enough that the O(n*m) table would be expensive — callers fall back to no diff stats in that case. */
function diffLineStats(oldText: string, newText: string): { additions: number; deletions: number } | null {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length * b.length > 250_000) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lcsLength = dp[0][0]
  return { additions: b.length - lcsLength, deletions: a.length - lcsLength }
}

/** Builds a simple unified-style diff (no hunk headers, every line shown) between two strings, for rendering
 *  with DiffLines. Skipped (returns null) for the same size cutoff as diffLineStats. */
function buildSimpleDiff(oldText: string, newText: string): string | null {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length * b.length > 250_000) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${a[i]}`)
      i++
    } else {
      lines.push(`+${b[j]}`)
      j++
    }
  }
  while (i < a.length) {
    lines.push(`-${a[i]}`)
    i++
  }
  while (j < b.length) {
    lines.push(`+${b[j]}`)
    j++
  }
  return lines.join("\n")
}

/** Shortens a tool's absolute file path to a path relative to the session's working directory, when the file
 *  actually lives under it — long absolute paths otherwise get truncated in the single-line summary row. */
function relativizePath(path: string, directory: string | undefined): string {
  if (!directory) return path
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const normalizedPath = normalize(path)
  const normalizedDir = normalize(directory)
  if (normalizedPath === normalizedDir) return "."
  const prefix = `${normalizedDir}/`
  if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedPath.slice(prefix.length)
  }
  return path
}

function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter(
    (item): item is TodoItem => Boolean(item) && typeof item === "object" && typeof (item as TodoItem).content === "string"
  )
  return items.length > 0 ? items : null
}

function parseQuestions(value: unknown): QuestionInfo[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter(
    (item): item is QuestionInfo => Boolean(item) && typeof item === "object" && typeof (item as QuestionInfo).question === "string"
  )
  return items.length > 0 ? items : null
}

/** Turns a raw tool call into a human-readable description of what the bot did, plus a +/- line-diff summary
 *  when the tool is an edit with old/new content to compare. */
function describeToolAction(
  part: MessagePart,
  directory: string | undefined,
  t: Translator
): { label: string; diff: { additions: number; deletions: number } | null } {
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  const tool = (part.tool || "").toLowerCase()
  const filePath = typeof input.filePath === "string" ? relativizePath(input.filePath, directory) : undefined

  switch (tool) {
    case "read":
      return { label: filePath ? t('action.readFileNamed', { file: filePath }) : t('action.readFile'), diff: null }
    case "write": {
      const content = typeof input.content === "string" ? input.content : null
      const diff = content !== null ? diffLineStats("", content) : null
      return { label: filePath ? t('action.wroteFileNamed', { file: filePath }) : t('action.wroteFile'), diff }
    }
    case "edit": {
      const oldString = typeof input.oldString === "string" ? input.oldString : null
      const newString = typeof input.newString === "string" ? input.newString : null
      const diff = oldString !== null && newString !== null ? diffLineStats(oldString, newString) : null
      return { label: filePath ? t('action.editedFileNamed', { file: filePath }) : t('action.editedFile'), diff }
    }
    case "bash":
      return {
        label: typeof input.command === "string" ? t('action.ranCommandNamed', { command: input.command }) : t('action.ranCommand'),
        diff: null
      }
    case "glob":
      return {
        label: typeof input.pattern === "string" ? t('action.searchedFilesFor', { pattern: input.pattern }) : t('action.searchedFiles'),
        diff: null
      }
    case "grep":
      return {
        label: typeof input.pattern === "string" ? t('action.searchedCodeFor', { pattern: input.pattern }) : t('action.searchedCode'),
        diff: null
      }
    case "webfetch":
      return { label: typeof input.url === "string" ? t('action.fetchedUrlNamed', { url: input.url }) : t('action.fetchedUrl'), diff: null }
    case "todowrite": {
      const todos = parseTodos(input.todos)
      if (!todos) return { label: t('action.updatedTodos'), diff: null }
      const done = todos.filter((item) => item.status === "completed").length
      return { label: t('action.todoSummary', { done, total: todos.length }), diff: null }
    }
    case "question": {
      const questions = parseQuestions(input.questions)
      if (!questions) return { label: t('action.askedQuestion'), diff: null }
      return {
        label: questions.length === 1 ? t('action.askedQuestionNamed', { question: questions[0].question }) : t('action.askedQuestions', { n: questions.length }),
        diff: null
      }
    }
    case "task":
      return {
        label:
          typeof input.description === "string"
            ? t('action.ranSubagentNamed', { description: input.description })
            : t('action.ranSubagent'),
        diff: null
      }
    case "skill":
      return {
        label: typeof input.name === "string" ? t('action.usedSkillNamed', { name: input.name }) : t('action.usedSkill'),
        diff: null
      }
    default:
      return { label: toolCommandLabel(part), diff: null }
  }
}

function TodoListView({ items }: { items: TodoItem[] }) {
  return (
    <div className="message-todo-list">
      {items.map((item) => (
        <div key={item.id} className="todo-item">
          <span className={`todo-status ${item.status}`}>
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
          </span>
          <span>{item.content}</span>
        </div>
      ))}
    </div>
  )
}

function QuestionListView({ questions, answers }: { questions: QuestionInfo[]; answers?: string[][] }) {
  return (
    <div className="question-options">
      {questions.map((question, index) => {
        const chosen = answers?.[index] ?? []
        const customAnswer = chosen.find((value) => !question.options.some((option) => option.label === value))
        return (
          <div key={index} className="question-block">
            <div className="question-header">{question.header}</div>
            <p className="question-text">{question.question}</p>
            {question.options.length > 0 && (
              <div className="question-options">
                {question.options.map((option) => (
                  <div
                    key={option.label}
                    className={`question-option static ${chosen.includes(option.label) ? "selected" : ""}`}
                  >
                    <span className="question-option-label">{option.label}</span>
                    {option.description && <span className="question-option-description">{option.description}</span>}
                  </div>
                ))}
              </div>
            )}
            {customAnswer && (
              <div className="question-option static selected">
                <span className="question-option-label">{customAnswer}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DiffLines({ patch }: { patch: string }) {
  const lines = patch.split("\n")
  return (
    <pre className="message-diff-patch">
      {lines.map((line, index) => {
        let className = "diff-line-context"
        if (line.startsWith("+++") || line.startsWith("---")) className = "diff-line-meta"
        else if (line.startsWith("+")) className = "diff-line-add"
        else if (line.startsWith("-")) className = "diff-line-del"
        else if (line.startsWith("@@")) className = "diff-line-hunk"
        return (
          <div key={index} className={className}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}

function PatchPartView({
  config,
  sessionID,
  messageID,
  files,
  timestamp,
  t
}: {
  config: ServerConfig
  sessionID: string
  messageID: string
  files: string[]
  timestamp?: string
  t: Translator
}) {
  const [diffs, setDiffs] = useState<DiffFile[] | null>(null)
  const [expandedDiff, setExpandedDiff] = useState<DiffFile | null>(null)

  useEffect(() => {
    let cancelled = false
    api.loadMessageDiff(config, sessionID, messageID).then((result) => {
      if (!cancelled) setDiffs(result)
    }).catch(() => {
      if (!cancelled) setDiffs([])
    })
    return () => {
      cancelled = true
    }
  }, [config.host, config.port, config.username, config.password, sessionID, messageID])

  if (diffs === null) {
    return (
      <div className="message-patch">
        {files.map((file) => (
          <div key={file} className="message-patch-file">{file}</div>
        ))}
      </div>
    )
  }

  if (diffs.length === 0) return null

  return (
    <div className="message-patch">
      {diffs.map((diff) => (
        <button
          key={diff.file}
          type="button"
          className="message-diff-row"
          onClick={() => setExpandedDiff(diff)}
          aria-label={t('action.showDiffFor', { file: diff.file })}
        >
          <span className="message-diff-file">{diff.file}</span>
          <span className="message-diff-stats">
            {diff.additions > 0 && <span className="diff-stat-add">+{diff.additions}</span>}
            {diff.deletions > 0 && <span className="diff-stat-del">-{diff.deletions}</span>}
          </span>
        </button>
      ))}

      {expandedDiff && (
        <Modal title={expandedDiff.file} timestamp={timestamp} onClose={() => setExpandedDiff(null)} t={t}>
          {expandedDiff.patch && <DiffLines patch={expandedDiff.patch} />}
        </Modal>
      )}
    </div>
  )
}

const BOTTOM_STICK_THRESHOLD = 80

/** How far from an end a list must be scrolled before its jump button appears, at most. */
const JUMP_AFFORDANCE_MAX_THRESHOLD = 320
/** Below this much total travel, jumping saves nobody a scroll and the buttons are pure clutter. */
const JUMP_AFFORDANCE_MIN_RANGE = 240

type JumpAffordances = { top: boolean; bottom: boolean }
type ScrollMetrics = { fromTop: number; fromBottom: number }

const NO_JUMP_AFFORDANCES: JumpAffordances = { top: false, bottom: false }

/** Which jump buttons are worth showing at this scroll position.
 *
 *  The threshold has to scale with the total scroll range rather than being a flat 320px. Measured
 *  absolutely, a list that only scrolls ~600px has no position where both ends are more than 320px
 *  away, and its jump-to-top only appears in the last 320px of travel — which reads as "the buttons
 *  only show up at the very bottom". Anything scrolling less than 320px got no buttons at all. */
function jumpAffordancesFor({ fromTop, fromBottom }: ScrollMetrics): JumpAffordances {
  const range = fromTop + fromBottom
  if (range < JUMP_AFFORDANCE_MIN_RANGE) return NO_JUMP_AFFORDANCES
  const threshold = Math.min(JUMP_AFFORDANCE_MAX_THRESHOLD, range * 0.25)
  return { top: fromTop > threshold, bottom: fromBottom > threshold }
}

function windowScrollMetrics(): ScrollMetrics {
  const doc = document.documentElement
  return { fromTop: window.scrollY, fromBottom: doc.scrollHeight - window.scrollY - window.innerHeight }
}

function elementScrollMetrics(element: HTMLElement | null): ScrollMetrics {
  if (!element) return { fromTop: 0, fromBottom: 0 }
  return {
    fromTop: element.scrollTop,
    fromBottom: element.scrollHeight - element.scrollTop - element.clientHeight
  }
}

/** True when the element is a real scroller rather than one that grows to fit its content. Geometry
 *  alone is not enough: scrollHeight also exceeds clientHeight on an overflow: visible element whose
 *  content spills, which is exactly what the mobile message list is, and treating that as a scroller
 *  reads a scrollTop that is permanently 0. */
function scrollsItself(element: HTMLElement | null): element is HTMLElement {
  if (!element || element.scrollHeight <= element.clientHeight + 1) return false
  const overflowY = window.getComputedStyle(element).overflowY
  return overflowY === "auto" || overflowY === "scroll"
}

/** Watches how far a list sits from each end and reports which jump buttons are worth showing.
 *  `getMetrics` is injected because the scroller varies: the chat scrolls its own pane in the
 *  desktop layout, while every mobile list lets the page scroll instead. Returns a `refresh` to
 *  call from an element's own onScroll and whenever content changes the distances without a
 *  scroll event. */
function useJumpAffordances(active: boolean, getMetrics: () => ScrollMetrics): [JumpAffordances, () => void] {
  const [affordances, setAffordances] = useState<JumpAffordances>(NO_JUMP_AFFORDANCES)
  const getMetricsRef = useRef(getMetrics)
  getMetricsRef.current = getMetrics

  const refresh = useCallback(() => {
    const next = jumpAffordancesFor(getMetricsRef.current())
    setAffordances((current) => (current.top === next.top && current.bottom === next.bottom ? current : next))
  }, [])

  useEffect(() => {
    if (!active) {
      setAffordances(NO_JUMP_AFFORDANCES)
      return
    }
    window.addEventListener("scroll", refresh, { passive: true })
    window.addEventListener("resize", refresh)
    // Layout settles a frame after the view mounts, so the first read has to wait for it.
    const frame = requestAnimationFrame(refresh)
    return () => {
      window.removeEventListener("scroll", refresh)
      window.removeEventListener("resize", refresh)
      cancelAnimationFrame(frame)
    }
  }, [active, refresh])

  return [affordances, refresh]
}

/** Floating jump-to-top/bottom buttons for a long list. */
function JumpControls({
  affordances,
  onJumpToTop,
  onJumpToBottom,
  variant = "chat",
  t
}: {
  affordances: JumpAffordances
  onJumpToTop: () => void
  onJumpToBottom: () => void
  /** "chat" clears the composer, "page" the bottom nav, "sidebar" the desktop sidebar footer. */
  variant?: "chat" | "page" | "sidebar"
  t: Translator
}) {
  if (!affordances.top && !affordances.bottom) return null
  return (
    <div className={`jump-controls jump-controls--${variant}`}>
      {affordances.top && (
        <button
          type="button"
          className="jump-button fade-in"
          onClick={onJumpToTop}
          title={t('app.jumpToTop')}
          aria-label={t('app.jumpToTop')}
        >
          <JumpToTopIcon size={18} />
        </button>
      )}
      {affordances.bottom && (
        <button
          type="button"
          className="jump-button fade-in"
          onClick={onJumpToBottom}
          title={t('app.jumpToBottom')}
          aria-label={t('app.jumpToBottom')}
        >
          <JumpToBottomIcon size={18} />
        </button>
      )}
    </div>
  )
}

let modalTitleSequence = 0

/** Shared full-detail modal — everything that isn't the primary output text (thoughts, tool calls, edits) is
 *  surfaced through this rather than inline collapsible/expandable regions. */
function Modal({
  title,
  timestamp,
  onClose,
  children,
  t
}: {
  title: string
  timestamp?: string
  onClose: () => void
  children: ReactNode
  t: Translator
}) {
  const [titleID] = useState(() => `modal-title-${++modalTitleSequence}`)
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card diff-modal fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleID}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="diff-modal-header">
          <div className="diff-modal-heading">
            <h2 id={titleID}>{title}</h2>
            {timestamp && <small className="diff-modal-timestamp">{timestamp}</small>}
          </div>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('action.close')}
          </button>
        </div>
        <div className="diff-modal-body">{children}</div>
      </section>
    </div>
  )
}

/** Wraps children with `wrapper(children)` only when `condition` holds, otherwise renders children
 *  as-is. Lets a panel's body be written once and reused unmodified in both its mobile inline form
 *  and its desktop modal form. */
function ConditionalWrapper({
  condition,
  wrapper,
  children
}: {
  condition: boolean
  wrapper: (children: ReactNode) => ReactNode
  children: ReactNode
}) {
  return <>{condition ? wrapper(children) : children}</>
}

/** Desktop-only modal shell for panels (settings, help) that already render their own heading —
 *  unlike Modal, it has no title bar of its own, just a close affordance, so the panel's existing
 *  content isn't duplicated under a second title. */
function DesktopModalOverlay({
  onClose,
  ariaLabel,
  children
}: {
  onClose: () => void
  ariaLabel: string
  children: ReactNode
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card desktop-panel-modal fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="btn-secondary desktop-modal-close" onClick={onClose} aria-label={ariaLabel}>
          <CloseIcon size={16} />
        </button>
        {children}
      </section>
    </div>
  )
}

function QuestionCard({
  config,
  directory,
  request,
  onResolved,
  t,
  coordinator,
  onLeaseChanged
}: {
  config: ServerConfig
  directory: string
  request: QuestionRequest
  onResolved: (id: string) => void
  t: Translator
  coordinator: SessionMutationCoordinator
  onLeaseChanged: () => void
}) {
  const [selections, setSelections] = useState<string[][]>(() => request.questions.map(() => []))
  const [customValues, setCustomValues] = useState<string[]>(() => request.questions.map(() => ""))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const answers = request.questions.map((_, index) => {
    const customValue = customValues[index].trim()
    return customValue ? [...selections[index], customValue] : selections[index]
  })

  function toggleOption(questionIndex: number, label: string, multiple: boolean) {
    setSelections((current) => {
      const next = [...current]
      const existing = next[questionIndex]
      next[questionIndex] = multiple
        ? existing.includes(label)
          ? existing.filter((value) => value !== label)
          : [...existing, label]
        : existing.includes(label)
          ? []
          : [label]
      return next
    })
    if (!multiple) {
      setCustomValues((current) => {
        const next = [...current]
        next[questionIndex] = ""
        return next
      })
    }
  }

  function setCustomValue(questionIndex: number, value: string, multiple: boolean) {
    setCustomValues((current) => {
      const next = [...current]
      next[questionIndex] = value
      return next
    })
    if (!multiple && value) {
      setSelections((current) => {
        const next = [...current]
        next[questionIndex] = []
        return next
      })
    }
  }

  const canSubmit = request.questions.every((question, index) => {
    if (!isQuestionActive(request, index, answers)) return true
    if (question.optional) return true
    return answers[index].length > 0
  })

  async function submit() {
    const lease = coordinator.acquireLease("question")
    if (!lease) return
    onLeaseChanged()
    setSubmitting(true)
    setError(null)
    try {
      await api.replyQuestion(config, request.id, answers, directory)
      if (coordinator.isLeaseCurrent(lease) && coordinator.isContextGenerationCurrent(lease.contextGeneration) && coordinator.isContextCurrent(lease.context)) onResolved(request.id)
    } catch (err) {
      if (coordinator.isLeaseCurrent(lease) && coordinator.isContextGenerationCurrent(lease.contextGeneration) && coordinator.isContextCurrent(lease.context)) {
        setError((err as Error).message)
        setSubmitting(false)
      }
    } finally {
      if (coordinator.releaseLease(lease)) onLeaseChanged()
    }
  }

  async function reject() {
    const lease = coordinator.acquireLease("question")
    if (!lease) return
    onLeaseChanged()
    setSubmitting(true)
    setError(null)
    try {
      await api.rejectQuestion(config, request.id, directory)
      if (coordinator.isLeaseCurrent(lease) && coordinator.isContextGenerationCurrent(lease.contextGeneration) && coordinator.isContextCurrent(lease.context)) onResolved(request.id)
    } catch (err) {
      if (coordinator.isLeaseCurrent(lease) && coordinator.isContextGenerationCurrent(lease.contextGeneration) && coordinator.isContextCurrent(lease.context)) {
        setError((err as Error).message)
        setSubmitting(false)
      }
    } finally {
      if (coordinator.releaseLease(lease)) onLeaseChanged()
    }
  }

  return (
    <article className="message assistant question-card fade-in" aria-label={t('question.ariaLabel')}>
      {request.questions.map((question, index) => isQuestionActive(request, index, answers) ? (
        <div key={question.key ?? index} className="question-block">
          <div className="question-header">{question.header}</div>
          <p className="question-text">{question.question}</p>
          <div className="question-options">
            {question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`question-option ${selections[index].includes(option.label) ? "selected" : ""}`}
                onClick={() => toggleOption(index, option.label, Boolean(question.multiple))}
                 disabled={submitting || coordinator.getActiveLease() !== null}
              >
                <span className="question-option-label">{option.label}</span>
                {option.description && <span className="question-option-description">{option.description}</span>}
              </button>
            ))}
          </div>
          {question.externalUrl && (
            <div className="question-external">
              <a
                href={question.externalUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (!isDesktopPlatform()) return
                  event.preventDefault()
                  openDesktopExternalUrl(question.externalUrl!)
                }}
              >
                {t('question.openExternal')}
              </a>
              <button
                type="button"
                className={`question-option ${selections[index].includes("true") ? "selected" : ""}`}
                onClick={() => toggleOption(index, "true", false)}
                 disabled={submitting || coordinator.getActiveLease() !== null}
              >
                <span className="question-option-label">{t('question.externalComplete')}</span>
              </button>
            </div>
          )}
          {question.custom !== false && (
            <input
              type="text"
              className="question-custom-input"
              placeholder={t('question.otherPlaceholder')}
              value={customValues[index]}
              onChange={(event) => setCustomValue(index, event.target.value, Boolean(question.multiple))}
               disabled={submitting || coordinator.getActiveLease() !== null}
            />
          )}
        </div>
      ) : null)}
      {error && <p className="question-error">{error}</p>}
      <div className="question-actions">
        <button type="button" className="btn-secondary" onClick={reject} disabled={submitting || coordinator.getActiveLease() !== null}>
          {t('question.skip')}
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={submitting || coordinator.getActiveLease() !== null || !canSubmit}>
          {t('question.sendAnswer')}
        </button>
      </div>
    </article>
  )
}

function PermissionCard({
  config,
  directory,
  request,
  onResolved,
  t,
  coordinator,
  onLeaseChanged
}: {
  config: ServerConfig
  directory: string
  request: PermissionRequest
  onResolved: (id: string) => void
  t: Translator
  coordinator: SessionMutationCoordinator
  onLeaseChanged: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reply(response: "once" | "always" | "reject") {
    const lease = coordinator.acquireLease("permission")
    if (!lease) return
    onLeaseChanged()
    setSubmitting(true)
    setError(null)
    try {
      await api.replyPermission(config, request.id, response, directory)
      if (coordinator.isLeaseCurrent(lease) && coordinator.isContextGenerationCurrent(lease.contextGeneration) && coordinator.isContextCurrent(lease.context)) onResolved(request.id)
    } catch (err) {
      if (coordinator.isLeaseCurrent(lease) && coordinator.isContextGenerationCurrent(lease.contextGeneration) && coordinator.isContextCurrent(lease.context)) {
        setError((err as Error).message)
        setSubmitting(false)
      }
    } finally {
      if (coordinator.releaseLease(lease)) onLeaseChanged()
    }
  }

  return (
    <article className="message assistant question-card fade-in" aria-label={t('permission.ariaLabel')}>
      <div className="question-block">
        <div className="question-header">{t('permission.requested', { permission: request.permission })}</div>
        <div className="question-options">
          {request.patterns.map((pattern) => <code key={pattern}>{pattern}</code>)}
        </div>
      </div>
      {error && <p className="question-error">{error}</p>}
      <div className="question-actions">
         <button type="button" className="btn-danger" onClick={() => void reply("reject")} disabled={submitting || coordinator.getActiveLease() !== null}>
          {t('permission.deny')}
        </button>
         <button type="button" className="btn-secondary" onClick={() => void reply("once")} disabled={submitting || coordinator.getActiveLease() !== null}>
          {t('permission.allowOnce')}
        </button>
        {request.always.length > 0 && (
            <button type="button" className="btn-primary" onClick={() => void reply("always")} disabled={submitting || coordinator.getActiveLease() !== null}>
            {t('permission.allowAlways')}
          </button>
        )}
      </div>
    </article>
  )
}

function ToolPartView({
  part,
  directory,
  timestamp,
  t
}: {
  part: MessagePart
  directory: string | undefined
  timestamp?: string
  t: Translator
}) {
  const [open, setOpen] = useState(false)
  const status = part.state?.status || "pending"
  const command = toolCommandLabel(part)
  const { label, diff } = describeToolAction(part, directory, t)
  const tool = (part.tool || "").toLowerCase()
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  const isPreparing = (status === "pending" || status === "running") && Object.keys(input).length === 0
  const displayLabel = isPreparing ? t('action.preparingTool', { tool: part.tool || t('action.actionsFallback') }) : label
  let patch: string | null = null
  if (tool === "edit" && typeof input.oldString === "string" && typeof input.newString === "string") {
    patch = buildSimpleDiff(input.oldString, input.newString)
  } else if (tool === "write" && typeof input.content === "string") {
    patch = buildSimpleDiff("", input.content)
  }
  const todos = tool === "todowrite" ? parseTodos(input.todos) : null
  const questions = tool === "question" ? parseQuestions(input.questions) : null
  return (
    <>
      <button type="button" className={`message-tool-summary message-tool-${status}`} onClick={() => setOpen(true)}>
        <span className="message-tool-label">{displayLabel}</span>
        <span className="message-tool-meta">
          {diff && (diff.additions > 0 || diff.deletions > 0) && (
            <span className="message-tool-diff-stats">
              {diff.additions > 0 && <span className="diff-stat-add">+{diff.additions}</span>}
              {diff.deletions > 0 && <span className="diff-stat-del">-{diff.deletions}</span>}
            </span>
          )}
          {part.state?.exitCode !== undefined && (
            <span className="message-tool-status-exit" title={t('action.exitCode', { n: part.state.exitCode })}>
              {t('action.exitCode', { n: part.state.exitCode })}
            </span>
          )}
          {tool === "shell" && status === "timeout" && (
            <span className="message-tool-status-timeout" title={t('action.shellTimeout')}>
              {t('action.shellTimeout')}
            </span>
          )}
          {tool === "shell" && status === "killed" && (
            <span className="message-tool-status-killed" title={t('action.shellKilled')}>
              {t('action.shellKilled')}
            </span>
          )}
          {status === "error" && (
            <span className="message-tool-status-error" title={t('action.toolFailed')} aria-label={t('action.toolFailed')}>
              ✕
            </span>
          )}
          {(status === "pending" || status === "running") && (
            <span className="message-tool-status-pending" title={t('action.running')} aria-label={t('action.running')}>
              …
            </span>
          )}
        </span>
      </button>

      {open && (
        <Modal title={truncateForTitle(displayLabel)} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          {todos ? (
            <TodoListView items={todos} />
          ) : questions ? (
            <QuestionListView questions={questions} answers={part.state?.metadata?.answers} />
          ) : (
            <>
              <pre className="message-tool-command">{command}</pre>
              {patch ? (
                <DiffLines patch={patch} />
              ) : (
                part.state?.output && <pre className="message-tool-output">{part.state.output}</pre>
              )}
              {part.state?.outputFiles?.map((file) => (
                <FileContentView key={file.uri} uri={file.uri} mime={file.mime} name={file.name} t={t} />
              ))}
            </>
          )}
          {part.state?.error && <pre className="message-tool-output message-tool-error">{part.state.error}</pre>}
        </Modal>
      )}
    </>
  )
}

function ReasoningPartView({ part, timestamp, t }: { part: MessagePart; timestamp?: string; t: Translator }) {
  const [open, setOpen] = useState(false)
  if (!part.text) return null
  const label = reasoningLabel([part], t)
  return (
    <>
      <button type="button" className="message-reasoning-summary" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Modal title={label} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          <pre className="message-reasoning-text">{part.text}</pre>
        </Modal>
      )}
    </>
  )
}

/** A tool-produced file and a standalone `file-content` part share one representation: an image
 *  renders as the attachment card, everything else as a link carrying the file's name (or its uri). */
function FileContentView({ uri, mime, name, t }: { uri: string; mime: string; name?: string; t: Translator }) {
  return (
    <div className="message-content">
      {mime && mime.startsWith("image/") ? (
        <img className="message-attachment" src={uri} alt={name || t('detail.attachedImage')} />
      ) : (
        <a href={uri}>{name || uri}</a>
      )}
    </div>
  )
}

/** `{providerID}/{id} ({variant})` with the provider/variant pieces dropped when the wire did not
 *  carry them, so a bare model id still reads cleanly. */
function modelRefLabel(model: { id: string; providerID?: string; variant?: string } | undefined): string {
  if (!model) return ""
  const base = model.providerID ? `${model.providerID}/${model.id}` : model.id
  return model.variant ? `${base} (${model.variant})` : base
}

/** The localized one-line summary for a `switch` part. The wire's own English text stays out of the
 *  visible label — it is only kept as the row's aria-label fallback for screen readers. */
function switchPartLabel(part: MessagePart, t: Translator): string {
  // Live v2 transcripts carry `previous === value` (e.g. `{"type":"agent-switched","agent":"build",
  // "previous":"build"}`): only render the "a → b" arrow when the previous value actually differs,
  // mirroring the mapper's `switchPartText` instead of showing a self-referential "build → build".
  // For model switches both sides are ref ids, so the equality check lands on `part.value` too.
  const switchedFrom = part.previous !== undefined && part.previous !== part.value ? part.previous : undefined
  if (part.kind === "model") {
    const to = modelRefLabel(part.model) || part.value || ""
    return switchedFrom
      ? t('detail.switchModel', { from: switchedFrom, to })
      : t('detail.switchModelTo', { to })
  }
  const subpath = part.kind === "location" && part.subpath ? ` (${part.subpath})` : ""
  const to = `${part.value || ""}${subpath}`
  if (part.kind === "agent") {
    return switchedFrom
      ? t('detail.switchAgent', { from: switchedFrom, to })
      : t('detail.switchAgentTo', { to })
  }
  return switchedFrom
    ? t('detail.switchLocation', { from: switchedFrom, to })
    : t('detail.switchLocationTo', { to })
}

/** A non-interactive informational row for agent/model/directory switches — looks like the action
 *  summaries but opens nothing and takes no focus. */
function SwitchPartView({ part, t }: { part: MessagePart; t: Translator }) {
  const label = switchPartLabel(part, t)
  return (
    <div className="message-switch-summary" role="note" aria-label={part.text || label}>
      {label}
    </div>
  )
}

/** Unknown future wire message types surface as a labelled summary with the sanitized payload one
 *  click away — never dropped from the transcript, and never rendered inline. */
function FallbackPartView({ part, timestamp, t }: { part: MessagePart; timestamp?: string; t: Translator }) {
  const [open, setOpen] = useState(false)
  const typeName = part.typeName || "unknown"
  return (
    <>
      <button type="button" className="message-fallback-summary" onClick={() => setOpen(true)}>
        {t('detail.fallbackLabel', { typeName })}
      </button>
      {open && (
        <Modal title={t('detail.fallbackTitle')} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          <pre className="message-tool-output">{JSON.stringify(part.raw, null, 2)}</pre>
        </Modal>
      )}
    </>
  )
}

/** A delegated-subagent run rendered as its own structured card in the transcript (issue #10):
 *  agent + description headline, a status pill from the shared run vocabulary, a live elapsed
 *  clock while the run is in flight, the terminal result (collapsible) or a danger-toned error,
 *  and an explicit "open child session" control. The card itself is deliberately NOT a button —
 *  unlike the collapsed tool rows, nothing about the run opens on a whole-card click; navigation
 *  is the small labelled control below. Status/elapsed freshness rides the existing poll and
 *  event cadence; the only timer here is a local one-second clock for the live elapsed label. */
function SubagentRunCard({
  run,
  onOpenChildSession,
  openingChildID,
  t
}: {
  run: SubagentRun
  onOpenChildSession: (childID: string) => void
  openingChildID: string | null
  t: Translator
}) {
  const [expanded, setExpanded] = useState(false)
  const live = isLiveSubagentStatus(run.status) && run.startedAt !== undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const elapsed = run.startedAt !== undefined
    ? t('detail.subagentElapsed', { time: formatRunDuration((run.endedAt ?? now) - run.startedAt) })
    : null
  const headline = run.description ?? run.agent ?? t('detail.subagentTask')
  const longOutput = (run.output?.length ?? 0) > 240
  return (
    <div className={`subagent-run-card subagent-run-${run.status}`}>
      <div className="subagent-run-head">
        {run.agent && <span className="subagent-run-agent">{run.agent}</span>}
        <span className="subagent-run-description">{headline}</span>
        <span className={`subagent-run-status subagent-status-${run.status}`}>{run.status}</span>
      </div>
      {elapsed && (
        <div className="subagent-run-meta">
          <span className="subagent-run-elapsed">{elapsed}</span>
        </div>
      )}
      {run.error && (
        <div className="subagent-run-error">{run.error}</div>
      )}
      {run.output && run.status !== "failed" && (
        <>
          <div className={`subagent-run-result${expanded ? " expanded" : ""}`}>
            <span className="subagent-run-result-caption">{t('detail.subagentResult')}</span>
            <pre className="subagent-run-result-text">{run.output}</pre>
          </div>
          {longOutput && (
            <button type="button" className="subagent-run-result-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? t('detail.showLess') : t('detail.showMore')}
            </button>
          )}
        </>
      )}
      <div className="subagent-run-actions">
        <button
          type="button"
          className="btn-secondary compact subagent-run-open"
          onClick={() => onOpenChildSession(run.childID)}
          disabled={openingChildID === run.childID}
          title={t('detail.openChildSession')}
        >
          {openingChildID === run.childID ? t('detail.openingChildSession') : t('detail.openChildSession')}
        </button>
      </div>
    </div>
  )
}

function MessagePartView({
  part,
  config,
  sessionID,
  directory,
  timestamp,
  t,
  subagentContext,
  onOpenChildSession,
  openingChildID
}: {
  part: MessagePart
  config: ServerConfig
  sessionID: string
  directory?: string
  timestamp?: string
  t: Translator
  /** Transcript-wide subagent correlation (see SubagentContext). Optional so ActionGroupView's
   *  modal reuse stays untouched — subagent run parts escape action groups, so the modal never
   *  actually hosts one. */
  subagentContext?: SubagentContext
  onOpenChildSession?: (childID: string) => void
  openingChildID?: string | null
}) {
  if (part.type === "text") {
    if (!part.text) return null
    return (
      <div className="message-content">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{normalizeMessageMarkdown(part.text)}</ReactMarkdown>
      </div>
    )
  }

  if (part.type === "file") {
    if (!part.url) return null
    return (
      <div className="message-content">
        <img className="message-attachment" src={part.url} alt={part.filename || t('detail.attachedImage')} />
      </div>
    )
  }

  if (part.type === "reasoning") {
    return <ReasoningPartView part={part} timestamp={timestamp} t={t} />
  }

  if (part.type === "tool") {
    // A subagent tool part with a correlated child session renders as its own run card; a
    // completion for the same child (info.subagent, injected by the subagent tool on finish)
    // merges over it so the card goes terminal without waiting for the next poll. Parts without
    // correlation (subagentRunFromTool → null) fall through to the generic tool row exactly as
    // before — the degraded case never invents lifecycle state.
    const subagentRun = subagentRunFromTool(part)
    if (subagentRun) {
      const completion = subagentContext?.completions.get(subagentRun.childID)
      return (
        <SubagentRunCard
          run={mergeSubagentCompletion(subagentRun, completion)}
          onOpenChildSession={onOpenChildSession ?? (() => undefined)}
          openingChildID={openingChildID ?? null}
          t={t}
        />
      )
    }
    return <ToolPartView part={part} directory={directory} timestamp={timestamp} t={t} />
  }

  if (part.type === "patch") {
    if (!part.files || part.files.length === 0 || !part.messageID) return null
    return (
      <PatchPartView
        config={config}
        sessionID={sessionID}
        messageID={part.messageID}
        files={part.files}
        timestamp={timestamp}
        t={t}
      />
    )
  }

  if (part.type === "switch") {
    return <SwitchPartView part={part} t={t} />
  }

  if (part.type === "system") {
    return (
      <div className="message-system-row">
        {part.text && <span className="message-system-text">{part.text}</span>}
        {part.description && <span className="message-system-description">{part.description}</span>}
      </div>
    )
  }

  if (part.type === "skill-activation") {
    return (
      <div className="message-skill-summary">
        <span className="message-skill-name">{t('detail.skillActivated', { name: part.name || part.skillId || "" })}</span>
        {part.text && <span className="message-skill-text">{part.text}</span>}
      </div>
    )
  }

  if (part.type === "file-content") {
    if (!part.uri) return null
    return <FileContentView uri={part.uri} mime={part.mime || ""} name={part.name} t={t} />
  }

  if (part.type === "fallback") {
    return <FallbackPartView part={part} timestamp={timestamp} t={t} />
  }

  return null
}

const ACTION_GROUP_TYPES = new Set(["reasoning", "tool", "patch"])

type TimelineItem = { kind: "action-group"; parts: MessagePart[] } | { kind: "part"; part: MessagePart }

/* --- Delegated-subagent runs (issue #10): transcript cards -------------------
   A `subagent` tool part with a correlated child session id is a parallel piece of work: it gets
   its own run card instead of being collapsed into the "thought for Xs, ran N tools" row. The
   helpers below assemble the run data; the renderers live near MessagePartView. */

/** Whether a run is still in flight. Only these statuses keep the live elapsed clock ticking;
 *  terminal runs (completed/failed/stopped) and idle freeze at their own timestamps. */
function isLiveSubagentStatus(status: AgentRunStatus): boolean {
  return status === "working" || status === "waiting" || status === "retrying"
}

/** Compact "1m 23s" style duration for run cards — plain digits, no locale inflection, matching
 *  the raw timing the transcript already shows for tool durations. */
function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Merge a synthetic terminal completion (`info.subagent`, injected by the opencode `subagent`
 *  tool when its child finishes) over a tool-derived run for the same child session id. The
 *  completion's state is the server's own terminal word and wins; the tool run keeps supplying
 *  the description/output/error/timing the completion signal does not carry. The agent stays the
 *  tool input's stable agent id when the tool run carries one — the completion's `agent` is only
 *  a fallback for a run whose tool part never surfaced an id. */
function mergeSubagentCompletion(run: SubagentRun, completion: SubagentRun | undefined): SubagentRun {
  if (!completion) return run
  const merged: SubagentRun = { ...run, status: completion.status, endedAt: completion.endedAt ?? run.endedAt }
  if (!merged.agent && completion.agent) merged.agent = completion.agent
  return merged
}

/** Every child session id that has a tool-derived run card somewhere in the transcript. A
 *  completion for one of these merges into that card; a completion for anything else renders as
 *  its own compact card, otherwise a delegated task that finished before its tool part reached the
 *  transcript would vanish entirely. */
function collectSubagentToolChildIDs(messages: readonly MessageEnvelope[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      const run = part.type === "tool" ? subagentRunFromTool(part) : null
      if (run) ids.add(run.childID)
    }
  }
  return ids
}

/** Collect the terminal completion signals carried on `info.subagent` across the whole rendered
 *  transcript, keyed by child session id. A later completion for the same child is the later word
 *  and replaces the earlier one. */
function collectSubagentCompletions(messages: readonly MessageEnvelope[]): Map<string, SubagentRun> {
  const completions = new Map<string, SubagentRun>()
  for (const message of messages) {
    const completion = subagentRunFromCompletion(message.info)
    if (!completion) continue
    const run: SubagentRun = { ...completion }
    // Synthetic completions carry ONLY `time.created` on the wire (opencode `message-updater.ts`
    // never sets `time.completed` for them): the completion's creation time IS the terminal time,
    // so the merged card shows the real elapsed instead of freezing at the launch instant.
    run.endedAt = message.info.time.created
    // The headline reads the completion's own parts: the v2 mapper emits a structured `system`
    // part carrying the child's short description on `description` (and the model-facing
    // `<subagent ...>` block on `text`), so plain text extraction alone would come back empty.
    const description = subagentCompletionDescription(message.parts)
    if (!run.description && description) run.description = description
    completions.set(run.childID, run)
  }
  return completions
}

/** Transcript-wide subagent correlation, computed once per rendered-message change and handed down
 *  to the memoized bubble renderers: `completions` lets a working tool card go terminal the moment
 *  the synthetic completion lands (no refetch), and `toolChildIDs` decides whether a completion
 *  still needs its own compact card. */
type SubagentContext = {
  completions: Map<string, SubagentRun>
  toolChildIDs: Set<string>
}

/** Walks a message's parts in order and collapses each run of consecutive thinking/tool-call/edit parts into a
 *  single action-group item, alternating with the output text parts as they actually occurred — so a turn that
 *  thinks, calls a tool, replies, thinks again, calls another tool, and replies again renders as two separate
 *  "thought for Xs, used N tools" rows interleaved with their two outputs, rather than one merged blob. A run of
 *  just one action part skips the group wrapper entirely and renders as that part directly.
 *  Delegated-subagent tool parts escape the collapse entirely: a parallel run has its own lifecycle and its own
 *  card, so burying it in a group summary (whose modal only renders on demand) would hide a live run. Parts that
 *  fail to correlate to a child session (`subagentRunFromTool` → null) stay buffered and render as today's
 *  generic tool row. */
function buildMessageTimeline(parts: MessagePart[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let buffer: MessagePart[] = []
  const flush = () => {
    if (buffer.length === 0) return
    items.push(buffer.length === 1 ? { kind: "part", part: buffer[0] } : { kind: "action-group", parts: buffer })
    buffer = []
  }
  for (const part of parts) {
    if (part.type === "step-start" || part.type === "step-finish") continue
    if (part.type === "text" && !part.text) continue
    if (ACTION_GROUP_TYPES.has(part.type)) {
      if (part.type === "tool" && subagentRunFromTool(part)) {
        flush()
        items.push({ kind: "part", part })
      } else {
        buffer.push(part)
      }
    } else {
      flush()
      items.push({ kind: "part", part })
    }
  }
  flush()
  return items
}

function formatActionDuration(ms: number, t: Translator): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return t('action.durationSeconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  return t('action.durationMinutes', { n: minutes })
}

/** Groups tool calls by what kind of action they represent (reads, searches, commands, ...) so a run of tool
 *  calls summarizes as "read 5 files, searched 1 time" instead of a meaningless "ran 6 tools". */
function summarizeToolCounts(toolParts: MessagePart[], t: Translator): string[] {
  const counts = new Map<string, number>()
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const part of toolParts) {
    const tool = (part.tool || "").toLowerCase()
    switch (tool) {
      case "read":
        bump("read")
        break
      case "write":
        bump("write")
        break
      case "edit":
        bump("edit")
        break
      case "bash":
        bump("bash")
        break
      case "glob":
      case "grep":
        bump("search")
        break
      case "webfetch":
        bump("webfetch")
        break
      case "task":
        bump("task")
        break
      case "skill":
        bump("skill")
        break
      case "todowrite":
        bump("todo")
        break
      case "question":
        bump("question")
        break
      default:
        bump("other")
        break
    }
  }

  const pieces: string[] = []
  const push = (key: string, oneKey: string, manyKey: string) => {
    const count = counts.get(key)
    if (count) pieces.push(count === 1 ? t(oneKey) : t(manyKey, { n: count }))
  }
  push("read", "action.countReadOne", "action.countReadMany")
  push("write", "action.countWriteOne", "action.countWriteMany")
  push("edit", "action.countEditOne", "action.countEditMany")
  push("search", "action.countSearchOne", "action.countSearchMany")
  push("bash", "action.countBashOne", "action.countBashMany")
  push("webfetch", "action.countWebfetchOne", "action.countWebfetchMany")
  push("task", "action.countTaskOne", "action.countTaskMany")
  push("skill", "action.countSkillOne", "action.countSkillMany")
  push("todo", "action.countTodoOne", "action.countTodoMany")
  push("question", "action.countQuestionOne", "action.countQuestionMany")
  push("other", "action.countOtherOne", "action.countOtherMany")
  return pieces
}

/** "Thought for Xs"/"Thought for Xm" when the reasoning part(s) carry timing, else a plain "Thinking". */
function reasoningLabel(reasoningParts: MessagePart[], t: Translator): string {
  let minStart: number | undefined
  let maxEnd: number | undefined
  for (const part of reasoningParts) {
    const time = part.time
    if (!time) continue
    if (minStart === undefined || time.start < minStart) minStart = time.start
    const end = time.end ?? Date.now()
    if (maxEnd === undefined || end > maxEnd) maxEnd = end
  }
  return minStart !== undefined && maxEnd !== undefined
    ? t('action.thoughtFor', { duration: formatActionDuration(maxEnd - minStart, t) })
    : t('action.thinking')
}

function summarizeActionGroup(parts: MessagePart[], t: Translator): string {
  const reasoningParts = parts.filter((part) => part.type === "reasoning")
  const toolParts = parts.filter((part) => part.type === "tool")
  const editCount = parts
    .filter((part) => part.type === "patch")
    .reduce((sum, part) => sum + (part.files?.length ?? 0), 0)

  const pieces: string[] = []
  if (reasoningParts.length > 0) pieces.push(reasoningLabel(reasoningParts, t))
  pieces.push(...summarizeToolCounts(toolParts, t))
  if (editCount > 0) pieces.push(editCount === 1 ? t('action.madeEditOne') : t('action.madeEditMany', { n: editCount }))
  if (pieces.length === 0) pieces.push(t('action.actionsFallback'))
  return capitalizeFirst(pieces.join(", "))
}

function ActionGroupView({
  parts,
  config,
  sessionID,
  directory,
  timestamp,
  t
}: {
  parts: MessagePart[]
  config: ServerConfig
  sessionID: string
  directory?: string
  timestamp?: string
  t: Translator
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="message-action-summary" onClick={() => setOpen(true)}>
        <span>{summarizeActionGroup(parts, t)}</span>
      </button>

      {open && (
        <Modal title={summarizeActionGroup(parts, t)} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          <div className="message-action-details">
            {parts.map((part, index) => (
              <Fragment key={part.id}>
                {index > 0 && <hr className="message-action-divider" />}
                <MessagePartView part={part} config={config} sessionID={sessionID} directory={directory} timestamp={timestamp} t={t} />
              </Fragment>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

function toFileStatusList(input: FileStatusEntry[] | Record<string, FileStatusEntry>): FileStatusEntry[] {
  if (Array.isArray(input)) return input
  return Object.entries(input).map(([path, value]) => ({ path, ...value }))
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function summarizeJson(value: unknown): string {
  if (value === null || value === undefined) return "-"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function configKey(config: ServerConfig): string {
  return JSON.stringify({
    backend: config.backend,
    host: config.host.trim(),
    port: config.port,
    username: config.username.trim(),
    password: config.password
  })
}

function canTestConfig(config: ServerConfig): boolean {
  return Boolean(config.username.trim()) && isValidServerConfig(config)
}

function modelKey(model: ModelSelection): string {
  return [model.providerID, model.modelID, model.variant ?? ""].map(encodeURIComponent).join("|")
}

function modelFromKey(value: string | null): ModelSelection | null {
  if (!value) return null
  const [providerID, modelID, variant] = value.split("|").map((part) => decodeURIComponent(part))
  if (!providerID || !modelID) return null
  return { providerID, modelID, variant: variant || undefined }
}

function modelStorageScope(backend: ServerConfig["backend"], sessionID?: string): string {
  return `${backend}:${sessionID ?? "new"}`
}

function readStoredModel(backend: ServerConfig["backend"], sessionID?: string): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) ?? "{}") as Record<string, unknown>
    const value = stored[modelStorageScope(backend, sessionID)]
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

function writeStoredModel(backend: ServerConfig["backend"], sessionID: string | undefined, value: string): void {
  let stored: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) ?? "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch {
    // Replace the legacy global string with scoped selections.
  }
  stored[modelStorageScope(backend, sessionID)] = value
  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(stored))
}

function sameModel(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  return Boolean(a && b && a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? "") === (b.variant ?? ""))
}

function modelSearchText(option: ModelOption): string {
  return [option.modelName, option.modelID, option.providerName, option.providerID, option.variant ?? ""].join(" ").toLowerCase()
}

function agentLabel(agent: AgentOption): string {
  return agent.name || agent.id
}

function normalizeDirectory(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isProjectDirectory(pathInfo: PathInfo): boolean {
  return pathInfo.worktree !== "/"
}

function messageActivityTime(message: MessageEnvelope): number {
  return Math.max(message.info.time.created, message.info.time.completed ?? 0)
}

function toSessionView(session: Session, status?: SessionStatus, activityTime = session.time.updated): SessionView {
  const view: SessionView = {
    id: session.id,
    title: session.title,
    directory: session.directory,
    updated: activityTime,
    status: status?.type ?? "idle",
    files: session.summary?.files ?? 0,
    additions: session.summary?.additions ?? 0,
    deletions: session.summary?.deletions ?? 0,
    model: session.model ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant } : undefined,
    revertMessageID: session.revert?.messageID,
    external: session.external
  }
  // The v2 mapper attaches `parentID` non-enumerably (it must never leak into wire payloads or
  // equality comparisons), so a plain field copy would silently drop it — the session list badge
  // for child sessions reads it from the view, so surface it the same non-enumerable way.
  if (session.parentID) Object.defineProperty(view, "parentID", { value: session.parentID, enumerable: false })
  return view
}

/** Shallow-copy a session view with the non-enumerable `parentID` preserved. `toSessionView` is
 *  the single definition point for that property, and it attaches it via Object.defineProperty —
 *  a plain `{...item}` spread drops it, which would make a child session's badge vanish until
 *  the next poll. */
function copySessionView(view: SessionView, patch: Partial<SessionView>): SessionView {
  const copied = { ...view, ...patch }
  const parentID = (view as SessionView & { parentID?: string }).parentID
  if (parentID) Object.defineProperty(copied, "parentID", { value: parentID, enumerable: false })
  return copied
}

function formatLimit(value?: number): string {
  if (!value) return "-"
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function createOptimisticUserMessage(sessionID: string, text: string, delivery?: "queue" | "steer", durableID?: string): MessageEnvelope {
  const now = Date.now()
  return {
    info: {
      id: `optimistic-${now}`,
      role: "user",
      sessionID,
        time: { created: now },
        delivery,
        // The server-confirmed durable message id, once the admission response returns it. Rows
        // without one (still awaiting the response, or a response that was lost) retire by text.
        durableID
    },
    parts: [
      {
        id: `optimistic-part-${now}`,
        type: "text",
        text
      }
    ]
  }
}

/** Build transcript rows for inbox entries the server still holds as queued user input. The message
 *  list drops undelivered items, so without these rows a queued prompt would silently disappear
 *  after any reconciliation (app restart, poll, session reopen) even though the server still holds
 *  it durably. Rows use the server's own message id so they stay stable across polls and disappear
 *  the moment the item is delivered (it leaves the inbox and enters history). */
function queuedInboxMessageEnvelopes(sessionID: string, inbox: V2InboxItem[], inHistoryIDs: Set<string>): MessageEnvelope[] {
  const rows: MessageEnvelope[] = []
  for (const item of inbox) {
    if (item.type !== "user" || item.delivery !== "queue" || inHistoryIDs.has(item.id)) continue
    const text = typeof item.payload?.text === "string" ? item.payload.text : ""
    rows.push({
      info: {
        id: item.id,
        role: "user",
        sessionID,
        time: { created: item.timeCreated },
        delivery: "queue",
        type: "user"
      },
      parts: text ? [{ id: `${item.id}:text`, type: "text", text }] : []
    })
  }
  return rows
}

/** The server-side inbox/message id for a queued row, when one exists and can be cancelled:
 *  inbox-derived rows carry it as their own id, and optimistic rows carry it as the durable
 *  admission id once the server confirmed the admission. An optimistic row still awaiting its
 *  admission response has no server id yet — there is nothing on the server to cancel, so it is
 *  not cancelable (its send is still being confirmed). */
function queuedInboxItemID(message: MessageEnvelope): string | null {
  if (message.info.delivery !== "queue") return null
  if (message.info.durableID) return message.info.durableID
  return message.info.id.startsWith("optimistic-") ? null : message.info.id
}

function createLocalAssistantMessage(sessionID: string, text: string): MessageEnvelope {
  const now = Date.now()
  return {
    info: {
      id: `local-assistant-${now}`,
      role: "assistant",
      sessionID,
      time: { created: now, completed: now }
    },
    parts: [
      {
        id: `local-assistant-part-${now}`,
        type: "text",
        text
      }
    ]
  }
}

/** Streamed text should only ever grow — if an incoming snapshot is shorter than what's already shown, a
 *  reset/truncated event landed; keep the longer text instead of visibly erasing it. Applied per part rather
 *  than by rejecting the whole snapshot, so a lean refetch can still deliver the messages that came with it. */
function reconcileStreamedPart(previous: MessagePart | undefined, incoming: MessagePart): MessagePart {
  if (!previous || previous.type !== incoming.type) return incoming
  if (incoming.type !== "reasoning" && incoming.type !== "text") return incoming
  const previousText = previous.text ?? ""
  const incomingText = incoming.text ?? ""
  return incomingText.length >= previousText.length ? incoming : { ...incoming, text: previousText }
}

/** GET /session/{id}/message doesn't return reasoning parts, only the live event stream does — keep any streamed-in reasoning the refetch would otherwise silently drop. */
function partsEqual(a: MessagePart[], b: MessagePart[]): boolean {
  return a === b || (a.length === b.length && JSON.stringify(a) === JSON.stringify(b))
}

/** Reuses the previous message object whenever the merged result is logically unchanged, instead of always
 *  returning a fresh `{ ...message }` wrapper. The periodic 3.5s poll calls this for every message in the
 *  conversation regardless of whether anything actually changed, and a fresh reference per message would defeat
 *  the WeakMap/memo caching that keeps unrelated messages from re-rendering while one is actively streaming. */
function mergeFetchedMessages(current: MessageEnvelope[], fetched: MessageEnvelope[]): MessageEnvelope[] {
  const currentByID = new Map(current.map((message) => [message.info.id, message]))
  return fetched.map((message) => {
    const previous = currentByID.get(message.info.id)
    if (!previous) return message
    const previousPartsByID = new Map(previous.parts.map((part) => [part.id, part]))
    const parts = message.parts.map((part) => reconcileStreamedPart(previousPartsByID.get(part.id), part))
    const fetchedPartIDs = new Set(message.parts.map((part) => part.id))
    const missingReasoning = previous.parts.filter((part) => part.type === "reasoning" && !fetchedPartIDs.has(part.id))
    const mergedParts = missingReasoning.length === 0 ? parts : [...missingReasoning, ...parts]
    const metadataChanged = previous.info.type !== message.info.type
      || previous.info.compactionStatus !== message.info.compactionStatus
      || previous.info.time.completed !== message.info.time.completed
      || previous.info.delivery !== message.info.delivery
      || !sameEnvelopeMetadata(previous.info, message.info)
    return !metadataChanged && partsEqual(previous.parts, mergedParts) ? previous : { ...message, parts: mergedParts }
  })
}

function applyStreamedPartUpdate(messages: MessageEnvelope[], sessionID: string, part: MessagePart): MessageEnvelope[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.info.sessionID !== sessionID || message.info.id !== part.messageID) return message
    changed = true
    const exists = message.parts.some((existing) => existing.id === part.id)
    const parts = exists
      ? message.parts.map((existing) => (existing.id === part.id ? reconcileStreamedPart(existing, part) : existing))
      : [...message.parts, part]
    return { ...message, parts }
  })
  return changed ? next : messages
}

function applyStreamedPartDelta(
  messages: MessageEnvelope[],
  sessionID: string,
  messageID: string,
  partID: string,
  field: string,
  delta: string
): MessageEnvelope[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.info.sessionID !== sessionID || message.info.id !== messageID) return message
    const parts = message.parts.map((existing) => {
      if (existing.id !== partID) return existing
      changed = true
      const current = (existing as Record<string, unknown>)[field]
      const nextValue = (typeof current === "string" ? current : "") + delta
      return { ...existing, [field]: nextValue }
    })
    return changed ? { ...message, parts } : message
  })
  return changed ? next : messages
}

/** Whether a fetched transcript or inbox row proves an optimistic bubble is now server-admitted.
 *  Rows tagged with the admission response's durable message id retire by that EXACT id — the same
 *  id the message carries in history (and in the inbox while it is still queued) — which is immune
 *  to identical text sent twice. Rows still awaiting their admission response (or whose response was
 *  lost) fall back to matching the same user text, guarded so only messages created after this row
 *  was sent can retire it, never a pre-existing identical message. */
function hasMatchingUserMessage(messages: MessageEnvelope[], optimistic: MessageEnvelope): boolean {
  if (optimistic.info.durableID) {
    return messages.some((message) => message.info.id === optimistic.info.durableID)
  }
  const text = extractText(optimistic)
  return messages.some((message) => (
    message.info.sessionID === optimistic.info.sessionID &&
    message.info.role === "user" &&
    extractText(message) === text &&
    message.info.time.created >= optimistic.info.time.created
  ))
}

/** M8: transcript-dependent availability must count every visible user row — fetched history,
 *  optimistic bubbles, and server-admitted queued inbox rows. A just-sent or queued prompt
 *  keeps Compact/Fork reachable instead of flashing them disabled until the next refresh. */
function hasAnyUserMessage(
  messages: MessageEnvelope[],
  optimisticUserMessages: MessageEnvelope[],
  queuedInboxMessages: MessageEnvelope[]
): boolean {
  return [...messages, ...optimisticUserMessages, ...queuedInboxMessages].some((message) => message.info.role === "user")
}

type RenderGroup =
  | { kind: "message"; message: MessageEnvelope & { text: string } }
  | {
      kind: "run"
      key: string
      items: TimelineItem[]
      messagesByID: Map<string, MessageEnvelope & { text: string }>
      sessionID: string
    }

/** Groups consecutive non-user messages into a single "run" and builds one continuous timeline across all of
 *  their parts (via buildMessageTimeline), instead of computing each message's timeline in isolation. This is
 *  what lets a trailing action-group in one message merge with a leading action-group in the next — a run of
 *  thought/tool-call parts with no real text between them collapses into one summary row regardless of which
 *  message boundary it happened to be split across. User messages always start a fresh group. */
function groupRenderedMessages(messages: (MessageEnvelope & { text: string })[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let buffer: (MessageEnvelope & { text: string })[] = []
  const flush = () => {
    if (buffer.length === 0) return
    // A run exists to merge action groups that a message boundary split apart. With nothing
    // groupable there is nothing to merge, and folding the messages together would glue two
    // separate replies into one bubble — which is what an OMP session looks like while a queued
    // prompt is running, since it produces text parts only.
    if (!buffer.some((message) => message.parts.some((part) => ACTION_GROUP_TYPES.has(part.type)))) {
      for (const message of buffer) groups.push({ kind: "message", message })
    } else {
      const items = buildMessageTimeline(buffer.flatMap((message) => message.parts))
      const messagesByID = new Map(buffer.map((message) => [message.info.id, message]))
      groups.push({
        kind: "run",
        key: `run-${buffer[0].info.id}`,
        items,
        messagesByID,
        sessionID: buffer[buffer.length - 1].info.sessionID
      })
    }
    buffer = []
  }
  for (const message of messages) {
    if (message.info.role === "user") {
      flush()
      groups.push({ kind: "message", message })
    } else {
      buffer.push(message)
    }
  }
  flush()
  return groups
}

type MessageMenuAction = {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Tooltip text for a disabled item, so users understand why the action is unavailable
   *  instead of staring at an unexplained greyed-out row. Never announced separately. */
  disabledReason?: string
}

/** A ⋯ control in the conversation header exposing session-level actions from the connected
 *  harness/extension (currently Undo/Redo). The message context menu only reaches those actions
 *  when a bubble exists to host it — an Undo that empties the transcript leaves Redo enabled but
 *  unreachable, so the header menu is the interaction surface that never depends on transcript
 *  contents. Availability still comes from the harness via the caller. */
function SessionActionsMenu({
  actions,
  t,
  pendingAction = null
}: {
  actions: MessageMenuAction[]
  t: Translator
  pendingAction?: "compact" | "fork" | null
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const dismissOnResize = () => setOpen(false)
    window.addEventListener("pointerdown", dismiss)
    window.addEventListener("keydown", dismissOnEscape)
    window.addEventListener("resize", dismissOnResize)
    return () => {
      window.removeEventListener("pointerdown", dismiss)
      window.removeEventListener("keydown", dismissOnEscape)
      window.removeEventListener("resize", dismissOnResize)
    }
  }, [open])

  return (
    <div className="session-actions" ref={menuRef}>
      <button
        type="button"
        className="btn-icon session-actions-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('detail.sessionActions')}
        title={t('detail.sessionActions')}
      >
        <MoreVerticalIcon size={20} />
      </button>
      {open && (
        <div className="session-actions-menu" role="menu">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.disabled ? action.disabledReason : undefined}
              onClick={() => {
                if (action.disabled) return
                setOpen(false)
                action.onSelect()
              }}
            >
              {pendingAction === "compact" && action.id === "compact" ? t('detail.compacting')
                : pendingAction === "fork" && action.id === "fork" ? t('detail.forking')
                  : action.label}
            </button>
          ))}
        </div>
      )}
      {pendingAction && <span className="session-action-pending" role="status" aria-live="polite">
        {pendingAction === "compact" ? t('detail.compacting') : t('detail.forking')}
      </span>}
    </div>
  )
}

/** Wraps a bubble in the copy menu. Takes the text to copy rather than a message, because what a
 *  bubble shows is not always one message's text: a run merges several, and some carry none at all. */
function MessageContextMenu({
  text,
  className,
  t,
  actions = [],
  children
}: {
  text: string
  className: string
  t: Translator
  actions?: MessageMenuAction[]
  children: ReactNode
}) {
  const [position, setPosition] = useState<{ x: number, y: number, touch: boolean } | null>(null)
  const longPressTimer = useRef<number | undefined>(undefined)
  const touchStart = useRef<{ x: number, y: number } | null>(null)
  const cancelLongPress = () => {
    if (longPressTimer.current !== undefined) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = undefined
    touchStart.current = null
  }
  const open = (x: number, y: number, touch = false) => {
    cancelLongPress()
    const itemCount = actions.length + (text ? 2 : 0)
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - 220)),
      y: Math.max(8, Math.min(y, window.innerHeight - (40 * itemCount + 8))),
      touch
    })
  }
  const copy = (markdown: boolean) => {
    void copyToClipboard(markdown ? normalizeMessageMarkdown(text) : stripMarkdownDirectives(text))
    setPosition(null)
  }
  // Everything that means "not this" has to put the menu away: a press anywhere else, Escape, the
  // transcript scrolling out from under a fixed menu, a resize moving the coordinates it was pinned
  // to. Each bubble owns its own menu state, so without this a second right-click adds a second menu
  // instead of moving the first, and neither ever leaves until an item is chosen.
  useEffect(() => {
    if (!position) return
    const dismiss = () => setPosition(null)
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss()
    }
    window.addEventListener("pointerdown", dismiss)
    window.addEventListener("keydown", dismissOnEscape)
    window.addEventListener("resize", dismiss)
    // The transcript scrolls inside its own pane, and a scroll there never reaches window by itself.
    window.addEventListener("scroll", dismiss, true)
    return () => {
      window.removeEventListener("pointerdown", dismiss)
      window.removeEventListener("keydown", dismissOnEscape)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("scroll", dismiss, true)
    }
  }, [position])
  // A bubble made only of tool calls and thinking has no message text to hand over. Offering the menu
  // anyway gave two items that could do nothing, and taking over the context menu to show them also
  // took away the browser's own — with its Copy, the one thing that would have worked on a selection
  // the user made by hand. With nothing to copy, the bubble stays out of the way.
  if (!text && actions.length === 0) return <article className={className}>{children}</article>
  return (
    <article
      className={className}
      onContextMenu={(event) => {
        event.preventDefault()
        open(event.clientX, event.clientY, window.matchMedia("(pointer: coarse)").matches)
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return
        const { clientX, clientY } = event
        touchStart.current = { x: clientX, y: clientY }
        longPressTimer.current = window.setTimeout(() => open(clientX, clientY, true), 500)
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch" || !touchStart.current) return
        const movedX = event.clientX - touchStart.current.x
        const movedY = event.clientY - touchStart.current.y
        if (Math.hypot(movedX, movedY) > 10) cancelLongPress()
      }}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
    >
      {children}
      {position && (
        // Pressing an item must not read as pressing "anywhere else": the dismissal above would
        // unmount the menu on pointerdown and the click would never reach the button.
        <div
          className={`message-context-menu${position.touch ? " message-context-menu--touch" : ""}`}
          role="menu"
          style={position.touch ? undefined : { left: position.x, top: position.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {text && <button type="button" role="menuitem" onClick={() => copy(false)}>{t('detail.copyText')}</button>}
          {text && <button type="button" role="menuitem" onClick={() => copy(true)}>{t('detail.copyMarkdown')}</button>}
          {text && actions.length > 0 && <div className="message-context-menu__separator" role="separator" />}
            {actions.map((action) => (
             <button key={action.id} type="button" role="menuitem" disabled={action.disabled} title={action.disabled ? action.disabledReason : undefined} onClick={() => {
               if (action.disabled) return
               setPosition(null)
               action.onSelect()
            }}>{action.label}</button>
          ))}
        </div>
      )}
    </article>
  )
}

/** Renders one run's continuous timeline (see groupRenderedMessages) as a single message bubble, resolving
 *  each item's timestamp to the specific message that produced it. */
function ConversationRunView({
  items,
  messagesByID,
  sessionID,
  config,
  directory,
  actions,
  onRevertMessage,
  revertDisabled,
  t,
  subagentContext,
  onOpenChildSession,
  openingChildID
}: {
  items: TimelineItem[]
  messagesByID: Map<string, MessageEnvelope & { text: string }>
  sessionID: string
  config: ServerConfig
  directory: string | undefined
  actions: MessageMenuAction[]
  onRevertMessage: (messageID: string) => void
  revertDisabled: boolean
  t: Translator
  subagentContext: SubagentContext
  onOpenChildSession: (childID: string) => void
  openingChildID: string | null
}) {
  const fallback = [...messagesByID.values()].pop()
  const timestampFor = (part: MessagePart) => {
    const owner = (part.messageID && messagesByID.get(part.messageID)) || fallback
    return owner ? formatTime(owner.info.time.created) : undefined
  }
  // The run bubble merges several messages, and a synthetic subagent completion is its own message
  // inside the run — a completion whose tool card is absent must surface as a compact card here,
  // exactly as MessageArticle renders it for a standalone message.
  const orphanCompletions: SubagentRun[] = []
  const seen = new Set<string>()
  for (const message of messagesByID.values()) {
    const subagent = message.info.subagent
    if (!subagent || seen.has(subagent.childID) || subagentContext.toolChildIDs.has(subagent.childID)) continue
    const run = subagentContext.completions.get(subagent.childID)
    if (run) {
      seen.add(subagent.childID)
      orphanCompletions.push(run)
    }
  }
  // The bubble shows the whole run, so copying it means copying every message in it. Handing over the
  // last one copied a fraction of what is on screen, and nothing at all whenever the run happened to
  // end on a tool call — which is most of the time.
  const runText = [...messagesByID.values()].map((message) => message.text).filter(Boolean).join("\n\n")
  return (
    <MessageContextMenu
      text={runText}
      className="message assistant fade-in"
      t={t}
       actions={fallback ? [...actions, ...(config.backend === "opencode" || config.backend === "opencode2" ? [{ id: "revert", label: t('detail.revertToMessage'), disabled: revertDisabled, disabledReason: revertDisabled ? t('detail.actionLocked') : undefined, onSelect: () => onRevertMessage(fallback.info.id) }] : [])] : actions}
    >
      {items.map((item) =>
        item.kind === "action-group" ? (
          <ActionGroupView
            key={`group-${item.parts[0].id}`}
            parts={item.parts}
            config={config}
            sessionID={sessionID}
            directory={directory}
            timestamp={timestampFor(item.parts[item.parts.length - 1])}
            t={t}
          />
        ) : (
          <MessagePartView
            key={item.part.id}
            part={item.part}
            config={config}
            sessionID={sessionID}
            directory={directory}
            timestamp={timestampFor(item.part)}
            t={t}
            subagentContext={subagentContext}
            onOpenChildSession={onOpenChildSession}
            openingChildID={openingChildID}
          />
        )
      )}
      {orphanCompletions.map((run) => (
        <SubagentRunCard
          key={run.childID}
          run={run}
          onOpenChildSession={onOpenChildSession}
          openingChildID={openingChildID}
          t={t}
        />
      ))}
    </MessageContextMenu>
  )
}

/** One message's parts. Memoized on the message object identity so that streaming a token into one message
 *  (which necessarily re-renders MessagesPane) doesn't re-run timeline/diff formatting for every other message
 *  in the conversation — toRenderedMessage keeps unrelated messages referentially stable across updates. */
const MessageArticle = memo(function MessageArticle({
  message,
  config,
  directory,
  actions,
  onRevertMessage,
  revertDisabled,
  t,
  onCancelQueuedMessage,
  cancellingInboxIDs,
  subagentContext,
  onOpenChildSession,
  openingChildID
}: {
  message: MessageEnvelope & { text: string }
  config: ServerConfig
  directory: string | undefined
  actions: MessageMenuAction[]
  onRevertMessage: (messageID: string) => void
  revertDisabled: boolean
  t: Translator
  onCancelQueuedMessage: (message: MessageEnvelope) => void
  cancellingInboxIDs: ReadonlySet<string>
  subagentContext: SubagentContext
  onOpenChildSession: (childID: string) => void
  openingChildID: string | null
}) {
  const cancelableInboxID = message.info.delivery === "queue" ? queuedInboxItemID(message) : null
  // A terminal completion whose tool part never reached the transcript (its child session id has
  // no run card anywhere) must still surface as its own compact card — the synthetic completion
  // is the only trace of the delegated task. When the card DOES exist, the completion merges into
  // it at the part renderer and nothing extra is drawn here.
  const orphanCompletion = message.info.subagent && !subagentContext.toolChildIDs.has(message.info.subagent.childID)
    ? subagentContext.completions.get(message.info.subagent.childID) ?? null
    : null
  return (
    <MessageContextMenu
      text={message.text}
      className={`message ${message.info.role} fade-in`}
      t={t}
      actions={[...actions, ...(config.backend === "opencode" || config.backend === "opencode2" ? [{ id: "revert", label: t('detail.revertToMessage'), disabled: revertDisabled, disabledReason: revertDisabled ? t('detail.actionLocked') : undefined, onSelect: () => onRevertMessage(message.info.id) }] : [])]}
    >
      {buildMessageTimeline(message.parts).map((item) =>
        item.kind === "action-group" ? (
          <ActionGroupView
            key={`group-${item.parts[0].id}`}
            parts={item.parts}
            config={config}
            sessionID={message.info.sessionID}
            directory={directory}
            timestamp={formatTime(message.info.time.created)}
            t={t}
          />
        ) : (
          <MessagePartView
            key={item.part.id}
            part={item.part}
            config={config}
            sessionID={message.info.sessionID}
            directory={directory}
            timestamp={formatTime(message.info.time.created)}
            t={t}
            subagentContext={subagentContext}
            onOpenChildSession={onOpenChildSession}
            openingChildID={openingChildID}
          />
        )
      )}
      {orphanCompletion && (
        <SubagentRunCard
          run={orphanCompletion}
          onOpenChildSession={onOpenChildSession}
          openingChildID={openingChildID}
          t={t}
        />
      )}
      {(message.info.error || message.info.finish === "error") && (
        <div className="message-error-row">
          {message.info.error
            ? t('detail.assistantError', { message: message.info.error.message || message.info.finish || "" })
            : t('detail.assistantInterrupted')}
        </div>
      )}
      {message.info.delivery === "queue" && (
        <div className="message-delivery-notice">
          <span>{t('detail.queuedPrompt')}</span>
          {cancelableInboxID && (
            <button
              type="button"
              className="message-cancel-queued"
              onClick={() => onCancelQueuedMessage(message)}
              disabled={cancellingInboxIDs.has(cancelableInboxID)}
              title={t('detail.cancelQueuedPrompt')}
            >
              {t('detail.cancelQueuedPrompt')}
            </button>
          )}
        </div>
      )}
    </MessageContextMenu>
  )
})

/** Renders the message list, pending questions, and typing bubble. Memoized so that unrelated state changes in
 *  the parent (most importantly typing into the composer) don't re-run the per-message formatting/diffing work
 *  on every keystroke. */
const MessagesPane = memo(function MessagesPane({
  loadingSessionID,
  loadedSessionID,
  loadFailure,
  onRetrySession,
  selectedID,
  renderedMessages,
  timelineGroups,
  showTypingBubble,
  pendingQuestions,
  pendingPermissions,
  config,
  directory,
  actions,
  onRevertMessage,
  revertDisabled,
  t,
  messagesRef,
  messagesEndRef,
  onMessagesScroll,
  onQuestionResolved,
  onPermissionResolved,
  coordinator,
  onLeaseChanged,
  jumpAffordances,
  onJumpToTop,
  onJumpToBottom,
  onCancelQueuedMessage,
  cancellingInboxIDs,
  subagentContext,
  onOpenChildSession,
  openingChildID
}: {
  loadingSessionID: string | null
  loadedSessionID: string | null
  loadFailure: { sessionID: string; message: string } | null
  onRetrySession: () => void
  selectedID: string | null
  renderedMessages: (MessageEnvelope & { text: string })[]
  timelineGroups: RenderGroup[]
  showTypingBubble: boolean
  pendingQuestions: QuestionRequest[]
  pendingPermissions: PermissionRequest[]
  config: ServerConfig
  directory: string | undefined
  actions: MessageMenuAction[]
  onRevertMessage: (messageID: string) => void
  revertDisabled: boolean
  t: Translator
  messagesRef: RefObject<HTMLDivElement>
  messagesEndRef: RefObject<HTMLDivElement>
  onMessagesScroll: () => void
  onQuestionResolved: (id: string) => void
  onPermissionResolved: (id: string) => void
  coordinator: SessionMutationCoordinator
  onLeaseChanged: () => void
  jumpAffordances: { top: boolean; bottom: boolean }
  onJumpToTop: () => void
  onJumpToBottom: () => void
  onCancelQueuedMessage: (message: MessageEnvelope) => void
  cancellingInboxIDs: ReadonlySet<string>
  subagentContext: SubagentContext
  onOpenChildSession: (childID: string) => void
  openingChildID: string | null
}) {
  return (
    <div className="messages-wrap">
      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {/* Nothing selected is its own state, not a load in progress. Both of the tests below compare
            against selectedID, so a null one used to satisfy them and left the desktop layout — which
            renders this pane with no session, unlike mobile — spinning "loading" forever. */}
        {selectedID === null ? (
          <div className="empty-state compact">
            <ChatIcon size={40} className="icon-empty-state" />
            <p>{t('detail.selectSession')}</p>
          </div>
        ) : loadFailure?.sessionID === selectedID && loadingSessionID !== selectedID ? (
          /* A history load that failed leaves loadedSessionID unset, which the spinner test below
             cannot tell apart from one still in flight — so without this the pane spun forever on
             a session the harness refused to open, and the reason only ever reached the toast. */
          <div className="empty-state compact">
            <p>{t('detail.loadFailed')}</p>
            <p className="subtle">{loadFailure.message}</p>
            <button type="button" className="secondary" onClick={onRetrySession}>{t('sessions.retry')}</button>
          </div>
        ) : loadingSessionID === selectedID || loadedSessionID !== selectedID ? (
          <div className="empty-state compact">
            <LoadingIcon size={32} />
            <p>{t('detail.loading')}</p>
          </div>
        ) : renderedMessages.length === 0 && !showTypingBubble && pendingQuestions.length === 0 && pendingPermissions.length === 0 ? (
          <div className="empty-state compact">
            <ChatIcon size={40} className="icon-empty-state" />
            <p>{t('detail.emptyTitle')}</p>
            <p className="subtle">{t('detail.emptyHint')}</p>
          </div>
        ) : (
          <>
            {timelineGroups.map((group) =>
              group.kind === "message" ? (
                <MessageArticle key={group.message.info.id} message={group.message} config={config} directory={directory} actions={actions} onRevertMessage={onRevertMessage} revertDisabled={revertDisabled} t={t} onCancelQueuedMessage={onCancelQueuedMessage} cancellingInboxIDs={cancellingInboxIDs} subagentContext={subagentContext} onOpenChildSession={onOpenChildSession} openingChildID={openingChildID} />
              ) : (
                <ConversationRunView
                  key={group.key}
                  items={group.items}
                  messagesByID={group.messagesByID}
                  sessionID={group.sessionID}
                  config={config}
                  directory={directory}
                  actions={actions}
                  onRevertMessage={onRevertMessage}
                  revertDisabled={revertDisabled}
                  t={t}
                  subagentContext={subagentContext}
                  onOpenChildSession={onOpenChildSession}
                  openingChildID={openingChildID}
                />
              )
            )}
            {directory !== undefined &&
              pendingQuestions.map((request) => (
                <QuestionCard
                  key={request.id}
                  config={config}
                  directory={directory}
                  request={request}
                   onResolved={onQuestionResolved}
                   t={t}
                    coordinator={coordinator}
                    onLeaseChanged={onLeaseChanged}
                />
              ))}
            {directory !== undefined &&
              pendingPermissions.map((request) => (
                <PermissionCard
                  key={request.id}
                  config={config}
                  directory={directory}
                  request={request}
                   onResolved={onPermissionResolved}
                   t={t}
                    coordinator={coordinator}
                    onLeaseChanged={onLeaseChanged}
                />
              ))}
            {showTypingBubble && (
              <article className="message assistant typing-bubble fade-in" aria-label={t('detail.waiting')}>
                <div className="typing-dots" aria-hidden="true">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              </article>
            )}
            <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
          </>
        )}
      </div>
      <JumpControls affordances={jumpAffordances} onJumpToTop={onJumpToTop} onJumpToBottom={onJumpToBottom} t={t} />
    </div>
  )
})

function App() {
  type NoticeType = "info" | "success" | "error"
  type ThemePreference = "system" | "light" | "dark"
  const initialProfiles = useMemo(loadServerProfiles, [])
  const initialProfile = useMemo(() => loadActiveServerProfile(initialProfiles), [initialProfiles])
  const [profiles, setProfiles] = useState<SavedServerProfile[]>(initialProfiles)
  const [activeProfileID, setActiveProfileID] = useState(initialProfile.id)
  const [config, setConfig] = useState<ServerConfig>(initialProfile.config)
  const [draftProfileName, setDraftProfileName] = useState(initialProfile.name)
  const [profileToDelete, setProfileToDelete] = useState<SavedServerProfile | null>(null)
  const [desktopProfileRevision, setDesktopProfileRevision] = useState(0)
  const [desktopProfileSyncError, setDesktopProfileSyncError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    syncDesktopProfiles(profiles).then((result) => {
      if (!active) return
      setDesktopProfileRevision(result.revision)
      setDesktopProfileSyncError(null)
    }).catch((error: unknown) => {
      if (active) setDesktopProfileSyncError(error instanceof Error ? error.message : "Desktop profile synchronization failed")
    })
    return () => {
      active = false
    }
  }, [profiles])
  const [language, setLanguage] = useState<LanguageCode>(() => {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) || navigator.language)
  })
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system"
  })
  const t = useMemo(() => createTranslator(language), [language])

  const [draftConfig, setDraftConfig] = useState<ServerConfig>(config)
  const [capabilities, setCapabilities] = useState<HarnessCapabilities>(() => DEFAULT_HARNESS_CAPABILITIES[config.backend])
  const [connectedVersion, setConnectedVersion] = useState<string>("")
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [extensionActions, setExtensionActions] = useState<HarnessAction[]>([])
  const [commandFilter, setCommandFilter] = useState<"all" | "skill">("all")
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = useState<string>(() => localStorage.getItem(AGENT_STORAGE_KEY) || "build")
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  /** Read inside loadSelected, which must not re-declare itself every time this changes. */
  const modelLoadErrorRef = useRef<string | null>(null)
  modelLoadErrorRef.current = modelLoadError
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(() => readStoredModel(config.backend))
  const [modelQuery, setModelQuery] = useState("")
  const [helpPage, setHelpPage] = useState<"overview" | "server" | "network" | "troubleshooting" | "commands">(
    "overview"
  )
  const [view, setView] = useState<"settings" | "sessions" | "detail" | "help">(() => {
    return config.host && config.port > 0 ? "sessions" : "settings"
  })
  // Desktop gets a persistent left sidebar instead of the mobile top bar/bottom nav; this mirrors
  // the existing 780px CSS breakpoint so JS layout and stylesheet layout never disagree.
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_MEDIA_QUERY).matches)
  /* Whether the platform draws the menu itself. Fixed for the life of the process — it is a
     property of the build, not of the window — so it is read once. */
  const [usesNativeMenu] = useState(desktopUsesNativeMenu)
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  // On desktop the sidebar always shows sessions, so the main pane falls back to the chat view
  // instead of duplicating the session list there.
  const mainView = isDesktop && view === "sessions" ? "detail" : view

  // The two side panels carry explicit pixel widths; the conversation between them fills whatever
  // is left, so the panel edges are the borders worth dragging — the other two are the window's own.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, defaultSidebarWidth(), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
  )
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readStoredWidth(INSPECTOR_WIDTH_STORAGE_KEY, INSPECTOR_WIDTH_DEFAULT, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
  )
  /** The right-hand panel is opt-in and remembered: it is a working surface for whoever is watching
   *  models and file changes, and dead chrome for whoever is only reading the conversation. */
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) === "true")
  const [inspectorTab, setInspectorTab] = useState<"ai" | "project">("ai")
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth))
  }, [inspectorWidth])
  useEffect(() => {
    localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, String(inspectorOpen))
  }, [inspectorOpen])
  // The window width, becoming state only so a resize re-renders the panels. The render-time clamp
  // of the side panels reads it (via maxSidebarWidth/maxInspectorWidth) and hasRoomForInspector is
  // derived from it — nothing on a resize ever touches the stored preferences below.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const hasRoomForInspector = viewportWidth >= INSPECTOR_MIN_WINDOW_WIDTH
  // Read through refs by the drag handlers below, which are created during this render but only
  // ever run after it — the widths they clamp against are whatever the last render settled on.
  const inspectorSpaceRef = useRef(0)
  const sidebarWidthRef = useRef(sidebarWidth)
  const dragPanelDivider = useHorizontalDrag((deltaX) => {
    // Growing the sidebar takes the space out of the main pane, which is why the cap has to know
    // the window width — and what the opposite panel is already holding — rather than just the
    // sidebar's own maximum.
    setSidebarWidth((width) => clamp(width + deltaX, SIDEBAR_WIDTH_MIN, maxSidebarWidth(inspectorSpaceRef.current)))
  })
  const dragInspectorDivider = useHorizontalDrag((deltaX) => {
    setInspectorWidth((width) => clamp(width - deltaX, INSPECTOR_WIDTH_MIN, maxInspectorWidth(sidebarWidthRef.current)))
  })
  // Keeps the window width current so a resize re-renders the panels and re-applies the render-time
  // clamp (viewportSidebarWidth/inspectorWidth). The clamp writes to the rendered widths only:
  // the stored preferences are reserved for the drag handle and are never narrowed by the viewport.
  useEffect(() => {
    if (!isDesktop) return
    const reflowPanels = () => setViewportWidth(window.innerWidth)
    reflowPanels()
    window.addEventListener("resize", reflowPanels)
    return () => window.removeEventListener("resize", reflowPanels)
  }, [isDesktop])

  const [sessions, setSessions] = useState<SessionView[]>([])
  const [selectedID, setSelectedID] = useState<string | null>(null)
  // This ref, rather than React state, is the synchronous authority for session mutations. State is
  // only a paint signal so every alternate affordance sees the lock in the same tick.
  const mutationCoordinatorRef = useRef<SessionMutationCoordinator | null>(null)
  if (!mutationCoordinatorRef.current) mutationCoordinatorRef.current = createSessionMutationCoordinator({
    profileID: activeProfileID,
    configKey: configKey(config),
    sessionID: selectedID
  })
  const mutationCoordinator = mutationCoordinatorRef.current
  const [, bumpMutationLock] = useState(0)
  // Abort is deliberately not represented by the ordinary lease: it may overlap the prompt lease,
  // and must remain a lock after that lease's owner has finished cleaning up.
  const abortInFlightRef = useRef(new Map<string, Promise<void>>())
  const [abortPresentationContext, setAbortPresentationContext] = useState<string | null>(null)
  // This is the single synchronous navigation boundary. Old leases may finish later, but they must
  // not leave their spinners, draft, optimistic bubbles, or activity caches in the new context.
  const replaceMutationContext = (sessionID: string | null = selectedID, profileID = activeProfileID, nextConfig = config) => {
    const context = { profileID, configKey: configKey(nextConfig), sessionID }
    if (!mutationCoordinator.isContextCurrent(context)) {
      const previousContext = mutationCoordinator.getContext()
      mutationCoordinator.replaceContext(context)
      bumpMutationLock((value) => value + 1)
      sessionActionPendingRef.current = null
      setBusySending(false)
      setAbortPresentationContext(null)
      setSessionActionPending(null)
      setActivatingSkill(null)
      setCreatingSession(false)
      setAwaitingAssistantReply(false)
      // A replacement view starts with its own presentation state. The old lease is still held by
      // its physical owner, so the lock remains visible, but its spinner must not bleed into here.
      setRefreshingSessions(false)
      refreshingSessionsRef.current = false
      refreshIndicatorRequestRef.current += 1
      setRuntimeError(null)
      setActionNotice(null)
      setLoadingSessionID(null)
      setAgentOptions([])
      setAgentLoadError(null)
      setModelOptions([])
      setModelLoadError(null)
      setOptimisticUserMessages([])
      setQueuedInboxMessages([])
      compactObservationRef.current = null
      forkReconcilingRef.current = false
      pendingSkillRequestsRef.current.clear()
      setComposer("")
      setAttachments([])
      // H1: session-only navigation must never silently destroy the draft/staged attachments.
      // Park the outgoing session's draft under its own key and restore the incoming session's
      // parked draft; only a profile/config change (different namespace) clears the whole map.
      // The ref is the synchronous authority here — replaceContext has already committed.
      const namespaceChanged = previousContext === null
        || previousContext.profileID !== context.profileID
        || previousContext.configKey !== context.configKey
      if (namespaceChanged) {
        sessionDraftsRef.current.clear()
        pendingForkDraftRef.current = null
        setComposer("")
        setAttachments([])
      } else {
        if (previousContext.sessionID && (composer.trim() || attachments.length > 0)) {
          sessionDraftsRef.current.set(
            sessionDraftKey(previousContext.profileID, previousContext.configKey, previousContext.sessionID),
            { text: composer, attachments: [...attachments] }
          )
        } else if (previousContext.sessionID) {
          // The outgoing composer is empty, so any parked draft for this session is stale: the
          // user cleared it deliberately (or already sent it), and restoring the old text on the
          // next visit would resurrect exactly what they removed.
          sessionDraftsRef.current.delete(sessionDraftKey(previousContext.profileID, previousContext.configKey, previousContext.sessionID))
        }
        const saved = context.sessionID
          ? sessionDraftsRef.current.get(sessionDraftKey(context.profileID, context.configKey, context.sessionID))
          : undefined
        setComposer(saved ? saved.text : "")
        setAttachments(saved ? [...saved.attachments] : [])
      }
      completionShouldPlayRef.current = false
      awaitingAssistantBaselineRef.current = ""
      latestMessageTimesRef.current.clear()
      lastEventBySessionRef.current.clear()
      executionMemoryRef.current.clear()
      loadAgentsRequestRef.current += 1
      loadModelsRequestRef.current += 1
      refreshRequestRef.current += 1
      activityRequestRef.current += 1
    }
  }
  const isSessionMutationLocked = () => mutationCoordinator.getActiveLease() !== null || abortInFlightRef.current.size > 0
  // Ownership and currency are deliberately separate. A stale owner must release its lease, but it
  // may not write into the replacement view (including cleanup state).
  const isLeaseContextCurrent = (lease: MutationLease) => mutationCoordinator.isLeaseCurrent(lease)
    && mutationCoordinator.isContextGenerationCurrent(lease.contextGeneration)
    && mutationCoordinator.isContextCurrent(lease.context)
    && mutationCoordinator.isForkGenerationCurrent(lease.forkGeneration)
  const acquireMutation = (kind: MutationKind, targetSessionID?: string | null): MutationLease | null => {
    const lease = mutationCoordinator.acquireLease(kind, targetSessionID)
    if (lease) bumpMutationLock((value) => value + 1)
    return lease
  }
  const releaseMutation = (lease: MutationLease) => {
    if (mutationCoordinator.releaseLease(lease)) bumpMutationLock((value) => value + 1)
  }
  // Keep the coordinator in lock-step with React after an externally-driven profile/config change.
  // This is deliberately an effect, never a render side effect; event handlers below replace the
  // context synchronously before starting navigation or a mutation.
  useLayoutEffect(() => {
    const context = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
    if (!mutationCoordinator.isContextCurrent(context)) replaceMutationContext(selectedID, activeProfileID, config)
  }, [activeProfileID, config, selectedID, mutationCoordinator])
  const mutationLocked = isSessionMutationLocked()
  // Async session actions must never complete into a different server/profile or session. This is
  // updated during render so an in-flight fork can compare against the user's latest context.
  const activeContextRef = useRef({ profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID })
  activeContextRef.current = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
  const showInspector = isDesktop && inspectorOpen && hasRoomForInspector && mainView === "detail" && Boolean(selectedID)
  // The persisted widths are the user's preference, changed only by dragging the divider. What is
  // actually laid out is that preference clamped to what this window can spare at this moment —
  // kept separate so a resize (or a stored width from a larger screen) never rewrites the stored
  // preference down to a viewport-sized value that then stays small forever.
  const viewportSidebarWidth = isDesktop ? clamp(sidebarWidth, SIDEBAR_WIDTH_MIN, maxSidebarWidth()) : sidebarWidth
  const viewportInspectorWidth = showInspector ? clamp(inspectorWidth, INSPECTOR_WIDTH_MIN, maxInspectorWidth()) : inspectorWidth
  inspectorSpaceRef.current = showInspector ? viewportInspectorWidth : 0
  sidebarWidthRef.current = viewportSidebarWidth
  const [newSessionDirectory, setNewSessionDirectory] = useState(() => localStorage.getItem(NEW_SESSION_DIRECTORY_STORAGE_KEY) ?? "")
  const [showNewSessionPicker, setShowNewSessionPicker] = useState(false)
  const [pickerPath, setPickerPath] = useState("")
  const [pickerItems, setPickerItems] = useState<FileEntry[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageEnvelope[]>([])
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<MessageEnvelope[]>([])
  /** Server-admitted but still queued prompts (from `GET /api/session/{id}/inbox`), rendered as
   *  transcript rows with the queued indicator so they survive reconciliation. */
  const [queuedInboxMessages, setQueuedInboxMessages] = useState<MessageEnvelope[]>([])
  /** Inbox ids whose cancellation request is in flight, so the queued row's cancel control
   *  disables itself instead of double-firing. A ReadonlySet keeps the reference stable across
   *  unrelated renders, so the message-list memo is not defeated on every keystroke. */
  const cancellingInboxIDsRef = useRef<ReadonlySet<string>>(new Set())
  const [cancellingInboxIDs, setCancellingInboxIDs] = useState<ReadonlySet<string>>(() => new Set())
  cancellingInboxIDsRef.current = cancellingInboxIDs
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([])
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([])
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([])

  const [projectDashboard, setProjectDashboard] = useState<ProjectDashboard | null>(null)

  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [composer, setComposer] = useState("")
  const [attachments, setAttachments] = useState<AttachmentPart[]>([])
  /** H1: composer drafts and staged attachments parked per session, scoped to the current
   *  profile/config namespace. A session-only switch parks the outgoing draft under its own key
   *  and restores the incoming session's parked draft; only a profile/config change clears the
   *  whole namespace. This mirrors the fork restore pattern (empty-composer guard, context
   *  scoped) for plain navigation, so switching sessions never silently destroys unsent input. */
  const sessionDraftsRef = useRef(new Map<string, { text: string; attachments: AttachmentPart[] }>())
  /** M4: the fork snapshot survives reconcile exhaustion. The child could not be confirmed, but
   *  the fork may still have committed server-side; keeping the snapshot here lets a later manual
   *  open of the child restore it (see openSession), so the draft is never lost. Scoped to the
   *  profile/config the fork ran in and consumed on restore. */
  const pendingForkDraftRef = useRef<{
    namespace: string
    parentSessionID: string
    parentDirectory: string
    baselineChildIDs: Set<string>
    text: string
    attachments: AttachmentPart[]
  } | null>(null)
  function sessionDraftKey(profileID: string, configKeyValue: string, sessionID: string | null): string {
    return `${profileID}\u0000${configKeyValue}\u0000${sessionID ?? ""}`
  }
  /** Retires a session's parked draft once its text has actually been sent: the composer was
   *  flushed by the dispatch, so an older parked entry from a previous visit must not resurrect
   *  the already-sent text on a session round-trip. Only called at commit boundaries, when the
   *  send is confirmed (or, for skills, when the activation is later confirmed by poll). */
  function clearParkedDraft(sessionID: string) {
    sessionDraftsRef.current.delete(sessionDraftKey(activeProfileID, configKey(config), sessionID))
  }
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const [busySending, setBusySending] = useState(false)
  const [sessionActionPending, setSessionActionPending] = useState<"compact" | "fork" | null>(null)
  const sessionActionPendingRef = useRef<"compact" | "fork" | null>(null)
  sessionActionPendingRef.current = sessionActionPending
  /** Tracks one in-flight compaction: the exact admission id when the acknowledgement confirmed it
   *  (so terminal state is correlated to THAT request), the stable request id otherwise — the server
   *  admits compaction durably under the client-supplied id, so the terminal compaction message
   *  carries that same id in every path, including a lost acknowledgement or double-indeterminate
   *  response — plus a bounded deadline for when the admission could not be established. No
   *  baseline/any-terminal heuristic: only the exact admission/request id resolves the pending
   *  state, so a later unrelated compaction can never release this one. */
  const compactObservationRef = useRef<{
    context: string
    expectedID: string | null
    startedAt: number
    /** M5: true once the bounded deadline resolved the pending lock. The observation then becomes a
     *  passive watcher: it no longer locks controls, but it keeps watching for the exact expected
     *  compaction id so the terminal result is still announced instead of silently vanishing. */
    passive: boolean
  } | null>(null)
  useEffect(() => {
    const observation = compactObservationRef.current
    if (!observation) return
    const context = JSON.stringify({ profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID })
    if (observation.context !== context || !selectedID) {
      // The compaction belongs to a context this view no longer owns. Clear the observation and the
      // pending action so a stale compaction can never strand the global sessionActionPending.
      if (compactObservationRef.current === observation) compactObservationRef.current = null
      sessionActionPendingRef.current = null
      setSessionActionPending(null)
      return
    }
    const compactions = messages.filter((message) => message.info.type === "compaction")
    // Exact correlation only: the terminal compaction message carries the same durable id the server
    // admitted under, so only a message with the expected id may release the pending action.
    const expected = observation.expectedID
      ? compactions.find((message) => message.info.id === observation.expectedID)
      : undefined
    if (expected && (expected.info.compactionStatus === "completed" || expected.info.compactionStatus === "failed")) {
      const terminal = expected.info.compactionStatus === "failed" ? t('detail.compactFailed') : t('detail.compactCompleted')
      compactObservationRef.current = null
      if (!observation.passive) {
        sessionActionPendingRef.current = null
        setSessionActionPending(null)
        setActionNotice(terminal)
      } else {
        // M5: the deadline already released the pending lock. Only announce the terminal result —
        // re-locking the controls (or re-enabling a duplicate compaction) would be wrong here.
        setActionNotice(terminal)
      }
      return
    }
    // A passive watcher has no deadline of its own: the lock already resolved, and it only waits
    // for the exact expected id to reach terminal state (or for the context to change).
    if (observation.passive) return
    // Bounded terminal recovery: the expected message never reached terminal state. Do not let the
    // pending action (and the compact button) block forever — check inline on every message change
    // AND schedule a timer for a quiet session that stops changing.
    const remaining = COMPACTION_PENDING_MAX_MS - (Date.now() - observation.startedAt)
    if (remaining <= 0) {
      // M5: resolve the lock but keep the observation as a passive watcher on the exact id.
      observation.passive = true
      sessionActionPendingRef.current = null
      setSessionActionPending(null)
      setActionNotice(t('detail.compactUnconfirmed'))
      return
    }
    const deadlineTimer = setTimeout(() => {
      const active = compactObservationRef.current
      if (!active || active !== observation || sessionActionPendingRef.current !== "compact") return
      active.passive = true
      sessionActionPendingRef.current = null
      setSessionActionPending(null)
      setActionNotice(t('detail.compactUnconfirmed'))
    }, remaining)
    return () => clearTimeout(deadlineTimer)
  }, [activeProfileID, config, messages, selectedID, sessionActionPending, t])
  const forkFocusSessionRef = useRef<string | null>(null)
  const forkReconcilingRef = useRef(false)
  /** Skill activations whose 204 acknowledgement was lost: keyed by the original request id (which
   *  the projected skill message carries, see `Session.skill`), so a later poll can confirm the
   *  activation by exact id instead of retrying the unsafe duplicate admission. */
  const pendingSkillRequestsRef = useRef(new Map<string, { sessionID: string; skillName: string }>())
  const [activatingSkill, setActivatingSkill] = useState<string | null>(null)
  const [loadingSessionID, setLoadingSessionID] = useState<string | null>(null)
  /** The empty transcript state is only meaningful after this session's first history snapshot succeeds. */
  const [loadedSessionID, setLoadedSessionID] = useState<string | null>(null)
  /** Which session failed to open, and why, so the transcript pane can say so instead of spinning. */
  const [loadFailure, setLoadFailure] = useState<{ sessionID: string; message: string } | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const refreshingSessionsRef = useRef(false)
  refreshingSessionsRef.current = refreshingSessions
  const [awaitingAssistantReply, setAwaitingAssistantReply] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState<{ type: NoticeType; text: string } | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "offline">(
    config.host && config.port > 0 ? "connecting" : "idle"
  )
  const [connectionMessage, setConnectionMessage] = useState<string>("")
  const [eventStreamState, setEventStreamState] = useState<"idle" | "connecting" | "live" | "reconnecting" | "fallback">("idle")
  const [liveEventCount, setLiveEventCount] = useState(0)
  const [liveEventError, setLiveEventError] = useState<string | null>(null)
  const [lastTestedConfigKey, setLastTestedConfigKey] = useState<string | null>(null)
  const [sessionToDelete, setSessionToDelete] = useState<SessionView | null>(null)
  const [renamingSessionID, setRenamingSessionID] = useState<string | null>(null)
  const [renameSource, setRenameSource] = useState<"list" | "header" | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [activeDetailSheet, setActiveDetailSheet] = useState<null | "ai" | "details">(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [showConnectWizard, setShowConnectWizard] = useState(false)
  const [settingsTab, setSettingsTab] = useState<"server" | "appearance">("server")
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  useLayoutEffect(() => {
    if (forkFocusSessionRef.current !== selectedID || !selectedID || mainView !== "detail") return
    // Focus the heading rather than the textarea: this gives both desktop and mobile users a
    // deterministic announcement without unexpectedly opening a soft keyboard on mobile.
    detailHeadingRef.current?.focus()
    forkFocusSessionRef.current = null
  }, [mainView, selectedID])
  // Both gate on mainView, not view: on desktop, picking a session leaves view === "sessions" while
  // the chat is what's actually rendered, so gating on view left the buttons permanently inactive.
  const [jumpAffordances, refreshChatJumps] = useJumpAffordances(mainView === "detail", () =>
    messagesScrollMetrics()
  )
  // mainView is never "sessions" on desktop — there the list is the sidebar below — so this is
  // implicitly the mobile page-scrolled list.
  const [sessionJumpAffordances, refreshSessionJumps] = useJumpAffordances(
    mainView === "sessions",
    windowScrollMetrics
  )
  // The desktop sidebar list scrolls itself, so it needs its own instance reading that element.
  const sidebarSessionsRef = useRef<HTMLDivElement | null>(null)
  const [sidebarJumpAffordances, refreshSidebarJumps] = useJumpAffordances(isDesktop, () =>
    elementScrollMetrics(sidebarSessionsRef.current)
  )
  const completionAudioRef = useRef<HTMLAudioElement | null>(null)
  const completionShouldPlayRef = useRef(false)
  const wasAwaitingAssistantReplyRef = useRef(false)
  const wasRunningRef = useRef(false)
  const awaitingAssistantBaselineRef = useRef("")
  const loadSelectedRequestRef = useRef(0)
  const loadCommandsRequestRef = useRef(0)
  const loadAgentsRequestRef = useRef(0)
  const loadModelsRequestRef = useRef(0)
  const refreshRequestRef = useRef(0)
  const refreshIndicatorRequestRef = useRef(0)
  const activityRequestRef = useRef(0)
  const backgroundFailureCountRef = useRef(0)
  const initialSessionLoadRef = useRef(true)
  const latestMessageTimesRef = useRef(new Map<string, { sessionUpdated: number; activityTime: number }>())
  // Deletes are eventual-consistency tombstones. Keep them per profile/config namespace so
  // leaving a profile and coming back does not resurrect a row, while a different server can
  // legitimately have a session with the same id.
  const removedSessionIDsRef = useRef(new Map<string, Set<string>>())
  const tombstonesHydratedRef = useRef(false)
  if (!tombstonesHydratedRef.current) {
    for (const [key, ids] of readSessionTombstones()) removedSessionIDsRef.current.set(key, ids)
    tombstonesHydratedRef.current = true
  }
  const selectedSessionRef = useRef<SessionView | null>(null)
  /** The session `openSession` is currently working on, so its retry can tell it is still wanted. */
  const openingSessionRef = useRef<string | null>(null)
  /** Set once the project/vcs/file endpoints prove absent, so polling stops asking for them. */
  const dashboardUnsupportedRef = useRef(false)
  /** When the model list was last re-fetched after a failure, so the retry stays occasional. */
  const modelRetryRef = useRef<{ sessionID: string; at: number } | null>(null)
  const eventStreamStateRef = useRef<"idle" | "connecting" | "live" | "reconnecting" | "fallback">("idle")
  /** Last time an SSE event arrived for a given session, used to spot sessions the stream isn't covering. */
  const lastEventBySessionRef = useRef(new Map<string, number>())
  /** Per-session execution memory for the v2 status derivation (issue #8). Survives SSE reconnects;
   *  cleared only on context/session switch, send, supersession, and authoritative-list pruning. */
  const executionMemoryRef = useRef(new Map<string, SessionExecutionMemory>())

  const loadedMessagesRef = useRef<MessageEnvelope[]>([])
  const shouldAutoScrollRef = useRef(false)
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedID) ?? null,
    [sessions, selectedID]
  )
  const projectPath = projectDashboard?.project
    ? pickString(projectDashboard.project.path) || pickString(projectDashboard.project.directory) || pickString(projectDashboard.project.root)
    : null
  const projectName = projectDashboard?.project
    ? pickString(projectDashboard.project.name) || (projectPath ? projectPath.split("/").filter(Boolean).pop() ?? projectPath : null)
    : null
  const vcsBranch = projectDashboard?.vcs
    ? pickString(projectDashboard.vcs.branch) || pickString(projectDashboard.vcs.status) || summarizeJson(projectDashboard.vcs)
    : null
  const selectedModel = useMemo(() => modelFromKey(selectedModelKey), [selectedModelKey])
  const activeModelOption = useMemo(() => {
    if (selectedModel) {
      const explicit = modelOptions.find((option) => sameModel(option, selectedModel))
      if (explicit) return explicit
    }
    if (selectedSession?.model) {
      const current = modelOptions.find((option) => sameModel(option, selectedSession.model))
      if (current) return current
    }
    return modelOptions.find((option) => option.isDefault) ?? modelOptions[0] ?? null
  }, [modelOptions, selectedModel, selectedSession?.model])
  const activeModel = activeModelOption
    ? { providerID: activeModelOption.providerID, modelID: activeModelOption.modelID, variant: activeModelOption.variant }
    : undefined
  const primaryAgentOptions = useMemo(() => agentOptions.filter((agent) => agent.mode === "primary" || agent.mode === "all"), [agentOptions])
  const activeAgent = useMemo(() => {
    return primaryAgentOptions.find((agent) => agent.id === selectedAgentID)
      ?? primaryAgentOptions.find((agent) => agent.id === "build")
      ?? primaryAgentOptions[0]
      ?? null
  }, [primaryAgentOptions, selectedAgentID])
  const activeAgentID = activeAgent?.id ?? "build"
  const filteredModelOptions = useMemo(() => {
    const text = modelQuery.trim().toLowerCase()
    if (!text) return modelOptions
    return modelOptions.filter((option) => modelSearchText(option).includes(text))
  }, [modelOptions, modelQuery])

  // On desktop there's always a sidebar listing sessions, so an empty main pane just says
  // "select a session" for no reason — auto-open the first one instead. Only attempted once per
  // server connection so it doesn't fight a session the user deliberately closed back out of.
  const autoSelectAttemptedRef = useRef(false)
  useEffect(() => {
    if (!isDesktop || autoSelectAttemptedRef.current || selectedID || sessions.length === 0) return
    autoSelectAttemptedRef.current = true
    openSession(sessions[0].id, sessions[0].directory).catch(() => undefined)
  }, [isDesktop, selectedID, sessions])

  const filteredSessions = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return sessions
    return sessions.filter((session) => {
      return session.title.toLowerCase().includes(text) || session.directory.toLowerCase().includes(text)
    })
  }, [sessions, query])
  // Child-session badges (issue #10): `toSessionView` carries `parentID` non-enumerably, so the
  // badge reads it off the view rows and resolves the parent's title from the same list — cheap
  // because both sides are already in memory. Recomputed whenever the list changes identity.
  const parentInfo = useMemo(() => {
    const info = new Map<string, { parentID: string; parentTitle?: string }>()
    const titles = new Map(sessions.map((session) => [session.id, session.title]))
    for (const session of sessions) {
      const parentID = (session as SessionView & { parentID?: string }).parentID
      if (parentID) info.set(session.id, { parentID, parentTitle: titles.get(parentID) })
    }
    return info
  }, [sessions])
  const displayedCommands = useMemo(() => {
    if (commandFilter === "skill") return commands.filter((command) => command.source === "skill")
    return commands
  }, [commands, commandFilter])
  const isSessionRunning = Boolean(selectedSession && isSessionWorking(selectedSession.status))
  const isWorking = awaitingAssistantReply || busySending || isSessionRunning
  // revertDisabled={sessionActionPending === "fork"}
  const messageMenuActions = useMemo(() => {
    const supported = new Set(commands.map((command) => command.name.toLowerCase()))
    const actions: MessageMenuAction[] = []
    const revertMessageID = selectedSession?.revertMessageID
    const undoAction = extensionActions.find((action) => action.id === "undo")
    const redoAction = extensionActions.find((action) => action.id === "redo")
    const hasUndo = config.backend === "opencode" || config.backend === "opencode2"
      ? messages.some((message) => message.info.role === "user" && (!revertMessageID || message.info.id < revertMessageID))
      : undoAction ? undoAction.enabled && messages.some((message) => message.info.role === "user") : true
    const hasRedo = config.backend === "opencode" || config.backend === "opencode2" ? !!revertMessageID : redoAction ? redoAction.enabled : true
    const supportsUndo = config.backend === "opencode" || config.backend === "opencode2" || !!undoAction || supported.has("undo")
    const supportsRedo = config.backend === "opencode" || config.backend === "opencode2" || !!redoAction || supported.has("redo")
    if (supportsUndo && hasUndo) actions.push({ id: "undo", label: t('detail.undo'), disabled: mutationLocked || sessionActionPending !== null, disabledReason: mutationLocked || sessionActionPending !== null ? t('detail.actionLocked') : undefined, onSelect: () => void runNativeHistoryCommand("undo") })
    if (supportsRedo && hasRedo) actions.push({ id: "redo", label: t('detail.redo'), disabled: mutationLocked || sessionActionPending !== null, disabledReason: mutationLocked || sessionActionPending !== null ? t('detail.actionLocked') : undefined, onSelect: () => void runNativeHistoryCommand("redo") })
    return actions
  }, [commands, config.backend, extensionActions, messages, mutationLocked, selectedSession?.revertMessageID, sessionActionPending, t])
  /** Session-level actions for the header ⋯ menu. Unlike the message context menu, availability
   *  follows the harness/extension's own enabled state rather than the transcript contents: an
   *  Undo that empties the conversation leaves Redo enabled but with no bubble left to host a menu,
   *  so this menu stays reachable and mirrors exactly what the bridge reports. */
  const sessionHeaderActions = useMemo(() => {
    const supported = new Set(commands.map((command) => command.name.toLowerCase()))
    const actions: MessageMenuAction[] = []
    const revertMessageID = selectedSession?.revertMessageID
    const undoAction = extensionActions.find((action) => action.id === "undo")
    const redoAction = extensionActions.find((action) => action.id === "redo")
    // M8: availability counts every visible user row (history, optimistic bubble, queued inbox),
    // so a just-sent or queued prompt keeps Compact/Fork reachable.
    const hasUserMessage = hasAnyUserMessage(messages, optimisticUserMessages, queuedInboxMessages)
    // M7: a disabled item must be able to explain itself in its tooltip. The lock and pending
    // action win over every other reason; compact/fork additionally need a user message and an
    // idle agent. mutationLocked is intentionally additive so every lease also disables them.
    const lockedReason = t('detail.actionLocked')
    const emptyReason = t('detail.requiresUserMessage')
    const workingReason = t('detail.actionWhileWorking')
    const disabledReasonFor = (extraDisabled: boolean): string | undefined => {
      if (extraDisabled) {
        if (mutationLocked || sessionActionPending !== null) return lockedReason
        if (!hasUserMessage) return emptyReason
        return workingReason
      }
      return undefined
    }
    const hasUndo = config.backend === "opencode" || config.backend === "opencode2"
      ? messages.some((message) => message.info.role === "user" && (!revertMessageID || message.info.id < revertMessageID))
      : undoAction ? undoAction.enabled : supported.has("undo")
    const hasRedo = config.backend === "opencode" || config.backend === "opencode2" ? !!revertMessageID : redoAction ? redoAction.enabled : supported.has("redo")
     if (hasUndo) actions.push({ id: "undo", label: t('detail.undo'), disabled: mutationLocked || sessionActionPending !== null, disabledReason: disabledReasonFor(mutationLocked || sessionActionPending !== null), onSelect: () => void runNativeHistoryCommand("undo") })
     if (hasRedo) actions.push({ id: "redo", label: t('detail.redo'), disabled: mutationLocked || sessionActionPending !== null, disabledReason: disabledReasonFor(mutationLocked || sessionActionPending !== null), onSelect: () => void runNativeHistoryCommand("redo") })
    if (selectedSession && config.backend === "opencode2" && capabilities.compactSession) {
      const compactDisabled = mutationLocked || sessionActionPending !== null || !hasUserMessage || isWorking || busySending
       actions.push({ id: "compact", label: t('detail.compactSession'), disabled: compactDisabled, disabledReason: disabledReasonFor(compactDisabled), onSelect: () => void compactCurrentSession() })
    }
    if (selectedSession && config.backend === "opencode2" && capabilities.forkSession) {
      const forkDisabled = mutationLocked || sessionActionPending !== null || !hasUserMessage || isWorking || busySending
       actions.push({ id: "fork", label: t('detail.forkSession'), disabled: forkDisabled, disabledReason: disabledReasonFor(forkDisabled), onSelect: () => void forkCurrentSession() })
    }
    return actions
  }, [awaitingAssistantReply, busySending, capabilities.compactSession, capabilities.forkSession, commands, config.backend, extensionActions, isWorking, messages, optimisticUserMessages, queuedInboxMessages, selectedSession, sessionActionPending, t, mutationLocked])
  const selectedNewSessionDirectory = normalizeDirectory(newSessionDirectory)

  const renderedMessages = useMemo(() => {
    const revertMessageID = config.backend === "opencode" || config.backend === "opencode2" ? selectedSession?.revertMessageID : undefined
    return [...messages, ...optimisticUserMessages, ...queuedInboxMessages]
      .filter((message) => !revertMessageID || message.info.id < revertMessageID)
      .map(toRenderedMessage)
      .filter((message) => message.text || message.parts.some((part) => part.type !== "step-start" && part.type !== "step-finish"))
  }, [config.backend, messages, optimisticUserMessages, queuedInboxMessages, selectedSession?.revertMessageID])

  // Transcript-wide subagent correlation (issue #10): terminal completions carried on
  // info.subagent and the set of child ids that have a run card. Recomputes only when the rendered
  // transcript actually changes, so the memoized bubble renderers below keep their referential
  // stability across polls that change nothing.
  const subagentContext = useMemo<SubagentContext>(() => ({
    completions: collectSubagentCompletions(renderedMessages),
    toolChildIDs: collectSubagentToolChildIDs(renderedMessages)
  }), [renderedMessages])

  const timelineGroups = useMemo(() => groupRenderedMessages(renderedMessages), [renderedMessages])

  const messageScrollSignature = useMemo(() => {
    return renderedMessages.map((message) => `${message.info.id}:${message.text.length}`).join("|")
  }, [renderedMessages])

  const assistantResponseSignature = useMemo(() => {
    return renderedMessages
      .filter((message) => message.info.role !== "user")
      .map((message) => `${message.info.id}:${message.text.length}`)
      .join("|")
  }, [renderedMessages])
  const backendClient = BACKEND_CLIENTS[config.backend]

  const hasConfiguredServer = isValidServerConfig(config)
  const draftConfigKey = configKey(draftConfig)
  const canTestDraft = canTestConfig(draftConfig)
  const testAlreadyPassedForDraft = lastTestedConfigKey === draftConfigKey
  const connectionStatusText = connectionMessage || (connectionState === "connecting"
    ? t('connection.connecting')
    : connectionState === "reconnecting"
      ? t('connection.reconnecting')
      : connectionState === "connected"
        ? t('connection.connected')
        : connectionState === "offline"
          ? t('connection.offline')
          : "")
  const isOffline = connectionState === "offline"
  /* The connection status already speaks when the server is unreachable. A second, more hopeful
     voice about the event stream only made the app look like it disagreed with itself. */
  const eventStreamText = isOffline
    ? ""
    : eventStreamState === "live"
    ? t('events.live', { count: liveEventCount })
    : eventStreamState === "connecting"
      ? t('events.connecting')
      : eventStreamState === "reconnecting"
        ? t('events.reconnecting')
        : eventStreamState === "fallback"
          ? t('events.fallback', { error: liveEventError ?? t('events.unknownError') })
          : ""
  const isWaitingForOpenCodeReply = awaitingAssistantReply || busySending || isSessionRunning
  // Stop is the one deliberate out-of-band action allowed to overlap a working turn. It may
  // interrupt prompt/command/skill work, but never competes with an unrelated structural mutation.
  const activeWorkingLease = mutationCoordinator.getActiveLease()
  const currentAbortContext = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
  const currentAbortKey = `${currentAbortContext.profileID}\u0000${currentAbortContext.configKey}\u0000${currentAbortContext.sessionID ?? ""}`
  const canAbortSession = Boolean(selectedSession && isWorking
    && !abortInFlightRef.current.has(currentAbortKey)
    && abortPresentationContext !== currentAbortKey
    && (!activeWorkingLease
      || (activeWorkingLease.context.profileID === currentAbortContext.profileID
        && activeWorkingLease.context.configKey === currentAbortContext.configKey
        && activeWorkingLease.context.sessionID === currentAbortContext.sessionID
        && activeWorkingLease.targetSessionID === selectedSession.id
        && (activeWorkingLease.kind === "prompt" || activeWorkingLease.kind === "command" || activeWorkingLease.kind === "skill"))))
  // Stopping is an out-of-band action, so it must stay reachable while a draft is present. The
  // draft remains in the composer; changing the action to Stop must never make an interruption
  // destructive on either mobile or desktop.
  const showStopAction = canAbortSession
  const showTypingBubble = Boolean(selectedSession) && isWaitingForOpenCodeReply
  const activeSessions = sessions.filter((session) => isSessionWorking(session.status)).length
  const changedSessions = sessions.filter(
    (session) => session.files > 0 || session.additions > 0 || session.deletions > 0
  ).length
  const totalDiffAdditions = diffFiles.reduce((sum, file) => sum + file.additions, 0)
  const totalDiffDeletions = diffFiles.reduce((sum, file) => sum + file.deletions, 0)
  /* The chip also stands its ground when the model list could not be fetched. Hiding it there left
     no trace of a control every other session has — Codex reports its models only inside the
     session load it refuses for a conversation its desktop app holds open, so those sessions lost
     the chip with no explanation. `modelStatusLabel` already has the wording for it. */
  const showModelChip = modelOptions.length > 1
    || Boolean(activeModelOption)
    || primaryAgentOptions.length > 0
    || (capabilities.models && Boolean(modelLoadError))
  /**
   * Three distinct states, and conflating any two of them reads as a hang: a fetch in flight, a
   * fetch that failed, and a harness that has no model list to fetch. `loadModels` returns early
   * when the backend does not expose one, so without the first branch the label would sit on
   * "loading" forever — which is what the Claude Code backend did.
   */
  const modelStatusLabel = activeModelOption?.modelName
    ?? (!capabilities.models
      ? t('detail.modelNotSupported')
      : modelLoadError ? t('detail.modelUnavailable') : t('detail.modelLoading'))

  async function openSession(sessionID: string, directory: string) {
    replaceMutationContext(sessionID)
    const openContextGeneration = mutationCoordinator.getContextGeneration()
    const openContext = { profileID: activeProfileID, configKey: configKey(config), sessionID }
    const isCurrentOpen = () => mutationCoordinator.isContextGenerationCurrent(openContextGeneration)
      && mutationCoordinator.isContextCurrent(openContext)
    setSelectedID(sessionID)
    // M4: restore a preserved fork draft when the child is subsequently opened manually. Only
    // when the open stays in the fork's profile/config, targets a session that is not the fork's
    // parent and not part of the pre-fork baseline, and matches the fork's directory; and only
    // into an empty composer/attachment tray (the empty-composer guard from the fork restore
    // pattern), so anything the user typed meanwhile is never overwritten. Consumed on restore.
    const pendingForkDraft = pendingForkDraftRef.current
    if (pendingForkDraft
      && pendingForkDraft.namespace === `${activeProfileID}\u0000${configKey(config)}`
      && sessionID !== pendingForkDraft.parentSessionID
      && !pendingForkDraft.baselineChildIDs.has(sessionID)
      && directory === pendingForkDraft.parentDirectory) {
      pendingForkDraftRef.current = null
      setComposer((current) => (current === "" ? pendingForkDraft.text : current))
      setAttachments((current) => (current.length === 0 ? pendingForkDraft.attachments : current))
    }
    setSelectedModelKey(readStoredModel(config.backend, sessionID))
    loadModelsRequestRef.current += 1
    setModelOptions([])
    setExtensionActions([])
    setMessages([])
    loadedMessagesRef.current = []
    setLoadedSessionID(null)
    setLoadFailure(null)
    setOptimisticUserMessages([])
    setTodos([])
    setDiffFiles([])
    setPendingQuestions([])
    setProjectDashboard(null)
    setDashboardError(null)
    setAwaitingAssistantReply(false)
    setRuntimeError(null)
    setActionNotice(null)
    setView("detail")
    setLoadingSessionID(sessionID)
    openingSessionRef.current = sessionID
    try {
      try {
        await loadSelected(sessionID, directory, true)
      } catch (first) {
        // Opening a session fires several requests at once and one of them losing a flaky mobile
        // connection is common enough that it was the usual way this screen failed. Announcing it
        // immediately made the app look broken for the second it took to come good on its own, so
        // one quiet retry comes first and only a second failure is worth telling anyone about.
        if (openingSessionRef.current !== sessionID || !isCurrentOpen()) throw first
        await new Promise((resolve) => setTimeout(resolve, 600))
        if (openingSessionRef.current !== sessionID || !isCurrentOpen()) throw first
        await loadSelected(sessionID, directory, true)
      }
      await Promise.all([loadAgents(sessionID, directory), loadModels(sessionID, directory)])
    } catch (err) {
      const message = (err as Error).message
      if (isCurrentOpen()) {
        setRuntimeError(message)
        setLoadFailure({ sessionID, message })
      }
    }
    if (isCurrentOpen()) setLoadingSessionID((activeID) => (activeID === sessionID ? null : activeID))
  }

  function applyConfig(nextConfig: ServerConfig, profileID = activeProfileID, sourceProfiles = profiles) {
    replaceMutationContext(null, profileID, nextConfig)
    const serverChanged = configKey(nextConfig) !== configKey(config)
    const profileChanged = profileID !== activeProfileID
    if (serverChanged || profileChanged) {
      loadSelectedRequestRef.current += 1
      loadModelsRequestRef.current += 1
      autoSelectAttemptedRef.current = false
      dashboardUnsupportedRef.current = false
      setSessions([])
      setSelectedID(null)
      setMessages([])
      setLoadedSessionID(null)
      loadedMessagesRef.current = []
      setOptimisticUserMessages([])
      setTodos([])
      setDiffFiles([])
      setProjectDashboard(null)
      setDashboardError(null)
      setAwaitingAssistantReply(false)
      setConnectedVersion("")
      setCommands([])
      setExtensionActions([])
      setActionNotice(null)
      setAgentOptions([])
      setModelOptions([])
      setSelectedModelKey(readStoredModel(nextConfig.backend))
    }
    const nextProfiles = sourceProfiles.map((profile) => profile.id === profileID ? { ...profile, config: nextConfig } : profile)
    setProfiles(nextProfiles)
    setActiveProfileID(profileID)
    persistServerProfiles(nextProfiles, profileID)
    setDraftConfig(nextConfig)
    setConfig(nextConfig)
    setSettingsNotice({ type: "success", text: t('settings.saved') })
    setConnectionState("connecting")
    setConnectionMessage(t('connection.connecting'))
    setRuntimeError(null)
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
  }

  function activateProfile(profileID: string) {
    const profile = profiles.find((candidate) => candidate.id === profileID)
    if (!profile || profile.id === activeProfileID) return
    setDraftProfileName(profile.name)
    setDraftConfig(profile.config)
    applyConfig(profile.config, profile.id)
  }

  function deleteActiveProfile() {
    setProfileToDelete(null)
    if (profiles.length === 1) return
    const nextProfiles = profiles.filter((profile) => profile.id !== activeProfileID)
    const nextProfile = nextProfiles[0]
    setDraftProfileName(nextProfile.name)
    setDraftConfig(nextProfile.config)
    applyConfig(nextProfile.config, nextProfile.id, nextProfiles)
  }
  async function testConnection(configToTest: ServerConfig): Promise<{ ok: boolean; message: string }> {
    setTestingConnection(true)
    setSettingsNotice({ type: "info", text: t('settings.testingConnection') })
    try {
      const health = await Promise.race([
        api.health(configToTest),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out")), 12000))
      ])
      if (health.backend && health.backend !== configToTest.backend) {
        throw new Error(`Expected ${backendDisplayName(configToTest.backend)} but reached ${backendDisplayName(health.backend)}`)
      }
      setConnectedVersion(health.version)
      setLastTestedConfigKey(configKey(configToTest))
      setSettingsNotice({ type: "success", text: t('settings.testedNotSaved', { version: health.version }) })
      return { ok: true, message: t('settings.connectedTo', { version: health.version }) }
    } catch (err) {
      const message = t('settings.connectionFailed', { message: (err as Error).message })
      setSettingsNotice({ type: "error", text: message })
      return { ok: false, message }
    } finally {
      setTestingConnection(false)
    }
  }

  async function refreshSessions(silent = false, preserveSession?: SessionView, suppressError = false): Promise<boolean> {
    if (!isValidServerConfig(config)) return true
    const refreshRequestID = ++refreshRequestRef.current
    const refreshContextGeneration = mutationCoordinator.getContextGeneration()
    const refreshContext = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
    const refreshIsCurrent = () => refreshRequestID === refreshRequestRef.current
      && mutationCoordinator.isContextGenerationCurrent(refreshContextGeneration)
      && mutationCoordinator.isContextCurrent(refreshContext)
    if (!silent) {
      setRuntimeError(null)
      setConnectionState(sessions.length === 0 ? "connecting" : "reconnecting")
      setConnectionMessage(sessions.length === 0 ? t('connection.loadingSessions') : t('connection.refreshing'))
    } else if (initialSessionLoadRef.current && sessions.length === 0) {
      setConnectionState("connecting")
      setConnectionMessage(t('connection.loadingSessions'))
    }
    try {
      let authoritativeGlobalListing = true
      const items = await api.listGlobalSessions(config).catch(async () => {
        authoritativeGlobalListing = false
        return api.listSessions(config)
      })
      // OpenCode scopes both of these to a project directory, so each one has to be asked
      // separately. The bridge does not: called without a directory it answers for every session it
      // knows. Fanning out there turned one refresh into two requests per distinct directory — over
      // a hundred requests every eight seconds on a real session list, which is what made the app
      // stall for seconds at a time on a phone.
      const directories = isBridgeBackend(config.backend)
        ? []
        : [...new Set(items.map((session) => session.directory).filter(Boolean))]
      const [sessionLists, statusMaps, formLists, permissionLists] = isBridgeBackend(config.backend)
        ? await Promise.all([
            api.listSessions(config).then((list) => [list]).catch(() => [[]] as Session[][]),
            api.listStatuses(config).then((map) => [map]).catch(() => [{}] as Record<string, SessionStatus>[]),
            Promise.resolve([] as QuestionRequest[][]),
            Promise.resolve([] as PermissionRequest[][])
          ])
        : await Promise.all([
            Promise.all(directories.map((directory) => api.listSessions(config, directory).catch(() => [] as Session[]))),
            Promise.all(directories.map((directory) => api.listStatuses(config, directory).catch(() => ({} as Record<string, SessionStatus>)))),
            // The v2 status derivation (issue #8) needs the live pending forms/permissions scoped to
            // each directory, exactly like the status fan-out above; v1 backends never fetch them here.
            config.backend === "opencode2"
              ? Promise.all(directories.map((directory) => api.loadQuestions(config, directory).catch(() => [] as QuestionRequest[])))
              : Promise.resolve([] as QuestionRequest[][]),
            config.backend === "opencode2"
              ? Promise.all(directories.map((directory) => api.loadPermissions(config, directory).catch(() => [] as PermissionRequest[])))
              : Promise.resolve([] as PermissionRequest[][])
          ])
      const scopedSessions = new Map(sessionLists.flat().map((session) => [session.id, session]))
      const statuses = Object.assign({}, ...statusMaps)
      // The v2 mapper attaches `parentID` non-enumerably (it must never leak into wire payloads or
      // equality comparisons), so the spread below would silently drop it — object spread copies only
      // enumerable own properties. Child sessions reach the list only through this hydration path
      // (a refresh replaces their just-inserted rows), and the badge reads `parentID` from the view,
      // so surface it the same non-enumerable way `toSessionView` does.
      const hydratedItems = items.map((session) => {
        const parentID = session.parentID
        const hydrated = { ...session, ...scopedSessions.get(session.id), project: session.project }
        if (parentID) Object.defineProperty(hydrated, "parentID", { value: parentID, enumerable: false })
        return hydrated
      })
      // v2-only (issue #8): overlay the derived activity status on the wire status map. The derived
      // status wins because execution memory is strictly newer than the poll snapshot it overlays.
      if (config.backend === "opencode2") {
        const activeIDs = new Set(Object.keys(statuses))
        const pendingForms = formLists.flat()
        const pendingPermissions = permissionLists.flat()
        for (const session of hydratedItems) {
          const derived = deriveSessionStatus(session.id, { active: activeIDs, pendingForms, pendingPermissions }, executionMemoryRef.current.get(session.id))
          if (derived) statuses[session.id] = derived
        }
      }
      const activityTimes = await loadSessionActivityTimes(hydratedItems)
      const tombstoneKey = refreshContext.profileID + "\u0000" + refreshContext.configKey
      const persistedTombstoneKey = tombstoneNamespaceKey(refreshContext.profileID, refreshContext.configKey)
      const tombstones = mergedSessionTombstones(removedSessionIDsRef.current, tombstoneKey, persistedTombstoneKey)
      const mapped = hydratedItems
        .map((session) => toSessionView(session, statuses[session.id], activityTimes.get(session.id)))
        .filter((session) => !tombstones.has(session.id))
        .sort((a, b) => b.updated - a.updated)
      // A profile/session switch, or a fork that started while this fan-out was in flight, makes
      // this snapshot historical. Never let it replace a newer list (especially the just-inserted
      // child row).
      if (!refreshIsCurrent()) return true
      // Retirement needs both halves of the proof: the global endpoint really answered, and this
      // refresh still belongs to the current context/generation. Scoped fallbacks and stale
      // snapshots may hide rows, but can never erase durable deletion evidence.
      if (authoritativeGlobalListing) {
        const authoritativeIDs = new Set(hydratedItems.map((session) => session.id))
        // Bounded-growth guard: sessions that left the authoritative list can never produce fresh
        // execution facts, so their memory must not accumulate forever.
        for (const key of [...executionMemoryRef.current.keys()]) {
          if (!authoritativeIDs.has(key)) executionMemoryRef.current.delete(key)
        }
        let tombstonesChanged = false
        for (const id of [...tombstones]) {
          if (!authoritativeIDs.has(id)) { tombstones.delete(id); tombstonesChanged = true }
        }
        if (tombstonesChanged) {
          if (tombstones.size) {
            removedSessionIDsRef.current.set(tombstoneKey, tombstones)
            removedSessionIDsRef.current.set(persistedTombstoneKey, tombstones)
          } else {
            removedSessionIDsRef.current.delete(tombstoneKey)
            removedSessionIDsRef.current.delete(persistedTombstoneKey)
          }
          persistSessionTombstones(removedSessionIDsRef.current)
        }
      }
      setSessions((current) => {
        // `current` is the list this refresh started from, so a session opened moments ago may not
        // be in it yet; the ref holds what is actually on screen. Falling back to `current` alone
        // let a refresh that raced an open drop the selected session, and the sessions list then
        // came back with nothing selected.
        const selected = selectedID
          ? current.find((session) => session.id === selectedID)
            ?? (selectedSessionRef.current?.id === selectedID ? selectedSessionRef.current : null)
          : null
        const toPreserve = preserveSession ?? selected
        const activeLease = mutationCoordinator.getActiveLease()
        const optimisticRows = activeLease?.kind === "fork" || activeLease?.kind === "create"
          ? current.filter((session) => !mapped.some((item) => item.id === session.id))
          : []
        const preserved = toPreserve && !mapped.some((session) => session.id === toPreserve.id) ? [toPreserve] : []
        const next = [...mapped, ...optimisticRows, ...preserved]
          .filter((session, index, all) => all.findIndex((item) => item.id === session.id) === index)
          .sort((a, b) => b.updated - a.updated)
        return keepIfUnchanged(current, next)
      })
      if (!refreshIsCurrent()) return true
      backgroundFailureCountRef.current = 0
      initialSessionLoadRef.current = false
      setConnectionState("connected")
      setConnectionMessage(t('connection.connected'))
      setRuntimeError(null)
      return true
    } catch (err) {
      const message = (err as Error).message
      if (!refreshIsCurrent()) return true
      if (suppressError) return false
      if (!silent) {
        setConnectionState("offline")
        setConnectionMessage(t('connection.offline'))
        setRuntimeError(message)
        return false
      }

      backgroundFailureCountRef.current += 1
      // A device returning from standby commonly loses one or two polling rounds while Wi-Fi and
      // the server wake up. Keep the last known state and retry quietly before calling it offline.
      if (backgroundFailureCountRef.current < 3) {
        const isInitialLoad = initialSessionLoadRef.current && sessions.length === 0
        setConnectionState(isInitialLoad ? "connecting" : "reconnecting")
        setConnectionMessage(isInitialLoad ? t('connection.loadingSessions') : t('connection.reconnecting'))
        return false
      }

      setConnectionState("offline")
      setConnectionMessage(t('connection.offline'))
      setRuntimeError(message)
      initialSessionLoadRef.current = false
      return false
    }
  }

  async function refreshSessionsWithIndicator() {
    if (refreshingSessionsRef.current) return
    const generation = mutationCoordinator.getContextGeneration()
    const context = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
    const indicatorRequestID = ++refreshIndicatorRequestRef.current
    refreshingSessionsRef.current = true
    setRefreshingSessions(true)
    try {
      await refreshSessions()
    } finally {
      if (indicatorRequestID === refreshIndicatorRequestRef.current
        && mutationCoordinator.isContextGenerationCurrent(generation)
        && mutationCoordinator.isContextCurrent(context)) {
        refreshingSessionsRef.current = false
        setRefreshingSessions(false)
      }
    }
  }

  async function loadCommands() {
    if (!isValidServerConfig(config)) return
    const requestID = ++loadCommandsRequestRef.current
    const generation = mutationCoordinator.getContextGeneration()
    const context = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
    const current = () => requestID === loadCommandsRequestRef.current
      && mutationCoordinator.isContextGenerationCurrent(generation)
      && mutationCoordinator.isContextCurrent(context)
    try {
      const list = await api.listCommands(config)
      if (!current()) return
      setCommands(list)
    } catch {
      if (!current()) return
      setCommands([])
    }
  }

  async function loadAgents(sessionID = selectedSession?.id, directory = selectedSession?.directory ?? selectedNewSessionDirectory) {
    if (!isValidServerConfig(config) || !capabilities.agents) {
      setAgentOptions([])
      return
    }
    const requestID = ++loadAgentsRequestRef.current
    const generation = mutationCoordinator.getContextGeneration()
    const context = { profileID: activeProfileID, configKey: configKey(config), sessionID: sessionID ?? selectedID }
    try {
      const list = await api.listAgents(config, directory)
       if (requestID !== loadAgentsRequestRef.current || !mutationCoordinator.isContextGenerationCurrent(generation) || !mutationCoordinator.isContextCurrent(context)) return
      setAgentOptions(list)
      setAgentLoadError(null)
      const saved = localStorage.getItem(AGENT_STORAGE_KEY) || selectedAgentID
      const primary = list.filter((agent) => agent.mode === "primary" || agent.mode === "all")
      const next = primary.find((agent) => agent.id === saved) ?? primary.find((agent) => agent.id === "build") ?? primary[0]
      if (next) {
        setSelectedAgentID(next.id)
        localStorage.setItem(AGENT_STORAGE_KEY, next.id)
      }
    } catch (err) {
      if (requestID === loadAgentsRequestRef.current && mutationCoordinator.isContextGenerationCurrent(generation) && mutationCoordinator.isContextCurrent(context)) setAgentLoadError((err as Error).message)
    }
  }

  async function loadModels(sessionID = selectedSession?.id, directory = selectedSession?.directory ?? selectedNewSessionDirectory) {
    if (!isValidServerConfig(config) || !capabilities.models) return
    const requestID = ++loadModelsRequestRef.current
    const generation = mutationCoordinator.getContextGeneration()
    const context = { profileID: activeProfileID, configKey: configKey(config), sessionID: sessionID ?? selectedID }
    const current = () => requestID === loadModelsRequestRef.current
      && mutationCoordinator.isContextGenerationCurrent(generation)
      && mutationCoordinator.isContextCurrent(context)
    try {
      const list = await api.listModels(config, directory, backendClient.modelSelectionRequiresSession ? sessionID : undefined)
      if (!current()) return
      setModelOptions(list)
      setModelLoadError(null)
      const sessionModel = sessions.find((session) => session.id === sessionID)?.model
      const sessionOption = sessionModel ? list.find((option) => sameModel(option, sessionModel)) : null
      if (sessionOption) {
        const nextKey = modelKey(sessionOption)
        setSelectedModelKey(nextKey)
        writeStoredModel(config.backend, sessionID, nextKey)
        return
      }
      const savedKey = readStoredModel(config.backend, sessionID)
      const saved = modelFromKey(savedKey)
      const savedOption = saved ? list.find((option) => sameModel(option, saved)) : null
      if (savedOption) {
        setSelectedModelKey(savedKey)
        return
      }
      const fallback = list.find((option) => option.isDefault) ?? list[0]
      if (fallback) {
        const nextKey = modelKey(fallback)
        setSelectedModelKey(nextKey)
        writeStoredModel(config.backend, sessionID, nextKey)
      }
    } catch (err) {
      if (current()) setModelLoadError((err as Error).message)
    }
  }

  async function loadSessionActivityTimes(items: Session[]): Promise<Map<string, number>> {
    const activityRequestID = ++activityRequestRef.current
    const activityGeneration = mutationCoordinator.getContextGeneration()
    const activityContext = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }
    const activityIsCurrent = () => activityRequestID === activityRequestRef.current
      && mutationCoordinator.isContextGenerationCurrent(activityGeneration)
      && mutationCoordinator.isContextCurrent(activityContext)
    if (config.backend !== "opencode") {
      return new Map(items.map((session) => [session.id, session.time.updated]))
    }
    const results = await Promise.all(items.map(async (session) => {
      const cacheKey = `${activityContext.profileID}|${activityContext.configKey}|${session.id}`
      const cached = latestMessageTimesRef.current.get(cacheKey)
      if (cached?.sessionUpdated === session.time.updated) return [session.id, cached.activityTime] as const

      const latest = await api.loadLatestMessage(config, session.id, session.directory).catch(() => null)
      if (latest === null) return [session.id, session.time.updated] as const
      const activityTime = latest.length > 0 ? Math.max(...latest.map(messageActivityTime)) : session.time.updated
       // The request may finish after navigation. Never let its response repopulate a cache that was
       // synchronously cleared for another profile/config/session.
       if (activityIsCurrent()) latestMessageTimesRef.current.set(cacheKey, { sessionUpdated: session.time.updated, activityTime })
      return [session.id, activityTime] as const
    }))
    return new Map(results)
  }

  function changeModel(nextKey: string) {
    if (isSessionMutationLocked()) return
    const lease = acquireMutation("model")
    if (!lease) return
    // A manual choice wins over a catalog request that was already in flight. The request's
    // response may still be useful for a later refresh, but it must not restore its old selection.
    loadModelsRequestRef.current += 1
    setSelectedModelKey(nextKey)
    writeStoredModel(config.backend, selectedSession?.id, nextKey)
    releaseMutation(lease)
  }

  function changeAgent(nextAgentID: string) {
    if (isSessionMutationLocked()) return
    const lease = acquireMutation("agent")
    if (!lease) return
    // Do not let an older agent catalog completion apply its saved/default choice after an explicit
    // user selection.
    loadAgentsRequestRef.current += 1
    setSelectedAgentID(nextAgentID)
    localStorage.setItem(AGENT_STORAGE_KEY, nextAgentID)
    releaseMutation(lease)
  }

  async function loadSelected(sessionID: string, directory: string, refreshHistory = false, replaceMessages = false) {
    const requestID = ++loadSelectedRequestRef.current
    const loadContext = { profileID: activeProfileID, configKey: configKey(config), sessionID }
    const loadContextGeneration = mutationCoordinator.getContextGeneration()
    const isCurrentLoad = () => requestID === loadSelectedRequestRef.current
      && mutationCoordinator.isContextGenerationCurrent(loadContextGeneration)
      && mutationCoordinator.isContextCurrent(loadContext)
    const [msg, todo, diff, questions, permissions, actions, inbox] = await Promise.all([
      api.loadMessages(config, sessionID, directory, backendClient.messageRefreshSupported && refreshHistory),
      capabilities.todos ? api.loadTodo(config, sessionID, directory) : Promise.resolve([]),
      capabilities.diff ? api.loadDiff(config, sessionID, directory).catch(() => []) : Promise.resolve([]),
      capabilities.questions ? api.loadQuestions(config, directory).catch(() => []) : Promise.resolve([]),
      capabilities.permissions ? api.loadPermissions(config, directory).catch(() => []) : Promise.resolve([]),
      capabilities.actions ? api.listActions(config, sessionID, directory).catch(() => []) : Promise.resolve([]),
      config.backend === "opencode2"
        ? listInboxV2(config, sessionID, directory).catch(() => [])
        : Promise.resolve([] as V2InboxItem[])
    ])
    if (requestID !== loadSelectedRequestRef.current) return
    if (!isCurrentLoad()) return
    setLoadedSessionID(sessionID)
    // Background polling keeps running after a failed open, so a session that only failed once must
    // not stay stuck on the failure state once its history does arrive.
    setLoadFailure((failure) => (failure?.sessionID === sessionID ? null : failure))
    const current = loadedMessagesRef.current
    // The server admits queued prompts durably before delivering them: overlay the inbox's delivery
    // metadata on messages that reached history (their queued indicator survives reconciliation) and
    // render inbox-only queued items as stable transcript rows (see queuedInboxMessageEnvelopes).
    const transcript = config.backend === "opencode2" ? applyInboxDelivery(msg, inbox) : msg
    const queuedRows = config.backend === "opencode2"
      ? queuedInboxMessageEnvelopes(sessionID, inbox, new Set(transcript.map((message) => message.info.id)))
      : []
    // A snapshot carrying less assistant text than is already on screen used to be rejected wholesale, to
    // avoid erasing streamed content. But the optimistic user bubble below is cleared against this same
    // snapshot either way, so rejecting it made a just-sent message vanish — and since the rejected
    // snapshot never reached state, the comparison stayed true and swallowed every later message too,
    // until the session was reopened. Shrinking text is now held back per part in mergeFetchedMessages
    // instead, which keeps the streamed text without ever dropping the messages that came with it.
    if (!messagesHaveSameContent(current, transcript)) {
      shouldAutoScrollRef.current = messagesExtendContent(current, transcript) && isNearMessagesBottom()
      loadedMessagesRef.current = transcript
      setMessages((prev) => replaceMessages ? transcript : mergeFetchedMessages(prev, transcript))
    }
    // A prompt the server has durably admitted (in history or still queued in the inbox) retires the
    // app's own optimistic bubble for the same text.
    const optimisticMatchSource = [...transcript, ...queuedRows]
    setOptimisticUserMessages((current) => {
      const remaining = current.filter((message) => !hasMatchingUserMessage(optimisticMatchSource, message))
      return remaining.length === current.length ? current : remaining
    })
    // A skill activation whose 204 acknowledgement was lost is confirmed when the projected skill
    // message — which carries the original request id — appears in history. The tagged optimistic
    // row was retired by that exact id above; announce the confirmation once, when it lands.
    if (pendingSkillRequestsRef.current.size > 0) {
      for (const [requestID, entry] of pendingSkillRequestsRef.current) {
        if (entry.sessionID !== sessionID) continue
        if (transcript.some((message) => message.info.id === requestID)) {
          pendingSkillRequestsRef.current.delete(requestID)
          // The activation is confirmed; the composer was flushed for it, so the session's
          // parked draft must not resurrect the activation text on a later round-trip.
          clearParkedDraft(sessionID)
          if (isCurrentLoad()) setActionNotice(t('help.skillActivated', { skill: entry.skillName }))
        }
      }
    }
    setQueuedInboxMessages((current) => keepIfUnchanged(current, queuedRows))
    setTodos((current) => keepIfUnchanged(current, todo))
    setDiffFiles((current) => keepIfUnchanged(current, diff))
    setPendingQuestions((current) => keepIfUnchanged(current, questions.filter((question) => question.sessionID === sessionID)))
    setPendingPermissions((current) => keepIfUnchanged(current, permissions.filter((permission) => permission.sessionID === sessionID)))
    setExtensionActions((current) => keepIfUnchanged(current, actions))
    // A model list that failed to load once is never retried on its own — the fetch is tied to the
    // session changing — so a transient failure left the picker disabled and marked in warning for
    // as long as the session stayed open. The transcript arriving is the signal that the server is
    // answering again. Spaced out because some failures are permanent rather than transient: Codex
    // will not list models for a conversation another client holds open, and retrying that on every
    // poll would be a request every few seconds for an answer that is not going to change.
    if (capabilities.models && modelLoadErrorRef.current && isCurrentLoad()) {
      const lastAttempt = modelRetryRef.current
      if (lastAttempt?.sessionID !== sessionID || Date.now() - lastAttempt.at > 30_000) {
        modelRetryRef.current = { sessionID, at: Date.now() }
        void loadModels(sessionID, directory)
      }
    }
    // A bridge-backed harness only advertises its commands once a session is loaded, so the
    // mount-time fetch of an idle bridge legitimately returns []. Retry here rather than in each
    // of loadSelected's callers, otherwise Help -> Commands stays empty for the whole visit.
    // if (capabilities.commands && commands.length === 0) await loadCommands()
    if (capabilities.commands && commands.length === 0 && isCurrentLoad()) await loadCommands()
    if (isCurrentLoad()) await loadProjectDashboard(directory, loadContextGeneration, loadContext)
  }

  async function runNativeHistoryCommand(command: "undo" | "redo") {
    if (!selectedSession || busySending || sessionActionPending !== null || isSessionMutationLocked()) return
    if (command === "undo" && !window.confirm(t('detail.undoConfirm'))) return
    const lease = acquireMutation("history")
    if (!lease) return

    setBusySending(true)
    setRuntimeError(null)
    setActionNotice(null)
    try {
      let revertedSession: Session | undefined
      if (config.backend === "opencode" || config.backend === "opencode2") {
        const revertMessageID = selectedSession.revertMessageID
        const userMessages = messages.filter((message) => message.info.role === "user")
        if (command === "undo") {
          const target = [...userMessages].reverse().find((message) => !revertMessageID || message.info.id < revertMessageID)
          if (!target) return
          revertedSession = await api.revertMessage(config, selectedSession.id, target.info.id, selectedSession.directory)
        } else {
          const next = userMessages.find((message) => !!revertMessageID && message.info.id > revertMessageID)
          revertedSession = next
            ? await api.revertMessage(config, selectedSession.id, next.info.id, selectedSession.directory)
            : await api.unrevertSession(config, selectedSession.id, selectedSession.directory)
        }
      } else if (capabilities.actions && extensionActions.some((action) => action.id === command)) {
        const result = await api.invokeAction(config, selectedSession.id, command, selectedSession.directory)
        if (!isLeaseContextCurrent(lease)) return
        setExtensionActions(result.actions)
        if (result.applied === false) {
          setActionNotice(t(command === "undo" ? 'detail.nothingToUndo' : 'detail.nothingToRedo'))
        }
        await loadSelected(selectedSession.id, selectedSession.directory, true, result.applied !== false)
      } else {
        await api.sendCommand(config, selectedSession.id, command, "", selectedSession.directory, activeModel, activeAgentID)
        await loadSelected(selectedSession.id, selectedSession.directory, true)
      }
      if (!isLeaseContextCurrent(lease) || !mutationCoordinator.isForkGenerationCurrent(lease.forkGeneration)) return
      if (config.backend === "opencode" || config.backend === "opencode2") await loadSelected(selectedSession.id, selectedSession.directory, true)
      await refreshSessions(true)
      if (revertedSession) {
        setSessions((current) => current.map((item) => item.id === revertedSession.id ? copySessionView(item, { revertMessageID: revertedSession.revert?.messageID }) : item))
      }
    } catch (err) {
      if (isLeaseContextCurrent(lease)) setRuntimeError((err as Error).message)
    } finally {
      if (isLeaseContextCurrent(lease)) {
        setBusySending(false)
      }
      releaseMutation(lease)
    }
  }

  /** Compact is a queued current-session action: it must not replace the selected session. */
  async function compactCurrentSession() {
    if (config.backend !== "opencode2" || !selectedSession || sessionActionPending || sessionActionPendingRef.current || isWorking || busySending || isSessionMutationLocked()
      || !hasAnyUserMessage(messages, optimisticUserMessages, queuedInboxMessages)) return
    const lease = acquireMutation("compact")
    if (!lease) return
    setSessionActionPending("compact")
    setRuntimeError(null)
    setActionNotice(null)
    // A stable admission id makes the acknowledgement retryable (the server answers 409 once the id
    // is durably recorded) and lets terminal history state be correlated to THIS compaction. The
    // server admits compaction durably under this id and the terminal compaction message carries the
    // same id, so the observation's expectedID is the exact admission id when the response confirms
    // it, and the stable request id otherwise — including a 409 conflict or a double-indeterminate
    // response, where no heuristic is needed: either the exact message appears and releases the
    // pending action, or the bounded deadline resolves it as unconfirmed.
    const compactRequestID = createMessageRequestID()
    const observation = {
      context: JSON.stringify({ profileID: activeProfileID, configKey: configKey(config), sessionID: selectedSession.id }),
      expectedID: compactRequestID as string | null,
      startedAt: Date.now(),
      passive: false
    }
    compactObservationRef.current = observation
    try {
      const admission = await compactSessionV2(config, selectedSession.id, selectedSession.directory, compactRequestID)
      observation.expectedID = admission?.id ?? compactRequestID
      if (isLeaseContextCurrent(lease)) setActionNotice(t('detail.compactQueued'))
    } catch (err) {
      if (isLeaseContextCurrent(lease)) {
        if (isIndeterminateDeliveryError(err)) {
          // The acknowledgement was lost. The server admits compaction durably under our id, so one
          // idempotent retry with the SAME id either confirms the earlier admission (409 conflict)
          // or performs it — it can never queue the compaction twice.
          try {
            const admission = await compactSessionV2(config, selectedSession.id, selectedSession.directory, compactRequestID)
            observation.expectedID = admission?.id ?? compactRequestID
            setActionNotice(t('detail.compactQueued'))
          } catch (retryErr) {
            if (isAdmissionConflict(retryErr)) {
              // The earlier admission is durably recorded under the request id; correlate with it.
              observation.expectedID = compactRequestID
              setActionNotice(t('detail.compactQueued'))
            } else if (isIndeterminateDeliveryError(retryErr)) {
              // Still unknown: if the transmission landed, the server admitted the compaction under
              // the request id, so correlating with that exact id still resolves the pending action
              // at terminal state; if it never landed, the bounded deadline resolves as unconfirmed.
              observation.expectedID = compactRequestID
              setActionNotice(t('detail.deliveryIndeterminate'))
              void loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
            } else {
              // The retry answered definitely (not a conflict): the compaction was never admitted.
              compactObservationRef.current = null
              setSessionActionPending(null)
              sessionActionPendingRef.current = null
              setRuntimeError((retryErr as Error).message)
            }
          }
        } else {
          compactObservationRef.current = null
          setSessionActionPending(null)
          sessionActionPendingRef.current = null
          setRuntimeError((err as Error).message)
        }
      }
    } finally {
      // Keep the logical action pending after a successful acknowledgement. The server performs
      // compaction asynchronously; the refresh metadata effect releases it at terminal state.
      releaseMutation(lease)
    }
  }

  async function forkCurrentSession() {
    if (config.backend !== "opencode2" || !selectedSession || sessionActionPending || sessionActionPendingRef.current || isWorking || busySending || isSessionMutationLocked()
      || !hasAnyUserMessage(messages, optimisticUserMessages, queuedInboxMessages)) return
    const original = selectedSession
    const forkDraft = { text: composer, attachments: [...attachments] }
    const forkContext = {
      profileID: activeProfileID,
      configKey: configKey(config),
      sessionID: original.id
    }
    const lease = acquireMutation("fork")
    if (!lease) return
    // State updates are batched. Update the ref too so callbacks and an awaited command
    // discovery cannot slip through during the render before the pending state commits.
    sessionActionPendingRef.current = "fork"
    forkReconcilingRef.current = false
    setSessionActionPending("fork")
    setRuntimeError(null)
    setActionNotice(null)
    // Children that already exist BEFORE the request are the baseline: reconciliation must find the
    // child THIS fork created, never navigate to an older fork's child.
    const baselineChildIDs = new Set<string>()
    const captureBaseline = async () => {
      try {
        for (const child of await listChildSessionsV2(config, original.id)) baselineChildIDs.add(child.id)
      } catch {
        try {
          for (const child of await api.listGlobalSessions(config)) if (child.parentID === original.id) baselineChildIDs.add(child.id)
        } catch {
          try {
            for (const child of await api.listSessions(config)) if (child.parentID === original.id) baselineChildIDs.add(child.id)
          } catch { /* best-effort: an empty baseline still reconciles, only less selectively */ }
        }
      }
    }
    // Currency for the reconciliation is deliberately NOT the lease: the fork lease is released as
    // soon as the acknowledgement is lost, so a check like isLeaseContextCurrent would fail the
    // moment the reconciliation starts. The captured context/generation is the authority.
    const reconcileGeneration = mutationCoordinator.getContextGeneration()
    const isReconcileCurrent = () => mutationCoordinator.isContextGenerationCurrent(reconcileGeneration)
      && mutationCoordinator.isContextCurrent(forkContext)
    const restoreForkDraft = (childID: string) => {
      const childContext = { profileID: activeProfileID, configKey: configKey(config), sessionID: childID }
      if (mutationCoordinator.isContextCurrent(childContext) && activeContextRef.current.sessionID === childID) {
        // Only restore into an empty composer/attachment tray: the reconciliation can lag the
        // navigation (bounded retries with delays), and anything the user typed into the child in
        // the meantime is newer than the forked snapshot and must never be overwritten.
        setComposer((current) => (current === "" ? forkDraft.text : current))
        setAttachments((current) => (current.length === 0 ? forkDraft.attachments : current))
      }
    }
    const finishForkPending = () => {
      forkReconcilingRef.current = false
      sessionActionPendingRef.current = null
      setSessionActionPending(null)
    }
    /** Indeterminate fork: the POST may have committed even though its response was lost. Reconcile
     *  with bounded, paginated, authoritative listings; never ask the user to retry blindly. */
    const reconcileFork = async () => {
      try {
        for (let attempt = 0; attempt < FORK_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FORK_RECONCILE_ATTEMPT_DELAY_MS))
          if (!isReconcileCurrent()) return
          const children = await (async () => {
            try { return await listChildSessionsV2(config, original.id) }
            catch {
              try { return (await api.listGlobalSessions(config)).filter((child) => child.parentID === original.id) }
              catch {
                try { return (await api.listSessions(config)).filter((child) => child.parentID === original.id) }
                catch { return [] }
              }
            }
          })()
          const child = children.find((candidate) => !baselineChildIDs.has(candidate.id))
          if (child && isReconcileCurrent()) {
            const childView = toSessionView(child)
            setSessions((current) => current.some((session) => session.id === childView.id)
              ? current
              : [childView, ...current].sort((a, b) => b.updated - a.updated))
            // M3: a back/view navigation during a pending fork must not be reversed by reconcile.
            // If the user left the fork context's detail view (mobile back/settings/help, or a
            // different session on desktop), insert the confirmed child into the list and announce
            // the result — never yank them back into the child. The fork draft is parked under the
            // child's key so a later manual open restores it (H1 session drafts).
            if (mainViewRef.current !== "detail" || selectedSessionRef.current?.id !== original.id) {
              sessionDraftsRef.current.set(
                sessionDraftKey(activeProfileID, configKey(config), childView.id),
                { text: forkDraft.text, attachments: [...forkDraft.attachments] }
              )
              setActionNotice(t('detail.forkCreated'))
              return
            }
            forkFocusSessionRef.current = childView.id
            await openSession(childView.id, childView.directory)
            restoreForkDraft(childView.id)
            return
          }
        }
        // Bounded terminal recovery: the child could not be confirmed. Resolve the pending state and
        // leave a resolvable path (refresh the session list) instead of blocking the menu forever.
        if (isReconcileCurrent()) {
          // M4: the fork may still have committed server-side even though the child was not found.
          // Preserve the fork draft snapshot (context-scoped) so opening the child manually later
          // restores it instead of losing it; openSession consumes the record with the empty
          // composer guard. It is cleared by replaceMutationContext on any profile/config change.
          pendingForkDraftRef.current = {
            namespace: `${activeProfileID}\u0000${configKey(config)}`,
            parentSessionID: original.id,
            parentDirectory: original.directory,
            baselineChildIDs,
            text: forkDraft.text,
            attachments: [...forkDraft.attachments]
          }
          setActionNotice(t('detail.forkUnconfirmed'))
        }
      } finally {
        // Always release the pending state on exhaustion (and on confirmed navigation, where the
        // child open already cleared it). When the context changed mid-reconciliation, navigation
        // cleared the pending state synchronously, and a newer action's state must not be clobbered
        // by this stale reconciliation's finally.
        if (isReconcileCurrent()) finishForkPending()
      }
    }
    try {
      await captureBaseline()
      if (!isLeaseContextCurrent(lease) || !mutationCoordinator.isContextCurrent(forkContext)) return
      const forked = await api.forkSession(config, original.id, original.directory)
      // The user may have switched profile or session while the server created the child. Do not
      // insert it into the new context or steal navigation from the session they chose meanwhile.
      if (!isLeaseContextCurrent(lease) || !mutationCoordinator.isContextCurrent(forkContext)) return
      const forkedView = toSessionView(forked)
      setSessions((current) => current.some((session) => session.id === forkedView.id)
        ? current
        : [forkedView, ...current].sort((a, b) => b.updated - a.updated))
      // Keep the original session and navigate through the shared session-opening path.
       forkFocusSessionRef.current = forkedView.id
       await openSession(forkedView.id, forkedView.directory)
      // A fork copies server history, not the unsent composer. Restore the snapshot only when the
      // navigation that this request initiated still owns the destination context.
      restoreForkDraft(forkedView.id)
       forkReconcilingRef.current = false
       sessionActionPendingRef.current = null
       setSessionActionPending(null)
    } catch (err) {
      if (isLeaseContextCurrent(lease)) {
        if (isIndeterminateDeliveryError(err)) {
          forkReconcilingRef.current = true
          setActionNotice(t('detail.deliveryIndeterminate'))
          // Runs detached from this function: the lease is released in finally while the
          // reconciliation continues on its own (bounded) schedule.
          void reconcileFork()
        } else {
          setRuntimeError((err as Error).message)
        }
      }
    } finally {
      if (isLeaseContextCurrent(lease)) {
        if (!forkReconcilingRef.current) {
          sessionActionPendingRef.current = null
          setSessionActionPending(null)
        }
      }
      releaseMutation(lease)
    }
  }

  async function revertToMessage(messageID: string) {
    if (!selectedSession || busySending || sessionActionPending === "fork" || isSessionMutationLocked() || (config.backend !== "opencode" && config.backend !== "opencode2")) return
    if (!window.confirm(t('detail.revertConfirm'))) return

    setBusySending(true)
    const lease = acquireMutation("history")
    if (!lease) { setBusySending(false); return }
    setRuntimeError(null)
    try {
      const session = await api.revertMessage(config, selectedSession.id, messageID, selectedSession.directory)
      await loadSelected(selectedSession.id, selectedSession.directory, true)
      await refreshSessions(true)
      if (isLeaseContextCurrent(lease)) setSessions((current) => current.map((item) => item.id === session.id ? copySessionView(item, { revertMessageID: session.revert?.messageID }) : item))
    } catch (err) {
      if (isLeaseContextCurrent(lease)) setRuntimeError((err as Error).message)
    } finally {
      if (isLeaseContextCurrent(lease)) {
        setBusySending(false)
      }
      releaseMutation(lease)
    }
  }

  async function loadProjectDashboard(directory: string, expectedGeneration = mutationCoordinator.getContextGeneration(), expectedContext = { profileID: activeProfileID, configKey: configKey(config), sessionID: selectedID }) {
    // The bridge implements none of these three, so on a bridge-backed harness this was nine
    // guaranteed 404s a second during polling. One round of them settles the question for the
    // rest of the connection.
    if (dashboardUnsupportedRef.current) return
    if (!mutationCoordinator.isContextGenerationCurrent(expectedGeneration) || !mutationCoordinator.isContextCurrent(expectedContext)) return
    setDashboardError(null)
    try {
      const [project, vcs, fileStatus] = await Promise.all([
        api.loadProjectCurrent(config, directory).catch(() => null),
        api.loadVcs(config, directory).catch(() => null),
        api.loadFileStatus(config, directory).catch(() => [])
      ])
      if (!mutationCoordinator.isContextGenerationCurrent(expectedGeneration) || !mutationCoordinator.isContextCurrent(expectedContext)) return
      const files = toFileStatusList(fileStatus)
      if (project === null && vcs === null && files.length === 0) {
        dashboardUnsupportedRef.current = true
        setProjectDashboard(null)
        return
      }
      setProjectDashboard((current) => {
        const next = { project, vcs, files }
        return current && JSON.stringify(current) === JSON.stringify(next) ? current : next
      })
    } catch (err) {
      if (mutationCoordinator.isContextGenerationCurrent(expectedGeneration) && mutationCoordinator.isContextCurrent(expectedContext)) setDashboardError((err as Error).message)
    }
  }

  function syncChatBottomClearance() {
    const container = messagesRef.current
    const composer = composerRef.current
    if (!container || !composer) return

    const composerRect = composer.getBoundingClientRect()
    const composerStyles = window.getComputedStyle(composer)
    const composerBottom = Number.parseFloat(composerStyles.bottom) || 0
    const clearance = Math.ceil(composerRect.height + composerBottom + 16)
    // Scoped to the wrap rather than the list itself so the jump buttons, which are siblings of the
    // list, can sit on top of the same clearance the list reserves for the composer.
    const scope = container.parentElement ?? container
    scope.style.setProperty("--chat-bottom-clearance", `${clearance}px`)
  }

  /** The chat is its own scroller in the desktop layout but lets the page scroll on mobile, so
   *  anything reading scroll position has to look at whichever of the two actually scrolls. */
  function messagesScrollMetrics(): ScrollMetrics {
    const container = messagesRef.current
    if (scrollsItself(container)) return elementScrollMetrics(container)

    // The fixed mobile composer is intentionally outside document flow. The transcript reserves
    // enough tail space to place its sentinel just above that composer, so the visually-correct
    // live tail is not the document's maximum scrollY. Measure the remaining transcript travel
    // directly instead; using document.scrollHeight here leaves the pin false by roughly one
    // composer height even while the last message is exactly where it belongs.
    const endRect = messagesEndRef.current?.getBoundingClientRect()
    const composerRect = composerRef.current?.getBoundingClientRect()
    if (!endRect || !composerRect) return windowScrollMetrics()
    const liveTailBottom = composerRect.top - 12
    return {
      fromTop: window.scrollY,
      fromBottom: Math.max(0, endRect.bottom - liveTailBottom)
    }
  }

  function isNearMessagesBottom(): boolean {
    // Read only the scroller that is active for this layout. On mobile `.messages` deliberately has
    // overflow: visible and the window scrolls; treating the overflowing element as a second scroller
    // makes its permanently-zero scrollTop disable the live-tail pin after almost every swipe.
    return messagesScrollMetrics().fromBottom <= BOTTOM_STICK_THRESHOLD
  }

  const handleMessagesScroll = useCallback(() => {
    stickToBottomRef.current = isNearMessagesBottom()
    refreshChatJumps()
  }, [])

  const handleQuestionResolved = useCallback((id: string) => {
    setPendingQuestions((current) => current.filter((item) => item.id !== id))
  }, [])

  const handlePermissionResolved = useCallback((id: string) => {
    setPendingPermissions((current) => current.filter((item) => item.id !== id))
  }, [])

  /** Identity-stable lease-change signal for the memoized MessagesPane: an inline arrow would be
   *  a fresh reference every render, which defeated the memo and re-formatted every message on
   *  every keystroke even though nothing about the lease changed. */
  const handleLeaseChanged = useCallback(() => bumpMutationLock((value) => value + 1), [])

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    requestAnimationFrame(() => {
      syncChatBottomClearance()
      requestAnimationFrame(() => {
        const container = messagesRef.current
        const end = messagesEndRef.current
        if (container) {
          container.scrollTo({ top: container.scrollHeight, behavior })
        }
        end?.scrollIntoView({ block: "end", behavior })

        const composerRect = composerRef.current?.getBoundingClientRect()
        const endRect = end?.getBoundingClientRect()
        if (composerRect && endRect && endRect.bottom > composerRect.top - 12) {
          const coveredByComposer = endRect.bottom - composerRect.top + 12
          window.scrollBy({ top: coveredByComposer, behavior })
        }
      })
    })
  }

  // Memoised so they don't defeat MessageList's memo on every render.
  const handleJumpToTop = useCallback(() => {
    // Jumping to the oldest message is an explicit "leave the live tail" gesture, so drop the pin;
    // otherwise the next incoming message would yank the view straight back down.
    stickToBottomRef.current = false
    const container = messagesRef.current
    if (scrollsItself(container)) {
      container.scrollTo({ top: 0, behavior: "smooth" })
      return
    }
    // The page is the scroller, so go to the actual top — scrolling the list into view instead
    // would strand the header above the fold and leave this button showing with nowhere to go.
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const handleJumpToBottom = useCallback(() => {
    stickToBottomRef.current = true
    scrollMessagesToBottom("smooth")
  }, [])

  /**
   * Both of these reach the memoized transcript, and `onRevertMessage` goes on to every message in
   * it. Declared inline they were a new function on every render of this component, which defeated
   * the memo on all of them and re-parsed every message's markdown each time — the other half of
   * why opening a long chat froze the app. The bodies are read through refs so the callbacks can
   * stay identity-stable while still calling the current version.
   */
  const revertToMessageRef = useRef(revertToMessage)
  revertToMessageRef.current = revertToMessage
  const handleRevertMessage = useCallback((messageID: string) => {
    if (sessionActionPendingRef.current === "fork") return
    void revertToMessageRef.current(messageID)
  }, [])

  /** Cancels a server-admitted queued prompt by inbox id (`DELETE /api/session/{id}/inbox/{id}`).
   *  The row is removed optimistically and the transcript is refreshed; the server answers
   *  definite statuses (409 — already delivered or executing; 404 — unknown session), so a
   *  failure surfaces as a visible error instead of being retried blindly. Deliberately
   *  out-of-band like Stop: the queued prompt's own send lease is long gone and the item is not
   *  a coordinator mutation, so no lease is acquired — the in-flight guard is the cancelling set.
   *  The body lives behind a ref so the identity-stable callback always calls the current one. */
  const cancelQueuedMessageRef = useRef<(message: MessageEnvelope) => void>(() => undefined)
  const cancelQueuedMessage = useCallback((message: MessageEnvelope) => {
    cancelQueuedMessageRef.current(message)
  }, [])
  cancelQueuedMessageRef.current = (message: MessageEnvelope) => {
    const inboxID = queuedInboxItemID(message)
    const session = selectedSessionRef.current
    if (!inboxID || !session || session.id !== message.info.sessionID) return
    const cancelContext = { profileID: activeProfileID, configKey: configKey(config), sessionID: session.id }
    if (!mutationCoordinator.isContextCurrent(cancelContext)) return
    if (cancellingInboxIDsRef.current.has(inboxID)) return
    cancellingInboxIDsRef.current = new Set(cancellingInboxIDsRef.current).add(inboxID)
    setCancellingInboxIDs(cancellingInboxIDsRef.current)
    setRuntimeError(null)
    void (async () => {
      try {
        await api.cancelInboxItem(config, session.id, inboxID, session.directory)
        if (!mutationCoordinator.isContextCurrent(cancelContext)) return
        // Definite success (204): drop the row now — both the server-inbox row and any optimistic
        // twin carrying the same durable id — then reconcile so the transcript converges.
        setQueuedInboxMessages((current) => {
          const remaining = current.filter((candidate) => queuedInboxItemID(candidate) !== inboxID)
          return remaining.length === current.length ? current : remaining
        })
        setOptimisticUserMessages((current) => {
          const remaining = current.filter((candidate) => queuedInboxItemID(candidate) !== inboxID)
          return remaining.length === current.length ? current : remaining
        })
        void loadSelected(session.id, session.directory, true).catch(() => undefined)
        void refreshSessions(false, undefined, true).catch(() => undefined)
      } catch (err) {
        // 409/404 and transport failures are definite: name them instead of leaving the row
        // half-removed or pretending the cancel succeeded.
        if (mutationCoordinator.isContextCurrent(cancelContext)) setRuntimeError((err as Error).message)
      } finally {
        if (cancellingInboxIDsRef.current.has(inboxID)) {
          cancellingInboxIDsRef.current = new Set([...cancellingInboxIDsRef.current].filter((id) => id !== inboxID))
          setCancellingInboxIDs(cancellingInboxIDsRef.current)
        }
      }
    })()
  }

  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession
  const handleRetrySession = useCallback(() => {
    const session = selectedSessionRef.current
    if (session) void openSessionRef.current(session.id, session.directory)
  }, [])

  /** Opening a child session needs its directory, which the sessions list usually already has; when
   *  the child is not listed (deleted, pruned, or never surfaced), the directory is fetched lazily
   *  from the server on demand — one request, only when the user actually presses the button. */
  const openingChildIDRef = useRef<string | null>(null)
  const [openingChildID, setOpeningChildID] = useState<string | null>(null)
  const openChildSessionRef = useRef<(childID: string) => void>(() => undefined)
  const handleOpenChildSession = useCallback((childID: string) => {
    openChildSessionRef.current(childID)
  }, [])
  openChildSessionRef.current = (childID: string) => {
    if (openingChildIDRef.current === childID) return
    const known = sessions.find((session) => session.id === childID)
    const open = (directory: string) => void openSessionRef.current(childID, directory).catch(() => undefined)
    if (known) {
      open(known.directory)
      return
    }
    openingChildIDRef.current = childID
    setOpeningChildID(childID)
    void (async () => {
      try {
        const child = await getSessionV2(config, childID)
        if (!child) return
        open(child.directory)
      } catch { /* the child is gone or unreachable; the button stays available to retry */ }
      finally {
        if (openingChildIDRef.current === childID) {
          openingChildIDRef.current = null
          setOpeningChildID(null)
        }
      }
    })()
  }

  const handleSessionsJumpToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const handleSessionsJumpToBottom = useCallback(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
  }, [])

  const handleSidebarJumpToTop = useCallback(() => {
    sidebarSessionsRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const handleSidebarJumpToBottom = useCallback(() => {
    const list = sidebarSessionsRef.current
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" })
  }, [])

  async function browseNewSessionDirectory(path: string) {
    setPickerLoading(true)
    setPickerError(null)
    try {
      const items = await api.listFiles(config, path, path)
      setPickerPath(path)
      setPickerItems(items.filter((item) => item.type === "directory").sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) {
      setPickerError((err as Error).message)
      setPickerItems([])
    } finally {
      setPickerLoading(false)
    }
  }

  async function openNewSessionPicker() {
    if (creatingSession || isSessionMutationLocked()) return
    setRuntimeError(null)
    setShowNewSessionPicker(true)
    setPickerError(null)
    try {
      const pathInfo = await api.loadPath(config, selectedNewSessionDirectory)
      await browseNewSessionDirectory(selectedNewSessionDirectory || pathInfo.directory)
    } catch (err) {
      setPickerError((err as Error).message)
    }
  }

  async function createSession(directory = selectedNewSessionDirectory) {
    if (creatingSession || isSessionMutationLocked()) return
    const lease = acquireMutation("create")
    if (!lease) return
    // v2 create accepts an optional client id (`Session.ID`); with it, a lost response can be
    // reconciled by fetching the session by id instead of retrying the mutation blindly.
    const createRequestID = config.backend === "opencode2" ? createSessionRequestID() : undefined
    setCreatingSession(true)
    setRuntimeError(null)
    setPickerError(null)
    try {
      if (directory) {
        const pathInfo = await api.loadPath(config, directory)
        if (!isProjectDirectory(pathInfo)) {
          throw new Error(t('sessions.projectDirectoryInvalid', { directory }))
        }
      }
      let created: Session
      if (createRequestID) {
        try {
          created = await (api.createSession as unknown as (config: ServerConfig, title: string, model: ModelSelection | undefined, directory: string | undefined, requestID: string) => Promise<Session>)(config, t('sessions.remoteSessionTitle'), activeModel, directory, createRequestID)
        } catch (createErr) {
          if (!isIndeterminateDeliveryError(createErr)) throw createErr
          // The POST may have committed before the response was lost. Reconcile by id: the session
          // either exists (created once) or was never admitted. Never blind-retry the create.
          try {
            created = await getSessionV2(config, createRequestID)
            setActionNotice(t('detail.deliveryAdmitted'))
          } catch {
            setActionNotice(t('detail.deliveryIndeterminate'))
            void refreshSessions(false, undefined, true).catch(() => undefined)
            return
          }
        }
      } else {
        created = await api.createSession(config, t('sessions.remoteSessionTitle'), activeModel, directory)
      }
      if (!isLeaseContextCurrent(lease)) return
      const createdView = toSessionView(created)
      if (directory) {
        setNewSessionDirectory(directory)
      }
      setShowNewSessionPicker(false)
      setSessions((current) => {
        if (current.some((session) => session.id === created.id)) return current
        return [createdView, ...current].sort((a, b) => b.updated - a.updated)
      })
      // The create lease targets the pre-session (null) context. Release it before replacing that
      // context, otherwise replaceContext invalidates the lease and leaves the create spinner stuck.
      setCreatingSession(false)
      releaseMutation(lease)
      replaceMutationContext(created.id)
      setSelectedID(created.id)
      setMessages([])
      setLoadedSessionID(null)
      setOptimisticUserMessages([])
      setTodos([])
      setDiffFiles([])
      setProjectDashboard(null)
      setDashboardError(null)
      setAwaitingAssistantReply(false)
      loadedMessagesRef.current = []
      setView("detail")
      setLoadingSessionID(created.id)
      try {
        await loadSelected(created.id, created.directory)
        await Promise.all([loadAgents(created.id, created.directory), loadModels(created.id, created.directory)])
        await refreshSessions(false, createdView)
      } catch (err) {
        if (mutationCoordinator.isContextCurrent({ profileID: activeProfileID, configKey: configKey(config), sessionID: created.id })) {
          setRuntimeError((err as Error).message)
        }
      } finally {
        if (mutationCoordinator.isContextCurrent({ profileID: activeProfileID, configKey: configKey(config), sessionID: created.id })) {
          setLoadingSessionID((activeID) => (activeID === created.id ? null : activeID))
        }
      }
      } catch (err) {
        if (isLeaseContextCurrent(lease)) {
        setPickerError((err as Error).message)
        setRuntimeError((err as Error).message)
      }
    } finally {
      if (isLeaseContextCurrent(lease)) {
        setCreatingSession(false)
      }
      // A create can replace the context before this finally runs. Releasing an old lease is safe,
      // and is required to free the physical owner even when its result became stale.
      releaseMutation(lease)
    }
  }

  async function activateSkill(skill: CommandInfo, input = `/${skill.name}`, stagedAttachments = attachments) {
    // F2: refuse dispatch during the fork reconcile window (ref = synchronous authority), so an
    // activation started in the same tick as a fork cannot be orphaned by the reconcile navigation.
    if (sessionActionPendingRef.current === "fork") return
    if (isSessionMutationLocked()) return
    if (!selectedSession) {
      setRuntimeError(t('help.skillRequiresSession'))
      return
    }
    if (config.backend !== "opencode2") {
      setRuntimeError(t('help.skillRequiresOpenCode2'))
      return
    }
    const skillName = skill.id ?? skill.name
    const session = selectedSession
    const lease = acquireMutation("skill")
    if (!lease) return
    // Stable durable admission id: the projected skill message carries this exact id (the server
    // derives the event id from it), so an indeterminate acknowledgement can be confirmed by id on a
    // later poll. Unlike prompt/command/compact the skill endpoint is NOT durably admitted by id, so
    // the id is only ever used for correlation — never for an automatic retry, which could defect on
    // a duplicate event id.
    const skillRequestID = createMessageRequestID()
    setComposer("")
    setActivatingSkill(skillName)
    setActionNotice(t('help.skillActivating'))
    setRuntimeError(null)
    const optimisticMessage = createOptimisticUserMessage(session.id, input, undefined, skillRequestID)
    setOptimisticUserMessages((current) => [...current, optimisticMessage])
    awaitingAssistantBaselineRef.current = assistantResponseSignature
    completionShouldPlayRef.current = true
    setAwaitingAssistantReply(true)
    setBusySending(true)
    scrollMessagesToBottom("smooth")
    try {
      // The v1 compatibility surface deliberately rejects this method, but shares the v2 signature;
      // the proxy routes the same call to the live v2 client for OpenCode 2.
      await sendSkillV2(config, session.id, skillName, session.directory, skillRequestID)
      if (!isLeaseContextCurrent(lease)) return
      // A successful 204 is the commit point. Refreshes are best-effort and must not turn a
      // completed activation into a failed command or put the slash text back in the composer.
      clearParkedDraft(session.id)
      setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
      setActionNotice(t('help.skillActivated', { skill: skill.name }))
      let refreshFailed = false
      try {
        await loadSelected(session.id, session.directory)
      } catch {
        refreshFailed = true
      }
      try {
        if (!(await refreshSessions(false, undefined, true))) refreshFailed = true
      } catch {
        refreshFailed = true
      }
      if (refreshFailed && isLeaseContextCurrent(lease)) setActionNotice(t('help.skillRefreshFailed'))
    } catch (err) {
      if (isLeaseContextCurrent(lease)) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        if (!isIndeterminateDeliveryError(err)) {
          // Definite failure: the activation was never accepted, so the optimistic row is retired,
          // the draft is restored, and the failure is named as such.
          setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
          setComposer((current) => current || input)
          setAttachments((current) => current.length ? current : stagedAttachments)
          setRuntimeError(t('help.skillActivationFailed', { skill: skill.name, message: (err as Error).message }))
        } else {
          // Indeterminate delivery: the 204 may have been lost after the server activated the skill.
          // The skill endpoint is not durably admitted by id, so re-POSTing can defect on a duplicate
          // event id — never retry automatically. Keep the tagged optimistic row as the visible trace
          // and reconcile: a poll that surfaces the projected skill message under the original
          // request id confirms the activation (loadSelected retires the row and announces it).
          pendingSkillRequestsRef.current.set(skillRequestID, { sessionID: session.id, skillName: skill.name })
          setActionNotice(t('detail.deliveryIndeterminate'))
          void loadSelected(session.id, session.directory, true).catch(() => undefined)
          void refreshSessions(false, undefined, true).catch(() => undefined)
        }
      }
    } finally {
      if (isLeaseContextCurrent(lease)) {
        setBusySending(false)
        setActivatingSkill(null)
      }
      releaseMutation(lease)
    }
  }

  async function send() {
    // Read the ref here as well as after awaited work. The render-state check would
    // narrow sessionActionPending for the rest of this function, even though the ref
    // is the live guard needed to catch a fork that starts while this send is pending.
    // F2: while a fork is pending (reconcile window), refuse dispatch outright — an in-flight
    // prompt could otherwise be orphaned by the reconcile navigation that follows. Compaction
    // deliberately keeps its queue window instead (see promptDelivery below).
    if (sessionActionPendingRef.current === "fork") return
    if (!selectedSession || isSessionMutationLocked()) return
    const text = composer.trim()
    // An image with no caption is a complete prompt, so emptiness is about both.
    if (!text && attachments.length === 0) return
    setActionNotice(null)

    if (text.startsWith("/")) {
      const normalized = text.slice(1)
      const command = normalized.split(" ")[0]?.trim() ?? ""
      const args = normalized.slice(command.length).trim()
      const localCommand = command.toLowerCase()

      if (localCommand === "help" || localCommand === "commands" || localCommand === "skills") {
        setComposer("")
        setRuntimeError(null)
        setCommandFilter(localCommand === "skills" ? "skill" : "all")
        setHelpPage("commands")
        setView("help")
        return
      }

      if (!command) return

      if (localCommand === "status") {
        const status = [
          `Connection: ${connectionStatusText || connectionState}`,
          `Server: ${hasConfiguredServer ? `${config.host}:${config.port}` : "not configured"}`,
          `Session: ${selectedSession.title} (${selectedSession.status})`,
          `Directory: ${selectedSession.directory}`,
          `Agent: ${activeAgent?.name ?? activeAgentID}`,
          `Model: ${activeModelOption ? `${activeModelOption.providerName} / ${activeModelOption.modelName}` : "default"}`
        ].join("\n")
        setComposer("")
        setRuntimeError(null)
        setOptimisticUserMessages((current) => [
          ...current,
          createOptimisticUserMessage(selectedSession.id, text),
          createLocalAssistantMessage(selectedSession.id, status)
        ])
        scrollMessagesToBottom("smooth")
        return
      }

      let availableCommands = commands
      const commandLease = acquireMutation("command")
      if (!commandLease) return
      const commandContext = commandLease.context
      const commandForkGeneration = commandLease.forkGeneration
      if (availableCommands.length === 0) {
        try {
          availableCommands = await api.listCommands(config)
          // Fork can begin while command discovery is in flight. Do not let the
          // stale closure dispatch a command or update command state afterwards.
           if (!isLeaseContextCurrent(commandLease)) { releaseMutation(commandLease); return }
           if (!mutationCoordinator.isContextCurrent(commandContext) || !mutationCoordinator.isForkGenerationCurrent(commandForkGeneration)) { releaseMutation(commandLease); return }
          setCommands(availableCommands)
        } catch (err) {
          if (!isLeaseContextCurrent(commandLease)) { releaseMutation(commandLease); return }
          if (!mutationCoordinator.isContextCurrent(commandContext) || !mutationCoordinator.isForkGenerationCurrent(commandForkGeneration)) { releaseMutation(commandLease); return }
          setRuntimeError(`Cannot load server commands: ${(err as Error).message}`)
          releaseMutation(commandLease)
          return
        }
      }

      if (!isLeaseContextCurrent(commandLease)) { releaseMutation(commandLease); return }
      if (!mutationCoordinator.isContextCurrent(commandContext) || !mutationCoordinator.isForkGenerationCurrent(commandForkGeneration)) { releaseMutation(commandLease); return }

      const matchingCommand = availableCommands.find((item) => item.name === command)
      if (!matchingCommand) {
        const available = availableCommands.map((item) => `/${item.name}`).join(", ")
        if (isLeaseContextCurrent(commandLease)) setRuntimeError(`Command not found: "/${command}". Available commands: ${available}`)
        releaseMutation(commandLease)
        return
      }

      if (matchingCommand.source === "skill") {
        releaseMutation(commandLease)
        if (!mutationCoordinator.isContextCurrent(commandContext) || !mutationCoordinator.isForkGenerationCurrent(commandForkGeneration)) return
        await activateSkill(matchingCommand, text, attachments)
        return
      }

      setComposer("")
      const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text)
      setOptimisticUserMessages((current) => [...current, optimisticMessage])
      awaitingAssistantBaselineRef.current = assistantResponseSignature
      completionShouldPlayRef.current = true
      setAwaitingAssistantReply(true)
      scrollMessagesToBottom("smooth")
      // Stable durable admission id for the resolved prompt input (see sendPrompt).
      const commandRequestID = createMessageRequestID()

      setBusySending(true)
      setRuntimeError(null)
      try {
        const admission = await sendCommandV2(config, selectedSession.id, command, args, selectedSession.directory, activeModel, activeAgentID, commandRequestID)
        if (!isLeaseContextCurrent(commandLease)) return
        // sendCommand is the commit boundary. The composer was flushed, so any parked draft for
        // this session must not resurrect the dispatched command on a round-trip.
        clearParkedDraft(selectedSession.id)
        // Tag the optimistic row with the durable admission metadata instead of removing it: the
        // exact message id retires the bubble by id once the resolved prompt reaches history (or the
        // inbox), and the server-recorded delivery keeps any queued status visible in the meantime.
        setOptimisticUserMessages((current) => current.map((message) =>
          message.info.id === optimisticMessage.info.id
            ? { ...message, info: { ...message.info, durableID: admission?.messageID, delivery: admission?.delivery ?? message.info.delivery } }
            : message))
        // sendCommand is the commit boundary. History/session refreshes are best effort and must
        // not make a successfully dispatched command look retryable or restore its draft.
        let refreshFailed = false
        try {
          await loadSelected(selectedSession.id, selectedSession.directory)
        } catch {
          refreshFailed = true
        }
        try {
          if (!(await refreshSessions(false, undefined, true))) refreshFailed = true
        } catch {
          refreshFailed = true
        }
        if (refreshFailed && isLeaseContextCurrent(commandLease)) {
          setActionNotice("Command sent, but the session view could not be refreshed. Please refresh to see the latest state.")
        }
      } catch (err) {
        if (isLeaseContextCurrent(commandLease)) {
          completionShouldPlayRef.current = false
          setAwaitingAssistantReply(false)
          if (!isIndeterminateDeliveryError(err)) {
            setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
            setComposer((current) => current || text)
            setAttachments((current) => current.length ? current : attachments)
            setRuntimeError((err as Error).message)
          } else {
            // Indeterminate delivery: one idempotent retry with the SAME id either confirms the
            // earlier admission (409 conflict) or performs it — never dispatches the command twice.
            // The resolved prompt is admitted durably under the request id, so a confirmed retry
            // tags the row with that exact id for retirement by id on the next poll.
            let resolved = false
            try {
              const readmission = await sendCommandV2(config, selectedSession.id, command, args, selectedSession.directory, activeModel, activeAgentID, commandRequestID)
              resolved = true
              if (readmission?.messageID) {
                setOptimisticUserMessages((current) => current.map((message) =>
                  message.info.id === optimisticMessage.info.id
                    ? { ...message, info: { ...message.info, durableID: readmission.messageID, delivery: readmission.delivery ?? message.info.delivery } }
                    : message))
              } else {
                // A 204-style admission without the envelope: the durable admission key is the
                // request id itself, which the resolved prompt will carry.
                setOptimisticUserMessages((current) => current.map((message) =>
                  message.info.id === optimisticMessage.info.id
                    ? { ...message, info: { ...message.info, durableID: commandRequestID } }
                    : message))
              }
            } catch (retryErr) {
              if (isAdmissionConflict(retryErr)) {
                resolved = true
                // The request id was durably admitted; the resolved prompt surfaces under that id.
                setOptimisticUserMessages((current) => current.map((message) =>
                  message.info.id === optimisticMessage.info.id
                    ? { ...message, info: { ...message.info, durableID: commandRequestID } }
                    : message))
              }
            }
            if (resolved && isLeaseContextCurrent(commandLease)) {
              clearParkedDraft(selectedSession.id)
              setActionNotice(t('detail.deliveryAdmitted'))
              void loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
              void refreshSessions(false, undefined, true).catch(() => undefined)
            } else if (isLeaseContextCurrent(commandLease)) {
              // Still unknown after the idempotent retry. The resolved prompt is admitted durably
              // under the request id when the transmission landed — and its history text differs from
              // the typed slash command, so text matching could never retire this row — tag it with
              // the stable request id so a surfacing message retires it by exact id instead.
              setOptimisticUserMessages((current) => current.map((message) =>
                message.info.id === optimisticMessage.info.id
                  ? { ...message, info: { ...message.info, durableID: commandRequestID } }
                  : message))
              setActionNotice(t('detail.deliveryIndeterminate'))
              void loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
              void refreshSessions(false, undefined, true).catch(() => undefined)
            }
          }
        }
      } finally {
        if (isLeaseContextCurrent(commandLease)) {
          setBusySending(false)
        }
        releaseMutation(commandLease)
      }
      return
    }

    const promptLease = acquireMutation("prompt")
    if (!promptLease) return
    // Preserve the normal working follow-up contract (`attachments, isWorking ? "queue" : "steer"`)
    // and extend it to the whole window where compaction has acknowledged but is not terminal. The
    // ref is the synchronous authority, so a send that lands in the same tick as a pending compact
    // still queues instead of steering a prompt into the compaction.
    const promptDelivery = (sessionActionPendingRef.current === "compact" || sessionActionPending === "compact")
      ? "queue"
      : (isWorking ? "queue" : "steer")
    // Stable durable admission id: a lost acknowledgement can be retried with the SAME id, which the
    // server answers with 409 (already admitted) instead of admitting the prompt twice.
    const promptRequestID = createMessageRequestID()
    setComposer("")
    setAttachments([])
    const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text, promptDelivery)
    setOptimisticUserMessages((current) => [...current, optimisticMessage])
    awaitingAssistantBaselineRef.current = assistantResponseSignature
    completionShouldPlayRef.current = true
    setAwaitingAssistantReply(true)
    scrollMessagesToBottom("smooth")

    setBusySending(true)
    setRuntimeError(null)
    let promptDispatched = false
    try {
      const admission = await sendPromptV2(config, selectedSession.id, text, selectedSession.directory, activeModel, activeAgentID, attachments, promptDelivery, promptRequestID)
      promptDispatched = true
      // The user has acted on this session: a remembered terminal/error state must not linger.
      executionMemoryRef.current.delete(selectedSession.id)
      if (!isLeaseContextCurrent(promptLease)) return
      // Dispatch is the commit boundary for the parked draft too: the composer was flushed, so a
      // parked entry from a previous visit must not resurrect this prompt on a round-trip.
      clearParkedDraft(selectedSession.id)
      // Tag the optimistic row with the durable admission metadata instead of removing it: the exact
      // message id retires the bubble by id once the prompt reaches history (or the inbox), and the
      // server-recorded delivery keeps the queued status visible until the inbox stops listing it.
      setOptimisticUserMessages((current) => current.map((message) =>
        message.info.id === optimisticMessage.info.id
          ? { ...message, info: { ...message.info, durableID: admission?.messageID, delivery: admission?.delivery ?? message.info.delivery } }
          : message))
      // Dispatch is the commit boundary. A history/sidebar refresh is best effort and must never
      // turn a prompt that the server accepted into a retryable send failure or restore its draft.
      let refreshFailed = false
      try {
        await loadSelected(selectedSession.id, selectedSession.directory)
      } catch {
        refreshFailed = true
      }
      try {
        if (!(await refreshSessions(false, undefined, true))) refreshFailed = true
      } catch {
        refreshFailed = true
      }
      if (refreshFailed && isLeaseContextCurrent(promptLease)) {
        setActionNotice("Message sent, but the session view could not be refreshed. Please refresh to see the latest state.")
      }
    } catch (err) {
      if (isLeaseContextCurrent(promptLease) && isIndeterminateDeliveryError(err)) {
        // The response was lost after transmission. The server admits durably under the request id,
        // so exactly one idempotent retry with the same id confirms the earlier admission (409) or
        // performs it — it can never send the prompt twice. A confirmed retry tags the row with the
        // exact durable id so retirement is by id, never by text.
        let resolved = false
        try {
          const readmission = await sendPromptV2(config, selectedSession.id, text, selectedSession.directory, activeModel, activeAgentID, attachments, promptDelivery, promptRequestID)
          resolved = true
          if (readmission?.messageID) {
            setOptimisticUserMessages((current) => current.map((message) =>
              message.info.id === optimisticMessage.info.id
                ? { ...message, info: { ...message.info, durableID: readmission.messageID, delivery: readmission.delivery ?? message.info.delivery } }
                : message))
          } else {
            // An admission without the envelope: the durable admission key is the request id itself.
            setOptimisticUserMessages((current) => current.map((message) =>
              message.info.id === optimisticMessage.info.id
                ? { ...message, info: { ...message.info, durableID: promptRequestID } }
                : message))
          }
        } catch (retryErr) {
          if (isAdmissionConflict(retryErr)) {
            resolved = true
            // The request id was durably admitted; the prompt surfaces under that exact id.
            setOptimisticUserMessages((current) => current.map((message) =>
              message.info.id === optimisticMessage.info.id
                ? { ...message, info: { ...message.info, durableID: promptRequestID } }
                : message))
          }
        }
        if (resolved && isLeaseContextCurrent(promptLease)) {
          promptDispatched = true
          // The retry confirmed the admission: the user's prompt went through, so the remembered
          // terminal/error state for this session must not linger.
          executionMemoryRef.current.delete(selectedSession.id)
          clearParkedDraft(selectedSession.id)
          setActionNotice(t('detail.deliveryAdmitted'))
          void loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
          void refreshSessions(false, undefined, true).catch(() => undefined)
        } else if (isLeaseContextCurrent(promptLease)) {
          // Still unknown after the idempotent retry. The server admits durably under the request id
          // when the transmission landed, so tag the row with that stable id: if the prompt surfaces
          // (in the inbox or history) it retires by exact id; if it never landed, the row stays as
          // the visible trace of the indeterminate send.
          setOptimisticUserMessages((current) => current.map((message) =>
            message.info.id === optimisticMessage.info.id
              ? { ...message, info: { ...message.info, durableID: promptRequestID } }
              : message))
          setActionNotice(t('detail.deliveryIndeterminate'))
          void loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
          void refreshSessions(false, undefined, true).catch(() => undefined)
        }
      } else if (isLeaseContextCurrent(promptLease)) setRuntimeError((err as Error).message)
      if (!promptDispatched && !isIndeterminateDeliveryError(err) && isLeaseContextCurrent(promptLease)) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
        setComposer((current) => current || text)
        // Losing a staged image to a failed send would mean picking it out of the gallery again.
        setAttachments((current) => current.length ? current : attachments)
      }
    } finally {
      if (isLeaseContextCurrent(promptLease)) {
        setBusySending(false)
      }
      releaseMutation(promptLease)
    }
  }

  async function deleteSession(sessionID: string) {
    if (isSessionMutationLocked()) return
    // Capture the target namespace and directory before awaiting the delete. Navigation may change
    // the selected session while the server is processing this request, but a successful delete
    // still needs a tombstone in the same profile/config namespace.
    const deleteTarget = sessions.find((session) => session.id === sessionID) ?? sessionToDelete
    const deleteContext = {
      profileID: activeProfileID,
      configKey: configKey(config),
      sessionID: sessionID
    }
    const deleteDirectory = deleteTarget?.directory
    const lease = acquireMutation("delete", sessionID)
    if (!lease) return
    try {
       await api.deleteSession(config, sessionID, deleteDirectory)
       // The server may continue returning a recently deleted row for a short time. Persist the
       // tombstone in the captured namespace regardless of where navigation ended up; only the
       // visible list and selection below are allowed to depend on the current namespace.
        const tombstoneKey = deleteContext.profileID + "\u0000" + deleteContext.configKey
        const persistedTombstoneKey = tombstoneNamespaceKey(deleteContext.profileID, deleteContext.configKey)
        const tombstones = mergedSessionTombstones(removedSessionIDsRef.current, tombstoneKey, persistedTombstoneKey)
        tombstones.add(sessionID)
        removedSessionIDsRef.current.set(tombstoneKey, tombstones)
        removedSessionIDsRef.current.set(persistedTombstoneKey, tombstones)
        persistSessionTombstones(removedSessionIDsRef.current)
       // Lease currency includes the session, so it is intentionally too strict for this part:
      // moving to another session does not make persistence of this deletion unsafe. Profile/config
      // changes do, because their session list is a different namespace.
      const currentDeleteContext = mutationCoordinator.getContext()
      const sameNamespace = currentDeleteContext?.profileID === deleteContext.profileID
        && currentDeleteContext.configKey === deleteContext.configKey
       if (sameNamespace) {
         setSessions((current) => current.filter((item) => item.id !== sessionID))
      }
      if (sameNamespace && currentDeleteContext?.sessionID === sessionID) {
        // Remove the row and invalidate navigation before any refresh can reintroduce it.
        replaceMutationContext(null)
        // The tombstone intentionally survives this session-only context replacement so an
        // eventual-consistency refresh (and navigation) cannot resurrect the deleted row.
         setSelectedID(null)
        setMessages([])
        loadedMessagesRef.current = []
        setOptimisticUserMessages([])
        setTodos([])
        setDiffFiles([])
        setProjectDashboard(null)
        setDashboardError(null)
        setView("sessions")
      }
      setSessionToDelete(null)
      await refreshSessions(true)
    } catch (err) {
      if (isLeaseContextCurrent(lease)) setRuntimeError((err as Error).message)
    } finally {
      releaseMutation(lease)
    }
  }

  async function renameSession(sessionID: string, newTitle: string, directory: string) {
    if (!newTitle.trim() || isSessionMutationLocked()) return
    const lease = acquireMutation("rename", sessionID)
    if (!lease) return
    try {
      await api.renameSession(config, sessionID, newTitle.trim(), directory)
      if (!isLeaseContextCurrent(lease)) return
      setRenamingSessionID(null)
      setRenameValue("")
      await refreshSessions(true)
    } catch (err) {
      if (isLeaseContextCurrent(lease)) setRuntimeError((err as Error).message)
    } finally {
      releaseMutation(lease)
    }
  }

  // The session list (mobile panel and desktop sidebar) and the detail header both offer a rename
  // affordance for the same session — on desktop the sidebar always shows the open session, so
  // without this, renaming from either place would flip both into edit mode at once (and fight
  // over the single renameInputRef). Track which one is active so only that side switches to the
  // input.
  function startRename(session: SessionView, source: "list" | "header" = "list") {
    if (isSessionMutationLocked()) return
    setRenameValue(session.title)
    setRenamingSessionID(session.id)
    setRenameSource(source)
    // Focus the input after render
    setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 50)
  }

  function cancelRename() {
    setRenamingSessionID(null)
    setRenameSource(null)
    setRenameValue("")
  }

  async function abortSession() {
    const target = selectedSession
    const activeLease = mutationCoordinator.getActiveLease()
    const abortContext = mutationCoordinator.getContext()
    const abortContextGeneration = mutationCoordinator.getContextGeneration()
    const abortKey = abortContext
      ? `${abortContext.profileID}\u0000${abortContext.configKey}\u0000${abortContext.sessionID ?? ""}`
      : ""
    const canAbort = Boolean(target && isWorking && abortContext && abortContext.sessionID === target.id
      && !abortInFlightRef.current.has(abortKey)
      && (!activeLease
        || (activeLease.context.profileID === abortContext.profileID
          && activeLease.context.configKey === abortContext.configKey
          && activeLease.context.sessionID === abortContext.sessionID
          && activeLease.targetSessionID === target.id
          && (activeLease.kind === "prompt" || activeLease.kind === "command" || activeLease.kind === "skill"))))
    if (!target || !canAbort) return
    // A prompt/command/skill owns the coordinator lease while it waits for the backend. Do not
    // steal or release that lease: abort is an out-of-band request and the original owner still
    // needs to finish its cleanup safely.
    const lease = activeLease ? null : acquireMutation("abort")
    if (!activeLease && !lease) return
    if (!abortContext) {
      if (lease) releaseMutation(lease)
      return
    }
    setAbortPresentationContext(abortKey)
    bumpMutationLock((value) => value + 1)
    let operation!: Promise<void>
    operation = (async () => {
      const sameContext = () => mutationCoordinator.isContextGenerationCurrent(abortContextGeneration)
        && mutationCoordinator.isContextCurrent(abortContext)
      try {
        await api.abort(config, target.id, target.directory)
        // The original prompt lease may have released by now. Currency is the full captured
        // profile/config/session context, not ownership of that lease.
        if (!sameContext()) return
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        await refreshSessions()
        if (!sameContext()) return
        await loadSelected(target.id, target.directory)
      } catch (err) {
        if (sameContext()) setRuntimeError((err as Error).message)
      } finally {
        if (lease) releaseMutation(lease)
        if (abortInFlightRef.current.get(abortKey) === operation) {
          abortInFlightRef.current.delete(abortKey)
          if (sameContext()) {
            setAbortPresentationContext(null)
          }
          // The registry is part of the synchronous mutation-lock presentation even when this
          // operation belongs to a context the user has already left.
          bumpMutationLock((value) => value + 1)
        }
      }
    })()
    abortInFlightRef.current.set(abortKey, operation)
  }

  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  }, [language])

  // Android back: dismiss whatever is on top, then fall back to the session list,
  // and only leave the app from there. Reads state through a ref because the
  // handler is registered once and must not capture a stale view.
  const backStateRef = useRef({ view, activeDetailSheet, sessionToDelete, renamingSessionID })
  backStateRef.current = { view, activeDetailSheet, sessionToDelete, renamingSessionID }
  /** M3: fork reconciliation runs detached from renders, so it reads navigation state through refs —
   *  mainView (which layout is on screen) and selectedSession (which session is open). */
  const mainViewRef = useRef(mainView)
  mainViewRef.current = mainView

  useEffect(() => {
    if (!isAndroidPlatform(Capacitor.getPlatform())) return
    let handle: PluginListenerHandle | undefined
    let removed = false
    void CapacitorApp.addListener("backButton", () => {
      const state = backStateRef.current
      if (state.sessionToDelete) {
        setSessionToDelete(null)
        return
      }
      if (state.renamingSessionID) {
        setRenamingSessionID(null)
        return
      }
      if (state.activeDetailSheet) {
        setActiveDetailSheet(null)
        return
      }
      if (state.view !== "sessions") {
        setView("sessions")
        return
      }
      CapacitorApp.exitApp()
    }).then((registered) => {
      // The effect can be torn down before registration resolves.
      if (removed) void registered.remove()
      else handle = registered
    })
    return () => {
      removed = true
      void handle?.remove()
    }
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    function applyThemePreference() {
      const resolvedTheme = theme === "system" && mediaQuery.matches ? "dark" : theme === "dark" ? "dark" : "light"
      document.documentElement.dataset.theme = resolvedTheme
      document.documentElement.style.colorScheme = resolvedTheme
    }

    localStorage.setItem(THEME_STORAGE_KEY, theme)
    applyThemePreference()
    mediaQuery.addEventListener("change", applyThemePreference)
    return () => mediaQuery.removeEventListener("change", applyThemePreference)
  }, [theme])

  useEffect(() => {
    persistServerProfiles(profiles, activeProfileID)
  }, [])

  useEffect(() => {
    localStorage.setItem(NEW_SESSION_DIRECTORY_STORAGE_KEY, newSessionDirectory)
  }, [newSessionDirectory])

  useEffect(() => {
    selectedSessionRef.current = selectedSession
  }, [selectedSession])

  useEffect(() => {
    eventStreamStateRef.current = eventStreamState
  }, [eventStreamState])

  useEffect(() => {
    if (configKey(draftConfig) === configKey(config)) return
    // A half-typed host such as `http://` cannot be turned into a URL. Persisting it
    // would also poison the next launch, so incomplete drafts are simply not applied.
    if (draftConfig.host.trim() && !isValidServerConfig(draftConfig)) return
    const timer = setTimeout(() => applyConfig(draftConfig), 500)
    return () => clearTimeout(timer)
  }, [draftConfig, config])

  useEffect(() => {
    if (!selectedSession) {
      setModelOptions([])
      setModelLoadError(null)
      return
    }
    loadModels(selectedSession.id, selectedSession.directory).catch(() => undefined)
  }, [config.backend, config.host, config.port, config.username, config.password, selectedSession?.id])

  useEffect(() => {
    if (!isValidServerConfig(config)) {
      setConnectionState("idle")
      setConnectionMessage("")
      return
    }
    setConnectionState("connecting")
    setConnectionMessage(t('connection.connecting'))
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
    refreshSessions(true).catch(() => undefined)
    loadCommands().catch(() => undefined)
    if (capabilities.agents) loadAgents().catch(() => undefined)
    if (capabilities.models) loadModels().catch(() => undefined)
    const timer = setInterval(() => {
      // Live SSE events already keep sessions and the open session's messages/todos/diffs in sync
      // (via applyStreamedPartUpdate/scheduleRefresh), so polling on top of a working stream is a
      // redundant full refetch. But "connected" only proves the stream is open, not that it carries
      // this session: opencode emits events on an in-process bus, so a session driven by a *different*
      // opencode process (a local TUI running its own server) never produces events here even though
      // the stream is perfectly healthy. Keep polling as a per-session fallback — skip it only while
      // the open session is actually receiving events.
      if (eventStreamStateRef.current === "live") {
        const openSession = selectedSessionRef.current
        if (openSession) {
          const lastEventAt = lastEventBySessionRef.current.get(openSession.id) ?? 0
          if (Date.now() - lastEventAt < SESSION_STREAM_QUIET_MS) return
        }
      }
      refreshSessions(true).catch(() => undefined)
      if (selectedSession) {
        loadSelected(selectedSession.id, selectedSession.directory).catch(() => undefined)
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [capabilities.agents, capabilities.models, config.backend, config.host, config.port, config.username, config.password, selectedSession?.id, selectedNewSessionDirectory])

  useEffect(() => {
    const fallback = DEFAULT_HARNESS_CAPABILITIES[config.backend]
    // A staged image belongs to the connection it was staged on, and the next server may not accept
    // images at all: dropping it here keeps the chips from outliving the control that made them.
    setAttachments([])
    setCapabilities(fallback)
    if (config.backend === "opencode" || config.backend === "opencode2" || !isValidServerConfig(config)) return
    api.capabilities(config).then(setCapabilities).catch(() => setCapabilities(fallback))
  }, [config.backend, config.host, config.port, config.username, config.password])

  useEffect(() => {
    if (!isValidServerConfig(config)) {
      setEventStreamState("idle")
      return
    }
    if (isDesktopPlatform() && desktopProfileSyncError) {
      setLiveEventError(desktopProfileSyncError)
      setEventStreamState("fallback")
      return
    }
    setEventStreamState("connecting")
    const desktop = isDesktopPlatform()
    let stream: { url: string; headers: Record<string, string> } | undefined
    if (!desktop) {
      try {
        stream = api.eventStream(config)
      } catch (error) {
        setLiveEventError((error as Error).message)
        setEventStreamState("fallback")
        return
      }
    }
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        refreshSessions(true).catch(() => undefined)
        const selected = selectedSessionRef.current
        if (selected) loadSelected(selected.id, selected.directory).catch(() => undefined)
      }, 250)
    }
    const onEvent = (event: { data: unknown; name: string }) => {
      const type = eventType(event.data) ?? event.name
      const payload = eventPayload(event.data)
      const body = (payload?.properties ?? payload?.data ?? payload) as
        | {
            sessionID?: string
            sessionId?: string
            message?: string
            part?: MessagePart
            messageID?: string
            partID?: string
            field?: string
            delta?: string
            info?: { id?: string; sessionID?: string }
          }
        | undefined
      if (type === "session.error" && body?.sessionId && body.sessionId === selectedSessionRef.current?.id) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        setBusySending(false)
        setRuntimeError(body.message ?? "The agent stopped with an error")
      }
      if (type === "session.execution.failed" && body?.sessionID === selectedSessionRef.current?.id) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        setBusySending(false)
        const error = body as { sessionID?: string; error?: { message?: string } }
        setRuntimeError(error.error?.message ?? "The agent stopped with an error")
      }
      if (type === "session.execution.started" && body?.sessionID) {
        const sessionID = body.sessionID
        if (sessionID === selectedSessionRef.current?.id) setAwaitingAssistantReply(true)
      }
      if (type === "session.execution.succeeded" && body?.sessionID) {
        const sessionID = body.sessionID
        if (sessionID === selectedSessionRef.current?.id) {
          setAwaitingAssistantReply(false)
          setBusySending(false)
        }
      }
      if (type === "message.part.updated" && body?.sessionID && body.part) {
        setMessages((current) => applyStreamedPartUpdate(current, body.sessionID!, body.part!))
      } else if (
        type === "message.part.delta" &&
        body?.sessionID &&
        body.messageID &&
        body.partID &&
        body.field &&
        typeof body.delta === "string"
      ) {
        setMessages((current) =>
          applyStreamedPartDelta(current, body.sessionID!, body.messageID!, body.partID!, body.field!, body.delta!)
        )
      }
      // v2-only: fold execution lifecycle events into the per-session execution memory (issue #8).
      // The memory survives SSE reconnects, so a status derived later still knows the session crashed.
      if (config.backend === "opencode2") {
        const sessionID = body?.sessionID ?? body?.sessionId ?? body?.info?.sessionID ?? body?.info?.id
        const kind = executionEventKind(type)
        if (sessionID && kind) {
          executionMemoryRef.current.set(sessionID, reduceExecutionEvent(executionMemoryRef.current.get(sessionID), {
            kind,
            at: Date.now(),
            sessionID,
            error: (body as { error?: { message?: string } } | undefined)?.error,
            attempt: (body as { attempt?: number } | undefined)?.attempt,
            next: typeof (body as { at?: number } | undefined)?.at === "number" ? (body as { at?: number }).at : undefined
          }))
        }
      }
      if (type.startsWith("session.") || type.startsWith("message.") || type.startsWith("todo.") || type.startsWith("question.") || type.startsWith("permission.")) {
        // `session.*` events carry the id on the session itself; `message.*`/`todo.*` use sessionID.
        const sessionID = body?.sessionID ?? body?.sessionId ?? body?.info?.sessionID ?? body?.info?.id
        if (sessionID) lastEventBySessionRef.current.set(sessionID, Date.now())
        setLiveEventCount((count) => count + 1)
        scheduleRefresh()
      }
    }
    const onStatus = (status: EventStreamStatus) => {
      if (status.type === "connected") {
        setLiveEventError(null)
        setEventStreamState("live")
      }
      if (status.type === "reconnecting") setEventStreamState("reconnecting")
      if (status.type === "connection-error") {
        setLiveEventError(status.error)
        setEventStreamState("fallback")
      }
    }
    let subscription: { close(): void }
    if (desktop) {
      const profileID = desktopProfileID(config)
      if (!profileID) {
        setLiveEventError("Unknown desktop server profile")
        setEventStreamState("fallback")
        return
      }
      subscription = createDesktopOpenCodeEventSubscription({ profileId: profileID, scope: "global", onEvent, onStatus })
    } else if (isNativeEventTransport()) {
      subscription = createNativeOpenCodeEventSubscription({
        url: stream!.url,
        username: config.username,
        password: config.password,
        onEvent,
        onStatus
      })
    } else {
      subscription = createFetchOpenCodeEventSubscription({ url: stream!.url, headers: stream!.headers, onEvent, onStatus })
    }
    return () => {
      clearTimeout(refreshTimer)
      subscription.close()
    }
  }, [config.backend, config.host, config.port, config.username, config.password, desktopProfileRevision, desktopProfileSyncError])

  useEffect(() => {
    if (!hasConfiguredServer) {
      setView("settings")
    }
  }, [hasConfiguredServer])

  // useJumpAffordances watches window scroll for the jump buttons already; this listener is here for
  // the auto-scroll pin, which must also break when the user scrolls the page rather than the list.
  useEffect(() => {
    const onWindowScroll = () => {
      stickToBottomRef.current = isNearMessagesBottom()
    }
    window.addEventListener("scroll", onWindowScroll, { passive: true })
    return () => window.removeEventListener("scroll", onWindowScroll)
  }, [])

  useEffect(() => {
    if (view !== "detail") return
    if (!stickToBottomRef.current) return
    scrollMessagesToBottom("auto")
  }, [view, renderedMessages, isWorking, showTypingBubble, pendingQuestions, pendingPermissions])

  // Growing or swapping the transcript changes the distance to each end without any scroll event
  // firing, so the jump buttons have to be re-evaluated off the content too.
  useEffect(() => {
    if (mainView !== "detail") return
    const frame = requestAnimationFrame(refreshChatJumps)
    return () => cancelAnimationFrame(frame)
  }, [mainView, selectedID, messageScrollSignature, refreshChatJumps])

  // Same for the sessions list: filtering or a refresh changes its length under a static scroll offset.
  useEffect(() => {
    if (mainView !== "sessions") return
    const frame = requestAnimationFrame(refreshSessionJumps)
    return () => cancelAnimationFrame(frame)
  }, [mainView, query, filteredSessions.length, refreshSessionJumps])

  // The desktop sidebar list is always on screen, so it only depends on its own length, and on the
  // sidebar width, which reflows the rows.
  useEffect(() => {
    if (!isDesktop) return
    const frame = requestAnimationFrame(refreshSidebarJumps)
    return () => cancelAnimationFrame(frame)
  }, [isDesktop, query, filteredSessions.length, viewportSidebarWidth, refreshSidebarJumps])

  useEffect(() => {
    if (view !== "detail" || !selectedID) return
    const container = messagesRef.current
    if (!container) return
    // Opening a session should always land at the bottom, regardless of where a previous session left off.
    stickToBottomRef.current = true
    scrollMessagesToBottom("auto")
    // Tool/diff parts fetch their content asynchronously and grow after the
    // initial layout, so keep pinning to the bottom while that settles — but only while the
    // user hasn't scrolled away from it.
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollMessagesToBottom("auto")
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [view, selectedID])

  // Mobile detail and sessions share the window scroller. Leaving a long transcript therefore
  // preserves a large page offset which is usually clamped to the end of the shorter sessions page.
  // Restore the selected card after React has committed and the replacement page has laid out. This
  // single path also covers the Android system back button, the header button and bottom navigation.
  useEffect(() => {
    if (isDesktop || mainView !== "sessions" || !selectedID) return
    let innerFrame = 0
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".session-card.active")?.scrollIntoView({ block: "center" })
      })
    })
    return () => {
      cancelAnimationFrame(outerFrame)
      if (innerFrame) cancelAnimationFrame(innerFrame)
    }
  }, [isDesktop, mainView, selectedID])

  useEffect(() => {
    loadedMessagesRef.current = messages
    if (!shouldAutoScrollRef.current) return
    shouldAutoScrollRef.current = false
    scrollMessagesToBottom("smooth")
  }, [messages])

  useEffect(() => {
    if (!awaitingAssistantReply) return
    if (assistantResponseSignature && assistantResponseSignature !== awaitingAssistantBaselineRef.current) {
      setAwaitingAssistantReply(false)
    }
  }, [assistantResponseSignature, awaitingAssistantReply])

  useEffect(() => {
    completionAudioRef.current = new Audio(`${import.meta.env.BASE_URL}audio/staplebops-01.aac`)
    completionAudioRef.current.preload = "auto"
  }, [])

  useEffect(() => {
    if (wasAwaitingAssistantReplyRef.current && !awaitingAssistantReply && completionShouldPlayRef.current) {
      completionShouldPlayRef.current = false
      const audio = completionAudioRef.current
      if (audio) {
        audio.currentTime = 0
        audio.play().catch(() => undefined)
      }
      notifyDesktopCompletion({
        title: t("notification.title"),
        body: t("notification.body"),
        overlayDescription: t("notification.overlayDescription")
      })
    }
    wasAwaitingAssistantReplyRef.current = awaitingAssistantReply
  }, [awaitingAssistantReply])
  useEffect(() => {
    if (!selectedSession) {
      wasRunningRef.current = false
      return
    }
    wasRunningRef.current = isSessionWorking(selectedSession.status)
  }, [selectedSession?.id, selectedSession?.status])

  const navItems = [
    { view: "sessions" as const, label: t('nav.sessions'), icon: <FolderIcon size={19} />, disabled: !hasConfiguredServer },
    { view: "detail" as const, label: t('nav.detail'), icon: <ChatIcon size={19} />, disabled: !selectedSession },
    { view: "settings" as const, label: t('nav.settings'), icon: <SettingsIcon size={19} />, disabled: false },
    { view: "help" as const, label: t('nav.help'), icon: <HelpIcon size={19} />, disabled: false }
  ]

  const serverProfileSummaries = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    backendLabel: backendDisplayName(profile.config.backend),
    backendClass: profile.config.backend,
    address: profile.config.host ? `${profile.config.host}:${profile.config.port}` : t('settings.hostPlaceholder')
  }))

  const brandBlock = (
    <>
      <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" className="app-icon" />
      <div className="brand-text">
        <h1>{t('app.title')}</h1>
      </div>
    </>
  )

  /* One dispatcher behind the in-app menu bar, the packaged app's native menu and the command
     palette. Three surfaces offering the same verbs is only an improvement while they cannot
     disagree about what those verbs do or when they are available. */
  function runAppCommand(id: string) {
    switch (id) {
      case "session.new":
        if (!hasConfiguredServer || isOffline || isSessionMutationLocked()) return
        void openNewSessionPicker()
        return
      case "session.refresh":
        void refreshSessionsWithIndicator().catch(() => undefined)
        return
      case "session.rename":
        if (isSessionMutationLocked()) return
        if (selectedSession) startRename(selectedSession, "header")
        return
      case "session.delete":
        if (isSessionMutationLocked()) return
        if (selectedSession) setSessionToDelete(selectedSession)
        return
      case "session.stop":
        void abortSession()
        return
      case "session.undo":
        if (sessionActionPending !== null) return
        void runNativeHistoryCommand("undo")
        return
      case "session.redo":
        if (sessionActionPending !== null) return
        void runNativeHistoryCommand("redo")
        return
      case "focus.composer":
        setView("detail")
        // The pane it lives in may only mount on this render, so reach for it on the next frame.
        requestAnimationFrame(() => composerInputRef.current?.focus())
        return
      case "focus.search":
        if (!isDesktop) setView("sessions")
        requestAnimationFrame(() => searchInputRef.current?.focus())
        return
      case "server.add":
        setShowConnectWizard(true)
        return
      case "server.settings":
        setSettingsTab("server")
        setView("settings")
        return
      case "view.palette":
        setPaletteOpen(true)
        return
      case "view.inspector":
        setInspectorOpen((open) => !open)
        return
      case "view.sessions":
        setView("sessions")
        return
      case "view.theme.system":
        setTheme("system")
        return
      case "view.theme.light":
        setTheme("light")
        return
      case "view.theme.dark":
        setTheme("dark")
        return
      case "help.open":
        setView("help")
        return
      default:
        return
    }
  }
  const runAppCommandRef = useRef(runAppCommand)
  runAppCommandRef.current = runAppCommand

  // Keyboard shortcuts belong to the window, not to any one control, so they keep working while
  // focus is in the transcript or the sidebar. The composer's own Enter/Shift+Enter handling is
  // untouched: nothing here fires without a modifier.
  //
  // Skipped entirely where the platform menu owns the same accelerators, or every one of them would
  // fire twice — harmless for "New session", but a toggle run twice lands back where it started.
  useEffect(() => {
    if (usesNativeMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      const accelerator = IS_APPLE ? event.metaKey : event.ctrlKey
      if (!accelerator || event.altKey) return
      const command = commandForKeyEvent(event)
      if (!command) return
      event.preventDefault()
      runAppCommandRef.current(command)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [usesNativeMenu])

  // The packaged desktop app draws the platform's own menu bar; its items arrive here as commands
  // so the native menu and the in-app one stay a single implementation.
  useEffect(() => {
    return subscribeDesktopMenuCommands((id) => runAppCommandRef.current(id))
  }, [])

  const menuItem = (id: string, label: string, options: { disabled?: boolean; checked?: boolean } = {}): MenuEntry => ({
    kind: "item",
    id,
    label,
    shortcut: displayShortcut(id),
    disabled: options.disabled,
    checked: options.checked,
    onSelect: () => runAppCommand(id)
  })

  const menuDefinitions: MenuDefinition[] = [
    {
      id: "file",
      label: t('menubar.file'),
      entries: [
         menuItem("session.new", t('command.newSession'), { disabled: !hasConfiguredServer || isOffline || mutationLocked }),
          menuItem("session.refresh", t('command.refreshSessions'), { disabled: !hasConfiguredServer }),
        { kind: "separator", id: "file-sep" },
        menuItem("server.add", t('command.addServer')),
        menuItem("server.settings", t('command.openSettings'))
      ]
    },
    {
      id: "session",
      label: t('menubar.session'),
      entries: [
        menuItem("focus.composer", t('command.focusComposer'), { disabled: !selectedSession }),
         menuItem("session.stop", t('command.stopAgent'), { disabled: !canAbortSession }),
        { kind: "separator", id: "session-sep-1" },
        menuItem("session.undo", t('detail.undo'), { disabled: !sessionHeaderActions.some((action) => action.id === "undo" && !action.disabled) }),
        menuItem("session.redo", t('detail.redo'), { disabled: !sessionHeaderActions.some((action) => action.id === "redo" && !action.disabled) }),
        { kind: "separator", id: "session-sep-2" },
         menuItem("session.rename", t('session.renameTitle'), { disabled: !selectedSession || !capabilities.sessionRename || mutationLocked }),
         menuItem("session.delete", t('sessions.delete'), { disabled: !selectedSession || !capabilities.sessionDelete || mutationLocked })
      ]
    },
    {
      id: "view",
      label: t('menubar.view'),
      entries: [
        menuItem("view.palette", t('command.commandPalette')),
        menuItem("focus.search", t('command.searchSessions')),
        menuItem("view.inspector", t('command.toggleInspector'), { checked: inspectorOpen }),
        { kind: "separator", id: "view-sep" },
        menuItem("view.theme.system", t('settings.themeSystem'), { checked: theme === "system" }),
        menuItem("view.theme.light", t('settings.themeLight'), { checked: theme === "light" }),
        menuItem("view.theme.dark", t('settings.themeDark'), { checked: theme === "dark" })
      ]
    },
    {
      id: "help",
      label: t('menubar.help'),
      entries: [menuItem("help.open", t('command.openHelp'))]
    }
  ]

  /* Where the platform draws the menu, it is handed the same definitions the in-app bar would have
     rendered — labels, enabled state and all — so the two can only ever say the same thing. Sent on
     change rather than on every render: the signature is what the menu actually depends on, and the
     definitions are rebuilt each time the transcript ticks. */
  const nativeMenuTemplate = usesNativeMenu
    ? menuDefinitions.map((menu) => ({
        id: menu.id,
        label: menu.label,
        items: menu.entries.map((entry) => entry.kind === "separator"
          ? { kind: "separator" as const }
          : {
              kind: "item" as const,
              command: entry.id as DesktopMenuCommand,
              label: entry.label,
              accelerator: electronAccelerator(entry.id),
              enabled: !entry.disabled,
              checked: entry.checked
            })
      }))
    : null
  const nativeMenuSignature = nativeMenuTemplate ? JSON.stringify(nativeMenuTemplate) : ""
  useEffect(() => {
    if (!nativeMenuSignature) return
    setDesktopApplicationMenu(JSON.parse(nativeMenuSignature) as DesktopMenuTemplate)
  }, [nativeMenuSignature])

  const paletteCommands: PaletteCommand[] = [
     { id: "session.new", group: t('command.groupSession'), label: t('command.newSession'), hint: displayShortcut("session.new"), icon: <PlusIcon size={16} />, disabled: !hasConfiguredServer || isOffline || mutationLocked },
      { id: "session.refresh", group: t('command.groupSession'), label: t('command.refreshSessions'), hint: displayShortcut("session.refresh"), icon: <RefreshIcon size={16} />, disabled: !hasConfiguredServer },
     { id: "session.rename", group: t('command.groupSession'), label: t('session.renameTitle'), icon: <PencilIcon size={16} />, disabled: !selectedSession || !capabilities.sessionRename || mutationLocked },
     { id: "session.delete", group: t('command.groupSession'), label: t('sessions.delete'), icon: <TrashIcon size={16} />, disabled: !selectedSession || !capabilities.sessionDelete || mutationLocked },
      { id: "session.stop", group: t('command.groupSession'), label: t('command.stopAgent'), icon: <StopCircleIcon size={16} />, disabled: !canAbortSession },
     { id: "session.undo", group: t('command.groupSession'), label: t('detail.undo'), disabled: mutationLocked || !sessionHeaderActions.some((action) => action.id === "undo" && !action.disabled) },
     { id: "session.redo", group: t('command.groupSession'), label: t('detail.redo'), disabled: mutationLocked || !sessionHeaderActions.some((action) => action.id === "redo" && !action.disabled) },
    { id: "server.add", group: t('command.groupServer'), label: t('command.addServer'), icon: <ServerIcon size={16} /> },
    { id: "server.settings", group: t('command.groupServer'), label: t('command.openSettings'), hint: displayShortcut("server.settings"), icon: <SettingsIcon size={16} /> },
    { id: "view.palette", group: t('command.groupView'), label: t('command.commandPalette'), hint: displayShortcut("view.palette"), icon: <CommandIcon size={16} /> },
    { id: "view.inspector", group: t('command.groupView'), label: t('command.toggleInspector'), hint: displayShortcut("view.inspector"), icon: <PanelRightIcon size={16} />, disabled: !selectedSession || !hasRoomForInspector },
    { id: "view.theme.light", group: t('command.groupView'), label: t('settings.themeLight') },
    { id: "view.theme.dark", group: t('command.groupView'), label: t('settings.themeDark') },
    { id: "view.theme.system", group: t('command.groupView'), label: t('settings.themeSystem') },
    { id: "help.open", group: t('command.groupView'), label: t('command.openHelp'), icon: <HelpIcon size={16} /> }
  ]
    .map((command) => ({ ...command, run: () => runAppCommand(command.id) }))
    .concat(
      // Sessions are commands too: on a machine running a dozen of them, typing three letters of a
      // project name beats scrolling a sidebar for it.
      sessions.map((session) => ({
        id: `open-session-${session.id}`,
        group: t('command.groupOpenSession'),
        label: session.title,
        hint: shortDirectory(session.directory),
        keywords: session.directory,
        icon: <ChatIcon size={16} />,
        run: () => void openSession(session.id, session.directory).catch(() => undefined)
      }))
    )
    .concat(
      profiles
        .filter((profile) => profile.id !== activeProfileID)
        .map((profile) => ({
          id: `switch-server-${profile.id}`,
          group: t('command.groupServer'),
          label: t('command.switchTo', { name: profile.name }),
          hint: profile.config.host ? `${profile.config.host}:${profile.config.port}` : "",
          icon: <ServerIcon size={16} />,
          run: () => activateProfile(profile.id)
        }))
    )

  const serverSwitcher = (
    <ServerSwitcher
      profiles={serverProfileSummaries}
      activeProfileID={activeProfileID}
      connectionState={connectionState}
      connectionLabel={connectionStatusText || t('connection.connecting')}
      onSelect={activateProfile}
      onAddServer={() => setShowConnectWizard(true)}
      onManageServers={() => {
        setSettingsTab("server")
        setView("settings")
      }}
      addLabel={t('command.addServer')}
      manageLabel={t('command.manageServers')}
      ariaLabel={t('settings.serverProfile')}
    />
  )

  /* The AI controls and the project readout are the same panel wherever they appear: a bottom sheet
     on a phone, the right-hand inspector on a desktop. Written once, so the two can never drift. */
  const aiPanelContent = (
    <>
      {capabilities.agents && (primaryAgentOptions.length > 0 ? (
        <div className="agent-controls">
          <label htmlFor="agent-select">
            {t('detail.agentSelectLabel')}
            <select
              id="agent-select"
              value={activeAgentID}
              onChange={(event) => changeAgent(event.target.value)}
               disabled={isWorking || mutationLocked}
            >
              {primaryAgentOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>
              ))}
            </select>
          </label>
          <p className="subtle">
            {activeAgent?.description || t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}
          </p>
        </div>
      ) : (
        <p className="subtle">{agentLoadError ? t('detail.agentLoadError', { message: agentLoadError }) : t('detail.agentLoading')}</p>
      ))}
      {modelOptions.length > 0 ? (
        <div className="model-controls">
          <label htmlFor="model-search">
            {t('detail.modelSelectLabel')}
            <input
              id="model-search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder={t('detail.modelSearchPlaceholder')}
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="none"
              spellCheck={false}
               disabled={isWorking || mutationLocked}
              autoComplete="off"
            />
          </label>
          <div className="model-option-list" role="listbox" aria-label={t('detail.modelSelectLabel')}>
            {filteredModelOptions.length > 0 ? (
              filteredModelOptions.map((option) => {
                const optionKey = modelKey(option)
                const active = activeModelOption ? sameModel(option, activeModelOption) : optionKey === selectedModelKey
                return (
                  <button
                    type="button"
                    key={optionKey}
                    className={active ? "model-option active" : "model-option"}
                    onClick={() => changeModel(optionKey)}
                               disabled={isWorking || mutationLocked}
                    role="option"
                    aria-selected={active}
                  >
                    <span>
                      <strong>{option.modelName}</strong>
                      {/* The harness's own description carries the version — "Sonnet 5 ·
                          Efficient for routine tasks" — which is what someone picking a
                          model wants. The provider only earns the line when there is
                          nothing better, as with OpenCode. */}
                      <small>
                        {[option.description ?? option.providerName, option.variant].filter(Boolean).join(" · ")}
                      </small>
                    </span>
                    {option.isDefault && <em>{t('detail.modelDefault')}</em>}
                  </button>
                )
              })
            ) : (
              <p className="subtle model-empty">{t('detail.modelSearchEmpty')}</p>
            )}
          </div>
          {activeModelOption && (
            <div className="model-meta">
              <span>{t('detail.modelProvider', { provider: activeModelOption.providerName })}</span>
              <span>{t('detail.modelContext', { context: formatLimit(activeModelOption.contextLimit), output: formatLimit(activeModelOption.outputLimit) })}</span>
              <span>{activeModelOption.tools ? t('detail.modelToolsYes') : t('detail.modelToolsNo')}</span>
              {activeModelOption.variant && <span>{t('detail.modelVariant', { variant: activeModelOption.variant })}</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="subtle">
          {!capabilities.models
            ? t('detail.modelNotSupported')
            : modelLoadError ? t('detail.modelLoadError', { message: modelLoadError }) : t('detail.modelLoading')}
        </p>
      )}
    </>
  )

  const projectPanelContent = selectedSession ? (
    <>
      <div className="dashboard-card">
        <span className="dashboard-label">{t('detail.projectLabel')}</span>
        <strong>{projectName || selectedSession.directory}</strong>
        <small>{projectPath || selectedSession.directory}</small>
      </div>
      <div className="dashboard-card">
        <span className="dashboard-label">{t('detail.vcsLabel')}</span>
        <strong>{vcsBranch || t('detail.unavailable')}</strong>
        {projectDashboard?.vcs && (
          <small>{t('detail.aheadBehind', { ahead: projectDashboard.vcs.ahead ?? 0, behind: projectDashboard.vcs.behind ?? 0 })}</small>
        )}
      </div>
      <div className="dashboard-card">
        <span className="dashboard-label">{t('detail.fileStatusLabel')}</span>
        <strong>{diffFiles.length > 0 ? t('detail.filesCount', { count: diffFiles.length }) : (projectDashboard?.files.length ?? 0)}</strong>
        {diffFiles.length > 0 ? (
          <small><span className="positive">+{totalDiffAdditions}</span> <span className="negative">-{totalDiffDeletions}</span></small>
        ) : (
          <small>{dashboardError ? t('detail.dashboardError', { message: dashboardError }) : t('detail.fileStatusSource')}</small>
        )}
      </div>
      <div className="dashboard-card">
        <span className="dashboard-label">{t('detail.agentTitle')}</span>
        <strong>{agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })}</strong>
        <small>{t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}</small>
      </div>
      <div className="dashboard-card">
        <span className="dashboard-label">{t('detail.modelTitle')}</span>
        <strong>{modelStatusLabel}</strong>
        <small>{activeModelOption?.providerName ?? "-"}</small>
      </div>
    </>
  ) : null

  /* Rows carry the project they belong to rather than repeating an absolute path per row: with a
     dozen sessions across three checkouts, the folder is the thing being scanned for. */
  const sidebarGroups = filteredSessions.reduce<Array<{ directory: string; sessions: SessionView[] }>>((groups, session) => {
    const last = groups[groups.length - 1]
    if (last && last.directory === session.directory) last.sessions.push(session)
    else groups.push({ directory: session.directory, sessions: [session] })
    return groups
  }, [])

  const sessionRenameState: SessionRenameState = {
    sessionID: renamingSessionID,
    source: renameSource,
    value: renameValue
  }
  const sessionCardProps = {
    selectedID,
    rename: sessionRenameState,
    renameInputRef,
    capabilities,
    language,
    t,
    parentInfo,
    onOpen: (session: SessionView) => void openSession(session.id, session.directory).catch(() => undefined),
    onRenameValueChange: setRenameValue,
    onRename: (session: SessionView) => void renameSession(session.id, renameValue, session.directory).catch(() => undefined),
    onCancelRename: cancelRename,
    onStartRename: (session: SessionView) => startRename(session),
    onDelete: (session: SessionView) => {
      if (!isSessionMutationLocked()) setSessionToDelete(session)
    },
    mutationLocked
  }

  return (
    <div className={`app-shell${isDesktop ? " app-shell-desktop" : ""}`}>
      {isDesktop ? (
        <MenuBar
          menus={usesNativeMenu ? [] : menuDefinitions}
          brand={brandBlock}
          right={(
            <>
              <button type="button" className="palette-hint" onClick={() => setPaletteOpen(true)}>
                <SearchIcon size={14} />
                <span>{t('command.commandPalette')}</span>
                <kbd className="kbd">{shortcut("K")}</kbd>
              </button>
              {serverSwitcher}
              <button
                type="button"
                className={`btn-icon btn-ghost${inspectorOpen ? " active" : ""}`}
                onClick={() => setInspectorOpen((open) => !open)}
                aria-label={t('command.toggleInspector')}
                title={t('command.toggleInspector')}
                disabled={!selectedSession || !hasRoomForInspector}
              >
                <PanelRightIcon size={16} />
              </button>
            </>
          )}
        />
      ) : mainView === "detail" && selectedSession ? (
        <header className="mobile-appbar mobile-session-appbar fade-in">
          <div className="appbar-lead">
            <button
              type="button"
              className="btn-icon btn-ghost mobile-back-button"
              onClick={() => setView("sessions")}
              aria-label={t('detail.backToSessions')}
              title={t('detail.backToSessions')}
            >
              <ArrowLeftIcon size={20} />
            </button>
            <div className="appbar-titles">
              <h1 ref={detailHeadingRef} tabIndex={-1} title={selectedSession.title}>{selectedSession.title}</h1>
              <p title={selectedSession.directory}>{projectLabel(selectedSession.directory)}</p>
            </div>
          </div>
          {sessionHeaderActions.length > 0 && (
            <div className="appbar-actions">
              <SessionActionsMenu actions={sessionHeaderActions} t={t} pendingAction={sessionActionPending} />
            </div>
          )}
        </header>
      ) : (
        <header className="mobile-appbar mobile-global-appbar fade-in">
          <div className="mobile-appbar-brand">{brandBlock}</div>
          <div className="mobile-appbar-spacer" />
          {serverSwitcher}
        </header>
      )}

      <div className="app-body">

      {isDesktop && (
        <SessionSidebar
          groups={sidebarGroups}
          query={query}
          searchInputRef={searchInputRef}
          sidebarSessionsRef={sidebarSessionsRef}
            refreshing={refreshingSessions}
           creating={creatingSession}
          mutationLocked={mutationLocked}
          offline={isOffline}
          width={viewportSidebarWidth}
          t={t}
          onQueryChange={setQuery}
          onRefresh={() => void refreshSessionsWithIndicator().catch(() => undefined)}
          onNewSession={() => void openNewSessionPicker()}
          onShowHelp={() => setView("help")}
          onShowSettings={() => setView("settings")}
          onResize={dragPanelDivider}
          onScroll={refreshSidebarJumps}
          jumpControls={<JumpControls affordances={sidebarJumpAffordances} onJumpToTop={handleSidebarJumpToTop} onJumpToBottom={handleSidebarJumpToBottom} variant="sidebar" t={t} />}
          sessionCardProps={sessionCardProps}
        />
      )}

      <div
        className="main-content"
        style={isDesktop ? { minWidth: MAIN_WIDTH_MIN, position: "relative" } : undefined}
      >
      {mainView === "settings" && (
        <ConditionalWrapper
          condition={isDesktop}
          wrapper={(children) => (
            <DesktopModalOverlay onClose={() => setView("detail")} ariaLabel={t('settings.title')}>
              {children}
            </DesktopModalOverlay>
          )}
        >
        <section className="panel settings fade-in" data-settings-tab={settingsTab}>
          <div className="section-heading">
            <div className="section-heading-text">
              <h2>{t('settings.title')}</h2>
              <p className="subtle">{hasConfiguredServer ? `${config.host}:${config.port}` : t('settings.hostPlaceholder')}</p>
              <p className="subtle">{t('settings.draftHint')}</p>
            </div>
            {/* Aligned to the bottom of the heading text: the pair costs no height of its own there,
                and it stays clear of the corner the modal's close button occupies. */}
            <div className="server-profile-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowConnectWizard(true)}>
                <PlusIcon size={16} />
                {t('settings.addServer')}
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => setProfileToDelete(profiles.find((profile) => profile.id === activeProfileID) ?? null)}
                disabled={profiles.length === 1}
                title={profiles.length === 1 ? t('settings.deleteLastServerHint') : undefined}
              >
                <TrashIcon size={16} />
                {t('settings.deleteServer')}
              </button>
            </div>
          </div>

          <div className="settings-nav settings-nav-inline" role="tablist" aria-label={t('settings.title')}>
            <button type="button" role="tab" aria-selected={settingsTab === "server"} className={settingsTab === "server" ? "active" : ""} onClick={() => setSettingsTab("server")}>
              <ServerIcon size={16} />
              {t('settings.serverProfile')}
            </button>
            <button type="button" role="tab" aria-selected={settingsTab === "appearance"} className={settingsTab === "appearance" ? "active" : ""} onClick={() => setSettingsTab("appearance")}>
              <SettingsIcon size={16} />
              {t('settings.theme')}
            </button>
          </div>

          <div className="form-grid">
          <label htmlFor="server-name" className="field-row-span settings-server-field">
            {t('settings.serverName')}
            <input
              id="server-name"
              value={draftProfileName}
              onChange={(event) => {
                const name = event.target.value
                setDraftProfileName(name)
                const nextProfiles = profiles.map((profile) => profile.id === activeProfileID ? { ...profile, name } : profile)
                setProfiles(nextProfiles)
                persistServerProfiles(nextProfiles, activeProfileID)
              }}
              autoComplete="off"
            />
          </label>
          <label htmlFor="language" className="settings-appearance-field">
            {t('settings.language')}
            <select
              id="language"
              value={language}
              onChange={(event) => setLanguage(normalizeLanguage(event.target.value))}
            >
              {languageOptions.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </label>

          <label htmlFor="theme" className="settings-appearance-field">
            {t('settings.theme')}
            <select
              id="theme"
              value={theme}
              onChange={(event) => setTheme(event.target.value as ThemePreference)}
            >
              <option value="system">{t('settings.themeSystem')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
            </select>
          </label>
          
          <label htmlFor="backend" className="settings-server-field">
            {t('settings.backend')}
            <select
              id="backend"
              value={draftConfig.backend}
              onChange={(event) => {
                const backend = event.target.value as ServerConfig["backend"]
                setDraftConfig(createServerProfile("", backend).config)
              }}
            >
              <option value="opencode">OpenCode</option>
              <option value="opencode2">OpenCode 2</option>
              <option value="omp">Oh My Pi (bridge)</option>
              <option value="pi">PI (ACP bridge)</option>
              <option value="claude">Claude Code (ACP bridge)</option>
              <option value="codex">Codex CLI (ACP bridge)</option>
            </select>
          </label>

          <label htmlFor="host" className="settings-server-field">
            {t('settings.host')}
            <input
              id="host"
              value={draftConfig.host}
              onChange={(event) => setDraftConfig({ ...draftConfig, host: event.target.value })}
              placeholder={t('settings.hostPlaceholder')}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label htmlFor="port" className="settings-server-field">
            {t('settings.port')}
            <input
              id="port"
              type="text"
              value={draftConfig.port || ""}
              onChange={(event) => {
                const value = event.target.value.trim()
                if (value === "" || /^\d+$/.test(value)) {
                  setDraftConfig({ ...draftConfig, port: value === "" ? 0 : Number(value) })
                }
              }}
              placeholder="4096"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
            />
          </label>
          
          <label htmlFor="username" className="settings-server-field">
            {t('settings.username')}
            <input
              id="username"
              value={draftConfig.username}
              onChange={(event) => setDraftConfig({ ...draftConfig, username: event.target.value })}
              placeholder="opencode"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
            />
          </label>
          
          <label htmlFor="password" className="settings-server-field">
            {t('settings.password')}
            <input
              id="password"
              type="password"
              value={draftConfig.password}
              onChange={(event) => setDraftConfig({ ...draftConfig, password: event.target.value })}
              placeholder={t('settings.passwordPlaceholder')}
              autoComplete="current-password"
            />
          </label>
          </div>
          
          <div className="actions">
            <button 
              type="button"
              onClick={() => testConnection(draftConfig)} 
              className="btn-secondary"
              disabled={testingConnection || !canTestDraft || testAlreadyPassedForDraft}
              title={!canTestDraft ? t('settings.testNeedsFields') : testAlreadyPassedForDraft ? t('settings.testAlreadyPassed') : undefined}
            >
              {testingConnection ? (
                <>
                  <LoadingIcon size={18} />
                  {t('settings.testing')}
                </>
              ) : (
                <>
                  <TestIcon size={18} />
                  {testAlreadyPassedForDraft ? t('settings.testOk') : t('settings.test')}
                </>
              )}
            </button>
          </div>
          
          {settingsNotice && (
            <div className={`notice ${settingsNotice.type} fade-in`}>
              {settingsNotice.type === 'success' && '✓ '}
              {settingsNotice.type === 'error' && '✗ '}
              {settingsNotice.type === 'info' && 'ℹ '}
              {settingsNotice.text}
            </div>
          )}
          
          <div className="connection-help">
            <span>{canTestDraft ? t('settings.readyToTest') : t('settings.testNeedsFields')}</span>
          </div>

          {connectedVersion && testAlreadyPassedForDraft && (
            <div className="notice success fade-in">
              <TestIcon size={16} />
              {t('settings.connectedTo', { version: connectedVersion })}
            </div>
          )}
        </section>
        </ConditionalWrapper>
      )}

      {mainView === "sessions" && (
        <SessionsPanel
          sessions={sessions}
          filteredSessions={filteredSessions}
          activeSessions={activeSessions}
          changedSessions={changedSessions}
          query={query}
            refreshing={refreshingSessions}
           creating={creatingSession}
          mutationLocked={mutationLocked}
          offline={isOffline}
          connectionState={connectionState}
          connectionStatusText={connectionStatusText}
          eventStreamState={eventStreamState}
          eventStreamText={eventStreamText}
          runtimeError={runtimeError}
          actionNotice={actionNotice}
          t={t}
          onQueryChange={setQuery}
          onRefresh={() => void refreshSessionsWithIndicator().catch(() => undefined)}
          onNewSession={() => void openNewSessionPicker()}
          onShowSettings={() => setView("settings")}
          jumpControls={<JumpControls affordances={sessionJumpAffordances} onJumpToTop={handleSessionsJumpToTop} onJumpToBottom={handleSessionsJumpToBottom} variant="page" t={t} />}
          sessionCardProps={sessionCardProps}
        />
      )}

      {showNewSessionPicker && (
        <NewSessionDialog
          t={t}
          path={pickerPath}
          items={pickerItems}
          loading={pickerLoading}
          error={pickerError}
          creating={creatingSession}
          recentDirectories={Array.from(new Set([selectedNewSessionDirectory, ...sessions.map((session) => session.directory)].filter((directory): directory is string => Boolean(directory)))).slice(0, 5)}
          onBrowse={(directory) => void browseNewSessionDirectory(directory).catch(() => undefined)}
          onCreate={(directory) => void createSession(directory).catch(() => undefined)}
          onUseServerDefault={() => void createSession("").catch(() => undefined)}
          onClose={() => setShowNewSessionPicker(false)}
        />
      )}

      {mainView === "detail" && (
        <main className="panel detail fade-in">
          <div className="header-row detail-header desktop-detail-header">
              <div>
              <h2 ref={detailHeadingRef} tabIndex={-1}>
                {selectedSession ? (
                  <div className="detail-title-row">
                    {renamingSessionID === selectedSession.id && renameSource === "header" ? (
                      <div className="rename-inline">
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              renameSession(selectedSession.id, renameValue, selectedSession.directory).catch(() => undefined)
                            } else if (event.key === "Escape") {
                              cancelRename()
                            }
                          }}
                          onBlur={() => {
                            if (renameValue === selectedSession.title || !renameValue.trim()) {
                              cancelRename()
                            }
                          }}
                          placeholder={t('session.renamePlaceholder')}
                          className="rename-input"
                          autoComplete="off"
                        />
                        {/* Two unlabelled 14px glyphs asked the user to guess which one commits.
                            One labelled primary action, and cancel as the quieter icon. */}
                        <button
                          className="btn-icon btn-primary compact rename-save"
                          onClick={() => renameSession(selectedSession.id, renameValue, selectedSession.directory).catch(() => undefined)}
                          onMouseDown={(event) => event.preventDefault()}
                          disabled={mutationLocked || !renameValue.trim() || renameValue === selectedSession.title}
                          title={t('session.renameConfirm')}
                          aria-label={t('session.renameConfirm')}
                        >
                          <SaveIcon size={16} />
                        </button>
                        <button
                          className="btn-icon btn-secondary compact"
                          onClick={() => cancelRename()}
                          onMouseDown={(event) => event.preventDefault()}
                          title={t('session.cancel')}
                          aria-label={t('session.cancel')}
                        >
                          <CloseIcon size={18} />
                        </button>
                      </div>
                    ) : (
                      <>
                        {/* A 14px glyph is a poor target and a poor hint. The title itself is the
                            button; the pencil only says that it can be edited. */}
                        {capabilities.sessionRename ? (
                          <button
                            type="button"
                            className="session-title-button"
                             onClick={() => startRename(selectedSession, "header")}
                             disabled={mutationLocked}
                            title={t('session.renameTitle')}
                            aria-label={t('session.renameTitle')}
                          >
                            <span className="session-title-text">{selectedSession.title}</span>
                            <PencilIcon size={18} className="session-title-pencil" />
                          </button>
                        ) : (
                          <span className="session-title-text">{selectedSession.title}</span>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  t('detail.selectSession')
                )}
              </h2>
              {selectedSession && (
                <p className="subtle detail-subline" title={selectedSession.directory}>
                  <span className="detail-subline-path">{shortDirectory(selectedSession.directory)}</span>
                  {/* Moved up from between the messages and the composer, where the sticky
                      composer covered half of it. Written out rather than tagged: a one-word
                      label needed a tooltip to be understood, and touch has no tooltip. */}
                  {selectedSession.external && (
                    <span className="detail-subline-note">{t('detail.externalSession')}</span>
                  )}
                </p>
                )}
              </div>
              {isDesktop && selectedSession && sessionHeaderActions.length > 0 && (
                <SessionActionsMenu actions={sessionHeaderActions} t={t} pendingAction={sessionActionPending} />
              )}
            </div>

          {selectedSession && (
            <section className="session-context-strip" aria-label={t('detail.contextStripLabel')}>
              {showModelChip && (
                <button
                  type="button"
                  className={`context-chip${modelLoadError && !activeModelOption ? " chip-warning" : ""}`}
                  onClick={() => setActiveDetailSheet("ai")}
                >
                  <span>{t('detail.aiChip')}</span>
                  <strong>{capabilities.agents ? `${agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })} · ${modelStatusLabel}` : modelStatusLabel}</strong>
                </button>
              )}

              <button type="button" className="context-chip ghost" onClick={() => setActiveDetailSheet("details")}>
                <span>{t('detail.detailsChip')}</span>
                <strong>{projectName || t('detail.projectLabel')}</strong>
              </button>
            </section>
          )}

          {todos.length > 0 && (
            <div className="todo-box">
              <div className="todo-header-row">
                <h3>
                  <span style={{ marginRight: 'var(--space-2)' }}>📋</span>
                  {t('todo.title')}
                </h3>
                <button
                  type="button"
                  className="todo-toggle-btn"
                  onClick={() => setTodosExpanded((value) => !value)}
                  aria-expanded={todosExpanded}
                  aria-controls="todo-items-content"
                >
                  {todosExpanded ? t('todo.hide') : t('todo.show')}
                </button>
              </div>
              {todosExpanded && (
                <div id="todo-items-content">
                  {todos.slice(0, 6).map((item) => (
                    <div key={item.id} className="todo-item">
                      <span className={`todo-status ${item.status}`}>
                        {item.status === 'completed' ? '✓' : '○'}
                      </span>
                      <span>{item.content}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <MessagesPane
            loadingSessionID={loadingSessionID}
            loadedSessionID={loadedSessionID}
            loadFailure={loadFailure}
            onRetrySession={handleRetrySession}
            selectedID={selectedID}
            renderedMessages={renderedMessages}
            timelineGroups={timelineGroups}
            showTypingBubble={showTypingBubble}
            pendingQuestions={pendingQuestions}
            pendingPermissions={pendingPermissions}
            config={config}
            directory={selectedSession?.directory}
            actions={messageMenuActions}
            onRevertMessage={handleRevertMessage}
             revertDisabled={sessionActionPending === "fork" || mutationLocked}
            t={t}
            jumpAffordances={jumpAffordances}
            onJumpToTop={handleJumpToTop}
            onJumpToBottom={handleJumpToBottom}
            messagesRef={messagesRef}
            messagesEndRef={messagesEndRef}
            onMessagesScroll={handleMessagesScroll}
            onQuestionResolved={handleQuestionResolved}
            onPermissionResolved={handlePermissionResolved}
            coordinator={mutationCoordinator}
            onLeaseChanged={handleLeaseChanged}
            onCancelQueuedMessage={cancelQueuedMessage}
            cancellingInboxIDs={cancellingInboxIDs}
            subagentContext={subagentContext}
            onOpenChildSession={handleOpenChildSession}
            openingChildID={openingChildID}
          />
          <SessionComposer
            selected={Boolean(selectedSession) && sessionActionPending !== "fork"}
            attachmentContextKey={`${activeProfileID}|${configKey(config)}|${selectedID ?? ""}`}
            mutationLocked={mutationLocked}
            value={composer}
            attachments={attachments}
            supportsAttachments={capabilities.attachments}
            showStopAction={showStopAction}
            canAbortSession={canAbortSession}
            softKeyboard={SOFT_KEYBOARD_DEVICE}
            t={t}
            composerRef={composerRef}
            inputRef={composerInputRef}
            attachmentInputRef={attachmentInputRef}
            onValueChange={setComposer}
            onAttachmentsChange={setAttachments}
            onAttachmentError={(message) => setRuntimeError(message)}
            onFocus={() => {
              syncChatBottomClearance()
              setTimeout(() => scrollMessagesToBottom("smooth"), 400)
              const onResize = () => {
                scrollMessagesToBottom("smooth")
                window.removeEventListener("resize", onResize)
              }
              window.addEventListener("resize", onResize, { once: true })
            }}
            onSend={() => void send().catch(() => undefined)}
            onAbort={() => void abortSession()}
          />

          {runtimeError && <div className="error fade-in" role="alert">✗ {runtimeError}</div>}
          {actionNotice && <div className="notice info fade-in" role="status" aria-live="polite">ℹ {actionNotice}</div>}
        </main>
      )}

      {activeDetailSheet && selectedSession && (
        <div className="sheet-backdrop" role="presentation" onClick={() => setActiveDetailSheet(null)}>
          <section
            className="bottom-sheet fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-sheet-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <div>
                <h3 id="detail-sheet-title">
                  {activeDetailSheet === "ai" && t('detail.aiTitle')}
                  {activeDetailSheet === "details" && t('detail.sessionDetailsTitle')}
                </h3>
                <p className="subtle">
                  {activeDetailSheet === "ai" && t('detail.modelHint')}
                  {activeDetailSheet === "details" && t('detail.sessionDetailsHint')}
                </p>
              </div>
              <button type="button" className="btn-secondary compact" onClick={() => setActiveDetailSheet(null)}>
                {t('detail.closeSheet')}
              </button>
            </div>

            {activeDetailSheet === "ai" && (
              <div className="sheet-content">
                <button type="button" className="btn-secondary" disabled={mutationLocked} onClick={() => { if (mutationLocked) return; void Promise.all([loadAgents(selectedSession?.id, selectedSession?.directory), loadModels(selectedSession?.id, selectedSession?.directory)]).catch(() => undefined) }}>
                  <RefreshIcon size={16} />
                  {t('detail.refreshAi')}
                </button>
                {capabilities.agents && (primaryAgentOptions.length > 0 ? (
                  <div className="agent-controls">
                    <label htmlFor="agent-select">
                      {t('detail.agentSelectLabel')}
                      <select
                        id="agent-select"
                        value={activeAgentID}
                        onChange={(event) => changeAgent(event.target.value)}
                         disabled={isWorking || mutationLocked}
                      >
                        {primaryAgentOptions.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>
                        ))}
                      </select>
                    </label>
                    <p className="subtle">
                      {activeAgent?.description || t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}
                    </p>
                  </div>
                ) : (
                  <p className="subtle">{agentLoadError ? t('detail.agentLoadError', { message: agentLoadError }) : t('detail.agentLoading')}</p>
                ))}
                {modelOptions.length > 0 ? (
                  <div className="model-controls">
                    <label htmlFor="model-search">
                      {t('detail.modelSelectLabel')}
                      <input
                        id="model-search"
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder={t('detail.modelSearchPlaceholder')}
                        inputMode="search"
                        enterKeyHint="search"
                        autoCapitalize="none"
                        spellCheck={false}
                               disabled={isWorking || mutationLocked}
                        autoComplete="off"
                      />
                    </label>
                    <div className="model-option-list" role="listbox" aria-label={t('detail.modelSelectLabel')}>
                      {filteredModelOptions.length > 0 ? (
                        filteredModelOptions.map((option) => {
                          const optionKey = modelKey(option)
                          const active = activeModelOption ? sameModel(option, activeModelOption) : optionKey === selectedModelKey
                          return (
                            <button
                              type="button"
                              key={optionKey}
                              className={active ? "model-option active" : "model-option"}
                              onClick={() => changeModel(optionKey)}
                              disabled={isWorking || mutationLocked}
                              role="option"
                              aria-selected={active}
                            >
                              <span>
                                <strong>{option.modelName}</strong>
                                {/* The harness's own description carries the version — "Sonnet 5 ·
                                    Efficient for routine tasks" — which is what someone picking a
                                    model wants. The provider only earns the line when there is
                                    nothing better, as with OpenCode. */}
                                <small>
                                  {[option.description ?? option.providerName, option.variant].filter(Boolean).join(" · ")}
                                </small>
                              </span>
                              {option.isDefault && <em>{t('detail.modelDefault')}</em>}
                            </button>
                          )
                        })
                      ) : (
                        <p className="subtle model-empty">{t('detail.modelSearchEmpty')}</p>
                      )}
                    </div>
                    {activeModelOption && (
                      <div className="model-meta">
                        <span>{t('detail.modelProvider', { provider: activeModelOption.providerName })}</span>
                        <span>{t('detail.modelContext', { context: formatLimit(activeModelOption.contextLimit), output: formatLimit(activeModelOption.outputLimit) })}</span>
                        <span>{activeModelOption.tools ? t('detail.modelToolsYes') : t('detail.modelToolsNo')}</span>
                        {activeModelOption.variant && <span>{t('detail.modelVariant', { variant: activeModelOption.variant })}</span>}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="subtle">
                    {!capabilities.models
                      ? t('detail.modelNotSupported')
                      : modelLoadError ? t('detail.modelLoadError', { message: modelLoadError }) : t('detail.modelLoading')}
                  </p>
                )}
              </div>
            )}

            {activeDetailSheet === "details" && (
              <div className="sheet-content project-dashboard single-column">
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.projectLabel')}</span>
                  <strong>{projectName || selectedSession.directory}</strong>
                  <small>{projectPath || selectedSession.directory}</small>
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.vcsLabel')}</span>
                  <strong>{vcsBranch || t('detail.unavailable')}</strong>
                  {projectDashboard?.vcs && (
                    <small>{t('detail.aheadBehind', { ahead: projectDashboard.vcs.ahead ?? 0, behind: projectDashboard.vcs.behind ?? 0 })}</small>
                  )}
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.fileStatusLabel')}</span>
                  <strong>{diffFiles.length > 0 ? t('detail.filesCount', { count: diffFiles.length }) : (projectDashboard?.files.length ?? 0)}</strong>
                  {diffFiles.length > 0 ? (
                    <small><span className="positive">+{totalDiffAdditions}</span> <span className="negative">-{totalDiffDeletions}</span></small>
                  ) : (
                    <small>{dashboardError ? t('detail.dashboardError', { message: dashboardError }) : t('detail.fileStatusSource')}</small>
                  )}
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.agentTitle')}</span>
                  <strong>{agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })}</strong>
                  <small>{t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}</small>
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.modelTitle')}</span>
                  <strong>{modelStatusLabel}</strong>
                  <small>{activeModelOption?.providerName ?? "-"}</small>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Deleting a saved server throws away a host, a username and a password that cannot be
          recovered, so it is confirmed exactly like deleting a session. */}
      {profileToDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setProfileToDelete(null)}>
          <section
            className="modal-card fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-server-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-server-title">{t('settings.deleteServerTitle')}</h2>
            <p>
              {t('session.deleteBodyPrefix')} <strong>{profileToDelete.name}</strong>.
            </p>
            {/* A server saved but never filled in has no address to show, and the placeholder that
                stands in for one inside the form reads as an actual host here. */}
            {profileToDelete.config.host && (
              <p className="subtle">{`${profileToDelete.config.host}:${profileToDelete.config.port}`}</p>
            )}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setProfileToDelete(null)}>
                {t('session.cancel')}
              </button>
              <button className="btn-danger" onClick={deleteActiveProfile}>
                <TrashIcon size={16} />
                {t('settings.deleteServer')}
              </button>
            </div>
          </section>
        </div>
      )}

      {sessionToDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSessionToDelete(null)}>
          <section
            className="modal-card fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-session-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-session-title">{t('session.deleteTitle')}</h2>
            <p>
              {t('session.deleteBodyPrefix')} <strong>{sessionToDelete.title}</strong>.
            </p>
            <p className="subtle">{sessionToDelete.directory}</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setSessionToDelete(null)}>
                {t('session.cancel')}
              </button>
              <button className="btn-danger" disabled={mutationLocked} onClick={() => deleteSession(sessionToDelete.id)}>
                <TrashIcon size={16} />
                {t('session.deleteConfirm')}
              </button>
            </div>
          </section>
        </div>
      )}

      {mainView === "help" && (
        <ConditionalWrapper
          condition={isDesktop}
          wrapper={(children) => (
            <DesktopModalOverlay onClose={() => setView("detail")} ariaLabel={t('help.title')}>
              {children}
            </DesktopModalOverlay>
          )}
        >
        <section className="panel help fade-in">
          <h2>{t('help.title')}</h2>
          <div className="help-tabs" role="tablist">
            <button 
              className={helpPage === "overview" ? "active" : ""} 
              onClick={() => setHelpPage("overview")}
              role="tab"
              aria-selected={helpPage === "overview"}
            >
              {t('help.overview')}
            </button>
            <button 
              className={helpPage === "server" ? "active" : ""} 
              onClick={() => setHelpPage("server")}
              role="tab"
              aria-selected={helpPage === "server"}
            >
              {t('help.server')}
            </button>
            <button 
              className={helpPage === "network" ? "active" : ""} 
              onClick={() => setHelpPage("network")}
              role="tab"
              aria-selected={helpPage === "network"}
            >
              {t('help.network')}
            </button>
            <button 
              className={helpPage === "troubleshooting" ? "active" : ""} 
              onClick={() => setHelpPage("troubleshooting")}
              role="tab"
              aria-selected={helpPage === "troubleshooting"}
            >
              {t('help.troubleshooting')}
            </button>
            <button 
              className={helpPage === "commands" ? "active" : ""} 
              onClick={() => { setCommandFilter("all"); setHelpPage("commands") }}
              role="tab"
              aria-selected={helpPage === "commands"}
            >
              {t('help.commands')}
            </button>
          </div>

          {helpPage === "overview" && (
            <div className="help-content fade-in">
              <h3>Getting Started</h3>
              <ul>
                <li><strong>Configure Server:</strong> Use Settings to enter host, port, username and password</li>
                <li><strong>Test Connection:</strong> Press Test to validate server connectivity</li>
                <li><strong>Configuration:</strong> Changes are saved automatically and applied after you pause typing.</li>
                {/* Told in terms of what is actually on screen: the same two steps are a tab and a
                    view on a phone, and two panes side by side on a desktop. */}
                <li><strong>Browse Sessions:</strong> {isDesktop
                  ? "Pick a session from the sidebar on the left"
                  : "View and manage sessions from the Sessions tab"}</li>
                <li><strong>Interact:</strong> {isDesktop
                  ? "Read and reply in the conversation beside it"
                  : "Open a session and chat in the Detail view"}</li>
                <li><strong>Quick Input:</strong> {SOFT_KEYBOARD_DEVICE
                  ? `Enter for new lines, ${shortcut("Enter")} to send`
                  : "Press Enter to send, Shift+Enter for new lines"}</li>
                <li><strong>Slash Commands:</strong> Text starting with <code>/</code> is sent as a command</li>
              </ul>

              {/* Window width alone picks the layout, so the one thing worth stating is where the
                  boundary is: otherwise a resized window looks like the app lost its sidebar. */}
              <h3>Desktop Layout</h3>
              <p>
                A window at least {DESKTOP_MIN_WIDTH}px wide shows the sessions sidebar and the
                conversation side by side.{isDesktop
                  ? " Narrow it below that and the single-view mobile layout comes back."
                  : " This window is narrower than that, which is why you are seeing one view at a time."}
              </p>
              <ul>
                <li><strong>Resize:</strong> Drag the sidebar's outer edge, the divider between the panes, or the conversation's outer edge. Both widths are remembered.</li>
                <li><strong>Rename or delete:</strong> Hover a sidebar row to reveal its icons.</li>
                <li><strong>Working sessions:</strong> A moving accent bar down the left of a row replaces the status pill.</li>
                <li><strong>Settings and Help:</strong> Open over the conversation, so it stays where you left it.</li>
              </ul>

              <h3>Key Features</h3>
              <ul>
                <li>🔄 Real-time session monitoring</li>
                <li>💬 Interactive chat interface</li>
                <li>📋 Todo tracking display</li>
                <li>⚡ Instant session control</li>
                <li>🔔 Completion notifications</li>
                <li>↕️ Jump to either end of a long conversation</li>
              </ul>
            </div>
          )}

          {helpPage === "server" && (
            <div className="help-content fade-in">
              <h3>{isBridgeBackend(config.backend) ? `${backendDisplayName(config.backend)} bridge` : "OpenCode server"}</h3>
              <p>
                This page keeps setup brief. Full, versioned backend guides live in the Harness Remote repository so new
                backends do not make the app help unwieldy.
              </p>
              <div className="code-blocks">
                {config.backend === "omp" ? (
                  <>
                    <h4>OMP bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend omp --host 0.0.0.0 --port 4097 --username omp --password your-password --root "$PWD"</pre>
                  </>
                ) : config.backend === "pi" ? (
                  <>
                    <h4>PI bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend pi --host 0.0.0.0 --port 4097 --username pi --password your-password --root "$PWD"</pre>
                  </>
                ) : config.backend === "claude" ? (
                  <>
                    <h4>Claude Code bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend claude --host 0.0.0.0 --port 4097 --username claude --password your-password --root "$PWD"</pre>
                    <p className="note">Requires <code>claude login</code> or <code>ANTHROPIC_API_KEY</code> on the host machine.</p>
                  </>
                ) : config.backend === "codex" ? (
                  <>
                    <h4>Codex CLI bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend codex --host 0.0.0.0 --port 4097 --username codex --password your-password --root "$PWD"</pre>
                    <p className="note">Requires <code>codex login</code> (ChatGPT account) or an OpenAI API key on the host machine.</p>
                  </>
                ) : (
                  <>
                    <h4>OpenCode server (macOS / Linux)</h4>
                    <pre>OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=your-password npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096</pre>
                  </>
                )}
              </div>
              <p>
                <a
                  href={`https://github.com/giuliastro/harness-remote#${config.backend === "opencode" ? "opencode-server-setup" : config.backend === "opencode2" ? "opencode-2-server-setup" : config.backend === "pi" ? "pi-bridge-setup" : config.backend === "claude" ? "claude-code-bridge-setup" : config.backend === "codex" ? "codex-bridge-setup" : "oh-my-pi-bridge-setup"}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the complete {isBridgeBackend(config.backend) ? `${backendDisplayName(config.backend)} bridge` : "OpenCode server"} guide in the repository
                </a>
              </p>
            </div>
          )}

          {helpPage === "network" && (
            <div className="help-content fade-in">
              <h3>Network Configuration</h3>
              
              <div className="network-modes">
                <h4>🌐 LAN Mode (Recommended)</h4>
                <p>Use your PC's local IP address for devices on the same network:</p>
                <pre>Example: 192.168.1.61</pre>
                
                <h4>🌍 WAN Mode (Advanced)</h4>
                <ul>
                  <li>Configure NAT/port forwarding on your router</li>
                  <li>Set up a VPN for secure remote access</li>
                  <li>Use a reverse proxy with TLS/HTTPS</li>
                </ul>
              </div>
              
              <div className="security-checklist">
                <h4>🔒 Security Requirements</h4>
                <ul>
                  <li>✅ Open TCP port 4096 in OS firewall</li>
                  <li>✅ Configure router/NAT port forwarding</li>
                  <li>✅ Use strong authentication passwords</li>
                  <li>✅ Prefer TLS/HTTPS for external access</li>
                  <li>✅ Restrict source IPs when possible</li>
                  <li>⚠️ Never expose without authentication</li>
                </ul>
              </div>
            </div>
          )}

          {helpPage === "troubleshooting" && (
            <div className="help-content fade-in">
              <h3>Troubleshooting Guide</h3>
              
              <div className="troubleshooting-steps">
                <h4>🔍 Connection Diagnostics</h4>
                <ol>
                  <li><strong>Verify Server:</strong> Check if OpenCode is listening on port 4096</li>
                  <li><strong>Test Locally:</strong> Check health endpoint from the same machine</li>
                  <li><strong>Test Network:</strong> Check health endpoint from your phone browser</li>
                  <li><strong>Check Firewall:</strong> Ensure port 4096 is open in OS firewall</li>
                </ol>
              </div>
              
              <div className="health-checks">
                <h4>🩺 Health Check Commands</h4>
                <div className="code-examples">
                  <h5>Local Machine:</h5>
                  <pre>curl -u opencode:your-password \
http://127.0.0.1:4096/global/health</pre>
                  
                  <h5>From Phone/Network:</h5>
                  <pre>curl -u opencode:your-password \
http://YOUR_PC_IP:4096/global/health</pre>
                </div>
              </div>
              
              <div className="common-issues">
                <h4>⚠️ Common Issues</h4>
                <ul>
                  <li><strong>CORS Errors:</strong> Add <code>--cors</code> flags to server</li>
                  <li><strong>Connection Timeout:</strong> Check firewall settings</li>
                  <li><strong>Auth Failures:</strong> Verify username/password</li>
                  <li><strong>Session Issues:</strong> Re-open session and check server models</li>
                </ul>
              </div>
            </div>
          )}

          {helpPage === "commands" && (
            <div className="help-content fade-in">
              <h3>Slash Commands</h3>
              <p>Local mobile commands are handled by the app. Server commands are loaded from OpenCode and sent to <code>/session/:id/command</code>.</p>
              <div className="example-commands">
                <pre>/help</pre>
                <pre>/commands</pre>
                <pre>/skills</pre>
                <pre>/status</pre>
              </div>
              <div className="help-tabs compact" role="tablist">
                <button
                  className={commandFilter === "all" ? "active" : ""}
                  onClick={() => setCommandFilter("all")}
                  role="tab"
                  aria-selected={commandFilter === "all"}
                >
                  Server Commands
                </button>
                <button
                  className={commandFilter === "skill" ? "active" : ""}
                  onClick={() => setCommandFilter("skill")}
                  role="tab"
                  aria-selected={commandFilter === "skill"}
                >
                  Skills
                </button>
              </div>
               
               {displayedCommands.length === 0 ? (
                <div className="no-commands">
                  <HelpIcon size={48} className="icon-empty-state" />
                  <p className="subtle">No {commandFilter === "skill" ? "skills" : "server commands"} available</p>
                  <p className="subtle">Connect to a server to see available commands and skills</p>
                </div>
              ) : (
                 <div className="commands-grid">
                   {displayedCommands.map((cmd) => (
                      <div key={`${cmd.source ?? "command"}:${cmd.id ?? cmd.name}`} className="command-card">
                       <div className="command-card-header">
                         <code className="command-name">/{cmd.name}</code>
                         {cmd.source === "skill" && (
                            <button
                              type="button"
                              className="btn-secondary"
                               disabled={!selectedSession || config.backend !== "opencode2" || busySending || sessionActionPending === "fork" || mutationLocked}
                             onClick={() => void activateSkill(cmd)}
                             title={!selectedSession
                               ? t('help.skillRequiresSession')
                               : config.backend !== "opencode2"
                                 ? t('help.skillRequiresOpenCode2')
                                 : undefined}
                           >
                             {activatingSkill === (cmd.id ?? cmd.name)
                               ? t('help.skillActivating')
                               : t('help.skillActivate')}
                           </button>
                         )}
                       </div>
                       {cmd.description && (
                         <p className="command-description">{cmd.description}</p>
                       )}
                       {cmd.source && <p className="subtle">{cmd.source}</p>}
                     </div>
                   ))}
                 </div>
               )}
               {commandFilter === "all" && displayedCommands.some((cmd) => cmd.source === "skill") && (!selectedSession || config.backend !== "opencode2") && (
                 <p className="subtle">
                   {!selectedSession ? t('help.skillRequiresSession') : t('help.skillRequiresOpenCode2')}
                 </p>
               )}
               {commandFilter === "skill" && displayedCommands.length > 0 && (!selectedSession || config.backend !== "opencode2") && (
                 <p className="subtle">
                   {!selectedSession ? t('help.skillRequiresSession') : t('help.skillRequiresOpenCode2')}
                 </p>
               )}
               {actionNotice && <div className="notice info fade-in" role="status" aria-live="polite">ℹ {actionNotice}</div>}
             </div>
           )}
          {runtimeError && <p className="error" role="alert">{runtimeError}</p>}
        </section>
        </ConditionalWrapper>
      )}
      </div>

      {showInspector && (
        <aside className="inspector fade-in" style={{ width: viewportInspectorWidth, flex: `0 0 ${viewportInspectorWidth}px` }}>
          <div className="resize-handle resize-handle--start" onPointerDown={dragInspectorDivider} role="separator" aria-orientation="vertical" aria-label="Resize inspector" />
          <div className="inspector-header">
            <h3>{t('detail.sessionDetailsTitle')}</h3>
            <div className="segmented" role="tablist" aria-label={t('detail.sessionDetailsTitle')}>
              <button type="button" role="tab" aria-selected={inspectorTab === "ai"} className={inspectorTab === "ai" ? "active" : ""} onClick={() => setInspectorTab("ai")}>
                {t('detail.aiChip')}
              </button>
              <button type="button" role="tab" aria-selected={inspectorTab === "project"} className={inspectorTab === "project" ? "active" : ""} onClick={() => setInspectorTab("project")}>
                {t('detail.detailsChip')}
              </button>
            </div>
            <button type="button" className="btn-icon btn-ghost compact" onClick={() => setInspectorOpen(false)} aria-label={t('detail.closeSheet')}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="inspector-body">
            {inspectorTab === "ai" ? (
              <section className="inspector-section">
                <div className="inspector-section-title">
                  <span>{t('detail.aiTitle')}</span>
                   <button type="button" className="btn-icon btn-ghost compact" disabled={mutationLocked} onClick={() => { if (mutationLocked) return; void Promise.all([loadAgents(selectedSession?.id, selectedSession?.directory), loadModels(selectedSession?.id, selectedSession?.directory)]).catch(() => undefined) }} aria-label={t('detail.refreshAi')}>
                    <RefreshIcon size={14} />
                  </button>
                </div>
                {aiPanelContent}
              </section>
            ) : (
              <section className="inspector-section project-dashboard single-column">
                <div className="inspector-section-title">{t('detail.projectDashboardLabel')}</div>
                {projectPanelContent}
              </section>
            )}
          </div>
        </aside>
      )}
      </div>

      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          placeholder={t('command.palettePlaceholder')}
          emptyLabel={t('command.paletteEmpty')}
          navigateHint={t('command.navigate')}
          runHint={t('command.run')}
          closeHint={t('command.close')}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {showConnectWizard && (
        <ConnectServerWizard
          t={t}
          initialName={t('settings.newServerName')}
          onCancel={() => setShowConnectWizard(false)}
          onTest={testConnection}
          onSave={(name, nextConfig) => {
            const profile = { ...createServerProfile(name, nextConfig.backend), name, config: nextConfig }
            const nextProfiles = [...profiles, profile]
            setDraftProfileName(name)
            applyConfig(nextConfig, profile.id, nextProfiles)
            setShowConnectWizard(false)
            setView("sessions")
          }}
        />
      )}

      {!isDesktop && <nav className="bottom-nav" role="navigation" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <button
            key={item.view}
            className={view === item.view ? "active" : ""}
            onClick={() => setView(item.view)}
            disabled={item.disabled}
            aria-label={item.label}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>}
    </div>
  )
}

export default App
