import assert from 'node:assert/strict'
import { buildSessionTree, readParentID } from './sessionTree.ts'

const session = (id, overrides = {}) => ({
  id,
  title: `Session ${id}`,
  directory: '/work/project',
  updated: 1_723_456_789_000,
  status: 'idle',
  files: 0,
  additions: 0,
  deletions: 0,
  ...overrides
})

// Production attaches `parentID` non-enumerably (App.tsx toSessionView), so fixtures mirror that:
// a plain field would work through the cast too, but the non-enumerable shape is the real one.
const withParent = (s, parentID) => {
  Object.defineProperty(s, 'parentID', { value: parentID, enumerable: false })
  return s
}

const ids = (nodes) => nodes.map((node) => node.session.id)

// readParentID is the shared cast helper — plain fields and the non-enumerable shape both read.
assert.equal(readParentID(session('plain')), undefined)
assert.equal(readParentID(withParent(session('child'), 'parent')), 'parent')

// --- Empty and flat lists (the normal case on most backends): a straight pass-through. ---
assert.deepEqual(buildSessionTree([]), [])
const flat = [session('a'), session('b'), session('c')]
assert.deepEqual(ids(buildSessionTree(flat)), ['a', 'b', 'c'], 'a list without parent links must render unchanged')
for (const node of buildSessionTree(flat)) assert.deepEqual(node.children, [], 'flat sessions must have no children')

// --- Grouping: children nest under their parent, in input order. ---
const grouped = buildSessionTree([
  session('parent'),
  withParent(session('child-1'), 'parent'),
  withParent(session('child-2'), 'parent')
])
assert.deepEqual(ids(grouped), ['parent'])
assert.deepEqual(ids(grouped[0].children), ['child-1', 'child-2'], 'children keep their relative input order')

// --- Nested depth: a chain renders recursively at every level. ---
const deep = buildSessionTree([
  session('a'),
  withParent(session('b'), 'a'),
  withParent(session('c'), 'b')
])
assert.deepEqual(ids(deep), ['a'])
assert.deepEqual(ids(deep[0].children), ['b'])
assert.deepEqual(ids(deep[0].children[0].children), ['c'], 'children of children nest one level deeper')

// --- Skipped-level ancestor: the parentID chain may skip a level when the intermediate session
//     is absent (a fork-of-fork reports its original parent, opencode2-mappers.ts:59). The child
//     still attaches under the deepest present ancestor instead of floating at root. ---
const skipped = buildSessionTree([
  session('grandparent'),
  withParent(session('child'), 'grandparent')
])
assert.deepEqual(ids(skipped), ['grandparent'])
assert.deepEqual(ids(skipped[0].children), ['child'], 'a child whose chain skips an absent level nests under the present ancestor')

// --- Orphans: a parent missing from the list, or a self-parent, never drops the session. ---
const orphaned = buildSessionTree([
  withParent(session('missing-parent'), 'not-in-the-list'),
  session('root')
])
assert.deepEqual(ids(orphaned), ['missing-parent', 'root'], 'a child whose parent is absent renders at root level')
assert.deepEqual(orphaned[0].children, [])

const selfParented = buildSessionTree([withParent(session('self'), 'self')])
assert.deepEqual(ids(selfParented), ['self'], 'a self-parent renders at root level')
assert.deepEqual(selfParented[0].children, [])

// --- Cycle guard: A→B→A must not hang. The offender (the node that closes the loop) becomes a
//     root and the other member keeps its real parent link, so the pair renders as one chain.
//     The split is deterministic for a given input order; this pins the first processing order. ---
const cycle = buildSessionTree([
  withParent(session('a'), 'b'),
  withParent(session('b'), 'a')
])
assert.equal(cycle.length, 1, 'a two-session cycle must collapse to exactly one root')
assert.equal(cycle[0].session.id, 'b', 'the node that closes the loop renders as the root')
assert.deepEqual(ids(cycle[0].children), ['a'], 'the other cycle member keeps its real parent link')

// A three-session cycle A→B→C→A resolves the whole segment as a chain under the offender.
const cycle3 = buildSessionTree([
  withParent(session('a'), 'b'),
  withParent(session('b'), 'c'),
  withParent(session('c'), 'a')
])
assert.equal(cycle3.length, 1)
assert.equal(cycle3[0].session.id, 'c')
assert.deepEqual(ids(cycle3[0].children), ['b'])
assert.deepEqual(ids(cycle3[0].children[0].children), ['a'])

// A cycle with a legitimate child attached to one member: the child still nests under its own
// parent (inside the resolved chain), nothing drops and nothing double-renders.
const cycleWithChild = buildSessionTree([
  withParent(session('a'), 'b'),
  withParent(session('b'), 'a'),
  withParent(session('child'), 'a')
])
assert.deepEqual(ids(cycleWithChild), ['b'])
assert.deepEqual(ids(cycleWithChild[0].children), ['a'])
assert.deepEqual(ids(cycleWithChild[0].children[0].children), ['child'], 'a legit child of a cycle member nests under its own parent')

// --- Order preservation: parents keep their positions even when children precede them, and
//     siblings keep their relative order. ---
const outOfOrder = buildSessionTree([
  withParent(session('child-1'), 'parent'),
  session('first-root'),
  withParent(session('child-2'), 'parent'),
  session('parent'),
  session('second-root')
])
assert.deepEqual(ids(outOfOrder), ['first-root', 'parent', 'second-root'], 'roots keep their input positions')
assert.deepEqual(ids(outOfOrder[1].children), ['child-1', 'child-2'], 'children keep input order even when they precede their parent')

console.log('session-tree tests passed')
