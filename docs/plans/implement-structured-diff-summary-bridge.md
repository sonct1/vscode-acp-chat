# Structured Diff Summary Bridge Implementation Plan

| Attribute  | Value |
| ---------- | ----- |
| Status     | Implemented |
| Owner      | TBD |
| Scope      | Extension Host, ACP tool-call output handling, diff tracking, multi-session routing, tests, docs |
| References | `src/views/chat.ts`, `src/acp/session-output-pipeline.ts`, `src/acp/diff-manager.ts`, `src/acp/file-handler.ts`, `src/features/multi-session/host.ts`, `src/views/webview/widget/diff-summary.ts` |

## Mục tiêu

Đảm bảo `Diff summary panel` hiển thị cho mọi file change có structured diff hợp lệ, không chỉ các write đi qua ACP client request `client.fs.writeTextFile`.

Sau thay đổi, nếu agent/tool hoàn tất với content dạng:

```ts
{
  type: "diff",
  path: "src/example.ts",
  oldText: "before...",
  newText: "after..."
}
```

thì host sẽ đưa change này vào `DiffManager`, từ đó webview nhận `diffSummary` và panel tổng hợp phía dưới chat hiển thị file pending để review/accept/discard.

## Hiện trạng

### Luồng đã hiện panel

```text
ACP agent
  └─ calls client.fs.writeTextFile
       └─ ACPClient.setOnWriteTextFile
            └─ FileHandler.handleWriteTextFile()
                 ├─ snapshot old file content
                 ├─ write file to disk
                 └─ DiffManager.recordChange(path, oldText, newText)
                      └─ onDidChange
                           └─ host sends { type: "diffSummary", changes }
                                └─ DiffSummary panel renders
```

Relevant code:

- `src/views/chat.ts` binds `setOnWriteTextFile()` to `FileHandler.handleWriteTextFile()`.
- `src/acp/file-handler.ts` writes the file and calls `diffManager.recordChange(...)`.
- `src/views/chat.ts` and `src/features/multi-session/host.ts` listen to `DiffManager.onDidChange()` and emit `diffSummary`.

### Luồng chưa hiện panel

```text
ACP agent
  └─ sends completed tool_call/tool_call_update with content[{ type: "diff" }]
       └─ ChatViewProvider.completeToolCall()
          or SessionOutputPipeline.completeToolCall()
             └─ webview receives toolCallComplete
                  └─ ToolBlock renders inline diff only
```

`content[{ type: "diff" }]` hiện chỉ phục vụ inline diff trong tool block. Nó không được record vào `DiffManager`, nên bottom `Diff summary panel` không biết có pending file change.

## Target behavior

Khi `toolCallComplete` có structured diff hợp lệ:

```text
completed tool call
  ├─ inline diff vẫn render trong transcript như hiện tại
  └─ structured diff bridge records into DiffManager
       └─ diffSummary panel shows/updates pending files
```

Yêu cầu hành vi:

- Giữ nguyên inline diff trong tool block.
- Bottom diff summary hiện với cùng file change nếu diff đủ an toàn để review/rollback.
- Không tạo duplicate pending entry nếu cùng file đã được record bởi `FileHandler`.
- Không record diff thiếu dữ liệu rollback an toàn.
- Không giả định mọi built-in/custom agent đều emit structured diff; bridge chỉ record khi `content[{ type: "diff" }]` thật sự có mặt và hợp lệ.
- Hoạt động ở cả legacy single-session và multi-session.
- Multi-session vẫn giữ ownership/conflict semantics theo session.

## Non-goals

Không xử lý các trường hợp agent sửa file nhưng không emit structured diff, ví dụ:

- sửa file qua shell command nhưng chỉ trả stdout/stderr;
- external process tự mutate workspace không báo nội dung trước/sau;
- file binary hoặc non-text diff.

Các case đó cần cơ chế snapshot/file watcher/git diff riêng, không thuộc phạm vi plan này.

Không cố làm các agent không hỗ trợ structured diff tự có diff summary. Với các agent đó, panel chỉ hiện nếu chúng đi qua `client.fs.writeTextFile` hoặc một cơ chế tracking khác đã record vào `DiffManager`.

## Built-in agent structured diff findings

`src/acp/agents.ts` hiện đăng ký các built-in agent: `opencode`, `claude-code`, `codex`, `gemini`, `goose`, `amp`, `aider`, `augment`, `kimi`, `mistral-vibe`, `openhands`, `qwen-code`, `kiro`, `cursor`, `codebuddy`, và bundled `pi`.

ACP protocol hỗ trợ `ToolCallContent` variant dạng:

```ts
{
  type: "diff",
  path: "/absolute/path/src/example.ts",
  oldText: "before...", // optional trong schema, null cho file mới
  newText: "after..."
}
```

Tuy nhiên support là theo từng adapter/version, không phải đảm bảo chung cho mọi built-in agent. Custom agents cũng có thể override built-in agent cùng `id`, nên behavior thực tế phụ thuộc cấu hình người dùng.

| Agent group | Current finding | Bridge implication |
| ----------- | --------------- | ------------------ |
| `pi` | Confirmed native structured diff emission in bundled adapter for file write/edit mutations. | Record completed tool diffs when present; keep `client.fs.writeTextFile` path for ACP fs writes. |
| `opencode` | Confirmed native `type: "diff"` blocks for edit/write tool content. | Record when present. |
| `claude-code` | Confirmed native diff blocks for write/edit tool calls. | Record when present. |
| `codex` | Confirmed `@agentclientprotocol/codex-acp` maps file-change events into `ToolCallContent` diff blocks. | Record when present. |
| `gemini`, `qwen-code`, `kimi` | Evidence of ACP structured diff mapping in current public adapters. | Record when present; keep validation strict because output shape/version may drift. |
| `goose`, `codebuddy` | No clear evidence of native diff content in tool completion; these may rely on ACP fs/file-operation proxy instead. | Existing `FileHandler.handleWriteTextFile()` flow remains required. |
| `amp`, `aider`, `augment`, `mistral-vibe`, `openhands`, `kiro`, `cursor`, custom agents | Not confirmed or version-dependent. | Treat bridge as best-effort only; do not depend on these agents emitting structured diffs. |

Plan consequence:

- The bridge must be capability-shape driven, not agent-id driven.
- No special allowlist/denylist should be added for built-in agents.
- `client.fs.writeTextFile` tracking remains first-class because some agents may never emit `content[{ type: "diff" }]`.
- Tool/shell edits without ACP fs writes or structured diff remain outside MVP scope.

## Thiết kế đề xuất

### 1. Thêm helper bridge dùng chung

Tạo helper host-side, ví dụ:

```text
src/acp/structured-diff-recorder.ts
```

Trách nhiệm:

- nhận `content` từ completed tool call;
- lọc các item `type: "diff"`;
- validate shape;
- normalize path;
- record vào `DiffManager`;
- optional notify write coordinator trong multi-session để đánh dấu stale/conflict cho session khác.

API đề xuất:

```ts
export interface StructuredDiffRecordOptions {
  cwd: string;
  diffManager: DiffManager;
  onDidRecord?: (path: string, oldText: string | null, newText: string) => void;
}

export function recordStructuredDiffsFromContent(
  content: unknown,
  options: StructuredDiffRecordOptions
): number;
```

### 2. Validate dữ liệu trước khi record

Chỉ record khi đủ điều kiện:

| Field | Điều kiện | Lý do |
| ----- | --------- | ----- |
| `type` | bằng `"diff"` | đúng structured diff item |
| `path` | `string`, non-empty | cần file target |
| `newText` | `string` | cần expected final file content |
| `oldText` | `string` hoặc `null` | rollback/review an toàn |

Không record nếu `oldText === undefined`.

Lý do: `oldText: null` đang có nghĩa là file mới, rollback sẽ delete file. Nếu ép `undefined` thành `null`, discard có thể xoá nhầm file đã tồn tại.

### 3. Normalize path

Structured diff từ agent có thể dùng relative path, trong khi `DiffManager` và VS Code diff actions cần absolute path.

Helper phải normalize:

```text
if path is absolute:
  use path as-is
else:
  resolve path against cwd/workspace root
```

Yêu cầu:

- Single-session dùng `getWorkspaceRoot()` làm `cwd`.
- Multi-session dùng `session.cwd`.
- `relativePath` khi gửi webview vẫn dùng `vscode.workspace.asRelativePath(normalizedPath)` như hiện tại.

### 4. Chống duplicate/no-op trong DiffManager

Hiện `DiffManager.recordChange()` nếu có pending change cùng path thì giữ `oldText` cũ và update `newText`. Hành vi này phù hợp khi:

- `FileHandler` đã record trước;
- completed tool call sau đó emit cùng structured diff;
- một file bị sửa nhiều lần trong cùng session.

Nên bổ sung no-op guard để tránh notify dư:

```ts
if (
  existing?.status === "pending" &&
  existing.oldText === oldText &&
  existing.newText === newText
) {
  return;
}
```

Không thay đổi semantics hiện tại: nếu existing pending khác `newText`, vẫn update `newText` và giữ base `oldText` ban đầu.

### 5. Single-session hook

File: `src/views/chat.ts`

Trong `completeToolCall()`, sau khi content đã được final/enrich và trước `postMessage({ type: "toolCallComplete", ... })`, gọi helper:

```ts
recordStructuredDiffsFromContent(content, {
  cwd: getWorkspaceRoot(),
  diffManager: this.diffManager,
});
```

Luồng mới:

```text
tool_call_update completed
  └─ completeToolCall()
       ├─ merge previous tool state
       ├─ enrich missing diff when possible
       ├─ recordStructuredDiffsFromContent(content, single-session DiffManager)
       │    └─ emits diffSummary if change recorded
       └─ post toolCallComplete for inline rendering
```

### 6. Multi-session hook

Có hai lựa chọn, ưu tiên lựa chọn A.

#### Lựa chọn A — callback từ SessionOutputPipeline

File: `src/acp/session-output-pipeline.ts`

Thêm callback vào `SessionOutputPipelineOptions`:

```ts
onStructuredDiffContent?: (content: unknown) => void;
```

Trong `completeToolCall()`, sau khi content đã final/enrich và trước `this.options.emit(...)`:

```ts
this.options.onStructuredDiffContent?.(content);
```

File: `src/features/multi-session/host.ts`

Khi tạo `SessionOutputPipeline`, truyền callback:

```ts
onStructuredDiffContent: (content) => {
  recordStructuredDiffsFromContent(content, {
    cwd: session.cwd,
    diffManager: resources.diffManager,
    onDidRecord: (path, oldText, newText) =>
      this.mutationCoordinator.didWrite(
        session.localSessionId,
        path,
        oldText,
        newText
      ),
  });
}
```

Ghi chú: cần cân nhắc tránh double `didWrite` khi cùng change đã được `FileHandler` ghi nhận. Có thể chỉ gọi `onDidRecord` khi helper thật sự tạo/update pending change, không gọi khi no-op duplicate.

Luồng mới:

```text
per-session ACP completed tool call
  └─ SessionOutputPipeline.completeToolCall()
       ├─ enrich content diff
       ├─ onStructuredDiffContent(content)
       │    └─ record into that session's DiffManager
       │         └─ host appends session-scoped diffSummary
       └─ emit toolCallComplete into that session transcript
```

#### Lựa chọn B — intercept emitted `toolCallComplete` trong host

Có thể inspect message trong `emit: (message) => ...` ở `MultiSessionHostController` trước khi append. Không khuyến nghị vì:

- trộn presentation routing với diff side-effect;
- khó tái sử dụng cho single-session;
- callback rõ intent hơn và test dễ hơn.

## Tương tác với conflict/stale trong multi-session

Multi-session hiện có `WorkspaceMutationCoordinator` để:

- serialize write theo path;
- nhận `didWrite(ownerId, path, oldText, newText)`;
- mark pending diff của session khác là stale/conflicted;
- bảo vệ accept/rollback bằng so sánh current file content.

Structured diff bridge nên tích hợp với cơ chế này để structured diff cũng có ownership như `FileHandler` write.

Cần quyết định implementation detail:

- Nếu structured diff đại diện cho thay đổi đã thực sự ghi ra disk, gọi `didWrite()` để session khác được mark stale.
- Nếu structured diff chỉ là preview chưa apply, không nên gọi `didWrite()`.

Theo ACP tool completion hiện tại, inline diff được tạo từ after-state hoặc tool result sau khi tool hoàn tất, nên MVP giả định structured diff là applied change. Nếu phát hiện agent nào emit preview-only diff, cần thêm guard/capability sau.

## Task list

### Phase 1 — Shared recorder helper

**Description:** Tạo helper parse/validate/normalize/record structured diff content.

**Acceptance criteria:**

- [ ] Bỏ qua `content` không phải array.
- [ ] Bỏ qua item không phải object hoặc `type !== "diff"`.
- [ ] Bỏ qua diff thiếu `path`, `newText`, hoặc `oldText` hợp lệ.
- [ ] Không ép `oldText: undefined` thành `null`.
- [ ] Resolve relative path theo `cwd`.
- [ ] Return số diff đã record/update.

**Verification:**

- [ ] Unit tests cho valid absolute path.
- [ ] Unit tests cho valid relative path.
- [ ] Unit tests cho `oldText: null` file mới.
- [ ] Unit tests cho `oldText: undefined` bị skip.
- [ ] Unit tests cho malformed items bị skip.

**Files likely touched:**

- `src/acp/structured-diff-recorder.ts`
- `src/test/structured-diff-recorder.test.ts` hoặc suite test tương ứng

### Phase 2 — DiffManager duplicate/no-op hardening

**Description:** Giảm notify dư khi bridge gặp diff đã được record bởi `FileHandler`.

**Acceptance criteria:**

- [ ] `recordChange()` no-op khi pending change cùng `path`, `oldText`, `newText`.
- [ ] Pending change cùng path nhưng `newText` khác vẫn update `newText` và giữ base `oldText` cũ.
- [ ] Existing tests không đổi semantics accept/rollback/clear.

**Verification:**

- [ ] Add/adjust `src/test/diff_manager.test.ts`.

**Files likely touched:**

- `src/acp/diff-manager.ts`
- `src/test/diff_manager.test.ts`

### Phase 3 — Single-session integration

**Description:** Record structured diff content trong legacy `ChatViewProvider.completeToolCall()`.

**Acceptance criteria:**

- [ ] Completed tool call có `content[{ type: "diff" }]` tạo pending change trong `this.diffManager`.
- [ ] Host gửi `diffSummary` khi setting `vscode-acp-chat.enableDiffSummary` bật.
- [ ] Inline tool diff vẫn render như trước.
- [ ] Setting tắt thì không post bottom summary dù `DiffManager` có update, giữ behavior hiện tại.

**Verification:**

- [ ] Unit/integration test cho `ChatViewProvider` hoặc extracted helper path nếu test direct provider khó.
- [ ] Existing webview `diffSummary` tests pass.

**Files likely touched:**

- `src/views/chat.ts`
- `src/test/chat.test.ts` hoặc test suite phù hợp

### Phase 4 — Multi-session integration

**Description:** Thêm callback từ `SessionOutputPipeline` để multi-session record structured diff vào đúng session.

**Acceptance criteria:**

- [ ] `SessionOutputPipelineOptions` có callback optional cho structured diff content.
- [ ] Callback được gọi sau khi content đã final/enrich, trước khi emit `toolCallComplete`.
- [ ] `MultiSessionHostController` record vào `resources.diffManager` của đúng `ManagedSession`.
- [ ] Active session nhận `diffSummary`; background session lưu transcript/diff và hiển thị khi activate.
- [ ] Structured diff từ session A không lẫn sang session B.
- [ ] Conflict/stale behavior vẫn hoạt động khi nhiều session pending cùng path.

**Verification:**

- [ ] Unit test cho `SessionOutputPipeline` callback được gọi với final content.
- [ ] Multi-session test cho session-scoped `diffSummary` khi tool completion có structured diff.
- [ ] Multi-session test cho không duplicate khi writeTextFile và structured diff cùng path cùng content.

**Files likely touched:**

- `src/acp/session-output-pipeline.ts`
- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`
- tests cho pipeline nếu đã có suite phù hợp

### Phase 5 — Docs and UX wording update

**Description:** Cập nhật docs để mô tả đúng nguồn diff summary.

**Acceptance criteria:**

- [ ] `docs/architecture/acp-chat-layout.md` ghi rõ diff summary lấy pending changes từ `DiffManager`, bao gồm `client.fs.writeTextFile` và structured tool diff bridge.
- [ ] `docs/features/feature-catalog.md` cập nhật mục File-change review and diff summary: agent file writes hoặc structured diffs đều có thể vào panel.
- [ ] Không tạo feature doc mới vì đây là fix/extension của feature hiện hữu, không phải feature durable mới.

**Verification:**

- [ ] Markdown links vẫn đúng relative path.

## Test strategy

### Unit tests

- Structured diff recorder:
  - parse valid diff;
  - skip invalid shape;
  - preserve `null` vs `undefined` semantics;
  - path normalization.
- `DiffManager`:
  - no-op duplicate;
  - update same path with new final text.
- `SessionOutputPipeline`:
  - callback receives enriched content;
  - callback not called or records zero for no diff content.

### Webview/host behavior tests

- Existing `diffSummary` render tests should remain green.
- Single-session host emits `diffSummary` after tool completion with structured diff.
- Multi-session host emits session-scoped diff summary for active session and preserves background session diff state.

### Manual verification

1. Enable `vscode-acp-chat.enableDiffSummary`.
2. Run an agent/tool that emits structured diff in `toolCallComplete` without using `client.fs.writeTextFile`.
3. Confirm:
   - inline diff appears inside tool block;
   - bottom summary appears above input;
   - `Review Diff` opens VS Code native diff;
   - `Accept` removes pending entry;
   - `Discard` restores old content or deletes newly created file when `oldText === null`.
4. Repeat in multi-session:
   - session A and B edit different files;
   - switching sessions shows correct panel per session;
   - editing same file from two sessions marks stale/conflict as current implementation expects.

## Risks and mitigations

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Structured diff path is relative and not normalized | Review/rollback fails or duplicate entry appears | Normalize against session cwd/workspace root before record |
| `oldText: undefined` treated as new file | Discard may delete an existing file | Strictly skip unless `oldText` is string or `null` |
| Duplicate record from `writeTextFile` + tool diff | Extra notifications/UI flicker | Add no-op guard in `DiffManager.recordChange()` |
| Agent emits preview-only diff | Panel offers discard/accept for unapplied change | MVP assumes completed tool diff is applied; document limitation and revisit with agent-specific capability if needed |
| Agent/adapter support is uneven or version-dependent | Some built-in/custom agents still do not show bottom diff summary after direct tool/shell edits | Record by validated content shape only; keep ACP fs write tracking; document best-effort behavior |
| Multi-session stale tracking missed | Session conflicts not visible | Call coordinator `didWrite` only when structured diff is actually recorded/updated |
| Large diffs increase memory | Existing inline diff already computes LCS; bridge stores old/new in `DiffManager` too | Accept current behavior; large-diff guard belongs to readable inline diff plan |

## Rollout plan

1. Implement helper and low-level tests first.
2. Integrate single-session path and verify existing behavior.
3. Integrate multi-session path with session-scoped tests.
4. Update docs.
5. Run quality gates:
   - `npm run check-types`
   - relevant test suites (`npm test` or targeted test command used by repo)
   - `npm run package`
6. Because implementation changes extension/webview code, package/install per repository rule:
   - `npx vsce package --out <temporary-or-versioned-path>.vsix`
   - `code --install-extension <path>.vsix --force`
   - remove temporary VSIX if appropriate.

## Open questions

1. Có agent/adapter nào emit structured diff như preview chưa apply không? Nếu có, cần thêm flag/capability trước khi record vào `DiffManager`.
2. Có cần setting riêng để bật/tắt bridge không, hay dùng chung `vscode-acp-chat.enableDiffSummary` là đủ? Recommendation: dùng chung setting hiện tại.
3. Có cần giữ structured diff pending qua webview reload tốt hơn không? `DiffManager` hiện có TODO về restore bị `agentChanged` clear; đây là issue riêng, không block bridge.
