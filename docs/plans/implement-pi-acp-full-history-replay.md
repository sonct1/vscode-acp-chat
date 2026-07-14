# Implementation Plan: Pi ACP Full History Replay

| Attribute  | Value                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented / Complete                                                                                                                                                                                                             |
| Owner      | TBD                                                                                                                                                                                                                                |
| Scope      | Bundled Pi ACP adapter history loading, Pi JSONL transcript parsing, configurable Pi history load mode, ACP replay translation, tests, docs, VSIX verification                                                                     |
| Depends on | [Bundled Pi ACP Agent](./implement-bundled-pi-agent.md)                                                                                                                                                                            |
| References | `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`, `src/features/pi-agent/vendor/pi-acp/src/acp/pi-sessions.ts`, `src/features/pi-agent/vendor/pi-acp/src/acp/translate/pi-messages.ts`, `src/acp/session-output-pipeline.ts` |

## Objective

Fix lỗi load history với built-in Pi agent chỉ hiển thị phần cuối conversation sau khi Pi compact session.

Kết quả mong muốn:

- `session/load` của bundled Pi ACP adapter replay transcript đầy đủ từ Pi JSONL session file.
- Có setting chọn chế độ load history cho Pi, mặc định là load full từ JSONL active path.
- Conversation được hiển thị từ đầu đến cuối theo active branch/path hiện tại.
- Compaction của Pi không làm mất các message cũ trong UI history.
- Full JSONL transcript chỉ dùng cho `session/load`/UI replay, không dùng để nhồi lại toàn bộ history vào model khi chat tiếp.
- Không phụ thuộc vào global `pi-acp`; fix nằm trong vendored adapter được bundle theo plan [Bundled Pi ACP Agent](./implement-bundled-pi-agent.md).
- Existing ACP render pipeline trong extension không cần đổi lớn.

## Problem statement

Khi mở session history bằng Pi agent, VS Code ACP Chat chỉ nhận và render những message mà ACP agent replay qua `session/update`.

Hiện tại vendored `pi-acp` trong bundled Pi plan đang replay history bằng:

```ts
const data = await proc.getMessages();
const messages = Array.isArray(data?.messages) ? data.messages : [];
```

`proc.getMessages()` gọi Pi RPC `get_messages`. Với Pi, RPC này trả `session.agent.state.messages`, tức resolved in-memory context sau `buildSessionContext()`. Sau compaction, danh sách này chỉ còn:

- `compactionSummary`;
- kept messages sau `firstKeptEntryId`;
- messages sau compaction.

Nó không phải raw transcript đầy đủ trong JSONL.

Evidence từ session thật `019f5e46`:

- Raw JSONL file còn `213` message entries trong `243` lines.
- File có `2` compaction entries.
- Pi RPC `get_messages` chỉ trả `10` messages: `compactionSummary: 1`, `assistant: 4`, `toolResult: 5`, `user: 0`.
- Vì `pi-acp` bỏ qua role `compactionSummary`, ACP client chỉ thấy một phần rất nhỏ ở cuối.

## Current-state analysis

### Bundled Pi agent integration

Plan [Bundled Pi ACP Agent](./implement-bundled-pi-agent.md) đã vendor `pi-acp` vào:

```text
src/features/pi-agent/vendor/pi-acp/
```

Extension build adapter riêng thành:

```text
dist/pi-acp/index.mjs
```

Built-in Pi agent chạy bundled adapter qua VS Code/Electron Node mode và chỉ cần Pi CLI `pi` trên `PATH`.

Do đó fix đúng cho built-in Pi là patch vendored `pi-acp`, không sửa global package:

```text
src/features/pi-agent/vendor/pi-acp/src/acp/*
```

User vẫn có thể override bằng `vscode-acp-chat.customAgents` `id: "pi"`. Nếu override trỏ tới global `pi-acp`, fix bundled sẽ không áp dụng.

### Pi session storage

Pi raw session files nằm dưới:

```text
~/.pi/agent/sessions/**/*.jsonl
```

hoặc custom dir qua Pi setting `sessionDir`, đã được `pi-acp` xử lý trong `getPiSessionsDir()`.

`src/features/pi-agent/vendor/pi-acp/src/acp/pi-sessions.ts` hiện đã có:

- `listPiSessions()` để scan JSONL files;
- `findPiSession(sessionId)` để lấy `sessionFile`;
- metadata parsing cho `cwd`, `title`, `updatedAt`.

### Pi JSONL active path

Pi session file version hiện tại lưu entries dạng tree:

- mỗi entry có `id` và `parentId`;
- active leaf hiện được Pi chọn là last entry trong file;
- active conversation path là chain từ leaf về root theo `parentId`, rồi đảo lại root → leaf.

Compaction entry không xóa raw JSONL message entries cũ. Nếu reconstruct bằng active path và lấy các `message` entries theo thứ tự, UI có thể replay đầy đủ conversation từ đầu.

### Extension render behavior

Extension history pipeline đã phù hợp với ACP replay:

- `user_message_chunk` chỉ được xử lý khi `isLoadingHistory = true`;
- trước assistant/tool content, host flush user buffer thành `userMessage`;
- final `streamEnd(history_load)` được extension gửi sau khi queue drain.

Vì vậy fix nên nằm ở ACP agent replay source, không phải webview/render layer.

## Architecture decisions

### 1. Do not use Pi RPC `get_messages` for default full history replay

`get_messages` là compacted context cho continuation, không phải full UI transcript. Vì vậy ở chế độ mặc định `full`, history replay không dùng RPC này làm nguồn chính.

`loadSession()` vẫn cần spawn/restore Pi process để:

- reattach session cho future prompts;
- nhận model/config/mode state;
- keep adapter lifecycle consistent.

Nhưng history replay phải đọc từ `stored.sessionFile` / `findPiSession(sessionId).sessionFile`.

### 2. Reconstruct active-path transcript, not every line blindly

Không replay toàn bộ file theo line order vì JSONL có thể chứa abandoned branch entries.

Algorithm:

1. Parse JSONL entries into array and `Map<id, entry>`.
2. Determine leaf:
   - prefer last non-session entry with string `id`;
   - fallback to last entry with string `id`;
   - fallback to sequential mode for legacy entries without ids.
3. Walk `parentId` chain from leaf to root.
4. Reverse path to chronological order.
5. Extract visible replay messages from path.

This mirrors Pi `SessionManager.getBranch()` behavior while intentionally not applying compaction truncation.

### 3. Compaction entries do not truncate UI replay

For full history UI replay, `compaction` entries are metadata and should not replace earlier messages with summary.

Behavior:

- Include raw `message` entries before and after compaction if they are on active path.
- Skip `compaction` entries themselves in initial implementation.
- Optional future enhancement: show compaction summary as a lightweight marker, but not as replacement for raw history.

### 4. Chat continuation still uses Pi compacted context

This fix must not change how Pi continues a session after `session/load`.

When the user sends a new prompt in a loaded session:

- the adapter restores/reattaches the Pi process as today;
- the adapter sends only the new prompt/ACP request into that restored Pi session;
- Pi builds model context with its existing `buildSessionContext()` / compaction behavior;
- after compaction, the model context is expected to contain the compaction summary, kept/recent messages, recent tool state/results as Pi chooses, and the new prompt;
- the adapter must not read the full JSONL transcript and resend it to the model.

Therefore raw JSONL replay is a display/history-loading concern only. It restores UI visibility of old turns without changing Pi compaction semantics or model prompt construction.

### 5. Reuse existing Pi-to-ACP translation for visible messages

Keep current mapping semantics as much as possible:

| Pi message role | ACP replay                                                               |
| --------------- | ------------------------------------------------------------------------ |
| `user`          | `user_message_chunk` with normalized text                                |
| `assistant`     | `agent_message_chunk` with normalized text                               |
| `toolResult`    | synthetic `tool_call` then `tool_call_update` using `toolResultToText()` |

Initial fix should not expand UI semantics for roles that were previously skipped unless needed for full history correctness.

Potential later mappings:

- `custom_message` with `display: true` → user/system-like text chunk;
- `branch_summary` → summary marker;
- image content blocks → ACP image content.

### 6. Parser must be local to vendored adapter

Do not import Pi internals from `@earendil-works/pi-coding-agent` at runtime.

Reasons:

- The adapter is bundled separately and should only require the `pi` CLI executable.
- Pi package path/version is not guaranteed to be importable from the extension runtime.
- The needed logic is small and stable: parse JSONL, follow `id`/`parentId`.

### 7. Preserve upstream provenance

Because this is a local patch to vendored `pi-acp`, update:

```text
src/features/pi-agent/vendor/pi-acp/UPSTREAM.md
```

Add local patch note describing full-history replay from JSONL.

### 8. Add configurable Pi history load mode, default `full`

Add a VS Code setting for the built-in Pi agent:

```json
"vscode-acp-chat.pi.historyLoadMode": {
  "type": "string",
  "enum": ["full", "compacted"],
  "default": "full",
  "description": "Pi session history load mode. 'full' replays the full active-path transcript from Pi JSONL files; 'compacted' uses Pi RPC get_messages compatibility mode."
}
```

Mode semantics:

- `full`: default behavior. Read raw Pi JSONL, reconstruct active path, replay all visible messages; fall back to RPC `get_messages` only when the JSONL file cannot be read or has no replayable messages.
- `compacted`: compatibility/escape-hatch behavior. Use Pi RPC `get_messages` as the primary replay source, matching the current compacted-history behavior and avoiding full JSONL replay cost.

Implementation notes:

- Contribute the setting in `package.json` under the existing `vscode-acp-chat` configuration namespace.
- Read and validate the setting in extension host code when constructing the built-in Pi agent config.
- Pass the normalized mode to the bundled adapter through an environment variable such as `VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE`.
- The vendored adapter validates the env value defensively; unknown or missing values resolve to `full`.
- Setting applies to the built-in bundled Pi agent. A custom `vscode-acp-chat.customAgents` override with `id: "pi"` still replaces the bundled agent and must implement/pass equivalent behavior itself.
- Changing the setting applies to newly spawned Pi ACP processes/session loads; if an old Pi ACP process is already active, start a new chat/reload window before relying on the new mode.

## Proposed file changes

```text
package.json
  # contributes vscode-acp-chat.pi.historyLoadMode setting with default "full"

src/acp/agents.ts
  # ensures built-in Pi agent config reflects the current normalized history load mode instead of a stale module-load value

src/features/pi-agent/host.ts
  # defines/reads Pi history load mode and passes it to bundled adapter env

src/features/pi-agent/vendor/pi-acp/src/acp/pi-history-load-mode.ts
  # shared adapter-side mode type/env parsing with default "full"

src/features/pi-agent/vendor/pi-acp/src/acp/pi-session-transcript.ts
  # new parser/reconstructor for Pi JSONL active-path transcript

src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts
  # loadSession uses selected mode: JSONL full replay by default, RPC get_messages for compacted mode/fallback

src/features/pi-agent/vendor/pi-acp/src/acp/translate/pi-messages.ts
  # optional helper tweaks for text/image/custom content normalization

src/features/pi-agent/vendor/pi-acp/test/unit/pi-history-load-mode.test.ts
  # mode/env normalization tests, including invalid value fallback to full

src/features/pi-agent/vendor/pi-acp/test/unit/pi-session-transcript.test.ts
  # parser/active-path/compaction regression tests

src/features/pi-agent/vendor/pi-acp/test/component/session-list-and-load.test.ts
  # default full mode uses JSONL transcript, not fake getMessages compacted response

src/features/pi-agent/vendor/pi-acp/test/component/session-load-mode.test.ts
  # compacted mode uses RPC getMessages as primary source

src/features/pi-agent/vendor/pi-acp/test/component/session-load-toolresult.test.ts
  # keep/adjust historic toolResult replay coverage

src/features/pi-agent/vendor/pi-acp/UPSTREAM.md
  # record local patch

README.md / docs/features/feature-catalog.md
  # update Pi history behavior and configurable load mode if implementation changes user-visible docs
```

## Implementation phases

### Phase 1: Add raw transcript reader

Create `pi-session-transcript.ts` with exported API:

```ts
export type PiReplayMessage =
  | { role: "user"; content: unknown }
  | { role: "assistant"; content: unknown }
  | { role: "toolResult"; message: unknown };

export function readPiSessionTranscript(sessionFile: string): PiReplayMessage[];
```

Implementation requirements:

- Read JSONL line-by-line or bounded streaming; avoid assuming the whole file is tiny.
- Skip malformed lines without failing the entire replay.
- Validate objects defensively.
- Build `byId` only for entries with string `id`.
- For v2/v3 tree entries, follow active path by `parentId`.
- For legacy/no-id entries, fall back to file-order message entries.
- Return only visible replay messages.

Acceptance criteria:

- A session with compaction still returns messages before `firstKeptEntryId` if they are ancestors of the leaf.
- Abandoned branch messages not on the leaf path are not returned.
- Malformed/non-message metadata lines do not break replay.

### Phase 2: Add setting and switch `loadSession()` replay source

Add configuration plumbing before changing replay behavior:

1. Contribute `vscode-acp-chat.pi.historyLoadMode` with enum `full | compacted` and default `full`.
2. Normalize invalid/missing values to `full` in extension host code.
3. Pass the selected mode to the bundled `pi-acp` process via `VSCODE_ACP_CHAT_PI_HISTORY_LOAD_MODE`.
4. In the vendored adapter, parse the env value with the same default/fallback behavior.

Update `PiAcpAgent.loadSession()`:

1. Resolve stored session with existing `findStoredSession()`.
2. Restore Pi process as today.
3. Branch by load mode:
   - `full`: read transcript from `stored.sessionFile`, then replay transcript messages through existing ACP update mapping.
   - `compacted`: skip JSONL transcript replay and read compacted messages from RPC `proc.getMessages()` as primary source.
4. In `full` mode, use `proc.getMessages()` only as fallback if JSONL replay fails or returns no replayable messages.

Pseudo-flow:

```ts
const loadMode = getPiHistoryLoadModeFromEnv();
let messages: PiReplayMessage[];

if (loadMode === "compacted") {
  messages = await readCompactedMessagesFromRpc(proc);
} else {
  messages = readPiSessionTranscript(stored.sessionFile);
  if (messages.length === 0) {
    messages = await readCompactedMessagesFromRpc(proc);
  }
}

await replayPiMessages(session.sessionId, messages);
```

Fallback should log a warning to stderr/debug output, not silently hide parser failures if debug is enabled.

Acceptance criteria:

- Default setting value is `full`.
- In `full` mode, `loadSession()` does not call `proc.getMessages()` when JSONL replay succeeds.
- In `compacted` mode, `loadSession()` uses `proc.getMessages()` as primary source and can reproduce current compacted-history behavior.
- Existing behavior remains available for unusual sessions where raw file cannot be read.
- ACP update ordering stays identical: user → assistant/tool updates in transcript order.

### Phase 3: Preserve tool replay behavior

Keep current synthetic tool replay:

```text
toolResult
  -> tool_call(status=completed)
  -> tool_call_update(status=completed|failed)
```

Requirements:

- Stable `toolCallId` from Pi message if present.
- Generated UUID fallback if missing.
- `toolName` fallback to `tool`.
- `toolResultToText()` still prefers `details.diff` for edit/write history.

Acceptance criteria:

- Existing tool history tests pass.
- Historic edit/write diffs still render when Pi stored `details.diff`.

### Phase 4: Regression tests for compaction

Add focused tests with synthetic JSONL.

Minimum cases:

1. **Compacted session full replay**

   JSONL path:

   ```text
   session
   message user: first prompt
   message assistant: first answer
   message user: second prompt
   message assistant: second answer
   compaction firstKeptEntryId=<second prompt or answer>
   message user: after compact
   message assistant: final answer
   ```

   Assert replay includes `first prompt` and all later messages, not only kept/post-compaction messages.

2. **No user after final compaction**

   Mirrors real failure class where compacted `get_messages` may return no user messages. Assert JSONL replay still includes early user messages.

3. **Active branch only**

   Add a side branch message that is not an ancestor of the last leaf. Assert it is not replayed.

4. **Tool result replay**

   Assert toolResult from JSONL produces both `tool_call` and `tool_call_update`.

5. **Load mode setting**

   Assert default/missing/invalid mode resolves to `full`. Assert explicit `compacted` mode does not read JSONL as primary source and uses mocked `getMessages()`.

6. **Fallback path**

   If JSONL file missing/unreadable in `full` mode, mocked `getMessages()` compacted fallback is used.

Acceptance criteria:

- Tests fail against current `proc.getMessages()`-only implementation.
- Tests pass after JSONL replay implementation.

### Phase 5: Documentation and provenance

Update vendored provenance:

```text
src/features/pi-agent/vendor/pi-acp/UPSTREAM.md
```

Add local patch note:

```md
- Patched `session/load` to replay full active-path transcript from Pi JSONL session files instead of Pi RPC `get_messages`, because `get_messages` returns compacted in-memory context after Pi compaction.
```

If user-facing docs mention Pi history, update them to state:

- Built-in Pi uses bundled adapter.
- Pi history load mode is controlled by `vscode-acp-chat.pi.historyLoadMode`; default is `full`.
- `full` replays the full active-path JSONL transcript; `compacted` keeps compatibility with RPC `get_messages` compacted replay.
- Full history replay requires using built-in Pi or a custom adapter containing this patch.
- Remove old `customAgents` `id: "pi"` override if it still points to global `pi-acp`.

## Completion notes

Implemented on 2026-07-14. The bundled Pi adapter now defaults to full JSONL active-path history replay, exposes `vscode-acp-chat.pi.historyLoadMode`, preserves compacted RPC replay as an opt-in/fallback, keeps synthetic toolResult replay, and includes unit/component coverage for mode parsing, transcript reconstruction, fallback, compacted mode, and tool results. Documentation and vendored provenance were updated to describe the local patch and user-facing setting.

## Verification plan

Required automated checks:

```bash
npm run check-types
node --import tsx --test src/features/pi-agent/vendor/pi-acp/test/unit/pi-history-load-mode.test.ts
node --import tsx --test src/features/pi-agent/vendor/pi-acp/test/unit/pi-session-transcript.test.ts
node --import tsx --test src/features/pi-agent/vendor/pi-acp/test/component/session-list-and-load.test.ts
node --import tsx --test src/features/pi-agent/vendor/pi-acp/test/component/session-load-mode.test.ts
node --import tsx --test src/features/pi-agent/vendor/pi-acp/test/component/session-load-toolresult.test.ts
npm test
npm run package
npx vsce package --out /tmp/vscode-acp-chat-pi-history-replay.vsix
unzip -l /tmp/vscode-acp-chat-pi-history-replay.vsix | grep 'dist/pi-acp/index.mjs'
code --install-extension /tmp/vscode-acp-chat-pi-history-replay.vsix --force
```

Manual checks:

1. Remove/disable old custom agent override:

   ```json
   {
     "id": "pi",
     "command": "pi-acp"
   }
   ```

2. Ensure selected agent is built-in `Pi`.
3. Ensure `vscode-acp-chat.pi.historyLoadMode` is unset or set to `full`.
4. Load session `019f5e46` or another compacted Pi session from history.
5. Verify early user prompts and assistant replies from before compaction are visible.
6. Set `vscode-acp-chat.pi.historyLoadMode` to `compacted`, start a fresh Pi ACP process/session load, and verify legacy compacted replay behavior is used.
7. Set the mode back to `full` before final verification.
8. Verify tool calls still render in order.
9. Continue the loaded session with a new prompt to ensure restored Pi process still works.
10. Run `Developer: Reload Window` after installing the VSIX.

## Risks and mitigations

| Risk                                                                     | Impact | Mitigation                                                                                                                                   |
| ------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Replaying full raw history increases render time for very large sessions | Medium | Keep this fix correctness-focused; pair with [Fast Chat History Loading](./implement-fast-chat-history-loading.md) for batching/performance. |
| Parser accidentally replays abandoned branch messages                    | High   | Reconstruct active path via `parentId`; add active-branch test.                                                                              |
| Parser misses legacy sessions without ids                                | Medium | Add file-order fallback for no-id entries.                                                                                                   |
| Raw JSONL schema changes in future Pi versions                           | Medium | Defensive parsing; fallback to RPC `get_messages`; keep patch documented in `UPSTREAM.md`.                                                   |
| User still uses custom global `pi-acp` override                          | Medium | Document that bundled fix applies only when old `customAgents` override is removed or updated.                                               |
| ToolResult entries lack enough metadata to pair with original tool call  | Low    | Preserve current synthetic tool call behavior with UUID fallback.                                                                            |
| Full replay includes sensitive old content that compacted context hid    | Low    | This is expected for explicit history viewing; do not log transcript content in debug/perf logs.                                             |
| Setting changes are not reflected in an already-running adapter process  | Low    | Document that mode changes apply to newly spawned Pi ACP processes; advise new chat/reload when switching modes.                             |
| Users select `compacted` and still see truncated history                 | Low    | Describe `compacted` as a compatibility/escape-hatch mode that intentionally matches current compacted replay behavior.                      |

## Out of scope

- Changing Pi CLI/RPC `get_messages` behavior upstream.
- Publishing a new global `pi-acp` npm package.
- Replacing extension history render pipeline with batched snapshots.
- Implementing fast Markdown/diff rendering for large histories.
- Reconstructing deleted branch histories outside the current active path.
- Changing Pi compaction semantics for future model context.
- Sending the full raw JSONL transcript back to the model when continuing a compacted session.
- Adding a per-session UI toggle/dropdown for history load mode; this plan uses a VS Code setting.

## Definition of Done

- Bundled Pi `session/load` defaults to replaying from raw JSONL active path.
- `vscode-acp-chat.pi.historyLoadMode` exists, defaults to `full`, and supports `compacted` compatibility mode.
- Compacted Pi sessions show messages from before the final compaction in `full` mode.
- `proc.getMessages()` is not the primary replay source in `full` mode.
- Regression tests cover compacted history, branch filtering, tool results, and fallback.
- `UPSTREAM.md` records the local patch.
- Typecheck, targeted tests, full test suite, production build, VSIX package content check, and local install complete successfully.
