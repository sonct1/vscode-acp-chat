# Existing extension feature catalog

This document records the current user-visible feature set of VSCode ACP Chat as implemented in the extension host, ACP client, and webview runtime.

## Inventory summary

| Feature                                                | User value                                                                                                                                     | Main entry points                                                                                     | Key implementation                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP Chat workbench surface                             | Opens an ACP-backed chat view inside VS Code without leaving the editor.                                                                       | Secondary sidebar view `vscode-acp-chat.chatView`, status bar item, `vscode-acp-chat.startChat`.      | [`package.json`](../../package.json), [`src/extension.ts`](../../src/extension.ts), [`src/views/chat.ts`](../../src/views/chat.ts)                                                                                                                                                                                                       |
| Agent selection and custom agents                      | Lets users choose installed ACP agents or define their own CLI-backed agents.                                                                  | `vscode-acp-chat.selectAgent`, `vscode-acp-chat.customAgents`.                                        | [`src/acp/agents.ts`](../../src/acp/agents.ts), [`src/extension.ts`](../../src/extension.ts)                                                                                                                                                                                                                                             |
| Rich chat composer and transcript                      | Supports streamed Markdown conversations, code blocks, thought/tool blocks, images, chips, copy/reuse actions, and stop controls.              | Webview input, message list, `sendMessage`, `stop`, `vscode-acp-chat.fontSize`.                       | [`src/views/webview/component/input-panel.ts`](../../src/views/webview/component/input-panel.ts), [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts), [`src/views/webview/block/`](../../src/views/webview/block/), [`src/features/chat-font-size/`](../../src/features/chat-font-size/) |
| Context ingestion                                      | Adds editor selections, terminal selections, Explorer files/folders, workspace `@` mentions, slash commands, and image attachments to prompts. | Context-menu commands and input autocomplete.                                                         | [`src/features/add-to-chat/host.ts`](../../src/features/add-to-chat/host.ts), [`src/utils/file-search.ts`](../../src/utils/file-search.ts), [`src/utils/mention-serializer.ts`](../../src/utils/mention-serializer.ts)                                                                                                                   |
| Tool visibility, terminal integration, and permissions | Shows agent tool activity, terminal output, permission prompts, and command results in the transcript.                                         | ACP client fs/terminal/permission callbacks and webview tool blocks.                                  | [`src/acp/client.ts`](../../src/acp/client.ts), [`src/acp/terminal-handler.ts`](../../src/acp/terminal-handler.ts), [`src/views/webview/block/tool-block.ts`](../../src/views/webview/block/tool-block.ts), [`src/views/webview/widget/permission-dialog.ts`](../../src/views/webview/widget/permission-dialog.ts)                       |
| File-change review and diff summary                    | Tracks agent edits and lets users review, accept, or discard file changes individually or in batch.                                            | Diff summary panel, `reviewDiff`, `acceptDiff`, `rollbackDiff`, `acceptAllDiffs`, `rollbackAllDiffs`. | [`src/acp/diff-manager.ts`](../../src/acp/diff-manager.ts), [`src/acp/file-handler.ts`](../../src/acp/file-handler.ts), [`src/views/webview/widget/diff-summary.ts`](../../src/views/webview/widget/diff-summary.ts)                                                                                                                     |
| Agent session toolbar                                  | Exposes agent-advertised modes, models, dynamic config options, model stars, and context/cost usage.                                           | Webview toolbar selectors, `selectMode`, `selectModel`, `selectConfigOption`, `toggleModelStar`.      | [`src/views/webview/component/session-toolbar.ts`](../../src/views/webview/component/session-toolbar.ts), [`src/views/chat.ts`](../../src/views/chat.ts)                                                                                                                                                                                 |
| Concurrent multi-session chat                          | Runs and switches between multiple local ACP sessions with independent transcripts, status, unread counts, permissions, and diffs.             | `vscode-acp-chat.newChat`, `vscode-acp-chat.manageSessions`, multi-session header/manager.            | [`src/features/multi-session/`](../../src/features/multi-session/)                                                                                                                                                                                                                                                                       |
| Session history and retention                          | Lists, loads, resumes, and deletes previous conversations when supported; keeps local session records with retention limits.                   | `vscode-acp-chat.loadHistory`, `vscode-acp-chat.deleteHistorySession`, persistence settings.          | [`src/acp/session-manager.ts`](../../src/acp/session-manager.ts), [`src/views/chat.ts`](../../src/views/chat.ts), [`src/extension.ts`](../../src/extension.ts)                                                                                                                                                                           |
| MCP server forwarding                                  | Passes VS Code MCP server configuration into ACP `session/new` and `session/load` requests.                                                    | `vscode-acp-chat.passMcpServers`, workspace/user `mcp.json`.                                          | [`src/acp/client.ts`](../../src/acp/client.ts), [`src/acp/mcp-config.ts`](../../src/acp/mcp-config.ts)                                                                                                                                                                                                                                   |
| Document synchronization                               | Sends local document open/change/close/save/focus notifications to agents that advertise NES document support.                                 | `vscode-acp-chat.enableDocumentSync`.                                                                 | [`src/acp/document-sync.ts`](../../src/acp/document-sync.ts), [`src/features/multi-session/host.ts`](../../src/features/multi-session/host.ts)                                                                                                                                                                                           |
| Transcript navigation helpers                          | Speeds up prompt and response navigation with keyboard recall and assistant-turn controls.                                                     | Up/Down in prompt, assistant previous/next header buttons.                                            | [`src/features/prompt-history-navigation/`](../../src/features/prompt-history-navigation/), [`src/features/assistant-turn-navigation/`](../../src/features/assistant-turn-navigation/)                                                                                                                                                   |
| Markdown table copy                                    | Adds table-level copy controls for rendered assistant Markdown tables.                                                                         | Table hover/focus toolbar in assistant messages.                                                      | [`src/features/table-copy/`](../../src/features/table-copy/)                                                                                                                                                                                                                                                                             |
| Clickable chat resource links                          | Turns high-confidence file paths, file URLs, and web URLs in assistant responses into clickable links.                                         | Assistant Markdown text and inline code links.                                                        | [`src/features/clickable-resource-links/`](../../src/features/clickable-resource-links/), [`src/views/chat.ts`](../../src/views/chat.ts), [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts)                                                                                             |
| Settings and diagnostics                               | Opens extension-scoped settings and optionally logs raw ACP session updates for debugging.                                                     | `vscode-acp-chat.openSettings`, `vscode-acp-chat.debug`.                                              | [`src/features/open-settings/host.ts`](../../src/features/open-settings/host.ts), [`src/acp/client.ts`](../../src/acp/client.ts)                                                                                                                                                                                                         |

## Feature details

### ACP Chat workbench surface

The extension contributes a secondary-sidebar container named **ACP CHAT** and a retained webview view with id `vscode-acp-chat.chatView`. `Start Chat` focuses the view and asks the current `ChatViewProvider` to connect to the selected ACP agent. A status bar item also opens the chat and reflects either legacy single-session connection state or aggregate multi-session attention.

Relevant commands:

- `vscode-acp-chat.startChat` — focus chat view and connect.
- `vscode-acp-chat.newChat` — create a new chat/session.
- `vscode-acp-chat.clearChat` — clear the current transcript/session surface.
- `vscode-acp-chat.manageSessions` — open the multi-session manager.
- `vscode-acp-chat.loadHistory` — load a previous session.
- `vscode-acp-chat.openSettings` — open extension settings.

### Agent selection and custom agents

Agents are local CLI processes launched through ACP over stdio. Built-in agents are defined in source and merged with `vscode-acp-chat.customAgents`; custom agents with the same `id` replace built-ins, while new ids extend the list. Availability is checked by command lookup before agents appear in the selector. Built-in Pi ships a bundled `pi-acp` adapter and checks for the `pi` CLI instead of requiring a global `pi-acp` command.

Built-in agent ids currently include:

`opencode`, `claude-code`, `codex`, `gemini`, `goose`, `amp`, `aider`, `augment`, `kimi`, `mistral-vibe`, `openhands`, `qwen-code`, `kiro`, `cursor`, `codebuddy`, and `pi`.

The selected agent id is stored in VS Code global state and restored on activation. Agent-specific preferences store selected mode/model/config values and starred models.

Implementation note: source uses `cursor-agent acp` for the Cursor agent.

### Rich chat composer and transcript

The webview is composed from reusable components:

- `InputPanelComponent` manages a contenteditable prompt, send/stop buttons, image attach/paste, mention chips, command chips, and autocomplete.
- `MessageListComponent` renders user, assistant, system, error, stream, thought, and tool messages.
- `BlockManager` delegates assistant blocks to text, thought, and tool block renderers.
- `ActionButtonsComponent` adds post-response controls such as copy and reuse-in-input.

Messages can contain plain text, `@` mentions, slash-command chips, and image data URLs. Assistant output streams in real time and ends with a `streamEnd` event that enables final response actions.

`vscode-acp-chat.fontSize` controls the chat webview base font size. `0` follows VS Code's `--vscode-font-size`; positive values are normalized to `8`-`40` px and apply live to transcript content and the prompt input through `--acp-chat-font-size`.

### Context ingestion

The extension has both command-driven and composer-driven context attachment.

Command-driven context:

- `vscode-acp-chat.sendSelectionToChat` — adds the active editor selection as a `selection` mention.
- `vscode-acp-chat.sendTerminalSelectionToChat` — adds selected terminal text as a `terminal` mention.
- `vscode-acp-chat.addFileToChat` — adds a file mention from Explorer, the active editor/title action, or a picker fallback.
- `vscode-acp-chat.addFolderToChat` — adds an Explorer folder mention.

Composer-driven context:

- `@` autocomplete searches workspace files/folders.
- `/` autocomplete exposes agent-advertised commands.
- Image attachments and pasted images become image mentions with preview chips.
- File links in responses can be opened from the webview, including common line-range suffixes.

### Tool visibility, terminal integration, and permissions

During ACP initialization, the client advertises file-system read/write support and terminal support. Agent requests are handled by extension-host services and reflected in the webview as tool-call lifecycle blocks.

Capabilities surfaced to users:

- expandable tool cards with input/output, status, and generated diff content;
- ANSI-colored terminal output rendering;
- client-side terminal creation, output streaming, wait, kill, and release operations;
- embedded permission dialogs inside matching tool blocks when possible, otherwise modal dialogs;
- automatic permission cancellation after timeout when unanswered.

### File-change review and diff summary

Agent file writes go through `FileHandler`, which snapshots previous content and records pending changes in `DiffManager`. Completed ACP tool calls that include valid structured diff content (`type: "diff"`, target path, `oldText`, and `newText`) are also bridged into the same `DiffManager` only when the current file content matches `newText`, so agents that report applied edits as structured diffs can populate the collective panel without using `client.fs.writeTextFile`. Structured diffs that are preview-only, stale, missing safe rollback data, or otherwise not applied to disk remain inline in the tool block and do not get accept/discard actions. The diff summary panel shows changed files, line statistics, and actions:

- review a file in VS Code diff view;
- accept one pending change;
- discard one pending change;
- accept all pending changes;
- discard all pending changes.

`vscode-acp-chat.enableDiffSummary` controls whether the collective changed-files panel is posted to the webview. Structured diffs are best-effort and shape-driven: malformed diffs, diffs without safe rollback data, and diffs whose `newText` does not match the file on disk are skipped for the actionable summary.

In multi-session mode, file mutations are coordinated per session. Accept/discard checks verify that the file still matches the session’s expected version; after a write, other sessions' pending diffs can be marked stale or conflicted.

### Agent session toolbar

The session toolbar is capability-driven. If an agent advertises modes, models, generic config options, available commands, or context usage, the webview displays the relevant selector or usage control. Bundled Pi exposes its thinking selector through the `thought_level` config option only, preventing duplicate mode/config thinking controls while still preserving legacy setter compatibility.

Supported controls:

- mode dropdown;
- model dropdown with starred-model preference support;
- generic config-option dropdowns;
- context usage ring with optional cost information;
- send/stop state tied to active generation.

Mode/model/config selections are sent back to the ACP agent and persisted as agent preferences where applicable.

### Concurrent multi-session chat

Multi-session is enabled by default through `vscode-acp-chat.multiSession.enabled`. When enabled, `ChatViewProvider` attaches `MultiSessionHostController` and routes both feature messages and compatible core chat messages to it.

User-visible behavior:

- multiple local sessions can be created from commands, the chat header, QuickPick, or the dedicated **ACP Sessions** manager panel;
- the initial restored/opened draft session eagerly starts its ACP runtime when the chat webview is ready, but does not create an ACP session/history entry until a prompt or explicit session action needs one;
- each session has independent transcript, draft, scroll state, ACP runtime, metadata, permissions, diffs, unread count, and status;
- the chat webview shows only the active session detail plus compact aggregate counts; the separate manager panel shows running, idle, draft, permission-waiting, error, and closed sessions;
- started and loaded sessions show the full ACP session id in manager metadata and its hover tooltip for debugging/resume traceability;
- `vscode-acp-chat.switchSession` opens a native QuickPick to activate an existing session and focus the existing chat view;
- `vscode-acp-chat.multiSession.maxConcurrentSessions` limits concurrently started local ACP processes; draft sessions without an eager-started runtime do not count.

Main host/webview protocol messages:

- chat webview → host: `feature.multi-session.ready`, `new`, `activate`, `stop`, `close`, `openManagerPanel`, `quickSwitch`, `resync`, `reviewPermission`, `permission.respond`;
- host → chat webview: `feature.multi-session.chatState`, `feature.multi-session.snapshot`, `feature.multi-session.delta`;
- manager panel → host: `feature.multi-session.managerReady`, `managerResync`, `new`, `activate`, `stop`, `close`, `reviewPermission`;
- host → manager panel: `feature.multi-session.managerState` summary messages.

The webview requests resync if it detects a delta sequence gap and ignores stale deltas after activation revision changes.

### Session history and retention

History support is agent-capability gated. If the selected agent supports listing/loading/deleting sessions, the extension uses native ACP session APIs. The local `AgentSessionManager` also records session metadata per agent so agents without native `session/list` can still show locally known sessions where load is possible. Loaded history sessions use the catalog/user-provided title when one is available; otherwise their fallback title uses the full ACP session id, and the manager metadata still shows the full id. The bundled Pi adapter defaults `vscode-acp-chat.pi.historyLoadMode` to `full`, replaying the active-path transcript from Pi JSONL session files during `session/load`; `compacted` preserves the previous behavior of replaying Pi's compacted `get_messages` RPC response. Full replay is display-only and does not resend the raw transcript to the model when continuing a chat.

Commands:

- `vscode-acp-chat.loadHistory` — Quick Pick of available sessions; can delete from the picker when supported.
- `vscode-acp-chat.deleteHistorySession` — dedicated deletion picker.

Persistence settings:

- `vscode-acp-chat.enablePersistentSessions` — persist local session records in VS Code global state; otherwise keep them in memory only.
- `vscode-acp-chat.sessionRetentionDays` — delete old local records during cleanup.
- `vscode-acp-chat.maxSessionsPerAgent` — cap local records per agent.

Important boundary: the extension stores local session metadata and relies on the ACP agent to replay full conversation history during `session/load`; full transcript persistence is not implemented as an extension-owned database.

### MCP server forwarding

When `vscode-acp-chat.passMcpServers` is true, the ACP client reads MCP server definitions from VS Code MCP configuration and includes compatible servers in `session/new` and `session/load` requests.

Supported transports:

- `stdio` — always convertible to ACP MCP server payloads;
- `http` — forwarded only when the agent advertises HTTP MCP capability;
- `sse` — forwarded only when the agent advertises SSE MCP capability.

Server names are sanitized and deduplicated per request before forwarding. If the setting is disabled, no MCP server definitions are sent.

### Document synchronization

`DocumentSyncManager` forwards local `file:` scheme document events to agents that advertise NES document capabilities and only when `vscode-acp-chat.enableDocumentSync` is enabled.

Supported notifications:

- `didOpen` with full document text, language id, and version;
- `didChange` with 100 ms debounce and either full or incremental payloads based on agent capability;
- `didClose`;
- `didSave`;
- `didFocus` with cursor position, version, and visible range.

Virtual, untitled, and non-file documents are intentionally excluded. In multi-session mode, document sync is rebound to the active connected ACP session.

### Transcript navigation helpers

Two webview-only features improve navigation without changing host protocol:

- prompt-history navigation: plain Up/Down at the first/last logical line cycles prior visible user-message drafts and restores the pre-navigation draft;
- assistant-turn navigation: previous/next icon controls in the multi-session header, or the message-container fallback when the header is absent, scroll between completed assistant responses. The feature keeps an `Assistant n / total` counter for accessibility/state, anchors navigation on the first `.block-text` of the target response so the answer starts at the top of the transcript viewport, and falls back to `.message.assistant` for textless turns.

Both features observe DOM state and reset when relevant input or transcript mutations occur.

### Markdown table copy

Rendered assistant Markdown tables get an inline copy toolbar. The primary action copies Markdown; a menu can copy HTML or displayed tabular text. The feature uses browser clipboard APIs and temporary copied-state feedback.

This is webview-only and has no commands or settings.

### Clickable chat resource links

Assistant Markdown text is decorated after render so high-confidence resources are clickable without changing Markdown parsing. Detected resources include `http://`, `https://`, `www.` URLs, `file://` URLs, absolute paths, explicit relative paths, workspace-style paths with file-like final segments, and common root config filenames. Inline code is linked only when the whole code span is exactly one resource candidate.

File links reuse the existing `openFile` webview message and request existence checks for auto-detected links. Web links are intercepted in the webview and opened by the extension host through `vscode.env.openExternal` after `http:`/`https:` protocol validation. Fenced code blocks, tool output, chips, buttons, table controls, and existing Markdown links are not rewrapped.

### Settings and diagnostics

`Open ACP Settings` invokes VS Code’s Settings UI filtered to this extension. Diagnostic logging is controlled by `vscode-acp-chat.debug` and logs raw ACP session update events when enabled.

There is also an internal source-registered `vscode-acp-chat.openDevTools` command for webview debugging, but it is not contributed as a normal user-facing command in `package.json`.

## Configuration reference

| Setting                                              | Default | Effect                                                                                        |
| ---------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `vscode-acp-chat.enableDiffSummary`                  | `true`  | Shows/hides the collective file-change summary panel.                                         |
| `vscode-acp-chat.multiSession.enabled`               | `true`  | Enables concurrent multi-session workflow; disabled mode uses the legacy single-session path. |
| `vscode-acp-chat.multiSession.maxConcurrentSessions` | `4`     | Caps concurrently started local ACP sessions/processes.                                       |
| `vscode-acp-chat.passMcpServers`                     | `true`  | Sends compatible VS Code MCP server configurations to agents.                                 |
| `vscode-acp-chat.enableDocumentSync`                 | `true`  | Sends local document events to capable agents.                                                |
| `vscode-acp-chat.debug`                              | `false` | Enables raw ACP session update logging.                                                       |
| `vscode-acp-chat.enablePersistentSessions`           | `true`  | Stores local session records in VS Code global state.                                         |
| `vscode-acp-chat.sessionRetentionDays`               | `30`    | Removes locally persisted session records older than this many days.                          |
| `vscode-acp-chat.maxSessionsPerAgent`                | `300`   | Caps locally persisted session records per agent.                                             |
| `vscode-acp-chat.customAgents`                       | `[]`    | Defines custom ACP agent command configurations.                                              |

## Command and menu reference

| Command                                       | Palette | View title | Context menu                   | Behavior                                   |
| --------------------------------------------- | ------- | ---------- | ------------------------------ | ------------------------------------------ |
| `vscode-acp-chat.startChat`                   | Yes     | No         | No                             | Focuses chat and connects.                 |
| `vscode-acp-chat.newChat`                     | Yes     | Yes        | No                             | Creates a new chat/session.                |
| `vscode-acp-chat.clearChat`                   | Yes     | Yes        | No                             | Clears the current chat/session surface.   |
| `vscode-acp-chat.manageSessions`              | Yes     | Yes        | No                             | Opens the ACP Sessions manager panel.      |
| `vscode-acp-chat.switchSession`                | Yes     | Yes        | No                             | Opens QuickPick to switch active session.  |
| `vscode-acp-chat.loadHistory`                 | Yes     | Yes        | No                             | Lists and loads prior sessions.            |
| `vscode-acp-chat.deleteHistorySession`        | Yes     | No         | No                             | Deletes a previous session when supported. |
| `vscode-acp-chat.openSettings`                | No      | Yes        | No                             | Opens extension-scoped Settings UI.        |
| `vscode-acp-chat.selectAgent`                 | No      | Yes        | No                             | Selects an installed ACP agent.            |
| `vscode-acp-chat.sendSelectionToChat`         | No      | No         | Editor selection               | Adds selected editor text to chat.         |
| `vscode-acp-chat.sendTerminalSelectionToChat` | No      | No         | Terminal selection             | Adds selected terminal text to chat.       |
| `vscode-acp-chat.addFileToChat`               | No      | No         | Editor/Explorer file or picker | Adds a file mention to chat.               |
| `vscode-acp-chat.addFolderToChat`             | No      | No         | Explorer folder                | Adds a folder mention to chat.             |

## Implementation boundaries

- ACP agent capabilities determine whether history, MCP transports, document sync, modes, models, commands, and generic options are available.
- Multi-session is the default workflow; legacy single-session remains as a fallback when disabled by setting.
- Extension-owned persistence stores session metadata and user preferences, not complete long-term transcript bodies.
- Document sync intentionally excludes non-local and virtual documents.
- File-change review is strongest in multi-session mode because workspace mutation coordination detects stale/conflicting diffs across sessions.
