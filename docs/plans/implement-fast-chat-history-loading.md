# Fast Chat History Loading Implementation Plan

| Attribute  | Value                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented                                                                                                                                                                |
| Owner      | Engineering                                                                                                                                                                |
| Phase      | Completed; performance gates validated with deterministic counters and focused integration tests                                                                           |
| Scope      | Agent-scoped history catalog, bundled Pi session discovery, ACP history replay, multi-session publication, webview restoration, pagination, metrics, tests                 |
| Depends on | [Pi ACP Full History Replay](./implement-pi-acp-full-history-replay.md)                                                                                                    |
| Related    | [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md), [Session Switch Loading](./implement-session-switch-loading.md)                    |
| References | `src/extension.ts`, `src/acp/session-manager.ts`, `src/acp/client.ts`, `src/features/multi-session/`, `src/features/pi-agent/vendor/pi-acp/src/acp/`, `src/views/webview/` |

## Objective

Giảm thời gian cảm nhận khi mở danh sách history và thời gian từ lúc chọn một session đến khi transcript ổn định trong chat, ưu tiên luồng mặc định hiện tại:

- multi-session đang bật;
- history được scope theo agent của session đang active;
- bundled Pi agent dùng `session/list` và `session/load` của vendored `pi-acp`;
- Pi mặc định replay full active-path transcript từ JSONL.

Kết quả cần đạt:

- QuickPick hiện ngay, không chờ agent scan history xong mới xuất hiện.
- Session được định danh bằng `{ agentId, sessionId }`, không phụ thuộc map tạm chỉ keyed theo `sessionId`.
- Không gọi lại `session/list` chỉ để lấy title sau khi người dùng đã chọn item.
- Bundled Pi không scan và parse lại toàn bộ cây JSONL nhiều lần cho cùng một thao tác list/load.
- Cursor pagination hoạt động; session sau page đầu tiên vẫn truy cập được.
- Multi-session history chỉ render một lần, không render delta rồi reset/replay snapshot lần nữa.
- Snapshot history parse Markdown một lần trên mỗi finalized text/thought block.
- Không đọc workspace hiện tại để reconstruct historical diff.
- Ordering, tool rendering, metadata, continuation và late notifications vẫn đúng.

## Non-goals

- Không thay đổi ACP public protocol hoặc yêu cầu third-party agent hỗ trợ message riêng của extension.
- Không thay đổi Pi compaction/model-context semantics.
- Không gửi full JSONL transcript lại vào model khi continue session.
- Không persist transcript body trong VS Code `globalState`.
- Không loại bỏ serial queues đang bảo vệ ordering.
- Không triển khai DOM surface cache trong plan này; repeated A ↔ B switching thuộc plan [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md).
- Không thay thuật toán diff tổng quát nếu profiling chưa chứng minh đó là bottleneck còn lại.

## Current flow

### 1. Agent scope

Các built-in agent được khai báo trong `src/acp/agents.ts`. Extension không có một history database chung cho mọi agent.

History hiện được scope như sau:

```text
active multi-session local session
  -> session.agent
  -> SessionCatalogService.listSessions(agent, runtime?)
  -> ACP session/list của chính agent đó
     hoặc local metadata fallback theo agentId
```

Local metadata fallback dùng prefix:

```text
vscode-acp-chat.localSessions.v1.<agentId>
```

Agent capability quyết định có thể list/load/delete hay không. Với các built-in agent ngoài Pi, chi phí server-side của `session/list` và `session/load` phụ thuộc implementation của agent tương ứng; extension chỉ thấy ACP response/notifications.

### 2. Load History command

Luồng command hiện tại:

```text
vscode-acp-chat.loadHistory
  -> check supportsLoadSession
  -> await chatProvider.listSessions()
  -> map toàn bộ kết quả thành QuickPickItem
  -> create/show QuickPick
```

QuickPick chỉ xuất hiện sau khi remote list hoàn tất. Vì vậy agent startup, filesystem scan hoặc network/storage latency đều bị người dùng cảm nhận như command không phản hồi.

### 3. Default multi-session listing

Khi multi-session bật:

```text
ChatViewProvider.listSessions()
  -> MultiSessionHostController.listSessions()
  -> active session agent
  -> SessionCatalogService.listSessions()
```

`SessionCatalogService`:

- dùng runtime hiện có nếu runtime đã connected;
- nếu không có runtime, tạo temporary `ACPClient`, connect, sync capabilities, list rồi dispose;
- nếu runtime tồn tại nhưng disconnected, trả local records trực tiếp.

Khoảng trống hiện tại:

- disconnected-local branch không filter theo workspace `cwd` như `AgentSessionManager.listLocalSessions()`;
- agent-returned sessions không được persist thành một remote catalog snapshot, nên local metadata cache không đại diện đầy đủ cho session tạo ngoài extension;
- `AgentSessionManager.listSessions()` chỉ gọi page đầu và bỏ qua `nextCursor`.

### 4. Bundled Pi history list

Bundled Pi `session/list` hiện làm:

```text
listSessions({ cwd, cursor })
  -> listPiSessions()
     -> recursively walk mọi *.jsonl trong Pi sessions dir
     -> read header mỗi file
     -> read tail mỗi file
     -> có thể scan cả file để tìm session_info.name
     -> fallback title có thể readFileSync toàn file
     -> sort toàn bộ sessions
  -> filter cwd
  -> slice page 50
  -> return nextCursor
```

Pagination chỉ giảm response payload; nó chưa giảm discovery cost vì Pi vẫn scan toàn bộ session tree trước khi slice page.

### 5. Selection and load in multi-session mode

Sau khi người dùng chọn session:

```text
QuickPick selection
  -> loadHistorySession(sessionId)
  -> resolve agent qua historySessionAgentById / lastHistoryListAgentId
  -> create agent-specific local draft
  -> activate draft and post empty/loading snapshot
  -> start a new ACP runtime
  -> listSessions() lần nữa để resolve title
  -> ACP session/load
```

Với bundled Pi runtime mới:

```text
Pi loadSession(sessionId)
  -> findStoredSession(sessionId)
     -> persistent pi-acp session map nếu có
     -> nếu miss: findPiSession(sessionId)
        -> listPiSessions() toàn bộ lần nữa
  -> spawn/restore pi --mode rpc
  -> read full JSONL active path
  -> replay each saved user/assistant message
  -> replay two ACP notifications per toolResult
  -> read session configuration
  -> return load response
```

Một thao tác list rồi load có thể thực hiện nhiều lần global Pi discovery:

1. list ban đầu cho QuickPick;
2. list lại chỉ để lấy title;
3. fallback scan trong runtime load mới nếu session map chưa có mapping.

### 6. Host reconstruction and duplicate publication

Mỗi ACP `session/update` được đưa qua `AsyncSerialProcessor` và `SessionOutputPipeline`.

Trong multi-session hiện tại:

```text
history notification
  -> output pipeline
  -> TranscriptStore.append()
  -> active session: post feature.multi-session.delta
  -> webview render delta ngay

history load completes
  -> queue.waitForIdle()
  -> append streamEnd(history_load)
  -> send full feature.multi-session.snapshot
  -> webview reset DOM
  -> replay transcript từ đầu
```

`TranscriptStore` compact adjacent `streamChunk`/`thoughtChunk` trong snapshot, nhưng lượt delta trước đó vẫn đã render. Đây là duplicate rendering chắc chắn trên default path.

### 7. Webview rendering

`MultiSessionWebviewController.applySnapshot()` hiện:

1. `bridge.reset()`;
2. dispatch từng transcript event tuần tự;
3. apply metadata/context/diff/permissions;
4. restore generation, draft và scroll.

`TextBlock.appendContent()` và `ThoughtBlock.appendContent()` nối text rồi gọi `marked.parse()` trên toàn bộ accumulated content. Với agent replay nhiều chunk trong cùng block, chi phí gần bậc hai và syntax highlighting bị chạy lại nhiều lần.

### 8. Legacy mode

Khi multi-session tắt, `ChatViewProvider.loadHistorySession()` cũng dùng serial notification queue và post từng render message. Legacy mode không có duplicate delta + final multi-session snapshot, nhưng vẫn chịu raw event count, repeated Markdown parsing và historical tool reconstruction.

Plan ưu tiên default multi-session + Pi trước. Generic collector/batching cho legacy và chunk-heavy agents chỉ triển khai khi metrics sau các phase đầu vẫn cho thấy cần thiết.

## Latency model

Đo riêng các thành phần sau thay vì chỉ đo end-to-end:

```text
T_picker = T_picker_shell
         + T_cached_catalog
         + T_runtime_connect
         + T_remote_list
         + T_agent_discovery

T_load = T_runtime_connect
       + T_session_lookup
       + T_agent_restore
       + T_transcript_read
       + T_agent_replay
       + T_host_queue
       + T_snapshot_publish
       + T_webview_render
```

Với Pi cần tách thêm:

- recursive discovery/stat;
- JSONL metadata content reads;
- session-map lookup hit/miss;
- Pi RPC process spawn/restore;
- full transcript parse;
- replay notification count.

## Root causes ranked

| Priority       | Cause                                                                 | Effect                                                                                 |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| P0             | Pi global synchronous JSONL discovery trước mỗi page/list             | Picker chậm theo tổng số session/file, không theo page size                            |
| P0             | Selection relist để lấy title và có thể scan lại khi load runtime mới | Lặp filesystem work và ACP startup không cần thiết                                     |
| P0             | Multi-session delta-render rồi snapshot-render cùng transcript        | Toàn bộ history bị render hai lần                                                      |
| P0 correctness | Extension bỏ qua `nextCursor`                                         | Session sau page đầu không truy cập được                                               |
| P1             | Snapshot dispatch tuần tự và Markdown parse accumulated content       | CPU/long task cao với history nhiều chunk/code block                                   |
| P1             | Pi full JSONL parse + serial ACP replay                               | Chi phí thực, một phần cần thiết để đảm bảo full history correctness                   |
| P1             | Historical tool path có thể đọc workspace và eager render diff        | I/O tuần tự, diff không phản ánh historical state, có thể tạo LCS long task            |
| P1 correctness | History identity keyed bằng plain `sessionId`                         | Có thể chọn/load/delete sai agent nếu ID trùng hoặc picker result stale                |
| P2             | Temporary ACP runtime cho list                                        | Có thể đáng kể, nhưng chỉ tối ưu/adopt runtime nếu metrics chứng minh                  |
| P2             | First-read `globalState` key scan                                     | Có giới hạn theo local retention/max sessions; không phải bottleneck chính đã xác minh |

## Architecture decisions

### 1. Composite history identity

Thay vì truyền plain `sessionId` từ QuickPick vào load/delete, dùng typed selection:

```ts
interface HistorySessionRef {
  agentId: string;
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  source: "agent" | "remote-cache" | "local-fallback";
}
```

Load/delete phải dùng `{ agentId, sessionId }` trực tiếp. Không dùng `lastHistoryListAgentId` để quyết định agent sau khi user đã chọn item.

### 2. Page-aware catalog contract

Giữ low-level ACP cursor semantics và expose ở session manager/catalog:

```ts
interface HistorySessionPage {
  sessions: HistorySessionRef[];
  nextCursor: string | null;
}
```

Không eager fetch tất cả page trước khi show picker. Page 1 được refresh trước; page tiếp theo được load qua `Load more…` hoặc background fetch có lifecycle guard.

### 3. Remote catalog snapshot riêng

Local session metadata hiện tại không đủ để làm stale cache cho agent-native history vì remote result không được ghi lại và session có thể được tạo ngoài extension.

Thêm last-successful remote catalog snapshot scoped theo:

```text
agentId + normalized cwd
```

Snapshot chỉ chứa metadata, không chứa transcript/tool content. Agent result vẫn là authoritative; snapshot chỉ giúp picker hiện nhanh.

### 4. Pi metadata index and direct lookup

Bundled Pi cần một metadata index keyed theo session file với validation bằng `mtime` và size.

Nguyên tắc:

- file không đổi: không parse JSONL content lại;
- file mới/đổi: một metadata pass để lấy header, latest name, first-user fallback và updated timestamp;
- discovery result bulk-update `sessionId -> { cwd, sessionFile }` vào pi-acp session map;
- runtime load mới lookup mapping trực tiếp và validate file trước khi fallback scan;
- cursor pages trong cùng listing snapshot reuse cùng sorted discovery result.

Không gọi `SessionStore.upsert()` từng session trong loop vì implementation hiện tại read/write toàn bộ map file mỗi lần. Cần in-memory load + `upsertMany()`/single flush.

### 5. Carry selected metadata into load

Title/cwd/agent từ selected QuickPick item được truyền vào `loadHistorySession(ref)`. Không gọi lại catalog chỉ để resolve title.

`session_info_update` sau load vẫn có quyền cập nhật title mới hơn.

### 6. Single-pass history publication

Mỗi managed session có replay phase rõ ràng:

```ts
type HistoryReplayPhase = "idle" | "collecting" | "publishing" | "live";
```

Trong `collecting`:

- append vào `TranscriptStore`;
- update lightweight status/progress;
- không post transcript-content delta.

Khi `session/load` response về:

1. drain notifications đã nhận;
2. flush user buffer;
3. append final `streamEnd(history_load)` vào transcript;
4. capture/post đúng một snapshot với `lastSeq` boundary;
5. chuyển phase sang `live` ngay sau publication boundary.

Notification thực sự đến muộn vẫn được nhận thành delta với `seq > snapshot.lastSeq`. Không dùng arbitrary sleep làm correctness mechanism.

### 7. Preserve serial ordering queues

Không loại bỏ `AsyncSerialProcessor`, webview incoming queue hoặc post ordering queue. Giảm số item đi qua queue bằng suppression/compaction, không chạy song song event handlers.

### 8. Snapshot restoration is finalized rendering

Snapshot transcript là dữ liệu đã có đầy đủ, không cần mô phỏng token streaming cũ.

Webview snapshot path phải:

- reset một lần;
- suspend per-event auto-scroll/paint invalidation;
- render finalized text/thought bằng `setContent()` một lần/block;
- finalize action buttons một lần;
- apply side state;
- restore scroll một lần ở cuối;
- yield giữa bounded work units nếu profiling còn long task.

Chỉ thêm protocol batch mới nếu snapshot serialization hoặc một replay task vẫn vượt performance gate sau khi bỏ duplicate render và repeated Markdown parsing.

### 9. Historical tool behavior

Trong history mode:

- không gọi `captureBaseContent()`/workspace read để reconstruct diff;
- giữ agent-provided diff/content;
- tool summary render ngay;
- large details/diff render lazy khi user expand;
- cache details sau lần render đầu;
- collective pending diff summary không coi historical edits là pending workspace mutations.

### 10. Instrumentation must not log content

Dùng setting debug hiện có cho local performance summaries. Chỉ log timing, count, bytes estimate, agent ID, hashed/truncated session identity và mode; không log prompt, response, tool payload, image data hoặc file content.

## Target flows

### Fast picker

```text
Load History command
  -> create/show QuickPick immediately, busy=true
  -> determine active agentId + cwd
  -> read remote catalog snapshot and local fallback metadata
  -> show cached items
  -> request remote page 1
  -> reconcile by {agentId, sessionId}
  -> persist successful remote snapshot
  -> expose/fetch next page while picker remains open
```

### Bundled Pi list

```text
ACP session/list(cursor)
  -> get/reuse discovery snapshot
  -> recursively enumerate files + stat
  -> parse metadata only for new/changed files
  -> filter cwd + sort
  -> return requested page
  -> bulk persist sessionId -> file mapping
```

### Bundled Pi load

```text
selected HistorySessionRef
  -> start agent-specific runtime
  -> use carried title/cwd; no relist
  -> ACP session/load
  -> session map direct lookup
  -> validate mapped JSONL file
  -> restore Pi RPC process
  -> read active-path transcript
  -> replay standard ACP notifications
  -> host collects without transcript deltas
  -> publish one snapshot
  -> webview finalized replay once
```

## Implementation phases

### Phase 0 — Baseline and observability

Add timings/counters at these boundaries:

#### Extension/catalog

- command invoked → QuickPick shown;
- cached catalog read;
- temporary/existing runtime connect;
- each `session/list` page request;
- selected item → `session/load` request;
- duplicate list count per user operation.

#### Bundled Pi

- files enumerated/stat-ed;
- unchanged index hits;
- metadata files parsed;
- full-file metadata reads;
- session-map lookup hit/miss;
- fallback discovery count;
- Pi process restore;
- transcript lines/messages parsed;
- ACP replay notification count.

#### Host/webview

- first/last history notification;
- queue drain;
- transcript event count and compacted event count;
- history transcript delta count;
- snapshot count and estimated bytes;
- webview replay duration;
- `marked.parse()` count/time;
- scroll/paint settle count;
- workspace read and diff render count.

Synthetic profiles:

| Profile       | Shape                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| Catalog-small | 50 Pi sessions, mostly unchanged files                                         |
| Catalog-large | 1,000 Pi sessions, mix of small/large JSONL files                              |
| Replay-small  | 20 turns, no tools                                                             |
| Replay-medium | 100 turns, 2,000 raw chunks for generic ACP profile, 20 tools, 10 code blocks  |
| Replay-large  | 300 turns, 10,000 raw chunks for generic ACP profile, 100 tools, large outputs |

**Gate:** Có thể tách rõ agent discovery/restore time khỏi extension-host và webview time mà không log content.

### Phase 1 — Composite identity and remove redundant selection work

1. Introduce `HistorySessionRef`/`HistorySessionPage` contracts.
2. Carry `agentId`, `title`, `cwd` trong QuickPick item.
3. Change load/delete entry points to accept composite identity.
4. Remove `historySessionAgentById`, `lastHistoryListAgentId` and selection-time `resolveHistorySessionTitle()` from critical path after migration.
5. Apply consistent `cwd` filter to disconnected local catalog branch.
6. Keep title update from `session_info_update`.

**Gate:**

- selecting a session causes zero extra `session/list` calls for title;
- two agents with identical `sessionId` load/delete đúng selected agent;
- active agent thay đổi sau khi picker mở không đổi target của selected item.

### Phase 2 — Bundled Pi catalog index and direct lookup

1. Refactor `pi-sessions.ts` thành scanner/index service thay vì stateless full scan helpers.
2. Store metadata cache keyed by canonical `sessionFile` with size/mtime validation.
3. Parse changed files bằng một streaming pass; bỏ fallback `readFileSync()` toàn file riêng biệt.
4. Add per-list immutable discovery snapshot so all cursor pages share one scan/sort result.
5. Refactor vendored `SessionStore`:
   - load map once per process;
   - validate mapped file;
   - support `upsertMany()` and one flush;
   - persist all discovered `sessionId -> sessionFile` mappings after list.
6. `findStoredSession()` uses validated map first; discovery fallback only on miss/stale mapping.
7. Bound/invalidate index when session directory or settings path changes.

**Gate:**

- warm list: unchanged JSONL content parse count bằng `0`;
- cold list: mỗi JSONL tối đa một metadata content pass;
- load immediately after successful list: fallback global scan count bằng `0`;
- cursor page 2 không trigger second discovery scan;
- add/rename/update/delete session file được phản ánh sau invalidation.

### Phase 3 — Immediate, cached and paged QuickPick

1. Create/show QuickPick before any remote await; set `busy = true`.
2. Add remote catalog snapshot store scoped by `{ agentId, cwd }`.
3. Show last successful remote snapshot immediately when available.
4. Merge local fallback metadata only as non-authoritative fallback; dedupe by composite identity.
5. Fetch remote page 1 asynchronously and reconcile selection/active item.
6. Preserve selection while items refresh.
7. Support `nextCursor` via `Load more…` item or guarded background pagination.
8. Ignore/cancel updates after picker dispose or scope change.
9. Apply same shared picker service to delete-history command without duplicating lifecycle logic.
10. Remote delete must be confirmed against authoritative agent capability/result; stale cache alone không cấp quyền delete server-side.

**Gate:**

- picker shell shown trong cùng event-loop turn;
- cached items appear dưới `50 ms` trên benchmark machine;
- 120 synthetic sessions đều reachable đúng một lần và sorted newest-first;
- remote failure giữ cached list với warning non-modal;
- no update attempted after picker disposal.

### Phase 4 — Multi-session single-pass history publication

1. Add replay phase/load epoch to `ManagedSession`.
2. Set `collecting` before invoking `session/load`.
3. In `append()`, suppress transcript-content delta while collecting; continue storing events and lightweight state.
4. After response and queue drain, flush user buffer and append final history `streamEnd` while suppression is still active.
5. Capture/post exactly one non-empty history snapshot.
6. Switch to live phase only after snapshot boundary is published.
7. Later notifications become deltas with contiguous sequence numbers.
8. Use activation revision + load epoch to prevent stale load publication after rapid switches/close.
9. Do not publish intermediate full transcript snapshots during collection.

**Gate:**

- transcript-content delta count during history collection bằng `0`;
- exactly one non-empty history snapshot per load;
- one transcript reset/render per load;
- first late/live delta has `seq = snapshot.lastSeq + 1`;
- no false resync or cross-session render under rapid A → B activation.

### Phase 5 — Finalized snapshot rendering

1. Add snapshot replay lifecycle to the webview bridge/message list.
2. Suspend per-event auto-scroll, input focus, paint invalidation and action-button finalization.
3. Add `setContent()` to `TextBlock` and `ThoughtBlock`.
4. Route snapshot text/thought blocks through finalized content rendering.
5. Finalize assistant actions once per completed assistant message.
6. Apply metadata/context/diff/permissions after transcript surface is stable.
7. Restore draft, generation state and scroll once.
8. Yield between bounded event groups using browser scheduling if a replay task still exceeds the gate.
9. Keep live `appendContent()` semantics unchanged initially; rAF coalescing belongs to a later measured optimization.

**Gate:**

- `marked.parse()` count không vượt số finalized text/thought blocks cộng một hằng số nhỏ;
- zero per-event scroll-settle operations during snapshot replay;
- Medium replay task p95 dưới `50 ms`, max dưới `100 ms`; nếu chưa đạt mới thêm bounded snapshot batches;
- visual ordering/output matches current behavior.

### Phase 6 — Historical tool/diff fast path

1. Pass explicit history/snapshot replay context into tool pipeline.
2. Skip `captureBaseContent()` and workspace file reads in history mode.
3. Preserve agent-provided structured diff/content.
4. Render historical tool summary immediately but defer large details/diffs.
5. Cache first details render.
6. Add oversized diff guard before LCS allocation.
7. Ensure history-specific collapsed policy actually prevents eager edit/write/execute detail rendering.

**Gate:**

- workspace read count during history restoration bằng `0`;
- collapsed historical tools invoke diff/LCS renderer `0` times;
- expanding a tool renders once and subsequent toggles reuse cached details;
- live tool/diff behavior unchanged.

### Phase 7 — Pi replay event reduction and conditional generic batching

#### Pi-specific

1. Evaluate emitting one final ACP `tool_call` for each historical `toolResult` instead of final `tool_call` plus final `tool_call_update`.
2. Keep one notification per saved user/assistant message.
3. Preserve tool title, status, raw output, content and ordering.

#### Generic ACP, only if metrics require it

Add a pure `HistoryReplayCollector` when a third-party/chunk-heavy agent still produces excessive raw events after single-pass publication:

- compact consecutive user/text/thought chunks;
- preserve user/thought/tool/text boundaries;
- keep latest metadata snapshots where order permits;
- create bounded batches by event count and estimated bytes;
- retain replay/load epoch and sequence ordering.

Initial batch guard, subject to benchmark:

- up to `100` events; or
- about `512 KiB` estimated payload;
- oversized single event sent alone.

**Gate:**

- Pi toolResult uses at most one ACP tool notification if compatibility tests pass;
- generic Medium profile reduces host-to-webview message count ít nhất `90%` when collector is enabled;
- no collector added to default path unless baseline demonstrates material benefit.

### Phase 8 — Rollout and documentation

1. Run deterministic counters and wall-clock benchmarks before/after.
2. Test at least bundled Pi and one non-Pi ACP agent/mock.
3. Update `docs/features/feature-catalog.md` with user-visible behavior changes.
4. Update this plan status/completion notes after implementation.
5. Update vendored Pi `UPSTREAM.md` for local index/direct-lookup/replay patches.
6. Run quality gates, production package, VSIX package and local install per repository workflow.
7. Instruct user to run `Developer: Reload Window` after installation.

## File-level change map

| File/area                                                              | Planned change                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/extension.ts`                                                     | Immediate QuickPick shell, shared async picker controller, composite selection payload                 |
| `src/acp/session-manager.ts`                                           | Page-aware list API, local fallback page/snapshot access, preserve `nextCursor`                        |
| `src/acp/client.ts`                                                    | Timing/count hooks around list/load/notification boundaries; no content logs                           |
| `src/features/multi-session/session-catalog.ts`                        | Composite scope, page API, consistent `cwd` filter, remote snapshot integration                        |
| `src/features/multi-session/host.ts`                                   | Remove ID-only agent map/title relist; replay phase; suppress history deltas; atomic snapshot boundary |
| `src/features/multi-session/contracts.ts`                              | Typed history identity/page/replay fields if feature protocol requires them                            |
| `src/features/multi-session/webview.ts`                                | Single finalized snapshot replay and stale epoch guards                                                |
| `src/features/multi-session/transcript-store.ts`                       | Verify compaction/sequence semantics for publication boundary                                          |
| `src/acp/session-output-pipeline.ts`                                   | History context; skip historical file reconstruction                                                   |
| `src/views/webview/main.ts`                                            | Snapshot replay lifecycle bridge                                                                       |
| `src/views/webview/component/message-list.ts`                          | Suspend/resume render side effects; finalized block replay                                             |
| `src/views/webview/block/text-block.ts`                                | `setContent()` and parse metrics                                                                       |
| `src/views/webview/block/thought-block.ts`                             | `setContent()` and parse metrics                                                                       |
| `src/views/webview/block/tool-block.ts`                                | Lazy historical details and cached render                                                              |
| `src/views/webview/widget/diff-render.ts`                              | Deferred invocation and oversized diff guard                                                           |
| `src/features/pi-agent/vendor/pi-acp/src/acp/pi-sessions.ts`           | Indexed metadata discovery, reusable page snapshot, direct mapping support                             |
| `src/features/pi-agent/vendor/pi-acp/src/acp/session-store.ts`         | In-memory map, validation, bulk upsert/single flush                                                    |
| `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`                 | Reuse list snapshot/mapping, reduce redundant lookup/replay events                                     |
| `src/features/pi-agent/vendor/pi-acp/src/acp/pi-session-transcript.ts` | Add timing/count seams; memory optimization only if measured                                           |
| `src/test/features/`                                                   | Composite identity, pagination, single-pass publication, replay races                                  |
| Vendored Pi tests                                                      | Index invalidation, page reuse, direct lookup, replay notification count                               |

Core changes are generic history performance/correctness fixes suitable for upstream. Pi-specific indexing and replay changes remain inside the bundled Pi feature/vendor boundary.

## Test strategy

### Catalog and identity

1. Same `sessionId` under Pi and OpenCode loads/deletes selected agent only.
2. Picker opened under agent A, active session switches to B, selected A item still loads A.
3. Disconnected local fallback filters exact `cwd`.
4. Remote page cursor is forwarded and `nextCursor` preserved.
5. 120 sessions across three pages are reachable without duplicates.
6. Picker disposal ignores late page responses.
7. Stale remote snapshot is replaced by authoritative response without losing current selection.

### Bundled Pi index

1. Cold scan extracts title/cwd/updatedAt/sessionId in one pass per file.
2. Warm scan parses no unchanged JSONL content.
3. Changed file invalidates only its index entry.
4. Deleted file disappears.
5. Session directory setting change invalidates old snapshot.
6. Page 2 reuses page 1 discovery snapshot.
7. Successful list bulk persists mappings.
8. New load process resolves selected session without fallback full scan.
9. Stale/missing mapped file falls back safely and repairs mapping.

### Replay publication and ordering

1. History events append to transcript but emit no deltas during collection.
2. Final snapshot includes user, thought, assistant and tool events in exact order.
3. Final history `streamEnd` is inside snapshot boundary.
4. Notification received during drain is included or emitted later exactly once.
5. Notification immediately after snapshot becomes contiguous delta.
6. Stale load epoch cannot overwrite newer activation.
7. Closing session during load does not publish stale transcript.
8. Loading already-open history only activates it and does not call ACP load again.

### Webview

1. Snapshot reset occurs once.
2. One finalized text block calls `marked.parse()` once.
3. Thought block has same guarantee.
4. Action buttons render once per finalized assistant response.
5. No per-event scroll settle during replay.
6. Draft/scroll/generation state restore after transcript.
7. Historical collapsed tool does not render diff before expansion.
8. Expansion renders once and caches details.

### Performance assertions

Ưu tiên deterministic counters trong CI:

- duplicate selection-time `session/list` count: `0`;
- Pi warm metadata parse count: `0` for unchanged files;
- load-after-list fallback discovery count: `0`;
- history content delta count in multi-session: `0`;
- non-empty final snapshot count: `1`;
- transcript reset count: `1`;
- Markdown parse count: one per finalized text/thought block;
- historical workspace read count: `0`;
- eager historical diff render count: `0`.

Wall-clock benchmark trên cùng machine/build:

- cached picker items under `50 ms`;
- at least `70%` reduction in extension-controlled Medium-profile time from final ACP history notification to settled UI;
- no single Medium replay task over `100 ms` after yielding;
- no regression over `10%` for small history or live streaming.

## Recommended delivery slices

### Slice A — Highest-impact extension quick wins

- Phase 0 minimum metrics;
- composite selection and remove title relist;
- suppress multi-session history deltas;
- one snapshot boundary;
- `setContent()` finalized snapshot rendering.

Expected effort: 1–2 days. Expected effect: remove one remote list and one full duplicate render.

### Slice B — Pi catalog scalability and picker UX

- Pi metadata index/direct mapping;
- immediate cached QuickPick;
- page-aware catalog and `Load more…`;
- remote catalog snapshot.

Expected effort: 1–2 days. Expected effect: list cost becomes proportional mainly to changed files; session after page 50 becomes reachable.

### Slice C — Historical tool path and generic ACP batching

- skip workspace reconstruction;
- lazy diff/details;
- Pi tool notification reduction;
- generic collector/batches only if measured.

Expected effort: 1–2 days depending on tool rendering refactor and agent compatibility.

## Risks and mitigations

| Risk                                                        | Mitigation                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Stale Pi index points to moved/deleted file                 | Validate path/stat/header before use; fallback discovery repairs mapping                             |
| Cache hides newly created external sessions                 | Cached list is stale display only; remote refresh remains authoritative                              |
| Pagination repeats expensive scan                           | Pi page requests reuse one immutable discovery snapshot with bounded expiry/invalidation             |
| Composite contract migration breaks command call sites      | Introduce adapter overload temporarily; migrate load/delete tests before removing ID-only path       |
| Delta suppression loses late notifications                  | Publish snapshot boundary before live phase; late updates remain contiguous deltas                   |
| `waitForIdle()` is mistaken for future-notification barrier | Treat it only as drain of currently received work; accept later notifications rather than sleep/drop |
| Finalized render merges real block boundaries               | Preserve transcript event boundaries; add text → tool → text and thought → text tests                |
| Lazy diff changes historical expanded/open state            | Add explicit history-only policy and manual visual comparison                                        |
| Remote snapshot stores sensitive data                       | Persist metadata only: ID/title/cwd/time; no transcript/tool payload                                 |
| Temporary ACP runtime startup remains slow                  | Measure first; runtime leasing/adoption is optional follow-up, not initial complexity                |
| Pi full active-path parser retains all entries              | Profile memory; optimize separately only if large JSONL causes measured pressure                     |

## Completion notes

Implemented on 2026-07-15:

- composite history references and page-aware cursor APIs;
- immediate stale-while-revalidate QuickPick shared by load/delete, with persisted remote metadata cache, local fallback merge, lifecycle guards, and `Load more…`;
- bundled Pi JSONL metadata index, canonical-file cache validation, reusable pagination snapshot, bulk/direct session mapping, and one historical tool notification;
- multi-session collecting/live replay boundary with no history transcript deltas and one non-empty publication snapshot;
- finalized snapshot text/thought rendering, suspended replay side effects, lazy cached historical tool details, and oversized diff guard;
- history mode skips current-workspace diff reconstruction in both legacy and multi-session pipelines.

Verification completed:

- root typecheck, focused lint, production package, VSIX package, and local installation;
- focused VS Code integration suite: 91 passing;
- vendored Pi suite: 140 passing.

Wall-clock benchmark thresholds for the synthetic Medium/Large profiles were not automated in CI; deterministic counters cover the correctness/performance invariants, and further generic batching remains conditional on profiling.

## Definition of Done

- Current agent-scoped history flow is represented by typed composite identity.
- QuickPick appears before remote list completion and can show cached metadata.
- ACP cursor pagination is supported; sessions after page 1 are reachable.
- Bundled Pi warm listing avoids JSONL content parsing for unchanged files.
- Bundled Pi load after list resolves directly without another global scan.
- Selection does not call `session/list` again for title.
- Multi-session history emits no transcript deltas during collection and publishes one final snapshot.
- Snapshot restoration renders transcript once and Markdown once per finalized text/thought block.
- Historical replay does not read current workspace to reconstruct diffs.
- Late notifications, rapid activation and same-ID/different-agent cases are covered by tests.
- Before/after metrics meet agreed gates or remaining bottlenecks are documented with evidence.
- Typecheck, lint, relevant tests, production package, VSIX package and local install complete successfully when implementation changes code.
