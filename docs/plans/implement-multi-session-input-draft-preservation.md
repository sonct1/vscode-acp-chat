# Implementation Plan: Multi-Session Input Draft Preservation

## Overview

Fix the bug where the chat input is cleared after an ACP agent finishes running in multi-session mode. The expected behavior is: sending a message clears only the submitted prompt, but any follow-up draft typed while the agent is running must remain in the prompt input when the final multi-session snapshot arrives.

## Current Failure Mode

Relevant flow:

```text
User sends message
  → InputPanelComponent.send()
  → beforeSend event
  → MultiSessionWebviewController.beforeSend()
  → delete drafts[activeSessionId]
  → clear input

User types follow-up while agent runs
  → InputPanelComponent input listener
  → StatePersistenceService.inputValue updated
  → multi-session drafts[activeSessionId] not updated

Agent finishes
  → MultiSessionHost.sendActiveMessage() finally
  → sendSnapshot()
  → webview applySnapshot()
  → setInputHtml(drafts[activeSessionId] ?? "")
  → input is overwritten with ""
```

Primary code paths:

- `src/views/webview/component/input-panel.ts` clears the input after a valid send; this is intentional.
- `src/features/multi-session/webview.ts` deletes the active draft in `beforeSend()` and later restores input from `drafts[sessionId] ?? ""` in `applySnapshot()`.
- `src/views/webview/state-persistence.ts` tracks `inputValue`, but `applySnapshot()` does not consult that value.
- `src/features/multi-session/host.ts` sends a final snapshot after `sendActiveMessage()` completes, which triggers the destructive restore.

## Goals

- Preserve follow-up draft text, mention chips, command chips, and image chips typed while an agent is generating.
- Keep the intentional post-send input clear behavior.
- Keep per-session drafts isolated across multi-session switching.
- Avoid broad changes to ACP host protocol or transcript rendering.
- Add regression tests that fail on the current destructive snapshot restore.

## Non-Goals

- Do not redesign prompt history navigation.
- Do not change single-session chat behavior.
- Do not add new persistent storage outside the existing webview state.
- Do not change ACP protocol messages unless a minimal webview-only fix is impossible.

## Architecture Decisions

- Treat `multiSession.drafts[sessionId]` as the source of truth for per-session prompt drafts in multi-session mode.
- Update the active session draft when the prompt input changes, not only when switching sessions.
- During same-session snapshot replay, avoid overwriting a newer local draft with stale/empty snapshot-derived state.
- Keep `StatePersistenceService.inputValue` for existing webview reload compatibility, but make multi-session draft persistence explicit and session-scoped.
- Prefer a small webview feature integration over host-side snapshot changes; the host does not know about unsent webview drafts.

## Proposed Fix Strategy

1. Add a way for `InputPanelComponent` or `WebviewController` to notify multi-session code whenever the prompt draft changes.
2. Store the current `inputPanel.getInputHtml()` into `drafts[activeLocalSessionId]` for the active session.
3. Keep `beforeSend()` clearing the submitted draft, because the sent message should not remain in input.
4. When `applySnapshot()` replays the same active session, restore from the current session draft only if that draft is the intended latest local value.
5. Ensure snapshot replay cannot write `""` over non-empty local input typed after send.

Possible implementation shape:

```ts
// WebviewController wires input draft changes to multi-session.
inputPanel.onDraftChanged = () => {
  features.multiSession.saveActiveDraft(inputPanel.getInputHtml());
};

// MultiSessionWebviewController owns session-scoped draft state.
saveActiveDraft(html: string): void {
  if (!this.activeLocalSessionId) return;
  if (html) this.drafts[this.activeLocalSessionId] = html;
  else delete this.drafts[this.activeLocalSessionId];
  this.persistState({ inputValue: html });
}
```

The exact API can differ, but the final behavior must be covered by tests.

## Task List

### Phase 1: Reproduce and guard the bug

#### Task 1: Add a failing regression test for snapshot replay preserving active input

**Description:** Add a webview/multi-session test that reproduces the bug: send clears the submitted message, user types a follow-up draft while generation is active, final `feature.multi-session.snapshot` arrives for the same session, and the follow-up draft remains in the input.

**Acceptance criteria:**

- [ ] Test fails on the current implementation because `applySnapshot()` calls `setInputHtml("")`.
- [ ] Test models same active session and final `isGenerating: false` snapshot.
- [ ] Test asserts both text draft and HTML draft preservation where practical.

**Verification:**

- [ ] Run the focused webview/multi-session test command used by the repo.
- [ ] Confirm failure occurs before implementation and passes after implementation.

**Dependencies:** None

**Files likely touched:**

- `src/test/webview.test.ts`
- `src/test/features/multi-session.test.ts` if the existing multi-session webview harness is a better fit

**Estimated scope:** Small

### Phase 2: Persist active session draft on input changes

#### Task 2: Expose prompt draft change notification from InputPanelComponent

**Description:** Add a minimal webview-layer callback/event so other webview features can observe prompt draft changes without reading DOM through ad-hoc listeners.

**Acceptance criteria:**

- [ ] Draft change notification fires after normal typing, paste, chip insertion, and explicit `setInputHtml()` changes.
- [ ] Notification carries or allows reading the current input HTML.
- [ ] Existing send, Escape clear, autocomplete, and image attachment behavior remains unchanged.
- [ ] No webview feature imports `vscode` directly.

**Verification:**

- [ ] Existing `InputPanelComponent` tests pass.
- [ ] Add/adjust focused tests for notification if the test harness supports it.
- [ ] `npm run check-types` passes.

**Dependencies:** Task 1

**Files likely touched:**

- `src/views/webview/component/input-panel.ts`
- `src/views/webview/main.ts`
- `src/views/webview/types.ts` only if a shared event type is needed

**Estimated scope:** Small

#### Task 3: Store active multi-session draft on every prompt change

**Description:** Add a public method on `MultiSessionWebviewController` to save the active session draft and wire it from `WebviewController` or the webview event bus.

**Acceptance criteria:**

- [ ] `drafts[activeLocalSessionId]` updates when the user types in the active session.
- [ ] Empty input removes or stores an empty draft consistently without breaking placeholder behavior.
- [ ] `multiSession.drafts` in webview state remains session-scoped.
- [ ] Switching sessions still saves/restores each session draft independently.

**Verification:**

- [ ] Regression test from Task 1 passes for plain text.
- [ ] Existing multi-session session-switch tests pass.
- [ ] `npm run check-types` passes.

**Dependencies:** Task 2

**Files likely touched:**

- `src/features/multi-session/webview.ts`
- `src/views/webview/main.ts`
- `src/test/features/multi-session.test.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Small to Medium

### Phase 3: Make snapshot restore non-destructive

#### Task 4: Prevent same-session snapshot from clearing newer local input

**Description:** Harden `applySnapshot()` so same-session snapshot replay does not overwrite a non-empty active local draft with stale or missing `drafts[sessionId]` data.

**Acceptance criteria:**

- [ ] If the active session did not change and current input is non-empty, final snapshot replay preserves it.
- [ ] If the active session changed, snapshot restore still loads that session's saved draft.
- [ ] If the current input is intentionally empty after send and no follow-up draft exists, input remains empty.
- [ ] `setInputHtml()` is not called with `""` solely because `drafts[sessionId]` is missing for the same active session.

**Verification:**

- [ ] Regression test covers the final snapshot after generation completes.
- [ ] Add a negative test proving the submitted prompt does not reappear immediately after send.
- [ ] Existing snapshot replay/session switch tests pass.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/multi-session/webview.ts`
- `src/test/features/multi-session.test.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Small

#### Task 5: Preserve rich prompt content in draft storage

**Description:** Confirm and test that draft preservation keeps contenteditable HTML that includes mention chips, command chips, and image chips.

**Acceptance criteria:**

- [ ] Restored draft keeps chip `data-*` attributes needed by `collectMessage()`.
- [ ] `rehydrateMentionChips()` still runs after `setInputHtml()` restore.
- [ ] Mention/image draft preservation does not duplicate chips or lose chip labels.

**Verification:**

- [ ] Add/adjust JSDOM tests for mention chip and image chip draft preservation across snapshot replay.
- [ ] `npm run check-types` passes.

**Dependencies:** Task 4

**Files likely touched:**

- `src/test/webview.test.ts`
- `src/test/features/multi-session.test.ts`
- `src/features/multi-session/webview.ts` only if rich content exposes a bug

**Estimated scope:** Small

#### Task 5a: Move message queue preview above chat input

**Description:** Move the `Steering` / `Follow-up` queue preview from below the rich prompt input to the top of the composer, above the text input, so queued guidance remains visible before the user reaches the lower toolbar area.

**Acceptance criteria:**

- [ ] `#message-queue-preview` is inserted in `#chat-input-area` before `#input-container`.
- [ ] Existing preview text, truncation, hidden state, `role="status"`, and `aria-live="polite"` behavior remain unchanged.
- [ ] Queue keyboard behavior is unchanged: processing `Enter` queues steering, `Alt+Enter` queues follow-up, and `Alt+Up` restores queued messages.
- [ ] Layout documentation reflects the queue preview above the rich input.

**Verification:**

- [ ] Add/adjust a webview DOM-order test for the queue preview.
- [ ] `npm run check-types` passes.
- [ ] Focused webview/message-queue tests pass.

**Dependencies:** Task 5

**Files likely touched:**

- `src/features/message-queue/webview.ts`
- `src/features/message-queue/styles.ts`
- `src/test/webview.test.ts`
- `docs/architecture/acp-chat-layout.md`

**Estimated scope:** Small

### Phase 4: Verification and release packaging

#### Task 6: Run focused and full quality gates

**Description:** Verify the fix does not regress webview, multi-session, prompt history, or TypeScript builds.

**Acceptance criteria:**

- [ ] Focused regression tests pass.
- [ ] Multi-session tests pass.
- [ ] Webview tests pass.
- [ ] Typecheck passes.
- [ ] Production bundle builds.

**Verification commands:**

- [ ] `npm run check-types`
- [ ] Focused test command for the new regression test
- [ ] `npm test -- --grep "multi-session"` or the repo-equivalent focused command
- [ ] `npm run package`

**Dependencies:** Tasks 1-5

**Files likely touched:** None beyond implementation/test files

**Estimated scope:** Small

#### Task 7: Package and install extension for local validation

**Description:** Follow repository rule after extension/webview code changes: package and install the VSIX into VS Code, then manually validate the user scenario.

**Acceptance criteria:**

- [ ] VSIX package is created outside committed source or in a git-ignored temporary path.
- [ ] VSIX installs with `code --install-extension <path>.vsix --force`.
- [ ] Manual validation: send a prompt, type a follow-up while agent runs, wait for completion, follow-up remains in input.
- [ ] User is told to run `Developer: Reload Window` if needed.

**Verification commands:**

- [ ] `npx vsce package --out <temporary-or-versioned-path>.vsix`
- [ ] `code --install-extension <path>.vsix --force`

**Dependencies:** Task 6

**Files likely touched:** None

**Estimated scope:** Small

## Checkpoint: After Tasks 1-3

- [ ] The bug is reproduced by an automated test.
- [ ] Active session draft storage updates while the user types.
- [ ] Existing send-clear behavior still works.
- [ ] Implementation direction is still webview-only.

## Checkpoint: After Tasks 4-7

- [ ] Final snapshot replay no longer clears a follow-up draft.
- [ ] Session switching still restores each session draft correctly.
- [ ] Rich chips survive snapshot replay.
- [ ] Quality gates, production bundle, VSIX package, and local install are complete.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Snapshot replay still races with user typing | High | Save active draft on every prompt change and avoid same-session destructive restore. |
| Submitted message reappears after send | Medium | Keep `beforeSend()`/`clearInput()` semantics and add a negative regression test. |
| Session switching restores the wrong draft | Medium | Keep `drafts` keyed by `localSessionId` and test switching after typing drafts in two sessions. |
| Rich mention/image chips lose metadata | Medium | Preserve full `innerHTML`, run `rehydrateMentionChips()`, and test chip `data-*` attributes. |
| Debounced state writes lag behind snapshot replay | Medium | Update in-memory `drafts` synchronously; do not rely only on debounced `vscode.setState()`. |

## Open Questions

- Should empty drafts be represented by deleting `drafts[sessionId]` or storing `""`? Pick one and make tests explicit.
- Should draft-change notification be a direct callback on `InputPanelComponent` or an `EventBus` event? Prefer the least invasive option that keeps feature integration clean.
