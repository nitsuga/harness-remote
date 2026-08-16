import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const clipboard = readFileSync(new URL('./clipboard.ts', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const icons = readFileSync(new URL('./Icons.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./components/shell.tsx', import.meta.url), 'utf8')
const panels = readFileSync(new URL('./components/panels.tsx', import.meta.url), 'utf8')
const sessionList = readFileSync(new URL('./components/session-list.tsx', import.meta.url), 'utf8')
const composerView = readFileSync(new URL('./components/session-composer.tsx', import.meta.url), 'utf8')

assert.match(styles, /button\s*\{[\s\S]*?cursor:\s*pointer;/, 'enabled buttons must advertise that they can be pressed')
assert.match(styles, /button:disabled\s*\{[\s\S]*?cursor:\s*not-allowed;/, 'disabled buttons must retain the blocked cursor')

assert.ok(api.includes('const body = await response.text()'), 'failed HTTP responses must consume their body only once')
// The bridge reports failures as {"error": "..."}; without unwrapping that the app printed the raw
// JSON, so a readable reason like "thread ... already has an active writer" reached the user as a
// braces-and-quotes blob.
assert.match(api, /typeof value\.error === "string" \? value\.error : undefined/, 'a bridge error body must be unwrapped to its message')
assert.equal(api.includes('const text = await response.text()'), false, 'error handling must not try to read an already consumed response stream')

const refreshButton = sessionList.match(/<button onClick=\{onRefresh\}[\s\S]*?\{t\('sessions\.refresh'\)\}[\s\S]*?<\/button>/)
assert.ok(refreshButton, 'sessions refresh button should receive the shared refresh callback')
assert.ok(refreshButton[0].includes('RefreshIcon'), 'idle sessions refresh button should render a non-spinning RefreshIcon')
assert.ok(refreshButton[0].includes('refreshing ? <LoadingIcon'), 'refresh button should spin only during an active manual refresh')
assert.match(styles, /\.session-card-main\s*\{[\s\S]*?min-width:\s*0;/, 'session card content should be allowed to shrink inside narrow layouts')
// The invariant is that a long title cannot widen its card, not how that is achieved. Asserting the
// nowrap/ellipsis spelling instead pinned a truncation the mobile cards never had: their titles wrap,
// and the README screenshots show it. Breaking the word contains the overflow and keeps the wrapping.
// Anchored to line start, and each match kept inside one rule block with [^}]: an unanchored
// `.session-card h3` also matches the tail of `.sidebar-sessions .session-card h3`, which made the
// negative assertion below fire on the sidebar's deliberate nowrap.
// Buttons are `white-space: nowrap` globally, which is right for a label and wrong for these three:
// they hold a whole sentence. Without the override the summary of a long run could not wrap, so it
// pushed the row past the screen and took the page with it — the chat jump buttons went off the
// right edge and the composer was cut off.
assert.match(
  styles,
  /\.message-reasoning-summary,\s*\.message-action-summary,\s*\.message-tool-summary\s*\{[^}]*white-space:\s*normal;/,
  'action summaries must opt out of the global button nowrap'
)
assert.match(
  styles,
  /\.message-reasoning-summary > \*,\s*\.message-action-summary > \*,\s*\.message-tool-summary > \*\s*\{[^}]*min-width:\s*0;/,
  'the text inside a summary row must be allowed to shrink, or the flex item keeps its full width'
)
assert.match(styles, /^\.session-card \.session-card-title\s*\{[^}]*overflow-wrap:\s*(break-word|anywhere);/m, 'a long session title must break rather than widen its card')
assert.ok(
  !/^\.session-card \.session-card-title\s*\{[^}]*white-space:\s*nowrap/m.test(styles),
  'the mobile session card title must stay free to wrap; only the compact desktop sidebar row truncates it'
)
assert.match(styles, /^\.sidebar-sessions \.session-card \.session-card-title\s*\{[^}]*white-space:\s*nowrap;/m, 'the desktop sidebar row keeps its single-line ellipsised title')

// The desktop shell used to hug the combined width of two fixed panels, which centred the whole app
// in a narrow column and left dead space either side of it on any wide display. The pane fills the
// window now, and only the transcript keeps a readable cap.
assert.match(styles, /^\.app-shell-desktop\s*\{[^}]*width:\s*100%;/m, 'the desktop shell must fill the window rather than hug its panels')
assert.ok(
  !/^\.app-shell-desktop\s*\{[^}]*width:\s*fit-content/m.test(styles),
  'a fit-content desktop shell is what left the app stranded in the middle of a wide window'
)
assert.match(styles, /^\.app-shell-desktop \.messages > \*,\s*\n\.app-shell-desktop \.composer\s*\{[^}]*max-width:\s*var\(--chat-measure\);/m, 'the transcript and composer must share one capped, centred reading column')
assert.match(styles, /--chat-measure:\s*clamp\(52rem,\s*58vw,\s*64rem\)/, 'wide desktop windows should progressively expand the transcript without producing full-width prose')
assert.match(styles, /\.message-reasoning-summary \+ \.message-content\s*\{[^}]*margin-top:\s*var\(--space-4\)/, 'reasoning summaries should have balanced spacing before and after')
assert.match(styles, /\.message > \.message-reasoning-summary:first-child\s*\{[^}]*margin-top:\s*0/, 'a leading reasoning row should rely on the message-list gap instead of doubling it')
assert.ok(app.includes('const SIDEBAR_WIDTH_WIDE_DEFAULT = 768') && app.includes('window.innerWidth >= WIDE_DESKTOP_MIN_WIDTH'), 'wide desktop windows should start with a substantially wider session sidebar')
assert.equal(app.includes('MAIN_WIDTH_MAX'), false, 'the main pane flexes now, so it has no width of its own to cap')
assert.ok(app.includes('maxSidebarWidth()'), 'the divider must clamp the sidebar against the window, since growing it now takes space from the main pane')

assert.ok(app.includes('messageScrollSignature'), 'conversation auto-scroll should react to message content changes, not only message count')
assert.ok(
  /if \(!stickToBottomRef\.current\) return[\s\S]*?scrollMessagesToBottom\("auto"\)/.test(app),
  'content-driven auto-scroll must be gated on the user already being pinned to the bottom, so background refreshes cannot force the conversation to scroll while the user has scrolled away'
)
assert.match(
  app,
  /return messagesScrollMetrics\(\)\.fromBottom <= BOTTOM_STICK_THRESHOLD/,
  'the live-tail pin must measure only the active scroller; mobile messages overflow into the page and are not themselves scrollable'
)
assert.match(
  app,
  /const liveTailBottom = composerRect\.top - 12[\s\S]*?fromBottom: Math\.max\(0, endRect\.bottom - liveTailBottom\)/,
  'mobile bottom distance must be measured between the transcript sentinel and fixed composer, not against unused document tail space'
)
assert.match(
  app,
  /\}, \[view, renderedMessages, isWorking, showTypingBubble, pendingQuestions, pendingPermissions\]\)/,
  'auto-scroll must react to every rendered message update, including tool output that changes layout without changing message text'
)
assert.ok(app.includes('}, [view, selectedID])'), 'auto-scroll should run only when opening a selected session')
assert.ok(app.includes('scrollMessagesToBottom("smooth")'), 'focusing the composer should scroll to the bottom')
assert.ok(app.includes('messagesEndRef'), 'auto-scroll should target a bottom sentinel marker')
assert.ok(app.includes('scrollTo({ top: container.scrollHeight'), 'auto-scroll should set the messages container scrollTop to its max scrollHeight')
assert.ok(app.includes('scrollIntoView'), 'auto-scroll should scroll the sentinel into view as a fallback')
assert.ok(app.includes('composerRef'), 'auto-scroll should know the sticky composer height so the latest message is not hidden behind input controls')
assert.ok(app.includes('syncChatBottomClearance'), 'detail view should update chat bottom clearance from the rendered composer size')
assert.ok(app.includes('scrollBy({ top: coveredByComposer'), 'page-level auto-scroll should compensate when the sentinel is covered by the sticky composer')
assert.ok(/\.messages[\s\S]*?padding-bottom:\s*var\(--chat-bottom-clearance/.test(styles), 'messages pane should reserve bottom space for the sticky composer')
assert.ok(/\.messages-end[\s\S]*?scroll-margin-bottom:\s*var\(--chat-bottom-clearance/.test(styles), 'bottom sentinel should keep the latest output above the sticky composer')
assert.ok(/requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{/.test(app), 'auto-scroll should wait for the next two frames so freshly rendered content is laid out before scrolling')
assert.match(
  app,
  /if \(isDesktop \|\| mainView !== "sessions" \|\| !selectedID\) return[\s\S]*?session-card\.active[\s\S]*?scrollIntoView\(\{ block: "center" \}\)/,
  'every mobile return path, including Android back, should center the active session after the sessions page commits'
)
assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.composer\s*\{[\s\S]*?position:\s*fixed;/, 'the mobile composer must be out of document flow so its reserved clearance cannot become a real blank gap')
assert.ok(app.includes('typing-bubble'), 'detail view should render a temporary typing bubble while waiting for OpenCode output')
assert.ok(app.includes('typing-dot'), 'typing bubble should show animated dots')
assert.ok(app.includes('awaitingAssistantReply'), 'typing bubble should stay visible after the send request returns and until a new assistant message arrives')
assert.ok(app.includes('assistantResponseSignature'), 'typing bubble should be replaced by the next assistant response')
assert.ok(app.includes('optimisticUserMessages'), 'sent user messages should render immediately before the network round trip returns')
assert.ok(app.includes('createOptimisticUserMessage'), 'send flow should create an optimistic user message envelope')
assert.ok(app.includes('setOptimisticUserMessages((current) => [...current, optimisticMessage])'), 'send flow should append the optimistic user bubble before awaiting OpenCode')
assert.ok(app.includes('isWaitingForOpenCodeReply = awaitingAssistantReply || busySending || isSessionRunning'), 'send button/waiting state should stay active until OpenCode assistant output arrives')
// Session mutations are arbitrated synchronously now. Do not pin send() to the old fork-only
// predicate: a prompt or command must also reject the same-tick lease held by any other action.
assert.match(app, /const isSessionMutationLocked = \(\) => mutationCoordinator\.getActiveLease\(\) !== null/, 'the mutation lock must be backed by the coordinator lease, not React state')
assert.match(app, /async function send\(\)\s*\{[\s\S]*?if \(!selectedSession \|\| isSessionMutationLocked\(\)\) return/, 'composer submission must synchronously reject an active mutation lease')
assert.match(app, /async function send\(\)[\s\S]*?const commandLease = acquireMutation\("command"\)[\s\S]*?const promptLease = acquireMutation\("prompt"\)/, 'each send path must take an exclusive coordinator lease')
assert.match(app, /sendPrompt[\s\S]*?if \(!isLeaseContextCurrent\(promptLease\)\) return/, 'prompt results must be discarded when their lease, context, or fork generation is stale')
assert.match(app, /sendPrompt[\s\S]*?promptDispatched = true[\s\S]*?let refreshFailed = false[\s\S]*?setActionNotice/, 'prompt refresh failures must be soft notices after dispatch commits')
assert.match(app, /if \(!promptDispatched && !isIndeterminateDeliveryError\(err\) && isLeaseContextCurrent\(promptLease\)\)[\s\S]*?setComposer/, 'only definite prompt dispatch failures may restore the draft')
assert.match(app, /if \(!isLeaseContextCurrent\(lease\)\) return/, 'session results must reject work from a stale lease, context, or fork generation')
assert.ok(app.includes('sessionActionPendingRef.current = "fork"'), 'fork must synchronously publish its pending state before React commits the render')
assert.match(app, /const forkDraft = \{ text: composer, attachments: \[\.\.\.attachments\] \}/, 'fork must snapshot unsent composer content before navigation')
assert.match(app, /setComposer\(\(current\) => \(current === "" \? forkDraft\.text : current\)\)[\s\S]*?setAttachments\(\(current\) => \(current\.length === 0 \? forkDraft\.attachments : current\)\)/, 'fork must restore its draft only into an empty child composer, never overwriting newer child edits')
assert.match(app, /!isIndeterminateDeliveryError\(err\)/, 'indeterminate delivery must not restore a duplicate draft')
assert.match(app, /sessionActionPendingRef\.current = null[\s\S]*?detail\.compactCompleted/, 'compaction must release its pending action only after terminal history metadata')
assert.match(app, /async function activateSkill\([\s\S]*?if \(isSessionMutationLocked\(\)\) return[\s\S]*?const lease = acquireMutation\("skill"\)/, 'direct skill activation must use the synchronous coordinator lease')
assert.match(app, /await api\.listCommands\(config\)[\s\S]*?if \(!isLeaseContextCurrent\(commandLease\)\)[\s\S]*?setCommands\(availableCommands\)/, 'slash command discovery must recheck its lease, context, and fork currency before mutating command state')
assert.ok(app.includes('busySending || sessionActionPending === "fork"'), 'Help skill activation buttons must be disabled during a pending fork')
assert.match(app, /async function revertToMessage\(messageID: string\)\s*\{[\s\S]*?isSessionMutationLocked\(\)/, 'revert must be blocked while another session mutation is pending')
assert.ok(app.includes('selected={Boolean(selectedSession) && sessionActionPending !== "fork"}'), 'composer controls must be disabled during a pending fork on every layout')
assert.ok(app.includes('revertDisabled={sessionActionPending === "fork"}'), 'revert affordances must be removed while a fork snapshot is pending')
assert.match(app, /const handleRevertMessage = useCallback\(\(messageID: string\) => \{[\s\S]*?revertToMessageRef\.current\(messageID\)/, 'stale message-menu callbacks must route through the coordinator-guarded revert handler')
assert.ok(app.includes('completionShouldPlayRef.current = true'), 'completion sound should be armed when a real assistant reply is expected')
assert.ok(app.includes('wasAwaitingAssistantReplyRef.current && !awaitingAssistantReply && completionShouldPlayRef.current'), 'completion sound should play only when assistant waiting ends, not when the user bubble renders')
assert.ok(app.includes('loadSelectedRequestRef'), 'session message refreshes should ignore stale overlapping polling responses')
assert.ok(app.includes('if (requestID !== loadSelectedRequestRef.current) return'), 'older loadSelected requests must not overwrite newer assistant output')
assert.ok(app.includes('loadedSessionID'), 'the message pane should track whether the selected session history has loaded')
assert.ok(app.includes('loadedSessionID !== selectedID'), 'an unloaded selected session must render the loading state instead of an empty transcript')
assert.ok(app.includes('setLoadedSessionID(sessionID)'), 'a successful selected-session snapshot should unlock the empty transcript state')
// The desktop layout renders the chat pane with no session selected, which mobile never does: both
// load checks compare against selectedID, so a null one satisfied them and spun "loading" forever.
assert.ok(
  /selectedID === null \?[\s\S]*?t\('detail\.selectSession'\)[\s\S]*?loadingSessionID === selectedID/.test(app),
  'no selected session must render its own empty state, ahead of and separate from the loading state'
)
// A failed history load never sets loadedSessionID, which the spinner test cannot tell apart from a
// load still in flight — so a session the harness refuses to open (a Codex thread the desktop app
// holds the writer on, say) spun "loading" forever while the reason went only to the toast.
assert.ok(app.includes('setLoadFailure({ sessionID, message })'), 'a session that fails to open must be recorded, not just reported to the toast')
assert.ok(app.includes('setLoadFailure(null)'), 'reopening a session must clear the previous failure')
assert.ok(
  /loadFailure\?\.sessionID === selectedID && loadingSessionID !== selectedID \?[\s\S]*?t\('detail\.loadFailed'\)[\s\S]*?loadingSessionID === selectedID \|\| loadedSessionID !== selectedID \?/.test(app),
  'a failed session load must render its own state ahead of the loading state, so the spinner cannot outlive it'
)
assert.ok(/t\('detail\.loadFailed'\)[\s\S]*?onClick=\{onRetrySession\}/.test(app), 'the failed-load state must offer a retry')
assert.ok(app.includes('reconcileStreamedPart'), 'message refresh should not regress streamed assistant output back to a leaner snapshot')
assert.ok(
  /function reconcileStreamedPart[\s\S]*?incomingText\.length >= previousText\.length \? incoming/.test(app),
  'a snapshot with shorter text than what is already shown must keep the longer text'
)
assert.ok(
  !/assistantPayloadLength\(current\) <= assistantPayloadLength\(msg\)/.test(app),
  'a leaner snapshot must not be rejected wholesale: the optimistic user bubble is cleared against that same snapshot, so dropping it makes a just-sent message vanish and latches every later message out of the transcript until the session is reopened'
)
assert.ok(composerView.includes('SendIcon') && composerView.includes('<SendIcon size={18} />'), 'composer send button should use the clear paper-plane SendIcon')
assert.ok(composerView.includes('StopCircleIcon') && composerView.includes('<StopCircleIcon size={18} />'), 'composer waiting button should use a clear stop-task icon')
assert.ok(composerView.includes('attachmentContextKey'), 'attachment decoding must be scoped to the active session context')
assert.match(composerView, /requestGeneration[\s\S]*?attachmentRequestState\.current\.generation/, 'a stale async attachment decode must be discarded after navigation')
assert.match(composerView, /pendingPreparationState[\s\S]*?contextKey[\s\S]*?generation[\s\S]*?count/, 'attachment preparation must be counted per context and generation')
assert.match(composerView, /pendingPreparation > 0 \|\| attachments\.length >= ATTACHMENT_MAX_COUNT/, 'a second picker selection must be disabled while attachment preparation is pending')
assert.match(composerView, /prepared\.slice\(0, Math\.max\(0, ATTACHMENT_MAX_COUNT - current\.length\)\)/, 'concurrent attachment completions must clamp to the global capacity in the functional update')
assert.match(composerView, /current\.contextKey === preparationContext && current\.generation === preparationGeneration[\s\S]*?Math\.max\(0, current\.count - 1\)/, 'stale attachment cleanup must not decrement the destination context counter')
assert.match(composerView, /mountedRef[\s\S]*?generation \+= 1/, 'attachment preparation must be invalidated when the composer unmounts')
assert.match(composerView, /useEffect\(\(\) => \{[\s\S]*?mountedRef\.current = true[\s\S]*?return \(\) => \{/, 'attachment preparation must become live again during Strict Mode effect setup')
assert.match(composerView, /!mountedRef\.current[\s\S]*?onAttachmentsChange/, 'an unmounted composer must never append a prepared attachment')
assert.match(app, /const deleteContext = \{[\s\S]*?sessionID: sessionID[\s\S]*?const currentDeleteContext = mutationCoordinator\.getContext\(\)[\s\S]*?sameNamespace/, 'delete must capture its target context and explicitly compare the completion namespace')
assert.match(app, /await api\.deleteSession\([\s\S]*?const tombstoneKey = deleteContext\.profileID[\s\S]*?tombstones\.add\(sessionID\)/, 'a successful delete must capture its tombstone before gating current-namespace UI updates')
assert.match(app, /if \(sameNamespace\) \{[\s\S]*?setSessions\(\(current\) => current\.filter/, 'only current-namespace delete completion may remove the visible row')
assert.match(app, /removedSessionIDsRef = useRef\(new Map<string, Set<string>>\(\)\)/, 'session tombstones must be stored per namespace')
assert.match(app, /mergedSessionTombstones\(removedSessionIDsRef\.current, tombstoneKey, persistedTombstoneKey\)/, 'session refreshes must merge tombstones from the active profile/config namespace')
assert.match(app, /removedSessionIDsRef\.current\.set\(tombstoneKey, tombstones\)/, 'deletes must write tombstones to their captured profile/config namespace')
assert.match(app, /sameNamespace && currentDeleteContext\?\.sessionID === sessionID/, 'a stale delete lease must still clear the currently selected target in its namespace')
assert.ok(!app.includes('removedSessionIDsRef.current.clear()'), 'switching namespaces must not erase prior tombstones')
assert.ok(!sessionList.includes('role="button"'), 'session cards must not nest buttons inside a role=button container')
assert.ok(sessionList.includes('className="session-card-open"'), 'session cards need a dedicated keyboard-accessible open control')
assert.equal(/\.session-card\s*\{[^}]*cursor:\s*pointer/.test(styles), false, 'the article must not promise that non-action card content opens the session')
assert.match(styles, /\.session-card-open\s*\{[\s\S]*?cursor:\s*pointer/, 'the primary session control must retain a pointer and keyboard affordance')
assert.match(styles, /\.composer-chips[\s\S]*?overflow-x: auto/, 'attachment chips must remain reachable on narrow screens')
assert.equal(app.includes('aria-busy={pendingAction !== null}'), false, 'the session-actions toggle must not carry inert aria-busy state')
assert.match(app, /<span className="session-action-pending" role="status" aria-live="polite">/, 'pending session actions must announce through a live status region instead of aria-busy')
assert.ok(app.includes('title={action.disabled ? action.disabledReason : undefined}'), 'disabled session-action menu items must carry an explanation in their title')
assert.match(icons, /export const StopCircleIcon/, 'StopCircleIcon should exist in the shared SVG icon set')
assert.ok(app.includes('api.loadDiff(config, sessionID, directory)'), 'detail view should load /session/:id/diff for changed-file details')
assert.ok(app.includes('diffFiles.length > 0'), 'changed-file panel should be hidden when there are no changed files')
assert.ok(app.includes('activeDetailSheet === "details"'), 'VCS and file status should be consolidated into the details bottom sheet')
assert.ok(app.includes('diffFiles.length > 0 ? t(\'detail.filesCount\''), 'details sheet should summarize changed files when diff data exists')
assert.ok(!app.includes('className={selectedDiff?.file === file.file ? "diff-file active" : "diff-file"}'), 'changed-file details should no longer render a separate selectable file list')
assert.ok(!app.includes('mini-diff-card'), 'separate mini diff card should stay removed from the streamlined details sheet')
assert.ok(app.includes('api.loadProjectCurrent(config, directory)'), 'project dashboard should use /project/current')
assert.ok(app.includes('api.loadVcs(config, directory)'), 'project dashboard should use /vcs')
assert.ok(app.includes('api.loadFileStatus(config, directory)'), 'project dashboard should use /file/status')
assert.ok(/\.project-dashboard[\s\S]*?grid-template-columns:\s*repeat\(3/.test(styles), 'project dashboard should render as compact cards on wide screens')
assert.ok(/@media \(max-width: 780px\)[\s\S]*?\.project-dashboard[\s\S]*?grid-template-columns:\s*1fr/.test(styles), 'project dashboard should stack on mobile')
assert.ok(app.includes('connectionState'), 'sessions view should track connection state separately from one-off runtime errors')
assert.ok(app.includes('backgroundFailureCountRef.current += 1'), 'background refresh should count failures before showing persistent offline errors')
assert.ok(sessionList.includes('connection-pending'), 'initial slow connection should show an explicit loading state instead of an empty sessions list')
assert.ok(app.includes("t('connection.reconnecting')"), 'slow reconnecting state should be translated and shown quietly')
assert.ok(styles.includes('.connection-status'), 'connection status should have a dedicated non-error visual treatment')
assert.ok(app.includes('createFetchOpenCodeEventSubscription'), 'app should use an authenticated fetch-based event stream')
assert.ok(app.includes('api.eventStream(config)'), 'app should derive the event stream URL and auth headers from server config')
assert.ok(app.includes('setEventStreamState("live")'), 'app should expose live event-stream state in the UI')
assert.ok(sessionList.includes('event-stream'), 'sessions header should visibly show the event stream state')
assert.ok(app.includes('isNativeEventTransport()'), 'Android should select the native SSE transport instead of WebView fetch streaming')
assert.ok(app.includes('createNativeOpenCodeEventSubscription'), 'Android should use the native event transport')
assert.match(styles, /\.connection-status\s*\{\s*display:\s*flex;/, 'connection and live-status rows should be stacked, not joined inline')
assert.ok(app.includes('eventType(event.data)'), 'app should unwrap the official global event envelope before filtering')
assert.ok(app.includes('type.startsWith("session.") || type.startsWith("message.") || type.startsWith("todo.")'), 'only session/message/todo events should schedule refreshes')
assert.ok(app.includes('setLiveEventCount((count) => count + 1)'), 'the UI should expose received application events as a counter')
assert.ok(app.includes('scheduleRefresh()'), 'relevant live events should schedule session/message refreshes')
assert.ok(api.includes('eventStream(config: ServerConfig)'), 'API should expose an authenticated global event-stream descriptor')
assert.ok(app.includes('NEW_SESSION_DIRECTORY_STORAGE_KEY'), 'last new-session folder should persist separately from connection settings')
assert.ok(app.includes('showNewSessionPicker'), 'New Session should open a per-session folder picker instead of applying one global folder')
assert.ok(app.includes('api.loadPath(config, selectedNewSessionDirectory)'), 'folder picker should start from OpenCode /path')
assert.ok(api.includes('listFiles(config: ServerConfig, path: string, directory?: string)'), 'API should expose OpenCode /file for directory browsing')
assert.ok(panels.includes("t('sessions.projectDirectoryLabel')"), 'folder picker should be localized')
assert.ok(app.includes("api.createSession(config, t('sessions.remoteSessionTitle'), activeModel, directory)"), 'new sessions should pass the translated remote title and only the picked directory to OpenCode')
assert.ok(app.includes("t('sessions.projectDirectoryInvalid'"), 'picked folders should be validated before creating unusable global sessions')
assert.ok(app.includes('if (!isProjectDirectory(pathInfo))'), 'new session creation should reject folders that OpenCode resolves to the global project')
assert.ok(app.includes('if (current.some((session) => session.id === created.id)) return current'), 'newly created sessions should be inserted before any refresh')
assert.ok(app.includes('async function refreshSessions(silent = false, preserveSession?: SessionView, suppressError = false)'), 'session refresh should accept a newly created session to preserve across stale React state')
assert.ok(app.includes('const toPreserve = preserveSession ?? selected'), 'session refresh should preserve an explicit created session, not only the previous selectedID')
assert.ok(app.includes('await refreshSessions(false, createdView)'), 'new-session flow must preserve the created session during the immediate post-create refresh')
assert.ok(api.includes('createSession(config: ServerConfig, title?: string, model?: ModelSelection, directory?: string)'), 'createSession API should accept a directory')
assert.ok(api.includes('withDirectory("/session", directory)'), 'new session creation should append ?directory= when set')
assert.ok(api.includes('loadTodo(config: ServerConfig, sessionID: string, directory?: string)'), 'todo requests should be directory-aware')
assert.ok(api.includes('loadDiff(config: ServerConfig, sessionID: string, directory?: string)'), 'diff requests should be directory-aware')
assert.ok(api.includes('abort(config: ServerConfig, sessionID: string, directory?: string)'), 'abort requests should be directory-aware')
assert.ok(api.includes('listGlobalSessions(config: ServerConfig)'), 'sessions view should use global session discovery when available')
assert.ok(api.includes('x-next-cursor'), 'global session discovery should page through all experimental session results')
assert.ok(app.includes('api.listSessions(config, directory).catch(() => [] as Session[])'), 'global sessions should be hydrated from scoped session lists for fresh timestamps and summaries')
assert.ok(api.includes('loadLatestMessage(config: ServerConfig, sessionID: string, directory?: string)'), 'API should expose a cheap latest-message request')
assert.ok(app.includes('function messageActivityTime'), 'sessions should display latest message activity instead of mutable session row timestamps')
assert.ok(app.includes('latestMessageTimesRef'), 'latest message activity lookups should be cached between refreshes')
assert.ok(app.includes('catch(() => null)'), 'failed latest-message lookups should not be cached as session row timestamps')
assert.match(app, /setRefreshingSessions\(false\)[\s\S]*?refreshIndicatorRequestRef\.current \+= 1/, 'context replacement must synchronously reset a stale refresh indicator')
assert.match(app, /const isLeaseContextCurrent = \(lease: MutationLease\)[\s\S]*?isContextGenerationCurrent\(lease\.contextGeneration\)[\s\S]*?isContextCurrent\(lease\.context\)/, 'lease ownership and UI currency must be checked separately')
assert.match(app, /const cacheKey = `\$\{activityContext\.profileID\}\|\$\{activityContext\.configKey\}\|\$\{session\.id\}`/, 'latest-message activity cache must be scoped to profile, config, and session')
assert.match(app, /if \(activityIsCurrent\(\)\) latestMessageTimesRef\.current\.set/, 'stale activity responses must not repopulate the cache')
assert.match(app, /disabled: mutationLocked \|\| sessionActionPending !== null/, 'message history menus must include the shared mutation lock')
assert.match(app, /case "session\.new":[\s\S]*?if \(!hasConfiguredServer \|\| isOffline \|\| isSessionMutationLocked\(\)\) return/, 'native and keyboard New must defensively honor configuration, offline, and shared mutation guards')
assert.match(app, /function openNewSessionPicker\(\)[\s\S]*?isSessionMutationLocked\(\)/, 'direct New picker opens must honor the shared lock')
assert.match(app, /function startRename\([\s\S]*?isSessionMutationLocked\(\)/, 'direct rename opens must honor the shared lock')

assert.ok(app.includes('THEME_STORAGE_KEY'), 'theme preference should persist separately from server settings')
assert.ok(app.includes('type ThemePreference = "system" | "light" | "dark"'), 'theme preference should support system, light, and dark')
assert.ok(app.includes('window.matchMedia("(prefers-color-scheme: dark)"'), 'system theme should follow prefers-color-scheme')
assert.ok(app.includes('document.documentElement.dataset.theme = resolvedTheme'), 'theme should be applied to the root element for CSS variables')
assert.ok(app.includes("t('settings.theme')"), 'settings should expose a localized theme picker')
assert.ok(styles.includes(':root[data-theme="dark"]'), 'dark mode should override design tokens through CSS variables')
assert.ok(styles.includes('--nav-bg'), 'theme-sensitive navigation background should use a variable')
assert.ok(styles.includes('--primary-border'), 'theme-sensitive active borders should use a variable')
assert.ok(styles.includes('--focus-ring'), 'theme-sensitive focus ring should use a variable')

assert.ok(app.includes('ReactMarkdown'), 'messages should use a maintained Markdown renderer')
assert.ok(app.includes('remarkGfm'), 'messages should support GitHub-flavored Markdown')
assert.ok(/\.message-content pre[\s\S]*?overflow-x:\s*auto/.test(styles), 'fenced code blocks should render as scrollable blocks')

assert.match(icons, /export const RefreshIcon/, 'RefreshIcon should exist for idle refresh UI')

// Android back button: dismiss the topmost layer, then fall back to the session list.
const backStart = app.indexOf('CapacitorApp.addListener("backButton"')
assert.notEqual(backStart, -1, 'the Android back button should be handled')
const backHandler = app.slice(backStart, app.indexOf('}, [])', backStart))
assert.equal(
  /setView\(\(current\)/.test(backHandler),
  false,
  'exitApp must not run inside a state updater, which React may invoke more than once'
)
assert.ok(backHandler.includes('backStateRef.current'), 'the handler is registered once, so it must read state through a ref')
assert.ok(backHandler.includes('if (removed) void registered.remove()'), 'a listener registered after teardown must still be removed')
for (const layer of ['sessionToDelete', 'renamingSessionID', 'activeDetailSheet']) {
  assert.ok(backHandler.includes(layer), `back should dismiss ${layer} before leaving the view`)
}
assert.ok(
  backHandler.indexOf('exitApp') > backHandler.indexOf('setView("sessions")'),
  'the app should only exit from the session list'
)

assert.ok(app.includes('api.capabilities(config).then(setCapabilities)'), 'bridge capabilities must be loaded from the selected harness')
for (const capability of ['agents', 'models', 'todos', 'diff', 'questions', 'permissions', 'sessionRename', 'sessionDelete', 'compactSession', 'forkSession']) {
  assert.ok(app.includes(`capabilities.${capability}`), `${capability} UI must be capability-driven`)
}
assert.ok(/capabilities\.compactSession[\s\S]*?t\('detail\.compactSession'\)/.test(app), 'compact must be a capability-gated current-session menu action')
assert.ok(/capabilities\.forkSession[\s\S]*?t\('detail\.forkSession'\)/.test(app), 'fork must be a capability-gated current-session menu action')
assert.ok(/selectedSession && config\.backend === "opencode2" && capabilities\.compactSession/.test(app), 'compact must only render for the OpenCode 2 backend')
assert.ok(/selectedSession && config\.backend === "opencode2" && capabilities\.forkSession/.test(app), 'fork must only render for the OpenCode 2 backend')
assert.ok(app.includes("compactSessionV2(config, selectedSession.id, selectedSession.directory, compactRequestID)"), 'compact must invoke the API once for the selected session with a stable admission id')
assert.ok(app.includes("setActionNotice(t('detail.compactQueued'))"), 'compact must show the queued notice without replacing the session')
assert.ok(app.includes('const forked = await api.forkSession(config, original.id, original.directory)'), 'fork must invoke the API once for the current session')
assert.ok(app.includes('setSessions((current) => current.some((session) => session.id === forkedView.id)'), 'fork must insert the returned child while preserving the original')
assert.ok(app.includes('await openSession(forkedView.id, forkedView.directory)'), 'fork must navigate through the shared session-opening path')
assert.ok(app.includes('forkFocusSessionRef.current = forkedView.id') && app.includes('detailHeadingRef.current?.focus()'), 'fork navigation must focus the mounted child session context')
assert.match(app, /const forkContext = \{[\s\S]*?profileID: activeProfileID[\s\S]*?configKey: configKey\(config\)[\s\S]*?sessionID: original\.id/, 'fork must capture the active profile, server, and session identity before awaiting')
// Indeterminate fork reconciliation must not depend on the released lease: it keeps its own
// captured context/generation, a baseline of pre-existing children, paginated authoritative
// listings with bounded retries, and a resolvable terminal notice instead of a hanging spinner.
assert.ok(app.includes('const baselineChildIDs = new Set<string>()'), 'fork must capture the pre-existing child ids as a baseline')
assert.ok(app.includes('!baselineChildIDs.has(candidate.id)'), 'fork reconciliation must only navigate to the NEW child, never an older fork child')
assert.match(app, /const isReconcileCurrent = \(\) => mutationCoordinator\.isContextGenerationCurrent\(reconcileGeneration\)/, 'fork reconciliation must be current-checked by captured generation, not by the released lease')
assert.ok(app.includes('FORK_RECONCILE_MAX_ATTEMPTS'), 'fork reconciliation must be bounded')
assert.ok(app.includes('detail.forkUnconfirmed'), 'an unconfirmed fork must resolve with a retryable notice')
assert.ok(app.includes('restoreForkDraft(childView.id)'), 'reconciled child navigation must restore the forked draft and attachments')
// Compaction must correlate terminal state to the exact admission id returned by the server, and
// resolve (instead of hanging) when the admission cannot be established.
assert.match(app, /observation\.expectedID = admission\?\.id \?\? compactRequestID/, 'compact must track the exact admission id from the server response')
assert.ok(app.includes('observation.expectedID'), 'compact terminal state must be correlated to the tracked admission id')
assert.ok(app.includes('detail.compactUnconfirmed'), 'an unconfirmed compaction must resolve with a retryable notice instead of blocking forever')
assert.ok(app.includes('COMPACTION_PENDING_MAX_MS'), 'compaction pending state must have a bounded deadline')
// Stable request ids make post-transmission retries idempotent: the same id is re-sent, and the
// server's 409 conflict (or silent dedupe for skills) confirms the earlier admission.
assert.ok(app.includes('const promptRequestID = createMessageRequestID()'), 'prompt sends must carry a stable durable admission id')
assert.ok(app.includes('const commandRequestID = createMessageRequestID()'), 'slash commands must carry a stable durable admission id')
assert.ok(app.includes('const skillRequestID = createMessageRequestID()'), 'skill activations must carry a stable durable admission id')
assert.ok(app.includes('const compactRequestID = createMessageRequestID()'), 'compactions must carry a stable durable admission id')
assert.ok(app.includes('isAdmissionConflict(retryErr)'), 'an idempotent retry must recognize the 409 conflict that confirms the earlier admission')
assert.ok(app.includes("t('detail.deliveryAdmitted')"), 'a confirmed idempotent retry must announce the resolved delivery')
assert.match(
  app,
  /if \(!isLeaseContextCurrent\(lease\) \|\| !mutationCoordinator\.isContextCurrent\(forkContext\)\) return/,
  'a stale fork completion must be discarded by lease, context, and fork validation before inserting or navigating'
)
assert.ok(
  /const sessionHeaderActions = useMemo\([\s\S]*?const compactDisabled = mutationLocked \|\| sessionActionPending !== null \|\| !hasUserMessage \|\| isWorking \|\| busySending[\s\S]*?const forkDisabled = mutationLocked \|\| sessionActionPending !== null \|\| !hasUserMessage \|\| isWorking \|\| busySending[\s\S]*?\}, \[awaitingAssistantReply,/.test(app),
  'compact and fork must share the coordinator lock and retain the visible-message and active-work guards'
)
assert.ok(
  /id: "undo", label: t\('detail\.undo'\), disabled: mutationLocked \|\| sessionActionPending !== null/.test(app)
    && /id: "redo", label: t\('detail\.redo'\), disabled: mutationLocked \|\| sessionActionPending !== null/.test(app),
  'undo and redo must share the coordinator lock and be disabled while compact or fork is pending'
)
assert.ok(
  /function compactCurrentSession\(\)[\s\S]*?config\.backend !== "opencode2"[\s\S]*?isWorking[\s\S]*?busySending[\s\S]*?isSessionMutationLocked\(\)[\s\S]*?!hasAnyUserMessage\(messages, optimisticUserMessages, queuedInboxMessages\)/.test(app)
    && /function forkCurrentSession\(\)[\s\S]*?config\.backend !== "opencode2"[\s\S]*?isWorking[\s\S]*?busySending[\s\S]*?isSessionMutationLocked\(\)[\s\S]*?!hasAnyUserMessage\(messages, optimisticUserMessages, queuedInboxMessages\)/.test(app),
  'compact and fork handlers must retain the backend, coordinator, visible-message (including optimistic and queued rows), and active-work guards'
)

// A follow-up prompt can be queued while the agent is still working.
assert.ok(app.includes('const showStopAction = canAbortSession'), 'stop should remain offered while a working session has a draft')
assert.equal(app.includes('disabled={!selectedSession || isWorking}'), false, 'the composer must stay usable while the agent works')
// Prompts must queue for the whole window where compaction has acknowledged but is not terminal,
// read through the synchronous ref so a send in the same tick as a pending compact still queues.
assert.ok(
  app.includes('sessionActionPendingRef.current === "compact" || sessionActionPending === "compact"'),
  'a follow-up prompt must queue while a compaction is pending, not steer into it'
)
// Queued delivery metadata must survive server reconciliation: the inbox is the authoritative
// delivery source, its metadata is overlaid on fetched transcripts, and inbox-only queued prompts
// render as stable transcript rows.
assert.ok(app.includes('listInboxV2(config, sessionID, directory)'), 'session loads must read the v2 inbox for queued delivery state')
assert.ok(app.includes('applyInboxDelivery(msg, inbox)'), 'server delivery metadata must be overlaid on fetched transcripts')
assert.ok(app.includes('queuedInboxMessageEnvelopes(sessionID, inbox'), 'inbox-only queued prompts must render as stable transcript rows')
assert.ok(app.includes('queuedInboxMessages'), 'server-admitted queued prompts must survive reconciliation as transcript state')
assert.ok(app.includes('role="status" aria-live="polite"'), 'indeterminate delivery and other action notices must announce with accessible live semantics')

// --- Exact-delivery client contract (issues #1-#6) ---------------------------------------------
// Optimistic prompt/command rows are tagged with the admission response's durable message id and
// retire by that EXACT id once the message reaches history or the inbox — immune to identical text
// sent twice. Text matching is only the fallback for rows still awaiting their admission response
// (or whose response was lost), guarded by creation time so a pre-existing identical message can
// never retire a fresh row.
assert.ok(app.includes('durableID'), 'optimistic rows must carry the server-confirmed durable message id')
assert.match(
  app,
  /function hasMatchingUserMessage\([\s\S]*?if \(optimistic\.info\.durableID\) \{[\s\S]*?message\.info\.id === optimistic\.info\.durableID[\s\S]*?\}[\s\S]*?extractText\(optimistic\)/,
  'optimistic retirement must prefer the exact durable id and fall back to text only for untagged rows'
)
assert.match(app, /message\.info\.time\.created >= optimistic\.info\.time\.created/, 'the text fallback must only match messages created after the optimistic row was sent')
assert.match(app, /durableID: admission\?\.messageID[\s\S]*?delivery: admission\?\.delivery/, 'a confirmed admission must tag the optimistic row with the returned message id and delivery')
assert.match(app, /durableID: promptRequestID/, 'a 409-confirmed prompt retry must tag the row with its durably admitted request id')
assert.match(app, /durableID: commandRequestID/, 'a 409-confirmed command retry must tag the row with its durably admitted request id')
assert.match(app, /const readmission = await sendPromptV2\([\s\S]*?durableID: readmission\.messageID/, 'a prompt retry must use the returned admission metadata')
assert.match(app, /const readmission = await sendCommandV2\([\s\S]*?durableID: readmission\.messageID/, 'a command retry must use the returned admission metadata')
// Queued delivery renders a localized status for every row — fetched transcripts overlaid with the
// inbox, optimistic rows tagged with queue delivery, and inbox-only queued rows — on both layouts.
assert.match(
  app,
  /message\.info\.delivery === "queue" && <div className="message-delivery-notice">\{t\('detail\.queuedPrompt'\)\}/,
  'every queued row must render the localized queue status in the shared message view'
)

// Compaction correlates terminal state ONLY with the exact admission/request id — no baseline or
// any-terminal heuristic — including the double-indeterminate path where the request id is the only
// known-valid correlation; context mismatches clear the observation and the pending state.
assert.equal(app.includes('observation.baseline'), false, 'compaction must not track a baseline of pre-existing compaction messages')
assert.equal(app.includes('observation.observed'), false, 'compaction must not track observed running message ids')
assert.match(
  app,
  /const expected = observation\.expectedID[\s\S]*?compactions\.find\(\(message\) => message\.info\.id === observation\.expectedID\)/,
  'terminal compaction state must only release on the exact expected message id'
)
assert.match(app, /isAdmissionConflict\(retryErr\)[\s\S]*?observation\.expectedID = compactRequestID/, 'a 409-confirmed compaction must correlate with the durably admitted request id')
assert.match(app, /isIndeterminateDeliveryError\(retryErr\)[\s\S]*?observation\.expectedID = compactRequestID[\s\S]*?deliveryIndeterminate/, 'a double-indeterminate compaction must still correlate with the request id and announce indeterminate delivery')
assert.match(
  app,
  /observation\.context !== context \|\| !selectedID[\s\S]*?compactObservationRef\.current === observation[\s\S]*?setSessionActionPending\(null\)/,
  'a stale compaction context must clear its observation and pending state'
)

// Fork reconciliation clears pending in a finally on exhaustion or confirmed navigation, and the
// draft restore is guarded so newer child edits are never overwritten.
assert.match(
  app,
  /const reconcileFork = async \(\) => \{[\s\S]*?finally \{[\s\S]*?if \(isReconcileCurrent\(\)\) finishForkPending\(\)/,
  'fork reconciliation must release pending state in a finally on exhaustion or navigation'
)

// Skill activation is NOT durably admitted by id: an indeterminate failure must never retry the
// POST automatically (a duplicate event id can defect); the tagged optimistic row plus poll
// confirmation correlated by the original request id is the only safe reconciliation, and the
// indeterminate notice must never read as a definite failure.
assert.equal((app.match(/await sendSkillV2\(/g) ?? []).length, 1, 'skill activation must never retry the POST automatically, even on indeterminate delivery')
assert.ok(app.includes('pendingSkillRequestsRef'), 'lost skill acknowledgements must be tracked for poll confirmation')
assert.match(app, /pendingSkillRequestsRef\.current\.set\(skillRequestID, \{ sessionID: session\.id, skillName: skill\.name \}\)/, 'an indeterminate skill activation must register its original request id for confirmation')
assert.match(app, /transcript\.some\(\(message\) => message\.info\.id === requestID\)/, 'skill confirmation must correlate by the original request id in history')
assert.match(
  app,
  /if \(!isIndeterminateDeliveryError\(err\)\) \{[\s\S]*?help\.skillActivationFailed[\s\S]*?\} else \{[\s\S]*?pendingSkillRequestsRef\.current\.set[\s\S]*?detail\.deliveryIndeterminate/,
  'indeterminate skill delivery must reconcile via the accessible indeterminate notice, never a definite-failure message'
)

// External OMP history must replace stale cached ordering even when the corrected payload is shorter.
// This no longer needs its own escape hatch: every fetched snapshot is now applied, and only same-id
// same-type text is held back from shrinking, so a corrected external history replaces the cache.
assert.ok(app.includes("if (!messagesHaveSameContent(current, transcript)) {"), "a fetched snapshot must be applied whenever it differs from what is on screen")
// The marker moved from below the messages, where the sticky composer cut it in half, into the
// header. What matters is that an external session is still marked and still explained, not where.
assert.ok(app.includes("selectedSession.external && ("), "a session from another client must be marked as such")
assert.ok(
  app.includes("t('detail.externalSession')") && !app.includes("externalShort"),
  "the marker must read as a sentence, not a one-word tag that needs a tooltip touch cannot show"
)
assert.equal(app.includes("disabled={!selectedSession || selectedSession.external}"), false, "external sessions must remain writable")
assert.ok(composerView.includes('hasQueuedFollowUp') && composerView.includes('onClick={sendNow}') && composerView.includes('onClick={onAbort}'), 'a working composer must expose both queued Send and reachable Stop controls')
assert.match(composerView, /disabled=\{!selected \|\| !canAbortSession\}/, 'Stop must remain enabled while an active prompt is being cancelled')
assert.match(app, /const canAbortSession = Boolean\(selectedSession && isWorking[\s\S]*?activeWorkingLease\.kind === "skill"/, 'Stop must be allowed only as an out-of-band action for active prompt, command, or skill work')
assert.match(app, /const activeLease = mutationCoordinator\.getActiveLease\(\)[\s\S]*?const lease = activeLease \? null : acquireMutation\("abort"\)/, 'abort must not steal the active prompt lease or release it as if it owned it')
assert.match(app, /session\.stop[\s\S]*?disabled: !canAbortSession/, 'native menu and palette Stop entries must use the abort-specific availability guard')
assert.ok(app.includes('const abortInFlightRef = useRef(new Map<string, Promise<void>>())'), 'abort requests need a synchronous per-context in-flight registry')
assert.match(app, /abortInFlightRef\.current\.has\(abortKey\)[\s\S]*?abortInFlightRef\.current\.set\(abortKey, operation\)/, 'repeated Stop must deduplicate and presentation must share handler availability')
assert.match(app, /const abortContextGeneration = mutationCoordinator\.getContextGeneration\(\)[\s\S]*?isContextGenerationCurrent\(abortContextGeneration\)[\s\S]*?isContextCurrent\(abortContext\)/, 'abort completion and cleanup must reject an away-and-back ABA context')
assert.match(app, /activeLease\.context\.profileID === abortContext\.profileID[\s\S]*?activeLease\.context\.configKey === abortContext\.configKey/, 'abort authorization must match the full active lease context')
assert.match(app, /const isSessionMutationLocked = \(\) => mutationCoordinator\.getActiveLease\(\) !== null \|\| abortInFlightRef\.current\.size > 0/, 'an abort remains a mutation lock after the original lease releases')
assert.ok(composerView.includes('canAbortSession'), 'composer Stop presentation must receive the abort availability guard')
assert.match(app, /runtimeError && <div className="error fade-in" role="alert">/, 'runtime errors must be announced accessibly in the detail view')
assert.equal(
  app.slice(app.indexOf('async function activateSkill'), app.indexOf('async function send()')).includes('setAttachments([])'),
  false,
  'successful skills must preserve staged attachments because the skill API does not transmit them'
)
const commandDispatch = app.slice(app.indexOf('await api.sendCommand(config, selectedSession.id, command'), app.indexOf('    const promptLease'))
assert.equal(commandDispatch.includes('setAttachments([])'), false, 'successful slash commands must preserve staged attachments')
assert.equal(app.slice(app.indexOf('if (localCommand === "help"'), app.indexOf('let availableCommands = commands')).includes('setAttachments([])'), false, 'local help, commands, skills, and status views must preserve staged attachments')
assert.match(commandDispatch, /api\.sendCommand[\s\S]*?let refreshFailed = false[\s\S]*?setActionNotice/, 'command refresh failures must be soft notices after dispatch commits')
assert.match(app, /activateSkill\(skill: CommandInfo[\s\S]*?stagedAttachments[\s\S]*?setAttachments\(\(current\) => current\.length \? current : stagedAttachments\)/, 'failed skills must restore their staged attachments in the same context')
assert.match(app, /api\.sendCommand[\s\S]*?setAttachments\(\(current\) => current\.length \? current : attachments\)/, 'failed slash commands must restore their staged attachments')
assert.match(app, /abortInFlightRef\.current\.delete\(abortKey\)[\s\S]*?bumpMutationLock\(\(value\) => value \+ 1\)/, 'stale abort cleanup must repaint the mutation lock even outside the current context')
assert.ok(app.includes('readSessionTombstones') && app.includes('persistSessionTombstones'), 'session tombstones must hydrate and persist safely')

// A run bubble merges action groups that a message boundary split apart. Consecutive replies with
// nothing groupable in them must stay separate, or two answers to two queued prompts render as one.
const groupRenderer = app.slice(app.indexOf('function groupRenderedMessages'), app.indexOf('function ConversationRunView'))
assert.ok(groupRenderer, 'consecutive assistant messages should be grouped for rendering')
assert.ok(
  groupRenderer.includes('!buffer.some((message) => message.parts.some((part) => ACTION_GROUP_TYPES.has(part.type)))'),
  'a run must only form when the buffered messages actually contain groupable parts'
)
assert.ok(
  groupRenderer.includes('for (const message of buffer) groups.push({ kind: "message", message })'),
  'text-only replies must each keep their own bubble'
)

// A model list that never arrived used to render as "loading" forever, which reads as a slow
// server rather than a failure — the reason a misconfigured server looked like a broken feature.
// Asserted on the failure branch alone: the label now has three states, and pinning the whole
// expression would break again the next time one is added.
assert.ok(
  app.includes("modelLoadError ? t('detail.modelUnavailable') : t('detail.modelLoading')"),
  'a failed model fetch must be named, not shown as still loading'
)
assert.ok(
  app.includes('activeModelOption?.modelName') && app.includes('const modelStatusLabel'),
  'a model already known must keep showing, even if a later refresh fails'
)
assert.equal(
  app.includes("activeModelOption?.modelName ?? t('detail.modelLoading')"),
  false,
  'every model label should go through modelStatusLabel so the failure state cannot be missed'
)
assert.ok(app.includes('chip-warning'), 'the context chip should mark the failure visually')

// The harness in use decides what the app can do, so it is named in the header.
assert.ok(shell.includes('className={`harness-badge harness-${profile.backendClass}`}'), 'the server switcher should badge each harness')
assert.ok(shell.includes('{profile.backendLabel}'), 'the badge should show the harness display name')
for (const cls of ['.harness-badge', '.harness-omp', '.harness-pi', '.brand-server']) {
  assert.ok(styles.includes(cls), `${cls} should be styled`)
}
assert.match(styles, /\.brand-server[\s\S]*?text-overflow: ellipsis/, 'a long address must truncate rather than push the badge off screen')

// Mobile keyboard: an address is not a sentence, a port is a number, and a soft keyboard has
// no Shift key — so the composer flips on touch-primary devices: Enter inserts a new line,
// Ctrl/Cmd+Enter sends, the send button covers soft-keyboard-only devices. Fine pointers keep
// Enter sends / Shift+Enter new line, untouched for every user with a physical keyboard.
assert.ok(app.includes('inputMode="url"') && app.includes('autoCapitalize="none"'), 'the host field must not be autocapitalised or autocorrected')
assert.ok(app.includes('inputMode="numeric"'), 'the port field should raise a numeric keypad')
assert.ok(app.includes('autoComplete="username"') && app.includes('autoComplete="current-password"'), 'credentials should be offerable by a password manager')
assert.ok(composerView.includes('enterKeyHint={softKeyboard ? "enter" : "send"}'), "the composer's action key should say send on a fine pointer and new line on a soft keyboard")
assert.ok(composerView.includes('if (event.ctrlKey || event.metaKey)'), 'a soft keyboard must send with Ctrl/Cmd+Enter and newline with plain Enter')
assert.ok(composerView.includes('if (!event.shiftKey)'), 'a fine pointer must keep Enter sends / Shift+Enter new line')
assert.match(composerView, /if \(!mutationLocked && pendingPreparation === 0\) sendNow\(\)/, 'keyboard send must stay blocked while the mutation lease or attachment preparation is active')

// A session card showed a full absolute path over three lines, a third of its height.
assert.ok(sessionList.includes('function shortDirectory'), 'the card should shorten the directory it shows')
assert.ok(sessionList.includes('<span className="session-card-directory" title={session.directory}>{shortDirectory(session.directory)}</span>'), 'the full path should stay available as a title on the styled directory span')
assert.equal(sessionList.includes("t('sessions.noFileChanges')"), false, 'absence of changes needs no line of its own on a phone')

// Hover is not a state a finger can produce.
// The defect was a control left at 60% opacity until hovered, a state a finger cannot produce.
// What must hold is that hover-dependent styling is behind a hover query, and that nothing
// interactive is dimmed by default. Disabled controls and the typing animation are not that.
assert.ok(styles.includes('@media (hover: hover)'), 'hover-dependent styling must be behind a hover query')
const dimmedOutsideHover = styles
  .split('@media (hover: hover)')[0]
  .match(/opacity: 0\.\d+/g)
  ?.filter((rule) => rule !== 'opacity: 0.45' && rule !== 'opacity: 0.35') ?? []
assert.deepEqual(dimmedOutsideHover, [], 'no interactive control should start dimmed on a touch device')
assert.ok(styles.includes('-webkit-tap-highlight-color: transparent'), 'the platform tap flash should not fight the pressed state')
assert.ok(styles.includes('overscroll-behavior: contain'), 'scrolling to the end of a list should not drag the page')
assert.match(styles, /button\.compact \{[\s\S]*?min-height: 44px/, 'a compact button is still a thumb target')

// A phone returning from standby can miss a couple of polls while Wi-Fi and the server wake up.
// Keep the last valid UI and show a quiet reconnect state before presenting the offline screen.
assert.ok(app.includes('const isOffline = connectionState === "offline"'), 'offline should be one named state')
assert.ok(
  app.includes('if (backgroundFailureCountRef.current < 3)'),
  'background refreshes should retry twice before declaring the server offline'
)
assert.ok(app.includes('eventStreamText = isOffline'), 'the event stream must not claim to be reconnecting while the connection is down')
assert.ok(
  sessionList.includes('runtimeError && !(offline && filteredSessions.length === 0)'),
  'the offline state explains itself; the raw transport error must not repeat it'
)
assert.ok(sessionList.includes("t('sessions.retry')"), 'an offline state should offer a way out')
assert.ok(sessionList.includes('disabled={creating || mutationLocked || offline}'), 'an action that cannot succeed offline or under the mutation lock must not be offered')
assert.ok(styles.includes('.empty-state-actions'), 'the offline actions should be styled')

// The question tool's own parameter schema has no `custom` field at all, so a question always
// arrives with it undefined and the documented default of `true` applies. Testing it for
// truthiness therefore hid the free-text answer on every question ever asked.
assert.ok(
  app.includes('question.custom !== false'),
  'the free-text answer must be offered unless a question opts out of it explicitly'
)
assert.equal(
  /question\.custom &&/.test(app),
  false,
  'a missing `custom` flag means enabled, so it must never be read as a boolean'
)
assert.match(
  app,
  /if \(!multiple\) \{[\s\S]*?setCustomValues\(/,
  'choosing an option in a single-answer question must clear the typed answer, so only one of the two is submitted'
)

// A backend is reachable only if every layer knows it. Declaring a `BackendKind` and wiring the
// bridge profile, capabilities and storage key is not enough: without an <option> in the Settings
// picker there is no way to select it, and the README ends up documenting a backend the app cannot
// open. Derived from the union rather than hard-coded, so adding a harness fails here until the
// picker, the display name and the persisted-value guards all accept it.
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const backendKinds = (types.match(/export type BackendKind =([^\n]+)/)?.[1] ?? '')
  .split('|')
  .map((kind) => kind.trim().replace(/"/g, ''))
  .filter(Boolean)
assert.ok(backendKinds.length >= 3, `BackendKind should parse into its members, got ${JSON.stringify(backendKinds)}`)
for (const kind of backendKinds) {
  assert.ok(
    app.includes(`<option value="${kind}">`),
    `backend "${kind}" is declared in BackendKind but has no option in the Settings picker, so it cannot be selected`
  )
  assert.ok(
    app.includes(`=== "${kind}"`),
    `backend "${kind}" is declared in BackendKind but never compared against in App.tsx, so stored values and display names will not accept it`
  )
}

// `loadModels` returns early when the harness exposes no model list, so anything that reports
// progress has to distinguish "nothing to load" from "still loading" or it sits on the loading text
// forever. The Claude Code backend did exactly that: `models: false`, and an AI panel that claimed
// to be loading for the life of the session.
// Matched with \s+ rather than a literal newline: these sources are checked out with CRLF endings.
assert.match(
  app,
  /\?\?\s*\(!capabilities\.models\s+\?\s*t\('detail\.modelNotSupported'\)/,
  'the model status label must say a harness has no model selection rather than claiming to load'
)
assert.match(
  app,
  /\{!capabilities\.models\s+\?\s*t\('detail\.modelNotSupported'\)/,
  'the AI panel must say a harness has no model selection rather than claiming to load'
)

// The harness names a model "Sonnet" and puts which Sonnet in the description. Showing the provider
// there instead was fine when it distinguished anything; with one synthesised provider it read as
// "claude" on all five rows while the version stayed invisible.
assert.match(
  app,
  /\[option\.description \?\? option\.providerName, option\.variant\]/,
  "the model picker's secondary line must prefer the harness description, falling back to the provider"
)

// A tool event is created before its streamed arguments arrive. Calling that action complete (or
// exposing its empty `{}` payload) falsely signals that the tool has already run.
assert.match(
  app,
  /const isPreparing = \(status === "pending" \|\| status === "running"\) && Object\.keys\(input\)\.length === 0/,
  'an active tool with no streamed input must remain in its preparing state'
)
assert.match(
  app,
  /const displayLabel = isPreparing \? t\('action\.preparingTool', \{ tool: part\.tool \|\| t\('action\.actionsFallback'\) \}\) : label/,
  'preparing tools must identify the pending tool instead of presenting an empty call as complete'
)
assert.ok(app.includes('>{displayLabel}</span>'), 'the tool summary must show the preparing label')


assert.match(app, /onContextMenu=\{\(event\) => \{\s*event\.preventDefault\(\)\s*open\(event\.clientX, event\.clientY, window\.matchMedia/, 'right-clicking a message must open its action menu')
assert.match(app, /event\.pointerType !== "touch"/, 'touch messages must support long-press actions')
assert.match(clipboard, /navigator\.clipboard\?\.writeText/, 'message actions must copy to the system clipboard')
assert.match(app, /markdown \? normalizeMessageMarkdown\(text\) : stripMarkdownDirectives\(text\)/, 'the menu must distinguish plain-text and markdown copies, stripping directive markup from both')
assert.match(styles, /\.message-context-menu\s*\{[\s\S]*?position:\s*fixed/, 'message actions must render above the scrolling transcript')
assert.match(app, /window\.matchMedia\("\(pointer: coarse\)"\)\.matches/, 'a touch context-menu event must keep the mobile menu layout')
assert.match(app, /Math\.hypot\(movedX, movedY\) > 10/, 'moving to scroll must cancel the pending long-press menu')
assert.match(styles, /\.message-context-menu--touch\s*\{[\s\S]*?bottom:\s*max\(/, 'the touch menu must render as a reachable bottom sheet')
assert.match(styles, /@media \(pointer: coarse\)\s*\{[\s\S]*?\.message\s*\{[\s\S]*?user-select:\s*none/, 'mobile long-press must not also select message text')
// A menu that only closes on its own items is a menu that stacks: the state is per bubble, so a
// right-click on a second message left the first one hanging over the transcript.
assert.match(app, /window\.addEventListener\("pointerdown", dismiss\)/, 'pressing outside an open message menu must dismiss it')
assert.match(app, /if \(event\.key === "Escape"\) dismiss\(\)/, 'Escape must dismiss an open message menu')
assert.match(app, /window\.addEventListener\("scroll", dismiss, true\)/, 'a fixed menu must not stay behind while the transcript scrolls under it')
assert.match(app, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/, 'choosing an item must not count as pressing outside, or the menu unmounts before the click lands')
// The Clipboard API needs a secure context, and the app is reachable over plain http on a LAN,
// where `navigator.clipboard` is undefined and reaching into it throws past any `.catch()`.
assert.match(clipboard, /document\.execCommand\("copy"\)/, 'copying must still work where the Clipboard API is unavailable')
// Both copy options did nothing on any bubble whose parts carry no text — a run ending on a tool
// call, an agent turn that only worked and never spoke. The menu was handed the run's last message,
// and `extractText` returns "" for those, so the copy wrote an empty string: the paste came back
// empty and whatever the user had in the clipboard was gone with it.
assert.match(
  app,
  /const runText = \[\.\.\.messagesByID\.values\(\)\]\.map\(\(message\) => message\.text\)\.filter\(Boolean\)\.join\("\\n\\n"\)/,
  'a run bubble must copy every message it shows, not just the last one'
)
assert.match(app, /<MessageContextMenu\s+text=\{runText\}/, 'the run bubble must hand the menu the whole run text')
assert.ok(
  !/<MessageContextMenu message=/.test(app),
  'the menu takes the text to copy: passing a message let a bubble that shows several, or none, claim one'
)
assert.match(app, /if \(!text && actions\.length === 0\) return <article className=\{className\}>\{children\}<\/article>/, 'a bubble with neither copy nor harness actions must not offer the menu')
assert.match(clipboard, /if \(!text\) return\s*\n\s*try \{/, 'an empty copy must not replace what the user already had in the clipboard')
assert.match(clipboard, /selection\.addRange\(previousRange\)/, 'the fallback carrier must give the selection back after stealing it')
assert.match(app, /supported\.has\("undo"\)/, 'Undo must appear only when the connected harness exposes the command')
assert.match(app, /supported\.has\("redo"\)/, 'Redo must appear only when the connected harness exposes the command')
assert.match(app, /api\.revertMessage\(config, selectedSession\.id, messageID/, 'OpenCode message actions must use its targeted revert endpoint')
assert.match(app, /message\.info\.id < revertMessageID/, 'a staged OpenCode revert must hide messages from its boundary onward')
assert.match(app, /const hasRedo = config\.backend === "opencode" \|\| config\.backend === "opencode2" \? !!revertMessageID : redoAction \? redoAction\.enabled : true/, 'OpenCode Redo must only appear while a revert is staged and extension Redo must follow session state')
assert.match(app, /const supportsRedo = config\.backend === "opencode" \|\| config\.backend === "opencode2" \|\| !!redoAction \|\| supported\.has\("redo"\)/, 'OpenCode native history actions must not depend on the server command list')
assert.match(app, /message-context-menu__separator/, 'harness actions must be visually separated from copy actions')
assert.match(styles, /\.message-context-menu button\s*\{[\s\S]*?justify-content:\s*flex-start[\s\S]*?text-align:\s*left/, 'message action labels must align to the menu edge')
// The rule was written for a field that no longer exists, but the class outlived it: dropping the
// declaration with its original caller left the server name silently back in half a row.
if (app.includes('className="field-row-span"')) {
  assert.match(
    styles,
    /\.field-row-span\s*\{[^}]*grid-column:\s*1 \/ -1;/,
    'a field asking for the whole settings row needs the rule that grants it'
  )
}

assert.match(
  app,
  /function isSessionWorking\(status: string\): boolean \{\s*return status === "busy" \|\| status === "retry" \|\| status === "waiting"/,
  'waiting sessions must remain working sessions rather than becoming idle'
)
assert.match(styles, /\.pill\.waiting\s*\{[^}]*background:\s*var\(--primary-soft\)/, 'waiting sessions need a distinct status pill')
assert.match(styles, /\.session-card\.waiting::before\s*\{[\s\S]*?animation-name:\s*session-waiting-sweep/, 'desktop waiting sessions need their own animation')

// The waiting marker first shipped naming two colours the palette never declared, and the
// assertions above could not tell: they read the rule as text. A `var()` with no fallback pointing
// at nothing is invalid at computed-value time, so the browser drops the whole declaration and the
// marker paints nothing at all. Checked over the sheet rather than that one rule, since any other
// token typo fails exactly as quietly.
const declaredTokens = new Set([...styles.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]))
const undeclaredTokens = [...new Set(
  [...styles.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)]
    .map((match) => match[1])
    .filter((token) => !declaredTokens.has(token))
)]
assert.deepEqual(undeclaredTokens, [], 'a custom property used without a fallback must be declared')
// Declared in one theme only fails just as silently, and half of it is invisible to whoever is not
// using that theme. The dark block overrides `:root`, so every name it carries has to exist there.
const themeTokens = (block) => new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]))
const rootTokens = themeTokens(styles.match(/^:root \{([\s\S]*?)^\}/m)[1])
const darkOnlyTokens = [...themeTokens(styles.match(/color-scheme: dark;([\s\S]*?)^\}/m)[1])].filter((token) => !rootTokens.has(token))
assert.deepEqual(darkOnlyTokens, [], 'a custom property overridden for dark mode must have a light-mode value too')

assert.ok(api.includes('`/session/${sessionID}/action`'), 'session action discovery should use the generic bridge endpoint')
assert.ok(api.includes('`/session/${sessionID}/action/${encodeURIComponent(actionID)}`'), 'action execution should use a structured endpoint rather than a chat prompt')
assert.ok(app.includes('capabilities.actions ? api.listActions'), 'the selected session should discover actions only when the bridge supports them')
assert.ok(app.includes('api.invokeAction(config, selectedSession.id, command, selectedSession.directory)'), 'OMP Undo/Redo should execute through the action API')
assert.ok(app.includes('replaceMessages ? transcript : mergeFetchedMessages(prev, transcript)'), 'a successful Undo must be allowed to shrink the rendered conversation')
assert.ok(app.includes('setExtensionActions(result.actions)'), 'action execution should apply the returned session-specific enabled state immediately')
assert.ok(app.includes("if (result.applied === false)"), 'only an authoritative no-op result should show no-op feedback')
assert.ok(app.includes('result.applied !== false'), 'unknown results should still refresh the active ACP context without being called no-ops')
assert.ok(app.includes("command === \"undo\" ? 'detail.nothingToUndo' : 'detail.nothingToRedo'"), 'the no-op message should describe the attempted action')
assert.match(app, /if \(!selectedSession \|\| busySending \|\| sessionActionPending !== null \|\| isSessionMutationLocked\(\)\) return/, 'native undo and redo must defensively no-op while a coordinator mutation is pending')
assert.match(app, /id: "undo", label: t\('detail\.undo'\), disabled: mutationLocked \|\| sessionActionPending !== null/, 'message undo must share the coordinator lock and be disabled while a session action is pending')
assert.match(app, /id: "redo", label: t\('detail\.redo'\), disabled: mutationLocked \|\| sessionActionPending !== null/, 'message redo must share the coordinator lock and be disabled while a session action is pending')
assert.match(app, /case "session\.undo":\s*if \(sessionActionPending !== null\) return/, 'the menubar/native undo dispatcher must reject pending session actions')
assert.match(app, /case "session\.redo":\s*if \(sessionActionPending !== null\) return/, 'the menubar/native redo dispatcher must reject pending session actions')
assert.match(app, /action\.id === "undo" && !action\.disabled/, 'menubar and palette undo entries must use the action disabled state')
assert.match(app, /action\.id === "redo" && !action\.disabled/, 'menubar and palette redo entries must use the action disabled state')
assert.ok(app.includes('{actionNotice && <div className="notice info fade-in" role="status" aria-live="polite">'), 'no-op action feedback should render as visible information rather than an error')

// Session actions in the header (issue #104): Undo can strip the transcript to nothing, leaving
// Redo enabled but unreachable through the message context menu, which needs a bubble to exist.
// A header ⋯ menu must therefore render the harness actions independently of transcript contents.
assert.ok(app.includes('function SessionActionsMenu'), 'session actions should have their own header menu component')
assert.ok(app.includes('<MoreVerticalIcon'), 'the session actions menu should open from a ⋯ control in the conversation header')
assert.match(app, /sessionHeaderActions\.length > 0 && \(/, 'the header actions menu should appear only when the harness offers actions')
assert.match(app, /session-actions-menu/, 'the header actions menu should render harness actions as menu items')
assert.match(app, /aria-haspopup="menu"/, 'the session actions toggle should announce that it opens a menu')
assert.match(app, /aria-expanded=\{open\}/, 'the session actions toggle should reflect the menu open state for assistive tech')
assert.ok(app.includes('detail.sessionActions'), 'the session actions toggle should have a translated accessible label')
assert.match(
  app,
  /const hasRedo = config\.backend === "opencode" \|\| config\.backend === "opencode2" \? !!revertMessageID : redoAction \? redoAction\.enabled : supported\.has\("redo"\)/,
  'the header menu must follow harness/extension availability instead of gating Redo on transcript contents'
)
assert.match(app, /session-actions-menu/, 'the header actions menu should have its own styles')
assert.match(styles, /\.session-actions-menu\s*\{[\s\S]*?position:\s*absolute/, 'the header actions menu must overlay the conversation rather than push its layout')
assert.match(styles, /\.session-actions-menu\s*\{[\s\S]*?z-index:\s*var\(--z-menu\)/, 'the header actions menu must stack above the message list')
assert.match(styles, /\.session-actions-menu button:hover:not\(:disabled\)/, 'disabled session actions must not receive hover styling')
assert.match(app, /mobile-session-appbar[\s\S]*?mobile-back-button[\s\S]*?SessionActionsMenu/, 'mobile detail should use one contextual row for back, identity, and session actions')
assert.match(app, /isDesktop && selectedSession && sessionHeaderActions\.length > 0/, 'on desktop the header actions menu should remain beside the session heading')
assert.match(styles, /\.mobile-appbar \{[\s\S]*?display:\s*flex/, 'the mobile contextual app bar should keep its controls on one row')
assert.match(styles, /\.desktop-detail-header \{[\s\S]*?display:\s*none/, 'mobile should not repeat the desktop session heading below the contextual app bar')
assert.doesNotMatch(styles, /\.session-title-button\s*\{[\s\S]*?min-height:\s*44px/, 'the editable title should not create an empty row before the session directory')

assert.ok(api.includes('withDirectory("/permission", directory)'), 'pending OpenCode permissions must be loaded through the server API')
assert.ok(api.includes('`/permission/${requestID}/reply`'), 'permission replies must target the request that blocked the session')
assert.ok(app.includes('capabilities.permissions ? api.loadPermissions'), 'permission polling must follow the negotiated capability')
assert.ok(app.includes('pendingPermissions.map'), 'each pending permission must render an actionable card')
assert.ok(app.includes('void reply("once")') && app.includes('void reply("reject")'), 'the permission card must let the user resolve the blocked request')
assert.ok(app.includes('type.startsWith("permission.")'), 'permission events must refresh the selected session promptly')

// A bridge-backed harness advertises its commands only once a session is loaded, so the
// mount-time fetch returns [] against an idle bridge and Help -> Commands stayed empty for the
// rest of the visit. loadSelected has to retry, and it is the shared seam every caller reaches.
assert.match(
  app,
  /if \(capabilities\.commands && commands\.length === 0\) await loadCommands\(\)/,
  'loadSelected must refetch an empty command catalog once a session is loaded'
)
const loadSelectedBody = app.match(/async function loadSelected\([\s\S]*?\r?\n  \}\r?\n/)
assert.ok(loadSelectedBody, 'loadSelected should be findable for the catalog-refetch check')
assert.ok(
  loadSelectedBody[0].includes('await loadCommands()'),
  'the command refetch belongs inside loadSelected, not in its individual callers'
)

// Ctrl+R reloads and Ctrl+F opens find-in-page. Taking either one away from someone using the app
// in a browser costs them the two keys they reach for when something looks stuck — and it is the
// browser's to give, not ours. The packaged app has no such owner, so there the app may bind them.
// Asserted on the binding map rather than on the handler: the map is the one place that decides,
// and a new browser-reserved key added without the flag is exactly the regression worth catching.
const keyBindings = app.slice(app.indexOf('const KEY_BINDINGS'), app.indexOf('function bindingApplies'))
assert.ok(keyBindings, 'the keyboard binding map should be findable')
for (const [command, key] of [['focus.search', 'f'], ['session.refresh', 'r']]) {
  assert.match(
    keyBindings,
    new RegExp(`"${command}":\\s*\\{ key: "${key}",[^}]*desktopOnly: true`),
    `${command} binds a key the browser owns, so it must be marked desktopOnly`
  )
}
assert.match(
  app,
  /function bindingApplies\([\s\S]*?return !binding\.desktopOnly \|\| isDesktopPlatform\(\)/,
  'a desktop-only binding must be gated on actually running in the desktop app'
)
assert.match(
  app,
  /if \(!binding \|\| !bindingApplies\(binding\)\) return undefined/,
  'a shortcut the build does not bind must not be advertised in menus either'
)
assert.match(
  app,
  /for \(const \[command, binding\] of Object\.entries\(KEY_BINDINGS\)\) \{\s*if \(!bindingApplies\(binding\)\) continue/,
  'the keydown handler must skip bindings that do not apply to this build'
)

// Context changes are a hard synchronous boundary: stale leases and same-ID activity caches must
// not bleed into the next profile/session, and refresh has its own latest-request ordering.
assert.match(app, /const replaceMutationContext[\s\S]*?latestMessageTimesRef\.current\.clear\(\)/, 'context replacement must clear activity caches')
assert.match(app, /const refreshRequestID = \+\+refreshRequestRef\.current/, 'refreshes need a monotonic request identity')
assert.match(app, /refreshRequestID === refreshRequestRef\.current/, 'stale refresh responses must be ignored')
assert.match(app, /const requestID = \+\+loadAgentsRequestRef\.current/, 'agent loads need a request identity')
assert.match(app, /disabled=\{mutationLocked\}[\s\S]*?t\('detail\.refreshAi'\)/, 'mobile AI refresh must honor the mutation lock')
assert.match(app, /onChange=\{\(event\) => changeAgent\(event\.target\.value\)\}[\s\S]*?disabled=\{isWorking \|\| mutationLocked\}/, 'mobile agent selection must honor the mutation lock')
assert.match(app, /onClick=\{\(\) => changeModel\(optionKey\)\}[\s\S]*?disabled=\{isWorking \|\| mutationLocked\}/, 'mobile model selection must honor the mutation lock')
assert.match(composerView, /const invalidateAttachmentPreparation[\s\S]*?generation \+= 1[\s\S]*?const sendNow/, 'attachment preparation must be invalidated synchronously before send')
assert.match(composerView, /pendingPreparation > 0/, 'send must wait for attachment preparation to settle')
assert.ok(!app.includes('removedSessionIDsRef.current.clear()'), 'session tombstones must survive session-only navigation and away/back namespace navigation')
assert.match(app, /disabled=\{action\.disabled\}/, 'message context actions must honor disabled state')
assert.match(app, /disabled=\{!selectedSession \|\| config\.backend !== "opencode2" \|\| busySending \|\| sessionActionPending === "fork" \|\| mutationLocked\}/, 'help skill buttons must honor the coordinator lock')
assert.match(app, /onRefresh=\{\(\) => void refreshSessionsWithIndicator\(\)\.catch/, 'refresh remains wired while mutations are active')

// --- Final review findings (PR #22) ------------------------------------------------------------
// H1: session-only navigation must preserve the composer draft and staged attachments per session
// within the current profile/config, restoring them on return and clearing the whole namespace
// only when the profile or config actually changes. Mirrors the fork restore pattern.
assert.ok(app.includes('const sessionDraftsRef = useRef(new Map<string, { text: string; attachments: AttachmentPart[] }>())'), 'composer drafts must be parked per session within the profile/config')
assert.ok(app.includes('function sessionDraftKey(profileID: string, configKeyValue: string, sessionID: string | null)'), 'parked drafts must be keyed by profile, config, and session')
assert.match(app, /const namespaceChanged = previousContext === null[\s\S]*?sessionDraftsRef\.current\.clear\(\)[\s\S]*?setComposer\(""\)[\s\S]*?setAttachments\(\[\]\)/, 'a profile/config change must clear the whole parked-draft namespace')
assert.match(app, /if \(previousContext\.sessionID && \(composer\.trim\(\) \|\| attachments\.length > 0\)\) \{\s*sessionDraftsRef\.current\.set\(/, 'a session switch must park the outgoing draft under its own key')
assert.match(app, /const saved = context\.sessionID[\s\S]*?sessionDraftsRef\.current\.get\(sessionDraftKey\(context\.profileID, context\.configKey, context\.sessionID\)\)[\s\S]*?setComposer\(saved \? saved\.text : ""\)/, 'a session switch must restore the incoming session\u2019s parked draft')
// H2: the mobile New Session button must only show the Creating spinner/label while actually
// creating; a mere mutation lock disables it with the plain New label.
assert.ok(
  /<SessionsPanel[\s\S]*?creating=\{creatingSession\}/.test(app) && /<SessionSidebar[\s\S]*?creating=\{creatingSession\}/.test(app),
  'the New Session spinner must reflect only an actual create, never the generic mutation lock'
)
assert.equal(sessionList.includes('disabled={creating || offline}'), false, 'the New Session disabled state must also carry the mutation lock')
assert.ok(sessionList.includes('{creating ? t(\'sessions.creating\') : t(\'sessions.new\')}'), 'the Creating label must be tied to the actual creating flag only')
// F2: while the fork reconcile window is open (ref = synchronous authority), send and skill
// activation must refuse dispatch so an in-flight prompt cannot be orphaned by reconcile navigation.
assert.match(app, /async function send\(\)\s*\{[\s\S]*?sessionActionPendingRef\.current === "fork"\) return[\s\S]*?if \(!selectedSession \|\| isSessionMutationLocked\(\)\) return/, 'send must refuse dispatch during the fork reconcile window via the synchronous ref')
assert.match(app, /async function activateSkill\([\s\S]*?sessionActionPendingRef\.current === "fork"\) return[\s\S]*?if \(isSessionMutationLocked\(\)\) return/, 'skill activation must refuse dispatch during the fork reconcile window')
// M2: the open control renders its title and directory as styled spans, never flow content.
const openControlMarkup = sessionList.match(/<button type="button" className="session-card-open"[\s\S]*?<\/button>/)
assert.ok(openControlMarkup && openControlMarkup[0].includes('session-card-title') && openControlMarkup[0].includes('session-card-directory'), 'the open control must render title and directory spans')
assert.ok(openControlMarkup && !/<h3|<p /.test(openControlMarkup[0]), 'a button must not contain heading/paragraph flow content')
// M3: a back/view navigation during a pending fork must not be reversed by reconcile — the
// confirmed child is inserted and announced, never forced open over the view the user chose.
assert.match(app, /const mainViewRef = useRef\(mainView\)[\s\S]*?mainViewRef\.current = mainView/, 'reconciliation must read the current layout through a ref')
assert.match(app, /if \(mainViewRef\.current !== "detail" \|\| selectedSessionRef\.current\?\.id !== original\.id\) \{[\s\S]*?sessionDraftsRef\.current\.set\([\s\S]*?childView\.id[\s\S]*?setActionNotice\(t\('detail\.forkCreated'\)\)[\s\S]*?return[\s\S]*?\}/, 'a reconcile that finds the child while the user left the detail view must insert it without forcing navigation')
assert.ok(app.includes('forkFocusSessionRef.current = childView.id'), 'reconcile navigation must still focus the child when the user is still viewing the fork context')
// M4: reconcile exhaustion (unconfirmed but committed) preserves the fork draft snapshot and
// restores it when the child is subsequently opened manually, empty-composer guard, context-scoped.
assert.match(app, /pendingForkDraftRef\.current = \{\s*namespace: `\$\{activeProfileID\}\\u0000\$\{configKey\(config\)\}`[\s\S]*?baselineChildIDs,[\s\S]*?text: forkDraft\.text,[\s\S]*?attachments: \[\.\.\.forkDraft\.attachments\][\s\S]*?setActionNotice\(t\('detail\.forkUnconfirmed'\)\)/, 'reconcile exhaustion must preserve the fork draft snapshot for a later manual open')
assert.match(app, /const pendingForkDraft = pendingForkDraftRef\.current[\s\S]*?sessionID !== pendingForkDraft\.parentSessionID[\s\S]*?!pendingForkDraft\.baselineChildIDs\.has\(sessionID\)[\s\S]*?setComposer\(\(current\) => \(current === "" \? pendingForkDraft\.text : current\)\)[\s\S]*?setAttachments\(\(current\) => \(current\.length === 0 \? pendingForkDraft\.attachments : current\)\)/, 'a manual open of the unconfirmed child must restore the preserved fork draft with the empty-composer guard')
// M5: after the compaction 45s deadline resolves the pending lock, a passive watcher on the exact
// expected compaction id announces terminal completed/failed state without re-locking controls.
assert.ok(app.includes('passive: false'), 'a fresh compaction observation must start in active (locking) mode')
assert.match(app, /if \(!observation\.passive\) \{[\s\S]*?sessionActionPendingRef\.current = null[\s\S]*?setSessionActionPending\(null\)[\s\S]*?setActionNotice\(terminal\)[\s\S]*?\} else \{[\s\S]*?setActionNotice\(terminal\)[\s\S]*?\}/, 'the passive watcher must announce terminal state without re-locking the controls')
assert.match(app, /const remaining = COMPACTION_PENDING_MAX_MS[\s\S]*?if \(remaining <= 0\) \{[\s\S]*?observation\.passive = true[\s\S]*?setSessionActionPending\(null\)[\s\S]*?setActionNotice\(t\('detail\.compactUnconfirmed'\)\)/, 'the deadline must resolve the pending lock while keeping the passive watch on the exact id')
assert.match(app, /if \(observation\.passive\) return/, 'the passive watcher must not schedule a second deadline of its own')
// M6: desktop row actions reveal when hovering the open control, never the whole card, and the
// open control advertises hover on itself without the misleading full-card pointer.
assert.match(styles, /\.sidebar-sessions \.session-card:has\(\.session-card-open:hover\) \.inline-actions/, 'desktop row actions must reveal when hovering the open control, not the whole card')
assert.match(styles, /\.sidebar-sessions \.session-card-open:hover \{[^}]*background:/, 'the open control must advertise hover on itself')
assert.equal(/\.session-card\s*\{[^}]*cursor:\s*pointer/.test(styles), false, 'the card must never reclaim the misleading full-card pointer')
// M7: disabled session-action menu items explain themselves; the toggle has no inert aria-busy.
assert.ok(app.includes('disabledReason'), 'session actions must be able to explain why they are disabled')
assert.ok(app.includes("disabledReason: disabledReasonFor(mutationLocked || sessionActionPending !== null)"), 'undo/redo must explain their disabled state from the shared reason helper')
assert.ok(app.includes("disabledReasonFor(compactDisabled)") && app.includes("disabledReasonFor(forkDisabled)"), 'compact/fork must explain their disabled state from the shared reason helper')
assert.ok(app.includes("t('detail.actionLocked')") && app.includes("t('detail.requiresUserMessage')") && app.includes("t('detail.actionWhileWorking')"), 'disabled-action explanations must be translated')
// M8: parity/consistency — optimistic and queued rows count for compact/fork availability,
// revert shows disabled consistently in both bubble views, the pending label centres, and the
// sidebar never repeats the directory already shown in its meta line.
assert.match(app, /function hasAnyUserMessage\([\s\S]*?\[\.\.\.messages, \.\.\.optimisticUserMessages, \.\.\.queuedInboxMessages\]\.some/, 'the combined user-row check must include history, optimistic, and queued rows')
assert.match(app, /disabled: revertDisabled, disabledReason: revertDisabled \? t\('detail\.actionLocked'\) : undefined/, 'MessageArticle must show the revert affordance disabled, aligned with the run view')
assert.match(styles, /\.session-action-pending \{[^}]*text-align:\s*center/, 'the pending action label must centre under its toggle on narrow appbars')
assert.match(styles, /\.sidebar-sessions \.session-card \.session-card-directory \{[^}]*display:\s*none/, 'the sidebar must not repeat the directory already shown in its meta line')

console.log('ui regression tests passed')
