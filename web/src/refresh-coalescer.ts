/**
 * At-most-one-in-flight refresh coalescer with a single trailing rerun.
 *
 * The v2 SSE global stream floods a long-running session with `session.*` events (every streamed
 * part, every child subagent session's events), and a long-transcript reload takes seconds. Each
 * event used to call the eager loadSelected, whose request-id bump aborted the in-flight load — so
 * no reload ever completed while the flood lasted and the transcript stayed empty until the flood
 * stopped. This coalescer serializes the EVENT-driven reloads instead (explicit callers keep the
 * eager loadSelected): one in-flight run per key, and at most one trailing rerun to pick up
 * whatever changed while the in-flight run was executing.
 */
export type RefreshCoalescer = {
  /** If a run for the same `key` is in flight, mark it for ONE follow-up and return without
   *  starting anything; otherwise start `fn` immediately. A different `key` always starts
   *  immediately (a session/profile switch must never wait on a stale heavy load). When the
   *  in-flight run finishes it runs exactly one follow-up (same key) if it was marked — the
   *  follow-up never chains another, so a continuous event flood cannot become an unbounded
   *  fetch loop; the caller's own poll keeps the cadence afterwards. */
  run(key: string, fn: () => Promise<void>): Promise<void>
}

export function createRefreshCoalescer(): RefreshCoalescer {
  let generation = 0
  let slot: { key: string; generation: number; rerun: boolean } | null = null

  const run = (key: string, fn: () => Promise<void>, noFollowUp = false): Promise<void> => {
    if (!noFollowUp && slot !== null && slot.key === key) {
      // Same key already in flight: coalesce into exactly one follow-up and return without
      // starting anything. The follow-up runs in the in-flight run's finally below.
      slot.rerun = true
      return Promise.resolve()
    }
    // Fresh key (or no run in flight, or an internal no-follow-up rerun): start immediately and
    // take the slot for this generation. A different key REPLACES the slot, so the replaced run's
    // finally (below) sees a different generation and does nothing.
    const myGeneration = ++generation
    slot = { key, generation: myGeneration, rerun: false }
    const owned = (async () => {
      try {
        await fn()
      } finally {
        if (slot === null || slot.generation !== myGeneration) return
        const { rerun } = slot
        slot = null
        if (rerun && !noFollowUp) {
          // Exactly ONE trailing rerun for the flood that landed while we were in flight. It is
          // started with the internal noFollowUp flag so its own finally can never chain another:
          // a continuous flood therefore cannot become an unbounded fetch loop — the caller's own
          // poll keeps the cadence afterwards.
          void run(key, fn, true).catch(() => undefined)
        }
      }
    })()
    return owned
  }

  return { run }
}