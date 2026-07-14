# Implementation Plan: Low-Resource Multi-Session Telemetry

Status: Implemented on 2026-07-14. Low-resource mode is default-on; multi-session manager no longer emits unread/diff/conflict telemetry; multi-session diff tracking is disabled unless `vscode-acp-chat.multiSession.lowResourceMode` is set to `false`; manager webviews are no longer retained while hidden; transcript storage keeps compacted snapshots plus sequence metadata only.

## Overview

Reduce CPU/RAM overhead in multi-session mode by removing live `Unread`, `diff`, and `conflicted` telemetry from the session manager UI and by disabling the underlying bookkeeping when it is not needed. The main target is `src/features/multi-session/`, where background message counts, per-session diff counts, conflict sets, and manager-panel updates currently keep extra state and can trigger frequent host-to-webview updates.

## Current Cost Map

- `unread`:
  - `src/features/multi-session/host.ts` increments `ManagedSession.unreadCount` for every background transcript event and schedules chat/manager state updates.
  - `src/features/multi-session/manager-webview.ts` renders aggregate and per-session unread badges.
  - `src/features/multi-session/quick-switch.ts` includes unread counts in QuickPick descriptions.
- `diff` / `conflicted`:
  - Each started session creates a `DiffManager` in `ensureResources()`; `DiffManager` currently owns a workspace-wide `**/*` file watcher.
  - `host.ts` computes `diffCount` from `diffManager.getPendingChanges()` and stores conflicts in `conflictedDiffPaths`.
  - `markOtherDiffsStale()` scans other sessions after writes to mark conflicts.
  - `manager-webview.ts` renders `diff` and `conflicted` badges.
- Hidden manager panel:
  - `src/features/multi-session/manager-panel.ts` uses `retainContextWhenHidden: true`, keeping the manager webview DOM/script alive while hidden.
- Transcript memory:
  - `TranscriptStore` keeps both `rawEvents` and `compactedEvents`; no production caller currently needs `raw()`.

## Architecture Decisions

- Remove the live telemetry from user-visible manager surfaces instead of merely hiding it with CSS.
- Keep permission/status indicators; they are user-actionable and low-volume.
- Preserve single-session diff summary behavior unless explicitly changed later.
- In multi-session low-resource mode, disable diff bookkeeping rather than only hiding diff badges; otherwise CPU/RAM savings are minimal.
- Keep transcript switching behavior intact by preserving compacted transcript snapshots and sequence numbers.

## Task List

### Phase 1: Remove unread telemetry from multi-session state

#### Task 1: Remove unread counters from host state and manager contracts

**Description:** Stop tracking `unreadCount` for background sessions and remove aggregate unread counts from manager/chat state payloads.

**Acceptance criteria:**

- [ ] `ManagedSession` no longer stores `unreadCount`, or it is hard-coded to `0` only for backward-compatible payloads during migration.
- [ ] Background `append()` no longer increments unread or schedules manager/chat state updates only because of transcript events.
- [ ] Activating a session no longer resets unread state.
- [ ] `MultiSessionAggregate` no longer exposes `unread` after contract cleanup.

**Verification:**

- [ ] Multi-session tests prove background transcript events are still available after switching sessions.
- [ ] Manager state tests prove no unread aggregate/badge data is emitted.
- [ ] `npm run check-types` passes.

**Dependencies:** None

**Files likely touched:**

- `src/features/multi-session/host.ts`
- `src/features/multi-session/contracts.ts`
- `src/test/features/multi-session.test.ts`
- `src/test/webview.test.ts`
- `src/test/features/assistant-turn-navigation.test.ts`

**Estimated scope:** Medium

#### Task 2: Remove unread UI from manager and quick switch

**Description:** Remove unread text from the ACP Sessions summary, per-session badges, and native QuickPick descriptions.

**Acceptance criteria:**

- [ ] `ACP Sessions` summary no longer contains `Unread N`.
- [ ] Session rows no longer render `N unread` badges.
- [ ] `Switch ACP Session` QuickPick descriptions no longer include unread text.
- [ ] Session filtering/sorting remains based on status, permission, draft/running state, and recency.

**Verification:**

- [ ] `src/test/features/multi-session-manager-webview.test.ts` covers the updated summary and badges.
- [ ] Manual check: background session output does not change manager badge counts.

**Dependencies:** Task 1

**Files likely touched:**

- `src/features/multi-session/manager-webview.ts`
- `src/features/multi-session/quick-switch.ts`
- `src/test/features/multi-session-manager-webview.test.ts`

**Estimated scope:** Small

### Phase 2: Remove multi-session diff/conflict live tracking

#### Task 3: Add a low-resource diff-tracking switch for multi-session resources

**Description:** Make multi-session diff tracking conditional so sessions can use file tools without retaining per-session diff state, conflict sets, or file watchers. Recommended setting: `vscode-acp-chat.multiSession.lowResourceMode` default `true` in this fork. When true, multi-session diff tracking is disabled and manager diff/conflict telemetry is unavailable.

**Acceptance criteria:**

- [ ] New config is contributed in `package.json` with clear description.
- [ ] When low-resource mode is enabled, `DiffManager` does not create a workspace watcher and `recordChange()` stores no pending diff data.
- [ ] Structured diff bridge is skipped in multi-session low-resource mode.
- [ ] `acceptDiff`, `rollbackDiff`, `acceptAllDiffs`, and `rollbackAllDiffs` fail safely/no-op when tracking is disabled.
- [ ] Existing legacy single-session `enableDiffSummary` behavior remains unchanged.

**Verification:**

- [ ] Unit test for disabled/no-op `DiffManager` mode.
- [ ] Multi-session test proves file writes still complete while `diffChanges` is empty.
- [ ] `npm run check-types` passes.

**Dependencies:** None; can run in parallel with Phase 1 if contract edits are coordinated.

**Files likely touched:**

- `package.json`
- `src/acp/diff-manager.ts`
- `src/features/multi-session/host.ts`
- `src/acp/file-handler.ts` only if a null-diff interface is cleaner than `DiffManager` options
- `src/test/diff_manager.test.ts`
- `src/test/features/multi-session.test.ts`

**Estimated scope:** Medium

#### Task 4: Remove diff/conflicted counts from manager contracts and UI

**Description:** Delete manager-level `diffCount` and `conflictedDiffCount` payload fields and their row badges. Active chat diff summary can remain available only when diff tracking is enabled.

**Acceptance criteria:**

- [ ] `MultiSessionListItem` no longer exposes `diffCount` or `conflictedDiffCount` after migration.
- [ ] `toListItem()` no longer calls `diffManager.getPendingChanges()` just to build manager state.
- [ ] Manager row badges no longer show `N diff` or `N conflicted`.
- [ ] Tests no longer rely on these fields.

**Verification:**

- [ ] Manager webview tests assert only permission/status/action UI remains.
- [ ] Multi-session host tests assert manager state construction does not require diff resources.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/multi-session/contracts.ts`
- `src/features/multi-session/host.ts`
- `src/features/multi-session/manager-webview.ts`
- `src/test/features/multi-session-manager-webview.test.ts`
- `src/test/features/multi-session.test.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Medium

#### Task 5: Disable cross-session conflict scans in low-resource mode

**Description:** Avoid scanning every session on each file write when diff tracking is disabled.

**Acceptance criteria:**

- [ ] `markOtherDiffsStale()` returns immediately in low-resource mode.
- [ ] `conflictedDiffPaths` is removed from `ManagedSession` or only allocated when tracking is enabled.
- [ ] No `diffSummary` transcript event is appended solely for conflict updates in low-resource mode.

**Verification:**

- [ ] Test with two sessions writing the same path confirms no conflict bookkeeping occurs in low-resource mode.
- [ ] Test with low-resource mode disabled confirms existing conflict behavior still works if retained.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`

**Estimated scope:** Small

### Phase 3: Reduce hidden UI and transcript memory

#### Task 6: Stop retaining the manager panel when hidden

**Description:** Release hidden webview resources by disabling retained context for the dedicated ACP Sessions panel.

**Acceptance criteria:**

- [ ] `retainContextWhenHidden` is set to `false` in `manager-panel.ts`.
- [ ] Revealing the panel posts a fresh manager snapshot from host state.
- [ ] Search/filter state may reset when hidden; this is acceptable in low-resource mode.

**Verification:**

- [ ] Manual check: open manager, hide/reveal, session list reloads correctly.
- [ ] Existing manager tests still pass.

**Dependencies:** None

**Files likely touched:**

- `src/features/multi-session/manager-panel.ts`

**Estimated scope:** XS

#### Task 7: Remove duplicate raw transcript storage

**Description:** Reduce per-session RAM by keeping only compacted transcript events and sequence metadata. The current `rawEvents` array duplicates stream chunks and is not used by production callers.

**Acceptance criteria:**

- [ ] `TranscriptStore` no longer stores a separate `rawEvents` array.
- [ ] `lastSeq` still tracks every appended event for delta-gap detection.
- [ ] `snapshot()` still returns compacted stream/thought chunks for session switching.
- [ ] Any unused `raw()` method is removed or marked test-only and rewritten to avoid duplication.

**Verification:**

- [ ] Transcript store tests cover chunk compaction and `lastSeq` behavior.
- [ ] Multi-session snapshot tests still pass.

**Dependencies:** None

**Files likely touched:**

- `src/features/multi-session/transcript-store.ts`
- `src/test/features/multi-session.test.ts` or new transcript-store unit test

**Estimated scope:** Small

### Phase 4: Documentation and rollout

#### Task 8: Update feature docs and settings catalog

**Description:** Document that low-resource mode removes unread/diff/conflict session telemetry and disables multi-session diff tracking by default.

**Acceptance criteria:**

- [ ] `docs/features/feature-catalog.md` no longer claims multi-session manager shows unread/diff/conflict counts when low-resource mode is default.
- [ ] Settings table includes the new low-resource setting if introduced.
- [ ] User-facing behavior change is clear: permission/status remain; diff review may require disabling low-resource mode.

**Verification:**

- [ ] Markdown renders cleanly.
- [ ] Links remain valid.

**Dependencies:** Tasks 1-7

**Files likely touched:**

- `docs/features/feature-catalog.md`
- `docs/plans/implement-low-resource-multi-session-telemetry.md`

**Estimated scope:** Small

## Checkpoints

### Checkpoint A: After Phase 1

- [ ] Manager no longer displays unread data.
- [ ] Background transcript switching still works.
- [ ] `npm run check-types` passes.

### Checkpoint B: After Phase 2

- [ ] Multi-session low-resource mode no longer allocates actionable diff state/watchers.
- [ ] File writes still work.
- [ ] Diff accept/rollback no-op safely when disabled.
- [ ] `npm run check-types` and targeted tests pass.

### Checkpoint C: Final

- [ ] `npm run check-types`
- [ ] Targeted tests for multi-session, manager webview, diff manager, transcript store.
- [ ] `npm run package`
- [ ] `npx vsce package --out ./.tmp/vscode-acp-chat-low-resource.vsix`
- [ ] `code --install-extension ./.tmp/vscode-acp-chat-low-resource.vsix --force`
- [ ] Remove temporary VSIX if safe.
- [ ] User reloads VS Code window.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Removing diff tracking removes accept/rollback safety in multi-session low-resource mode. | Medium | Keep setting documented; allow users to disable low-resource mode when they need actionable diff review. |
| Users may miss background activity without unread badges. | Low | Preserve running/waiting/status indicators and session recency sorting. |
| Contract removal touches many tests and fixtures. | Medium | Land Phase 1 and Phase 2 separately; keep temporary zero-valued fields only if needed for incremental migration. |
| Hidden manager panel reload may reset filters/search. | Low | Treat host state as source of truth; accept filter reset as low-resource trade-off. |
| Removing raw transcript storage could break assumptions about event count. | Medium | Preserve `lastSeq` semantics and add focused tests for chunk compaction and snapshot switching. |

## Open Questions

- Should low-resource mode be hard-defaulted to `true` in this fork, or should it be opt-in with default `false` for upstream compatibility?
- Should active-chat diff summary also be disabled by low-resource mode, or only manager-level diff/conflict telemetry?
- Should we additionally lower `vscode-acp-chat.multiSession.maxConcurrentSessions` default from `4` to `2` for stronger process-level resource savings?
