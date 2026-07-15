# Kế hoạch triển khai: Tối ưu hiệu năng mở chat và tải lịch sử

| Thuộc tính | Giá trị |
| ---------- | ------- |
| Trạng thái | Bản nháp |
| Chủ sở hữu | Engineering |
| Giai đoạn | Lập kế hoạch triển khai |
| Phạm vi | Độ trễ cảm nhận của **New Chat**, đường nóng khởi động ACP runtime, bundled Pi history discovery/load, render snapshot multi-session, đo đạc hiệu năng, kiểm thử |
| Phụ thuộc | [Fast Chat History Loading](./implement-fast-chat-history-loading.md), [Eager Multi-Session Runtime Loading](./implement-eager-multi-session-runtime.md) |
| Liên quan | [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md), [Session Switch Loading](./implement-session-switch-loading.md), [Pi ACP Full History Replay](./implement-pi-acp-full-history-replay.md) |
| Tham chiếu | `src/features/multi-session/host.ts`, `src/features/multi-session/webview.ts`, `src/features/multi-session/session-catalog.ts`, `src/acp/client.ts`, `src/acp/agents.ts`, `src/utils/bin-paths.ts`, `src/features/pi-agent/vendor/pi-acp/src/acp/`, `src/views/webview/` |

## Mục tiêu

Giảm độ trễ người dùng cảm nhận khi:

- bấm **New Chat**;
- mở danh sách history;
- chọn một session từ history list;
- chuyển lại các session lớn đã từng mở.

Mục tiêu là giảm hoặc đưa ra khỏi đường UI các bước đang chặn người dùng, không chỉ hiển thị spinner lâu hơn. Các điểm cần xử lý gồm: spawn/connect ACP process, `session/new`, restore mode/model/config tuần tự, Pi scan JSONL, Pi replay history từng notification, host queue xử lý toàn bộ transcript, và webview reset/replay DOM.

## Nút thắt hiện tại

### New Chat

Luồng hiện tại:

```text
New Chat
  -> tạo draft
  -> activate draft
  -> ensureRuntime(session, true)
     -> kiểm tra command availability
     -> build PATH/global bin paths
     -> spawn ACP process
     -> initialize handshake
     -> reload MCP config
     -> session/new
     -> restoreSessionPreferences()
        -> setMode
        -> setModel
        -> setConfigOption ... tuần tự
  -> gửi snapshot
```

Vì `newChat()` đang chờ `ensureRuntime(session, true)`, UI phải chịu toàn bộ chi phí startup của agent. Với Pi/OpenCode/Claude, spawn + initialize + `session/new` + restore preference có thể mất vài giây.

### History list/load

Luồng chọn history đã được tối ưu một phần bởi [Fast Chat History Loading](./implement-fast-chat-history-loading.md), nhưng vẫn còn các chi phí lớn:

```text
History list
  -> runtime/session catalog
  -> Pi discover sessions
     -> walk toàn bộ *.jsonl
     -> stat toàn bộ file
     -> parse metadata file thay đổi
  -> QuickPick / page

Load selected history
  -> tạo loading session
  -> ensureRuntime(session, false)
  -> ACP session/load
  -> Pi tìm session file
  -> đọc full JSONL active path
  -> replay từng historical user/assistant/tool message
  -> host serial queue drain toàn bộ notifications
  -> gửi final snapshot
  -> webview reset + replay transcript DOM
```

Các tối ưu đã có:

- tránh duplicate active delta render trong lúc load;
- cache Pi metadata theo `size/mtime`;
- cache remote catalog snapshot;
- giảm số lần parse Markdown khi replay snapshot.

Các khoảng trống còn lại:

- Pi discovery vẫn walk/stat toàn bộ cây session cho mỗi forced discovery.
- Pi adapter mới spawn có thể chưa có index của lần list trước, nên load lại scan.
- Pi replay vẫn emit nhiều ACP notifications tuần tự.
- Webview vẫn dựng lại DOM từ full snapshot khi cold history load và khi switch session lặp lại.

### Session switching

`activate()` gửi full snapshot. `MultiSessionWebviewController.applySnapshot()` reset chat surface rồi replay toàn bộ transcript events. Vì vậy mở lại một session lớn sẽ parse Markdown và dựng tool DOM lại, kể cả session đó vừa được render trong cùng webview.

## Chỉ số thành công

Dùng fixture deterministic và so sánh trước/sau trên cùng corpus agent/session.

| Chỉ số | Mục tiêu |
| ------ | -------- |
| `newChat.draftVisibleMs` | Draft/session header hiện trong `<100ms`, không chờ ACP runtime. |
| `newChat.firstSendCorrectness` | Prompt gửi trong lúc runtime startup dùng đúng 1 client, 1 ACP session, đúng model/mode/config. |
| `piHistory.cachedListMs` | Mở lại history picker từ warm index không full tree walk/stat trừ khi bị invalidate. |
| `piHistory.loadNotificationCount` | Bundled Pi replay phát ít notifications hơn với transcript có thể coalesce, không đổi thứ tự/nội dung hiển thị. |
| `historyLoad.hostQueueMs` | Đo và giảm hoặc bound thời gian host queue drain với fixture lớn. |
| `sessionSwitch.warmMs` | Switch lại session đã có DOM cache không replay toàn bộ transcript. |
| Correctness | Multi-session, permissions, diffs, context usage, continuation, cancel và history tests hiện có vẫn pass. |

Không đặt budget wall-clock cứng vì phụ thuộc agent startup và tốc độ disk. Mỗi tác vụ phải báo counter và phase timing, không chỉ báo thời gian end-to-end.

## Ngoài phạm vi

- Không thay đổi public ACP protocol bắt buộc với third-party agents.
- Không bỏ full-fidelity Pi history replay.
- Không gửi historical transcript trở lại model khi continue một loaded session.
- Không persist rendered DOM hoặc transcript body qua webview reload/Extension Host restart.
- Không tạo một VS Code webview/chat tab riêng cho từng session.
- Không làm yếu ordering guarantee đang được serial queue bảo vệ.
- Không đưa product logic lớn vào upstream/core files ngoài các hook tích hợp/đo đạc nhỏ, generic.

## Quyết định kiến trúc

### 1. Tách UI activation khỏi runtime/session creation

Local draft phải hiện ngay. ACP runtime startup và ACP `session/new` không được chặn command **New Chat**.

Hành vi khuyến nghị:

```text
New Chat
  -> tạo local draft
  -> activate/gửi state+snapshot ngay
  -> start runtime nền nếu hữu ích
  -> chỉ tạo ACP session khi first send hoặc explicit Start Chat
```

Điều này khớp nguyên tắc eager runtime hiện có: connect process thì chấp nhận được, nhưng không tạo ACP history/session rỗng chỉ vì mở view.

### 2. Bảo toàn correctness của first send

Dù runtime startup chạy nền, first send phải chờ:

1. một runtime startup promise duy nhất đang in-flight;
2. `session/new` đúng một lần;
3. model/mode/config cần thiết được áp dụng trước khi prompt rời extension.

### 3. Cache các bước availability/config đắt khỏi hot path

Command availability checks, global bin path probing và MCP config parsing nên được cache hoặc đưa khỏi blocking connect path khi an toàn. Spawn failure vẫn là fallback authoritative nếu command biến mất sau lần validate cache.

### 4. Xem Pi history discovery như một index

Bundled Pi adapter nên duy trì session index có invalidation, không chỉ cache metadata từng file. Warm list/load nên reuse cùng mapping `sessionId -> file metadata` khi sessions dir/settings chưa đổi.

### 5. Coalesce history replay trước khi vào host queue

Vị trí tốt nhất để giảm event count là bundled Pi adapter trước khi emit ACP notifications. Giữ ordering và nội dung hiển thị, nhưng tránh gửi các historical chunk/progress thừa khi một final render message là đủ.

### 6. DOM cache là hướng xử lý session switch

Plan này sẽ thực thi hoặc tiêu thụ [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md), không nhân bản toàn bộ thiết kế đó. Tối ưu history backend không tự giải quyết được lag khi switch A/B các session lớn.

## Danh sách tác vụ

### Giai đoạn 0 — Baseline instrumentation

#### Tác vụ 1: Thêm phase timing và counters

**Mô tả:** Thêm performance markers chi phí thấp quanh New Chat, ACP connect, `session/new`, preference restore, Pi discovery, Pi replay, host queue drain, snapshot publish và webview snapshot apply. Log chi tiết phải được gate bằng debug flag/setting để không spam người dùng thường.

**Tiêu chí chấp nhận:**

- [ ] Log có correlation ID cho từng New Chat hoặc history load.
- [ ] Timing tách riêng connect, `session/new`, preferences, Pi discovery, JSONL read, replay emit, host queue drain và webview replay.
- [ ] Pi discovery counters phân biệt full walk/stat, index hit, metadata parse, deleted entries và force refresh.
- [ ] Tests có thể assert deterministic counters, không phụ thuộc wall-clock.

**Xác minh:**

- [ ] Unit tests cho counter increments trên fake Pi session fixtures.
- [ ] Manual run capture được một New Chat trace và một history load trace.
- [ ] `npm run check-types` pass.

**Phụ thuộc:** Không.

**File dự kiến chạm:**

- `src/features/multi-session/host.ts`
- `src/acp/client.ts`
- `src/features/pi-agent/vendor/pi-acp/src/acp/pi-sessions.ts`
- `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`
- `src/features/multi-session/webview.ts`
- `src/test/features/`

**Quy mô ước tính:** Vừa.

### Giai đoạn 1 — Giảm độ trễ cảm nhận của New Chat

#### Tác vụ 2: Cho New Chat activate ngay và start runtime bất đồng bộ

**Mô tả:** Đổi `MultiSessionHostController.newChat()` để tạo/activate local draft và gửi state/snapshot ngay. Runtime startup có thể bắt đầu ở nền, nhưng `New Chat` không được chờ spawn/connect/initialize/`session/new` trước khi người dùng gõ được.

**Tiêu chí chấp nhận:**

- [ ] Draft mới hiện ngay với trạng thái starting/initializing nếu runtime đang start.
- [ ] Không gọi ACP `session/new` chỉ vì người dùng bấm **New Chat**.
- [ ] Nếu background runtime startup lỗi, draft vẫn retry được và chỉ hiện một lỗi rõ ràng.
- [ ] Bấm New Chat liên tiếp không reuse sai runtime/session.
- [ ] Hành vi explicit **Start Chat** hiện có vẫn hoạt động.

**Xác minh:**

- [ ] Host test chứng minh `newChat()` post state/snapshot trước khi fake client connect resolve.
- [ ] Host test chứng minh `newChat()` không gọi `newSession()`.
- [ ] Host test chứng minh background connect fail không reject command handler.

**Phụ thuộc:** Khuyến nghị sau Tác vụ 1.

**File dự kiến chạm:**

- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`

**Quy mô ước tính:** Vừa.

#### Tác vụ 3: Làm first send race-safe sau New Chat bất đồng bộ

**Mô tả:** Reuse runtime startup guard từ eager runtime loading để first send chờ connect đang in-flight, tạo ACP session một lần, apply preferences cần thiết rồi mới gửi prompt. Tránh duplicate client hoặc gửi với model/mode/config stale.

**Tiêu chí chấp nhận:**

- [ ] Gửi prompt khi background runtime đang connecting reuse đúng client đó.
- [ ] `session/new` được gọi đúng một lần cho mỗi local draft ở first send.
- [ ] Preferences model/mode/config cần thiết được áp dụng trước `sendMessage()`.
- [ ] Nếu restore preference lỗi, người dùng thấy lỗi rõ ràng và prompt không bị gửi âm thầm với setting không xác định.
- [ ] History loading sessions không bị vô tình convert thành new sessions.

**Xác minh:**

- [ ] Host test với connect promise điều khiển thủ công.
- [ ] Host test với first send đến trước khi connect hoàn tất.
- [ ] Message queue tests hiện có pass.

**Phụ thuộc:** Tác vụ 2.

**File dự kiến chạm:**

- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`

**Quy mô ước tính:** Vừa.

#### Tác vụ 4: Giảm round-trip restore preferences

**Mô tả:** Tránh ACP calls tuần tự không cần thiết sau `session/new`. Cache selected values đã biết, skip no-op updates, và chạy các config option độc lập với bounded concurrency sau khi xác minh an toàn về ordering.

**Tiêu chí chấp nhận:**

- [ ] `setMode`, `setModel` và `setConfigOption` được skip khi desired value đã active hoặc unset.
- [ ] Các config option độc lập không còn chạy tuần tự tuyệt đối, trừ khi được đánh dấu order-sensitive.
- [ ] Lỗi báo rõ preference nào fail.
- [ ] First prompt vẫn chờ required preferences.

**Xác minh:**

- [ ] Unit tests đếm ACP calls cho preferences không đổi.
- [ ] Unit tests cover thông báo lỗi partial config failure.
- [ ] Manual New Chat trace cho thấy preference phase giảm thời gian/số calls.

**Phụ thuộc:** Tác vụ 3.

**File dự kiến chạm:**

- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`

**Quy mô ước tính:** Vừa.

#### Tác vụ 5: Đưa sync command/config probing khỏi connect hot path khi an toàn

**Mô tả:** Thay repeated sync `which`/`where`, pnpm/npm global bin probing và MCP config reload không đổi bằng cache có invalidation. Không che giấu spawn failure thật; lỗi phải được báo từ actual process start.

**Tiêu chí chấp nhận:**

- [ ] Hot-path `ACPClient.connect()` không gọi sync shell probes lặp lại cho command đã validate trong lifecycle hiện tại.
- [ ] Global bin paths được cache và refresh khi agent configuration đổi.
- [ ] MCP config chỉ đọc lại khi path/mtime/size liên quan thay đổi.
- [ ] Nếu command bị xóa sau validate, spawn failure vẫn hiển thị lỗi rõ ràng.

**Xác minh:**

- [ ] Unit tests cho availability cache hit/miss/force refresh.
- [ ] Unit tests cho MCP config cache invalidation.
- [ ] Manual trace cho thấy connect path không còn tốn thời gian ở repeated sync probes.

**Phụ thuộc:** Tác vụ 1.

**File dự kiến chạm:**

- `src/acp/client.ts`
- `src/acp/agents.ts`
- `src/utils/bin-paths.ts`
- `src/test/`

**Quy mô ước tính:** Vừa.

### Giai đoạn 2 — Pi history discovery/indexing

#### Tác vụ 6: Thêm warm Pi session discovery snapshot có invalidation

**Mô tả:** Mở rộng bundled Pi discovery từ “metadata cache từng file” thành “warm snapshot/index có invalidation”. Tránh walk/stat đệ quy toàn bộ sessions tree ở mỗi lần list khi settings path và sessions dir không đổi và chưa có watcher/TTL invalidation.

**Tiêu chí chấp nhận:**

- [ ] Warm `session/list` có thể trả về sorted snapshot trước đó mà không full recursive walk/stat.
- [ ] Force refresh vẫn full discovery.
- [ ] Settings file path/mtime/size đổi sẽ invalidate snapshot.
- [ ] Sessions directory đổi sẽ invalidate hoặc đánh dấu stale theo watcher/TTL behavior.
- [ ] File đã xóa biến mất sau refresh.

**Xác minh:**

- [ ] Pi discovery tests với temp JSONL tree xác minh cold vs warm counters.
- [ ] Test sửa một file và chứng minh chỉ metadata liên quan được parse lại sau invalidation.
- [ ] `npm run check-types` pass.

**Phụ thuộc:** Tác vụ 1.

**File dự kiến chạm:**

- `src/features/pi-agent/vendor/pi-acp/src/acp/pi-sessions.ts`
- `src/features/pi-agent/vendor/pi-acp/test/` hoặc `src/test/features/pi-agent/`

**Quy mô ước tính:** Vừa.

#### Tác vụ 7: Reuse list index khi lookup load session

**Mô tả:** Đảm bảo Pi adapter resolve được `sessionId` đã chọn sang JSONL file bằng discovery/index mới nhất, thay vì scan toàn bộ tree lần nữa trong path phổ biến list-then-load.

**Tiêu chí chấp nhận:**

- [ ] Load một session ngay sau khi list dùng cached/indexed file mapping.
- [ ] Load bằng raw session id khi chưa list vẫn fallback sang discovery.
- [ ] Index entries validate `size/mtime` trước khi tin metadata có thể stale.
- [ ] Session file missing/deleted trả lỗi rõ ràng và có thể force refresh.

**Xác minh:**

- [ ] Unit test list-then-load cho thấy không có full walk lần hai.
- [ ] Unit test raw-load fallback vẫn tìm được session.
- [ ] Unit test file bị xóa trong lúc load trả lỗi ổn định.

**Phụ thuộc:** Tác vụ 6.

**File dự kiến chạm:**

- `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`
- `src/features/pi-agent/vendor/pi-acp/src/acp/pi-sessions.ts`
- `src/features/pi-agent/vendor/pi-acp/test/` hoặc `src/test/features/pi-agent/`

**Quy mô ước tính:** Vừa.

### Giai đoạn 3 — Giảm Pi history replay và host queue

#### Tác vụ 8: Coalesce replay messages trong bundled Pi trước khi emit ACP updates

**Mô tả:** Tối ưu `replayPiMessages()` để historical transcript được emit thành tập ACP updates nhỏ nhất có thể nhưng vẫn giữ user messages, assistant messages, tool cards, statuses và continuation semantics. Không coalesce qua ranh giới turn có ý nghĩa.

**Tiêu chí chấp nhận:**

- [ ] Các assistant text fragments liên tiếp trong cùng turn emit một `agent_message_chunk`.
- [ ] Các user text fragments liên tiếp trong cùng turn emit một `user_message_chunk`.
- [ ] Completed historical tools emit final `tool_call` state, không phát progress notifications thừa.
- [ ] Tool error/completion status và content vẫn hiển thị.
- [ ] Replay order ổn định và deterministic.

**Xác minh:**

- [ ] Adapter tests so sánh rendered transcript từ fixture cũ và optimized replay fixture.
- [ ] Tests assert notification count giảm với chunk-heavy fixture.
- [ ] Manual history load trace báo replay count và host queue duration.

**Phụ thuộc:** Tác vụ 1.

**File dự kiến chạm:**

- `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`
- `src/features/pi-agent/vendor/pi-acp/test/` hoặc `src/test/features/pi-agent/`

**Quy mô ước tính:** Vừa.

#### Tác vụ 9: Thêm bounded replay emission/backpressure

**Mô tả:** Tránh một `await` round-trip cho từng historical notification khi transport có thể giữ ordering bằng enqueue writes. Dùng bounded batches/yields để large history replay không starve cancellation, errors hoặc process lifecycle events.

**Tiêu chí chấp nhận:**

- [ ] Replay order giữ nguyên.
- [ ] Large history replay yield định kỳ và vẫn cancellable/disposable.
- [ ] Không tăng memory vô hạn khi load JSONL rất lớn.
- [ ] Transport errors dừng replay và surface load failure rõ ràng.

**Xác minh:**

- [ ] Stress test với large fake history validate order và bounded memory/counters.
- [ ] Test cancellation/dispose trong lúc replay không tiếp tục emit vô hạn.
- [ ] Manual trace cho thấy replay emit time giảm trên fixture lớn.

**Phụ thuộc:** Tác vụ 8.

**File dự kiến chạm:**

- `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`
- `src/features/pi-agent/vendor/pi-acp/test/` hoặc `src/test/features/pi-agent/`

**Quy mô ước tính:** Vừa.

#### Tác vụ 10: Giữ full/compacted history mode minh bạch

**Mô tả:** Giữ `pi.historyLoadMode = "full"` là mode ưu tiên fidelity trừ khi product quyết định khác. Cải thiện discoverability và tests cho `"compacted"` như mode thiên về tốc độ, nhưng không âm thầm đổi semantics history của người dùng trong performance pass này.

**Tiêu chí chấp nhận:**

- [ ] Setting docs mô tả rõ trade-off `full` vs `compacted`.
- [ ] Tests cover cả hai modes.
- [ ] Performance traces include active mode.
- [ ] Không tự động downgrade từ full sang compacted nếu user chưa set rõ.

**Xác minh:**

- [ ] Review config schema/docs hoặc package metadata.
- [ ] Manual load ở cả hai modes xác nhận transcript behavior đúng kỳ vọng.

**Phụ thuộc:** Tác vụ 1.

**File dự kiến chạm:**

- `package.json`
- `README.md` hoặc `docs/features/feature-catalog.md` sau triển khai
- `src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts`
- `src/test/`

**Quy mô ước tính:** Nhỏ.

### Giai đoạn 4 — Webview replay và session switch latency

#### Tác vụ 11: Thực hiện plan chat surface DOM cache

**Mô tả:** Triển khai [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md) như hướng xử lý chính cho repeated A/B session switching. Tác vụ này phải theo thiết kế của plan liên quan: mỗi local session có một rendered transcript surface cache, inactive rendering lazy, direct message-list dispatch, LRU eviction và snapshot catch-up.

**Tiêu chí chấp nhận:**

- [ ] Switch lại cached session không gọi full `bridge.reset()` + replay toàn bộ transcript events.
- [ ] Events thiếu sau `seq` cuối đã render được append đúng một lần.
- [ ] Evicted sessions fallback an toàn về full snapshot replay.
- [ ] Inactive sessions không render live DOM work.
- [ ] Memory cap/LRU eviction ngăn giữ surface vô hạn.

**Xác minh:**

- [ ] Reuse verification từ `implement-multi-session-dom-surface-cache.md`.
- [ ] Webview tests assert warm switch tránh full replay.
- [ ] Manual large-session A/B switch trace cho thấy cải thiện warm switch.

**Phụ thuộc:** Tác vụ 1; có thể làm song song với Giai đoạn 2/3 sau khi instrumentation có.

**File dự kiến chạm:**

- `src/features/multi-session/webview.ts`
- `src/features/multi-session/styles.ts`
- `src/views/webview/component/message-list.ts`
- `src/views/webview/main.ts`
- `src/test/features/`

**Quy mô ước tính:** Lớn; cần chia nhỏ theo plan liên quan trước khi triển khai.

#### Tác vụ 12: Thêm revision-safe loading overlay nếu switch vẫn lộ transcript cũ

**Mô tả:** Nếu DOM cache hoặc cold replay vẫn để lộ stale transcript/welcome flicker, triển khai phần tối thiểu của [Session Switch Loading](./implement-session-switch-loading.md): tách target/rendered session, overlay và composer lock.

**Tiêu chí chấp nhận:**

- [ ] Snapshot từ activation revision cũ không thể clear loading hoặc ghi đè target mới.
- [ ] Composer bị lock trong lúc cold snapshot replay đang apply.
- [ ] Draft/scroll được lưu cho rendered session, không phải target session.
- [ ] Overlay dùng VS Code theme tokens và semantics `aria-busy`.

**Xác minh:**

- [ ] Rapid switch tests với out-of-order snapshots.
- [ ] Manual switch trong lúc đang gõ draft xác nhận draft preservation.
- [ ] Accessibility smoke check cho reduced motion và focus lock.

**Phụ thuộc:** Tác vụ 11 hoặc quyết định rõ ràng là cải thiện UX trước DOM cache.

**File dự kiến chạm:**

- `src/features/multi-session/webview.ts`
- `src/features/multi-session/styles.ts`
- `src/test/features/`
- `docs/architecture/acp-chat-layout.md` nếu layout đổi.

**Quy mô ước tính:** Vừa.

### Giai đoạn 5 — Tích hợp, docs, release

#### Tác vụ 13: Thêm performance fixtures và regression tests end-to-end

**Mô tả:** Tạo fixtures deterministic cho Pi JSONL history lớn và multi-session transcript replay để thay đổi sau này không tái tạo full scans/replays mà không bị phát hiện.

**Tiêu chí chấp nhận:**

- [ ] Fixture cover nhiều sessions, một session đổi, session bị xóa, transcript lớn, tool calls và chunk-heavy assistant output.
- [ ] Tests assert counters thay vì wall-clock timing.
- [ ] Tests chạy trong CI mà không cần binary Pi/Claude/OpenCode thật.

**Xác minh:**

- [ ] Focused test command pass local.
- [ ] Root typecheck và relevant test suite pass.

**Phụ thuộc:** Giai đoạn 1-4.

**File dự kiến chạm:**

- `src/test/fixtures/`
- `src/test/features/`
- `src/features/pi-agent/vendor/pi-acp/test/`

**Quy mô ước tính:** Vừa.

#### Tác vụ 14: Cập nhật docs người dùng và completion notes

**Mô tả:** Sau khi triển khai, cập nhật feature catalog và plan này với behavior thực tế, commands đã chạy, counters trước/sau, hạng mục bỏ qua và rollout caveats.

**Tiêu chí chấp nhận:**

- [ ] `docs/features/feature-catalog.md` mô tả behavior New Chat/history đã thay đổi.
- [ ] Plan này có status/completion notes phản ánh phase nào đã làm/bỏ qua.
- [ ] Related plan links chỉ cập nhật khi bị ảnh hưởng trực tiếp.
- [ ] Không biến docs `README.md` thành backlog hoặc dump chi tiết implementation.

**Xác minh:**

- [ ] Review diff tài liệu.
- [ ] `git diff --check` pass.

**Phụ thuộc:** Triển khai và xác minh hoàn tất.

**File dự kiến chạm:**

- `docs/features/feature-catalog.md`
- `docs/plans/implement-chat-startup-history-performance.md`
- Related plan docs chỉ khi bị ảnh hưởng trực tiếp.

**Quy mô ước tính:** Nhỏ.

## Checkpoints

### Checkpoint A — Baseline và New Chat

Sau Tác vụ 1-5:

- [ ] New Chat draft hiện ngay.
- [ ] First send trong lúc startup race-safe.
- [ ] Connect hot path có số đo cải thiện sync-probe/config-cache.
- [ ] `npm run check-types` và focused multi-session tests pass.

### Checkpoint B — History list/load backend

Sau Tác vụ 6-10:

- [ ] Warm Pi history list tránh full walk/stat.
- [ ] List-then-load không scan lại toàn bộ tree.
- [ ] Replay notification count giảm với fixtures có thể coalesce.
- [ ] Full và compacted history modes vẫn explicit.

### Checkpoint C — Webview switching

Sau Tác vụ 11-12:

- [ ] Warm session switch tránh full transcript replay.
- [ ] Cold replay có loading/locking đúng nếu đã triển khai.
- [ ] Draft/scroll preservation hoạt động khi rapid switching.

### Checkpoint D — Release readiness

Sau Tác vụ 13-14:

- [ ] Typecheck, lint, tests, production package, VSIX packaging và local install hoàn tất.
- [ ] Manual performance traces được capture trước final report.
- [ ] Completion notes và feature docs được cập nhật.

## Cơ hội song song hóa

Có thể song song sau Tác vụ 1:

- Giai đoạn 1: New Chat changes.
- Giai đoạn 2: Pi discovery/index changes.
- Giai đoạn 4: DOM cache nếu đã chia nhỏ theo plan liên quan.

Phải tuần tự:

- Tác vụ 3 phụ thuộc Tác vụ 2.
- Tác vụ 7 phụ thuộc Tác vụ 6.
- Tác vụ 9 phụ thuộc Tác vụ 8.
- Tác vụ 14 chạy sau implementation và verification.

Cần phối hợp:

- DOM cache và session switch loading cùng chạm `src/features/multi-session/webview.ts`.
- New Chat async runtime và eager runtime hiện có cùng chạm runtime startup guards trong `src/features/multi-session/host.ts`.

## Lệnh xác minh và đóng gói

Với code changes, tuân thủ quy định repository: chạy checks liên quan, build, package và install trước khi báo hoàn tất.

Bộ lệnh khuyến nghị sau triển khai:

```bash
npm run check-types
npm run compile-tests
npx vscode-test --grep "multi-session feature"
npm run package
npx vsce package --out /tmp/vscode-acp-chat-performance.vsix
code --install-extension /tmp/vscode-acp-chat-performance.vsix --force
rm -f /tmp/vscode-acp-chat-performance.vsix
```

Bổ sung focused commands cho Pi adapter tests nếu các tests đó tồn tại hoặc được thêm trong phase triển khai.

Manual verification matrix:

1. Mở ACP Chat với multi-session enabled; bấm **New Chat** và xác nhận UI hiện ngay.
2. Gửi prompt khi runtime vẫn starting; xác nhận chỉ có một ACP runtime/session và message dùng đúng preferences đã chọn.
3. Mở history list hai lần; xác nhận lần hai dùng warm index và nhanh hơn.
4. Load một Pi history session lớn ở `full` mode; xác nhận transcript đầy đủ và continuation hoạt động.
5. Load với `compacted` mode nếu đã cấu hình; xác nhận trade-off tốc độ/fidelity rõ ràng.
6. Switch A/B giữa hai session lớn; xác nhận warm switch tránh full replay và draft/scroll được giữ.
7. Rapid switch và stale snapshots; xác nhận transcript cũ không ghi đè target mới.
8. Reload window và xác nhận eager runtime vẫn hoạt động, không tạo empty ACP history session chỉ vì view restore.

## Rủi ro và giảm thiểu

| Rủi ro | Ảnh hưởng | Giảm thiểu |
| ------ | --------- | ---------- |
| Background New Chat startup che lỗi cho tới khi user gửi | Medium | Hiển thị một draft error rõ ràng và giữ retry path qua Start Chat/send. |
| First send race với background startup | High | Một `runtimeStartPromise`; tests với controlled promises. |
| Preferences được apply sau prompt | High | First send phải await required preference application trước `sendMessage()`. |
| Caching command availability bị stale | Medium | Spawn failure vẫn authoritative; force refresh khi config đổi. |
| Pi discovery watcher bỏ sót thay đổi | Medium | TTL/force refresh fallback; validate `size/mtime` khi load. |
| Replay coalescing làm đổi transcript semantics | High | Golden fixtures so sánh rendered output/order/status trước và sau. |
| Bỏ await từng notification làm sai ordering | High | Bounded ordered queue; stress tests cho order/cancel/error. |
| DOM cache tăng RAM | Medium | LRU cap, không persist qua reload, fallback full replay khi eviction. |
| DOM cache và loading overlay xung đột | Medium | Implement DOM cache trước; chỉ thêm overlay phần cần thiết sau khi đo warm/cold behavior. |
| Metrics tạo overhead/noise | Low | Debug-gated logging; counters rẻ và deterministic. |

## Câu hỏi mở

Không có quyết định người dùng đang chặn plan ban đầu. Khuyến nghị mặc định:

- Giữ `pi.historyLoadMode = "full"` làm mặc định cho tới khi product chấp nhận compacted history làm mặc định.
- Không tạo ACP session khi bấm **New Chat** cho tới first send hoặc explicit Start Chat.
- Xem DOM cache là bắt buộc để xử lý repeated session switch latency; tối ưu history backend đơn lẻ không sửa được lag A/B switch.

## Ghi chú hoàn tất

Điền khi triển khai:

- Baseline metrics:
- Tác vụ đã triển khai:
- Tác vụ bỏ qua/defer và lý do:
- Lệnh xác minh và kết quả:
- Kết quả VSIX package/install:
