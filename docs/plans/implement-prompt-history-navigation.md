# Implementation Plan: Prompt History Navigation

## Mục tiêu

Bổ sung khả năng dùng `ArrowUp` / `ArrowDown` trong prompt input để duyệt lại các user message của **session chat hiện tại**. Khi duyệt, nội dung prompt input được thay bằng user message tương ứng để người dùng có thể sửa và gửi lại.

## Phân tích hiện trạng

Relevant flow:

```text
User typing
  ▼
#input contenteditable
  ▼
InputPanelComponent
  ├─ autocomplete handles ArrowUp / ArrowDown khi popup đang mở
  ├─ Enter gửi sendMessage
  └─ Escape clear input

ACP/webview messages
  ▼
MessageListComponent
  └─ render userMessage thành .message.user .message-content-text

Multi-session
  ▼
MultiSessionWebviewController
  ├─ applySnapshot() reset transcript DOM
  ├─ replay transcript của active session
  └─ restore per-session draft input
```

Các điểm chính:

- Prompt input nằm trong `src/views/webview/component/input-panel.ts`, là `contenteditable`, không phải `<textarea>`.
- User message được render trong transcript bởi `src/views/webview/component/message-list.ts` khi nhận `userMessage`.
- Autocomplete trong `src/views/webview/component/autocomplete.ts` đã dùng `ArrowUp` / `ArrowDown` khi popup `/` hoặc `@` đang visible.
- Multi-session replay transcript active session vào DOM khi đổi session, nên lịch sử có thể lấy từ message list hiện tại mà không cần host API mới.
- User message có thể chứa mention chip hoặc command chip. Nếu chỉ copy `textContent`, sẽ mất metadata cần để gửi lại mention đúng cách.

Root requirement: history navigation phải hoạt động trong webview layer, theo session hiện tại, không đổi ACP protocol/Extension Host.

## Quyết định UX

- Khi focus đang ở prompt input:
  - `ArrowUp`: đưa user message mới nhất vào prompt.
  - `ArrowUp` tiếp: đi về user message cũ hơn.
  - `ArrowDown`: đi tới user message mới hơn.
  - `ArrowDown` sau message mới nhất: restore draft ban đầu trước khi bắt đầu duyệt history.
- Không can thiệp khi autocomplete popup đang xử lý phím.
- Không phá multiline editing:
  - `ArrowUp` chỉ navigate khi caret ở dòng đầu logic.
  - `ArrowDown` chỉ navigate khi caret ở dòng cuối logic.
- Nếu user sửa input sau khi đang duyệt history, thoát navigation mode và coi nội dung hiện tại là draft mới.
- Khi send, clear chat, đổi session hoặc transcript thay đổi, reset navigation index.
- Không hiển thị UI mới trong MVP; đây là keyboard interaction thuần.

## Kiến trúc đề xuất

Đây là product-specific webview feature, nên đặt logic dưới `src/features/prompt-history-navigation/`.

```text
src/features/
├── prompt-history-navigation/
│   ├── types.ts
│   ├── webview.ts
│   └── index.ts
└── register-webview.ts
```

Không cần `host.ts` vì feature chỉ đọc transcript DOM hiện tại và cập nhật prompt input trong webview.

### Core integration tối thiểu

| File | Thay đổi |
| --- | --- |
| `src/views/webview/component/message-list.ts` | Expose method public để lấy các user message hiện có dưới dạng draft HTML an toàn cho input. |
| `src/views/webview/component/input-panel.ts` | Expose method public để set draft HTML vào input, focus và đưa caret về cuối. |
| `src/views/webview/types.ts` | Thêm type dùng chung nếu cần, ví dụ `PromptHistoryEntry`. |
| `src/features/register-webview.ts` | Register `promptHistoryNavigation` feature. |
| `src/features/prompt-history-navigation/webview.ts` | Keyboard handling, index state, draft restore, caret guard. |

Không sửa `src/views/chat.ts`, `src/features/register-host.ts` hoặc host message contracts cho MVP.

## Thiết kế dữ liệu

```ts
export interface PromptHistoryEntry {
  html: string;
  text: string;
}
```

- `html`: dùng để restore prompt input với mention/command chip metadata.
- `text`: dùng cho comparison, filtering empty entries, tests, hoặc fallback.

`MessageListComponent.getUserMessageDrafts()` nên trả về danh sách theo thứ tự cũ → mới.

## Thiết kế copy user message vào input

Khi đọc `.message.user .message-content-text`:

- clone DOM thay vì move node gốc;
- lấy `innerHTML` sau khi normalize chip;
- với `.mention-chip.readonly` và `.command-chip.readonly`, remove class `readonly` để dùng lại trong input;
- giữ dataset quan trọng:
  - `data-name`
  - `data-path`
  - `data-type`
  - `data-content`
  - `data-range`
  - `data-data-url`
  - `data-command`

Khi set vào input:

- `inputEl.innerHTML = entry.html`;
- `adjustHeight()`;
- `updateInputState()`;
- save state;
- focus input;
- collapse selection về cuối input.

## Keyboard handling

Feature lắng nghe `keydown` trên `controller.inputPanel.elements.inputEl`.

Điều kiện xử lý:

- key là `ArrowUp` hoặc `ArrowDown`;
- không có `shiftKey`, `altKey`, `ctrlKey`, `metaKey`;
- event chưa bị `preventDefault()` bởi autocomplete;
- selection nằm trong input;
- selection đang collapsed;
- có ít nhất một user message trong transcript hiện tại;
- với `ArrowUp`, caret đang ở dòng đầu logic;
- với `ArrowDown`, caret đang ở dòng cuối logic.

MVP dùng newline-based logical line guard:

- `ArrowUp`: nếu phần text trước caret có `\n`, không xử lý.
- `ArrowDown`: nếu phần text sau caret có `\n`, không xử lý.

Có thể nâng cấp sau bằng visual-line detection qua `Range.getClientRects()` nếu cần hỗ trợ wrapped line chính xác hơn.

## Navigation state

```ts
private activeIndex: number | null = null;
private draftBeforeNavigationHtml = "";
private suppressInputReset = false;
```

Pseudo-flow:

```ts
on ArrowUp:
  history = getUserMessageDrafts()
  if history empty: return
  if activeIndex is null:
    draftBeforeNavigationHtml = inputPanel.getInputHtml()
    activeIndex = history.length
  activeIndex = Math.max(0, activeIndex - 1)
  setInput(history[activeIndex].html)

on ArrowDown:
  if activeIndex is null: return
  history = getUserMessageDrafts()
  activeIndex = Math.min(history.length, activeIndex + 1)
  if activeIndex === history.length:
    setInput(draftBeforeNavigationHtml)
    reset navigation mode
  else:
    setInput(history[activeIndex].html)
```

Reset navigation mode khi:

- user nhập/sửa input thủ công;
- gửi message;
- transcript DOM thay đổi;
- chat reset/session snapshot replay;
- autocomplete selection làm thay đổi input.

Có thể dùng:

- `input` listener trên input;
- `MutationObserver` trên `messagesEl`;
- cờ `suppressInputReset` để tránh reset do feature tự set input.

## Task List

### Phase 1: Webview foundation

#### Task 1: Thêm type và API lấy user message history

**Description:** Thêm type `PromptHistoryEntry` và public method trên `MessageListComponent` để lấy các user message trong transcript hiện tại dưới dạng draft input.

**Acceptance criteria:**

- [ ] Trả về user messages theo thứ tự cũ → mới.
- [ ] Bỏ qua message rỗng.
- [ ] Preserve mention chip và command chip metadata.
- [ ] Không mutate transcript DOM gốc.

**Verification:**

- [ ] Add/adjust JSDOM tests cho plain text, mention chip, command chip.
- [ ] `npm run check-types`.

**Dependencies:** None

**Files likely touched:**

- `src/views/webview/types.ts`
- `src/views/webview/component/message-list.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Small: 2-3 files

#### Task 2: Thêm API set draft HTML vào prompt input

**Description:** Thêm method public trên `InputPanelComponent` để set HTML draft, focus input, move caret cuối, adjust height, update state.

**Acceptance criteria:**

- [ ] Set được plain text HTML vào input.
- [ ] Set được mention/command chip HTML vào input.
- [ ] Caret nằm cuối input sau khi set.
- [ ] Send button state và persisted input state được cập nhật.

**Verification:**

- [ ] JSDOM test cho `setDraftHtmlAndFocus()` hoặc equivalent.
- [ ] `npm run check-types`.

**Dependencies:** Task 1

**Files likely touched:**

- `src/views/webview/component/input-panel.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Small: 1-2 files

### Checkpoint: Foundation

- [ ] Có thể lấy history từ transcript hiện tại.
- [ ] Có thể đưa một history entry vào prompt input mà không mất chip metadata.
- [ ] Existing send/autocomplete tests không regression.

### Phase 2: Prompt history feature

#### Task 3: Implement feature keyboard navigation

**Description:** Tạo `prompt-history-navigation` webview feature, lắng nghe `ArrowUp` / `ArrowDown`, quản lý active index và restore draft ban đầu.

**Acceptance criteria:**

- [ ] `ArrowUp` lần đầu load user message mới nhất.
- [ ] `ArrowUp` tiếp đi về message cũ hơn.
- [ ] `ArrowDown` đi tới message mới hơn.
- [ ] `ArrowDown` sau message mới nhất restore draft ban đầu.
- [ ] Không post message tới Extension Host khi chỉ duyệt history.

**Verification:**

- [ ] JSDOM tests cho navigation sequence.
- [ ] `npm run check-types`.

**Dependencies:** Tasks 1-2

**Files likely touched:**

- `src/features/prompt-history-navigation/types.ts`
- `src/features/prompt-history-navigation/webview.ts`
- `src/features/prompt-history-navigation/index.ts`
- `src/features/register-webview.ts`
- `src/test/webview.test.ts` hoặc `src/test/features/prompt-history-navigation.test.ts`

**Estimated scope:** Medium: 4-5 files

#### Task 4: Guard autocomplete và multiline editing

**Description:** Đảm bảo feature không conflict với autocomplete và không hijack arrow navigation trong multiline input.

**Acceptance criteria:**

- [ ] Khi autocomplete visible và xử lý `ArrowUp`/`ArrowDown`, prompt history không đổi.
- [ ] `ArrowUp` không navigate nếu caret không ở dòng đầu logic.
- [ ] `ArrowDown` không navigate nếu caret không ở dòng cuối logic.
- [ ] Modifier keys (`Shift`, `Alt`, `Ctrl`, `Meta`) không trigger history navigation.

**Verification:**

- [ ] JSDOM tests cho autocomplete visible/defaultPrevented.
- [ ] JSDOM tests cho multiline caret guard.
- [ ] Manual keyboard check trong webview.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/prompt-history-navigation/webview.ts`
- `src/test/webview.test.ts` hoặc `src/test/features/prompt-history-navigation.test.ts`

**Estimated scope:** Small: 2 files

#### Task 5: Reset lifecycle và multi-session behavior

**Description:** Reset navigation state khi input/transcript/session thay đổi, đảm bảo history lấy theo active session hiện tại.

**Acceptance criteria:**

- [ ] User sửa input thủ công thì thoát history navigation mode.
- [ ] Sau khi send message, lần `ArrowUp` kế tiếp bắt đầu từ latest user message mới.
- [ ] Sau `chatCleared`, không còn history cũ.
- [ ] Sau multi-session snapshot/session switch, history chỉ gồm transcript active session.
- [ ] Draft per-session hiện có của multi-session không bị ghi đè ngoài ý muốn.

**Verification:**

- [ ] JSDOM tests cho reset sau input event và chat clear.
- [ ] Test hoặc manual check multi-session switch.
- [ ] `npm run check-types`.

**Dependencies:** Task 4

**Files likely touched:**

- `src/features/prompt-history-navigation/webview.ts`
- `src/test/webview.test.ts` hoặc `src/test/features/prompt-history-navigation.test.ts`

**Estimated scope:** Small: 2 files

### Checkpoint: Core behavior

- [ ] User có thể duyệt lại user messages trong prompt input bằng keyboard.
- [ ] Autocomplete vẫn dùng `ArrowUp` / `ArrowDown` bình thường.
- [ ] Multiline editing không bị phá.
- [ ] Multi-session không lẫn history giữa các session.

### Phase 3: Verification and packaging

#### Task 6: Regression tests và quality gates

**Description:** Hoàn thiện test coverage và chạy các checks phù hợp cho webview change.

**Acceptance criteria:**

- [ ] Tests cover plain text history navigation.
- [ ] Tests cover draft restore.
- [ ] Tests cover mention/command chip preservation.
- [ ] Tests cover autocomplete conflict guard.
- [ ] Tests cover multiline guard.
- [ ] TypeScript check pass.
- [ ] Production package build pass.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm run compile-tests`
- [ ] Relevant tests, ví dụ `npm test -- --grep "prompt history"` nếu runner hỗ trợ, hoặc `npm test`
- [ ] `npm run package`

**Dependencies:** Tasks 1-5

**Files likely touched:**

- `src/test/webview.test.ts`
- hoặc `src/test/features/prompt-history-navigation.test.ts`

**Estimated scope:** Small: tests/checks

#### Task 7: Package và install extension locally

**Description:** Theo rule repo, sau khi đổi extension/webview code phải build, package VSIX và install vào VS Code trước khi báo hoàn tất.

**Acceptance criteria:**

- [ ] Production bundle được build.
- [ ] VSIX được tạo ở temporary/git-ignored path.
- [ ] VSIX được install bằng `--force`.
- [ ] Temporary VSIX được remove nếu an toàn.
- [ ] User được nhắc chạy `Developer: Reload Window`.

**Verification:**

- [ ] `npm run package`
- [ ] `npx vsce package --out .tmp/vscode-acp-chat-prompt-history-navigation.vsix`
- [ ] `code --install-extension .tmp/vscode-acp-chat-prompt-history-navigation.vsix --force`

**Dependencies:** Task 6

**Files likely touched:** None, unless `.gitignore` cần thêm `.tmp/`.

**Estimated scope:** Small: commands only

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Conflict với autocomplete | High | Chạy sau autocomplete và bỏ qua khi event đã `preventDefault()` hoặc popup visible. |
| Multiline input bị mất khả năng di chuyển caret | High | Chỉ xử lý ở dòng đầu/cuối logic, bỏ qua modifier keys. |
| Mất mention/image metadata khi đưa message về input | Medium | Dùng cloned HTML và preserve chip dataset thay vì `textContent`. |
| Lẫn history giữa sessions | Medium | Lấy history từ transcript DOM hiện tại sau multi-session snapshot, reset state khi DOM đổi. |
| Draft per-session bị ghi đè | Medium | Lưu draft ban đầu khi bắt đầu navigation và restore khi đi qua cuối history; reset mode khi user sửa input. |
| JSDOM khó test caret visual line | Low | MVP dùng newline-based guard có thể test ổn định; visual wrapping để follow-up. |

## Open Questions

- Có nên cho `ArrowUp` hoạt động ngay cả khi input đang có text không? Recommendation: có, nhưng phải lưu text hiện tại làm draft để `ArrowDown` restore lại.
- Có cần UI hint trong input placeholder không? Recommendation: không trong MVP để tránh làm placeholder dài; có thể thêm sau nếu user không discover được.
- Có cần history riêng chỉ gồm message đã gửi trong runtime, không gồm loaded history? Recommendation: không; requirement là user messages trong session chat, nên loaded transcript cũng nên được duyệt.

## Definition of Done

- Trong prompt input, `ArrowUp` / `ArrowDown` duyệt được user messages của session hiện tại.
- Nội dung prompt input thay đổi theo user message đang chọn và có thể sửa/gửi lại.
- Draft trước khi duyệt history được restore bằng `ArrowDown` sau latest message.
- Mention/command chip vẫn serialize đúng khi gửi lại.
- Autocomplete và multiline editing không regression.
- Tests, typecheck, package build pass.
- VSIX được package và install locally theo repository rules khi implementation hoàn tất.
