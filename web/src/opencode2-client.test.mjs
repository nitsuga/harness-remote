import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isLiveSubagentStatus, isSubagentCompletionWrapper, subagentCompletionDescription, subagentCompletionOutput, subagentRunFromCompletion, subagentRunFromTool } from './agentRuns.ts'
import { applyStreamedToolProgress, extractChildOutputLines, liveSubagentChildIDs, mergeNewestTail, subagentProgressMetadata } from './subagentLive.ts'
import { createTranslator } from './i18n.ts'
import {
  applyInboxDelivery,
  deriveTodosFromMessages,
  fetchSkillCatalog,
  isV2RouteAbsent,
  mergeCommandCatalog,
  toAgentOption,
  toCommandOption,
  toDiffFile,
  toFileContentPart,
  toFileEntry,
  toFormAnswer,
  isQuestionActive,
  toMessageEnvelope,
  toModelOption,
  toQuestionRequest,
  sanitizeForFallback,
  toSession,
  toSkillActivationBody,
  toSkillCommand,
  toToolState
} from './opencode2-mappers.ts'

// Shapes captured from a live OpenCode 2.0-beta server (GET /api/session and /api/session/{id}/message).

const liveSession = {
  id: 'ses_003dc6eaeffeXJgbfQFfpD8Od2',
  projectID: 'global',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  cost: 0.0012965372,
  tokens: { input: 11583, output: 1236, reasoning: 453, cache: { read: 178048, write: 0 } },
  time: { created: 1786641617238, updated: 1786710305014 },
  title: 'Greeting',
  location: { directory: '/home/eric' },
  subpath: 'home/eric'
}

assert.deepEqual(toSession(liveSession), {
  id: 'ses_003dc6eaeffeXJgbfQFfpD8Od2',
  title: 'Greeting',
  directory: '/home/eric',
  time: { created: 1786641617238, updated: 1786710305014 },
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  project: { id: 'global', worktree: '/home/eric' },
  agent: 'build',
  revert: undefined,
  summary: undefined,
  external: false
})

assert.deepEqual(toSession({ id: 's1', time: { created: 1, updated: 2 }, revert: { messageID: 'm1', partID: 'p1' } }), {
  id: 's1',
  title: '',
  directory: '',
  time: { created: 1, updated: 2 },
  model: undefined,
  project: undefined,
  revert: { messageID: 'm1', partID: 'p1' },
  summary: undefined,
  external: false
})

// Assistant message with reasoning + text + a completed shell tool, captured live.
const liveAssistant = {
  id: 'msg_0003ba9350016pezEgfmFkO4kN',
  time: { created: 1786710306618, completed: 1786710307224 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  content: [
    { type: 'reasoning', text: 'Compute the timezone.', state: { reasoningField: 'reasoning_content' }, time: { created: 1, completed: 2 } },
    { type: 'text', text: '**2026-08-13 20:11:56 EDT**' }
  ],
  finish: 'stop'
}

const assistantEnvelope = toMessageEnvelope(liveAssistant, 'ses_x')
assert.equal(assistantEnvelope.info.role, 'assistant')
assert.equal(assistantEnvelope.info.sessionID, 'ses_x')
assert.equal(assistantEnvelope.info.time.completed, 1786710307224)
assert.equal(assistantEnvelope.parts.length, 2)
assert.equal(assistantEnvelope.parts[0].type, 'reasoning')
assert.equal(assistantEnvelope.parts[0].text, 'Compute the timezone.')
assert.equal(assistantEnvelope.parts[1].type, 'text')
assert.equal(assistantEnvelope.parts[1].text, '**2026-08-13 20:11:56 EDT**')

const liveTool = {
  id: 'msg_tool1',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [
    {
      type: 'tool',
      id: 'call_00_ET_y87blQPvx3iDyZ0AK3YG8552',
      name: 'shell',
      executed: false,
      state: {
        status: 'completed',
        input: { command: "stat -c '%n: %y' /tmp/x" },
        content: [
          { type: 'text', text: '/tmp/x: 2026-08-14 00:11:56 +0000' },
          { type: 'text', text: 'Command exited with code 0.' }
        ],
        metadata: { status: 'completed', truncated: false, exit: 0 }
      },
      time: { created: 1, ran: 2, completed: 3 }
    }
  ]
}

const toolEnvelope = toMessageEnvelope(liveTool, 'ses_x')
assert.equal(toolEnvelope.parts.length, 1)
assert.equal(toolEnvelope.parts[0].type, 'tool')
assert.equal(toolEnvelope.parts[0].tool, 'shell')
assert.equal(toolEnvelope.parts[0].callID, 'call_00_ET_y87blQPvx3iDyZ0AK3YG8552')
assert.equal(toolEnvelope.parts[0].state?.status, 'completed')
assert.deepEqual(toolEnvelope.parts[0].state?.input, { command: "stat -c '%n: %y' /tmp/x" })
assert.ok(toolEnvelope.parts[0].state?.output?.includes('Command exited with code 0.'))
assert.deepEqual(toolEnvelope.parts[0].state?.metadata, { status: 'completed', truncated: false, exit: 0 })
assert.equal(toolEnvelope.parts[0].state?.exitCode, 0, 'a completed shell tool call must lift metadata.exit onto the state')

assert.deepEqual(toToolState({ status: 'error', error: { message: 'boom' } }), {
  status: 'error',
  input: {},
  output: undefined,
  error: 'boom',
  time: undefined,
  metadata: undefined
})

const liveUser = { id: 'msg_user', time: { created: 1 }, type: 'user', text: 'Hello!', files: [], agents: [] }
const userEnvelope = toMessageEnvelope(liveUser, 'ses_x')
assert.equal(userEnvelope.info.role, 'user')
assert.deepEqual(userEnvelope.parts, [{ id: 'msg_user:text', type: 'text', text: 'Hello!' }])

const liveShell = {
  id: 'msg_shell',
  time: { created: 1, completed: 2 },
  type: 'shell',
  command: 'echo hi',
  status: 'exited',
  exit: 0,
  output: { output: 'hi\n', cursor: {}, size: {}, truncated: false }
}
const shellEnvelope = toMessageEnvelope(liveShell, 'ses_x')
assert.equal(shellEnvelope.info.role, 'system')
assert.equal(shellEnvelope.parts[0].type, 'tool')
assert.equal(shellEnvelope.parts[0].tool, 'shell')
assert.equal(shellEnvelope.parts[0].state?.output, 'hi\n')
assert.equal(shellEnvelope.parts[0].state?.status, 'completed')

const modelOptions = toModelOption({
  id: 'deepseek-v4-flash',
  modelID: 'deepseek-v4-flash',
  providerID: 'opencode-go',
  family: 'deepseek-flash',
  name: 'DeepSeek V4 Flash',
  status: 'active',
  enabled: true,
  limit: { context: 1000000, output: 384000 },
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }]
}, 'deepseek-v4-flash')

assert.equal(modelOptions.length, 4)
assert.equal(modelOptions[0].modelID, 'deepseek-v4-flash')
assert.equal(modelOptions[0].providerID, 'opencode-go')
assert.equal(modelOptions[0].contextLimit, 1000000)
assert.equal(modelOptions[0].outputLimit, 384000)
assert.equal(modelOptions[0].tools, true)
assert.equal(modelOptions[0].attachments, false)
assert.equal(modelOptions[0].isDefault, true)
assert.deepEqual(modelOptions.map((option) => option.variant), [undefined, 'low', 'high', 'max'])
assert.equal(modelOptions.slice(1).every((option) => option.isDefault === false), true)

assert.deepEqual(toAgentOption({ id: 'build', name: 'Build', description: 'Default', mode: 'primary', hidden: false }), {
  id: 'build', name: 'Build', description: 'Default', mode: 'primary', hidden: false
})

assert.deepEqual(toCommandOption({ name: 'init', template: 'x', description: 'Docs' }), {
  name: 'init', description: 'Docs', source: 'command'
})

// Skills: one v2 /api/skill entry (`SkillV2.Info`, live contract) requires
// `{ id, name, location, content }` and optionally carries `{ description, slash, autoinvoke }`.
// It maps to a slash command classified as a skill, keeping the skill's stable `id` and its
// `autoinvoke` flag so activation and filtering stay possible after the catalog merge.
const liveSkill = {
  id: 'skill_01JHXQ5R7B2ZP9Y4K3M8N6T2W',
  name: 'git-release',
  description: 'Create a git release',
  slash: true,
  autoinvoke: false,
  location: '/home/eric/.config/opencode/skills/git-release/SKILL.md',
  content: 'Release steps...'
}
assert.deepEqual(toSkillCommand(liveSkill), {
  name: 'git-release',
  description: 'Create a git release',
  source: 'skill',
  id: 'skill_01JHXQ5R7B2ZP9Y4K3M8N6T2W',
  autoinvoke: false
})
// A contract-minimal entry (required fields only) maps with safe defaults for the optional ones.
assert.deepEqual(toSkillCommand({ id: 'skill_mem', name: 'memory', location: '/x/SKILL.md', content: 'c' }), {
  name: 'memory', description: undefined, source: 'skill', id: 'skill_mem', autoinvoke: undefined
})
// `autoinvoke` marks skills the server fires on its own; it is carried on the mapped entry (callers
// may filter it) but does not hide the skill — `slash: false` is the catalog-visibility control.
assert.deepEqual(toSkillCommand({
  id: 'skill_auto', name: 'observe', location: '/x/SKILL.md', content: 'c', autoinvoke: true
}).autoinvoke, true)
// slash: false hides the skill from the slash catalog; a missing name does too.
assert.equal(toSkillCommand({ id: 'skill_g', name: 'guide', slash: false, location: '/x', content: 'c' }), null)
assert.equal(toSkillCommand({ id: 'skill_e', name: '', location: '/x', content: 'c' }), null)

// Activation wire body: `POST /api/session/{sessionID}/skill` (`v2.session.skill`) accepts exactly
// `{ skill, resume?, id? }`, forbids extra properties, and answers 204 — so the client posts
// precisely `{ skill, resume: true }`, with no extra keys.
assert.deepEqual(toSkillActivationBody('git-release'), { skill: 'git-release', resume: true })
assert.deepEqual(Object.keys(toSkillActivationBody('git-release')).sort(), ['resume', 'skill'])
assert.equal(toSkillActivationBody('git-release').resume, true)

// The merged catalog keeps both classifications when a server command and a skill share a display
// name: the skill stays visible to the skill filter (UI: `source === "skill"`) with its stable `id`,
// while commands stay first so a slash-name lookup resolves to the server command — OpenCode's own
// precedence — leaving invocation unambiguous. Duplicates are dropped only within one source.
const merged = mergeCommandCatalog(
  [
    toCommandOption({ name: 'init', description: 'Init' }),
    toCommandOption({ name: 'build', description: 'Build' }),
    toCommandOption({ name: 'build', description: 'Build duplicate' })
  ],
  [
    toSkillCommand({ id: 'skill_b', name: 'build', description: 'Build skill', location: '/x', content: 'c' }),
    toSkillCommand({ id: 'skill_l', name: 'lint', description: 'Lint', location: '/x', content: 'c' }),
    toSkillCommand({ id: 'skill_l2', name: 'lint', description: 'Lint duplicate', location: '/x', content: 'c' })
  ]
)
assert.deepEqual(merged, [
  { name: 'init', description: 'Init', source: 'command' },
  { name: 'build', description: 'Build', source: 'command' },
  { name: 'build', description: 'Build skill', source: 'skill', id: 'skill_b', autoinvoke: undefined },
  { name: 'lint', description: 'Lint', source: 'skill', id: 'skill_l', autoinvoke: undefined }
])
// The colliding skill is NOT hidden from the skill classification, so the Skills filter shows it.
assert.deepEqual(merged.filter((entry) => entry.source === 'skill').map((entry) => entry.name), ['build', 'lint'])
assert.deepEqual(merged.filter((entry) => entry.source === 'skill' && entry.name === 'build'), [
  { name: 'build', description: 'Build skill', source: 'skill', id: 'skill_b', autoinvoke: undefined }
])
// Invocation by slash name resolves to the server command first — no duplicate ambiguity.
assert.equal(merged.find((entry) => entry.name === 'build').source, 'command')
// A skill-only name still resolves to the skill.
assert.equal(merged.find((entry) => entry.name === 'lint').source, 'skill')

// `listCommands` degrades to commands-only only for a confirmed route absence (the v2 router's
// empty 404, surfaced by the shared error contract as "HTTP 404"). Any other `/api/skill` failure is
// rethrown unchanged so the UI can display it instead of silently showing an empty skills list.
assert.deepEqual(await fetchSkillCatalog(() => Promise.resolve([liveSkill])), [liveSkill])
assert.deepEqual(await fetchSkillCatalog(() => Promise.reject(new Error('HTTP 404'))), [])
assert.equal(isV2RouteAbsent(new Error('HTTP 404')), true)
for (const realFailure of [
  new Error('HTTP 500'),
  new Error('HTTP 401: the server rejected these credentials.'),
  new Error('Cannot reach 127.0.0.1:4097.'),
  new Error('Request timed out'),
  new Error('Something went wrong')
]) {
  assert.equal(isV2RouteAbsent(realFailure), false, realFailure.message)
  let rethrown
  await fetchSkillCatalog(() => Promise.reject(realFailure)).catch((error) => { rethrown = error })
  assert.equal(rethrown, realFailure, realFailure.message)
}

assert.deepEqual(toFileEntry({ path: 'workspaces/harness-remote/', type: 'directory' }, '/home/eric'), {
  name: 'harness-remote', path: '/home/eric/workspaces/harness-remote/', absolute: '/home/eric/workspaces/harness-remote/', type: 'directory'
})
assert.deepEqual(toFileEntry({ path: 'README.md', type: 'file' }, '/home/eric'), {
  name: 'README.md', path: '/home/eric/README.md', absolute: '/home/eric/README.md', type: 'file'
})

assert.deepEqual(toDiffFile({ file: 'web/src/api.ts', patch: '@@ -1,1 +1,1 @@', additions: 1, deletions: 1, status: 'modified' }), {
  file: 'web/src/api.ts', patch: '@@ -1,1 +1,1 @@', additions: 1, deletions: 1, status: 'modified'
})

// A v2 /api/model entry that carries only `id` (no `modelID`) must still be flagged as the default.
const idOnlyModel = toModelOption({ id: 'deepseek-v4-flash', providerID: 'opencode-go', name: 'DeepSeek V4 Flash' }, 'deepseek-v4-flash')
assert.equal(idOnlyModel[0].isDefault, true)
const nonDefault = toModelOption({ id: 'other', providerID: 'opencode-go', name: 'Other' }, 'deepseek-v4-flash')
assert.equal(nonDefault[0].isDefault, false)

// Forms: one question per field, options surfaced by label for the UI.
const liveForm = {
  id: 'frm_1',
  sessionID: 'ses_x',
  title: 'Choose',
  fields: [
    {
      key: 'framework',
      title: 'Which framework?',
      type: 'select',
      options: [
        { value: 'react', label: 'React' },
        { value: 'vue', label: 'Vue' }
      ]
    },
    {
      key: 'features',
      title: 'Which features?',
      type: 'multiselect',
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'ssr', label: 'SSR' }
      ]
    },
    { key: 'name', title: 'Project name?', type: 'string' }
  ]
}

const question = toQuestionRequest(liveForm)
assert.equal(question.id, 'frm_1')
assert.equal(question.sessionID, 'ses_x')
assert.equal(question.questions.length, 3)
assert.equal(question.questions[0].question, 'Which framework?')
assert.equal(question.questions[0].multiple, false)
assert.equal(question.questions[1].multiple, true)
assert.deepEqual(question.questions[0].options, [
  { label: 'React', description: '', value: 'react' },
  { label: 'Vue', description: '', value: 'vue' }
])
// A plain `string` field has no options, so it must expose the free-text input (custom).
assert.equal(question.questions[2].custom, true)
assert.deepEqual(question.questions[2].options, [])

// Replies must be keyed by field.key and carry option.value (not the display label), typed per field.
const answer = toFormAnswer(liveForm, [['React'], ['TypeScript', 'SSR'], ['my-app']])
assert.deepEqual(answer, { framework: 'react', features: ['ts', 'ssr'], name: 'my-app' })

// Free-text answers with no matching option pass through unchanged.
const customAnswer = toFormAnswer(liveForm, [['React'], [], ['custom-name']])
assert.deepEqual(customAnswer, { framework: 'react', name: 'custom-name' })

// Contract field types: string | number | integer | boolean | multiselect | external.
const typedForm = {
  id: 'frm_2',
  sessionID: 'ses_y',
  fields: [
    { key: 'name', title: 'Name', type: 'string', required: true },
    { key: 'count', title: 'Count', type: 'number', required: true },
    { key: 'retries', title: 'Retries', type: 'integer', required: true },
    { key: 'enabled', title: 'Enabled', type: 'boolean', required: true },
    // `required` is absent deliberately: optional is the v2 default.
    { key: 'nickname', title: 'Nickname', type: 'string' },
    { key: 'token', title: 'Token', type: 'external', url: 'https://example.test/authorize' }
  ]
}

const typedQuestions = toQuestionRequest(typedForm)
// Plain string/number/integer are answerable via a text input, and required ones block submission.
for (const index of [0, 1, 2]) {
  assert.equal(typedQuestions.questions[index].custom, true)
  assert.equal(typedQuestions.questions[index].optional ?? false, false)
}
// Boolean renders as Yes/No choices, not an open text box.
assert.equal(typedQuestions.questions[3].custom, false)
assert.deepEqual(typedQuestions.questions[3].options, [
  { label: 'Yes', description: '', value: 'true' },
  { label: 'No', description: '', value: 'false' }
])
// A missing `required` flag is optional, while external fields require explicit acknowledgement.
assert.equal(typedQuestions.questions[4].optional, true)
assert.equal(typedQuestions.questions[5].optional, false)
assert.equal(typedQuestions.questions[5].externalUrl, 'https://example.test/authorize')
assert.equal(toQuestionRequest({
  id: 'frm_unsafe',
  sessionID: 'ses_y',
  fields: [{ key: 'unsafe', type: 'external', url: 'javascript:alert(1)' }]
}).questions[0].externalUrl, undefined)

// number/integer answers are numeric; boolean and external acknowledgements are real booleans.
const typedAnswer = toFormAnswer(typedForm, [['Ada'], ['3.5'], ['7'], ['Yes'], [], ['true']])
assert.deepEqual(typedAnswer, { name: 'Ada', count: 3.5, retries: 7, enabled: true, token: true })
assert.equal(typeof typedAnswer.count, 'number')
assert.equal(typeof typedAnswer.retries, 'number')
assert.equal(typeof typedAnswer.enabled, 'boolean')
assert.equal(typeof typedAnswer.token, 'boolean')
// The blank optional field is omitted rather than submitted as an empty string.
assert.equal('nickname' in typedAnswer, false)

// A boolean answered "No" maps to false.
assert.equal(toFormAnswer(typedForm, [['Ada'], ['1'], ['1'], ['No'], [], ['true']]).enabled, false)

// Invalid integer text is never truncated into a different valid answer.
assert.equal(toFormAnswer(typedForm, [['Ada'], ['1'], ['3.5'], ['Yes'], [], ['true']]).retries, '3.5')
assert.equal(toFormAnswer(typedForm, [['Ada'], ['1'], ['7abc'], ['Yes'], [], ['true']]).retries, '7abc')

const conditionalForm = {
  id: 'frm_3',
  sessionID: 'ses_z',
  fields: [
    { key: 'enabled', title: 'Use authentication?', type: 'boolean', required: true },
    {
      key: 'secret',
      title: 'Secret',
      type: 'string',
      required: true,
      when: [{ key: 'enabled', op: 'eq', value: true }]
    }
  ]
}
const conditionalQuestions = toQuestionRequest(conditionalForm)
assert.equal(isQuestionActive(conditionalQuestions, 1, [[], []]), false)
assert.equal(isQuestionActive(conditionalQuestions, 1, [['No'], []]), false)
assert.equal(isQuestionActive(conditionalQuestions, 1, [['Yes'], []]), true)
// Stale values for inactive fields are omitted; active values are submitted.
assert.deepEqual(toFormAnswer(conditionalForm, [['No'], ['stale-secret']]), { enabled: false })
assert.deepEqual(toFormAnswer(conditionalForm, [['Yes'], ['current-secret']]), {
  enabled: true,
  secret: 'current-secret'
})

// --- Session compact/fork lane (issue #4) ---------------------------------------------

// `POST /api/session/{id}/fork` (`v2.session.fork`) answers `{ data: Session.Info }`. The fork
// response carries extra fields (`fork`, `parentID`, `cost`, `tokens`, ...) the app's mapper does
// not know about; it must still map to a usable Session — the client returns `toSession(forked)`
// and the UI feeds that straight into its session view.
const forkedInfo = {
  id: 'ses_child',
  parentID: 'ses_003dc6eaeffeXJgbfQFfpD8Od2',
  fork: { sessionID: 'ses_003dc6eaeffeXJgbfQFfpD8Od2', boundary: { type: 'through', messageID: 'msg_x' } },
  projectID: 'global',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  cost: 0.0012965372,
  tokens: { input: 11583, output: 1236, reasoning: 453, cache: { read: 178048, write: 0 } },
  time: { created: 1786641617238, updated: 1786710305014 },
  title: 'Greeting (fork)',
  location: { directory: '/home/eric' },
  subpath: 'home/eric'
}
assert.deepEqual(toSession(forkedInfo), {
  id: 'ses_child',
  title: 'Greeting (fork)',
  directory: '/home/eric',
  time: { created: 1786641617238, updated: 1786710305014 },
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  project: { id: 'global', worktree: '/home/eric' },
  agent: 'build',
  revert: undefined,
  summary: undefined,
  external: false
})

// Wire contract for the two new endpoints, checked against the client source the same way the
// regression suites check App.tsx/api.ts: the node runner cannot import opencode2-client.ts (its
// extensionless sibling imports), so the exact request shapes are asserted textually.
const clientSource = readFileSync(new URL('./opencode2-client.ts', import.meta.url), 'utf8')
assert.match(clientSource, /delivery: promptDelivery/, 'prompt delivery must be selected explicitly for idle and queued follow-ups')
assert.match(clientSource, /delivery\?: "steer" \| "queue"/, 'v2 prompt delivery must use the protocol enum')
assert.match(clientSource, /IndeterminateDeliveryError/, 'transport loss after a mutation request must remain indeterminate')
assert.match(readFileSync(new URL('./opencode2-mappers.ts', import.meta.url), 'utf8'), /compactionStatus/, 'compaction terminal metadata must survive history mapping')
// Compact is durably admitted under a stable client id (`msg_` prefix) so a lost acknowledgement can
// be retried idempotently, and the admission response carries the exact compaction message id the UI
// correlates terminal history state against.
assert.ok(
  clientSource.includes('`/api/session/${encodeURIComponent(sessionID)}/compact`, {\n      method: "POST",\n      body\n    })'),
  'compact must POST its admission body (stable id + queued delivery)'
)
assert.match(clientSource, /body\.id = compactRequestID/, 'compact must carry a stable admission id')
assert.match(clientSource, /return \{ id: admitted\?\.id \?\? compactRequestID, requestID: compactRequestID \}/, 'compact must return the exact admission id for terminal correlation')
assert.ok(
  clientSource.includes('`/api/session/${encodeURIComponent(sessionID)}/fork`, {\n      method: "POST",\n      body: { boundary: { type: "through" } }\n    })'),
  'fork must POST the through boundary — the only fork boundary that needs no messageID'
)
// The durable admission id makes prompt/command/skill/compact/create retryable without duplication:
// the server answers 409 when the id is already recorded, and isAdmissionConflict recognizes that.
assert.match(clientSource, /body\.id = promptRequestID/, 'prompt must carry its stable admission id')
assert.match(clientSource, /if \(requestID\) body\.id = requestID/, 'command, skill, and create must carry their stable admission id when provided')
assert.match(clientSource, /isAdmissionConflict/, 'the client must recognize an idempotent admission conflict (409)')
assert.ok(clientSource.includes('`/api/session/${encodeURIComponent(sessionID)}/inbox`'), 'queued delivery state must be readable from the v2 inbox endpoint')
assert.ok(clientSource.includes('`/api/session?parentID=${encodeURIComponent(parentID)}`'), 'fork reconciliation must list children by parent id')

// The v1/bridge backends must reject compact/fork honestly (same pattern as sendSkill) so the UI
// never sees a silent success from a backend that cannot perform the operation.
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
assert.ok(
  apiSource.includes('return Promise.reject(new Error("Session compaction is only supported on OpenCode 2 servers"))'),
  'v1 compactSession must reject honestly'
)
assert.ok(
  apiSource.includes('return Promise.reject(new Error("Session forking is only supported on OpenCode 2 servers"))'),
  'v1 forkSession must reject honestly'
)

// --- Inbox delivery metadata (issues #1/#6) ------------------------------------------------

// The message list does not carry delivery state; the inbox (`GET /api/session/{id}/inbox`) does.
// `applyInboxDelivery` overlays the server's queued/steer metadata onto the fetched transcript so a
// queued prompt keeps its indicator across reconciliation, and drops it once the item is delivered.
const queuedTranscript = [
  toMessageEnvelope({ id: 'msg_pending', type: 'user', time: { created: 1 }, text: 'Queued hello' }, 'ses_x'),
  toMessageEnvelope({ id: 'msg_delivered', type: 'user', time: { created: 2 }, text: 'Delivered hello' }, 'ses_x')
]
const inboxItems = [
  { id: 'msg_pending', sessionID: 'ses_x', timeCreated: 1, type: 'user', payload: { text: 'Queued hello' }, delivery: 'queue' },
  { id: 'msg_delivered', sessionID: 'ses_x', timeCreated: 2, type: 'user', payload: { text: 'Delivered hello' }, delivery: 'steer' },
  { id: 'msg_compact', sessionID: 'ses_x', timeCreated: 3, type: 'compaction', payload: {}, delivery: 'queue' }
]
const overlaid = applyInboxDelivery(queuedTranscript, inboxItems)
assert.equal(overlaid[0].info.delivery, 'queue', 'a message the inbox still holds as queued must keep its queued indicator')
assert.equal(overlaid[1].info.delivery, 'steer', 'a message the inbox reports as steered must carry steer delivery')
assert.equal(applyInboxDelivery(queuedTranscript, []), queuedTranscript, 'an empty inbox must leave the transcript untouched')
assert.equal(applyInboxDelivery(queuedTranscript, [{ id: 'msg_compact', sessionID: 'ses_x', timeCreated: 3, type: 'compaction', payload: {}, delivery: 'queue' }]), queuedTranscript, 'compaction inbox items must not affect user message delivery metadata')
// A message with no inbox entry (or one whose delivery already matches) must keep its identity so
// the memoized message rendering does not re-run on every poll.
const steerOnly = applyInboxDelivery(queuedTranscript, [{ id: 'msg_delivered', sessionID: 'ses_x', timeCreated: 2, type: 'user', payload: {}, delivery: 'steer' }])
assert.equal(steerOnly[1].info.delivery, 'steer')
assert.notEqual(steerOnly[1], queuedTranscript[1])
const alreadyQueued = applyInboxDelivery(overlaid, [{ id: 'msg_pending', sessionID: 'ses_x', timeCreated: 1, type: 'user', payload: {}, delivery: 'queue' }])
assert.equal(alreadyQueued[0], overlaid[0], 'an unchanged delivery must preserve the message identity')

// --- Compaction admission id (issue #4) ------------------------------------------------

// The client supplies its own stable `msg_` id so the acknowledgement can be retried idempotently,
// and the server's `{ data: SessionInbox.Compaction }` response carries the exact compaction message
// id that terminal history state is correlated against.
assert.match(clientSource, /createMessageRequestID/, 'the client must generate stable msg_ admission ids')
assert.match(clientSource, /compactRequestID = requestID \?\? createMessageRequestID\(\)/, 'compact must default its admission id when none is supplied')

// --- Prompt/command admission metadata (issues #1/#2) -------------------------------------

// `POST /api/session/{id}/prompt` and `/command` succeed with `{ data: Session.Inbox.User }` — the
// exact durable message id and the delivery the server recorded. The client must surface both in its
// return instead of discarding the response: prompt previously returned only `{ admitted, requestID }`
// and command fabricated a placeholder envelope.
assert.match(clientSource, /const admitted = await v2Request<\{ id\?: string; delivery\?: "steer" \| "queue" \}>\(config, `\/api\/session\/\$\{encodeURIComponent\(sessionID\)\}\/prompt`/, 'prompt must read the admitted Session.Inbox.User (exact id + delivery) from the response envelope')
assert.match(clientSource, /const admitted = await v2Request<\{ id\?: string; delivery\?: "steer" \| "queue" \}>\(config, `\/api\/session\/\$\{encodeURIComponent\(sessionID\)\}\/command`/, 'command must read the admitted Session.Inbox.User (exact id + delivery) from the response envelope')
assert.match(clientSource, /return \{ admitted: true, requestID: promptRequestID, messageID: admitted\?\.id, delivery: admitted\?\.delivery \}/, 'prompt must return the exact durable message id and delivery alongside its stable request id')
assert.match(clientSource, /return \{ admitted: true, requestID, messageID: admitted\?\.id, delivery: admitted\?\.delivery \}/, 'command must return the exact durable message id and delivery alongside its stable request id')
assert.ok(!clientSource.includes('parts: [] } as MessageEnvelope'), 'command must not fabricate a placeholder envelope')
// The stable client admission ids survive the metadata change: prompt keeps its defaulted id and
// command keeps its caller-supplied id on the wire.
assert.match(clientSource, /body\.id = promptRequestID/, 'prompt must keep its stable durable admission id')
assert.match(clientSource, /if \(requestID\) body\.id = requestID/, 'command must keep its stable durable admission id when provided')

// --- Skill activation: NOT idempotent by id (issue #5) ------------------------------------

// The skill endpoint is not durably admitted by id — it derives an event id from the request id,
// and re-admitting a duplicate event id can defect. The client comment must document that (the
// previous claim that a retry "can never activate the skill twice" was wrong), and the client must
// not attempt an automatic idempotent retry for skills the way prompt/command/compact allow.
const sendSkillSource = clientSource.slice(clientSource.indexOf('async sendSkill'), clientSource.indexOf('async compactSession'))
assert.ok(!clientSource.includes('can never activate the skill twice'), 'the misleading skill idempotency claim must be removed')
assert.match(clientSource, /durably admitted by id/, 'the client must document that skill activation is not durably admitted by id')
assert.match(clientSource, /duplicate event id can defect/, 'the client must document that a duplicate skill event id can defect')
assert.equal((sendSkillSource.match(/\/skill`, \{/g) ?? []).length, 1, 'sendSkill must admit the activation exactly once — no automatic retry added')
assert.equal((sendSkillSource.match(/sendSkillV2|sendSkill\(/g) ?? []).length, 1, 'sendSkill must not call itself or a sibling dispatch (no retry loop)')

// Every language must ship the compact/fork labels and the compact queued notice.
const compactSessionLabels = {
  en: 'Compact session',
  it: 'Compatta sessione',
  'zh-TW': '壓縮工作階段',
  'zh-CN': '压缩会话'
}
const forkSessionLabels = {
  en: 'Fork session',
  it: 'Duplica sessione',
  'zh-TW': '分叉工作階段',
  'zh-CN': '分叉会话'
}
const compactQueuedLabels = {
  en: 'Compaction queued',
  it: 'Compattazione in coda',
  'zh-TW': '壓縮已排入佇列',
  'zh-CN': '压缩已排队'
}
const unconfirmedLabels = {
  en: 'Compaction status is unknown. Check the transcript and wait for the current run to finish before compacting again.',
  it: 'Stato della compattazione sconosciuto. Controlla la trascrizione e attendi che l’esecuzione in corso finisca prima di compattare di nuovo.',
  'zh-TW': '壓縮狀態不明。請檢查對話記錄，並等待目前執行結束後再壓縮。',
  'zh-CN': '压缩状态未知。请检查对话记录，并等待当前运行结束后再压缩。'
}
for (const language of ['en', 'it', 'zh-TW', 'zh-CN']) {
  const t = createTranslator(language)
  assert.equal(t('detail.compactSession'), compactSessionLabels[language], `${language} compactSession label`)
  assert.equal(t('detail.forkSession'), forkSessionLabels[language], `${language} forkSession label`)
  assert.equal(t('detail.compactQueued'), compactQueuedLabels[language], `${language} compactQueued notice`)
  assert.equal(t('detail.compactUnconfirmed'), unconfirmedLabels[language], `${language} compactUnconfirmed notice`)
  assert.notEqual(t('detail.deliveryAdmitted'), 'detail.deliveryAdmitted', `${language} deliveryAdmitted notice`)
  assert.notEqual(t('detail.forkUnconfirmed'), 'detail.forkUnconfirmed', `${language} forkUnconfirmed notice`)
}

// --- Desktop definite-error classification (issue #22) ---------------------------------------

// The desktop bridge surfaces transport failures as thrown Errors carrying the electron transport's
// code and (for HTTP failures) status. The v2 client must wrap only genuine answer loss on a
// mutation — POST, DELETE, PATCH (anything but GET) — as IndeterminateDeliveryError, since the
// server may have durably admitted the request before the answer was lost. A definite HTTP status
// means the server answered, so 4xx/5xx on the desktop build surface as definite errors exactly
// like web/Capacitor, with the status preserved so the 409 admission-conflict signal keeps
// resolving through isAdmissionConflict.
const desktopBridgeSource = readFileSync(new URL('./desktopBridge.ts', import.meta.url), 'utf8')
assert.match(desktopBridgeSource, /\.status = result\.error\.status/, 'the desktop bridge must keep the HTTP status from the electron transport')
assert.match(desktopBridgeSource, /\.code = result\.error\.code/, 'the desktop bridge must carry the electron transport error code onto the thrown error')
const desktopBranch = clientSource.slice(clientSource.indexOf('  if (isDesktopPlatform()) {'), clientSource.indexOf('  const target = `${baseUrl(config)}${path}`'))
assert.ok(
  desktopBranch.includes('const lostAnswer = status === undefined && (code === undefined || code === "timeout" || code === "connection" || code === "response-too-large")'),
  'only bridge timeout/connection (or code-less) transport loss and the unreadable response-too-large answer may be classified as indeterminate'
)
assert.match(desktopBranch, /if \(method !== "GET" && lostAnswer\) throw new IndeterminateDeliveryError/, 'the desktop wrap must cover every mutation method (POST/DELETE/PATCH), never a definite HTTP status')
assert.ok(
  !desktopBranch.includes('if (method === "POST") throw new IndeterminateDeliveryError((error as Error).message)'),
  'the desktop branch must not blanket-wrap every POST error as indeterminate'
)
assert.ok(
  desktopBranch.includes('throw error') && desktopBranch.includes('const status = (error as Error & { status?: number }).status'),
  'a desktop error with a definite HTTP status must rethrow as-is, keeping its status'
)

// The DELETE mutations (deleteSession, cancelInboxItem) are idempotent and the server may have
// committed them before the connection broke, so their lost answers must be indeterminate exactly
// like POST — the wrap condition must be method-based, not a POST allowlist.
assert.match(
  desktopBranch,
  /method !== "GET" && lostAnswer/,
  'a lost DELETE/PATCH answer must be classified indeterminate alongside POST on the desktop transport'
)
// The electron transport attaches no status to `response-too-large` (see desktop-transport.test.mjs),
// so the client cannot treat it as a definite server answer: it means the server answered but the
// response body was unreadable, which for a mutation leaves the outcome unknowable.
assert.ok(
  desktopBranch.includes('code === "response-too-large"'),
  'response-too-large must be classified as an unreadable answer (indeterminate for mutations), not a definite status-bearing error'
)
// The web branch applies the same non-GET rule to an unreadable 2xx body (the server answered, so
// a mutation's exact outcome — e.g. the admitted message id — is lost).
assert.ok(
  clientSource.includes('if (method !== "GET") throw new IndeterminateDeliveryError((error as Error).message)'),
  'the web branch must classify an unreadable 2xx body as indeterminate for every mutation method, not just POST'
)

// --- Queued inbox cancellation (issue #22) ---------------------------------------------------

// `v2.session.inbox.cancel` (protocol-authoritative: `HttpApiEndpoint.delete` on
// `/api/session/:sessionID/inbox/:inboxID`) answers 204 NoContent, rejecting 409 once the item can
// no longer be cancelled and 404 for an unknown session. The client must issue that DELETE (never a
// body-carrying POST) and resolve on the bare acknowledgement, scoping it to the selected project.
assert.ok(
  clientSource.includes('`/api/session/${encodeURIComponent(sessionID)}/inbox/${encodeURIComponent(inboxID)}`, directory), { method: "DELETE" }'),
  'cancel must DELETE the inbox item through the protocol cancel route'
)
assert.match(clientSource, /async cancelInboxItem\(config: ServerConfig, sessionID: string, inboxID: string, directory\?: string\)/, 'the v2 client must expose a queued-inbox cancel method')
assert.ok(
  apiSource.includes('return Promise.reject(new Error("Inbox cancellation is only supported on OpenCode 2 servers"))'),
  'v1 cancelInboxItem must reject honestly'
)

// --- v1 dispatcher sentinels for v2-only routes (regression: v2.12.0 session open) -----------

// `api` is a Proxy that routes to the v2 client only when the v1 method exists (api.ts
// `get`): a v2-only method with NO v1 counterpart resolves to `undefined`, so calling it throws
// "is not a function" (minified: `Mm is not a function`) even on opencode2 backends. Every v2-only
// method must keep a v1 stub so the route stays reachable.
for (const [route, expected] of [
  ['`/api/session/${encodeURIComponent(sessionID)}/inbox`', 'return Promise.resolve([] as unknown[])'],
  ['`/api/session/${encodeURIComponent(sessionID)}`', 'return Promise.reject(new Error("Session lookup is only supported on OpenCode 2 servers"))'],
  ['`/api/session?parentID=${encodeURIComponent(parentID)}`', 'return Promise.reject(new Error("Child session listing is only supported on OpenCode 2 servers"))']
]) {
  assert.ok(clientSource.includes(route), `the v2 client must keep the inbox/fetch/child listing route: ${route}`)
}
assert.ok(
  apiSource.includes('listInbox(_config: ServerConfig, _sessionID: string, _directory?: string)'),
  'v1 listInbox must exist as a dispatcher sentinel (degrade to an empty list)'
)
assert.ok(
  apiSource.includes('return Promise.resolve([] as unknown[])'),
  'v1 listInbox must degrade to an empty list on v1 backends'
)
assert.ok(
  apiSource.includes('return Promise.reject(new Error("Session lookup is only supported on OpenCode 2 servers"))'),
  'v1 getSession must reject honestly'
)
assert.ok(
  apiSource.includes('return Promise.reject(new Error("Child session listing is only supported on OpenCode 2 servers"))'),
  'v1 listChildSessions must reject honestly'
)

// --- Systematic dispatcher completeness (regression class: v2.12.0 "Mm is not a function") -------

// The `api` Proxy (api.ts) routes by method name: a method on one surface without a counterpart on
// the other either resolves to `undefined` (minified "X is not a function") or silently runs the
// wrong implementation on opencode2 backends. The per-method pins above guard the known methods;
// this enforces set-equality of the two API surfaces so the class cannot ship again. Both object
// literals are method-only at two-space indent, so a line-based parse is exact (`clientSource` is
// sliced from the `opencode2Api` object which is the file tail; `apiSource` from `apiV1` up to the
// Proxy export).
const v2Surface = new Set(
  [...clientSource.slice(clientSource.indexOf('export const opencode2Api = {')).matchAll(/^  (?:async )?([A-Za-z][A-Za-z0-9]*)\(/gm)].map((m) => m[1])
)
const v1Surface = new Set(
  [...apiSource.slice(apiSource.indexOf('const apiV1 = {'), apiSource.indexOf('export const api')).matchAll(/^  (?:async )?([A-Za-z][A-Za-z0-9]*)\(/gm)].map((m) => m[1])
)
const missingSentinel = [...v2Surface].filter((name) => !v1Surface.has(name))
const silentFallback = [...v1Surface].filter((name) => !v2Surface.has(name))
assert.ok(
  missingSentinel.length === 0,
  `every v2 client method must keep a v1 sentinel stub or the Proxy resolves it to undefined: ${missingSentinel.join(', ')}`
)
assert.ok(
  silentFallback.length === 0,
  `every v1 method must have a v2 counterpart or opencode2 backends silently run the v1 implementation: ${silentFallback.join(', ')}`
)
assert.ok(
  v2Surface.size >= 30,
  'the dispatcher surface parse must stay meaningful (sanity floor, not an exact count)'
)

// --- Feature #13 lane 1: rich structured message/tool mapping ----------------------------------
// Synthetic fixtures only — the shapes mirror live OpenCode 2 captures, but every id/path was
// invented here (nothing copied from a real transcript).

// Switch messages previously fell into the generic else-branch and were dropped entirely (they hold
// no `text`). Each now maps to a structured `switch` part carrying its own fields — `info` metadata
// stays reserved for assistant messages so switch indications never get confused with them.
const agentSwitch = toMessageEnvelope({
  id: 'msg_ag1', time: { created: 1 }, type: 'agent-switched', agent: 'orchestrator', previous: 'build'
}, 'ses_x')
assert.equal(agentSwitch.info.role, 'system')
assert.equal(agentSwitch.info.agent, undefined, 'switch metadata must stay off info (assistant-only field)')
assert.deepEqual(agentSwitch.parts, [{
  id: 'msg_ag1:switch',
  messageID: 'msg_ag1',
  type: 'switch',
  kind: 'agent',
  value: 'orchestrator',
  previous: 'build',
  text: 'Switched agent: build → orchestrator'
}])
// Without `previous` the summary drops the arrow and no `previous` key is emitted.
const agentSwitchNoPrev = toMessageEnvelope({
  id: 'msg_ag2', time: { created: 2 }, type: 'agent-switched', agent: 'orchestrator'
}, 'ses_x')
assert.deepEqual(agentSwitchNoPrev.parts[0], {
  id: 'msg_ag2:switch',
  messageID: 'msg_ag2',
  type: 'switch',
  kind: 'agent',
  value: 'orchestrator',
  text: 'Switched agent: orchestrator'
})
assert.equal('previous' in agentSwitchNoPrev.parts[0], false)

// A model switch carries the full new ref (provider/variant) on the `model` field, the previous ref
// id on `previous` — both sides are `Model.Ref` on the wire, so a plain id in the summary is
// ambiguous when the same ref id is reused with a different variant: the arrow is dropped then.
const modelSwitch = toMessageEnvelope({
  id: 'msg_md1', time: { created: 3 }, type: 'model-switched',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  previous: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'default' }
}, 'ses_x')
assert.deepEqual(modelSwitch.parts[0], {
  id: 'msg_md1:switch',
  messageID: 'msg_md1',
  type: 'switch',
  kind: 'model',
  value: 'deepseek-v4-flash',
  previous: 'deepseek-v4-flash',
  text: 'Switched model: deepseek-v4-flash',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' }
})
assert.deepEqual(modelSwitch.info.model, undefined, 'switch messages must not set info.model')
const modelSwitchNew = toMessageEnvelope({
  id: 'msg_md2', time: { created: 4 }, type: 'model-switched',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' }
}, 'ses_x')
assert.deepEqual(modelSwitchNew.parts[0], {
  id: 'msg_md2:switch',
  messageID: 'msg_md2',
  type: 'switch',
  kind: 'model',
  value: 'deepseek-v4-flash',
  text: 'Switched model: deepseek-v4-flash',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: undefined }
})
assert.equal('previous' in modelSwitchNew.parts[0], false)

// Location switch: the new directory is the value, the old one rides on `previous`, and the new
// project subpath keeps its own field. The wire's `previous` nests the same location shape.
const locationSwitch = toMessageEnvelope({
  id: 'msg_loc1', time: { created: 5 }, type: 'location-switched',
  location: { directory: '/home/eric/work' }, projectID: 'project-a', subpath: 'work',
  previous: { location: { directory: '/home/eric' } }
}, 'ses_x')
assert.deepEqual(locationSwitch.parts[0], {
  id: 'msg_loc1:switch',
  messageID: 'msg_loc1',
  type: 'switch',
  kind: 'location',
  value: '/home/eric/work',
  previous: '/home/eric',
  text: 'Switched location: /home/eric → /home/eric/work',
  subpath: 'work'
})
const locationSwitchMinimal = toMessageEnvelope({
  id: 'msg_loc2', time: { created: 6 }, type: 'location-switched', location: { directory: '/home/eric' }
}, 'ses_x')
assert.deepEqual(locationSwitchMinimal.parts[0], {
  id: 'msg_loc2:switch',
  messageID: 'msg_loc2',
  type: 'switch',
  kind: 'location',
  value: '/home/eric',
  text: 'Switched location: /home/eric'
})
assert.equal('previous' in locationSwitchMinimal.parts[0], false)
assert.equal('subpath' in locationSwitchMinimal.parts[0], false)

// `system` messages carry a model-facing `text` plus an optional short human `description`; both
// ride on the structured system part. (Live shape: the server emits a date-rollover note like this.)
const systemMessage = toMessageEnvelope({
  id: 'msg_sys', time: { created: 5 }, type: 'system',
  text: "Today's date is now: Sat Aug 15 2026", description: 'Instructions updated: core/date'
}, 'ses_x')
assert.deepEqual(systemMessage.parts, [{
  id: 'msg_sys:system',
  messageID: 'msg_sys',
  type: 'system',
  text: "Today's date is now: Sat Aug 15 2026",
  description: 'Instructions updated: core/date'
}])
const systemNoDescription = toMessageEnvelope({
  id: 'msg_sys2', time: { created: 6 }, type: 'system', text: 'Context window cleared.'
}, 'ses_x')
assert.deepEqual(systemNoDescription.parts[0], {
  id: 'msg_sys2:system', messageID: 'msg_sys2', type: 'system', text: 'Context window cleared.'
})
assert.equal('description' in systemNoDescription.parts[0], false)

// Synthetic messages keep the plain text part when they carry no description, and upgrade to the
// structured system part when a human summary is present.
assert.deepEqual(toMessageEnvelope({
  id: 'msg_syn1', time: { created: 7 }, type: 'synthetic', text: 'Move to /home/eric/work.', description: 'Prompt updated'
}, 'ses_x').parts[0], {
  id: 'msg_syn1:system', messageID: 'msg_syn1', type: 'system', text: 'Move to /home/eric/work.', description: 'Prompt updated'
})
assert.deepEqual(toMessageEnvelope({
  id: 'msg_syn2', time: { created: 8 }, type: 'synthetic', text: 'Move to /home/eric/work.'
}, 'ses_x').parts, [{ id: 'msg_syn2:text', type: 'text', text: 'Move to /home/eric/work.' }])

// A `skill` message is a skill ACTIVATION (distinct from a `skill` tool call): it carries the
// stable skill catalog id, the user-facing name and the model-facing instruction text.
const skillActivation = toMessageEnvelope({
  id: 'msg_sk', time: { created: 9 }, type: 'skill',
  skill: 'skill_01JHXQ5R7B2ZP9Y4K3M8N6T2W', name: 'git-release', text: 'Use git-release to cut a release.'
}, 'ses_x')
assert.deepEqual(skillActivation.parts, [{
  id: 'msg_sk:skill',
  messageID: 'msg_sk',
  type: 'skill-activation',
  skillId: 'skill_01JHXQ5R7B2ZP9Y4K3M8N6T2W',
  name: 'git-release',
  text: 'Use git-release to cut a release.'
}])

// Compaction keeps its transcript row (summary/recent for running and completed) plus the terminal
// status on `info.compactionStatus`; a failed compaction surfaces its structured error on `info.error`.
const compactRunning = toMessageEnvelope({
  id: 'msg_c1', time: { created: 10 }, type: 'compaction', status: 'running', reason: 'manual',
  summary: 'Let me review what we know', recent: 'User: hi'
}, 'ses_x')
assert.equal(compactRunning.info.compactionStatus, 'running')
assert.deepEqual(compactRunning.parts, [{ id: 'msg_c1:text', type: 'text', text: 'Let me review what we know\n\nUser: hi' }])
assert.equal(compactRunning.info.error, undefined)
const compactCompleted = toMessageEnvelope({
  id: 'msg_c2', time: { created: 11, completed: 12 }, type: 'compaction', status: 'completed', reason: 'auto',
  summary: 'We were discussing the release.', recent: 'Assistant: …'
}, 'ses_x')
assert.equal(compactCompleted.info.compactionStatus, 'completed')
assert.equal(compactCompleted.parts[0].text, 'We were discussing the release.\n\nAssistant: …')
const compactFailed = toMessageEnvelope({
  id: 'msg_c3', time: { created: 13 }, type: 'compaction', status: 'failed', reason: 'manual',
  error: { type: 'tool-failed', message: 'no searcher available' }
}, 'ses_x')
assert.equal(compactFailed.info.compactionStatus, 'failed')
assert.deepEqual(compactFailed.info.error, { type: 'tool-failed', message: 'no searcher available' })
assert.deepEqual(compactFailed.parts, [], 'a failed compaction carries no summary/recent row — only the error')

// Unknown future message types become a `fallback` part holding the SANITIZED payload: the tool
// bookkeeping keys and every credential-looking key are stripped at any depth, safe fields survive,
// and the source object is never mutated.
const unknownMessage = {
  id: 'msg_future',
  time: { created: 14 },
  type: 'session-summary',
  text: 'A mysterious future message',
  note: 'safe field',
  metadata: { apiKey: 'sk-super-secret', safe: true },
  providerState: { nested: { credential: 'nope', token: 'nope' }, alsoSafe: 1 },
  providerResultState: { work: 'x' }
}
const fallbackEnvelope = toMessageEnvelope(unknownMessage, 'ses_x')
assert.equal(fallbackEnvelope.parts.length, 1)
assert.deepEqual(fallbackEnvelope.parts[0], {
  id: 'msg_future:fallback',
  messageID: 'msg_future',
  type: 'fallback',
  typeName: 'session-summary',
  text: 'A mysterious future message',
  raw: {
    id: 'msg_future',
    time: { created: 14 },
    type: 'session-summary',
    text: 'A mysterious future message',
    note: 'safe field',
    metadata: { safe: true }
  }
})
const assertScrubbed = (value) => {
  if (Array.isArray(value)) { value.forEach(assertScrubbed); return }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.equal(/providerState|providerResultState/.test(key), false, `key "${key}" must not surface`)
      assert.equal(/key|token|secret|password|credential/i.test(key), false, `key "${key}" must not surface`)
      assertScrubbed(child)
    }
  }
}
assertScrubbed(fallbackEnvelope.parts[0].raw)
assert.notEqual(fallbackEnvelope.parts[0].raw, unknownMessage, 'the fallback payload must be a deep copy')
assert.equal(unknownMessage.metadata.apiKey, 'sk-super-secret', 'sanitizing must not mutate the source payload')
// A textless unknown message still keeps its type name and raw payload.
const textlessFallback = toMessageEnvelope({
  id: 'msg_future2', time: { created: 15 }, type: 'mystery-event', detail: { answer: 42 }
}, 'ses_x')
assert.equal(textlessFallback.parts[0].typeName, 'mystery-event')
assert.equal('text' in textlessFallback.parts[0], false)
assert.deepEqual(textlessFallback.parts[0].raw, {
  id: 'msg_future2', time: { created: 15 }, type: 'mystery-event', detail: { answer: 42 }
})

// The sanitizer itself deep-copies and leaves the input untouched: sanitizeForFallback drops only
// the forbidden keys, arrays recurse, and a plain safe payload round-trips intact.
assert.deepEqual(sanitizeForFallback({ a: 1, b: { accessToken: 'x', keep: [1, { secretKey: 'y', ok: true }] } }), {
  a: 1, b: { keep: [1, { ok: true }] }
})
const sanitizeInput = { apiKey: 'sk-live', providerState: { raw: 'base64' } }
assert.deepEqual(sanitizeForFallback(sanitizeInput), {})
assert.deepEqual(sanitizeInput, { apiKey: 'sk-live', providerState: { raw: 'base64' } }, 'sanitize must not mutate its input')

// Assistant metadata propagation: the live `{"finish":"error",...}` shape used to vanish entirely;
// now agent/model/finish/error/cost/tokens/retry ride on `info` while the snapshot stays out of the
// transcript for now (no part is produced for it).
const erroredAssistant = {
  id: 'msg_z',
  time: { created: 3, completed: 4 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  content: [],
  snapshot: { start: 'snap_1', end: 'snap_2', files: [] },
  finish: 'error',
  error: { type: 'aborted', message: 'Step interrupted' },
  cost: 0.0012965372,
  tokens: { input: 11583, output: 1236, reasoning: 453, cache: { read: 178048, write: 0 } },
  retry: { attempt: 2, at: 5, error: { type: 'aborted', message: 'Retried once' } }
}
const metaEnvelope = toMessageEnvelope(erroredAssistant, 'ses_x')
assert.equal(metaEnvelope.info.agent, 'build')
assert.deepEqual(metaEnvelope.info.model, { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' })
assert.equal(metaEnvelope.info.finish, 'error')
assert.deepEqual(metaEnvelope.info.error, { type: 'aborted', message: 'Step interrupted' })
assert.equal(metaEnvelope.info.cost, 0.0012965372)
assert.deepEqual(metaEnvelope.info.tokens, { input: 11583, output: 1236, reasoning: 453 }, 'token cache is not part of the app info shape')
assert.deepEqual(metaEnvelope.info.retry, { attempt: 2, at: 5, error: { type: 'aborted', message: 'Retried once' } })
assert.deepEqual(metaEnvelope.parts, [], 'the snapshot must not become a transcript part yet')

// Tool `streaming` state carries its input as a STRING — mapping it must not mis-read it as a
// record (the old reader cast the payload blindly) and the status must survive.
const streamingTool = {
  id: 'msg_stream',
  time: { created: 1 },
  type: 'assistant',
  content: [{
    type: 'tool',
    id: 'call_stream_1',
    name: 'apply',
    executed: true,
    state: { status: 'streaming', input: 'Generating a diff for web/src/api.ts…' },
    time: { created: 1 }
  }]
}
const streamingEnvelope = toMessageEnvelope(streamingTool, 'ses_x')
assert.equal(streamingEnvelope.parts.length, 1)
assert.equal(streamingEnvelope.parts[0].type, 'tool')
assert.equal(streamingEnvelope.parts[0].state?.status, 'streaming')
assert.deepEqual(streamingEnvelope.parts[0].state?.input, { command: 'Generating a diff for web/src/api.ts…' })

// Tool `file` content: text entries still join into `output`, and `type:"file"` entries ride on the
// tool state as `outputFiles` (uri/mime/name preserved).
const fileTool = {
  id: 'msg_filetool',
  time: { created: 1, completed: 3 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
  content: [{
    type: 'tool',
    id: 'call_file_1',
    name: 'read',
    state: {
      status: 'completed',
      input: { path: 'notes.md' },
      content: [
        { type: 'text', text: '# Notes' },
        { type: 'file', uri: 'file:///tmp/notes.md', mime: 'text/markdown', name: 'notes.md' },
        { type: 'file', uri: 'file:///tmp/logo.png', mime: 'image/png' }
      ],
      metadata: { truncated: false }
    },
    time: { created: 1, ran: 2, completed: 3 }
  }]
}
const fileEnvelope = toMessageEnvelope(fileTool, 'ses_x')
assert.equal(fileEnvelope.parts.length, 1)
assert.equal(fileEnvelope.parts[0].state?.status, 'completed')
assert.ok(fileEnvelope.parts[0].state?.output?.includes('# Notes'))
assert.deepEqual(fileEnvelope.parts[0].state?.outputFiles, [
  { uri: 'file:///tmp/notes.md', mime: 'text/markdown', name: 'notes.md' },
  { uri: 'file:///tmp/logo.png', mime: 'image/png', name: undefined }
])

// A failed tool keeps its error message on the tool state (as before), with the outputs intact.
const errorTool = {
  id: 'msg_errtool',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [{
    type: 'tool',
    id: 'call_err_1',
    name: 'bash',
    state: {
      status: 'error',
      input: { command: 'rm -rf /var/empty' },
      error: { type: 'tool-error', message: 'permission denied' },
      content: [{ type: 'text', text: 'partial output' }]
    },
    time: { created: 1, ran: 2 }
  }]
}
const errorEnvelope = toMessageEnvelope(errorTool, 'ses_x')
assert.equal(errorEnvelope.parts[0].state?.status, 'error')
assert.equal(errorEnvelope.parts[0].state?.error, 'permission denied')
assert.ok(errorEnvelope.parts[0].state?.output?.includes('partial output'))

// Shells run as TOOL CALLS on the wire, with the outcome in `state.metadata` — `exit` for the exit
// code, `timeout: true` when the shell was stopped by its timeout — never as a `type:"shell"`
// message. `toToolState` must lift those onto the tool state so the exit-code and timeout badges
// fire for real shell usage, while the fields stay absent for every other tool.
const shellExitTool = {
  id: 'msg_tool_exit',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [{
    type: 'tool',
    id: 'call_shell_exit',
    name: 'shell',
    state: {
      status: 'completed',
      input: { command: 'echo hi' },
      metadata: { status: 'completed', truncated: false, exit: 0 }
    },
    time: { created: 1, ran: 2, completed: 3 }
  }]
}
const shellExitEnvelope = toMessageEnvelope(shellExitTool, 'ses_x')
assert.equal(shellExitEnvelope.parts[0].state?.status, 'completed')
assert.equal(shellExitEnvelope.parts[0].state?.exitCode, 0)

const shellTimeoutTool = {
  id: 'msg_tool_timeout',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [{
    type: 'tool',
    id: 'call_shell_timeout',
    name: 'shell',
    state: {
      status: 'completed',
      input: { command: 'sleep 100' },
      metadata: { status: 'completed', truncated: true, timeout: true }
    },
    time: { created: 1, ran: 2, completed: 3 }
  }]
}
const shellTimeoutEnvelope = toMessageEnvelope(shellTimeoutTool, 'ses_x')
assert.equal(shellTimeoutEnvelope.parts[0].state?.status, 'timeout')
assert.equal('exitCode' in shellTimeoutEnvelope.parts[0].state, false, 'a timed-out shell carries no exit code')

// `exit` is shell metadata: a non-shell tool that happens to carry it must not get an `exitCode`,
// so the exit badge never fires for e.g. a read tool.
const readExitTool = {
  id: 'msg_tool_read',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [{
    type: 'tool',
    id: 'call_read_1',
    name: 'read',
    state: {
      status: 'completed',
      input: { path: 'notes.md' },
      metadata: { status: 'completed', truncated: false, exit: 0 }
    },
    time: { created: 1, ran: 2, completed: 3 }
  }]
}
const readExitEnvelope = toMessageEnvelope(readExitTool, 'ses_x')
assert.equal('exitCode' in readExitEnvelope.parts[0].state, false, 'exitCode must only be lifted for the shell tool')
assert.equal(readExitEnvelope.parts[0].state?.status, 'completed')

// `toFileContentPart` turns one `Tool.Content` file entry into a standalone transcript part.
assert.deepEqual(toFileContentPart({ uri: 'file:///tmp/a.md', mime: 'text/markdown', name: 'a.md' }, 'msg_x', 'call_1'), {
  id: 'msg_x:file:file:///tmp/a.md',
  messageID: 'msg_x',
  callID: 'call_1',
  type: 'file-content',
  uri: 'file:///tmp/a.md',
  mime: 'text/markdown',
  name: 'a.md'
})

// Shell messages: `exited` → completed (+ exitCode), while `timeout`/`killed` keep their own
// statuses so the UI can distinguish an interrupted shell from a finished one.
const shellExited = toMessageEnvelope({
  id: 'msg_sh_e', time: { created: 1, completed: 2 }, type: 'shell', shellID: 'sh_1',
  command: 'echo hi', status: 'exited', exit: 0, output: { output: 'hi\n', cursor: 3, size: 3, truncated: false }
}, 'ses_x')
assert.equal(shellExited.parts[0].state?.status, 'completed')
assert.equal(shellExited.parts[0].state?.exitCode, 0)
assert.equal(shellExited.parts[0].state?.output, 'hi\n')
assert.deepEqual(shellExited.parts[0].state?.input, { command: 'echo hi' })
const shellNoExit = toMessageEnvelope({
  id: 'msg_sh_n', time: { created: 3 }, type: 'shell', shellID: 'sh_2', command: 'echo hi', status: 'exited'
}, 'ses_x')
assert.equal('exitCode' in shellNoExit.parts[0].state, false, 'no exit code, no exitCode field')
assert.equal(toMessageEnvelope({ id: 'msg_sh_t', time: { created: 4 }, type: 'shell', shellID: 'sh_3', command: 'sleep 100', status: 'timeout' }, 'ses_x').parts[0].state?.status, 'timeout')
assert.equal(toMessageEnvelope({ id: 'msg_sh_k', time: { created: 5 }, type: 'shell', shellID: 'sh_4', command: 'sleep 100', status: 'killed' }, 'ses_x').parts[0].state?.status, 'killed')
assert.equal(toMessageEnvelope({ id: 'msg_sh_r', time: { created: 6 }, type: 'shell', shellID: 'sh_5', command: 'echo hi', status: 'running' }, 'ses_x').parts[0].state?.status, 'running')

// --- Feature #10 lane 1: delegated-subagent correlation signals -------------------------------
// Synthetic fixtures only — every id was invented here. The shapes mirror the opencode v2
// `subagent` tool contract (packages/core/src/tool/plugin/subagent.ts): a finished delegated
// child injects a synthetic message carrying `metadata: { source: "subagent", childID, agent,
// state }` into the parent transcript; the tool part's `state.metadata` carries
// `{ sessionID, status: "running"|"completed" }` with agent/description on the tool input.

// A synthetic subagent completion maps its terminal signal onto `info.subagent`, while the
// `<subagent ...>` text part stays exactly as before (the renderer lane owns the visuals).
const subagentCompleted = toMessageEnvelope({
  id: 'msg_sub_done',
  time: { created: 30 },
  type: 'synthetic',
  text: '<subagent id="ses_child" state="completed" description="Do the thing">\nDone\n</subagent>',
  description: 'Do the thing',
  metadata: { source: 'subagent', childID: 'ses_child', agent: 'explorer', state: 'completed' }
}, 'ses_x')
assert.deepEqual(subagentCompleted.info.subagent, {
  childID: 'ses_child', agent: 'explorer', state: 'completed'
})
assert.deepEqual(subagentCompleted.parts, [{
  id: 'msg_sub_done:system',
  messageID: 'msg_sub_done',
  type: 'system',
  text: '<subagent id="ses_child" state="completed" description="Do the thing">\nDone\n</subagent>',
  description: 'Do the thing'
}], 'the synthetic subagent text part must keep mapping exactly as before')
// All three documented completion states survive the mapping.
assert.equal(toMessageEnvelope({
  id: 'msg_sub_err', time: { created: 31 }, type: 'synthetic',
  text: '<subagent id="ses_child" state="error" description="Do the thing">\nSubagent failed\n</subagent>',
  description: 'Do the thing',
  metadata: { source: 'subagent', childID: 'ses_child', agent: 'explorer', state: 'error' }
}, 'ses_x').info.subagent.state, 'error')
assert.equal(toMessageEnvelope({
  id: 'msg_sub_cancel', time: { created: 32 }, type: 'synthetic',
  text: '<subagent id="ses_child" state="cancelled" description="Do the thing">\nSubagent cancelled\n</subagent>',
  description: 'Do the thing',
  metadata: { source: 'subagent', childID: 'ses_child', agent: 'explorer', state: 'cancelled' }
}, 'ses_x').info.subagent.state, 'cancelled')
// A synthetic WITHOUT the subagent metadata stays exactly as today: no `info.subagent`.
const plainSynthetic = toMessageEnvelope({
  id: 'msg_syn_plain', time: { created: 33 }, type: 'synthetic', text: 'Move to /home/eric/work.', description: 'Prompt updated'
}, 'ses_x')
assert.equal(plainSynthetic.info.subagent, undefined, 'a synthetic without subagent metadata must not gain info.subagent')
// ...and neither does one whose metadata claims subagent source but carries no child id.
assert.equal(toMessageEnvelope({
  id: 'msg_sub_noid', time: { created: 34 }, type: 'synthetic', text: 'x', description: 'x',
  metadata: { source: 'subagent', state: 'completed' }
}, 'ses_x').info.subagent, undefined, 'a subagent synthetic without a childID must degrade to the old mapping')
// A terminal state is never invented (acceptance criterion #5): a subagent synthetic with an
// absent or unknown completion `state` degrades to the old mapping too — no `info.subagent` — so
// the run keeps its tool-derived in-flight status instead of snapping to a fabricated "completed".
assert.equal(toMessageEnvelope({
  id: 'msg_sub_nostate', time: { created: 35 }, type: 'synthetic',
  text: '<subagent id="ses_child" description="Do the thing">\nStill running\n</subagent>',
  description: 'Do the thing',
  metadata: { source: 'subagent', childID: 'ses_child', agent: 'explorer' }
}, 'ses_x').info.subagent, undefined, 'a subagent synthetic without a completion state must degrade to the old mapping')
assert.equal(toMessageEnvelope({
  id: 'msg_sub_unkstate', time: { created: 36 }, type: 'synthetic',
  text: '<subagent id="ses_child" description="Do the thing">\nx\n</subagent>',
  description: 'Do the thing',
  metadata: { source: 'subagent', childID: 'ses_child', agent: 'explorer', state: 'unknown' }
}, 'ses_x').info.subagent, undefined, 'an unknown completion state must degrade to the old mapping')

// `subagentRunFromTool` derives the delegated run from the tool part: child id from
// `state.metadata.sessionID`, in-flight/terminal signal from `state.metadata.status`, and
// agent/description from the tool input.
assert.deepEqual(subagentRunFromTool({
  tool: 'subagent',
  state: {
    status: 'completed',
    input: { agent: 'explorer', description: 'Find the bug', prompt: 'Investigate' },
    output: 'Found it',
    metadata: { sessionID: 'ses_child', status: 'completed' },
    time: { start: 10, end: 20 }
  }
}), {
  childID: 'ses_child', agent: 'explorer', description: 'Find the bug',
  status: 'completed', startedAt: 10, endedAt: 20, output: 'Found it'
})
// A BACKGROUND launch is the real in-flight wire shape: the PART is already `completed` while the
// job metadata still says `running` (opencode `subagent.ts` returns the backgrounded job without
// waiting). The run must stay "working" — with the live elapsed clock ticking — until the
// injected synthetic completion lands, never fall to "idle" off the part's own terminal status.
assert.equal(subagentRunFromTool({
  tool: 'subagent',
  state: {
    status: 'completed',
    input: { agent: 'explorer' },
    metadata: { sessionID: 'ses_child', status: 'running', truncated: false },
    time: { start: 10, end: 10 }
  }
}).status, 'working', 'a completed part whose job is still running must map to working')
// A FOREGROUND failure carries the part as `error` while the job metadata still says `running`
// (opencode `subagent.ts` throws ToolFailure without injecting a completion): the part's own
// error state is the source of truth for failure, so the pill shows failed and the error box
// keeps rendering.
assert.equal(subagentRunFromTool({
  tool: 'subagent',
  state: { status: 'error', input: { agent: 'explorer' }, metadata: { sessionID: 'ses_child', status: 'running' }, error: 'boom' }
}).status, 'failed', 'a foreground-failed subagent must map to failed despite the running job metadata')
assert.equal(subagentRunFromTool({
  tool: 'subagent',
  state: { status: 'error', input: { agent: 'explorer' }, metadata: { sessionID: 'ses_child', status: 'running' }, error: 'boom' }
}).error, 'boom', 'the foreground-failed run must keep the tool error surfaced')
// Terminal states come only from the server's metadata.status, mapped onto the shared vocabulary.
assert.equal(subagentRunFromTool({
  tool: 'subagent',
  state: { status: 'completed', input: { agent: 'explorer' }, metadata: { sessionID: 'ses_child', status: 'error' } }
}).status, 'failed')
assert.equal(subagentRunFromTool({
  tool: 'subagent',
  state: { status: 'completed', input: { agent: 'explorer' }, metadata: { sessionID: 'ses_child', status: 'cancelled' } }
}).status, 'stopped')
// The in-flight RUNNING part ships `metadata:{}` on the wire (opencode `message-updater.ts`), so
// it carries no session id: it degrades to null and renders as the generic tool row, exactly like
// the streaming part.
assert.equal(subagentRunFromTool({
  tool: 'subagent',
  state: { status: 'running', input: { agent: 'explorer' }, metadata: {} }
}), null, 'a running part without session id metadata must degrade to the generic row')
// Missing correlation data degrades to null: a non-subagent tool, or a subagent part without a
// non-empty `metadata.sessionID` — the caller falls back to generic tool rendering.
assert.equal(subagentRunFromTool({ tool: 'read', state: { metadata: { sessionID: 'ses_child', status: 'completed' } } }), null)
assert.equal(subagentRunFromTool({ tool: 'subagent', state: { status: 'completed', metadata: { status: 'completed' } } }), null)
assert.equal(subagentRunFromTool({ tool: 'subagent' }), null, 'a subagent part without state metadata degrades to null')
assert.equal(subagentRunFromTool({ tool: 'subagent', state: { metadata: { sessionID: '', status: 'completed' } } }), null, 'an empty child id is not correlation data')

// `subagentRunFromCompletion` reads the terminal signal off the envelope info, mapping the
// completion state onto the shared vocabulary; absent signal → null.
assert.deepEqual(subagentRunFromCompletion({ subagent: { childID: 'ses_child', agent: 'explorer', state: 'completed' } }), {
  childID: 'ses_child', agent: 'explorer', status: 'completed'
})
assert.equal(subagentRunFromCompletion({ subagent: { childID: 'ses_child', agent: 'explorer', state: 'error' } }).status, 'failed')
assert.equal(subagentRunFromCompletion({ subagent: { childID: 'ses_child', agent: 'explorer', state: 'cancelled' } }).status, 'stopped')
assert.equal(subagentRunFromCompletion({}), null)
assert.equal(subagentRunFromCompletion({ subagent: undefined }), null)

// The completion headline must read the structured `system` part the mapper emits for a subagent
// completion (the child's short description on `description`, the model-facing `<subagent ...>`
// block on `text`) — plain text-part extraction alone would come back empty. The same tag-stripper
// handles a plain-text completion, and over-long payloads stay in the transcript.
assert.equal(subagentCompletionDescription(subagentCompleted.parts), 'Do the thing',
  'the description must come off the system part, not the empty text extraction')
assert.equal(subagentCompletionDescription([
  { id: 'msg_syn_plain:text', type: 'text', text: '<subagent id="ses_child" state="completed">\nDone\n</subagent>' }
]), 'Done', 'a plain-text completion keeps its block on text and strips the wrapper tags')
assert.equal(subagentCompletionDescription([
  { id: 'x:text', type: 'text', text: `<subagent id="ses_child">\n${'long '.repeat(100)}\n</subagent>` }
]), undefined, 'an over-long completion payload is not a card headline')
assert.equal(subagentCompletionDescription([]), undefined, 'an empty envelope carries no description')

// The completion's inner payload — the child's actual final output — must be extracted for the run
// card (issue #47): only the outer `<subagent ...>`/`</subagent>` tags are stripped, a normal
// system/text message passes through as undefined, and an empty payload surfaces nothing.
assert.equal(subagentCompletionOutput([
  { id: 'msg_sub_done:system', messageID: 'msg_sub_done', type: 'system', text: '<subagent id="ses_child" state="completed" description="Do the thing">\nDone\n</subagent>', description: 'Do the thing' }
]), 'Done', 'the structured system part must yield the child\u2019s actual final output')
assert.equal(subagentCompletionOutput([
  { id: 'msg:text', type: 'text', text: '<subagent id="ses_child" state="completed">\nFinished the task\n</subagent>' }
]), 'Finished the task', 'a plain-text completion without a description must extract the same way')
assert.equal(subagentCompletionOutput([
  { id: 'msg:system', type: 'system', text: "Today's date is now: Sat Aug 15 2026", description: 'Instructions updated: core/date' }
]), undefined, 'a normal system message is not a synthetic wrapper and must be untouched')
assert.equal(subagentCompletionOutput([
  { id: 'msg:text', type: 'text', text: 'Move to /home/eric/work.' }
]), undefined, 'a normal text message is not a synthetic wrapper and must be untouched')
assert.equal(subagentCompletionOutput([
  { id: 'msg:system', type: 'system', text: '<subagent id="ses_child">\n</subagent>', description: 'Do the thing' }
]), undefined, 'an empty wrapper payload has no output to surface')
assert.equal(subagentCompletionOutput([]), undefined, 'no parts carry no output')

// The recognition predicate is strict about the wrapper spanning the whole payload: inline tag
// mentions and partial blocks are ordinary content and must keep rendering as before.
assert.equal(isSubagentCompletionWrapper('<subagent id="ses_child" state="completed" description="Do the thing">\nDone\n</subagent>'), true)
assert.equal(isSubagentCompletionWrapper('  <subagent id="ses_child">Done</subagent>\n'), true, 'surrounding whitespace is still a complete wrapper')
assert.equal(isSubagentCompletionWrapper('The subagent finished.'), false, 'plain prose is not a wrapper')
assert.equal(isSubagentCompletionWrapper('See <subagent id="x">inline</subagent> in text'), false, 'a wrapper must span the whole payload to be the injected completion')
assert.equal(isSubagentCompletionWrapper('<subagent id="x">unclosed'), false, 'an unclosed tag is not the injected completion')
assert.equal(isSubagentCompletionWrapper(undefined), false)

// --- Feature #47 lane: live running-subagent summary ------------------------------------------
// Synthetic fixtures only — every id was invented here. The shapes mirror the opencode v2
// `subagent` tool contract exactly as the live server publishes them: the ephemeral
// `session.tool.progress` event carries `{ sessionID, assistantMessageID, id, metadata }` with
// the child correlation NESTED — the plugin publishes `context.progress({ metadata: {...} })`,
// so `data.metadata = { metadata: { sessionID: <childID>, status: "running" } }` (a shell tool's
// flat `{ shellID }` update does not nest) — while the child's own transcript
// (GET /api/session/{child}/message) is the source of the live output.

// The live status vocabulary gates both the elapsed clock and the live output window.
assert.equal(isLiveSubagentStatus('working'), true)
assert.equal(isLiveSubagentStatus('waiting'), true)
assert.equal(isLiveSubagentStatus('retrying'), true)
assert.equal(isLiveSubagentStatus('completed'), false)
assert.equal(isLiveSubagentStatus('failed'), false)
assert.equal(isLiveSubagentStatus('stopped'), false)
assert.equal(isLiveSubagentStatus('idle'), false)

// A parent transcript whose streaming `subagent` tool part has no child correlation yet — exactly
// the bare launch row the app showed while the child ran before this feature.
const parentWithStreamingSubagent = toMessageEnvelope({
  id: 'msg_parent',
  time: { created: 1 },
  type: 'assistant',
  content: [
    {
      type: 'tool',
      id: 'call_00_sub1',
      name: 'subagent',
      executed: false,
      state: {
        status: 'streaming',
        input: { agent: 'explorer', description: 'Find the bug', prompt: 'Investigate' },
        metadata: {}
      },
      time: { created: 1 }
    }
  ]
}, 'ses_parent')
assert.equal(subagentRunFromTool(parentWithStreamingSubagent.parts[0]), null,
  'a streaming subagent part without metadata.sessionID must stay a bare tool row')

// The captured-shape progress event: exactly what opencode `subagent.ts` publishes at launch —
// the child correlation is nested under `metadata.metadata` because the plugin passes its record
// to `context.progress({ metadata: ... })`. `subagentProgressMetadata` normalizes it to the flat
// `{ sessionID, status }` record the run derivation reads; the app handler applies that.
const subagentProgressEvent = {
  type: 'session.tool.progress',
  sessionID: 'ses_parent',
  assistantMessageID: 'msg_parent',
  id: 'call_00_sub1',
  metadata: { metadata: { sessionID: 'ses_child', status: 'running' } }
}
const subagentProgress = subagentProgressMetadata(subagentProgressEvent.metadata)
assert.deepEqual(subagentProgress, { sessionID: 'ses_child', status: 'running' },
  'the nested live-server shape must normalize to the flat correlation record')
assert.deepEqual(subagentProgressMetadata({ sessionID: 'ses_child', status: 'running' }),
  { sessionID: 'ses_child', status: 'running' },
  'a flat metadata record must pass through unchanged')
assert.equal(subagentProgressMetadata({ shellID: 'sh_1' }), undefined,
  'a non-subagent progress update carries no sessionID')
assert.equal(subagentProgressMetadata({ metadata: { shellID: 'sh_1' } }), undefined,
  'a nested non-subagent progress update carries no sessionID')
assert.equal(subagentProgressMetadata(undefined), undefined,
  'no metadata carries no child correlation')

// (a) The progress event injects its normalized metadata onto the matching tool part, immutably.
const injected = applyStreamedToolProgress(
  [parentWithStreamingSubagent],
  subagentProgressEvent.sessionID,
  subagentProgressEvent.assistantMessageID,
  subagentProgressEvent.id,
  subagentProgress
)
assert.deepEqual(injected[0].parts[0].state.metadata, { sessionID: 'ses_child', status: 'running' },
  'the progress metadata must land on the matching tool part so the run card appears while the child runs')
assert.notEqual(injected[0].parts[0], parentWithStreamingSubagent.parts[0],
  'the injected part must be a fresh object (immutable update)')
assert.equal(injected[0].info.id, parentWithStreamingSubagent.info.id,
  'unrelated envelope fields must be preserved')
assert.equal(subagentRunFromTool(injected[0].parts[0])?.childID, 'ses_child',
  'the injected correlation must make subagentRunFromTool derive a run immediately')
assert.equal(subagentRunFromTool(injected[0].parts[0])?.status, 'working',
  'the injected status "running" must map to the live working state')
// Merging is keyed on the part's callID and the event's assistantMessageID: a different call or a
// different message leaves the transcript untouched (same array, same part object).
const noMatchInput = [parentWithStreamingSubagent]
assert.equal(
  applyStreamedToolProgress(noMatchInput, 'ses_parent', 'msg_parent', 'call_00_other', subagentProgress),
  noMatchInput,
  'a progress event for an unknown callID must not touch the transcript'
)
const otherSessionInput = [parentWithStreamingSubagent]
assert.equal(
  applyStreamedToolProgress(otherSessionInput, 'ses_other', 'msg_parent', 'call_00_sub1', subagentProgress),
  otherSessionInput,
  'a progress event for another session must not touch the transcript'
)
// A later event with more metadata merges over, keeping earlier keys (the terminal success event
// arrives through the durable part update, but the merge must stay additive regardless).
const reInjected = applyStreamedToolProgress(injected, 'ses_parent', 'msg_parent', 'call_00_sub1', { status: 'completed' })
assert.deepEqual(reInjected[0].parts[0].state.metadata, { sessionID: 'ses_child', status: 'completed' },
  'a later progress merge must keep the child id and take the newer status')

// (b) The live-output extraction flattens the child transcript's text parts into bounded lines.
const childTranscript = [
  toMessageEnvelope({
    id: 'msg_child_user',
    time: { created: 1 },
    type: 'user',
    text: 'You are a subagent spawned by another session. Investigate.'
  }, 'ses_child'),
  toMessageEnvelope({
    id: 'msg_child_1',
    time: { created: 2 },
    type: 'assistant',
    content: [
      { type: 'reasoning', text: 'Let me think about the parser.' },
      { type: 'text', text: 'Found the bug.\n\nIt was the parser.' }
    ]
  }, 'ses_child'),
  toMessageEnvelope({
    id: 'msg_child_2',
    time: { created: 3 },
    type: 'assistant',
    content: [
      { type: 'tool', id: 'call_c1', name: 'read', executed: true, state: { status: 'completed', metadata: {} }, time: { created: 3, completed: 4 } },
      { type: 'text', text: 'Done.' }
    ]
  }, 'ses_child')
]
assert.deepEqual(extractChildOutputLines(childTranscript),
  ['You are a subagent spawned by another session. Investigate.', 'Found the bug.', 'It was the parser.', 'Done.'],
  'text parts flatten to lines; reasoning and tool parts stay out; blank lines are dropped')
assert.deepEqual(extractChildOutputLines(childTranscript, 2),
  ['It was the parser.', 'Done.'],
  'the cap keeps the newest lines, not the oldest')
assert.deepEqual(extractChildOutputLines([]), [], 'an empty child transcript extracts no lines')

// The live-window fetch is scoped to runs that are actually in flight.
const parentWithLiveChild = applyStreamedToolProgress(
  [parentWithStreamingSubagent],
  subagentProgressEvent.sessionID,
  subagentProgressEvent.assistantMessageID,
  subagentProgressEvent.id,
  subagentProgress
)
assert.deepEqual(liveSubagentChildIDs(parentWithLiveChild), ['ses_child'],
  'a correlated running subagent is a live child')
const parentWithDoneChild = toMessageEnvelope({
  id: 'msg_parent_done',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [
    {
      type: 'tool',
      id: 'call_00_sub2',
      name: 'subagent',
      executed: true,
      state: {
        status: 'completed',
        input: { agent: 'explorer', description: 'Find the bug', prompt: 'Investigate' },
        output: 'Found it',
        metadata: { sessionID: 'ses_child', status: 'completed' }
      },
      time: { created: 1, ran: 2, completed: 3 }
    }
  ]
}, 'ses_parent')
assert.deepEqual(liveSubagentChildIDs([parentWithDoneChild]), [],
  'a terminal subagent is not a live child; its result card takes over')
assert.deepEqual(liveSubagentChildIDs([parentWithStreamingSubagent]), [],
  'a streaming subagent without correlation is not a live child')


// --- Newest-page transcript seed (issue #52) -------------------------------------------------
// Synthetic fixtures only — minimal envelopes (id/time/parts) like the fixtures above. The seed
// is an append-only merge keyed on message ids: it never re-reconciles existing messages (the full
// reload owns reconciliation), and it returns the same array on a no-op so memoized renderers stay
// put.
const seedEnvelope = (id, created) => ({
  info: { id, role: 'user', sessionID: 'ses_x', time: { created } },
  parts: [{ id: `${id}:text`, type: 'text', text: id }]
})
const seedCurrent = [seedEnvelope('msg_a', 1), seedEnvelope('msg_b', 2)]
// (a) An empty tail adds nothing and returns the same array.
assert.equal(mergeNewestTail(seedCurrent, []), seedCurrent,
  'an empty tail must return the same array')
// (b) New ids are appended in tail order, preserving the current order.
assert.deepEqual(mergeNewestTail(seedCurrent, [seedEnvelope('msg_c', 3), seedEnvelope('msg_d', 4)]).map((message) => message.info.id),
  ['msg_a', 'msg_b', 'msg_c', 'msg_d'],
  'new tail ids must append in tail order')
// (c) Existing ids keep their exact objects; only new ones are appended after.
const mergedOverlap = mergeNewestTail(seedCurrent, [seedEnvelope('msg_a', 1), seedEnvelope('msg_c', 3)])
assert.equal(mergedOverlap[0], seedCurrent[0], 'an existing message must keep its object identity')
assert.equal(mergedOverlap[1], seedCurrent[1], 'an existing message must keep its object identity')
assert.deepEqual(mergedOverlap.map((message) => message.info.id), ['msg_a', 'msg_b', 'msg_c'],
  'new ids must append after the existing ones')
// (d) A fully-overlapping tail changes nothing and returns the same array.
assert.equal(mergeNewestTail(seedCurrent, seedCurrent), seedCurrent,
  'a fully-overlapping tail must return the same array')


// --- Session todo derivation from transcript todowrite parts (issue #7) ----------------------
// Captured-style fixture: an assistant message carrying an executed `todowrite` tool part (v2 has
// no todo endpoint, so the session panel reconstructs the latest state from these parts). The tool
// input carries only content/status/priority — ids are invented by the app for rendering, never
// sent, so the fixture locks the real wire contract.
const liveTodoWrite = {
  id: 'msg_todo1',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [
    {
      type: 'tool',
      id: 'call_todo_1',
      name: 'todowrite',
      executed: true,
      state: {
        status: 'completed',
        input: {
          todos: [
            { content: 'Write tests', status: 'in_progress', priority: 'high' },
            { content: 'Fix bug', status: 'pending', priority: 'medium' }
          ]
        }
      },
      time: { created: 1, ran: 2, completed: 3 }
    }
  ]
}
const todoEnvelope = toMessageEnvelope(liveTodoWrite, 'ses_x')
assert.equal(todoEnvelope.parts.length, 1)
assert.equal(todoEnvelope.parts[0].tool, 'todowrite')
// (a) status/priority/content pass through unchanged, exactly as the todowrite input carried them.
assert.deepEqual(deriveTodosFromMessages([todoEnvelope]), [
  { content: 'Write tests', status: 'in_progress', priority: 'high' },
  { content: 'Fix bug', status: 'pending', priority: 'medium' }
])

// (b) A later completed todowrite replaces an earlier one: latest valid list wins.
const laterTodoWrite = {
  id: 'msg_todo2',
  time: { created: 2, completed: 3 },
  type: 'assistant',
  content: [
    {
      type: 'tool',
      id: 'call_todo_2',
      name: 'todowrite',
      executed: true,
      state: { status: 'completed', input: { todos: [{ content: 'Ship it', status: 'completed', priority: 'high' }] } }
    }
  ]
}
assert.deepEqual(deriveTodosFromMessages([todoEnvelope, toMessageEnvelope(laterTodoWrite, 'ses_x')]), [
  { content: 'Ship it', status: 'completed', priority: 'high' }
])

// (c) Only adopted (completed) writes count: a pending write was never applied by the server, so
// it must not replace the last completed state...
const pendingTodoWrite = {
  id: 'msg_todo_pending',
  time: { created: 4 },
  type: 'assistant',
  content: [
    { type: 'tool', id: 'call_todo_pending', name: 'todowrite', executed: false, state: { status: 'pending', input: { todos: [{ content: 'Draft', status: 'pending', priority: 'low' }] } } }
  ]
}
assert.deepEqual(deriveTodosFromMessages([todoEnvelope, toMessageEnvelope(pendingTodoWrite, 'ses_x')]), [
  { content: 'Write tests', status: 'in_progress', priority: 'high' },
  { content: 'Fix bug', status: 'pending', priority: 'medium' }
], 'a pending todowrite must not replace the last completed state')
// ...while a later completed write still does.
const adoptedAfterPendingWrite = {
  id: 'msg_todo_adopted',
  time: { created: 5, completed: 6 },
  type: 'assistant',
  content: [
    { type: 'tool', id: 'call_todo_adopted', name: 'todowrite', executed: true, state: { status: 'completed', input: { todos: [{ content: 'Adopted', status: 'completed', priority: 'high' }] } } }
  ]
}
assert.deepEqual(deriveTodosFromMessages([todoEnvelope, toMessageEnvelope(pendingTodoWrite, 'ses_x'), toMessageEnvelope(adoptedAfterPendingWrite, 'ses_x')]), [
  { content: 'Adopted', status: 'completed', priority: 'high' }
], 'a later completed todowrite overrides an earlier pending one')

// (d) A well-formed `todos: []` is an authoritative clear: the server applied it, so the panel
// must drop its previous list rather than keep the stale one.
const clearTodoWrite = {
  id: 'msg_todo_clear',
  time: { created: 7, completed: 8 },
  type: 'assistant',
  content: [
    { type: 'tool', id: 'call_todo_clear', name: 'todowrite', executed: true, state: { status: 'completed', input: { todos: [] } } }
  ]
}
assert.deepEqual(deriveTodosFromMessages([todoEnvelope, toMessageEnvelope(clearTodoWrite, 'ses_x')]), [], 'a later completed todos:[] must clear the panel')

// (e) Malformed lists are skipped — a non-array `todos` and items without a string `.content`
// count as no state — and a transcript with no valid list yields [].
const malformedTodoWrite = {
  id: 'msg_todo_bad',
  time: { created: 9 },
  type: 'assistant',
  content: [
    { type: 'tool', id: 'call_todo_bad', name: 'todowrite', executed: true, state: { status: 'completed', input: { todos: 'nope' } } },
    { type: 'tool', id: 'call_todo_noitems', name: 'todowrite', executed: true, state: { status: 'completed', input: { todos: [{ status: 'pending', priority: 'low' }] } } }
  ]
}
assert.deepEqual(deriveTodosFromMessages([toMessageEnvelope(malformedTodoWrite, 'ses_x')]), [])
assert.deepEqual(deriveTodosFromMessages([todoEnvelope, toMessageEnvelope(malformedTodoWrite, 'ses_x')]), [
  { content: 'Write tests', status: 'in_progress', priority: 'high' },
  { content: 'Fix bug', status: 'pending', priority: 'medium' }
], 'a malformed later todowrite must be skipped, keeping the last valid list')

// (f) Reconstructing the same transcript (reload) yields the same state, deterministically.
const rawTodoMessages = [liveTodoWrite, laterTodoWrite]
const firstReconstruct = deriveTodosFromMessages(rawTodoMessages.map((message) => toMessageEnvelope(message, 'ses_x')))
const secondReconstruct = deriveTodosFromMessages(rawTodoMessages.map((message) => toMessageEnvelope(message, 'ses_x')))
assert.deepEqual(firstReconstruct, secondReconstruct, 'reloading a transcript must reconstruct the same todo state')

console.log('OpenCode 2 client mapping tests passed')
