# Fast Chat History Loading Implementation Plan

| Attribute  | Value                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Draft                                                                                                                                                                                                 |
| Owner      | TBD                                                                                                                                                                                                   |
| Phase      | Performance implementation planning                                                                                                                                                                   |
| Scope      | History listing, ACP history replay, host/webview message batching, Markdown rendering, tool/diff restoration, multi-session snapshots, performance tests                                             |
| References | `src/extension.ts`, `src/acp/client.ts`, `src/acp/session-manager.ts`, `src/acp/session-output-pipeline.ts`, `src/views/chat.ts`, `src/views/webview/`, `src/features/multi-session/`, `src/utils/diff.ts` |

## Objective

Giảm rõ rệt thời gian mở danh sách history và thời gian hiển thị một conversation đã lưu, đặc biệt với session dài, nhiều code block, thought chunk và tool call.

Kết quả cần đạt:

- QuickPick history xuất hiện ngay, không chờ `session/list` hoàn tất mới mở UI.
- Chi phí replay phụ thuộc chủ yếu vào số turn/block sau khi compact, không phụ thuộc trực tiếp vào số raw ACP chunk.
- Mỗi text/thought block trong history chỉ parse Markdown một lần trong đường chạy chuẩn.
- Không đọc workspace hiện tại để dựng lại diff lịch sử.
- Không render cùng một history hai lần trong multi-session mode.
- Giữ nguyên thứ tự turn, tool call, thought, metadata và final `streamEnd`.
- Không làm giảm tính đúng đắn của live streaming hoặc đưa lỗi race thứ tự quay trở lại.

## Current-state analysis

### History list

Command `vscode-acp-chat.loadHistory` hiện làm tuần tự:

```text
command invoked
  -> await ChatViewProvider.listSessions()
  -> await ACP session/list when supported
  -> create and show QuickPick
```

`src/extension.ts` chỉ gọi `quickPick.show()` sau khi `listSessions()` hoàn tất. Nếu agent truy vấn session từ storage hoặc service riêng, người dùng thấy command không phản hồi dù VS Code chưa có UI loading.

`AgentSessionManager.listSessions()` tại `src/acp/session-manager.ts` ưu tiên `session/list`; local store chỉ là fallback khi capability không tồn tại hoặc RPC lỗi. Local data đã có thể dùng làm stale snapshot nhưng chưa được dùng để mở UI sớm.

### Legacy history load

`ChatViewProvider.loadHistorySession()` tại `src/views/chat.ts`:

1. Xóa UI hiện tại.
2. Gọi ACP `session/load`.
3. Agent replay toàn bộ history thành `session/update` notifications.
4. Mỗi notification được đẩy qua `AsyncSerialProcessor`.
5. Mỗi render message lại đi qua `webviewPostNotifier`.
6. Webview tiếp tục xử lý từng message qua `incomingNotifier`.
7. Host chờ queue drain rồi gửi final `streamEnd`.

Ba queue tuần tự cần thiết để giữ ordering, nhưng hiện mỗi raw chunk tạo ít nhất một task/Promise và một lần truyền host-to-webview.

### Markdown and syntax highlighting

`TextBlock.appendContent()` và `ThoughtBlock.appendContent()` đang nối chunk rồi parse lại toàn bộ nội dung:

```ts
this.rawContent += text;
this.contentEl.innerHTML = marked.parse(this.rawContent) as string;
```

Với một block có `n` chunk, tổng lượng text được parse xấp xỉ:

```text
chunk 1
+ chunks 1..2
+ chunks 1..3
...
+ chunks 1..n
```

Chi phí tăng gần bậc hai theo số chunk. Mỗi lần parse còn chạy lại `highlight.js` cho mọi fenced code block đã xuất hiện trong nội dung tích lũy.

### Tool and diff restoration

Khi replay tool write/edit, host có thể đọc file hiện tại bằng `vscode.workspace.fs.readFile()` để dựng `oldText`/`newText`. Việc này có hai vấn đề:

- Chặn queue xử lý history bằng filesystem I/O.
- Workspace hiện tại không nhất thiết phản ánh trạng thái file tại thời điểm tool lịch sử chạy, nên diff có thể sai.

Khi diff được gửi sang webview, `computeLineDiff()` dùng full LCS matrix với độ phức tạp thời gian và bộ nhớ `O(oldLines * newLines)`. Tool history chứa file lớn có thể tạo long task đáng kể.

### Multi-session duplicate rendering

Trong multi-session mode, history session active hiện có thể được render theo hai lượt:

1. Mỗi update được `append()` và gửi ngay dưới dạng `feature.multi-session.delta`.
2. Khi load hoàn tất, host gửi full `feature.multi-session.snapshot`.
3. Webview reset DOM và replay toàn bộ transcript lần nữa.

`TranscriptStore` đã compact các `streamChunk`/`thoughtChunk` liên tiếp, nhưng việc phát delta trong lúc load làm lợi ích compaction không được áp dụng cho lượt render đầu.

### Missing performance evidence

Test hiện tại kiểm tra ordering và restoration correctness nhưng chưa đo:

- số raw notifications;
- số host-to-webview messages;
- tổng byte payload;
- số lần `marked.parse()`;
- thời gian ACP request, queue drain và webview render;
- số filesystem reads trong history mode;
- số lần cùng transcript bị reset/replay.

Không được tối ưu bằng cảm nhận mà thiếu baseline và regression threshold.

## Root causes ranked

| Priority | Cause                                                                 | Effect                                                                                             |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P0       | Parse toàn bộ Markdown sau mỗi raw chunk                              | CPU tăng gần `O(n²)`; code block bị highlight lặp lại                                               |
| P0       | Raw ACP chunk đi qua nhiều queue và `postMessage` riêng               | Hàng nghìn Promise/task, serialization và DOM update tuần tự                                        |
| P1       | Multi-session vừa phát delta vừa gửi final snapshot                   | History active bị render hai lần                                                                   |
| P1       | Tool history đọc workspace và dựng diff như live tool                 | Filesystem I/O tuần tự, diff có thể sai ngữ nghĩa                                                   |
| P1       | LCS diff được tính eager khi tool details được render                 | Long task và memory spike với file lớn                                                             |
| P2       | Command chờ remote `session/list` trước khi mở QuickPick              | UI có cảm giác treo dù phần list local có thể sẵn sàng                                              |
| P2       | Không có performance timing/counters dành cho history                 | Khó tách agent latency, extension-host latency và webview latency                                   |

## Architecture decisions

### 1. Giữ queue ordering, giảm số item đi qua queue

Không loại bỏ hoặc chạy song song tùy tiện `AsyncSerialProcessor`, `webviewPostNotifier` hay `incomingNotifier`. Các queue này bảo vệ thứ tự message và đã sửa race `streamEnd` vượt content.

Tối ưu phải diễn ra trước boundary của queue bằng cách compact history thành render events lớn hơn, thay vì xử lý raw chunk nhanh hơn nhưng mất ordering.

### 2. Tách live streaming và history replay

Live streaming vẫn ưu tiên phản hồi từng phần. History replay không cần mô phỏng tốc độ stream cũ.

Trong history mode:

- Thu nhận và chuẩn hóa notifications ở Extension Host.
- Gộp text/thought chunks liên tiếp thuộc cùng block.
- Chỉ gửi dữ liệu đã compact sang webview.
- Finalize theo turn/block trước khi render.

Không áp dụng buffering dài cho live conversation.

### 3. Dùng bounded batches, không gửi một payload không giới hạn

Một message chứa toàn bộ history có thể gây serialization pause lớn, đặc biệt khi có image data URL hoặc tool output dài.

Protocol replay phải hỗ trợ các batch có giới hạn, đề xuất ban đầu:

- tối đa `100` render events mỗi batch;
- hoặc tối đa khoảng `512 KiB` payload ước lượng;
- event riêng lẻ vượt ngưỡng được gửi một mình;
- giữ nguyên thứ tự tuyệt đối giữa các batch.

Các giá trị cuối cùng phải được xác nhận bằng benchmark, không coi là public API.

### 4. Render Markdown một lần cho mỗi compacted block

Thêm API phân biệt:

```ts
appendContent(chunk: string): void; // live stream
setContent(content: string): void;  // finalized/history block
```

History replay dùng `setContent()`. Live stream có thể tiếp tục `appendContent()`, sau đó được coalesce theo animation frame ở phase riêng nếu benchmark cho thấy cần thiết.

`finalize()` phải flush pending live render trước khi action buttons hoặc block state được tạo.

### 5. Không reconstruct historical diffs từ workspace hiện tại

Trong history mode:

- Giữ diff nếu agent đã cung cấp trực tiếp trong tool content.
- Không gọi `captureBaseContent()` hoặc đọc file để tự dựng diff.
- Tool không có agent-provided diff chỉ hiển thị summary/input/output có sẵn.
- Collective diff summary chỉ đại diện thay đổi của runtime hiện tại, không giả định lịch sử vẫn pending.

Đây vừa là tối ưu hiệu năng vừa sửa vấn đề correctness.

### 6. Lazy-render tool details chứa diff lớn

Tool summary được render ngay. Tool details, đặc biệt `renderDiff()`, chỉ được tạo khi:

- người dùng mở `<details>` lần đầu; hoặc
- tool đang live và UX hiện tại bắt buộc hiển thị ngay.

History restoration không chạy LCS cho mọi tool trước khi người dùng xem.

### 7. Multi-session load chỉ publish transcript đã compact

Khi `session.isLoadingHistory === true`:

- `append()` vẫn ghi vào `TranscriptStore`.
- Không gửi từng delta của history active sang webview.
- Có thể gửi progress/state nhẹ, không chứa transcript content.
- Sau queue drain, gửi một snapshot hoặc bounded snapshot batches duy nhất.

Live updates sau khi history load kết thúc tiếp tục dùng delta protocol.

### 8. History list dùng stale-while-revalidate

QuickPick được tạo và show ngay:

1. Populate local cached sessions nếu có.
2. Đặt `busy = true` và placeholder phù hợp.
3. Gọi remote `session/list` bất đồng bộ.
4. Reconcile và thay item list khi kết quả về.
5. Giữ selection theo `sessionId` nếu item vẫn tồn tại.
6. Nếu remote lỗi nhưng local cache có dữ liệu, giữ list và hiển thị warning không modal.

Không biến local cache thành source of truth khi agent hỗ trợ list; nó chỉ là dữ liệu để giảm perceived latency.

### 9. Instrumentation không log nội dung chat

Performance log chỉ chứa timing, count, byte estimate, session ID rút gọn hoặc hash và mode. Không log prompt, response, raw tool input/output hoặc image data.

Instrumentation dùng setting debug hiện có và không thêm telemetry ngoài máy người dùng.

## Target flow

### History list

```text
Load History command
  -> create/show QuickPick immediately
  -> read local session snapshot
  -> render cached items
  -> start remote session/list
  -> reconcile remote result
  -> user selects session
```

### History load

```text
ACP session/load
  -> raw session/update notifications
  -> ordered host processor
  -> HistoryReplayCollector
       - reconstruct user turns
       - compact text chunks
       - compact thought chunks
       - preserve tool/turn order
       - retain final metadata snapshots
       - skip workspace diff reconstruction
  -> bounded HistoryReplayBatch[]
  -> webview batch mode
       - reset once
       - suspend auto-scroll/paint invalidation
       - render finalized blocks once
       - lazy tool details/diffs
       - restore final scroll
  -> historyReplayEnd / final streamEnd
```

## Proposed internal contracts

Tên type cuối cùng có thể thay đổi để phù hợp codebase, nhưng semantics phải tương đương.

```ts
interface HistoryReplayStartMessage {
  type: "historyReplayStart";
  replayId: string;
  sessionId: string;
}

interface HistoryReplayBatchMessage {
  type: "historyReplayBatch";
  replayId: string;
  batchIndex: number;
  events: HistoryRenderEvent[];
}

interface HistoryReplayEndMessage {
  type: "historyReplayEnd";
  replayId: string;
  batchCount: number;
  lastSequence: number;
}
```

`HistoryRenderEvent` nên tái sử dụng render message hiện có khi có thể:

```ts
type HistoryRenderEvent =
  | { type: "userMessage"; text: string; images?: string[]; mentions?: Mention[] }
  | { type: "assistantText"; text: string }
  | { type: "assistantThought"; text: string }
  | { type: "toolCallStart"; /* existing fields */ }
  | { type: "toolCallComplete"; /* existing fields */ }
  | { type: "turnEnd" }
  | { type: "error" | "system"; text: string };
```

Không cần giữ một event cho từng `agent_message_chunk`. `assistantText.text` phải là nội dung đã compact của block tương ứng.

Nếu dùng lại `ExtensionMessage`, cần thêm batch envelope thay vì tạo một render model thứ hai không cần thiết:

```ts
interface HistoryReplayBatchMessage {
  type: "historyReplayBatch";
  events: ExtensionMessage[];
}
```

Lựa chọn cuối cùng ưu tiên ít type duplication và dễ test ordering.

## Implementation phases

### Phase 0 — Baseline and observability

1. Thêm host timing quanh:
   - local history list read;
   - remote `session/list`;
   - `session/load` request start/response;
   - first/last history notification;
   - notification queue drain;
   - replay batch creation/post.
2. Thêm counters:
   - raw notification count theo type;
   - render event count trước/sau compaction;
   - host-to-webview message count;
   - estimated payload bytes;
   - workspace read count trong history mode.
3. Thêm webview timing:
   - replay start/end;
   - event count;
   - text/thought block count;
   - Markdown parse count và tổng parse time;
   - diff render count và tổng diff time.
4. Tạo synthetic history generator cho test/benchmark, không commit fixture chứa chat thật.
5. Ghi baseline cho ba profile:

| Profile | Shape                                                                                 |
| ------- | ------------------------------------------------------------------------------------- |
| Small   | 20 turns, 100 raw chunks, 2 code blocks, không tool                                |
| Medium  | 100 turns, 2,000 raw chunks, 20 tool calls, 10 code blocks                         |
| Large   | 300 turns, 10,000 raw chunks, 100 tool calls, nhiều thought và một số tool output lớn |

**Gate:** Có thể phân biệt rõ agent/RPC time, host processing time và webview render time mà không log nội dung chat.

### Phase 1 — Fast history QuickPick

1. Tách API lấy local snapshot khỏi remote list trong `AgentSessionManager`.
2. Tạo QuickPick trước mọi remote await và bật `busy`.
3. Populate cache theo `cwd` và sort newest-first.
4. Refresh bằng `session/list` bất đồng bộ.
5. Reconcile duplicate theo `sessionId` và giữ active/selected item.
6. Xử lý hide/dispose để remote result không update QuickPick đã đóng.
7. Dùng cùng flow cho delete-history picker nếu phù hợp, không copy logic.

**Gate:** QuickPick shell hiện trong cùng event-loop turn; remote list chậm không làm UI im lặng; list cuối vẫn phản ánh agent result.

### Phase 2 — Host-side history compaction

1. Tạo pure `HistoryReplayCollector` với state machine theo turn/block.
2. Chuyển legacy history path sang emit vào collector trong khi `isLoadingHistory`.
3. Compact:
   - user text/image chunks thành một user message;
   - consecutive assistant text chunks thành một finalized text block;
   - consecutive thought chunks thành một finalized thought block;
   - metadata updates thành latest snapshot khi ordering không yêu cầu append;
   - duplicate non-final tool updates thành representation tối thiểu cần replay.
4. Giữ chính xác boundary giữa user message, thought, tool và assistant text.
5. Chia output thành bounded batches.
6. Chỉ gửi final replay sau khi ordered notification processor đã drain.
7. Thêm generation/replay ID để bỏ qua batch cũ nếu người dùng load session khác nhanh.
8. Kiểm tra hành vi late notification sau `session/load` response; nếu agent thực tế có notification đến sau drain, dùng generation-aware quiescence barrier có timeout ngắn và đo được, không thêm sleep tùy ý.

**Gate:** Medium profile giảm ít nhất 90% số host-to-webview messages so với raw chunk path; ordering tests vẫn pass.

### Phase 3 — Webview batch rendering

1. Thêm `beginHistoryReplay()`/`endHistoryReplay()` vào chat surface hoặc message list.
2. Reset DOM đúng một lần tại replay start.
3. Trong batch mode:
   - tạm dừng auto-scroll settle frames;
   - tạm dừng paint invalidation bắt buộc;
   - không focus input sau từng event;
   - không tạo action buttons cho block chưa finalize.
4. Thêm `setContent()` cho `TextBlock` và `ThoughtBlock`.
5. Route finalized history text/thought qua `setContent()` để gọi `marked.parse()` đúng một lần/block.
6. Yield giữa bounded batches bằng `requestAnimationFrame()` hoặc scheduler tương đương để sidebar không freeze dài; không yield giữa các event cần atomic ordering trong cùng turn.
7. Khi end:
   - finalize block còn mở;
   - render action buttons;
   - apply metadata/context/plan;
   - restore scroll position hoặc scroll bottom một lần;
   - re-enable normal live behavior.
8. Nếu DOM mutation vẫn là bottleneck sau compaction, build batch subtree bằng `DocumentFragment` rồi append một lần. Không thực hiện refactor fragment trước khi benchmark chứng minh cần.

**Gate:** Số lần `marked.parse()` trong history không vượt quá số finalized text/thought blocks cộng một hằng số nhỏ; không còn parse theo raw chunk.

### Phase 4 — Skip historical workspace reconstruction and lazy diff

1. Truyền explicit `historyMode` vào tool completion/render pipeline.
2. Bỏ `captureBaseContent()` và `workspace.fs.readFile()` khi restore history.
3. Giữ agent-provided diff content nếu có.
4. Sửa `ToolBlock` để lưu typed details model và render details lần đầu khi `<details>` mở.
5. Không chạy `computeLineDiff()` cho collapsed historical tool.
6. Cache rendered details trong lifetime của block để toggle lại không tính diff lần nữa.
7. Đặt guard cho diff quá lớn nếu vẫn cần render:
   - đo line count/product trước LCS;
   - hiển thị summary và action mở VS Code diff/editor thay vì cấp phát matrix quá lớn;
   - không silently truncate mà không báo UI.
8. Đánh giá thay LCS bằng thuật toán Myers/patience trong thay đổi riêng nếu diff live vẫn là bottleneck; không trộn migration thuật toán vào patch batching đầu tiên.

**Gate:** History replay không đọc workspace để reconstruct diff; collapsed tool không chạy LCS; existing live diff behavior vẫn giữ nguyên.

### Phase 5 — Multi-session single-pass restoration

1. Trong `MultiSessionHostController.append()`, suppress transcript delta khi session đang `isLoadingHistory`.
2. Tiếp tục append/compact trong `TranscriptStore` và update lightweight session status.
3. Không gửi intermediate full snapshot trong lúc load trừ empty/loading surface ban đầu.
4. Sau queue drain, publish transcript một lần bằng snapshot hoặc bounded snapshot batches.
5. Thêm snapshot/replay revision để stale load không overwrite session vừa được activate.
6. Webview `applySnapshot()` dùng batch mode thay vì dispatch từng event với full scroll/paint behavior.
7. Khi chuyển sang một session đã mở, chỉ replay snapshot hiện có; không gọi lại ACP `session/load`.
8. Xác nhận `lastSeq` sau compact snapshot vẫn cho phép delta live kế tiếp mà không kích hoạt resync sai.

**Gate:** Mỗi history session được reset/render đúng một lần; không có delta content trong loading window rồi full replay lại lần hai.

### Phase 6 — Live-stream coalescing, only if still needed

Phase này chỉ thực hiện nếu profile sau Phase 1–5 cho thấy live streaming hoặc tail của history vẫn tốn CPU.

1. `appendContent()` chỉ update `rawContent` và schedule tối đa một Markdown render mỗi animation frame.
2. Nhiều chunk trong cùng frame được coalesce.
3. `finalize()` flush synchronously trước khi action buttons đọc raw content.
4. Thought block dùng cùng scheduler.
5. Không memoize toàn cục highlighted HTML mặc định; chỉ thêm cache có giới hạn nếu profiling chứng minh highlight lặp lại vẫn đáng kể.

**Gate:** Không mất text, không reorder, không làm copy/action buttons lấy content cũ; live stream vẫn cảm giác tức thời.

### Phase 7 — Cleanup and rollout

1. Xóa đường replay per-chunk cũ sau khi tests và benchmark đạt gate.
2. Giữ ordering queues cho live messages và batch envelopes.
3. Thêm concise debug summary cho mỗi history load.
4. Cập nhật changelog/release note với hành vi performance, không quảng bá internal protocol.
5. Build, package và cài VSIX theo repository workflow.
6. Manual profile trên ít nhất hai agent:
   - agent có native `session/list`/`session/load`;
   - agent dùng local list fallback hoặc history nhỏ.

## File-level change map

| File/area                                             | Planned change                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                                    | Show QuickPick immediately, async refresh, picker lifecycle guards                                   |
| `src/acp/session-manager.ts`                          | Expose local snapshot and remote refresh/reconcile APIs                                               |
| `src/acp/client.ts`                                   | Add timing/count hooks around list/load and notification boundaries; no raw-content performance logs |
| `src/acp/session-output-pipeline.ts`                  | History mode, collector output boundary, skip historical file reconstruction                         |
| `src/views/chat.ts`                                   | Legacy replay collector integration, bounded batch posting, replay generation guard                  |
| `src/views/webview/types.ts`                          | Typed history replay batch envelopes                                                                 |
| `src/views/webview/main.ts`                           | Route replay envelopes and control batch lifecycle                                                    |
| `src/views/webview/component/message-list.ts`         | Batch mode, suspend/resume scroll and paint, single finalization                                      |
| `src/views/webview/block/text-block.ts`               | `setContent()`, optional rAF live render scheduling                                                   |
| `src/views/webview/block/thought-block.ts`            | `setContent()`, optional rAF live render scheduling                                                   |
| `src/views/webview/block/tool-block.ts`               | Lazy details rendering and cached first render                                                        |
| `src/views/webview/widget/diff-render.ts`             | Oversized diff guard and deferred invocation                                                          |
| `src/utils/diff.ts`                                   | Metrics/guard seam; algorithm replacement deferred unless independently required                      |
| `src/features/multi-session/host.ts`                  | Suppress history deltas, publish one compact replay                                                   |
| `src/features/multi-session/webview.ts`               | Batch snapshot replay, stale revision guard                                                           |
| `src/features/multi-session/transcript-store.ts`      | Verify/extend compaction semantics and batch snapshot output                                          |
| `src/test/history_restoration.test.ts`                | Legacy ordering, batching, no-late-finalization regression                                            |
| `src/test/features/multi-session.test.ts`             | Single-pass multi-session history restoration                                                         |
| `src/test/webview.test.ts` or focused feature tests   | Parse count, batch lifecycle, lazy tool details                                                       |
| New focused pure unit test for replay collector       | Compaction and turn-boundary matrix                                                                   |

Core changes are justified as a generic history-loading performance/correctness fix suitable for upstream. Multi-session-specific behavior remains under `src/features/multi-session/`.

## Verification strategy

### Unit tests

`HistoryReplayCollector` test matrix:

- many user chunks followed by assistant text;
- metadata update interleaved between user chunks;
- thought before text;
- text → tool → text within one assistant turn;
- tool start plus multiple updates plus completion;
- image chunks and mentions;
- failed/cancelled tool;
- consecutive turns;
- empty chunks;
- large event that exceeds batch byte threshold;
- late/stale replay ID.

Assertions:

- exact event ordering;
- exact concatenated text;
- no lost images/mentions;
- bounded batch size except allowed single oversized event;
- final turn/block always finalized once.

### Integration tests

- 2,000 raw chunks produce compact event count proportional to turns/blocks.
- Final replay end cannot overtake prior batch.
- Live messages sent after history end follow the restored transcript.
- Loading session B while A replay is pending does not render A into B.
- Multi-session loading emits no transcript deltas before final compact publish.
- Agent-provided tool diff remains visible.
- Tool without provided diff causes zero workspace reads in history mode.
- `lastSeq`/revision accepts next live delta without unnecessary resync.

### Webview tests

- `setContent()` invokes Markdown render once.
- History batch does not call scroll settle logic per event.
- Action buttons are created once per finalized assistant message.
- Lazy tool details do not call diff renderer before expansion.
- Opening details renders once; subsequent toggles reuse output.
- Replay end restores expected scroll and generating state.

### Performance assertions

Automated tests should prefer deterministic counters over brittle wall-clock limits:

- host-to-webview message reduction `>= 90%` on Medium profile;
- Markdown parse count equals finalized text/thought block count within expected constant;
- workspace read count during history replay is `0` unless an explicit non-history operation occurs;
- multi-session transcript reset count is `1` per load;
- eager diff render count is `0` for collapsed historical tools.

Wall-clock benchmark is recorded separately and compared on the same machine/build:

- target at least `70%` reduction in extension-controlled Medium-profile load time;
- no single webview replay task above `200 ms` on Medium profile after bounded yielding;
- no regression greater than `10%` for Small profile or live streaming.

### Manual verification

1. Open Load History with agent-side list intentionally delayed.
2. Confirm QuickPick appears immediately with spinner/cache.
3. Load short session and compare visual output with current release.
4. Load long session with code blocks and thought content.
5. Confirm sidebar remains responsive during progressive batch render.
6. Expand old tool diffs and verify lazy rendering.
7. Switch sessions rapidly while one history load is active.
8. Send a new prompt after history restoration and verify correct continuation.
9. Reload VS Code window and repeat with installed VSIX.

## Risks and mitigations

| Risk                                                       | Mitigation                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Compaction merges blocks across a real turn boundary       | State-machine tests for every content/tool/user boundary; metadata alone must not split user message          |
| Queue removal reintroduces ordering race                    | Do not remove ordering queues; queue compact batches instead                                                  |
| One batch payload freezes serialization                    | Enforce event/byte limits and send oversized event alone                                                      |
| Image data URL dominates payload                           | Byte-aware batching; do not duplicate image data in multiple representations                                 |
| `session/load` response precedes late notifications        | Generation-aware notification accounting and measured quiescence barrier if required                         |
| Skip diff reconstruction changes historical UI            | Preserve agent-provided diff; show tool summary/output; document that current workspace is not historical truth |
| Lazy tool details break delegated actions                  | Render through existing tool block APIs and bind actions via delegation or one-time post-render hook          |
| Multi-session compacted sequence causes false resync       | Snapshot carries raw `lastSeq`; tests cover next delta and activation revision                               |
| Async remote list overwrites user selection                | Reconcile by `sessionId`, preserve active/selected item and ignore result after picker dispose                |
| Instrumentation leaks chat content                         | Log counts/timings only; add tests/review checklist against raw payload logging                               |

## Commit boundaries

Để review và rollback an toàn, triển khai thành các commit độc lập:

1. `perf(history): add replay metrics and synthetic benchmarks`
2. `perf(history): show cached sessions before remote list completes`
3. `perf(history): compact ACP replay into bounded batches`
4. `perf(webview): render finalized history blocks once`
5. `fix(history): skip workspace diff reconstruction during replay`
6. `perf(webview): lazy render historical tool diffs`
7. `perf(multi-session): avoid duplicate history replay`
8. `test(history): add performance and ordering regressions`

Không trộn thay đổi thuật toán diff tổng quát hoặc refactor ACP multiplex vào cùng chuỗi commit.

## Definition of done

- Baseline và after metrics được ghi lại cho Small/Medium/Large profiles.
- QuickPick hiện ngay và remote refresh không chặn UI.
- Legacy và multi-session đều dùng compacted bounded history replay.
- History text/thought được parse một lần trên mỗi finalized block.
- Không có workspace reads để reconstruct historical diff.
- Historical tool diff được render lazy.
- Multi-session không delta-render rồi snapshot-render cùng history.
- Ordering, history restoration, webview và multi-session tests pass.
- Typecheck, lint, test và production package pass.
- VSIX được package, cài bằng `code --install-extension ... --force` và kiểm tra sau `Developer: Reload Window`.
