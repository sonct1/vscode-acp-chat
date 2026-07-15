# Session Switch Loading Implementation Plan

| Attribute | Value |
| --- | --- |
| Status | Draft |
| Owner | TBD |
| Phase | Implementation planning |
| Scope | Multi-session chat webview transition feedback, interaction locking, snapshot replay lifecycle, race handling, tests |
| References | `src/features/multi-session/webview.ts`, `src/features/multi-session/styles.ts`, `src/features/multi-session/manager-webview.ts`, `src/features/multi-session/host.ts`, `src/views/webview/main.ts`, `src/views/webview/component/message-list.ts`, `docs/architecture/acp-chat-layout.md` |

## Objective

Cung cấp trạng thái loading rõ ràng và nhất quán khi người dùng chuyển giữa các chat session, đồng thời ngăn transcript hoặc draft của session cũ bị hiểu nhầm là thuộc session mới.

Mục tiêu:

- Hiện loading ngay khi Extension Host xác nhận session đích đang được activate.
- Giữ loading trong toàn bộ quá trình reset và replay snapshot.
- Không để welcome view hoặc transcript chưa hoàn chỉnh lóe lên trong lúc chuyển.
- Tạm khóa composer và các tương tác thuộc chat surface để tránh gửi prompt vào sai session.
- Bảo toàn draft và scroll position của từng session.
- Không để snapshot/revision cũ kết thúc loading hoặc ghi đè session mới hơn.
- Dùng theme token và accessibility semantics của VS Code.

## Non-goals

- Không thay đổi cách Extension Host lưu transcript hoặc quản lý ACP runtime.
- Không thay thế snapshot replay bằng DOM cache trong plan này.
- Không tạo chat webview riêng cho từng session.
- Không thêm setting mới cho animation/loading ở MVP.
- Không trì hoãn switch bằng minimum display duration chỉ để spinner dễ nhìn thấy.
- Không refactor lớn `ChatViewProvider`, `WebviewController`, hoặc `MessageListComponent`.

Tối ưu thời gian replay thực tế thuộc plan [Multi-Session Chat Surface DOM Cache](./implement-multi-session-dom-surface-cache.md). Plan hiện tại chỉ làm transition đúng, rõ ràng và an toàn hơn.

## Current-state analysis

### Luồng chuyển session hiện tại

```text
Manager / QuickPick / command
  -> feature.multi-session.activate
  -> MultiSessionHostController.activate()
  -> increment activationRevision
  -> post feature.multi-session.chatState
  -> post feature.multi-session.snapshot
  -> MultiSessionWebviewController.applyChatState()
  -> show "Opening chat…"
  -> MultiSessionWebviewController.applySnapshot()
  -> reset chat surface
  -> replay transcript events
  -> apply metadata/context/diff/permissions
  -> restore generating/draft/scroll
  -> hide optimistic loading
```

Các entry point chính:

- `src/features/multi-session/host.ts`: activate session và phát `chatState`/`snapshot`.
- `src/features/multi-session/webview.ts`: quản lý header, loading strip, draft/scroll và snapshot replay.
- `src/features/multi-session/styles.ts`: style spinner/loading hiện tại.
- `src/features/multi-session/manager-webview.ts`: optimistic spinner trên nút mở/review session.
- `src/views/webview/main.ts`: bridge reset/dispatch tới component tree.
- `src/views/webview/component/message-list.ts`: clear transcript và điều khiển welcome/messages visibility.

### Loading đã có

Chat webview đã inject `.multi-session-loading` với spinner và các nội dung:

- `Opening chat…`
- `Loading chat…`
- `Loading chat history…`
- `Initializing <agent>…`
- `Stopping the active chat…`

Manager view cũng đổi icon nút thành spinner trong lúc chờ activation.

### Khoảng trống UX và correctness

1. Loading hiện là strip nhỏ phía trên; transcript cũ vẫn nhìn thấy và vẫn có thể bị hiểu là transcript của title session mới.
2. `bridge.reset()` gọi `MessageListComponent.clear()`, có thể làm welcome view xuất hiện trước khi transcript mới replay xong.
3. Composer chưa có trạng thái khóa riêng cho session transition.
4. `applyChatState()` cập nhật `activeLocalSessionId` sang session đích trước khi snapshot tới. Vì vậy `applySnapshot()` có thể không còn biết session nào đang thực sự được render để lưu draft/scroll của surface cũ.
5. `applySnapshot()` chưa kiểm tra snapshot có còn khớp target/revision mới nhất trước khi reset và replay.
6. Snapshot replay lỗi chỉ ẩn optimistic loading; chưa có lifecycle thống nhất để mở khóa UI và request resync.
7. Rapid switch cần đảm bảo snapshot cũ không thể kết thúc trạng thái loading của switch mới hơn.

## UX target

Khi bắt đầu chuyển session:

```text
ACP Chat webview
┌────────────────────────────────────────────┐
│ [switch] Session B · Running               │
├────────────────────────────────────────────┤
│                                            │
│                    ◌                       │
│          Switching to Session B…           │
│                                            │
│       Chat surface temporarily locked      │
│                                            │
├────────────────────────────────────────────┤
│ Composer visible but not interactive       │
└────────────────────────────────────────────┘
```

Quy tắc:

- Multi-session header vẫn hiển thị session đích và cho biết switch đang diễn ra.
- Overlay che transcript, auxiliary panels và composer; không cần che header.
- Transcript cũ có thể được giữ trong DOM phía dưới overlay cho tới khi snapshot mới sẵn sàng.
- Composer không nhận focus, edit, send hoặc attachment trong lúc chuyển.
- Overlay được gỡ sau khi transcript, side state, generation state, draft và scroll đã được restore.
- Với `prefers-reduced-motion: reduce`, spinner không quay nhưng text loading vẫn hiển thị.

## Key design decisions

### 1. Tách target session khỏi rendered session

`MultiSessionWebviewController` cần phân biệt:

```ts
private targetLocalSessionId?: string;
private renderedLocalSessionId?: string;
private targetActivationRevision = 0;
```

Ý nghĩa:

- `targetLocalSessionId`: session mới nhất mà host yêu cầu hiển thị.
- `renderedLocalSessionId`: session có transcript/draft/scroll đang nằm trên chat surface.
- `targetActivationRevision`: revision mới nhất được chấp nhận.

Không dùng một `activeLocalSessionId` cho cả host target và rendered DOM lifecycle.

### 2. Loading lifecycle thuộc multi-session feature

Không thêm substantial logic vào core files. Loading state, DOM, styles và transition ownership tiếp tục nằm trong:

```text
src/features/multi-session/webview.ts
src/features/multi-session/styles.ts
```

Core chỉ cần bridge nhỏ nếu multi-session feature chưa thể khóa composer/chat surface qua API ổn định.

### 3. Không đổi host protocol trong MVP

Dùng các field hiện có:

- `activeLocalSessionId`
- `activationRevision`
- `session`
- `snapshot`

Không cần thêm message `switchStarted` hoặc `switchComplete`. `chatState` revision mới bắt đầu transition; snapshot đúng target/revision hoàn thành transition.

### 4. Giữ overlay cho tới khi surface ổn định

Không tắt loading chỉ vì session status là `idle`/`running`. Optimistic session-switch loading chỉ kết thúc khi snapshot của đúng target/revision được apply thành công.

Loading do runtime status như `starting`, `loading_history`, `cancelling` vẫn tiếp tục hiển thị theo state sau khi session switch hoàn tất.

### 5. Khóa tương tác, không xóa draft

Trong transition:

- Đặt chat surface/composer `aria-busy="true"`.
- Dùng `inert` hoặc bridge tương đương để chặn focus/click/keyboard.
- Không clear input như một side effect của loading.
- Draft session cũ được lưu trước khi target state thay thế rendered ownership.
- Draft session đích chỉ được restore sau snapshot replay.

## Proposed changes

### `src/features/multi-session/webview.ts`

1. Thay ownership state đơn thành target/rendered state riêng biệt.
2. Thêm session-switch transition state:

```ts
interface SessionSwitchTransition {
  localSessionId: string;
  activationRevision: number;
  title: string;
}
```

3. Thêm các method nội bộ:

```ts
beginSessionSwitch(...): void;
completeSessionSwitch(...): Promise<void>;
failSessionSwitch(...): void;
isCurrentTarget(...): boolean;
setSurfaceInteractionLocked(value: boolean): void;
```

4. `applyChatState()`:

- Bỏ qua revision cũ hơn target hiện tại.
- Nếu target/revision đổi, lưu draft và scroll của `renderedLocalSessionId` trước.
- Cập nhật target/header.
- Bật overlay với `Switching to <title>…`.
- Khóa surface interaction.
- Không đánh dấu session đích là rendered.

5. `applySnapshot()`:

- Kiểm tra snapshot khớp target/revision trước khi reset.
- Giữ overlay trong suốt replay.
- Reset và replay transcript.
- Apply metadata, context usage, diff summary và pending permissions.
- Restore generation state, draft và scroll.
- Chờ browser commit ít nhất một frame sau DOM updates.
- Đặt `renderedLocalSessionId` bằng session đích.
- Hoàn tất transition và mở khóa interaction.
- Sau đó xử lý buffered deltas theo thứ tự sequence.

6. Khi replay lỗi:

- Chỉ fail transition nếu lỗi thuộc target/revision hiện tại.
- Luôn mở khóa interaction trong cleanup phù hợp.
- Ẩn optimistic switch loading.
- Gửi `feature.multi-session.resync`.
- Không để snapshot lỗi cũ thay đổi transition mới.

7. `saveActiveSurfaceState()` đổi sang lưu theo `renderedLocalSessionId`.

### `src/features/multi-session/styles.ts`

1. Nâng `.multi-session-loading` từ strip thành overlay.
2. Overlay bắt đầu phía dưới `.multi-session-header` và che phần chat còn lại.
3. Dùng VS Code theme tokens:

- `--vscode-sideBar-background`
- `--vscode-foreground`
- `--vscode-descriptionForeground`
- `--vscode-panel-border`
- `--vscode-focusBorder`

4. Thêm layout cho nội dung centered, title và optional secondary text.
5. Bảo đảm `[hidden]` tiếp tục dùng `display: none !important`.
6. Giữ `@media (prefers-reduced-motion: reduce)`.
7. Không dùng shadow hoặc màu hard-coded trái với flat UI hiện tại.

### `src/features/multi-session/manager-webview.ts`

Giữ optimistic spinner đang có. Chỉ bổ sung:

- Disable button có `aria-busy="true"` để tránh activation lặp.
- Clear pending state khi target trở thành active hoặc session trả lỗi/không còn tồn tại.

Không đưa chat overlay lifecycle vào manager vì QuickPick và command switch không phụ thuộc manager view.

### Core bridge, chỉ khi cần

Nếu feature không thể khóa composer an toàn bằng DOM query ổn định, thêm API nhỏ vào `WebviewController`, ví dụ:

```ts
setSessionTransitioning(value: boolean): void;
```

API này chỉ điều phối:

- composer inert/disabled state;
- attachment/send controls;
- focus restoration sau transition.

Không đặt session-specific logic hoặc loading DOM vào `src/views/webview/main.ts` hay `InputPanelComponent`.

## Detailed implementation phases

### Phase 1 — Correct transition ownership

- Introduce target/rendered session state.
- Save draft/scroll using rendered session id.
- Add revision comparison and stale-message guards.
- Keep existing strip UI temporarily while lifecycle is corrected.

Exit criteria:

- Switching A → B stores A draft/scroll under A.
- Snapshot B cannot be applied if C is already the latest target.
- Existing snapshot/delta tests still pass.

### Phase 2 — Loading overlay and interaction lock

- Convert loading DOM/style to overlay.
- Add `role="status"`, `aria-live="polite"`, and busy semantics.
- Lock transcript/composer interactions during switch.
- Keep header accessible.

Exit criteria:

- Overlay appears immediately on revision change.
- Old transcript and composer cannot be interacted with while title points to the target session.
- Reduced-motion behavior works.

### Phase 3 — Snapshot completion and failure handling

- Complete transition only after replay and side-state restoration.
- Wait for browser paint before hiding overlay.
- Add deterministic cleanup and resync on failure.
- Ensure runtime-status loading can remain after switch completion.

Exit criteria:

- No welcome-view flash is visible.
- Loader does not disappear before transcript/draft/scroll are ready.
- Replay failure does not leave the webview permanently locked.

### Phase 4 — Manager feedback hardening

- Disable pending activation action.
- Clear pending state on active/error/removal result.
- Preserve existing incremental row rendering.

Exit criteria:

- Double click does not send duplicate activation requests.
- Manager spinner and chat overlay settle consistently.

### Phase 5 — Documentation and verification

- Update `docs/architecture/acp-chat-layout.md` to describe the overlay instead of a loading strip.
- Update `docs/features/feature-catalog.md` with user-visible switch feedback and temporary interaction lock.
- Run focused and full quality gates.
- Package and install the extension because implementation changes extension/webview code.

## Message and state sequencing

### Normal A → B switch

```text
Host                          Webview
 | chatState(B, rev=2)          |
 |----------------------------->|
 |                              | save rendered A draft/scroll
 |                              | target=B, rendered=A
 |                              | show overlay + lock surface
 | snapshot(B, rev=2)           |
 |----------------------------->|
 |                              | validate B/rev=2
 |                              | reset + replay B
 |                              | apply side state
 |                              | restore B draft/scroll
 |                              | rendered=B
 |                              | wait for paint
 |                              | hide switch overlay + unlock
```

### Rapid A → B → C

```text
chatState(B, rev=2) -> target B, show loading B
chatState(C, rev=3) -> target C, update loading C
snapshot(B, rev=2)  -> stale, ignore without hiding loading C
snapshot(C, rev=3)  -> replay C, complete transition
```

### Runtime initialization after switch

```text
snapshot(B, status=starting) -> complete session switch
switch overlay can settle
status loader remains: "Initializing <agent>…"
```

Session-switch completion and runtime-status loading are related but separate states.

## Tests

### `src/test/webview.test.ts`

Add or extend tests for:

1. New activation revision shows overlay immediately.
2. Overlay text contains target session title.
3. Draft and scroll are saved against rendered session A before target becomes B.
4. Chat surface/composer are marked busy and non-interactive during switch.
5. Snapshot replay keeps loading visible until all transcript and side-state dispatches complete.
6. Overlay hides only after target draft and scroll are restored.
7. Empty target transcript does not expose a transient welcome view before loading finishes.
8. Snapshot with older revision is ignored.
9. Snapshot for a non-target session is ignored.
10. Rapid A → B → C finishes on C and B cannot clear C loading.
11. Deltas received during the accepted snapshot replay remain buffered and ordered.
12. Replay failure unlocks UI and posts `feature.multi-session.resync`.
13. `starting`, `loading_history`, and `cancelling` status loading remains correct after switch completion.
14. Reduced-motion CSS disables spinner animation.

### `src/test/features/multi-session-manager-webview.test.ts`

If manager hardening is implemented:

1. Busy activation button is disabled and has `aria-busy="true"`.
2. Repeated click does not post duplicate activate messages.
3. Pending state clears when session becomes active.
4. Pending state clears when session disappears or enters error.

### Manual verification

1. Switch between two idle sessions with different transcripts and drafts.
2. Switch from a long transcript to an empty draft session.
3. Switch while source session is generating.
4. Switch to a background session that is generating.
5. Switch through QuickPick, manager view and command palette.
6. Rapidly select A → B → C.
7. Load a history session and observe `Loading chat history…`.
8. Verify keyboard focus does not enter composer during transition.
9. Verify focus returns to the composer after successful transition when appropriate.
10. Enable reduced-motion at OS level and verify static loading indicator.

## Quality gates

Implementation must run:

```bash
npm run check-types
npm run lint
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-session-switch-loading.vsix
code --install-extension .tmp/vscode-acp-chat-session-switch-loading.vsix --force
```

After successful installation, reload VS Code with `Developer: Reload Window`.

Do not commit the generated VSIX. Remove the temporary file after installation when safe.

## Acceptance criteria

- Loading appears immediately after selecting a different session.
- Header identifies the target session while the old surface is fully obscured.
- Composer and chat interactions are blocked during transition.
- Draft and scroll state remain associated with the correct sessions.
- Only the latest target/revision can reset the surface or finish loading.
- Snapshot replay completes before the overlay is removed.
- No visible welcome-view or partially replayed transcript flicker occurs.
- Replay failure cannot leave the UI locked and triggers resync.
- Existing runtime loading states and manager button spinners still work.
- QuickPick, manager and command-based switches share the same chat transition behavior.
- Typecheck, lint, tests, production package and local VSIX installation complete, or blockers are reported explicitly.

## Risks and mitigations

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Composer remains locked after exception | Centralized transition cleanup with target/revision check and failure tests | Disable interaction locking while retaining loader |
| Stale snapshot resets current session | Validate session id and revision before any reset/replay | Fall back to serialized current behavior plus resync |
| Draft saved under target instead of rendered session | Separate `renderedLocalSessionId` from target state | Restore previous single-id state and keep only visual overlay |
| Overlay hides permission or confirmation UI | Scope overlay below header and define z-index relative to modal surfaces | Restrict overlay to transcript/composer region |
| Loading flickers on very fast switches | Hide only after frame commit; do not add arbitrary minimum duration | Revert frame wait if it causes measurable delay |
| `inert` behavior differs in test/runtime | Use attribute plus explicit component disable bridge where needed | Use explicit disable/focus guards only |
| Runtime-status loader conflicts with switch loader | Track optimistic switch state separately from status-derived loading | Keep one text priority function with switch state first |
| DOM cache plan later changes replay flow | Keep lifecycle methods independent of reset implementation | DOM cache calls the same begin/complete transition API |

## Rollout strategy

1. Land target/rendered state separation and stale guards first.
2. Add overlay and interaction lock without protocol changes.
3. Add manager double-click protection.
4. Verify with long transcripts and rapid switching.
5. Keep implementation feature-local so rollback only touches multi-session files.
6. Implement DOM surface cache separately after transition behavior is stable.

## Revision history

| Date | Author | Summary |
| --- | --- | --- |
| 2026-07-15 | Bytes | Initial implementation plan for session-switch loading overlay, interaction locking and revision-safe snapshot completion. |
