import assert from 'node:assert/strict'
import {
  attentionItemAt,
  attentionItemFromDraft,
  attentionItemId,
  collectAttentionItems,
  filterDismissed,
  itemGeneration
} from './attentionInbox.ts'
import { attentionStorageKey, loadAttentionState, pruneAttentionState, saveAttentionState } from './attentionPersistence.ts'
import { toSavedPermission } from './opencode2-mappers.ts'

// --- attentionItemId: q:/p:/f:/c: prefixes ------------------------------------------------
assert.equal(attentionItemId('question', 's1', 'r1'), 'q:r1')
assert.equal(attentionItemId('permission', 's1', 'r2'), 'p:r2')
assert.equal(attentionItemId('failure', 's1'), 'f:s1')
assert.equal(attentionItemId('completion', 's1'), 'c:s1')

const run = (overrides = {}) => ({
  id: 'x',
  backend: 'opencode2',
  sessionId: 's1',
  title: 'T',
  directory: '/d',
  status: 'idle',
  ...overrides
})

const draft = (attention, overrides = {}) => attentionItemFromDraft({
  run: run(),
  attention,
  itemAt: 100,
  ...overrides
})

// --- attentionItemAt: F/C use the execution-memory generation, Q/P use session.updated ----
assert.equal(attentionItemAt(run({ updatedAt: 100 }), 'failure'), 100)
assert.equal(attentionItemAt(run({ updatedAt: 100 }), 'failure', () => 500), 500, 'F/C must prefer the execution-memory generation')
assert.equal(attentionItemAt(run({ updatedAt: 100 }), 'failure', () => undefined), 100, 'a missing generation must fall back to the run update time')
assert.equal(attentionItemAt(run(), 'completion', () => 500), 500)
assert.equal(attentionItemAt(run({ updatedAt: 100 }), 'question', () => 500), 100, 'Q/P must use session.updated, never the execution-memory generation')
assert.equal(attentionItemAt(run(), 'permission'), 0)

// --- attentionItemFromDraft ---------------------------------------------------------------
const permissionItem = draft({ reason: 'permission', requestId: 'p1' }, { requestId: 'p1', message: 'Run shell command' })
assert.deepEqual(permissionItem, {
  id: 'p:p1',
  kind: 'permission',
  sessionId: 's1',
  sessionTitle: 'T',
  directory: '/d',
  backend: 'opencode2',
  requestId: 'p1',
  message: 'Run shell command',
  at: 100
})
assert.equal('patterns' in permissionItem, false, 'an inbox item must never carry permission patterns')

const failureItem = draft({ reason: 'failure' }, { message: 'x'.repeat(200) })
assert.equal(failureItem.id, 'f:s1')
assert.equal(failureItem.kind, 'failure')
assert.equal(failureItem.message.length, 140, 'failure messages must be hard-capped at 140 chars')
assert.equal(failureItem.message, 'x'.repeat(140))

const questionItem = draft({ reason: 'question', requestId: 'q1' }, { requestId: 'q1', message: 'y'.repeat(180) })
assert.equal(questionItem.id, 'q:q1')
assert.equal(questionItem.kind, 'question')
assert.equal(questionItem.message.length, 140, 'question labels must be hard-capped at 140 chars')

const completionItem = draft({ reason: 'completion' })
assert.equal(completionItem.id, 'c:s1')
assert.equal('message' in completionItem, false, 'completion items carry no message')
assert.equal('requestId' in completionItem, false, 'completion items carry no request id')

const agentItem = draft({ reason: 'failure' }, { run: run({ agent: 'build', machineId: 'workstation' }) })
assert.equal(agentItem.agent, 'build', 'the item must carry the run agent when present')
assert.equal(agentItem.machineId, 'workstation', 'the item must carry the run machine when present')

// --- collectAttentionItems ----------------------------------------------------------------
const signals = {
  questions: [{ id: 'q1', sessionID: 's1', questions: [{ question: 'Pick a framework?', header: '', options: [] }], tool: { messageID: 'm', callID: 'c' } }],
  permissions: [{ id: 'p1', sessionID: 's2', permission: 'Run shell command', patterns: ['/home/*'], metadata: {}, always: [], tool: { messageID: 'm', callID: 'c' } }]
}
const items = collectAttentionItems(
  [
    run({ sessionId: 's1', updatedAt: 100 }),
    run({ sessionId: 's2', updatedAt: 200 }),
    run({ sessionId: 's3', updatedAt: 300, attention: { reason: 'failure' } }),
    run({ sessionId: 's3', updatedAt: 400, attention: { reason: 'completion' } })
  ],
  signals,
  { machineId: 'workstation' }
)
// One item per pending request (q/p) plus one per (session, kind) for terminals; sorted newest first.
assert.deepEqual(items.map((item) => item.id), ['c:s3', 'f:s3', 'p:p1', 'q:q1'])
assert.equal(items.every((item) => item.machineId === 'workstation'), true, 'machineId must be applied to every item when provided')
const question = items.find((item) => item.id === 'q:q1')
assert.equal(question.sessionId, 's1')
assert.equal(question.message, 'Pick a framework?', 'the question item must carry the first question label')
assert.equal(question.requestId, 'q1')
const permission = items.find((item) => item.id === 'p:p1')
assert.equal(permission.message, 'Run shell command', 'the permission item must carry the ACTION NAME, never the patterns')
assert.equal('patterns' in permission, false, 'criterion 6: the inbox summarizes, the card reveals')

// ONE ITEM PER REQUEST: two pending forms on one session are two independently resolvable items.
const perRequest = collectAttentionItems(
  [run({ sessionId: 's1', updatedAt: 100 })],
  {
    questions: [
      { id: 'q1', sessionID: 's1', questions: [{ question: 'First', header: '', options: [] }], tool: { messageID: 'm', callID: 'c' } },
      { id: 'q2', sessionID: 's1', questions: [{ question: 'Second', header: '', options: [] }], tool: { messageID: 'm', callID: 'c' } }
    ]
  }
)
assert.deepEqual(perRequest.map((item) => item.id).sort(), ['q:q1', 'q:q2'], 'each pending question request must project its own item')
assert.equal(perRequest.find((item) => item.id === 'q:q2').message, 'Second')

// A request for a session absent from the run list cannot be opened, so it stays out.
const orphanRequest = collectAttentionItems([run({ sessionId: 's1', updatedAt: 100 })], {
  permissions: [{ id: 'p9', sessionID: 's-orphan', permission: 'x', patterns: [], metadata: {}, always: [], tool: { messageID: 'm', callID: 'c' } }]
})
assert.deepEqual(orphanRequest, [], 'a request for a session with no run must not project')

// The attentionAt option feeds F/C generations (execution-memory latest.at).
const withAttentionAt = collectAttentionItems(
  [run({ sessionId: 's1', updatedAt: 10, attention: { reason: 'failure' } })],
  {},
  { attentionAt: (sessionId) => (sessionId === 's1' ? 999 : undefined) }
)
assert.equal(withAttentionAt[0].at, 999, 'F/C items must use the execution-memory generation when supplied')

// Runs without any terminal attention contribute nothing (this is the projection; the server
// decides which sessions need attention).
const projection = collectAttentionItems(
  [
    run({ sessionId: 's1', updatedAt: 100 }),
    run({ sessionId: 's2', updatedAt: 200, attention: { reason: 'completion' } })
  ],
  {}
)
assert.deepEqual(projection.map((item) => item.id), ['c:s2'], 'runs without terminal attention must not project any item')

// Caller-provided label/action overrides win over the signal lookups.
const overridden = collectAttentionItems(
  [run({ sessionId: 's1', updatedAt: 100 }), run({ sessionId: 's2', updatedAt: 200 })],
  {
    questions: [{ id: 'q1', sessionID: 's1', questions: [{ question: 'Signal label', header: '', options: [] }], tool: { messageID: 'm', callID: 'c' } }],
    permissions: [{ id: 'p1', sessionID: 's2', permission: 'Signal action', patterns: [], metadata: {}, always: [], tool: { messageID: 'm', callID: 'c' } }]
  },
  { permissionAction: (requestId) => `Allow ${requestId}`, questionLabel: (requestId) => `About ${requestId}` }
)
assert.equal(overridden.find((item) => item.id === 'q:q1').message, 'About q1')
assert.equal(overridden.find((item) => item.id === 'p:p1').message, 'Allow p1')

// --- itemGeneration / filterDismissed -----------------------------------------------------
const fItem = draft({ reason: 'failure' }, { itemAt: 100 })
const fItemAgain = draft({ reason: 'failure' }, { itemAt: 200 })
const cItem = draft({ reason: 'completion' }, { itemAt: 100 })
const qItem = draft({ reason: 'question', requestId: 'r1' }, { itemAt: 100, requestId: 'r1' })
const pItem = draft({ reason: 'permission', requestId: 'r1' }, { itemAt: 100, requestId: 'r1' })

assert.equal(itemGeneration(fItem), 'f:s1@100')

// f/c hide on generation match.
assert.deepEqual(filterDismissed([fItem], new Set(['f:s1@100'])), [], 'a failure must hide on its exact generation')
assert.deepEqual(filterDismissed([cItem], new Set(['c:s1@100'])), [], 'a completion must hide on its exact generation')
// Other-generation f/c NOT hidden: a re-failure re-alerts.
assert.deepEqual(filterDismissed([fItemAgain], new Set(['f:s1@100'])), [fItemAgain], 'a NEW failure generation must re-alert despite the old dismissal')
// q/p hide on bare id.
assert.deepEqual(filterDismissed([qItem], new Set(['q:r1'])), [], 'a question must hide on its bare id')
assert.deepEqual(filterDismissed([pItem], new Set(['p:r1'])), [], 'a permission must hide on its bare id')
// q/p are NOT hidden by a generation entry: their `at` (session.updated) changes on unrelated activity.
assert.deepEqual(filterDismissed([qItem], new Set(['q:r1@100'])), [qItem], 'a question must not hide on a generation entry')
assert.deepEqual(filterDismissed([pItem], new Set(['p:r1@100'])), [pItem], 'a permission must not hide on a generation entry')
// Unknown items kept.
assert.deepEqual(filterDismissed([fItem, qItem], new Set(['c:s9@1', 'q:other'])), [fItem, qItem], 'undismissed items must be kept')

// --- attentionPersistence ----------------------------------------------------------------
const storage = new Map()
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() }
}

// The storage key is an opaque hash of the namespace — never raw credentials.
const key = attentionStorageKey('profile-a\u0000https://user:secret@host:1234')
assert.match(key, /^opencode\.remote\.attention\.[0-9a-f]+$/, 'the storage key must be the prefix plus a hex hash')
assert.ok(!key.includes('secret'), 'the storage key must not contain the raw namespace (credentials)')
assert.equal(key, attentionStorageKey('profile-a\u0000https://user:secret@host:1234'), 'the hash must be stable for one namespace')
assert.notEqual(key, attentionStorageKey('profile-b\u0000https://user:secret@host:1234'), 'different namespaces must hash differently')

// load/save round-trip.
const state = { dismissed: ['f:s1@100'], notified: ['q:r1'] }
saveAttentionState(key, state)
assert.deepEqual(loadAttentionState(key), state, 'save then load must round-trip the dismissed/notified sets')
assert.deepEqual(loadAttentionState('opencode.remote.attention.unknown'), { dismissed: [], notified: [] }, 'an absent key must load an empty state')
storage.set(key, '{not json')
assert.deepEqual(loadAttentionState(key), { dismissed: [], notified: [] }, 'corrupt storage must load as empty')

// prune keeps live generations and drops dead ones.
const pruned = pruneAttentionState(
  { dismissed: ['f:s1@100', 'f:s1@200', 'q:r1', 'p:r2', 'f:s9@999'], notified: ['c:s1@100', 'q:r1', 'q:gone'] },
  new Set(['f:s1@200', 'c:s1@100', 'q:r1@555', 'p:r2@777'])
)
assert.deepEqual(pruned, {
  dismissed: ['f:s1@200', 'q:r1', 'p:r2'],
  notified: ['c:s1@100', 'q:r1']
}, 'prune must keep live generations and bare q:/p: ids whose item still exists, dropping the rest')
const prunedEmpty = pruneAttentionState({ dismissed: ['f:s1@100'], notified: [] }, new Set())
assert.deepEqual(prunedEmpty, { dismissed: [], notified: [] }, 'an empty live set must prune everything')

// --- toSavedPermission -------------------------------------------------------------------
assert.deepEqual(toSavedPermission({ id: 'sp1', projectID: 'global', action: 'shell', resource: '/home/*' }), {
  id: 'sp1', projectID: 'global', action: 'shell', resource: '/home/*'
}, 'a normal permission pattern must be kept for the revoke UI')
assert.deepEqual(toSavedPermission({ id: 'sp2', projectID: 'global', action: 'shell', resource: 'sk-prod-secret-token' }), {
  id: 'sp2', projectID: 'global', action: 'shell', resource: '[redacted]'
}, 'a resource that itself looks like a credential must be masked')
assert.deepEqual(toSavedPermission({}), { id: '', projectID: '', action: '', resource: '' }, 'missing fields must map to empty strings')

console.log('attention inbox tests passed')
