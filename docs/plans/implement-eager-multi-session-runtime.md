# Implementation Plan: Eager Multi-Session Runtime Loading

| Attribute  | Value                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented                                                                                                                                     |
| Owner      | TBD                                                                                                                                             |
| Scope      | Multi-session Extension Host lifecycle, ACP runtime startup, tests, feature docs                                                                |
| References | `src/features/multi-session/host.ts`, `src/features/multi-session/contracts.ts`, `src/views/chat.ts`, `src/test/features/multi-session.test.ts` |

## Tổng quan

Khi VS Code restore/mở lại view **ACP Chat** sau `Developer: Reload Window`, session local đầu tiên vẫn được tạo như hiện tại nhưng phải tự động start agent runtime ngay. Mục tiêu là trạng thái ban đầu không còn là draft thuần UI chưa có process; extension sẽ spawn/connect ACP client cho session đang mở sẵn, tương đương phần runtime của **Start Chat**.

MVP chỉ eager-connect runtime/process. Không tự gọi `session/new` trong lúc reload để tránh tạo ACP history/session rỗng mỗi lần người dùng mở VS Code.

## Phân tích hiện trạng

Các điểm liên quan hiện tại:

- `MultiSessionHostController` constructor gọi `createDraft()` ngay, tạo một local session `draft` với title `Untitled chat`.
- `attachView()` và webview message `feature.multi-session.ready` chỉ gửi `state` + `snapshot`.
- `src/views/chat.ts` chỉ auto-connect legacy single-session; multi-session không auto-connect.
- Runtime được tạo trong `ensureRuntime()` khi user `Start Chat`, `New Chat`, `sendMessage`, `loadHistory`, hoặc thao tác toolbar cần runtime.
- `connectActive()` đang là hành vi gần nhất với yêu cầu: gọi `ensureRuntime(session, false)`, spawn/connect client, không gọi `newSession`, sau đó chuyển session sang `idle` nếu chưa có ACP session.

Hệ quả: reload window mở lại chat view chỉ có local draft placeholder; agent process, capabilities và document sync chưa tồn tại cho đến khi user thao tác.

## Mục tiêu

- Khi webview ACP Chat sẵn sàng trong multi-session mode, active draft đầu tiên tự động spawn/connect agent runtime.
- Không tạo ACP session thật (`acpSessionId`) chỉ vì reload/mở view.
- Session sau khi connect thành công có `client`, `sessionManager`, `queue`, `output`, `resources`, `runtimeId` và status `idle`.
- Nếu user gửi message trong lúc eager runtime còn đang `starting`, prompt phải chờ cùng runtime startup rồi mới gọi `session/new`/`sendMessage`, không tạo client thứ hai và không lỗi `Not connected`.
- Nếu auto-start lỗi, UI thấy lỗi có thể retry bằng **Start Chat** hoặc gửi message; không spam lỗi khi webview gửi `ready` lại.

## Quyết định thiết kế

### 1. Trigger trên webview ready, không trigger trong constructor

Không spawn agent trong `MultiSessionHostController` constructor vì extension có thể activate vì command/history/setting mà chat view chưa thật sự được render. Trigger hợp lý là `feature.multi-session.ready`, tức webview DOM đã load và đang cần hiển thị session.

`attachView()` vẫn chỉ gửi state/snapshot như hiện tại vì hiện nó được gọi trước khi `webview.html` được set; các message ban đầu có thể bị webview mới bỏ lỡ và đã được handshake `ready` bù lại.

### 2. Eager connect runtime only, không `newSession`

Auto-start dùng `ensureRuntime(session, false)` hoặc helper tương đương. Không gọi `session/new` trong reload flow để tránh:

- sinh session/history rỗng trên agent mỗi lần mở VS Code;
- thay đổi retention/history của Pi/ACP agent;
- làm `New Chat` và `sendMessage` mất vai trò tạo session thật.

Nếu sau này cần toolbar model/mode/config xuất hiện ngay cả với agent chỉ trả metadata qua `session/new`, đó là follow-up riêng và phải chấp nhận trade-off tạo session thật khi mở view.

### 3. Runtime startup phải race-safe

Hiện `ensureRuntime()` gán `session.client` trước `await client.connect()`. Khi eager startup chạy song song với `sendActiveMessage()` hoặc toolbar action, call thứ hai có thể thấy `session.client` đã tồn tại và đi tiếp trước khi connect xong.

Cần thêm guard promise vào `ManagedSession`, ví dụ:

```ts
runtimeStartPromise?: Promise<void>;
eagerRuntimeAttempted?: boolean;
```

Nguyên tắc:

- Nếu runtime đang start, mọi caller của `ensureRuntime()` phải `await session.runtimeStartPromise` trước khi gọi `newSession`, `setMode`, `setModel`, `setConfigOption`, hoặc `sendMessage`.
- Chỉ tạo một `ACPClient` cho một local session dù `ready` và `sendMessage` đến gần nhau.
- Khi startup fail, clear promise, dispose runtime partial, giữ khả năng retry thủ công.

### 4. Status và UX

- Auto-start: `draft` → `starting` → `idle` nếu connect thành công và chưa có `acpSessionId`.
- Không tự mở session manager khi auto-start fail.
- Auto-start fail: set `lastError`, append error vào transcript hoặc snapshot active, status quay về `draft` để user có thể retry.
- `multiSession.maxConcurrentSessions` vẫn tính runtime eager này vì đã có process thật.

## Không nằm trong phạm vi

- Không tạo ACP session thật khi reload.
- Không persist transcript/event log mới của extension.
- Không restore prompt đang chạy sau Extension Host restart.
- Không thay đổi multi-session webview protocol nếu không cần.
- Không thêm setting mới ở phase đầu; hành vi áp dụng khi `multiSession.enabled = true` và view chat được mở/restore.
- Không refactor `ACPClient` sang multiplex session runtime.

## Implementation phases

### Phase 1: Host lifecycle hook

#### Task 1: Thêm helper auto-start runtime cho active initial session

**Mô tả:** Trong `MultiSessionHostController`, thêm helper private, ví dụ `eagerStartActiveRuntimeOnReady()`, được gọi từ case `feature.multi-session.ready` sau khi gửi state/snapshot ban đầu.

**Acceptance criteria:**

- [ ] `ready` trong multi-session gọi auto-start cho active session nếu session chưa có `client` và chưa từng auto-start trong lifecycle hiện tại.
- [ ] Auto-start chỉ chạy khi active session là draft/local placeholder phù hợp; không can thiệp history loading, running, existing runtime, hoặc closed session.
- [ ] Auto-start không gọi `session/new` và không set `acpSessionId`.
- [ ] Auto-start không mở session manager.
- [ ] Repeated `ready`/resync không spawn thêm client cho cùng session.

**Files likely touched:**

- `src/features/multi-session/host.ts`

### Phase 2: Race-safe `ensureRuntime()`

#### Task 2: Thêm startup promise vào `ManagedSession`

**Mô tả:** Mở rộng runtime lifecycle để connect đang pending được await bởi mọi caller.

**Acceptance criteria:**

- [ ] `ManagedSession` có field guard cho runtime startup promise.
- [ ] `ensureRuntime(session, createAcpSession)` nếu thấy startup đang pending thì await promise trước khi xét `createAcpSession`.
- [ ] Nếu `createAcpSession=true` trong lúc eager connect pending, chỉ sau khi connect xong mới gọi `newSession` một lần.
- [ ] Nếu connect fail, runtime partial được dispose, promise được clear, status phù hợp (`draft` nếu chưa có `acpSessionId`, `error` nếu session thật đã tồn tại).
- [ ] Không làm thay đổi behavior `loadHistorySession()` ngoài việc an toàn hơn khi runtime startup trùng thời điểm.

**Files likely touched:**

- `src/features/multi-session/host.ts`

#### Task 3: Chuẩn hóa status sau runtime-only connect

**Mô tả:** Reuse logic của `connectActive()` hoặc tách helper để runtime-only connect thành công chuyển session từ `starting` sang `idle` nếu chưa tạo ACP session.

**Acceptance criteria:**

- [ ] Auto-start thành công để active session status `idle`.
- [ ] `connectActive()` vẫn đóng manager khi được user gọi và vẫn gửi snapshot.
- [ ] `loadHistorySession()` không bị chuyển sớm từ `loading_history` sang `idle` trước khi `loadSession` hoàn tất.

**Files likely touched:**

- `src/features/multi-session/host.ts`

### Phase 3: Error handling and retry

#### Task 4: Xử lý lỗi auto-start không gây spam

**Mô tả:** Auto-start catch lỗi nội bộ, publish state/snapshot, và đánh dấu đã thử cho session để `ready` lặp lại không append lỗi nhiều lần.

**Acceptance criteria:**

- [ ] Connect failure không reject ra `webview.onDidReceiveMessage`.
- [ ] Active session có `lastError` và transcript/snapshot có error message rõ ràng.
- [ ] Session quay về trạng thái retry được (`draft`, no client).
- [ ] User gọi **Start Chat** hoặc gửi message sau đó vẫn retry được.
- [ ] Repeated `ready` không tạo nhiều error message giống nhau.

**Files likely touched:**

- `src/features/multi-session/host.ts`

### Phase 4: Tests

#### Task 5: Bổ sung multi-session host tests

**Mô tả:** Mở rộng `src/test/features/multi-session.test.ts` bằng fake client/manager hiện có.

**Acceptance criteria:**

- [ ] Test `ready` auto-starts runtime without `newSession`:
  - `clients.length === 1`
  - `managers[0].newCalls === 0`
  - client connected
  - active status `idle`
  - active `acpSessionId` undefined
- [ ] Test repeated `ready` does not spawn another client.
- [ ] Test failed auto-start leaves draft + `lastError` and does not call `newSession`.
- [ ] Test send during pending eager connect reuses the same client and calls `newSession` exactly once after connect resolves.
- [ ] Existing tests for `newChat`, `connectActive`, process limit, permission routing, diff scoping, and history loading vẫn pass.

**Files likely touched:**

- `src/test/features/multi-session.test.ts`

### Phase 5: Documentation updates after implementation

#### Task 6: Cập nhật feature docs/catalog

**Mô tả:** Sau khi code xong, cập nhật mô tả user-visible behavior trong feature catalog.

**Acceptance criteria:**

- [ ] `docs/features/feature-catalog.md` mục **Concurrent multi-session chat** nêu rõ restored/opened initial session eager-loads agent runtime but does not create ACP session/history until `New Chat`/send.
- [ ] Nếu có thay đổi layout/indicator visible trong UI, cập nhật `docs/architecture/acp-chat-layout.md` cùng change.
- [ ] Không biến docs README thành backlog.

**Files likely touched:**

- `docs/features/feature-catalog.md`
- `docs/architecture/acp-chat-layout.md` only if UI/layout indicator changes

### Phase 6: Verification, build, package, install

Vì implementation sẽ thay đổi extension host code, sau code change phải chạy quality gates và install VSIX local trước khi báo hoàn tất.

Recommended commands:

```bash
npm run check-types
npm run compile-tests
npx vscode-test --grep "multi-session feature"
npm run package
npx vsce package --out /tmp/vscode-acp-chat-eager-runtime.vsix
code --install-extension /tmp/vscode-acp-chat-eager-runtime.vsix --force
rm -f /tmp/vscode-acp-chat-eager-runtime.vsix
```

Manual verification:

- [ ] Mở ACP Chat, chạy `Developer: Reload Window`, chờ view restore.
- [ ] Session ban đầu chuyển `Starting` rồi `Idle` mà không bấm **Start Chat**.
- [ ] Kiểm tra agent process đã spawn/connect.
- [ ] Session chưa có full ACP session id/acpSessionId cho đến khi gửi prompt hoặc dùng **New Chat**.
- [ ] Gửi prompt ngay khi session còn `Starting`; chỉ có một runtime và message gửi thành công sau startup.
- [ ] Tắt/bật `vscode-acp-chat.multiSession.enabled` để xác nhận legacy single-session auto-connect không bị ảnh hưởng.

## Risks and mitigations

| Risk                                                               | Mitigation                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Reload tạo nhiều empty ACP sessions/history                        | Không gọi `newSession` trong eager flow.                                               |
| User gửi message khi runtime đang connect gây race `Not connected` | Thêm `runtimeStartPromise` và await trong `ensureRuntime()`.                           |
| `ready` lặp lại spawn nhiều process                                | Đánh dấu auto-start attempted và rely on runtime guard.                                |
| Eager runtime chiếm một slot `maxConcurrentSessions`               | Chấp nhận vì đã có process thật; document behavior và giữ close session để giải phóng. |
| Agent unavailable khiến reload luôn hiện lỗi                       | Catch lỗi, không spam, cho retry thủ công sau khi user sửa PATH/agent.                 |

## Definition of done

- Active session restored/opened with ACP Chat auto-starts agent runtime in multi-session mode.
- No ACP session/history is created until user explicitly starts a real session through New Chat/send or a command requiring `createAcpSession=true`.
- Runtime startup is race-safe across ready/send/toolbar actions.
- Tests cover success, repeat-ready, failure, and send-during-startup cases.
- Feature catalog reflects the new lifecycle behavior.
- Extension is typechecked, tested, packaged, installed locally, and user is told to run `Developer: Reload Window`.

## Completion notes

Implemented in `src/features/multi-session/host.ts` with a `feature.multi-session.ready` eager-start hook, per-session `runtimeStartPromise`, retry-safe failure handling, and runtime-only connect status normalization. Added host tests for eager runtime success, repeated ready, failed ready, and send during pending startup in `src/test/features/multi-session.test.ts`. Updated `docs/features/feature-catalog.md` with the new initial-session lifecycle behavior.
