# Implement live tool and custom-tool output

## Mục tiêu

Hiển thị output của tool và custom tool ngay khi tool đang chạy trong chat của extension, thay vì chỉ hiển thị spinner rồi render output sau khi tool chuyển sang `completed` hoặc `failed`.

Phạm vi phải hỗ trợ cả hai nguồn live output chuẩn của ACP:

1. `session/update` với `sessionUpdate: "tool_call_update"`, trong đó agent cập nhật `content`, `rawOutput`, `status`, `title`, `locations` hoặc `rawInput`.
2. ACP embedded terminal, trong đó tool call chứa `{ type: "terminal", terminalId }` và output được sinh từ terminal do client quản lý.

Kết quả phải hoạt động nhất quán trong:

- Legacy single-session mode.
- Multi-session mode, bao gồm background session, snapshot replay và resync.
- Built-in tools, MCP tools và custom tools; extension không phân nhánh theo nguồn tool.

## Phân tích hiện trạng

### Luồng ACP hiện tại

```text
Agent / ACP adapter
  │
  │ session/update
  │  ├─ tool_call
  │  └─ tool_call_update
  ▼
ACPClient
  │ AsyncSerialProcessor
  ▼
Legacy: ChatViewProvider.handleSessionUpdate()
Multi-session: SessionOutputPipeline.handleSessionUpdate()
  │
  ├─ non-final → toolCallStart
  └─ final     → toolCallComplete
  ▼
Webview MessageListComponent
  ├─ toolCallStart    → summary + spinner
  └─ toolCallComplete → details/output + finalize
```

Các điểm chính:

- `src/acp/client.ts` đã nhận đầy đủ `tool_call` và `tool_call_update` qua ACP `session/update`.
- `src/views/chat.ts` và `src/acp/session-output-pipeline.ts` lưu `content`/`rawOutput` của non-final update vào tool runtime state.
- Non-final update hiện chỉ phát lại `toolCallStart`; không có message riêng để cập nhật detail/output đang chạy.
- `hasToolCallPresentation()` không xét `rawOutput`, nên update chỉ có `rawOutput` bị giữ trong host state cho đến khi tool hoàn tất.
- `src/views/webview/component/message-list.ts` chỉ đăng ký `toolCallStart` và `toolCallComplete`.
- `src/views/webview/block/tool-block.ts` chỉ render details trong `updateDetails()`; `appendContent()` hiện là no-op.
- `ToolBlock.updateDetails()` thay toàn bộ `innerHTML`, phù hợp với snapshot replacement nhưng cần throttle để tránh DOM churn.

### ACP embedded terminal hiện tại

Extension đã quảng bá:

```ts
clientCapabilities: {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
}
```

`TerminalHandler` đã hỗ trợ:

- `terminal/create`
- `terminal/output`
- `terminal/wait_for_exit`
- `terminal/kill`
- `terminal/release`

Tuy nhiên:

- stdout/stderr chỉ được append vào buffer nội bộ của `TerminalHandler`.
- Không có event từ `TerminalHandler` sang tool output pipeline.
- Tool card không subscribe terminal output.
- Nếu final tool call chỉ chứa terminal reference mà không có `rawOutput`, UI có thể chỉ nhận placeholder `[Terminal: <id>]`.

Điều này chưa đáp ứng semantics của ACP embedded terminal: client phải hiển thị output của terminal khi output được sinh ra và tiếp tục giữ output sau khi terminal được release.

### Custom tool

Extension không phân biệt built-in tool, MCP tool hay custom tool. Tất cả dùng cùng `toolCallId` và cùng lifecycle ACP.

Do đó live output chỉ khả thi khi ACP agent/adapter thực sự phát ít nhất một trong các dạng sau:

- Non-final `tool_call_update.content`.
- Non-final `tool_call_update.rawOutput`.
- Embedded terminal content với `terminalId` thuộc terminal do extension quản lý.

Nếu agent chỉ gửi một final update sau khi tool hoàn tất, extension không thể tự suy ra output trung gian. Stderr của agent process cũng không được coi là tool output vì không có quan hệ tin cậy giữa stderr chunk và `toolCallId`.

## Scope

### In scope

- Live render non-final `tool_call_update.content` và `rawOutput`.
- Live render ACP embedded terminal output.
- Giữ spinner và trạng thái running trong lúc cập nhật details.
- Render ANSI và terminal cursor-control từ full output snapshot.
- Hỗ trợ update đến trước initial `tool_call` và final-only update.
- Hỗ trợ explicit replacement/clear theo semantics của ACP update.
- Throttle/coalesce output để không flood Extension Host, webview hoặc multi-session transcript.
- Snapshot/resync đúng cho tool đang chạy trong multi-session mode.
- Giữ final output sau `terminal/release`.
- Không tăng unread count theo từng live output update của background session.
- Bổ sung automated tests và manual verification với mock ACP server.

### Out of scope

- Tự tạo live output khi agent/ACP adapter không phát progress hoặc terminal reference.
- Parse agent process stderr thành tool output.
- Xây terminal emulator tương tác đầy đủ; UI vẫn là output-only `<pre>` trong tool card.
- Cho phép nhập stdin từ tool card.
- Thay đổi ACP wire protocol hoặc thêm proprietary message gửi ngược về agent.
- Persist process hoặc terminal qua Extension Host restart.
- Thiết kế lại toàn bộ tool card UI.

## Quyết định kiến trúc

### 1. Đây là protocol compatibility change

Live tool output là hành vi chung của ACP client, không phải product-specific feature độc lập. Theo scope exception của repository, implementation có thể sửa trực tiếp các core modules liên quan:

- ACP session output projection.
- Terminal capability implementation.
- Webview tool renderer.
- Multi-session transcript routing.

Không tạo `src/features/live-tool-output/` chỉ để bọc logic protocol cốt lõi. Core integration vẫn phải nhỏ, typed và có test trực tiếp.

### 2. `SessionOutputPipeline` là source of truth cho tool presentation state

Hiện multi-session dùng `SessionOutputPipeline`, nhưng legacy mode vẫn có implementation song song trong `ChatViewProvider`.

Trước hoặc cùng lúc thêm live output, legacy mode phải được chuyển sang dùng chung pipeline, hoặc toàn bộ tool state projection phải được tách thành một helper dùng chung. Không triển khai hai live-output state machines riêng biệt.

Phương án ưu tiên:

```text
ACPClient session/update
  ▼
AsyncSerialProcessor
  ▼
SessionOutputPipeline
  ├─ user/assistant/thought projection
  ├─ tool runtime state
  ├─ tool progress scheduling
  ├─ terminal association
  └─ finalization
  ▼
emit(SessionRenderMessage)
  ├─ legacy → webview.postMessage
  └─ multi  → TranscriptStore + delta
```

`ChatViewProvider` tiếp tục sở hữu transport, permission, diff summary, webview lifecycle và session commands; pipeline sở hữu việc chuyển ACP update thành transcript/render messages.

### 3. Host gửi full replacement snapshot

Thêm host-to-webview message mới:

```ts
interface ToolCallProgressMessage {
  type: "toolCallProgress";
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status: "pending" | "in_progress";
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: ToolCallContentItem[];
  locations?: ToolCallLocation[];
  terminalOutput?: string;
  terminalTruncated?: boolean;
}
```

Đây là snapshot đầy đủ mới nhất của presentation state, không phải output fragment.

Lý do:

- ACP `ToolCallUpdate.content` có semantics thay thế collection.
- `rawOutput` là giá trị mới nhất, không được giả định là append-only string.
- Custom tool có thể đổi từ text sang object hoặc thay toàn bộ output.
- ANSI cursor control như `\r`, erase-line hoặc cursor-position cần render lại từ full terminal buffer để có kết quả đúng.
- Snapshot dễ replay và resync trong multi-session mode.

Giữ `toolCallStart` để tạo card ban đầu và `toolCallComplete` để finalize. `toolCallProgress` chỉ cập nhật card đang chạy.

### 4. Phân biệt field absent và explicit clear

ACP update cho phép chỉ gửi field thay đổi; một số field có thể là `null` để clear.

Runtime merge phải dùng property presence, ví dụ `Object.prototype.hasOwnProperty.call(update, "content")`, thay vì chỉ kiểm tra truthy hoặc `Array.isArray()`.

Quy tắc:

| Update field | Absent | Có giá trị            | `null`                                 |
| ------------ | ------ | --------------------- | -------------------------------------- |
| `title`      | Giữ cũ | Replace               | Clear/fallback                         |
| `kind`       | Giữ cũ | Replace               | Clear                                  |
| `content`    | Giữ cũ | Replace toàn bộ array | Clear array                            |
| `locations`  | Giữ cũ | Replace toàn bộ array | Clear array                            |
| `rawInput`   | Giữ cũ | Replace               | Clear                                  |
| `rawOutput`  | Giữ cũ | Replace               | Clear                                  |
| `status`     | Giữ cũ | Replace               | Giữ trạng thái runtime hợp lệ/fallback |

Không concatenate `content` hoặc `rawOutput` tại host.

### 5. Terminal output dùng event, không polling từ webview

`TerminalHandler` là nơi trực tiếp nhận stdout/stderr nên phải phát typed snapshot event:

```ts
interface TerminalSnapshot {
  terminalId: string;
  output: string;
  truncated: boolean;
  exitStatus: {
    exitCode: number | null;
    signal?: string;
  } | null;
  phase: "running" | "exited" | "released";
}
```

API dự kiến:

```ts
readonly onDidChangeTerminal: vscode.Event<TerminalSnapshot>;
getTerminalSnapshot(terminalId: string): TerminalSnapshot | undefined;
```

Yêu cầu:

- Event được phát khi stdout/stderr thay đổi, process exit và ngay trước release.
- `getTerminalSnapshot()` cho phép finalization đọc trực tiếp buffer mới nhất, không phụ thuộc timer throttle còn pending.
- `TerminalHandler` vẫn phục vụ `terminal/output` cho agent như hiện tại.
- Webview không gọi `terminal/output`; host đẩy snapshot qua tool progress pipeline.

### 6. Mapping terminal và tool call thuộc session pipeline

Mỗi `SessionOutputPipeline` duy trì state session-scoped:

```ts
terminalToToolCalls: Map<string, Set<string>>;
latestTerminalById: Map<string, TerminalSnapshot>;
```

Mỗi tool runtime state giữ terminal IDs đang được reference bởi `content`.

Khi `content` được replace:

1. Tách tất cả `{ type: "terminal", terminalId }` mới.
2. Gỡ mapping terminal cũ không còn được reference.
3. Thêm mapping mới.
4. Nếu đã có buffered terminal snapshot, schedule `toolCallProgress` ngay.

Dùng `Set<string>` thay vì mapping một-một để không giả định một terminal chỉ có thể xuất hiện trong đúng một tool call.

### 7. Throttle ở host và render replacement ở webview

Dùng scheduler theo `toolCallId`:

- Update đầu tiên có output có thể emit ngay để UI phản hồi nhanh.
- Các update tiếp theo được coalesce trong cửa sổ khoảng `100–250ms`.
- Mỗi lần flush chỉ gửi snapshot mới nhất.
- Final update cancel pending progress timer và phát duy nhất `toolCallComplete` với state mới nhất.
- Không được có `toolCallProgress` xuất hiện sau completion/cleanup.

Webview tiếp tục dùng `ToolBlock.updateDetails()` để replace details. Không append trực tiếp vào `.tool-output` vì append sẽ sai với replacement semantics và ANSI cursor control.

Khi replace details:

- Giữ `<details>` đang mở trong lúc `pending`/`in_progress`.
- Giữ spinner.
- Nếu output đang ở cuối, scroll output mới xuống cuối.
- Nếu người dùng đã scroll lên xem output cũ, cố gắng giữ `scrollTop` thay vì cưỡng bức xuống cuối.
- Event delegation hiện tại tiếp tục xử lý copy button sau mỗi DOM replacement.

### 8. Giới hạn payload live output

Live update không được gửi một buffer tăng vô hạn qua `webview.postMessage()`.

Áp dụng một UI projection limit cố định, đề xuất tối đa `1 MiB` UTF-8 cho textual live output:

- Giữ phần cuối output khi vượt limit.
- Đặt `terminalTruncated: true`.
- Render marker rõ ràng rằng phần đầu output đã bị lược bỏ.
- Không thay đổi semantics của `terminal/output` dành cho agent ngoài giới hạn `outputByteLimit` mà agent đã yêu cầu.

Đối với `content` hoặc arbitrary `rawOutput`, host phải normalize an toàn cho phần textual display và không stringify cyclic object. Existing escaping/ANSI rendering phải tiếp tục được dùng.

### 9. Multi-session progress là replaceable state, không phải durable log line

Active session vẫn nhận live delta với sequence tăng đơn điệu. Tuy nhiên transcript snapshot không được giữ hàng nghìn progress snapshots cho cùng một tool.

`TranscriptStore` cần behavior riêng:

- `toolCallProgress`: upsert progress mới nhất theo `toolCallId` trong retained/snapshot events.
- `toolCallComplete`: loại bỏ retained progress của cùng tool vì complete message đã chứa full final state.
- Delta hiện tại vẫn được gửi cho active webview sau throttle.
- Sequence counter độc lập với retained event count để gap detection vẫn chính xác.
- Background session lưu latest progress để activation/resync render đúng tool đang chạy.
- `toolCallProgress` không tăng unread count theo mỗi update; `toolCallStart`, completion hoặc assistant text vẫn có thể tạo unread signal theo behavior hiện có.

## Target flows

### ACP `tool_call_update.rawOutput/content`

```text
Agent
  │ tool_call { status: in_progress }
  ▼
SessionOutputPipeline
  │ toolCallStart
  ▼
Webview ToolBlock: spinner + summary

Agent
  │ tool_call_update { rawOutput/content/status: in_progress }
  ▼
SessionOutputPipeline
  │ merge replacement fields
  │ normalize output
  │ throttle/coalesce
  │ toolCallProgress(full snapshot)
  ▼
Webview ToolBlock
  │ updateSummary()
  │ updateDetails()
  └─ spinner remains

Agent
  │ tool_call_update { status: completed/failed }
  ▼
SessionOutputPipeline
  │ cancel pending progress
  │ refresh terminal snapshot
  │ toolCallComplete(full final snapshot)
  ▼
Webview ToolBlock
  ├─ final details
  ├─ remove spinner
  └─ finalize/collapse by existing rules
```

### ACP embedded terminal

```text
Agent ── terminal/create ──► TerminalHandler
                                │ spawn process
                                │ stdout/stderr
                                ▼
                         TerminalSnapshot event
                                │
                                ▼
                      SessionOutputPipeline cache

Agent ── tool_call/content terminalId ──► SessionOutputPipeline
                                          │ map terminalId ↔ toolCallId
                                          │ use cached output if available
                                          ▼
                                  toolCallProgress
                                          ▼
                                     ToolBlock

Terminal exits/releases
  │
  ├─ final TerminalSnapshot retained by pipeline
  └─ tool completion reads latest snapshot synchronously
```

## Runtime state đề xuất

Mở rộng `ToolCallRuntimeState`:

```ts
interface ToolCallRuntimeState {
  pending: boolean;
  completed: boolean;
  startTime?: number;
  status?: ToolCallStatus;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  kind?: string;
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  terminalIds: Set<string>;
  terminalOutput?: string;
  terminalTruncated?: boolean;
  baseContent?: Promise<string | undefined>;
  progressTimer?: ReturnType<typeof setTimeout>;
  progressDirty?: boolean;
}
```

Không nhất thiết lưu timer trực tiếp trong public interface; có thể giữ scheduler map riêng. Điều bắt buộc là lifecycle cleanup phải xóa:

- Tool state.
- Progress timer.
- Terminal-to-tool mapping.
- Cleanup timeout.

## Webview behavior

### `toolCallStart`

- Tạo hoặc reuse block theo `toolCallId`.
- Dùng status thật từ host nếu có; fallback `in_progress`.
- Render summary và raw input cơ bản.
- Nếu initial `tool_call` đã có `content`/`rawOutput`/terminal output, host phát ngay một `toolCallProgress` sau start.

### `toolCallProgress`

- Nếu chưa có block, `ensureToolBlock()` phải tạo block với fallback title `Tool`.
- Update cached title/kind/status.
- Update summary nếu metadata thay đổi.
- Replace details từ full snapshot.
- Không remove spinner.
- Không gọi `finalizeBlock()`.
- Scroll chat xuống cuối theo existing auto-scroll policy, không override khi người dùng đã chủ động scroll lên.

### `toolCallComplete`

- Cancel/ignore mọi stale progress có version cũ.
- Render full final snapshot.
- Remove spinner.
- Mark failed nếu cần.
- Finalize theo existing collapse rules.

Để chặn stale message do queue hoặc timer, có thể thêm monotonically increasing `revision` cho từng tool snapshot. Nếu scheduler luôn cancel trước final và mọi message đi qua serial queue hiện tại thì revision không bắt buộc; chỉ thêm nếu tests chứng minh có race.

## File changes dự kiến

| File                                             | Thay đổi                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/acp/session-output-pipeline.ts`             | Single tool state projector, replacement merge, `toolCallProgress`, terminal association, throttle, final flush/cleanup                          |
| `src/acp/terminal-handler.ts`                    | Terminal snapshot event, synchronous snapshot lookup, release/final event, safe output projection                                                |
| `src/views/chat.ts`                              | Chuyển legacy session updates sang shared pipeline; bỏ duplicated tool projection sau khi parity tests pass; pass `TerminalHandler` vào pipeline |
| `src/features/multi-session/host.ts`             | Pass session-scoped terminal source vào pipeline; classify progress delta/unread behavior                                                        |
| `src/features/multi-session/transcript-store.ts` | Coalesce retained `toolCallProgress` theo `toolCallId`; completion supersedes progress; preserve delta sequence                                  |
| `src/features/multi-session/contracts.ts`        | Chỉ bổ sung field/type nếu cần để typed delta/snapshot nhận progress message                                                                     |
| `src/views/webview/types.ts`                     | Thêm progress message fields; widen `rawOutput` an toàn cho custom tool output; add `terminalTruncated`                                          |
| `src/views/webview/component/message-list.ts`    | Register và handle `toolCallProgress`; preserve running lifecycle và scroll policy                                                               |
| `src/views/webview/block/tool-block.ts`          | Live detail replacement helper, output scroll preservation, optional truncated marker behavior                                                   |
| `src/views/webview/tool-render.ts`               | Render normalized live output/truncation; giữ ANSI escaping và final renderer parity                                                             |
| `src/test/chat.test.ts`                          | Legacy/shared pipeline parity và ACP progress cases                                                                                              |
| `src/test/terminal-handler.test.ts`              | Terminal snapshot events, output, exit, release, truncation                                                                                      |
| `src/test/webview.test.ts`                       | Progress rendering, no duplicate block, spinner/finalization, ANSI/XSS/scroll                                                                    |
| `src/test/features/multi-session.test.ts`        | Transcript coalescing, snapshot/resync, background unread và session isolation                                                                   |
| `src/test/mocks/acp-server.ts`                   | Demo/test mode phát delayed tool progress và embedded terminal lifecycle                                                                         |

Không thêm file mới nếu logic đủ rõ trong modules hiện tại. Chỉ extract helper như `tool-output-normalizer.ts` khi cùng normalization thực sự được dùng ở nhiều module.

## Trình tự thực hiện

### Phase 1 — Consolidate legacy và multi-session projection

1. Tạo `SessionOutputPipeline` instance cho legacy `ChatViewProvider`.
2. Wire callbacks hiện có:
   - `emit` → serialized `postMessage()`.
   - metadata update → `sendSessionMetadata()`.
   - context usage → current context usage message.
   - session info → existing title/session metadata behavior nếu có.
3. Chuyển `handleSessionUpdate()` legacy sang delegate pipeline.
4. Giữ permission, connection, stderr, diff summary và prompt lifecycle ngoài pipeline.
5. Chạy parity tests cho:
   - assistant chunks.
   - thought chunks.
   - history replay.
   - tool start/final-only/status-only completion.
   - diff enrichment.
   - usage/mode/commands.
6. Chỉ xóa duplicated legacy tool-state helpers sau khi parity tests pass.

Definition of done:

- Legacy và multi-session dùng cùng code path để chuyển tool ACP update thành render messages.
- Không thay đổi UI behavior hiện tại trước khi thêm progress.

### Phase 2 — ACP tool progress snapshots

1. Mở rộng runtime state để giữ status và replacement-aware fields.
2. Thêm helper merge phân biệt absent/null/value.
3. Thêm `toolCallProgress` message contract.
4. Phát progress cho:
   - Non-final update có `rawOutput`.
   - Non-final update có `content`.
   - Status/title/kind/input/location update cần redraw.
   - Initial `tool_call` đã có displayable output.
5. Thêm per-tool throttle/coalescing.
6. Finalization cancel pending progress và dùng full latest state.
7. Đảm bảo `finalizePendingToolCalls()` cũng dùng latest progress state.

Definition of done:

- Raw-output-only update hiển thị trước completion.
- Content update replace output cũ, không concatenate sai.
- Không có progress message sau complete.

### Phase 3 — Webview live rendering

1. Register `toolCallProgress` trong `MessageListComponent`.
2. Tạo/reuse block theo `toolCallId` kể cả update đến trước start.
3. Update summary và details từ snapshot.
4. Giữ spinner và `<details open>` khi tool đang chạy.
5. Preserve output scroll position/pinned-to-bottom behavior.
6. Render truncation marker.
7. Giữ copy button bằng event delegation hiện có.
8. Verify ANSI output, carriage return, erase-line và HTML escaping.

Definition of done:

- Cùng một tool call luôn chỉ có một tool block.
- Output thay đổi live mà không reset toàn assistant message.
- Failed/completed lifecycle vẫn hoạt động như trước.

### Phase 4 — Embedded terminal bridge

1. Thêm terminal snapshot event và synchronous lookup vào `TerminalHandler`.
2. Phát snapshot khi stdout/stderr append, process exit và release.
3. Pass terminal source vào mỗi session pipeline.
4. Track terminal references từ tool `content`.
5. Buffer output đến trước terminal-to-tool mapping.
6. Schedule progress cho mọi mapped running tool.
7. Khi complete, lấy snapshot mới nhất trực tiếp từ `TerminalHandler` hoặc pipeline cache.
8. Unbind mappings khi content replace, tool complete, session reset hoặc dispose.
9. Không phát terminal progress sau tool completion.

Definition of done:

- Embedded terminal output xuất hiện live mà agent không cần mirror vào `rawOutput`.
- Output vẫn còn trong tool card sau `terminal/release`.
- Multi-session terminal output không rò sang session khác.

### Phase 5 — Multi-session transcript và backpressure

1. Thêm coalescing rule cho `toolCallProgress` theo `toolCallId`.
2. Khi complete, loại progress snapshot đã bị supersede.
3. Giữ `nextSeq` tăng cho mỗi live delta đã phát.
4. Đảm bảo snapshot có latest progress cho tool đang chạy.
5. Đảm bảo resync sau sequence gap render đúng state mới nhất.
6. Không tăng unread count trên mỗi progress update.
7. Verify background session không tạo DOM work cho đến khi được activate.
8. Bound retained progress state và xóa khi session close.

Definition of done:

- Một tool chạy lâu không tạo transcript snapshot tăng tuyến tính theo số stdout chunks.
- Switching session vẫn thấy output mới nhất và spinner đúng.

### Phase 6 — Integration, package và local installation

1. Mở rộng mock ACP server với:
   - `tool_call` in-progress.
   - Ba delayed rawOutput/content updates.
   - Embedded terminal output có ANSI.
   - Final completed update.
2. Chạy automated tests và quality gates.
3. Build production bundle.
4. Package VSIX vào path tạm hoặc git-ignored.
5. Cài VSIX bằng `code --install-extension ... --force`.
6. Xóa temporary VSIX khi an toàn.
7. Manual test sau `Developer: Reload Window`.

## Test cases

### Session output pipeline

1. `tool_call` tạo đúng một `toolCallStart`.
2. Non-final `rawOutput`-only update phát `toolCallProgress`.
3. Non-final `content` update phát full replacement snapshot.
4. Hai `content` arrays liên tiếp không bị concatenate.
5. Explicit `content: null` clear content cũ.
6. Explicit `title: null` không giữ title cũ như một update value mới.
7. Status-only update giữ state và cập nhật status nếu cần.
8. Update đến trước initial `tool_call` vẫn tạo state/card hợp lệ.
9. Final-only update vẫn phát `toolCallComplete` đầy đủ.
10. Rapid updates được coalesce và snapshot cuối thắng.
11. Completion cancel pending progress timer.
12. `finalizePendingToolCalls()` giữ output mới nhất khi cancel/error/end turn.
13. Reset/dispose clear timers và mappings.
14. File edit diff enrichment không bị regress.

### Terminal handler và association

1. stdout và stderr đều xuất hiện trong snapshot theo thứ tự nhận.
2. Running snapshot có `exitStatus: null`.
3. Exit snapshot có exit code/signal đúng.
4. Release phát snapshot cuối trước khi xóa terminal resource.
5. `getTerminalSnapshot()` trả buffer mới nhất trước release.
6. Terminal output đến trước tool terminal reference được buffer và render sau mapping.
7. Terminal reference đến trước output render khi output xuất hiện.
8. Content replacement gỡ mapping terminal cũ.
9. Một terminal có thể update nhiều mapped tool calls mà không duplicate block.
10. Terminal update sau completion không tái mở/fát progress cho tool.
11. Output byte truncation không cắt giữa UTF-8 character.
12. UI projection limit thêm truncation marker đúng.

### Webview

1. `toolCallProgress` tạo block nếu start chưa tới.
2. Nhiều progress update cho cùng ID không tạo block mới.
3. Spinner vẫn tồn tại trong progress.
4. Details được replace bằng snapshot mới nhất.
5. Raw input vẫn hiển thị cùng live output.
6. ANSI SGR render đúng.
7. `\r`, backspace, erase-line và cursor movement render từ full buffer đúng.
8. `<script>` và arbitrary output được escape.
9. User scroll ở cuối tiếp tục follow output.
10. User scroll lên không bị cưỡng bức xuống cuối trong tool output.
11. Completion remove spinner và finalize theo kind/status hiện có.
12. Failed completion giữ tool block mở và hiển thị output cuối.
13. Copy output lấy nội dung snapshot mới nhất.

### Multi-session

1. Active session nhận progress delta đúng sequence.
2. Progress snapshot được coalesce theo tool ID.
3. Completion supersede retained progress.
4. Background progress không tăng unread count theo từng chunk.
5. Activate background session render latest progress và spinner.
6. Resync sau sequence gap render latest state, không replay hàng nghìn progress events.
7. Hai session dùng cùng `toolCallId` không chia sẻ state.
8. Hai session có terminal IDs giống nhau không chia sẻ output.
9. Close/dispose session xóa terminal subscription và pending timers.

### Compatibility matrix

| Input source                        | Running display           | Final display                  |
| ----------------------------------- | ------------------------- | ------------------------------ |
| `tool_call_update.rawOutput` string | Live                      | Full latest output             |
| `rawOutput.output`                  | Live                      | Full latest output             |
| `rawOutput.text`                    | Live                      | Full latest output             |
| Codex-style `formatted_output`      | Live                      | Full latest output             |
| Arbitrary custom-tool object        | Normalized live text      | Normalized final text          |
| `content` text blocks               | Live replacement          | Final content                  |
| Embedded terminal                   | Live ANSI terminal output | Retained final terminal output |
| Agent only sends final update       | Không thể live            | Final output như hiện tại      |

## Manual verification matrix

Thực hiện cho cả legacy mode và multi-session mode:

1. Tool chạy lệnh phát một dòng mỗi `200ms`; kiểm tra từng dòng xuất hiện trong cùng tool card.
2. Tool dùng carriage return để cập nhật progress `1% → 100%`; kiểm tra UI không append 100 dòng sai.
3. Tool phát ANSI màu; kiểm tra màu và escaping.
4. Tool output dài vượt projection limit; kiểm tra truncation marker và responsiveness.
5. Chuyển sang session khác khi tool đang chạy, sau đó quay lại; kiểm tra latest output và status.
6. Để tool chạy background; kiểm tra unread count không tăng theo từng chunk.
7. Cancel prompt giữa lúc terminal đang chạy; kiểm tra final status failed và output đã nhận vẫn còn.
8. Agent release terminal trước final tool update; kiểm tra output không biến mất.
9. Custom tool chỉ phát `rawOutput` updates; kiểm tra live output.
10. Agent chỉ phát final output; kiểm tra không regress và không hiển thị dữ liệu giả.

## Quality gates

Chạy theo thứ tự:

```bash
npm run check-types
npx eslint src
npm run compile-tests
npm test
npm run package
```

Sau khi code extension/webview thay đổi, bắt buộc package và cài local extension:

```bash
npx vsce package --out .tmp/vscode-acp-chat-live-tool-output.vsix
code --install-extension .tmp/vscode-acp-chat-live-tool-output.vsix --force
```

Sau cài đặt:

- Xóa temporary VSIX nếu path không git-ignored hoặc không còn cần.
- Chạy `Developer: Reload Window`.
- Thực hiện manual verification matrix.

Nếu `code`, VSIX packaging hoặc VS Code integration-test harness không khả dụng, phải báo blocker và không tuyên bố extension đang chạy là bản mới nhất.

## Acceptance criteria

1. Tool card hiển thị `rawOutput` hoặc text content trước khi tool hoàn tất khi agent phát non-final updates.
2. ACP embedded terminal hiển thị output live từ process do extension quản lý.
3. Một `toolCallId` chỉ tạo một tool card.
4. Progress snapshot replace output cũ theo ACP semantics; không duplicate do append sai.
5. Spinner tồn tại đến final status.
6. Completion luôn hiển thị latest content/rawOutput/terminal output và không bị stale progress ghi đè.
7. Terminal output vẫn hiển thị sau release.
8. Legacy và multi-session cho kết quả UI tương đương.
9. Background session replay/resync có latest output mà transcript không tăng theo từng raw stdout chunk.
10. Live progress không tăng unread count liên tục.
11. ANSI, cursor control, escaping và copy output hoạt động đúng.
12. Rapid output không làm webview/message queue tăng không giới hạn.
13. Existing assistant streaming, thought streaming, permissions, diffs, history và final-only tool calls không regress.
14. Typecheck, lint, tests, production package và local VSIX installation hoàn tất hoặc blocker được báo chính xác.

## Rủi ro và giảm thiểu

| Rủi ro                                     | Giảm thiểu                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Agent không phát progress                  | Ghi rõ upstream prerequisite; giữ final-only behavior                      |
| Append sai replacement semantics           | Chỉ truyền full snapshot; test content/rawOutput replacement và null clear |
| DOM churn do output nhanh                  | Host throttle/coalesce; replace tối đa vài lần mỗi giây                    |
| Message payload tăng theo output           | UI projection cap và truncation marker                                     |
| Final bị stale progress ghi đè             | Cancel timer trước complete; serial queue; optional revision nếu cần       |
| Terminal output đến trước mapping          | Cache latest terminal snapshot theo ID                                     |
| Terminal release làm mất output            | Emit/cache final snapshot trước delete; complete đọc cache                 |
| Multi-session transcript phình to          | Upsert retained progress theo tool ID; completion supersede progress       |
| Background unread tăng vô hạn              | Không count progress messages                                              |
| Legacy và multi diverge                    | Một shared `SessionOutputPipeline`; parity tests                           |
| ANSI/cursor output sai khi append fragment | Render lại từ full output snapshot bằng existing terminal renderer         |
| XSS từ custom tool output                  | Tiếp tục escape trước render; tests với HTML/script payload                |
| User đang xem output cũ bị auto-scroll     | Preserve per-output scroll intent và existing chat auto-scroll policy      |

## Rollback strategy

Implementation nên chia commit/phase để có thể rollback riêng:

1. Shared pipeline migration.
2. ACP progress message và webview rendering.
3. Terminal event bridge.
4. Multi-session transcript compaction.

Nếu terminal bridge gây lỗi, có thể tắt riêng nguồn terminal events trong khi vẫn giữ live `tool_call_update` support. Nếu progress rendering gây performance regression, tăng throttle interval hoặc tạm chỉ render normalized textual output mà không bỏ final path hiện tại.

Không thay đổi wire protocol với agent nên rollback không yêu cầu migration dữ liệu hoặc config.

## Tài liệu tham chiếu

- ACP Tool Calls: <https://agentclientprotocol.com/protocol/tool-calls>
- ACP Terminals: <https://agentclientprotocol.com/protocol/terminals>
- SDK schema đang dùng: `@agentclientprotocol/sdk` `1.2.1`
