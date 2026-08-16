import type { SessionView } from "./types"

/** One node of the session tree: a session plus its child sessions, recursively. */
export type SessionTreeNode = {
  session: SessionView
  children: SessionTreeNode[]
}

/** Read a session view's `parentID`. The v2 mapper attaches it non-enumerably (see App.tsx
 *  `toSessionView`), so it must be read through the cast — a plain field read would always
 *  come back `undefined`. Shared by the tree builder and the list component. */
export function readParentID(session: SessionView): string | undefined {
  return (session as SessionView & { parentID?: string }).parentID
}

/**
 * Restructure a flat session list into a tree of sessions with children nested under their
 * parents, ready for recursive rendering.
 *
 * - A session attaches under its parent whenever the parent is present in the list. The chain
 *   itself may skip levels (a fork-of-fork reports its original parent directly, so the
 *   intermediate fork can be absent from the list); the helper trusts the named parent.
 * - When the direct parent is absent (filtered out by a query, or outside the current list),
 *   the session renders at root level — it is never dropped. This is what keeps search results
 *   usable: a child whose parent did not match the query still shows, as a root row.
 * - A `parentID` that points at itself renders at root.
 * - A `parentID` chain that loops (A→B→A) is broken by treating the node that closes the loop
 *   as a root; every other member of the loop keeps its real parent link, so the segment renders
 *   as a plain chain. The build never hangs and every session is emitted exactly once.
 * - Input order is preserved at every level: roots keep their positions, and children keep their
 *   relative order under the parent — even when a child appears before its parent in the input.
 */
export function buildSessionTree(sessions: SessionView[]): SessionTreeNode[] {
  const nodesById = new Map<string, SessionTreeNode>()
  for (const session of sessions) {
    if (!nodesById.has(session.id)) nodesById.set(session.id, { session, children: [] })
  }

  const roots: SessionTreeNode[] = []
  const placed = new Set<string>()

  const attach = (childID: string, parentID: string): void => {
    nodesById.get(parentID)!.children.push(nodesById.get(childID)!)
    placed.add(childID)
  }

  for (const session of sessions) {
    if (placed.has(session.id)) continue

    // Walk up through unplaced, present ancestors to detect a parent chain that loops. A walk
    // stops at the first placed node (its chain is already resolved) or at a missing/self parent.
    const chain: string[] = [session.id]
    const inChain = new Set([session.id])
    let cursor = session.id
    let cycle = false
    while (true) {
      const parent = readParentID(nodesById.get(cursor)!.session)
      if (!parent || !nodesById.has(parent) || parent === cursor) break
      if (inChain.has(parent)) {
        cycle = true
        break
      }
      if (placed.has(parent)) break
      cursor = parent
      chain.push(parent)
      inChain.add(parent)
    }

    if (cycle) {
      // The loop closes at the last chain member (its parentID points back into the chain).
      // Break the loop by treating that offender as a root; every other member keeps its real
      // parent link, so the whole segment renders as an ordinary chain under the offender.
      for (let i = 0; i < chain.length - 1; i++) attach(chain[i], chain[i + 1])
      roots.push(nodesById.get(chain[chain.length - 1])!)
      placed.add(chain[chain.length - 1])
      continue
    }

    const parent = readParentID(session)
    if (parent && parent !== session.id && nodesById.has(parent)) attach(session.id, parent)
    else roots.push(nodesById.get(session.id)!)
    placed.add(session.id)
  }

  return roots
}
