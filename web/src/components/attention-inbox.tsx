/**
 * Cross-session attention inbox panel (issue #9, panel lane).
 *
 * One component, two placements:
 *  - "sidebar" — a collapsible section at the top of the desktop sidebar, above the session
 *    groups. It sits OUTSIDE the `.sidebar-sessions` scroll area on purpose: the badge is the
 *    alert surface, so the entry must stay visible while the session list scrolls.
 *  - "page" — a full-page overlay on mobile, opened from the sessions header. The panel is
 *    mounted only while open, so it costs the mobile layout nothing otherwise.
 *
 * The component consumes `AttentionInboxContext` directly: App.tsx owns the derivation,
 * persistence and notifications; this module owns the presentation only. The context lives in
 * `../attentionInboxContext` precisely so this file can import it without a module cycle
 * (App imports session-list, session-list renders this panel).
 *
 * Grouping (criterion 1) is machine → agent → session:
 *  - machine: the active profile is the only machine (single-profile architecture), so the
 *    machine level is one label derived from the backend of the newest item.
 *  - agent: sessions are grouped by their agent; runs without an agent land in a "no agent"
 *    fallback bucket (v1/bridge sessions never set one).
 *  - session: items are grouped by session, newest first; queued prompts the server still
 *    holds for that session render under its items (v2 only — v1 has an empty map and renders
 *    nothing).
 * When grouping collapses to a single agent with a single session, the nested headers are
 * dropped and the list renders flat.
 *
 * Item messages arrive already truncated and redacted (permission items carry the ACTION NAME,
 * never patterns), so the cards render them as-is. The panel never re-implements reply forms:
 * "Open" navigates to the session, where the transcript card handles the actual reply.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  WaitingIcon
} from "../Icons"
import { AttentionInboxContext, type AttentionInboxContextValue } from "../attentionInboxContext"
import { backendDisplayName } from "../backendSetup"
import type { AttentionItem } from "../attentionInbox"
import type { Translator } from "../i18n"
import type { V2InboxItem } from "../opencode2-mappers"
import { formatRelativeTime, formatTime } from "./session-list"

/** The kind pill reuses the session-status pill language: waiting accent for questions and
 *  permissions, danger for failures, success for completions. */
const KIND_PILL_CLASS: Record<AttentionItem["kind"], string> = {
  question: "waiting",
  permission: "waiting",
  failure: "failed",
  completion: "completed"
}

const KIND_LABEL_KEY: Record<AttentionItem["kind"], string> = {
  question: "inbox.question",
  permission: "inbox.permission",
  failure: "inbox.failure",
  completion: "inbox.completion"
}

/** Fallback bucket for runs that carry no agent identity (v1/bridge never set one). */
const NO_AGENT_KEY = "no-agent"

type SessionGroup = {
  sessionId: string
  title: string
  items: AttentionItem[]
  queued: V2InboxItem[]
}

type AgentGroup = {
  key: string
  label: string
  sessions: SessionGroup[]
}

type MachineGroup = {
  label: string
  agents: AgentGroup[]
}

/** Project the (already newest-first) item stream into machine → agent → session groups,
 *  preserving the stream's order inside each level: buckets are appended on first sight. */
function groupAttentionItems(
  items: readonly AttentionItem[],
  queuedBySession: ReadonlyMap<string, V2InboxItem[]>
): MachineGroup {
  const machineLabel = items.length > 0 ? backendDisplayName(items[0].backend) : ""
  const agents: AgentGroup[] = []
  const agentByKey = new Map<string, AgentGroup>()
  for (const item of items) {
    const agentKey = item.agent ?? NO_AGENT_KEY
    let agent = agentByKey.get(agentKey)
    if (!agent) {
      agent = { key: agentKey, label: item.agent ?? "", sessions: [] }
      agentByKey.set(agentKey, agent)
      agents.push(agent)
    }
    let session = agent.sessions.find((candidate) => candidate.sessionId === item.sessionId)
    if (!session) {
      session = {
        sessionId: item.sessionId,
        title: item.sessionTitle,
        items: [],
        queued: queuedBySession.get(item.sessionId) ?? []
      }
      agent.sessions.push(session)
    }
    session.items.push(item)
  }
  return { label: machineLabel, agents }
}

function useAttentionInbox(): AttentionInboxContextValue {
  const value = useContext(AttentionInboxContext)
  if (!value) {
    throw new Error("AttentionInboxPanel must be rendered inside AttentionInboxContext.Provider")
  }
  return value
}

function AttentionItemCard({ item, t, language }: { item: AttentionItem; t: Translator; language: string }) {
  const inbox = useAttentionInbox()
  const openTitle = `${t('inbox.open')}: ${item.sessionTitle}`
  const dismissTitle = `${t('inbox.dismiss')}: ${item.sessionTitle}`
  return (
    <article className={`attention-item attention-item--${item.kind}`}>
      <div className="attention-item-head">
        <span className={`pill ${KIND_PILL_CLASS[item.kind]}`}>{t(KIND_LABEL_KEY[item.kind])}</span>
        <span className="attention-item-title" title={item.sessionTitle}>{item.sessionTitle}</span>
      </div>
      {item.message && <p className="attention-item-message" title={item.message}>{item.message}</p>}
      <div className="attention-item-meta">
        {item.agent && (
          <>
            <span className="attention-item-agent" title={item.agent}>{item.agent}</span>
            <span className="attention-item-meta-sep" aria-hidden="true">·</span>
          </>
        )}
        <span className="attention-item-time" title={formatTime(item.at)}>{formatRelativeTime(item.at, language)}</span>
      </div>
      <div className="attention-item-actions">
        <button type="button" className="btn-primary compact" onClick={() => inbox.open(item)} title={openTitle}>
          {t('inbox.open')}
        </button>
        <button type="button" className="btn-secondary compact" onClick={() => inbox.dismiss(item)} title={dismissTitle}>
          {t('inbox.dismiss')}
        </button>
      </div>
    </article>
  )
}

/** One undelivered server inbox entry and its three operations. Every operation is a real server
 *  mutation through the context handlers; on success the row is dropped from the local listing, so
 *  the buttons never lie. v1 backends have an empty map and never render this. */
function QueuedPrompts({ sessionId, entries, t }: { sessionId: string; entries: V2InboxItem[]; t: Translator }) {
  const inbox = useAttentionInbox()
  if (entries.length === 0) return null
  return (
    <div className="attention-queued">
      <div className="inspector-section-title attention-queued-title">
        <span>{t('inbox.queued')}</span>
        <span className="attention-queued-count">{entries.length}</span>
      </div>
      {entries.map((entry) => {
        const text = typeof entry.payload?.text === "string" ? entry.payload.text : ""
        return (
          <div key={entry.id} className="attention-queued-row">
            <div className="attention-queued-main">
              {text ? (
                <span className="attention-queued-text" title={text}>{text}</span>
              ) : (
                <span className="attention-queued-type" title={entry.type}>{entry.type}</span>
              )}
              {entry.delivery === "queue" && <span className="attention-queued-tag">{t('detail.queuedPrompt')}</span>}
            </div>
            <div className="attention-queued-ops">
              <button type="button" className="btn-secondary compact" onClick={() => inbox.cancelQueued(sessionId, entry.id)} title={t('inbox.cancelPrompt')}>
                {t('inbox.cancelPrompt')}
              </button>
              <button type="button" className="btn-primary compact" onClick={() => inbox.steerQueued(sessionId, entry.id)} title={t('inbox.steerPrompt')}>
                {t('inbox.steerPrompt')}
              </button>
              <button type="button" className="btn-secondary compact" onClick={() => inbox.queueQueued(sessionId, entry.id)} title={t('inbox.queuePrompt')}>
                {t('inbox.queuePrompt')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Saved allow-always grants — configuration, not attention, so it renders as its own section below
 *  the items. Loads once on mount (the context loader is ref-guarded, so repeated mounts and
 *  Strict-Mode double effects are no-ops after the first fetch). v1 backends leave the list empty
 *  and show the plain empty state. */
function SavedPermissionsSection({ t }: { t: Translator }) {
  const inbox = useAttentionInbox()
  const requestedRef = useRef(false)
  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    inbox.loadSavedPermissions()
    // The loader is ref-guarded in App.tsx; an empty dependency list would re-run the guarded
    // body on every render. eslint exhaustive-deps is not configured for this project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (inbox.savedPermissions.length === 0) {
    return (
      <section className="attention-saved">
        <div className="inspector-section-title"><span>{t('savedPermission.title')}</span></div>
        <p className="attention-saved-empty">{t('savedPermission.empty')}</p>
      </section>
    )
  }
  return (
    <section className="attention-saved">
      <div className="inspector-section-title"><span>{t('savedPermission.title')}</span></div>
      <ul className="attention-saved-list">
        {inbox.savedPermissions.map((permission) => (
          <li key={permission.id} className="attention-saved-row">
            <div className="attention-saved-main">
              <span className="attention-saved-action" title={permission.action}>{permission.action}</span>
              <span className="attention-saved-resource" title={permission.resource}>{permission.resource}</span>
              <span className="attention-saved-project" title={permission.projectID}>{permission.projectID}</span>
            </div>
            <button
              type="button"
              className="btn-danger compact"
              onClick={() => inbox.revokeSavedPermission(permission.id)}
              title={`${t('savedPermission.revoke')}: ${permission.action}`}
            >
              {t('savedPermission.revoke')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AttentionInboxPanel({
  variant,
  t,
  language,
  onClose
}: {
  variant: "sidebar" | "page"
  t: Translator
  language: string
  onClose?: () => void
}) {
  const inbox = useAttentionInbox()
  const machine = useMemo(
    () => groupAttentionItems(inbox.items, inbox.queuedBySession),
    [inbox.items, inbox.queuedBySession]
  )
  // Open by default while there is something to see, and open itself whenever the inbox goes from
  // empty to populated — the first poll usually arrives after mount, and a fresh alert after a
  // fully-resolved inbox is exactly when the surface should reappear. A deliberate collapse (only
  // possible while content is showing) is never overridden; the badge keeps alerting on the
  // collapsed header.
  const [open, setOpen] = useState(() => inbox.items.length > 0)
  const hadItemsRef = useRef(inbox.items.length > 0)
  useEffect(() => {
    const nowHasItems = inbox.items.length > 0
    if (nowHasItems && !hadItemsRef.current) setOpen(true)
    hadItemsRef.current = nowHasItems
  }, [inbox.items.length])
  const badgeLabel = inbox.badge > 0 ? `${t('inbox.title')} · ${inbox.badge}` : t('inbox.title')

  const flat = machine.agents.length === 1 && machine.agents[0].sessions.length === 1
  const body = (
    <>
      {inbox.items.length === 0 ? (
        <p className="attention-empty">
          <CheckIcon size={16} />
          <span>{t('inbox.empty')}</span>
        </p>
      ) : (
        <div className="attention-groups">
          <div className="attention-machine">{machine.label}</div>
          {flat ? (
            <>
              {machine.agents[0].sessions[0].items.map((item) => (
                <AttentionItemCard key={item.id} item={item} t={t} language={language} />
              ))}
              <QueuedPrompts sessionId={machine.agents[0].sessions[0].sessionId} entries={machine.agents[0].sessions[0].queued} t={t} />
            </>
          ) : (
            machine.agents.map((agent) => (
              <div key={agent.key} className="attention-agent">
                <div className="attention-agent-label" title={agent.key === NO_AGENT_KEY ? t('inbox.noAgent') : agent.label}>
                  {agent.key === NO_AGENT_KEY ? t('inbox.noAgent') : agent.label}
                </div>
                {agent.sessions.map((session) => (
                  <div key={session.sessionId} className="attention-session">
                    <div className="attention-session-label">
                      <span className="attention-session-title" title={session.title}>{session.title}</span>
                      <span className="attention-session-count">{session.items.length}</span>
                    </div>
                    {session.items.map((item) => (
                      <AttentionItemCard key={item.id} item={item} t={t} language={language} />
                    ))}
                    <QueuedPrompts sessionId={session.sessionId} entries={session.queued} t={t} />
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
      <SavedPermissionsSection t={t} />
    </>
  )

  if (variant === "page") {
    return (
      <div
        className="attention-page fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attention-page-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose?.()
        }}
      >
        <header className="attention-page-header">
          <h2 id="attention-page-title">{t('inbox.title')}</h2>
          {inbox.badge > 0 && <span className="attention-badge">{inbox.badge}</span>}
          <button
            type="button"
            className="btn-icon btn-ghost"
            onClick={onClose}
            aria-label={t('session.cancel')}
            title={t('session.cancel')}
            autoFocus
          >
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="attention-page-body">{body}</div>
      </div>
    )
  }

  return (
    <section className="attention-inbox">
      <button
        type="button"
        className="attention-inbox-toggle"
        aria-expanded={open}
        aria-controls="attention-inbox-body"
        aria-label={badgeLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" className="attention-chevron"><ChevronDownIcon size={12} /></span>
        <span className="attention-inbox-title">{t('inbox.title')}</span>
        {inbox.badge > 0 && <span className="attention-badge">{inbox.badge}</span>}
      </button>
      {open && (
        <div id="attention-inbox-body" className="attention-inbox-body">
          {body}
        </div>
      )}
    </section>
  )
}

/** Compact entry for the mobile sessions header: the badge is the alert surface on phones, so the
 *  count lives on the button itself, not hidden behind the panel. */
export function AttentionInboxButton({ t, onClick }: { t: Translator; onClick: () => void }) {
  const inbox = useAttentionInbox()
  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={inbox.badge > 0 ? `${t('inbox.title')} · ${inbox.badge}` : t('inbox.title')}
      title={t('inbox.title')}
    >
      <WaitingIcon size={16} />
      <span>{t('inbox.title')}</span>
      {inbox.badge > 0 && <span className="attention-badge">{inbox.badge}</span>}
    </button>
  )
}
