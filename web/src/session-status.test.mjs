import assert from 'node:assert/strict'
import { deriveSessionStatus, executionEventKind, reduceExecutionEvent } from './sessionStatus.ts'

// --- executionEventKind mapping ---------------------------------------------------------------
assert.equal(executionEventKind('session.execution.started'), 'started')
assert.equal(executionEventKind('session.execution.succeeded'), 'succeeded')
assert.equal(executionEventKind('session.execution.failed'), 'failed')
assert.equal(executionEventKind('session.execution.interrupted'), 'interrupted')
assert.equal(executionEventKind('session.retry.scheduled'), 'retry')
assert.equal(executionEventKind('session.error'), 'error')
assert.equal(executionEventKind('session.created'), undefined, 'unrelated event types must not map to an execution kind')
assert.equal(executionEventKind(''), undefined)

// --- reducer ----------------------------------------------------------------------------------
const event = (kind, overrides = {}) => ({ kind, at: 1_000, sessionID: 's1', ...overrides })

let memory = reduceExecutionEvent(undefined, event('started'))
assert.deepEqual(memory.latest, { kind: 'started', at: 1_000 }, 'started must seed latest')

memory = reduceExecutionEvent(memory, event('succeeded', { at: 2_000 }))
assert.deepEqual(memory.latest, { kind: 'succeeded', at: 2_000 }, 'started → succeeded must replace latest by arrival time')

memory = reduceExecutionEvent(undefined, event('started'))
memory = reduceExecutionEvent(memory, event('failed', { at: 2_000, error: { message: 'boom' } }))
assert.deepEqual(memory.latest, { kind: 'failed', at: 2_000 }, 'started → failed must replace latest')
assert.deepEqual(memory.latestError, { message: 'boom' }, 'the failed event error must be captured for the failed status')

memory = reduceExecutionEvent(memory, event('retry', { at: 3_000, attempt: 2, next: 4_000, error: { message: 'boom' } }))
assert.deepEqual(memory.latest, { kind: 'retry', at: 3_000 }, 'failed → retry must supersede failed in latest')
assert.deepEqual(memory.retry, { attempt: 2, at: 4_000, error: { message: 'boom' } }, 'retry must record attempt, scheduled at, and error')

memory = reduceExecutionEvent(memory, event('started', { at: 5_000 }))
assert.deepEqual(memory.latest, { kind: 'started', at: 5_000 }, 'retry → started must supersede retry in latest')

const errorEventMemory = reduceExecutionEvent(undefined, event('error', { at: 1_000, error: { message: 'nope' } }))
assert.equal(errorEventMemory.latest, undefined, 'an error event must not touch latest')
assert.deepEqual(errorEventMemory.lastError, { message: 'nope', at: 1_000 }, 'an error event must record lastError with its arrival time')

const interruptedMemory = reduceExecutionEvent(
  reduceExecutionEvent(undefined, event('started', { at: 1_000 })),
  event('error', { at: 2_000, error: { message: 'nope' } })
)
const interrupted = reduceExecutionEvent(interruptedMemory, event('interrupted', { at: 3_000 }))
assert.deepEqual(interrupted.latest, { kind: 'interrupted', at: 3_000 }, 'interrupted must record itself as the newest fact')
assert.equal(interrupted.lastError, undefined, 'interrupted must clear lastError')
assert.equal(interrupted.retry, undefined, 'interrupted must clear retry')

const interruptedAfterRetry = reduceExecutionEvent(
  reduceExecutionEvent(undefined, event('retry', { at: 1_000, attempt: 1, next: 2_000, error: { message: 'x' } })),
  event('interrupted', { at: 3_000 })
)
assert.equal(interruptedAfterRetry.retry, undefined, 'interrupted must clear a remembered retry')

// The reducer is immutable: reducing a new event must never mutate the input memory.
const base = reduceExecutionEvent(undefined, event('started', { at: 1_000 }))
reduceExecutionEvent(base, event('error', { at: 2_000, error: { message: 'x' } }))
assert.deepEqual(base.latest, { kind: 'started', at: 1_000 }, 'reducing an error must not mutate the previous memory')
assert.equal(base.lastError, undefined)

// --- derivation -------------------------------------------------------------------------------
const status = (memory) => deriveSessionStatus('s1', { active: new Set(), pendingForms: [], pendingPermissions: [] }, memory)

const completedMemory = reduceExecutionEvent(undefined, event('succeeded', { at: 1_000 }))
assert.deepEqual(status(completedMemory), { type: 'completed' })
assert.deepEqual(
  deriveSessionStatus('s1', { active: new Set(), pendingForms: [{ sessionID: 's1' }], pendingPermissions: [] }, completedMemory),
  { type: 'waiting' },
  'a pending form for the session must outrank a completed latest'
)
assert.deepEqual(
  deriveSessionStatus('s1', { active: new Set(), pendingForms: [], pendingPermissions: [{ sessionID: 'other' }] }, completedMemory),
  { type: 'completed' },
  'a pending permission for another session must not make this session waiting'
)

const failedMemory = reduceExecutionEvent(reduceExecutionEvent(undefined, event('started', { at: 1_000 })), event('failed', { at: 2_000, error: { message: 'boom' } }))
assert.deepEqual(status(failedMemory), { type: 'failed', message: 'boom' }, 'failed must surface the failed event message')

const retryMemory = reduceExecutionEvent(reduceExecutionEvent(undefined, event('failed', { at: 1_000, error: { message: 'boom' } })), event('retry', { at: 2_000, attempt: 2, next: 3_000, error: { message: 'boom' } }))
assert.deepEqual(status(retryMemory), { type: 'retrying', attempt: 2, next: 3_000, message: 'boom' }, 'retrying must surface attempt, scheduled time, and message')

const activeSet = new Set(['s1'])
const activeSignals = { active: activeSet, pendingForms: [], pendingPermissions: [] }
assert.deepEqual(deriveSessionStatus('s1', activeSignals, undefined), { type: 'busy' }, 'no memory + active must derive busy')
assert.deepEqual(deriveSessionStatus('s1', activeSignals, reduceExecutionEvent(undefined, event('started', { at: 1_000 }))), { type: 'busy' }, 'started + active must derive busy')
const busy = deriveSessionStatus('s1', activeSignals, undefined)
assert.equal(busy.type, 'busy')
assert.deepEqual(busy, { type: 'busy' }, 'busy must match the shared SessionStatus shape { type: "busy" }')

const startedMemory = reduceExecutionEvent(undefined, event('started', { at: 1_000 }))
assert.equal(status(startedMemory), undefined, 'started without the active set or a newer error must be idle')

const crashMemory = reduceExecutionEvent(startedMemory, event('error', { at: 2_000, error: { message: 'crashed' } }))
assert.deepEqual(status(crashMemory), { type: 'needs-attention', message: 'crashed' }, 'an error newer than the started event must derive needs-attention')

const staleErrorMemory = reduceExecutionEvent(startedMemory, event('error', { at: 500, error: { message: 'old' } }))
assert.equal(status(staleErrorMemory), undefined, 'an error older than the started event must not derive needs-attention')

assert.deepEqual(status(errorEventMemory), { type: 'needs-attention', message: 'nope' }, 'an error with no latest must derive needs-attention')

const interruptedAfterStarted = reduceExecutionEvent(startedMemory, event('interrupted', { at: 2_000 }))
assert.equal(status(interruptedAfterStarted), undefined, 'interrupted must derive idle whatever came before')

// Invariant: no sequence of non-terminal reduces (started/retry/error/interrupted only) may ever
// derive a terminal status — "failed"/"completed" come exclusively from their own wire events.
let invariantMemory = undefined
for (const [kind, overrides] of [
  ['started', { at: 1_000 }],
  ['error', { at: 2_000, error: { message: 'x' } }],
  ['retry', { at: 3_000, attempt: 1, next: 4_000 }],
  ['interrupted', { at: 5_000 }],
  ['started', { at: 6_000 }],
  ['retry', { at: 7_000, attempt: 2, next: 8_000 }],
  ['error', { at: 9_000, error: { message: 'y' } }]
]) {
  invariantMemory = reduceExecutionEvent(invariantMemory, event(kind, overrides))
  const derived = status(invariantMemory)
  assert.notEqual(derived?.type, 'failed', `a non-terminal sequence must never derive failed after ${kind}`)
  assert.notEqual(derived?.type, 'completed', `a non-terminal sequence must never derive completed after ${kind}`)
}

console.log('session-status tests passed')
