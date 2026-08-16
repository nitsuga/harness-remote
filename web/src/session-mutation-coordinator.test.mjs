import assert from 'node:assert/strict'
import {
  MUTATION_KINDS,
  createSessionMutationCoordinator
} from './session-mutation-coordinator.ts'

const ctx = (sessionID = 'session-1') => ({
  profileID: 'profile-1',
  configKey: 'opencode-2',
  sessionID
})

// ---------------------------------------------------------------------------
// Same-tick exclusion: only one lease may be active, for any kind.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx())
  const first = coordinator.acquireLease('prompt')
  assert.ok(first, 'the first lease in a tick must be granted')
  assert.equal(coordinator.getActiveLease(), first, 'the granted lease must be the active one')

  for (const kind of MUTATION_KINDS) {
    assert.equal(
      coordinator.acquireLease(kind),
      null,
      `a second lease (${kind}) in the same tick must be refused while one is active`
    )
  }

  assert.equal(coordinator.acquireLease('prompt'), null, 'the same kind is also exclusive')
  // Pin the newest kinds explicitly (the loop above already iterates MUTATION_KINDS, so these are
  // redundant by construction — they keep the expectation visible and break loudly if a kind is
  // ever dropped from the taxonomy).
  assert.equal(coordinator.acquireLease('model'), null, 'a second lease (model) in the same tick must be refused while one is active')
  assert.equal(coordinator.acquireLease('agent'), null, 'a second lease (agent) in the same tick must be refused while one is active')
  assert.equal(coordinator.releaseLease(first), true, 'releasing the active lease must succeed')
  assert.equal(coordinator.getActiveLease(), null, 'no lease may remain active after release')

  assert.ok(
    coordinator.acquireLease('command'),
    'a lease taken after release in the same tick must be granted'
  )
}

// ---------------------------------------------------------------------------
// Monotonically unique lease ids.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx())
  const seen = new Set()
  let previousID = 0
  for (const kind of MUTATION_KINDS) {
    const lease = coordinator.acquireLease(kind)
    assert.ok(lease, `a lease must be granted for ${kind}`)
    assert.ok(lease.id > previousID, 'lease ids must increase monotonically')
    assert.ok(!seen.has(lease.id), `lease id ${lease.id} must be unique`)
    seen.add(lease.id)
    previousID = lease.id
    coordinator.releaseLease(lease)
  }
}

// ---------------------------------------------------------------------------
// Context replacement invalidates results but retains the exclusive lock: a
// stale lease still blocks new acquisitions until its physical owner releases.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx('session-1'))
  const before = coordinator.getContextGeneration()
  const oldLease = coordinator.acquireLease('prompt')
  assert.ok(oldLease, 'a lease must be granted under the first context')
  assert.equal(
    oldLease.contextGeneration,
    before,
    'the lease must snapshot the context generation it was acquired under'
  )

  coordinator.replaceContext(ctx('session-2'))

  assert.equal(coordinator.getContextGeneration(), before + 1, 'replaceContext must bump the generation')

  // The result of the in-flight work is invalidated: it can never pass the currency checks.
  assert.equal(
    coordinator.isContextGenerationCurrent(oldLease.contextGeneration),
    false,
    'the old context generation must be stale after replacement — completion is invalidated'
  )
  assert.equal(
    coordinator.isContextCurrent(oldLease.context),
    false,
    'the context the lease started under must no longer be current'
  )
  assert.equal(
    coordinator.isContextCurrent(ctx('session-1')),
    false,
    'the replaced context must no longer be current'
  )
  assert.equal(
    coordinator.isContextCurrent(ctx('session-2')),
    true,
    'the new context must be current'
  )
  assert.deepEqual(coordinator.getContext(), ctx('session-2'), 'getContext must return the new context')

  // ...but the lock is retained: the lease stays exclusive until its physical owner releases.
  assert.equal(
    coordinator.getActiveLease(),
    oldLease,
    'replaceContext must NOT clear the active lease — the lock stays with its physical owner'
  )
  assert.equal(
    coordinator.isLeaseCurrent(oldLease),
    true,
    'the stale lease is still the active lease, so its owner can release it'
  )
  assert.equal(
    coordinator.acquireLease('rename'),
    null,
    'a context switch must refuse a new lease while the stale lease is still in flight'
  )

  // The delayed work completes and its owner releases — only now may the new context acquire.
  assert.equal(
    coordinator.releaseLease(oldLease),
    true,
    'the physical owner must be able to release the stale lease'
  )
  assert.equal(coordinator.getActiveLease(), null, 'no lease may remain once the owner released')

  const newLease = coordinator.acquireLease('rename')
  assert.ok(newLease, 'a lease must be granted in the new context once the stale lease released')
  assert.equal(
    newLease.contextGeneration,
    before + 1,
    'the new lease must snapshot the new context generation'
  )
  assert.equal(
    coordinator.isContextGenerationCurrent(newLease.contextGeneration),
    true,
    'the new lease must be current in the new context'
  )

  // Stale-release safety holds across the context boundary: re-releasing the old lease can never
  // clear the newer one.
  assert.equal(
    coordinator.releaseLease(oldLease),
    false,
    'releasing the already-released old lease must fail'
  )
  assert.equal(
    coordinator.getActiveLease(),
    newLease,
    'a stale release must not clear the newer lease'
  )
  assert.equal(coordinator.isLeaseCurrent(newLease), true, 'the newer lease must remain current')
  assert.equal(coordinator.releaseLease(newLease), true, 'the newer lease must still release cleanly')
}

// ---------------------------------------------------------------------------
// Fork generation invalidates delayed work that straddles a fork.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx())
  const beforeFork = coordinator.getForkGeneration()

  // Delayed work starts (captures the generation), then a fork happens and completes.
  const delayedWorkGeneration = beforeFork
  assert.equal(
    coordinator.isForkGenerationCurrent(delayedWorkGeneration),
    true,
    'the generation must be current before any fork'
  )

  const forkLease = coordinator.acquireLease('fork')
  assert.ok(forkLease, 'the fork lease must be granted')
  assert.equal(
    coordinator.getForkGeneration(),
    beforeFork + 1,
    'acquiring a fork lease must bump the fork generation'
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(delayedWorkGeneration),
    false,
    'pre-fork delayed work must already be stale once the fork starts'
  )

  assert.equal(coordinator.releaseLease(forkLease), true, 'the fork lease must release')
  assert.equal(
    coordinator.getForkGeneration(),
    beforeFork + 2,
    'releasing a fork lease must bump the fork generation again'
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(delayedWorkGeneration),
    false,
    'delayed work captured before the fork must be stale after the fork releases'
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(forkLease.forkGeneration),
    false,
    'work captured inside the fork must also be stale after the fork releases'
  )

  const afterFork = coordinator.getForkGeneration()
  assert.equal(
    coordinator.isForkGenerationCurrent(afterFork),
    true,
    'the post-fork generation must be current'
  )

  // Non-fork mutations must not touch the fork generation.
  const promptLease = coordinator.acquireLease('prompt')
  assert.ok(promptLease, 'a prompt lease must be granted')
  assert.equal(coordinator.getForkGeneration(), afterFork, 'non-fork acquisition must not bump the fork generation')
  assert.equal(
    promptLease.forkGeneration,
    afterFork,
    'a non-fork lease must snapshot the current fork generation'
  )
  assert.equal(coordinator.releaseLease(promptLease), true, 'the prompt lease must release')
  assert.equal(
    coordinator.getForkGeneration(),
    afterFork,
    'releasing a non-fork lease must not bump the fork generation'
  )

  // A context switch does not change fork semantics: the fork lease is retained across the switch,
  // still blocks new acquisitions, and releasing it (the fork physically completed) still bumps the
  // fork generation.
  const navForkLease = coordinator.acquireLease('fork')
  assert.ok(navForkLease, 'a fork lease must be granted')
  const forkGenerationAtSwitch = coordinator.getForkGeneration()
  coordinator.replaceContext(ctx('session-2'))
  assert.equal(
    coordinator.getActiveLease(),
    navForkLease,
    'the fork lease must be retained across a context switch'
  )
  assert.equal(
    coordinator.acquireLease('prompt'),
    null,
    'navigation must not let a prompt start while the stale fork is still in flight'
  )
  assert.equal(
    coordinator.releaseLease(navForkLease),
    true,
    'the stale fork lease must release when the fork physically completes'
  )
  assert.equal(
    coordinator.getForkGeneration(),
    forkGenerationAtSwitch + 1,
    'releasing a stale fork lease must still bump the fork generation'
  )
}

// ---------------------------------------------------------------------------
// A fork lease snapshots the POST-acquisition fork generation: the fork's own
// work passes context/fork currency while it is in flight, and releasing the
// fork invalidates both the pre-fork generation and the fork's own snapshot.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx('session-1'))
  const beforeFork = coordinator.getForkGeneration()
  const contextGenerationAtAcquisition = coordinator.getContextGeneration()

  // Prior work starts before the fork and captures the then-current generation.
  const delayedPreFork = coordinator.acquireLease('prompt')
  assert.ok(delayedPreFork, 'a pre-fork prompt lease must be granted')
  assert.equal(
    delayedPreFork.forkGeneration,
    beforeFork,
    'pre-fork work must capture the generation before any fork'
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(delayedPreFork.forkGeneration),
    true,
    'pre-fork work must be current while no fork exists'
  )
  assert.equal(coordinator.releaseLease(delayedPreFork), true, 'the pre-fork lease must release')

  const forkLease = coordinator.acquireLease('fork')
  assert.ok(forkLease, 'the fork lease must be granted')
  assert.equal(
    forkLease.forkGeneration,
    beforeFork + 1,
    'the fork lease must snapshot the post-acquisition fork generation'
  )

  // Immediately after acquisition the fork's own work is fully current.
  assert.equal(
    coordinator.isForkGenerationCurrent(forkLease.forkGeneration),
    true,
    'a current fork lease must pass fork currency right after acquisition'
  )
  assert.equal(
    forkLease.contextGeneration,
    contextGenerationAtAcquisition,
    'the fork lease must snapshot the context generation at acquisition'
  )
  assert.equal(
    coordinator.isContextGenerationCurrent(forkLease.contextGeneration),
    true,
    'a current fork lease must pass context-generation currency right after acquisition'
  )
  assert.equal(
    coordinator.isContextCurrent(forkLease.context),
    true,
    'a current fork lease must pass context currency right after acquisition'
  )
  assert.equal(
    coordinator.isLeaseCurrent(forkLease),
    true,
    'the fork lease must remain the active lease while in flight'
  )

  // ...while work that captured the generation before the fork is already invalidated.
  assert.equal(
    coordinator.isForkGenerationCurrent(beforeFork),
    false,
    'pre-fork work must be invalidated the moment the fork starts'
  )

  // Releasing the fork invalidates the fork's own snapshot as well: work captured during the fork
  // (including the fork's own completion checks) is stale once the fork has finished.
  assert.equal(coordinator.releaseLease(forkLease), true, 'the fork lease must release')
  assert.equal(
    coordinator.getForkGeneration(),
    beforeFork + 2,
    'releasing the fork lease must bump the fork generation again'
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(forkLease.forkGeneration),
    false,
    "releasing the fork must invalidate the fork lease's own snapshot — work captured during the fork is stale"
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(delayedPreFork.forkGeneration),
    false,
    'releasing the fork must keep pre-fork work stale'
  )
  assert.equal(
    coordinator.isForkGenerationCurrent(coordinator.getForkGeneration()),
    true,
    'the post-fork generation must be current'
  )
}

// ---------------------------------------------------------------------------
// Stale release safety: releasing an old lease can never clear a newer one.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx())
  const first = coordinator.acquireLease('prompt')
  assert.ok(first, 'first lease must be granted')
  coordinator.releaseLease(first)

  const second = coordinator.acquireLease('compact')
  assert.ok(second, 'second lease must be granted after the first released')
  assert.ok(second.id > first.id, 'the second lease must carry a newer id')

  assert.equal(
    coordinator.releaseLease(first),
    false,
    'releasing the already-released first lease must fail'
  )
  assert.equal(
    coordinator.getActiveLease(),
    second,
    'a stale release must not clear the newer lease'
  )
  assert.equal(coordinator.isLeaseCurrent(second), true, 'the newer lease must remain current')
  assert.equal(coordinator.isLeaseCurrent(first), false, 'the released lease must not be current')

  assert.equal(
    coordinator.releaseLease(first),
    false,
    'releasing an unknown/inactive lease must fail without side effects'
  )
  assert.equal(coordinator.getActiveLease(), second, 'repeated stale releases must be harmless')

  assert.equal(coordinator.releaseLease(second), true, 'the active lease must release')
  assert.equal(
    coordinator.releaseLease(second),
    false,
    'releasing an already-released active lease must fail'
  )
  assert.equal(coordinator.getActiveLease(), null, 'no lease may remain after the final release')
}

// ---------------------------------------------------------------------------
// Guards: no lease without a context, and no lease with a null target except
// `create` (which itself still waits for a context to exist).
// ---------------------------------------------------------------------------
{
  const empty = createSessionMutationCoordinator()
  assert.equal(empty.getContext(), null, 'a fresh coordinator must have no context')
  assert.equal(empty.acquireLease('prompt'), null, 'no lease may be granted before any context')
  assert.equal(empty.acquireLease('create'), null, 'not even create: a context must exist first')
  assert.equal(empty.acquireLease('create', null), null, 'an explicit null target still needs a context')

  const sessionless = createSessionMutationCoordinator(ctx(null))
  assert.equal(
    sessionless.acquireLease('fork'),
    null,
    'no non-create lease may target a null session'
  )
  assert.equal(sessionless.getActiveLease(), null, 'no lease may be active without a session target')
  assert.equal(
    sessionless.isContextCurrent(ctx(null)),
    true,
    'a null-session context is still the current context'
  )
}

// ---------------------------------------------------------------------------
// First-session create: a lease must be grantable while the context has no
// session yet — `create` is the one mutation that may target null.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx(null))
  assert.equal(coordinator.getContext().sessionID, null, 'the context must start sessionless')

  const createLease = coordinator.acquireLease('create')
  assert.ok(createLease, 'create must be granted while the context has no session')
  assert.equal(createLease.targetSessionID, null, 'the create lease must target null (no session exists yet)')
  assert.equal(createLease.context.sessionID, null, 'the create lease must snapshot the sessionless context')
  assert.equal(coordinator.getActiveLease(), createLease, 'the create lease must be the active one')

  assert.equal(
    coordinator.acquireLease('create'),
    null,
    'exclusivity holds in the sessionless state: a second create is refused'
  )
  assert.equal(
    coordinator.acquireLease('prompt', 'session-9'),
    null,
    'exclusivity holds across targets: a targeted lease is refused while create is active'
  )

  assert.equal(coordinator.releaseLease(createLease), true, 'the create lease must release')
  assert.equal(coordinator.getActiveLease(), null, 'no lease may remain after the create releases')

  // The sessionless context does not license null targets for anything but create.
  assert.equal(
    coordinator.acquireLease('prompt'),
    null,
    'non-create kinds still need a real session target, explicit or from context'
  )
  const targetedDelete = coordinator.acquireLease('delete', 'session-9')
  assert.ok(targetedDelete, 'a targeted lease must be grantable from a sessionless context')
  assert.equal(targetedDelete.targetSessionID, 'session-9', 'the explicit target must be pinned on the lease')
  assert.equal(coordinator.releaseLease(targetedDelete), true, 'the targeted lease must release')
}

// ---------------------------------------------------------------------------
// Targeted leases: rename/delete of a session that is NOT the one in context,
// via explicit target, without changing the active navigation context.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx('session-1'))

  const renameLease = coordinator.acquireLease('rename', 'session-9')
  assert.ok(renameLease, 'a rename lease with an explicit target must be granted')
  assert.equal(renameLease.targetSessionID, 'session-9', 'the lease must pin the targeted session')
  assert.equal(renameLease.context.sessionID, 'session-1', 'the lease must snapshot the active navigation context')
  assert.deepEqual(
    coordinator.getContext(),
    ctx('session-1'),
    'an explicit target must not change the active context'
  )
  assert.equal(
    coordinator.isContextCurrent(ctx('session-1')),
    true,
    'the active context must remain current during a targeted lease'
  )

  assert.equal(
    coordinator.acquireLease('delete', 'session-9'),
    null,
    'targeted leases are exclusive like any other lease'
  )

  assert.equal(coordinator.releaseLease(renameLease), true, 'the targeted rename lease must release')

  const deleteLease = coordinator.acquireLease('delete', 'session-9')
  assert.ok(deleteLease, 'a delete lease with an explicit target must be granted after release')
  assert.equal(deleteLease.targetSessionID, 'session-9', 'the delete lease must pin the targeted session')
  assert.equal(coordinator.releaseLease(deleteLease), true, 'the targeted delete lease must release')

  // The active session is still the default target when none is given.
  const defaultLease = coordinator.acquireLease('prompt')
  assert.ok(defaultLease, 'a lease without an explicit target must be granted')
  assert.equal(
    defaultLease.targetSessionID,
    'session-1',
    'the target must default to the active context session'
  )
  assert.equal(coordinator.releaseLease(defaultLease), true, 'the default-target lease must release')
}

// ---------------------------------------------------------------------------
// Stale-release/context behavior for targeted leases: a targeted lease is
// retained across navigation (results invalidated, lock held), blocks new
// acquisitions until released, and a stale release can never clear a newer
// lease.
// ---------------------------------------------------------------------------
{
  const coordinator = createSessionMutationCoordinator(ctx('session-1'))
  const targeted = coordinator.acquireLease('rename', 'session-9')
  assert.ok(targeted, 'the targeted rename lease must be granted')
  const targetedGeneration = coordinator.getContextGeneration()

  coordinator.replaceContext(ctx('session-2'))

  assert.equal(
    coordinator.getContextGeneration(),
    targetedGeneration + 1,
    'replaceContext must bump the generation even while a targeted lease is held'
  )
  assert.equal(
    coordinator.isContextGenerationCurrent(targeted.contextGeneration),
    false,
    'the generation snapshot of the targeted lease must be stale — its result is invalidated'
  )
  assert.equal(
    coordinator.getActiveLease(),
    targeted,
    'replaceContext must retain the targeted lease — the lock is held until its owner releases'
  )
  assert.equal(
    coordinator.isLeaseCurrent(targeted),
    true,
    'the targeted lease must still be the active lease'
  )
  assert.equal(
    coordinator.acquireLease('delete'),
    null,
    'a new lease must be refused while the stale targeted lease is still in flight'
  )

  assert.equal(
    coordinator.releaseLease(targeted),
    true,
    'the stale targeted lease must release when its physical owner finishes'
  )
  const next = coordinator.acquireLease('delete')
  assert.ok(next, 'a lease must be granted in the new context after the targeted lease released')
  assert.equal(
    coordinator.releaseLease(targeted),
    false,
    'releasing the stale targeted lease again must fail'
  )
  assert.equal(
    coordinator.getActiveLease(),
    next,
    'a stale targeted release must not clear the newer lease'
  )
  assert.equal(coordinator.isLeaseCurrent(next), true, 'the newer lease must remain current')
  assert.equal(coordinator.releaseLease(next), true, 'the newer lease must still release cleanly')
}

console.log('session mutation coordinator tests passed')
