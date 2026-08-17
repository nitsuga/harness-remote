import assert from 'node:assert/strict'
import { REAPED_SET_CAP, reapCandidates, rememberReaped } from './sessionReaping.ts'

// Completions are terminal by construction (collectSubagentCompletions only records
// completed/error/cancelled), so a completion-map key is a reap candidate unless excluded.
const completion = (childID) => ({ childID, status: 'completed' })
const completionsOf = (children) => {
  const map = new Map()
  for (const childID of children) map.set(childID, completion(childID))
  return map
}

// --- enabled=false: nothing is reaped even with terminal completions present. ---
assert.deepEqual(
  reapCandidates({
    completions: completionsOf(['child-a', 'child-b']),
    reaped: new Set(),
    inFlight: new Set(),
    selectedSessionID: null,
    enabled: false
  }),
  [],
  'a disabled setting must reap nothing'
)

// --- enabled=true (the default): every terminal completion is a candidate, in map order. ---
assert.deepEqual(
  reapCandidates({
    completions: completionsOf(['child-a', 'child-b', 'child-c']),
    reaped: new Set(),
    inFlight: new Set(),
    selectedSessionID: null,
    enabled: true
  }),
  ['child-a', 'child-b', 'child-c'],
  'terminal completions must be candidate in iteration order'
)
assert.deepEqual(
  reapCandidates({
    completions: new Map(),
    reaped: new Set(),
    inFlight: new Set(),
    selectedSessionID: null,
    enabled: true
  }),
  [],
  'an empty completion map yields no candidates'
)

// --- Already reaped children are excluded. ---
assert.deepEqual(
  reapCandidates({
    completions: completionsOf(['child-a', 'child-b', 'child-c']),
    reaped: new Set(['child-b']),
    inFlight: new Set(),
    selectedSessionID: null,
    enabled: true
  }),
  ['child-a', 'child-c'],
  'a reaped child must not be reaped twice'
)

// --- In-flight deletes are excluded (one delete per child at a time). ---
assert.deepEqual(
  reapCandidates({
    completions: completionsOf(['child-a', 'child-b', 'child-c']),
    reaped: new Set(),
    inFlight: new Set(['child-a', 'child-c']),
    selectedSessionID: null,
    enabled: true
  }),
  ['child-b'],
  'a child whose delete is already in flight must not be selected again'
)

// --- The session the user is currently viewing is never reaped. ---
assert.deepEqual(
  reapCandidates({
    completions: completionsOf(['child-a', 'child-b']),
    reaped: new Set(),
    inFlight: new Set(),
    selectedSessionID: 'child-b',
    enabled: true
  }),
  ['child-a'],
  'the selected session must never be reaped under the user'
)

// --- Combined exclusions compose in one pass, keeping iteration order. ---
assert.deepEqual(
  reapCandidates({
    completions: completionsOf(['a', 'b', 'c', 'd', 'e']),
    reaped: new Set(['a', 'e']),
    inFlight: new Set(['c']),
    selectedSessionID: 'd',
    enabled: true
  }),
  ['b'],
  'reaped, in-flight, and selected exclusions must combine in a single ordered pass'
)

// --- rememberReaped: bounded FIFO ledger with idempotent folding. ---
{
  const ledger = new Set()
  let next = ledger
  for (let i = 0; i < REAPED_SET_CAP; i += 1) {
    next = rememberReaped(next, [`child-${i}`])
  }
  assert.equal(next.size, REAPED_SET_CAP, 'the ledger must never grow beyond its cap')
  assert.ok(next.has('child-0'), 'the first reaped child must still be remembered at exactly the cap')

  next = rememberReaped(next, ['child-overflow'])
  assert.equal(next.size, REAPED_SET_CAP, 'adding past the cap must stay bounded')
  assert.ok(!next.has('child-0'), 'the oldest entry must be evicted first (FIFO)')
  assert.ok(next.has('child-1'), 'the second-oldest entry must survive the first eviction')
  assert.ok(next.has('child-overflow'), 'the newest entry must survive eviction')

  // Re-reporting an id already present is a no-op (Set semantics): the same delete outcome can be
  // confirmed multiple times without growing the ledger or disturbing its bounds.
  next = rememberReaped(next, ['child-5', 'child-overflow'])
  assert.equal(next.size, REAPED_SET_CAP, 're-adding known ids must not grow the ledger')
  assert.ok(next.has('child-5') && next.has('child-overflow'), 'reported ids must remain present')

  // Bulk fold over the cap from an empty set still lands exactly at the cap.
  const bulk = rememberReaped(new Set(), Array.from({ length: REAPED_SET_CAP + 10 }, (_, i) => `bulk-${i}`))
  assert.equal(bulk.size, REAPED_SET_CAP, 'a bulk fold must clamp to the cap')
  assert.ok(!bulk.has('bulk-0') && bulk.has(`bulk-${REAPED_SET_CAP + 9}`), 'a bulk fold must keep the newest ids')
}

console.log('session reaping tests passed')