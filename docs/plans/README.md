# Implementation Plans

Use this area for implementation strategy for large or cross-cutting changes: sequencing, phases, migration order, rollout plan, verification approach, risk management, and dependency management.

Typical files:

- `implement-<topic>.md`
- `migrate-<topic>.md`
- `refactor-<topic>.md`
- `rollout-<topic>.md`

Current plans:

- [Add Selection/File/Folder to Chat](./implement-add-to-chat-context.md) — add editor selection, Explorer file, and Explorer folder resources to the chat composer as mention chips.
- [Agent Selection and New Session](./implement-agent-selection-new-session.md) — keep the selected-agent marker correct across reopen/reload and make agent selection start a new chat/session with that agent.
- [Assistant Turn Navigation](./implement-assistant-turn-navigation.md) — jump quickly between completed assistant response turns in the chat transcript.
- [Chat Font Size Setting](./implement-chat-font-size-setting.md) — add a configurable font size for the ACP Chat webview transcript and prompt input.
- [Clickable Chat Resource Links](./implement-clickable-chat-resource-links.md) — auto-detect file paths and web URLs in assistant responses so they can be clicked from the webview.
- [Prompt History Navigation](./implement-prompt-history-navigation.md) — use ArrowUp/ArrowDown in the prompt input to navigate user messages in the current chat session.
- [Readable Inline Diff](./implement-readable-inline-diff.md) — improve inline edit/write diff readability with theme-aware styling, line numbers, hunk headers, full diff actions, and large-diff safeguards.
- [Structured Diff Summary Bridge](./implement-structured-diff-summary-bridge.md) — record structured tool-call diffs into `DiffManager` so the diff summary panel covers non-`writeTextFile` edits.
- [Bundled Pi ACP Agent](./implement-bundled-pi-agent.md) — ship Pi as a built-in agent by bundling/forking the `pi-acp` adapter into the extension.
- [Pi ACP Full History Replay](./implement-pi-acp-full-history-replay.md) — fix bundled Pi history loading by replaying full active-path transcript from Pi JSONL files instead of compacted RPC state.
- [Pi Agent Toolbar Thinking and Context Usage Fixes](./implement-pi-agent-toolbar-context-fixes.md) — remove duplicate Pi thinking selectors and surface Pi context/token usage in the chat toolbar.
- [Full ACP Session ID Display](./implement-full-session-id-display.md) — show the complete ACP/Pi session id in multi-session UI metadata and remove short-id fallbacks.
- [Split Multi-Session Manager Panel](./implement-split-session-manager-panel.md) — move full session management out of the chat webview into a dedicated panel plus quick switch flow.
- [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md) — cache rendered transcript DOM per session inside the existing chat webview to avoid full replay on repeated switches.
- [Eager Multi-Session Runtime Loading](./implement-eager-multi-session-runtime.md) — auto-start the restored/opened multi-session draft's ACP runtime without creating an ACP session until user action.
- [Searchable Model Picker](./implement-searchable-model-picker.md) — add search/filter support to the model selection dropdown.
- [Secondary Sidebar Settings Action](./implement-secondary-sidebar-settings-action.md) — add a settings gear action to the ACP Chat secondary sidebar title area.

Do not put long-lived technical design, API contracts, backlog items, active task status, or operational runbooks here. Use Beads for executable tasks and status.
