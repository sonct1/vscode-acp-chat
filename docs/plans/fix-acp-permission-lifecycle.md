# Fix ACP Permission Lifecycle

## Implementation status

Status: implementation and automated verification complete; manual cross-agent smoke tests remain outstanding.

Completion notes:

- `feature.permission-ui.state` carries monotonic `stateRevision` in addition to `ownerId` and optional `activationRevision`. Multi-session increments the revision on every enqueue/settle/cancel mutation and includes it in live publications and captured snapshot `permissionState`; legacy publishes a monotonic revision too.
- Webview permission state tracking keys by owner + activation + state revision, resets owner/revision on `chatSurfaceReplacementStarted`, accepts current/newer owner transitions, preserves legacy owner support without activation, and rejects stale lower revisions so old snapshots cannot overwrite newer live state.
- Multi-session permission responses require owner-qualified routing for core `permissionResponse`; ownerless request-id-only responses are ignored in multi-session and remain supported only by the legacy `ChatViewProvider` path. Settlement validates current runtime generation and prompt generation.
- Cancellation ordering is hardened: multi-session `stop()` and legacy Stop now cancel pending permission requests before `session/cancel`/`client.cancel()` and again in `finally` after cancel completes or throws, covering permissions emitted while cancellation is in flight. Multi-session `close()`, runtime replacement/disposal, and disconnect/error cancel pending permissions idempotently. Legacy `ensureIdleIfGenerating()` cancels permissions before and after `acpClient.cancel()`/idle waits, covering new chat, agent switch, and history load.
- `PermissionDialog` captures a single generating baseline when rendered permissions transition from zero to nonzero and restores only that baseline after the last permission is dismissed, regardless of dismissal order.
- Removed the dead `permissionDismissed` publication path; authoritative empty `feature.permission-ui.state` is the dismissal signal.
- Added regression coverage for owner switching, stale state revisions, baseline restore, owner-qualified routing, ownerless multi-session no-op responses, runtime replacement with a second runtime/new permission, old prompt generation responses, sendMessage-settled/finalization race cleanup in multi-session and legacy, legacy connect/new-session closed gate, stop second-pass race cleanup in multi-session and legacy Stop, post-Stop fail-closed callbacks, forged/missing/invalid-discriminator outcomes, valid reject option preservation, and legacy ready/stop/disconnect/new-chat/dispose lifecycle cleanup.
- Final security cleanup adds explicit prompt-lifecycle permission gates. Multi-session stores `acceptingPermissionRequests`, runtime generation, and prompt generation on each session, increments prompt generation for each actual `session.client.sendMessage` invocation, opens the permission gate only immediately before `sendMessage`, closes/cancels immediately when `sendMessage` settles before queue idle/tool finalization, and accepts callbacks/responses only for the current runtime + prompt generation. Legacy single-session mirrors this with `legacyPromptGeneration`, keeps the gate closed through connect/new session setup, opens only around `acpClient.sendMessage`, and closes/cancels before tool finalization/stream end.
- Host-boundary permission responses now use strict outcome parsing. Only `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: <nonempty string> }` are accepted; any other shape/discriminator for an existing owner/request is normalized to `cancelled`, and selected options still must match the live offered option id before ACP receives them. This validation applies to the owner-qualified core route, the compatibility multi-session route, and legacy responses with missing outcomes.
- Permission buttons are disabled after the first response, but the prompt remains visible until a newer authoritative host state removes it. If authoritative state still contains the request, reconciliation re-enables the prompt so failed/rejected delivery can be retried instead of hiding or permanently disabling a live resolver.

Verification notes from latest pass:

- `npm run check-types`: passed.
- `npm run lint`: passed with 3 existing warnings in `src/test/diff_manager.test.ts` for `no-explicit-any`; the repository script uses `--fix`.
- `npm run compile-tests`: passed.
- `xvfb-run -a npm test -- --grep "permission"`: passed, 29 tests.
- Full `xvfb-run -a npm test`: 927 passing, 1 failing; the remaining failure is the unrelated `WebviewController handleMessage renders sub-agent recent nested tools in a separate scrollable box` scroll assertion (`assert.notStrictEqual(scrollTop, 500)`), reproduced independently.
- `npm run package`: passed.
- Final permission-focused review: approved with no blocking findings after boundary/UI-authority hardening.
- `pnpm exec vsce package --no-dependencies --out .tmp/vsix-stage/vscode-acp-chat-permission-lifecycle.vsix`: passed.
- `code --install-extension .tmp/vsix-stage/vscode-acp-chat-permission-lifecycle.vsix --force`: passed; temporary VSIX removed afterward.
- Manual Codex/Claude/Pi smoke tests: not run; this is the remaining Definition-of-Done item.

## Mục tiêu

Sửa lỗi permission cũ xuất hiện lại sau khi người dùng đã chọn Allow/Deny, đặc biệt tại thời điểm ACP agent kết thúc turn, webview nhận snapshot mới, chuyển session, retry hoặc reconnect. Giải pháp phải áp dụng chung cho Codex, Claude Code và mọi agent dùng ACP `session/request_permission`.

Không gộp thay đổi lifecycle này với việc redesign giao diện permission. Có thể tái sử dụng feature `permission-ui`, nhưng correctness và protocol semantics phải được sửa độc lập trước.

## Kết luận nguyên nhân

### 1. Permission đang bị lưu như transcript lâu dài

Trong multi-session, `handlePermissionRequest()` vừa:

- tạo resolver sống trong `session.permissionQueue`;
- vừa `append()` message `permissionRequest` vào `TranscriptStore`.

Khi người dùng trả lời, `respondPermission()` chỉ xóa resolver khỏi `permissionQueue`. Event `permissionRequest` vẫn còn trong transcript.

Khi turn kết thúc, `dispatchSessionMessage()` gửi snapshot đầy đủ. Webview replay toàn bộ transcript, bao gồm permission đã trả lời, nên dialog cũ xuất hiện lại dù host không còn resolver tương ứng.

Luồng lỗi hiện tại:

```text
Agent requestPermission
        │
        ├─ permissionQueue: có resolver sống
        └─ transcript: append permissionRequest
                    │
User Allow/Deny     │
        │           │
        ├─ resolve ACP request
        └─ xóa permissionQueue
                    │
Agent end turn -> gửi snapshot
                    │
Webview replay transcript
                    │
permissionRequest cũ được render lại
nhưng host không còn resolver
```

Vị trí chính:

- `src/features/multi-session/host.ts`: `handlePermissionRequest()`, `respondPermission()`, `sendSessionSnapshot()`, `dispatchSessionMessage()`.
- `src/features/multi-session/transcript-store.ts`: lưu mọi message được append như lịch sử có thể replay.
- `src/features/multi-session/webview.ts`: replay toàn bộ transcript rồi render `pendingPermissions`.
- `src/views/webview/main.ts`: luôn render `permissionRequest`, kể cả event có `historical: true`.

### 2. Có hai nguồn sự thật cho cùng một permission

Multi-session hiện dùng đồng thời:

- `TranscriptStore`: dữ liệu lâu dài nhưng không còn resolver;
- `permissionQueue`: trạng thái sống có resolver và timeout.

Snapshot còn gửi cả transcript và `pendingPermissions`. Vì vậy permission pending có thể bị render hai lần; permission đã resolve vẫn có thể bị render từ transcript.

Permission phải là trạng thái tương tác tạm thời, không phải lịch sử hội thoại.

### 3. Webview không có cơ chế reconcile/dismiss từ host

`PermissionDialog` chỉ cleanup khi người dùng bấm nút trên chính dialog đó. Host không thể chủ động loại bỏ dialog khi request:

- timeout;
- bị cancel do Stop;
- bị cancel do disconnect/error;
- bị hủy khi retry/thay runtime;
- đã được resolve từ surface khác;
- không còn nằm trong snapshot authoritative.

Dialog cũng chưa quản lý theo `(ownerSessionId, requestId)`, nên repeated ready/resync/snapshot có thể tạo UI trùng.

### 4. Permission không gắn với runtime generation

`PermissionPending` không lưu runtime owner/generation. `disposeRuntime()` và state `error`/`disconnected` không cancel và clear `permissionQueue`; chỉ `disposeSession()` thực hiện việc này.

Do đó retry có thể tạo runtime mới trong khi request của runtime cũ vẫn còn trong queue và tiếp tục được snapshot/replay.

### 5. Deny đang trả sai ACP semantics

`PermissionDialog.handleOptionClick()` hiện chuyển mọi option có kind `reject_*` thành:

```ts
{ outcome: "cancelled" }
```

Theo ACP, khi người dùng chọn `reject_once` hoặc `reject_always`, client phải trả:

```ts
{
  outcome: {
    outcome: "selected",
    optionId: option.optionId,
  },
}
```

`cancelled` chỉ dùng khi prompt turn bị hủy trước khi người dùng chọn, ví dụ Stop, `session/cancel`, timeout hoặc transport/runtime bị hủy.

Lỗi này làm agent không nhận được lựa chọn Deny cụ thể, đặc biệt không thể ghi nhớ `reject_always`, và có thể hỏi lại permission.

### 6. Fallback hiện tại fail-open

`ACPClient.handleRequestPermission()` tự chọn allow option đầu tiên khi:

- không có listener;
- listener throw và không listener nào trả response.

Đây là hành vi không an toàn. Mất UI/lifecycle handler không được phép biến thành auto-approve.

## Kiến trúc mục tiêu

### Single source of truth

`permissionQueue` là nguồn sự thật duy nhất cho permission đang sống.

- Không append `permissionRequest` vào `TranscriptStore`.
- Snapshot chỉ lấy permission từ `pendingPermissions`.
- Webview nhận một permission-state authoritative và reconcile UI theo request ID.
- Permission chỉ actionable khi có resolver thuộc runtime generation hiện tại.

### Invariants bắt buộc

1. Transcript không chứa `permissionRequest`.
2. Permission UI tồn tại khi và chỉ khi host có resolver sống tương ứng.
3. Mỗi `(session owner, requestId)` chỉ có tối đa một dialog/embedded prompt.
4. Allow và Deny đều trả `selected` với nguyên `optionId` của agent.
5. `cancelled` chỉ dùng cho cancellation thực sự, không dùng thay Deny.
6. Mỗi request được settle đúng một lần trong race giữa response, timeout, Stop, disconnect, retry và dispose.
7. Runtime cũ phải cancel hết permission của nó trước khi runtime mới được tạo.
8. Permission của session nền không xuất hiện trong active session khác.
9. Repeated ready/resync/snapshot không làm permission đã resolve xuất hiện lại.
10. Không có listener hoặc listener lỗi phải fail closed bằng `cancelled`.

## Kế hoạch thực hiện

## Phase 1 — Khóa lỗi bằng regression tests và hotfix replay

### Task 1.1: Thêm test tái hiện đúng lỗi hiện tại

Tạo/điều chỉnh test trong `src/test/features/multi-session.test.ts`:

1. Start prompt.
2. Agent gửi permission.
3. User chọn Allow.
4. Permission promise resolve.
5. Agent kết thúc turn.
6. Lấy snapshot cuối.
7. Assert:
   - `pendingPermissions` rỗng;
   - transcript không chứa `permissionRequest`;
   - activate/resync lại không render permission cũ.

Thêm cùng scenario cho Deny và kiểm tra agent nhận `selected` với deny `optionId`.

### Task 1.2: Chặn replay ngay lập tức

- Không replay `permissionRequest` từ transcript trong snapshot.
- Giữ `lastSeq` theo sequence thật của `TranscriptStore`; không tự renumber snapshot đã filter vì sẽ phá delta sequencing.
- Đây là containment guard. Fix hoàn chỉnh ở Phase 2 phải ngừng append permission vào transcript.

Acceptance criteria:

- Agent end không làm dialog đã trả lời xuất hiện lại.
- Session switch/resync không replay permission đã resolve.
- Permission pending hợp lệ vẫn được restore qua `pendingPermissions`.

## Phase 2 — Tách permission khỏi transcript và thêm authoritative UI state

### Task 2.1: Không append permission vào `TranscriptStore`

Trong multi-session `handlePermissionRequest()`:

- enqueue `PermissionPending`;
- cập nhật status/state;
- publish permission state cho active session;
- không gọi `append(permissionMessage(...))`.

Background session chỉ cập nhật pending count. Khi activate, snapshot sẽ render permission đang sống từ `pendingPermissions`.

### Task 2.2: Thêm permission-state replace message

Thêm message typed, ví dụ:

```ts
{
  type: "feature.permission-ui.state",
  ownerId: string,
  activationRevision?: number,
  pending: PermissionView[],
}
```

Đây là replacement state, không phải chuỗi `show`/`dismiss` rời rạc.

Webview phải:

- bỏ qua state của owner/revision cũ;
- render request mới chưa có UI;
- giữ request vẫn pending;
- dismiss request không còn trong state;
- clear permission UI khi reset/surface replacement;
- không post response cho request đã bị dismiss.

Snapshot có thể dùng cùng contract/reconcile path thay vì tự loop và gọi `permissionRequest` trực tiếp.

### Task 2.3: Làm `PermissionDialog` idempotent

- Theo dõi UI bằng request ID và owner ID.
- `show()` cùng ID không tạo bản sao.
- Có `replace()` hoặc `dismiss(requestId)` do host điều khiển.
- Cleanup được cả modal overlay và embedded prompt.
- Không phụ thuộc vào việc người dùng phải bấm nút mới cleanup.

Likely files:

- `src/features/permission-ui/types.ts`
- `src/features/permission-ui/webview.ts`
- `src/features/register-webview.ts`
- `src/views/webview/widget/permission-dialog.ts`
- `src/views/webview/main.ts` chỉ giữ integration tối thiểu
- `src/features/multi-session/contracts.ts`
- `src/features/multi-session/host.ts`
- `src/features/multi-session/webview.ts`

## Phase 3 — Centralize settlement và runtime ownership

### Task 3.1: Tạo một settlement path duy nhất

Thay các đoạn remove/resolve phân tán bằng helper idempotent, ví dụ:

```text
settlePermission(session, requestId, response)
  1. tìm pending
  2. remove khỏi queue trước
  3. clear timeout
  4. publish permission state mới
  5. resolve ACP promise đúng một lần
  6. tính lại session status
```

Remove trước resolve để tránh re-entrancy/race nhìn thấy request vẫn còn sống.

Helper này phải được dùng bởi:

- user response;
- timeout;
- Stop/cancel;
- runtime disconnected/error;
- retry;
- close session;
- host/provider dispose.

### Task 3.2: Gắn permission với runtime generation

Thêm runtime generation/token thực sự thay đổi mỗi lần tạo ACP runtime. Lưu token đó trong `PermissionPending`.

Không dùng `runtimeId = runtime-${localSessionId}` hiện tại làm generation vì giá trị này không đổi giữa các lần retry cùng session.

Khi retire runtime:

- cancel toàn bộ pending permission thuộc generation đó;
- publish state đã clear;
- sau đó mới dispose client và tạo runtime mới.

### Task 3.3: Tuân thủ cancellation của ACP

Khi gửi `session/cancel` hoặc prompt turn bị hủy, tất cả pending `session/request_permission` của turn/runtime đó phải nhận:

```ts
{ outcome: { outcome: "cancelled" } }
```

Thực hiện trên Stop và các đường teardown tương đương. Không để queue chờ timeout 60 giây sau khi runtime đã chết.

## Phase 4 — Sửa ACP option semantics và fail closed

### Task 4.1: Preserve mọi option được người dùng chọn

Trong webview:

- `allow_once`, `allow_always`, `reject_once`, `reject_always` đều post:

```ts
{
  outcome: "selected",
  optionId: option.optionId,
}
```

Chỉ action Cancel/Escape/timeout/Stop/disconnect mới post hoặc settle `cancelled`.

Không suy luận outcome từ prefix `allow`/`reject`; ACP agent đã cung cấp `optionId` authoritative.

### Task 4.2: Đổi ACPClient fallback thành fail closed

Trong `src/acp/client.ts`:

- nếu không có permission listener: trả `cancelled`;
- nếu listener throw: log lỗi và tiếp tục listener khác; nếu không có response thì trả `cancelled`;
- không tự động chọn allow option.

Cập nhật `src/test/permission.test.ts` theo behavior mới.

## Phase 5 — Legacy single-session parity

Legacy flow trong `src/views/chat.ts` không append permission vào transcript nhưng vẫn thiếu lifecycle cleanup.

Cần:

- thêm timeout handle vào pending entry để clear đúng cách;
- dùng settlement helper tương đương;
- publish current permission state khi webview `ready`;
- cancel/dismiss khi Stop, disconnect/error, new chat, agent switch và dispose;
- trả Deny bằng selected option ID;
- đảm bảo pending resolver không sống sau khi provider/runtime đã bị dispose.

Không để multi-session đúng nhưng cấu hình `multiSession.enabled=false` vẫn gặp lỗi cũ.

## Phase 6 — Test matrix

### Host/protocol tests

- Allow once trả selected đúng option ID.
- Allow always trả selected đúng option ID.
- Reject once trả selected đúng option ID.
- Reject always trả selected đúng option ID.
- Cancel/Stop trả cancelled.
- Không listener trả cancelled.
- Listener throw trả cancelled, không auto-approve.
- Timeout settle một lần và clear queue.
- Response đến sau timeout là no-op.

### Multi-session tests

- Permission không nằm trong transcript và không tăng transcript sequence.
- Permission pending được replay đúng một lần khi activate owner session.
- Answered permission không xuất hiện lại sau agent end snapshot.
- Repeated ready/resync/snapshot không duplicate UI.
- Permission của session A không xuất hiện ở session B.
- Retry cancel permission của runtime cũ trước khi tạo runtime mới.
- Response với request ID cũ không ảnh hưởng request của runtime mới.
- Disconnect/error cancel và clear permission ngay.
- Stop cancel toàn bộ permission pending theo ACP.

### Webview tests

- State replacement render đúng tập pending.
- Request bị remove khỏi state được dismiss cả overlay và embedded UI.
- Repeated state cùng request ID không duplicate.
- Stale owner/revision state bị bỏ qua.
- Chọn reject post selected với deny option ID.
- Reset/surface replacement không giữ overlay cũ.

### Legacy tests

- Webview recreation restore request còn sống đúng một lần.
- Request đã settle khi webview detached không xuất hiện lại.
- Stop/disconnect/new chat/agent switch/dispose đều cancel và dismiss.

### Agent compatibility smoke tests

Chạy thủ công ít nhất với:

- Codex ACP;
- Claude Code ACP;
- bundled Pi ACP hoặc fake ACP test agent.

Scenario chung:

1. Trigger tool cần permission.
2. Chọn Allow once; turn hoàn tất; gửi prompt tiếp theo; permission cũ không xuất hiện lại.
3. Trigger lại và chọn Reject once; agent nhận deny, không coi là turn cancellation ngoài ý muốn.
4. Chọn Always Allow/Always Reject nếu agent cung cấp; verify extension preserve đúng option ID.
5. Trigger permission rồi Stop; dialog biến mất và runtime không treo.
6. Trigger permission rồi kill/restart agent; request cũ biến mất trước khi runtime mới chạy.

Lưu ý: việc agent có ghi nhớ `allow_always`/`reject_always` qua process restart hay không vẫn là agent-specific. Extension chỉ cam kết gửi đúng selected option ID và không replay UI cũ.

## Trình tự triển khai đề xuất

### Change set 1 — Regression + containment

- Test tái hiện agent-end replay.
- Filter permission khỏi replay snapshot.
- Sửa Reject thành selected option ID.
- Sửa fail-open thành fail-closed.

Mục tiêu: vá nhanh lỗi người dùng thấy và lỗi protocol/security rõ ràng.

### Change set 2 — Correct ownership model

- Không append permission vào transcript.
- Permission-state authoritative.
- Idempotent render/dismiss.
- Central settlement helper.

Mục tiêu: loại bỏ dual source of truth.

### Change set 3 — Runtime and legacy hardening

- Runtime generation ownership.
- Cleanup trên Stop/disconnect/retry/dispose.
- Legacy parity.
- Race tests và manual agent smoke tests.

Mục tiêu: không còn stale resolver/UI qua mọi lifecycle path.

## Verification

Theo thứ tự quality gate của repository:

```bash
npm run check-types
npm run lint
npm run compile-tests
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-permission-lifecycle.vsix
code --install-extension .tmp/vscode-acp-chat-permission-lifecycle.vsix --force
```

Sau khi install, chạy `Developer: Reload Window` trước khi smoke test Codex/Claude Code.

## Rủi ro và giảm thiểu

| Rủi ro | Mức độ | Giảm thiểu |
| --- | --- | --- |
| Filter transcript làm lệch delta sequence | Cao | Không renumber event và giữ `lastSeq` thật; sau đó ngừng append permission hoàn toàn. |
| Cancel runtime cũ vô tình cancel request của runtime mới | Cao | Gắn generation/token vào từng pending entry. |
| UI state đến trễ render permission của session khác | Cao | Message phải có owner và activation revision; bỏ qua stale state. |
| Deny semantic change làm lộ assumption cũ trong agent adapter | Trung bình | Test exact ACP payload; dùng nguyên option ID do agent cung cấp. |
| Nhiều permission đồng thời gây generating-state race | Trung bình | Không để từng dialog tự restore generating state; derive trạng thái từ host/session authoritative. |
| Fix multi-session nhưng bỏ sót legacy | Trung bình | Dùng cùng invariant/test matrix cho hai flow. |
| `always` không được agent nhớ qua restart | Thấp đối với extension | Ghi rõ ranh giới: extension preserve option ID; persistence là trách nhiệm agent. |

## Definition of Done

- Permission đã Allow/Deny không xuất hiện lại sau agent end, session switch, ready hoặc resync.
- Transcript không chứa actionable permission request.
- Webview permission UI khớp chính xác queue sống của owner runtime.
- Deny trả selected option ID theo ACP; cancelled chỉ dùng cho cancellation.
- Không có auto-approve khi thiếu/lỗi listener.
- Stop, disconnect, retry và dispose settle permission đúng một lần và dismiss UI ngay.
- Multi-session và legacy đều có regression coverage.
- Typecheck, lint, tests, production package, VSIX creation và local installation thành công.
