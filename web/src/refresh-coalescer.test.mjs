import assert from 'node:assert/strict'
import { createRefreshCoalescer } from './refresh-coalescer.ts'

const deferred = () => {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// A macrotask drain (setTimeout(0)) lets every pending microtask settle — enough to observe the
// in-flight/trailing-rerun ordering without any fake timers.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// Same-key flood: one in-flight run + exactly one trailing rerun, in order.
// ---------------------------------------------------------------------------
{
  const coalescer = createRefreshCoalescer()
  const gate1 = deferred()
  const gate2 = deferred()
  const order = []
  let callIndex = 0
  const fn = async () => {
    const n = callIndex
    callIndex += 1
    order.push(`start-${n}`)
    await (n === 0 ? gate1.promise : gate2.promise)
    order.push(`end-${n}`)
  }
  const first = coalescer.run('a', fn)
  await tick()
  assert.deepEqual(order, ['start-0'], 'the first run must start immediately')

  coalescer.run('a', fn)
  coalescer.run('a', fn)
  coalescer.run('a', fn)
  await tick()
  assert.deepEqual(order, ['start-0'], 'a same-key flood must not start extra runs while one is in flight')

  gate1.resolve()
  await first
  await tick()
  assert.deepEqual(
    order,
    ['start-0', 'end-0', 'start-1'],
    'exactly one trailing rerun must run after the in-flight load completes'
  )

  gate2.resolve()
  await tick()
  await tick()
  assert.deepEqual(
    order,
    ['start-0', 'end-0', 'start-1', 'end-1'],
    'the single trailing rerun must complete and nothing else may run'
  )
}

// ---------------------------------------------------------------------------
// The trailing rerun never chains a third run, even when more calls land during it.
// ---------------------------------------------------------------------------
{
  const coalescer = createRefreshCoalescer()
  const gate1 = deferred()
  const gate2 = deferred()
  const order = []
  let callIndex = 0
  const fn = async () => {
    const n = callIndex
    callIndex += 1
    order.push(`start-${n}`)
    await (n === 0 ? gate1.promise : gate2.promise)
    order.push(`end-${n}`)
  }
  const first = coalescer.run('a', fn)
  await tick()
  coalescer.run('a', fn) // mark the single trailing rerun
  gate1.resolve()
  await first
  await tick()
  assert.deepEqual(order, ['start-0', 'end-0', 'start-1'], 'the marked rerun must start')

  // More same-key calls land WHILE the trailing rerun is in flight: they may re-mark it, but the
  // rerun's noFollowUp finally must never chain a third run — a continuous flood cannot become an
  // unbounded fetch loop.
  coalescer.run('a', fn)
  coalescer.run('a', fn)
  await tick()
  gate2.resolve()
  await tick()
  await tick()
  assert.deepEqual(
    order,
    ['start-0', 'end-0', 'start-1', 'end-1'],
    'calls landing during the trailing rerun must not produce a third run'
  )
}

// ---------------------------------------------------------------------------
// A different key always starts immediately (session/profile switches never wait on a stale load).
// ---------------------------------------------------------------------------
{
  const coalescer = createRefreshCoalescer()
  const counts = new Map()
  const gates = new Map()
  const fnFor = (key) => async () => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
    await gates.get(key).promise
  }
  const gateA = deferred()
  const gateB = deferred()
  gates.set('a', gateA)
  gates.set('b', gateB)

  const runA = coalescer.run('a', fnFor('a'))
  await tick()
  const runB = coalescer.run('b', fnFor('b'))
  await tick()
  assert.deepEqual(
    [...counts.entries()].sort(),
    [['a', 1], ['b', 1]],
    'a different key must start immediately while another load is in flight'
  )

  gateA.resolve()
  gateB.resolve()
  await Promise.all([runA, runB])
  await tick()
  assert.deepEqual(
    [...counts.entries()].sort(),
    [['a', 1], ['b', 1]],
    'the replaced in-flight run must not leak a rerun for the key a session switch left behind'
  )

  const gateC = deferred()
  gates.set('a', gateC)
  const runC = coalescer.run('a', fnFor('a'))
  await tick()
  assert.equal(counts.get('a'), 2, 'a run after completion must start fresh (the slot must be free)')
  gateC.resolve()
  await runC
}

// ---------------------------------------------------------------------------
// A throwing fn must not leave a stale slot or an unhandled rejection.
// ---------------------------------------------------------------------------
{
  const coalescer = createRefreshCoalescer()
  let fail = true
  let calls = 0
  const fn = async () => {
    calls += 1
    if (fail) throw new Error('boom')
  }
  const first = coalescer.run('a', fn)
  coalescer.run('a', fn) // flood during the failing run: marks exactly ONE rerun (synchronous)
  // Attach the rejection handler immediately so the earliest rejection can never be unhandled.
  const rejection = assert.rejects(first, /boom/, 'the caller of the failing run must observe the rejection')
  await tick()
  assert.equal(calls, 2, 'the marked rerun must still run after the first run throws')
  // The rerun's own throw must be swallowed internally — an unhandled rejection would crash this
  // process — and the slot must be free for a later run.
  fail = false
  await coalescer.run('a', fn)
  assert.equal(calls, 3, 'a later run must start fresh once the failed run cleared the slot')
  await rejection
}

console.log('refresh coalescer tests passed')