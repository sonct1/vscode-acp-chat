# Implementation Plan: Scroll-Contextual User Prompt Composer Tip

| Attribute | Value |
| --- | --- |
| Status | Implemented |
| Owner | Extension maintainers |
| Phase | Completed, packaged and installed locally |
| Scope | Transcript viewport tracking, active user-turn selection, composer tip UI, streaming stability, multi-session replay, tests, documentation |
| References | `src/features/latest-user-prompt-tip/webview.ts`, `src/views/webview/component/message-list.ts`, `src/features/assistant-turn-navigation/webview.ts`, `src/features/multi-session/webview.ts`, `docs/architecture/acp-chat-layout.md` |

## Mục tiêu

Hiển thị một hàng `Tip: <user prompt preview>` ở đầu composer khi transcript không còn ở gần đáy. Nội dung tip phải là **user prompt tương ứng với lượt hội thoại đang được người dùng đọc trong viewport**, không phải luôn cố định ở user prompt mới nhất.

```text
Conversation:
  User prompt 1
  Assistant response 1
  User prompt 2
  Assistant response 2
  User prompt 3
  Assistant response 3 (latest / streaming)

Scroll position                  Composer tip
───────────────────────────────  ─────────────────────────────
Near bottom / response 3 bottom  hidden
Reading response 3               Tip: User prompt 3
Scroll up to response 2          Tip: User prompt 2
Scroll up to response 1          Tip: User prompt 1
Scroll down to response 2        Tip: User prompt 2
Return near bottom               hidden
```

Target layout:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ messages viewport                                                     │
│   user is reading an earlier conversation turn                        │
├──────────────────────────────────────────────────────────────────────┤
│ Tip: <prompt associated with the currently viewed turn>               │
├──────────────────────────────────────────────────────────────────────┤
│ [prompt contenteditable]                                     [send]   │
└──────────────────────────────────────────────────────────────────────┘
```

## Requirement correction

Implementation/plan trước đây chọn:

```text
Tip = latest textual user message in the active transcript
```

Semantics này không đúng với yêu cầu đã làm rõ. Semantics mới:

```text
Tip = user message that owns the transcript region at the viewport reading anchor
```

Hệ quả:

- Scroll lên qua các conversation turn phải đổi tip về prompt trước đó.
- Scroll xuống qua các turn phải đổi tip theo hướng mới hơn.
- Assistant tiếp tục stream bên dưới không được tự đổi tip khi user không thay đổi vùng đang đọc.
- `latest user prompt` chỉ đúng khi viewport vẫn đang nằm trong latest turn.

## Phân tích hiện trạng

### Transcript DOM

`MessageListComponent` render transcript theo thứ tự thời gian trong `#messages`:

```text
.message.user
.message.assistant
.message.user
.message.assistant
...
```

User text nằm trong:

```text
.message.user .message-content-text
```

Assistant response có thể gồm text, thought, tool và action blocks. Không phải assistant turn nào cũng có `.block-text`, nên việc xác định prompt theo user-message boundary ổn định hơn việc chỉ dựa vào assistant text block.

### Scroll state hiện tại

- `#messages` là scroll container thực tế.
- `MessageListComponent` dùng `BOTTOM_THRESHOLD_PX = 100` để xác định near-bottom.
- Auto-scroll bị disable khi user chủ động rời đáy.
- `setScrollTop()` được multi-session dùng để restore vị trí scroll active session.
- `onScrollPositionChange()` hiện chỉ có payload boolean `isNearBottom` và dedupe khi boolean không đổi.

Điểm thiếu quan trọng: khi user tiếp tục scroll giữa nhiều turn nhưng vẫn ở trạng thái `isNearBottom = false`, subscriber hiện tại không nhận đủ update để thay đổi prompt theo viewport.

### Implementation tip hiện tại

`LatestUserPromptTipWebviewFeature` hiện:

- gọi `getUserMessageDrafts().at(-1)`;
- giữ một field `latestPrompt`;
- chỉ dùng scroll state để hiện/ẩn row;
- không index user turns và không xác định turn đang được đọc.

Do đó implementation hiện tại cần được sửa, không chỉ đổi wording trong tài liệu.

### Multi-session và history

- Live chat, loaded history và multi-session snapshot đều replay về cùng `#messages` DOM.
- Multi-session restore `scrollTop` sau khi replay transcript.
- Feature có thể derive toàn bộ state từ active transcript DOM và restored scroll position; không cần host protocol, session schema hoặc persisted tip state mới.

## Mô hình conversation turn

### Turn ownership

Mỗi `.message.user` bắt đầu một conversation turn và sở hữu vùng transcript từ chính user message đó cho tới ngay trước `.message.user` kế tiếp.

```text
Turn 1 = [User 1, Assistant 1, system/tool content before User 2]
Turn 2 = [User 2, Assistant 2, system/tool content before User 3]
Turn 3 = [User 3, Assistant 3/current stream]
```

Quy tắc này xử lý được:

- assistant response có text;
- assistant response chỉ có tool/thought;
- partial/cancelled response;
- loaded history;
- latest response đang stream;
- user message đang nằm trực tiếp trong viewport.

### Viewport reading anchor

Không dùng phần tử gần tâm viewport một cách tùy ý. Dùng một anchor cố định trong vùng đọc phía trên của transcript, cùng convention với assistant-turn navigation:

```ts
const containerRect = messagesEl.getBoundingClientRect();
const anchorY =
  containerRect.top + Math.max(24, containerRect.height * 0.25);
```

Lý do:

- Nội dung gần 1/4 phía trên viewport thường là vùng user đang đọc.
- Tránh đổi prompt quá sớm chỉ vì phần cuối của turn kế tiếp xuất hiện ở đáy viewport.
- Đồng nhất với cách `AssistantTurnNavigationWebviewFeature` xác định response gần vị trí đọc.

### Active prompt selection

Build ordered entries từ mọi direct transcript user message:

```ts
interface UserTurnEntry {
  element: HTMLElement;
  preview: string;
}
```

Selection algorithm:

```text
if near bottom:
  hide tip
else:
  anchorY = transcript reading anchor
  active = last user entry whose element.top <= anchorY
  if no user entry is above anchor:
    active = first user entry
  show active.preview if it has textual content
```

Boundary behavior:

- Khi một user message đi qua anchor từ dưới lên, tip đổi sang prompt của turn đó.
- Khi scroll ngược xuống và user message kế tiếp đi qua anchor, tip đổi sang prompt mới hơn.
- Tại đúng boundary dùng so sánh `top <= anchorY` để kết quả deterministic.

### Text extraction

- Clone `.message-content-text` hoặc dùng helper hiện có để giữ cách đọc mention/command chip nhất quán.
- Preview dùng plain text, normalize whitespace bằng `value.replace(/\s+/g, " ").trim()`.
- Không đưa HTML vào tip.
- Nếu active turn không có textual content, ẩn tip; không fallback về prompt cũ vì như vậy sẽ gán sai prompt cho turn đang đọc.

## Quyết định UX

- Near bottom theo ngưỡng 100 px: tip ẩn.
- Away from bottom: tip hiển thị prompt của active viewport turn.
- Tip thay đổi theo cả scroll lên và scroll xuống.
- Prompt mới nhất chỉ hiển thị khi viewport đang ở latest turn nhưng chưa near-bottom.
- Assistant streaming bên dưới vị trí hiện tại không làm đổi tip.
- Chat clear hoặc transcript không có textual user turn: tip ẩn.
- Session switch/history replay: tip được rebuild từ transcript active và tính lại sau khi restore `scrollTop`.
- Preview mặc định một dòng và ellipsis; keyboard focus mở rộng full text như implementation hiện tại.
- Không thêm click-to-jump, setting hoặc host message trong iteration này.

## Kiến trúc đề xuất

Giữ feature webview-only:

```text
src/features/latest-user-prompt-tip/
├── styles.ts
└── webview.ts
```

### Core scroll integration

Refactor generic scroll subscription để phát đủ dữ liệu trên mọi scroll position change:

```ts
interface MessageScrollPosition {
  isNearBottom: boolean;
  scrollTop: number;
}

onScrollPositionChange(
  handler: (position: MessageScrollPosition) => void
): { dispose(): void }
```

Yêu cầu:

- Notify trên mọi native `scroll`, không chỉ khi `isNearBottom` đổi.
- Notify sau `setScrollTop()`.
- Notify sau automatic scroll-to-bottom.
- Không thực hiện DOM measurement nặng trong `MessageListComponent`.
- Feature coalesce viewport calculation bằng `requestAnimationFrame`.

Nếu muốn giữ API boolean hiện tại cho compatibility, có thể thêm generic `onTranscriptScroll()` riêng; không thêm feature-specific prompt logic vào `MessageListComponent`.

### Feature state

```ts
private entries: UserTurnEntry[] = [];
private activeIndex = -1;
private isNearBottom = true;
private updateFrame: number | null = null;
```

Feature responsibilities:

1. Tạo và attach tip row.
2. Build/rebuild ordered user-turn entries.
3. Subscribe mọi transcript scroll position update.
4. Coalesce `updateActivePrompt()` vào một animation frame.
5. Tính reading anchor và active user turn từ geometry hiện tại.
6. Render prompt khi active index thay đổi.
7. Rebuild entries khi user-message DOM được add/remove.
8. Recalculate sau window/container resize.
9. Cleanup observer, listener và pending frame khi dispose.

### Mutation strategy

`MutationObserver` chỉ rebuild entries khi:

- `.message.user` được thêm;
- `.message.user` bị remove;
- content của `.message.user` thay đổi.

Không rebuild trên từng assistant stream chunk. Assistant content streaming bên dưới chỉ thay đổi `scrollHeight`; tip context vẫn do scroll position của user quyết định.

### Resize strategy

Viewport anchor phụ thuộc `messagesEl.getBoundingClientRect().height`, nên cần schedule recalculation khi:

- webview/window resize;
- messages container đổi kích thước do composer/diff/plan panels;
- session header/loading surface thay đổi chiều cao nếu làm thay đổi transcript viewport.

Ưu tiên `ResizeObserver` trên `messagesEl` hoặc `#messages-container`; fallback `window.resize` nếu test/runtime compatibility yêu cầu.

## Task list

### Phase 1 — Lock corrected behavior with tests

#### Task 1: Add multi-turn viewport semantics tests

**Files:**

- `src/test/features/latest-user-prompt-tip.test.ts`

**Acceptance criteria:**

- [x] Transcript có ít nhất ba user/assistant turns.
- [x] Away from bottom trong turn 3 hiển thị prompt 3.
- [x] Scroll lên turn 2 đổi sang prompt 2.
- [x] Scroll lên turn 1 đổi sang prompt 1.
- [x] Scroll xuống đổi ngược lại prompt 2 rồi prompt 3.
- [x] Near bottom luôn ẩn tip.
- [x] Boundary tại anchor có kết quả deterministic.

**Test approach:**

- Stub `messagesEl.getBoundingClientRect()`.
- Stub mỗi `.message.user.getBoundingClientRect()` dựa trên logical document offset trừ `scrollTop`.
- Dispatch native `scroll` và flush animation frame.

### Phase 2 — Emit continuous scroll position

#### Task 2: Refactor transcript scroll subscription

**Files:**

- `src/views/webview/component/message-list.ts`
- `src/views/webview/types.ts` nếu cần shared type
- `src/test/features/latest-user-prompt-tip.test.ts` hoặc `src/test/webview.test.ts`

**Acceptance criteria:**

- [x] Subscriber nhận update khi `scrollTop` đổi trong lúc `isNearBottom` vẫn là `false`.
- [x] Subscriber nhận state ban đầu.
- [x] `setScrollTop()` hủy pending forced bottom scroll và notify restored position.
- [x] Auto-scroll về đáy notify `isNearBottom = true`.
- [x] Dispose ngừng nhận update.
- [x] Existing auto-scroll behavior không regression.

### Phase 3 — Build user-turn index

#### Task 3: Replace fixed latest prompt with ordered user-turn entries

**Files:**

- `src/features/latest-user-prompt-tip/webview.ts`

**Acceptance criteria:**

- [x] Không còn `getUserMessageDrafts().at(-1)` làm source hiển thị cố định.
- [x] Entries được tạo theo DOM order của `.message.user`.
- [x] Mỗi entry chứa element reference và normalized textual preview.
- [x] Rebuild giữ đúng DOM order và schedule lại active selection.
- [x] Empty/image-only active turn không fallback sang prompt khác.
- [x] Assistant-only mutations không rebuild index.

#### Task 4: Select active turn from viewport anchor

**Files:**

- `src/features/latest-user-prompt-tip/webview.ts`

**Acceptance criteria:**

- [x] Dùng anchor `top + max(24, height * 0.25)`.
- [x] Chọn user message cuối cùng có `top <= anchor` bằng binary search.
- [x] Fallback first user message khi viewport nằm trước boundary đầu tiên.
- [x] Chỉ update DOM khi active preview thực sự đổi.
- [x] Calculation được rAF-coalesce để tránh layout thrashing khi scroll nhanh.

### Phase 4 — Streaming, resize and lifecycle hardening

#### Task 5: Keep prompt stable during assistant streaming

**Acceptance criteria:**

- [x] Stream text/thought/tool dưới current scroll position không đổi active prompt.
- [x] Stream không kéo transcript về đáy sau khi user đã rời đáy.
- [x] Nếu user chủ động scroll trong lúc stream, prompt vẫn đổi theo turn mới được xem.
- [x] Không scan toàn transcript trên mỗi stream chunk.

#### Task 6: Handle clear, history and multi-session restore

**Acceptance criteria:**

- [x] `chatCleared` clear entries và ẩn tip.
- [x] Loaded/replayed transcript build đúng entries qua cùng DOM flow.
- [x] Session switch không giữ prompt của session cũ.
- [x] Sau snapshot replay và `setScrollTop()`, tip phản ánh turn tại restored viewport.
- [x] Pending auto-scroll frame không override restored position.

#### Task 7: Recalculate on viewport resize

**Acceptance criteria:**

- [x] Resize transcript viewport refresh near-bottom state và schedule active-turn recalculation.
- [x] Không rebuild entries nếu chỉ kích thước viewport đổi.
- [x] Dispose cleanup resize observer/listener.

### Phase 5 — Documentation

#### Task 8: Update durable behavior docs after implementation

**Files:**

- `docs/architecture/acp-chat-layout.md`
- `docs/features/feature-catalog.md`
- `docs/plans/implement-latest-user-prompt-composer-tip.md`

**Acceptance criteria:**

- [x] Không còn mô tả tip luôn là latest user prompt trong durable behavior docs.
- [x] Architecture mô tả viewport reading anchor và user-turn ownership.
- [x] Feature catalog mô tả scroll lên/xuống đổi prompt theo turn đang đọc.
- [x] Completion notes ghi đúng tests và package/install outcome.

### Phase 6 — Verification, package and install

#### Task 9: Quality gates

```bash
npm run check-types
npm run compile-tests
npm run test -- --grep "user prompt tip"
npm run package
```

Nếu full project vẫn bị block bởi lỗi ngoài phạm vi, phải:

- chạy focused compile/test cho feature;
- chạy focused ESLint;
- bundle webview entry trực tiếp;
- báo chính xác blocker, không claim production package pass.

#### Task 10: Package and local install

Sau khi `npm run package` pass:

```bash
npx vsce package --out /tmp/vscode-acp-chat-user-prompt-tip.vsix
code --install-extension /tmp/vscode-acp-chat-user-prompt-tip.vsix --force
```

Xóa VSIX tạm nếu an toàn và yêu cầu chạy `Developer: Reload Window`.

## Test matrix

| Scenario | Expected tip |
| --- | --- |
| Empty transcript | Hidden |
| Near bottom | Hidden |
| Away from bottom in latest turn | Latest turn's user prompt |
| Scroll up one turn | Previous user prompt |
| Scroll up multiple turns | Prompt owning the current viewport anchor |
| Scroll down across turn boundary | Newer prompt |
| Assistant streams below current position | Unchanged until user scrolls |
| User message itself crosses anchor | Switch to that user prompt |
| Active turn has no text | Hidden; no stale fallback |
| Chat clear | Hidden |
| History replay | Prompt derived from restored viewport turn |
| Multi-session switch | Prompt derived only from active session |
| Resize while away from bottom | Recomputed from new anchor geometry |

## Rủi ro và giảm thiểu

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Tip đổi quá sớm khi turn kế tiếp chỉ vừa xuất hiện ở đáy | High | Dùng anchor ở 25% phía trên viewport, không dùng first visible/center blindly. |
| Scroll subscriber chỉ phát khi near-bottom đổi | High | Emit continuous scroll position; rAF-coalesce ở feature. |
| Layout measurement trên mọi scroll gây jank | Medium | Chỉ đo user entry tops trong một scheduled animation frame. |
| Long history có nhiều user entries | Medium | Build entries một lần khi user DOM thay đổi; không clone toàn transcript trên mỗi scroll. |
| Assistant streaming làm tip nhảy dù user không scroll | Medium | Không rebuild/reselect theo assistant chunk; selection driven bởi scroll/resize/user-turn mutation. |
| Session restore bị pending auto-scroll kéo về đáy | High | `setScrollTop()` cancel pending bottom-scroll work trước khi restore. |
| User turn không có text hiển thị prompt cũ sai ngữ cảnh | Medium | Hide tip cho active non-text turn; không fallback. |
| Boundary flicker do sub-pixel geometry | Low | Dùng deterministic `top <= anchor`; chỉ render khi active index đổi. |
| Feature và assistant navigation dùng anchor khác nhau | Low | Dùng cùng formula hoặc extract generic helper nếu actual reuse làm giảm duplication mà không tạo cross-feature dependency. |

## Ngoài phạm vi

- Click tip để jump tới user message.
- Hiển thị attachment/image thumbnail trong tip.
- Persist active prompt riêng theo session.
- Host/ACP protocol mới.
- Setting bật/tắt tip.
- Thay đổi assistant-turn navigation controls.

## Completion notes

Implemented on 2026-07-15:

- Refactored `MessageListComponent.onScrollPositionChange()` to emit `{ isNearBottom, scrollTop }` for every transcript scroll, explicit scroll restore, and auto-scroll-to-bottom.
- Replaced fixed latest-prompt lookup with ordered user-turn entries and viewport reading-anchor selection.
- Active entry lookup uses binary search over DOM-ordered user messages and rAF-coalesced layout reads.
- User-message mutations rebuild the index; assistant-only streaming mutations do not.
- Added resize handling that refreshes near-bottom state and recalculates the active turn without rebuilding entries.
- Preserved single-line ellipsis, keyboard-focus expansion and contextual ARIA text.
- Added 11 focused JSDOM tests for three-turn bidirectional scrolling, boundary behavior, near-bottom visibility, streaming stability, non-text turns, clear/replay, resize and subscription lifecycle.
- Reviewer verdict: Approve, no blocking findings.

Verification:

- `npx eslint src/views/webview/component/message-list.ts src/views/webview/types.ts src/features/latest-user-prompt-tip/styles.ts src/features/latest-user-prompt-tip/webview.ts src/test/features/latest-user-prompt-tip.test.ts` — passed.
- `npm run check-types` — passed, including Antigravity adapter typecheck.
- `npm run compile-tests` — passed.
- `npx mocha --ui tdd out/test/features/latest-user-prompt-tip.test.js` — 11 passing.
- `npm run package` — passed.
- `npx vsce package --out /tmp/vscode-acp-chat-user-prompt-tip.vsix` — packaged 126 files, 1.95 MB.
- `code --install-extension /tmp/vscode-acp-chat-user-prompt-tip.vsix --force` — installed successfully.
- Temporary VSIX was removed after installation.

## Superseded implementation note

Initial implementation ngày 2026-07-15 đã hoàn thành UI row, near-bottom visibility, streaming stability và multi-session scroll restore, nhưng chọn cố định textual user prompt mới nhất. Phần đó là foundation có thể tái sử dụng; selection semantics và tests phải được sửa theo plan này trước khi tính năng được coi là hoàn tất.

## Definition of Done

- Tip ẩn khi transcript gần đáy.
- Khi away from bottom, tip hiển thị user prompt sở hữu vùng transcript tại reading anchor.
- Scroll lên qua turn boundary đổi về prompt trước đó.
- Scroll xuống qua turn boundary đổi sang prompt mới hơn.
- Assistant tiếp tục stream không làm đổi prompt nếu user không đổi vùng đang đọc.
- Clear/history/multi-session restore/resize đều cho kết quả đúng.
- Không còn logic cố định `latest user prompt` trong feature.
- Focused tests cover ít nhất ba turns, hai hướng scroll, boundary, streaming và session restore.
- Typecheck/test/package/install hoàn tất hoặc blocker ngoài phạm vi được báo chính xác.
