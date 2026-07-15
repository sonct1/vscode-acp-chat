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
- [Inline Agent Selector on ACP Chat Surface](./implement-selected-agent-view-title.md) — replace the robot title action with an always-visible searchable agent selector inside the shared chat header while retaining QuickPick as a Command Palette fallback.
- [Assistant Turn Navigation](./implement-assistant-turn-navigation.md) — jump quickly between completed assistant response turns in the chat transcript.
- [Chat Font Size Setting](./implement-chat-font-size-setting.md) — apply one configured size uniformly to normal text in the primary ACP Chat webview, with bounded Markdown heading hierarchy.
- [Scroll-Contextual User Prompt Composer Tip](./implement-latest-user-prompt-composer-tip.md) — show the user prompt associated with the conversation turn currently being read while the transcript is scrolled away from the bottom.
- [Clickable Chat Resource Links](./implement-clickable-chat-resource-links.md) — auto-detect file paths and web URLs in assistant responses so they can be clicked from the webview.
- [Prompt History Navigation](./implement-prompt-history-navigation.md) — use ArrowUp/ArrowDown in the prompt input to navigate user messages in the current chat session.
- [Pi-Style Message Queue](./implement-pi-style-message-queue.md) — add processing-aware Enter/Alt+Enter/Escape/Alt+Up queue behavior across all ACP agents, with universal host fallback and capability-gated native Pi delivery.
- [Readable Inline Diff](./implement-readable-inline-diff.md) — improve inline edit/write diff readability with theme-aware styling, line numbers, hunk headers, full diff actions, and large-diff safeguards.
- [Structured Diff Summary Bridge](./implement-structured-diff-summary-bridge.md) — record structured tool-call diffs into `DiffManager` so the diff summary panel covers non-`writeTextFile` edits.
- [Bundled Pi ACP Agent](./implement-bundled-pi-agent.md) — ship Pi as a built-in agent by bundling/forking the `pi-acp` adapter into the extension.
- [Bundled Antigravity ACP Agent](./implement-bundled-antigravity-agent.md) — fork, harden, and bundle an opt-in Antigravity ACP adapter that reuses the installed `agy` CLI and its OAuth session.
- [Pi ACP Full History Replay](./implement-pi-acp-full-history-replay.md) — fix bundled Pi history loading by replaying full active-path transcript from Pi JSONL files instead of compacted RPC state.
- [Fast Chat History Loading](./implement-fast-chat-history-loading.md) — optimize agent-scoped history listing and restoration with Pi metadata indexing, paged cached pickers, single-pass multi-session publication, and finalized webview rendering.
- [Chat Startup and History Load Performance](./implement-chat-startup-history-performance.md) — giảm độ trễ cảm nhận của New Chat, Pi history list/load và repeated session-switch bằng instrumentation, async runtime startup, Pi indexing/replay reduction và DOM cache rollout.
- [Pi Agent Toolbar Thinking and Context Usage Fixes](./implement-pi-agent-toolbar-context-fixes.md) — remove duplicate Pi thinking selectors and surface Pi context/token usage in the chat toolbar.
- [Pi Context Usage Synchronization](./implement-pi-context-usage-sync.md) — keep ACP Chat context usage synchronized with Pi terminal lifecycle, clear stale post-compaction values, and refresh on model changes.
- [Live Tool Output — Rollout Pi First](./implement-pi-live-tool-output.md) — add generic non-final ACP `tool_call_update` plumbing, activate bundled Pi bash/sub-agent profiles first, then expand safe textual progress to other agents.
- [Full ACP Session ID Display](./implement-full-session-id-display.md) — show the complete ACP/Pi session id in multi-session UI metadata and remove short-id fallbacks.
- [Split Multi-Session Manager Panel](./implement-split-session-manager-panel.md) — move full session management out of the chat webview into a dedicated panel plus quick switch flow.
- [Session Manager Activity Bar Toggle](./implement-session-manager-activity-bar-toggle.md) — move the session manager into an Activity Bar/Primary Sidebar webview and make the existing Manage Chat Sessions action toggle the same surface.
- [Session Switch Loading](./implement-session-switch-loading.md) — show a revision-safe loading overlay and temporarily lock chat interactions while switching between multi-session transcripts.
- [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md) — cache rendered transcript DOM per session inside the existing chat webview to avoid full replay on repeated switches.
- [Multi-Session Input Draft Preservation](./implement-multi-session-input-draft-preservation.md) — preserve follow-up prompt drafts typed while an agent is running when final multi-session snapshots replay.
- [Eager Multi-Session Runtime Loading](./implement-eager-multi-session-runtime.md) — auto-start the restored/opened multi-session draft's ACP runtime without creating an ACP session until user action.
- [Searchable Model Picker](./implement-searchable-model-picker.md) — add search/filter support to the model selection dropdown.
- [Secondary Sidebar Settings Action](./implement-secondary-sidebar-settings-action.md) — add a settings gear action to the ACP Chat secondary sidebar title area.
- [Low-Resource Multi-Session Telemetry](./implement-low-resource-multi-session-telemetry.md) — remove live unread/diff/conflict session telemetry and disable costly multi-session bookkeeping for lower CPU/RAM use.
- [Built-in Swarm Agent Infrastructure](./implement-built-in-swarm-agent.md) — add an experimental built-in Root Orchestrator infrastructure with user-defined roles/workflows, dedicated worker sessions, monitor/state normalization, capability policies, locks, and live progress.

Do not put long-lived technical design, API contracts, backlog items, active task status, or operational runbooks here. Use Beads for executable tasks and status.
