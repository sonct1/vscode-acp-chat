# Implementation Plan: Pi Agent Toolbar Thinking and Context Usage Fixes

| Attribute  | Value                                                                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented                                                                                                                                                                                                                                                                                         |
| Owner      | TBD                                                                                                                                                                                                                                                                                                 |
| Scope      | Bundled Pi ACP adapter metadata, chat toolbar session controls, context/token usage propagation, tests, docs                                                                                                                                                                                        |
| References | `docs/plans/implement-bundled-pi-agent.md`, `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`, `src/features/pi-agent/vendor/pi-acp/src/acp/session.ts`, `src/views/webview/component/session-toolbar.ts`, `src/views/webview/widget/context-usage.ts`, `docs/architecture/acp-chat-layout.md` |

## Objective

Fix two Pi-specific UX issues in the ACP Chat input toolbar:

1. Pi shows two `Thinking` selectors in the toolbar.
2. Pi does not show context/token usage information in the chat input toolbar.

Target behavior:

- Pi exposes one thinking control only.
- The remaining thinking control can update Pi's runtime thinking level.
- Pi usage information appears in the toolbar after usage data is available.
- The UI must not fake a context-window percentage when Pi cannot provide a reliable context size.

## Current-state analysis

### Duplicate `Thinking` selectors

Pi ACP currently advertises thinking level through two metadata paths:

- Legacy `modes` from `getThinkingState()` in `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`.
- Generic ACP `configOptions` entry with `id: "thought_level"` from `buildConfigOptions()` in the same file.

The VS Code webview renders both paths:

- `modes` renders into `#mode-dropdown` in `src/views/webview/component/session-toolbar.ts`.
- `genericConfigOptions` renders into `#config-options-container` in the same component.

Result: the toolbar shows one sparkle-icon `Thinking: xhigh` mode dropdown and one lightbulb-icon `Thinking: xhigh` config dropdown.

### Missing context usage

The HTML template already contains `#context-usage-ring` in `src/views/chat.ts`, but it is hidden by default.

It becomes visible only when the host posts a `contextUsage` message with valid usage numbers:

- Single-session path: `ChatViewProvider.handleSessionUpdate()` handles ACP `usage_update` and calls `sendContextUsage()`.
- Multi-session path: `SessionOutputPipeline` handles ACP `usage_update` and stores `session.contextUsage`.
- Webview path: `SessionToolbarComponent.updateContextUsage()` calls `updateContextUsageRing()`.

Pi ACP does not currently emit ACP `usage_update`. It only exposes usage through the `/session` slash command path, which calls `proc.getSessionStats()` and renders text into the transcript.

## Architecture decisions

### Decision 1: Use `configOptions.thought_level` as Pi's single toolbar control

For the bundled Pi agent, `configOptions` should be the source of truth for model and thinking controls.

Implementation direction:

- Stop advertising Pi thinking level as legacy `modes` in `newSession()` / `loadSession()` responses.
- Keep `setSessionMode()` implemented for compatibility with external clients that may still call it.
- Keep `setSessionConfigOption({ configId: "thought_level" })` as the primary path used by this VS Code extension.
- Optionally make displayed option names concise (`Off`, `Minimal`, `Low`, `Medium`, `High`, `Xhigh`) while preserving values (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`).

Rationale:

- Hiding the duplicate in the webview would treat a Pi adapter metadata bug as a client rendering special case.
- Fixing the adapter keeps the metadata contract clean and prevents the same duplicate from appearing in any ACP client that renders both `modes` and `configOptions`.

### Decision 2: Do not invent context percentages

The context usage ring represents `used / size`. If Pi cannot provide a reliable context-window size, the extension must not fabricate one.

Implementation direction:

- First try to derive `used` and `size` from Pi RPC data (`get_session_stats`, `get_state`, selected model metadata, or provider/model catalog metadata).
- If both `used` and `size` are available, emit normal ACP `usage_update` and keep the current ring behavior.
- If only token usage/cost is available, extend the toolbar UI to show a neutral token-usage indicator with tooltip text such as `Tokens: 12,345` and `Context size unavailable`; do not show a percentage ring.

## Proposed file changes

```text
src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts
  - Return no legacy `modes` for Pi toolbar metadata, or return `modes: null` while preserving configOptions.
  - Keep setSessionMode as compatibility shim mapped to Pi thinking level.
  - Improve thought_level option display names if needed.

src/features/pi-agent/vendor/pi-acp/src/acp/session.ts
  - Query Pi usage stats after agent turns and emit ACP usage updates when reliable.
  - Avoid blocking turn completion if stats lookup fails.

src/features/pi-agent/vendor/pi-acp/src/pi-rpc/process.ts
  - Reuse existing getSessionStats(); add typed helper shapes only if needed.

src/acp/client.ts
src/acp/session-output-pipeline.ts
src/views/chat.ts
src/features/multi-session/host.ts
  - No change if Pi can emit standard usage_update with numeric used/size.
  - If token-only fallback is needed, widen usage types and forwarding logic to support visible non-percentage token usage.

src/views/webview/widget/context-usage.ts
src/views/webview/component/session-toolbar.ts
media/main.css
  - No change if standard ring is enough.
  - If token-only fallback is needed, render a neutral token/context badge when size is unavailable.

src/test/**
src/features/pi-agent/vendor/pi-acp/test/**
  - Add adapter and webview regression tests.

docs/architecture/acp-chat-layout.md
  - Update only if the visible context indicator behavior changes beyond the existing ring.
```

## Implementation phases

### Phase 0: Verify Pi usage data shape

Inspect real Pi RPC responses for:

- `get_state`
- `get_session_stats`
- `get_available_models`

Needed fields:

- Current token usage: preferred `tokens.total`; fallback sum of input/output/cache read/cache write if semantically correct.
- Context window size: preferred explicit `contextWindow`, `contextLimit`, `maxContextTokens`, model metadata, or equivalent.
- Cost: optional numeric amount and currency if Pi provides it.

Acceptance criteria:

- Document the exact fields used to compute `used`, `size`, and optional `cost` in code comments or tests.
- If no reliable `size` exists, choose the token-only fallback path before changing UI code.

### Phase 1: Remove duplicate Pi thinking metadata

#### Task 1.1: Make Pi config options the toolbar source of truth

Update `getSessionConfiguration()` / response construction in `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts` so Pi no longer returns thinking as legacy `modes` to this extension.

Recommended shape:

```ts
return {
  configOptions: buildConfigOptions({ models, modes }),
  models,
  modes: null,
};
```

If SDK types require `modes` to be omitted rather than `null`, omit the property.

Acceptance criteria:

- Pi `newSession()` response contains `configOptions` with `thought_level`.
- Pi `newSession()` response does not cause the client to render `#mode-dropdown` for thinking.
- Pi `loadSession()` follows the same behavior.

#### Task 1.2: Preserve compatibility setters

Keep these paths working:

- `setSessionConfigOption(thought_level)` → `proc.setThinkingLevel()` → `config_option_update`.
- `setSessionMode(modeId)` → `proc.setThinkingLevel()` → `config_option_update` and, if needed, `current_mode_update` for compatibility.

Acceptance criteria:

- Selecting the remaining thinking dropdown changes Pi thinking level.
- External clients that still call `setSessionMode()` do not break.

#### Task 1.3: Migrate saved thinking preference

Existing users may have saved Pi thinking in `AgentPreference.modeId` from the duplicate legacy mode dropdown.

Add a migration in preference restore logic:

- If agent is `pi`.
- If no saved `configOptionValues.thought_level` exists.
- If saved `modeId` is one of Pi's thinking levels.
- Restore it through `setConfigOption("thought_level", savedModeId)` and persist it under `configOptionValues.thought_level`.

Apply to both:

- Single-session restore in `src/views/chat.ts`.
- Multi-session restore in `src/features/multi-session/host.ts` if it has an independent restore path.

Acceptance criteria:

- Upgrade does not reset a user's previously selected Pi thinking level.
- The stale saved `modeId` no longer forces a hidden/removed mode control.

### Phase 2: Emit Pi usage information

#### Task 2.1: Add usage normalization helper in Pi ACP

Create a small helper in the Pi ACP adapter to convert Pi stats/state/model metadata into ACP usage data.

Preferred output:

```ts
{
  used: number,
  size: number,
  cost?: { amount: number; currency: string } | null
}
```

Rules:

- `used` must be non-negative.
- `size` must be positive when emitting percentage/ring usage.
- Do not emit ring usage if `size` is unknown or guessed.
- Cost is optional and must be ignored if not numeric.

Acceptance criteria:

- Helper has unit tests for valid stats, missing stats, malformed stats, and missing context size.

#### Task 2.2: Emit `usage_update` after Pi turns

In `src/features/pi-agent/vendor/pi-acp/src/acp/session.ts`, after a Pi agent turn finishes, call the usage helper asynchronously and emit:

```ts
{
  sessionUpdate: ("usage_update", used, size, cost);
}
```

Implementation notes:

- Use `void this.emitUsageUpdate().catch(...)` or equivalent so stats lookup failure does not fail the user prompt.
- Preserve output ordering enough that the UI can update after `agent_end`.
- Also consider emitting after manual `/compact` and `/session` if those commands change or reveal usage.

Acceptance criteria:

- After a normal Pi response, the host receives `usage_update`.
- Single-session toolbar shows context usage after the turn.
- Multi-session snapshot stores/replays context usage when switching sessions.

### Phase 3: Add token-only fallback if context size is unavailable

Execute this phase only if Phase 0 proves Pi cannot provide a reliable context size.

#### Task 3.1: Extend host usage model

Allow usage data with `used` but no `size` to flow from host to webview without being discarded.

Candidate type change:

```ts
interface ContextUsageUpdate {
  used: number;
  size: number | null;
  cost?: { amount: number; currency: string } | null;
  label?: "tokens" | "context";
}
```

Acceptance criteria:

- Existing numeric `used`/`size` ring behavior remains unchanged.
- Token-only Pi usage reaches the webview.

#### Task 3.2: Render neutral token indicator

Update `updateContextUsageRing()` or split it into a generic toolbar usage widget:

- If `size > 0`, render current percentage ring.
- If `used` exists and `size` is null/unknown, show a neutral token badge/icon and tooltip.
- Keep `hidden` only when no usage data exists.

Acceptance criteria:

- Pi shows visible usage text/icon even without context size.
- Tooltip states clearly that context size is unavailable.
- `acp-chat-layout.md` documents the fallback if visible UI changes.

### Phase 4: Tests

Adapter tests under `src/features/pi-agent/vendor/pi-acp/test/`:

- `newSession` returns one thinking control path: `configOptions.thought_level`, no legacy `modes` for Pi toolbar metadata.
- `loadSession` follows the same metadata shape.
- `setSessionConfigOption(thought_level)` still calls `setThinkingLevel()` and emits sync metadata.
- `setSessionMode()` remains a compatibility shim.
- `PiAcpSession` emits `usage_update` from valid stats after `agent_end`.
- No `usage_update` is emitted for malformed stats or unknown context size unless token-only fallback is implemented.

Extension/webview tests under `src/test/`:

- Pi-like `sessionMetadata` renders only one thinking dropdown.
- Existing model dropdown behavior is unchanged.
- Existing context ring tests remain green.
- If token-only fallback is implemented, add tests for visible neutral usage indicator and tooltip.
- Preference restore migrates saved Pi `modeId` to `configOptionValues.thought_level`.
- Multi-session usage snapshot replays correctly after session switch.

Acceptance criteria:

- Regression tests fail on the current duplicate-thinking behavior and pass after the fix.
- Usage tests cover both valid and unavailable usage data.

### Phase 5: Docs and verification

Docs:

- Update `docs/architecture/acp-chat-layout.md` if the context indicator gets a token-only fallback or any visible layout change.
- Add completion notes to this plan after implementation.
- Update `docs/features/feature-catalog.md` only if feature behavior/status visible to users changes materially.

Verification commands for the implementation change:

```bash
npm run check-types
npm test
npm run package
npx vsce package --out /tmp/vscode-acp-chat-pi-toolbar-context.vsix
unzip -l /tmp/vscode-acp-chat-pi-toolbar-context.vsix | grep 'dist/pi-acp/index.mjs'
code --install-extension /tmp/vscode-acp-chat-pi-toolbar-context.vsix --force
```

Manual verification:

- Start VS Code with bundled Pi selected.
- Confirm toolbar shows only one thinking control.
- Change thinking level and verify subsequent Pi state reflects it.
- Send a Pi message and confirm usage appears in the input toolbar when usage data is available.
- If only token-only fallback is active, confirm tooltip says context size is unavailable.
- Switch away and back in multi-session mode; usage display should persist for the session.
- Run `Developer: Reload Window` after installing the VSIX.

## Risks and mitigations

| Risk                                                                                  | Impact | Mitigation                                                                                                              |
| ------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Removing legacy `modes` breaks a client path that still depends on `setSessionMode()` | Medium | Keep `setSessionMode()` implemented; only stop advertising duplicate metadata to the toolbar.                           |
| Saved Pi thinking preference was stored as `modeId`                                   | Medium | Add one-time restore migration to `configOptionValues.thought_level`.                                                   |
| Pi stats do not expose context-window size                                            | Medium | Do not fake percentages; implement token-only fallback indicator.                                                       |
| Stats lookup after every turn adds latency or failures                                | Low    | Run asynchronously after the turn and ignore stats failures.                                                            |
| Usage update order races with prompt finalization                                     | Low    | Emit after `agent_end`; existing host can process `usage_update` independently of transcript finalization.              |
| UI change affects non-Pi agents                                                       | Medium | Keep fallback generic but only activated by token-only payloads; preserve existing ring behavior for valid `used/size`. |

## Completion notes

Implemented 2026-07-14:

- Pi ACP now advertises thinking only as `configOptions.thought_level`; legacy `modes` is no longer returned from Pi `newSession()` / `loadSession()` metadata.
- `setSessionMode()` remains as a compatibility shim and still maps to `proc.setThinkingLevel()` with metadata sync updates.
- Single-session and multi-session restore paths migrate saved Pi `modeId` thinking preferences into `configOptionValues.thought_level` and remove the stale `modeId`.
- Pi usage is normalized from verified RPC fields: `get_session_stats.contextUsage.tokens` / `contextUsage.contextWindow`, with token fallback from `tokens.total` or token part sum and context-window fallback from `get_state.model.contextWindow`.
- `PiAcpSession` emits standard ACP `usage_update` after `agent_end` when both used tokens and reliable context size are available. Token-only fallback UI was not implemented because current Pi RPC exposes reliable context size.
- Regression tests cover metadata de-duplication, compatibility setters, usage normalization/emission, single-session preference migration, multi-session preference migration, and webview single-thinking rendering.

## Definition of Done

- Pi toolbar shows one thinking selector, not two.
- Remaining thinking selector updates Pi via `thought_level` config option.
- Existing saved Pi thinking preferences are restored after upgrade.
- Pi emits or surfaces usage information after turns.
- Context ring appears when reliable context size exists.
- Token-only fallback appears when tokens exist but context size does not.
- Single-session and multi-session flows both handle usage display.
- Tests cover metadata de-duplication, thinking changes, usage propagation, and fallback behavior.
- Typecheck, tests, production package, VSIX package content check, and local install complete successfully.
