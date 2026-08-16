/**
 * Session mutation coordinator — pure, dependency-free concurrency primitive.
 *
 * The React layer (App.tsx and friends) drives every session mutation — prompts, forks, compacts,
 * renames, permission answers, ... — through this coordinator so that at most one mutation is in
 * flight per active session at a time, and so that results that arrive after the world has moved on
 * (context replaced, a fork started and finished, a newer lease taken over) are provably stale and
 * can be dropped instead of applied to the wrong session.
 *
 * Everything here is SYNCHRONOUS and side-effect free: there are no promises, timers, or I/O. The
 * caller owns the async work; the coordinator only answers "may I start?", "is what I finished still
 * current?", and "may I let go?".
 *
 * Mental model for the React caller:
 *
 *   const coordinator = createSessionMutationCoordinator()
 *
 *   // Whenever the app's notion of "which session am I looking at" changes (profile switch, session
 *   // switch, session created/deleted), call this BEFORE doing anything else:
 *   coordinator.replaceContext({ profileID, configKey, sessionID })
 *
 *   // Before starting a mutation:
 *   const lease = coordinator.acquireLease('prompt')
 *   if (!lease) return            // another mutation is already in flight — do not start
 *   try {
 *     await submitPrompt(lease.targetSessionID, text)
 *     if (!coordinator.isLeaseCurrent(lease)) return              // lease superseded — stop
 *     if (!coordinator.isContextGenerationCurrent(lease.contextGeneration)) return // context replaced meanwhile
 *     if (!coordinator.isForkGenerationCurrent(lease.forkGeneration)) return // a fork happened
 *     applyResult(...)                                            // safe to touch the UI
 *   } finally {
 *     // ALWAYS release, even when a check above bailed: a stale lease still holds the exclusive
 *     // lock until its physical owner lets go, and releasing a non-active lease is a safe no-op.
 *     coordinator.releaseLease(lease)
 *   }
 *
 *   // First session: no session is open yet (context.sessionID is null), but creating one is the
 *   // one mutation that may target null:
 *   const createLease = coordinator.acquireLease('create')
 *   if (!createLease) return
 *   try {
 *     const session = await apiCreateSession()
 *     if (!coordinator.isLeaseCurrent(createLease)) return
 *     if (!coordinator.isContextGenerationCurrent(createLease.contextGeneration)) return
 *     coordinator.releaseLease(createLease)   // free the lock BEFORE switching the context
 *     coordinator.replaceContext({ profileID, configKey, sessionID: session.id })
 *   } finally {
 *     coordinator.releaseLease(createLease)   // safe even if it was already released above
 *   }
 *
 *   // Targeted mutation: rename or delete a session from the list that is not the one currently
 *   // open, without switching the active navigation context:
 *   const renameLease = coordinator.acquireLease('rename', unselectedSessionID)
 *   if (!renameLease) return
 *   try {
 *     await apiRenameSession(unselectedSessionID, ...)
 *     if (!coordinator.isLeaseCurrent(renameLease)) return
 *     if (!coordinator.isContextGenerationCurrent(renameLease.contextGeneration)) return
 *     refreshSessionList()
 *   } finally {
 *     coordinator.releaseLease(renameLease)
 *   }
 *
 * Guarantees:
 *  - Exclusive leases: `acquireLease` succeeds only when no lease is active, regardless of target.
 *    Lease ids are monotonically unique for the lifetime of the coordinator. A context switch never
 *    lifts exclusivity: a stale lease whose owner has not released yet still blocks every new
 *    acquisition, even though its results are already invalid.
 *  - Targeted leases: `acquireLease` takes an optional `targetSessionID` that defaults to the active
 *    context's session. A lease may target a session other than the one in context (rename/delete
 *    from the list) without changing the context. The only lease allowed to target `null` is
 *    `create` — which is how the very first session is made. The resolved target is snapshotted on
 *    the lease as `targetSessionID`.
 *  - Context generation: every `replaceContext` call bumps the generation, so work started under an
 *    older context can never pass the `isContextGenerationCurrent`/`isContextCurrent` checks and can
 *    never be mistaken for current — delayed results are dropped at the caller's completion checks.
 *    The active lease itself is deliberately NOT cleared by a context switch: it stays exclusive
 *    until its physical async owner calls `releaseLease`, so navigation blocks the next mutation
 *    instead of letting a second one start underneath the in-flight request.
 *  - Fork generation: bumped when a `fork` lease is acquired and again when it is released. A `fork`
 *    lease snapshots the post-acquisition generation, so its own completion checks pass while the
 *    fork is in flight; once the fork is released, that snapshot is stale too. Any work that captured
 *    a fork generation before or during a fork is stale once the fork is released — this is what
 *    stops delayed pre-fork results from landing after a fork completed.
 *  - Stale-release safety: `releaseLease` only ever clears the lease it is handed if that lease is
 *    still the active one. Releasing an old or invalidated lease is a no-op that returns false and
 *    can never clear a newer lease.
 */

/** The 15 mutation kinds the coordinator arbitrates. */
export const MUTATION_KINDS = [
  "fork",
  "prompt",
  "command",
  "skill",
  "history",
  "compact",
  "rename",
  "delete",
  "abort",
  "question",
  "permission",
  "inbox",
  "create",
  "model",
  "agent"
] as const

export type MutationKind = (typeof MUTATION_KINDS)[number]

/** Which profile/config/session a mutation is running against. `sessionID` is null when no session is open. */
export interface CoordinatorContext {
  profileID: string
  configKey: string
  sessionID: string | null
}

/**
 * A granted mutation lease. The fields snapshot the state at acquisition time so the caller can
 * validate, at completion time, that nothing it depends on has moved:
 *  - `contextGeneration`/`forkGeneration` feed `isContextGenerationCurrent`/`isForkGenerationCurrent`.
 *    A `fork` lease snapshots the post-acquisition fork generation (the bump happens before the
 *    snapshot), so the fork's own work is current while it is in flight.
 *  - `context` is the context the mutation started under (e.g. to gate the network call itself).
 *  - `targetSessionID` is the session the mutation acts on: it defaults to `context.sessionID`, is
 *    `null` only for a `create` lease (no session exists yet), and differs from `context.sessionID`
 *    when the mutation acts on a session other than the one currently open.
 */
export interface MutationLease {
  id: number
  kind: MutationKind
  context: CoordinatorContext
  targetSessionID: string | null
  contextGeneration: number
  forkGeneration: number
}

export interface SessionMutationCoordinator {
  /** The current context, or null if `replaceContext` has never been called. */
  getContext(): CoordinatorContext | null

  /**
   * Synchronously replace the current context. Bumps the context generation, which invalidates the
   * completion of any in-flight work: `isContextGenerationCurrent`/`isContextCurrent` go false for
   * anything started under the previous context, so delayed results must be dropped before touching
   * the UI. The active lease is deliberately NOT cleared: the exclusive lock belongs to the physical
   * async owner until it calls `releaseLease`, and a context switch must not let a second mutation
   * start underneath it — `acquireLease` keeps returning null until the stale owner releases. Call
   * this on every profile/session switch, and only when the context actually changes — the
   * replacement is unconditional, so calling it with the same context also invalidates in-flight
   * work.
   */
  replaceContext(context: CoordinatorContext): void

  /** True when `context` deep-equals the current context. */
  isContextCurrent(context: CoordinatorContext): boolean

  /** Monotonic counter bumped by every `replaceContext` call. */
  getContextGeneration(): number

  /**
   * Monotonic counter bumped when a `fork` lease is acquired and again when it is released. A `fork`
   * lease snapshots the post-acquisition value (the bump happens before the snapshot), so the fork's
   * own completion checks pass while it is in flight. A value captured before or during a fork is
   * stale once the fork has been released.
   */
  getForkGeneration(): number

  /** True when `generation` is the current fork generation (i.e. no fork has started AND finished since). */
  isForkGenerationCurrent(generation: number): boolean

  /**
   * Try to take the exclusive mutation lease for `kind`, targeting `targetSessionID` (defaults to
   * the active context's session). Returns a lease, or null when a lease is already active (any
   * target — including a stale lease whose context was replaced but whose owner has not released
   * yet), when no context is set, or when the effective target is null and `kind` is not `create`.
   * A targeted lease never changes the context — the active navigation context stays as it is, and
   * the resolved target is snapshotted on the lease as `targetSessionID`. Acquiring a `fork` lease
   * bumps the fork generation immediately and snapshots the bumped (post-acquisition) value on the
   * lease, so the fork's own work is current while it is in flight. Does not throw.
   */
  acquireLease(kind: MutationKind, targetSessionID?: string | null): MutationLease | null

  /**
   * Release `lease` if and only if it is still the active lease. Returns true when the lease was
   * actually released, false for a stale or unknown lease — a stale release never clears a newer
   * lease and never bumps the fork generation. Releasing a `fork` lease bumps the fork generation.
   * A context switch does not prevent a release: the physical owner of a stale lease still holds
   * the lock until it calls this, and releasing is the only way the next mutation can acquire.
   */
  releaseLease(lease: MutationLease): boolean

  /** The currently active lease, or null when none is held. */
  getActiveLease(): MutationLease | null

  /**
   * True when `lease` is still the active lease — i.e. its physical async owner is still in flight
   * and still holds the exclusive lock. This is an OWNERSHIP check, not a currency check: after
   * `replaceContext` the lease stays "current" here (so the owner's `releaseLease` still works and
   * the lock can be freed) even though its context generation is stale. Before applying a result,
   * additionally check `isContextGenerationCurrent(lease.contextGeneration)` and
   * `isContextCurrent(lease.context)`.
   */
  isLeaseCurrent(lease: MutationLease): boolean

  /** True when `generation` is the current context generation. */
  isContextGenerationCurrent(generation: number): boolean
}

function sameContext(a: CoordinatorContext, b: CoordinatorContext): boolean {
  return a.profileID === b.profileID && a.configKey === b.configKey && a.sessionID === b.sessionID
}

export function createSessionMutationCoordinator(
  initialContext?: CoordinatorContext
): SessionMutationCoordinator {
  let context: CoordinatorContext | null = initialContext ?? null
  let contextGeneration = 0
  let forkGeneration = 0
  let nextLeaseID = 1
  let activeLease: MutationLease | null = null

  return {
    getContext() {
      return context
    },

    replaceContext(nextContext: CoordinatorContext) {
      context = nextContext
      contextGeneration += 1
      // Deliberately NOT clearing activeLease: the exclusive lock belongs to the physical async
      // owner until it calls releaseLease. Clearing it here would let a second mutation start
      // while the first is still in flight. The generation bump above is what invalidates the
      // old work's completion: isContextGenerationCurrent(oldLease.contextGeneration) is now false.
    },

    isContextCurrent(candidate: CoordinatorContext) {
      return context !== null && sameContext(candidate, context)
    },

    getContextGeneration() {
      return contextGeneration
    },

    isContextGenerationCurrent(generation: number) {
      return generation === contextGeneration
    },

    getForkGeneration() {
      return forkGeneration
    },

    isForkGenerationCurrent(generation: number) {
      return generation === forkGeneration
    },

    acquireLease(kind: MutationKind, targetSessionID?: string | null) {
      if (activeLease !== null) return null
      if (context === null) return null
      const target = targetSessionID === undefined ? context.sessionID : targetSessionID
      if (target === null && kind !== "create") return null
      // A `fork` lease bumps the fork generation BEFORE the snapshot: the returned lease carries the
      // post-acquisition generation, so the fork's own completion checks pass while it is in flight —
      // only a later fork, or this fork's own release, invalidates it. Work that captured the
      // pre-bump generation is stale the moment the fork starts.
      if (kind === "fork") forkGeneration += 1
      const lease: MutationLease = {
        id: nextLeaseID,
        kind,
        context,
        targetSessionID: target,
        contextGeneration,
        forkGeneration
      }
      nextLeaseID += 1
      activeLease = lease
      return lease
    },

    releaseLease(lease: MutationLease) {
      if (activeLease === null || activeLease.id !== lease.id) return false
      const released = activeLease
      activeLease = null
      if (released.kind === "fork") forkGeneration += 1
      return true
    },

    getActiveLease() {
      return activeLease
    },

    isLeaseCurrent(lease: MutationLease) {
      return activeLease !== null && activeLease.id === lease.id
    }
  }
}
