# OpenCode 2 Client Feature Roadmap

> **Status:** active implementation backlog for the OpenCode 2 client.
>
> GitHub issues and pull requests are canonical for scope and implementation. This document tracks sequencing, dependencies, and overall progress.

## Goal

Bring the remote OpenCode 2 experience closer to the native client without weakening Harness Remote's web, desktop, Android, multi-agent, or local-first design.

OpenCode owns execution, sessions, plugins, permissions, tools, and credentials. Harness Remote should expose those capabilities remotely with clear state, safe controls, and graceful behavior when a backend cannot provide equivalent data.

## Status Legend

| Status | Meaning |
|---|---|
| Planned | Scoped in an issue but implementation has not started |
| In progress | An implementation PR is open or active work is underway |
| Blocked | Progress requires an upstream API or another roadmap item |
| Shipped | Merged and available on the default branch |

## Current Baseline

The OpenCode 2 client already supports sessions, streamed messages, prompts, interruption, model and agent selection, commands, questions, permissions, attachments, filesystem browsing, and working-copy diffs.

The remaining work is primarily richer visibility and control. Model execution and agent tools already run on the OpenCode server regardless of which Harness Remote client is connected.

## Progress

| Phase | Issue | Feature | Status | Depends on |
|---|---:|---|---|---|
| 1 | [#3](https://github.com/nitsuga/harness-remote/issues/3) | Classify commands and support explicit skill activation | Shipped | - |
| 1 | [#4](https://github.com/nitsuga/harness-remote/issues/4) | Add compact and fork session actions | Shipped | - |
| 1 | [#23](https://github.com/nitsuga/harness-remote/issues/23) | Detect v2 server version skew for compact/fork capability gating | Planned | #4 |
| 1 | [#24](https://github.com/nitsuga/harness-remote/issues/24) | Surface fork result when it arrives after navigation | Planned | #4 |
| 1 | [#5](https://github.com/nitsuga/harness-remote/issues/5) | Support session import and export | Planned | - |
| 1 | [#6](https://github.com/nitsuga/harness-remote/issues/6) | Show and manage MCP server status | Planned | - |
| 2 | [#7](https://github.com/nitsuga/harness-remote/issues/7) | Derive and display persistent session todos | Shipped | - |
| 2 | [#8](https://github.com/nitsuga/harness-remote/issues/8) | Expose richer session activity and attention states | Shipped | - |
| 2 | [#9](https://github.com/nitsuga/harness-remote/issues/9) | Build a cross-session attention inbox | Shipped | #8 |
| 2 | [#37](https://github.com/nitsuga/harness-remote/issues/37) | Aggregate the attention inbox across multiple machines (multi-profile) | Planned | #9, fleet ([#146](https://github.com/nitsuga/harness-remote/issues/146)) |
| 3 | [#10](https://github.com/nitsuga/harness-remote/issues/10) | Visualize background subagents and delegated tasks | Shipped | - |
| 3 | [#13](https://github.com/nitsuga/harness-remote/issues/13) | Render structured message and tool parts richly | Shipped | - |
| 3 | [#14](https://github.com/nitsuga/harness-remote/issues/14) | Research and provide accurate per-message diffs | Planned | #13 |
| 3 | [#47](https://github.com/nitsuga/harness-remote/issues/47) | Show live running-subagent summary with output window | Shipped | #10 |
| 4 | [#11](https://github.com/nitsuga/harness-remote/issues/11) | Add an authenticated remote PTY terminal | Planned | - |
| 4 | [#12](https://github.com/nitsuga/harness-remote/issues/12) | Expose task and worktree workflows in the client | Planned | #8, #9 |
| 4 | [#63](https://github.com/nitsuga/harness-remote/issues/63) | Auto-reap completed subagent child sessions (per-connection setting, default on) | Planned | #60 |

Progress: **8 of 17 shipped**.

### Reconciliation notes (Aug 16, 2026)

Statuses and issue states were cross-checked against the fork's issue tracker; the table above is canonical.

- **#4 stays `Shipped`** because the compact/fork flow merged in [PR #22](https://github.com/nitsuga/harness-remote/pull/22). The issue itself remains open because one acceptance criterion — actions exposed only for backends that support them — is not met: capabilities are still hardcoded. That gap is tracked by #23, and the dropped fork-result-after-navigation gap by #24.
- **#9 shipped with a re-scoped criterion 1.** [PR #36](https://github.com/nitsuga/harness-remote/pull/36) delivered the machine → agent → session grouping structure with the single active profile populated. Populating it from multiple machines is a connection-management architecture change tracked by #37 and gated on fleet work ([#146](https://github.com/nitsuga/harness-remote/issues/146)).
- **Queued-prompt surfacing shipped without a tracked issue:** [PR #40](https://github.com/nitsuga/harness-remote/pull/40) (badge, auto-open, inline "Send now") plus regression fixes #41 and #42 landed after the last status update. It is not in the table because no issue tracks it; if it should be tracked, file an issue and add a row.
- **#47 shipped after the last update via [PR #48](https://github.com/nitsuga/harness-remote/pull/48)** — the live running-subagent summary row above was added. The issue was closed after independent acceptance verification: all six criteria met on current main (oracle review + green suite), with the first-render gap (running card appears only after a full transcript reload) filed as #52 during live validation and fixed by PRs #53 and #54.
- **Backlog additions:** #44 (todo-panel keying) and #49/#50/#51 (filed from the PR #47 review round) are open bugs filed since the last reconciliation and were added to the maintenance table below.

### Open maintenance and security backlog (not feature-tracked)

Filed separately during feature reviews; these are bugs and hygiene items, not roadmap features:

| Issue | Area | One-liner |
|---|---|---|
| [#25](https://github.com/nitsuga/harness-remote/issues/25) | UX | Mutation-lock state on question/permission cards has no disabled hint |
| [#26](https://github.com/nitsuga/harness-remote/issues/26) | a11y | Session card meta/status areas read as clickable but no longer open |
| [#27](https://github.com/nitsuga/harness-remote/issues/27) | v1 parity | v1 prompt/command transport loss still surfaces as definite failure |
| [#28](https://github.com/nitsuga/harness-remote/issues/28) | v2 fix | Fork-reconciled child row can flicker under concurrent poll refresh |
| [#29](https://github.com/nitsuga/harness-remote/issues/29) | v2 fix | Rename input can stay open after a stale lease race |
| [#31](https://github.com/nitsuga/harness-remote/issues/31) | v2 fix | `file://` content should degrade gracefully in the file-content renderer |
| [#35](https://github.com/nitsuga/harness-remote/issues/35) | chore | Remove write-only `wasRunningRef` dead state |
| [#38](https://github.com/nitsuga/harness-remote/issues/38) | security | PermissionCard renders raw permission patterns (last raw credential-like surface) |
| [#44](https://github.com/nitsuga/harness-remote/issues/44) | web | Todo panel rows key on required `TodoItem.id` but real todo items have no id |
| [#49](https://github.com/nitsuga/harness-remote/issues/49) | v2 fix | 3.5s poll effect deps omit `activeProfileID`, so profile-only switches carry stale state |
| [#50](https://github.com/nitsuga/harness-remote/issues/50) | v2 fix | Eager awaited `loadSelected` can be silently discarded by event-driven refreshes |
| [#51](https://github.com/nitsuga/harness-remote/issues/51) | v2 fix | `refreshSessions` has the same request-id starvation the transcript reload fix addresses |

## Delivery Phases

### Phase 1: Quick parity wins

Ship small, independently reviewable additions that map directly to OpenCode 2 APIs and existing Harness Remote UI patterns.

- Skills and commands
- Compact and fork
- Compact/fork version-skew capability gating (#23) and fork-result surfacing (#24)
- Import and export
- MCP visibility and management

### Phase 2: Reliable supervision state

Build a durable state model before adding richer multi-agent presentation.

- Reconstructed session todos
- Busy, waiting, failed, completed, and needs-attention states
- Cross-session questions, permissions, failures, and completion inbox
- Multi-machine inbox aggregation (fleet-gated, #37)

### Phase 3: Rich execution visibility

Improve how agent work and historical results are represented.

- Background subagent and delegated-task hierarchy
- Structured message and tool-part rendering
- Accurate per-message diff research and implementation

### Phase 4: Full remote workspace control

Add larger interactive workflows after supervision state is reliable.

- Authenticated PTY terminal
- Task and worktree creation, execution, review, finish, and safe cleanup
- Auto-reap of completed subagent child sessions (per-connection setting, default on; #63)

## Implementation Principles

- Keep each feature in its own issue and PR unless a dependency makes separation artificial.
- Prefer documented OpenCode 2 API state over client-side inference.
- Label reconstructed or incomplete state honestly.
- Preserve backend-neutral UI and types where the concept applies to other harnesses.
- Make unsupported capabilities explicit rather than silently degrading behavior.
- Treat web, desktop, and Android behavior as part of acceptance, not follow-up polish.
- Add captured wire fixtures and regression tests because the OpenCode 2 API is experimental.
- Never expose server credentials, provider credentials, or sensitive raw payload fields in the UI.

## Progress Updates

Update this document in the PR that changes an item's status:

1. Mark the item `In progress` when the first implementation PR opens.
2. Link the PR from the feature issue.
3. Mark the item `Shipped` and update the shipped count when the PR merges.
4. Record a short blocker in the issue and mark the item `Blocked` when upstream behavior prevents progress.
5. Add newly discovered work to an existing issue when it belongs to that scope; create a new issue only for an independently deliverable feature.

## Related Documents

- [Harness 3 Product & Architecture Roadmap](HARNESS_3_ROADMAP.md)
- [Harness dependency notes](DEPENDENCIES.md)
- [Contributing guide](../CONTRIBUTING.md)
