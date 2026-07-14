# Kế hoạch triển khai: Điều hướng nhanh giữa các lượt trả lời của Assistant

## Tổng quan

Bổ sung tính năng trong webview cho phép người dùng chuyển nhanh giữa các lượt trả lời đã hoàn tất của assistant/agent. Về mặt kỹ thuật, một lượt trả lời của assistant được xem là hoàn tất khi webview xử lý xong sự kiện `streamEnd` và đã có node DOM `.message.assistant` tương ứng. Kết quả mong muốn là cụm icon previous/next gọn trong multi-session header, sticky ở góc phải, scroll/focus ổn định để người dùng đọc lại cuộc hội thoại dài mà không phải lần lượt đi qua user message, system message hoặc tool details. Khi assistant turn có tool/image/action block đứng trước phần trả lời, navigation phải anchor vào `.block-text` đầu tiên để câu trả lời nằm ở đầu viewport; nếu turn không có text block thì fallback về root `.message.assistant`.

## Phân tích hiện trạng extension

Luồng message liên quan:

- `src/views/chat.ts` là luồng Extension Host legacy. File này nhận ACP `SessionNotification` qua `ACPClient.setOnSessionUpdate()`, serialize bằng `AsyncSerialProcessor`, rồi gửi message sang webview: `userMessage`, `streamStart`, `streamChunk`, `thoughtChunk`, `toolCallStart`, `toolCallComplete`, `streamEnd`.
- `src/acp/session-output-pipeline.ts` là output pipeline dùng chung cho multi-session. Pipeline này chuyển ACP update thành cùng contract render message và emit `streamEnd` trước user message được phục dựng từ history khi cần đóng lượt assistant trước đó.
- `src/features/multi-session/host.ts` lưu các render message vào `TranscriptStore`, gửi live update qua `feature.multi-session.delta`, và gửi `feature.multi-session.snapshot` khi chuyển session.
- `src/features/multi-session/webview.ts` replay transcript từ snapshot/delta bằng `controller.handleMessage(event.message)`, nên DOM của live session và replayed session đều đi qua cùng handler webview hiện tại.
- `src/views/webview/main.ts` serialize message đến bằng `AsyncSerialQueue`, xử lý feature message trước, sau đó dispatch non-feature message qua `MessageRouter`.
- `src/views/webview/component/message-list.ts` sở hữu DOM chat. `ensureAssistantMessage()` tạo một `.message.assistant` cho lượt trả lời đang stream. `handleStreamEnd()` finalize block, render `.message-actions`, set generating false, clear `currentAssistantMessage`, rồi scroll xuống cuối.
- `src/views/webview/component/action-buttons.ts` thêm action cho assistant response đã hoàn tất: copy, copy to input, scroll to top, scroll về user question trước đó. Hiện chưa có điều hướng previous/next chỉ dành cho assistant response.
- `media/main.css` định nghĩa layout cho messages container, `.message.assistant`, và `.message-actions`.

Quan sát quan trọng về ranh giới turn:

- Contract ACP/webview hiện không có stable assistant-turn id.
- Ranh giới đáng tin cậy ở webview là assistant message thực sự được finalize bởi `streamEnd`, không chỉ riêng `stopReason: "end_turn"`. `stopReason: "end_turn"` chủ yếu xuất hiện khi phục dựng history trước user message kế tiếp; response live có thể kết thúc bằng stop reason khác.
- Vì vậy tính năng nên index các DOM node `.message.assistant` đã hoàn tất, ưu tiên node có `.message-actions`, thay vì đếm mọi message `streamEnd`. Cách này tránh tạo lượt ảo từ history flush, error finalizer, hoặc disconnect finalizer khi không có assistant content.

Cơ chế điều hướng sẵn có:

- `MessageListComponent.scrollToTop()` và `scrollToPreviousUserMessage()` đã disable auto-scroll trước khi điều hướng thủ công.
- `setupScrollEventListeners()` đã hỗ trợ keyboard navigation giữa mọi `.message` bằng `ArrowUp`, `ArrowDown`, `Home`, `End` khi focus nằm trong message surface.
- `MessageListComponent.disableAutoScroll()`, `getScrollTop()`, `setScrollTop()`, và `elements.messagesEl` đủ để feature mới điều hướng assistant-only mà không cần đưa nhiều logic vào core file.

## Quyết định kiến trúc

- Triển khai dưới dạng webview-only feature trong `src/features/assistant-turn-navigation/`. Không cần đổi ACP protocol, host, session store, hoặc transcript schema.
- Đăng ký feature qua `src/features/register-webview.ts`, đúng quy ước tổ chức feature của repo. Core file chỉ nên thay đổi tối thiểu ở registry và, nếu thật sự cần, một helper/accessor nhỏ.
- Xem completed assistant response là nguồn dữ liệu chuẩn: `.message.assistant` đã được finalize bởi `streamEnd` và có `.message-actions`.
- Dùng `MutationObserver` trên `messageList.elements.messagesEl` để duy trì index sau live streaming, history replay, chat clear, và multi-session snapshot reset. Cách này tránh thêm nhánh feature-specific vào `MessageListComponent.handleStreamEnd()`.
- UI hiện là cụm icon previous/next gọn trong multi-session header của ACP Chat webview, đặt sticky ở góc phải để không che nội dung chat, input panel, hoặc message action bars. Không thêm nút vào từng message toolbar.
- Khi điều hướng: disable auto-scroll, scroll `.block-text` đầu tiên của response đích lên đầu transcript viewport, focus root `.message.assistant`, và thêm highlight ngắn để người dùng định vị. Nếu response không có `.block-text`, scroll root `.message.assistant` như fallback.
- Theo dõi current response index dựa trên vị trí scroll/focus của cùng scroll target để trạng thái nút previous/next vẫn đúng sau khi người dùng scroll thủ công hoặc chuyển session.
- Không dùng phím tắt `Alt+[` / `Alt+]` trong iteration này; điều hướng được thực hiện bằng icon trong header để tránh xung đột khi user đang nhập hoặc với keybindings của VS Code.

## Không nằm trong phạm vi

- Không thêm ACP message type mới cho turn.
- Không persist bookmark theo từng turn qua các session.
- Không thay thế keyboard navigation hiện tại giữa mọi message.
- Không phụ thuộc vào literal text như `turn agent end -->`; cụm này được ánh xạ sang semantics hiện tại là `streamEnd` + completed assistant DOM.
- Không thêm full response outline/search panel trong iteration đầu.

## Danh sách task

### Phase 1: Chốt semantics của turn và tạo feature shell

#### Task 1: Khóa semantics assistant-turn bằng test

**Mô tả:** Thêm test tập trung để mô tả cách một completed assistant turn đang được biểu diễn. Test cần xác nhận các boundary `streamEnd` riêng biệt tạo ra các `.message.assistant` riêng biệt có action bar, và một `streamEnd` không có assistant content thì không tạo navigable turn.

**Acceptance criteria:**

- [ ] Test cover hai lượt user/assistant bình thường và xác nhận có hai completed assistant response node.
- [ ] Test cover `streamEnd` xảy ra khi chưa có `streamChunk`, `thoughtChunk`, hoặc tool content và xác nhận trường hợp này không được tính là response node.
- [ ] Test ghi rõ completed response detection dựa trên DOM: `.message.assistant` + `.message-actions`.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm run compile-tests`
- [ ] Webview tests liên quan pass.

**Dependencies:** Không có

**Files likely touched:**

- `src/test/webview.test.ts`

**Estimated scope:** Small: 1 file

#### Task 2: Tạo shell cho webview feature `assistant-turn-navigation`

**Mô tả:** Tạo webview-only feature module và đăng ký qua webview feature registry hiện có. Shell sở hữu lifecycle setup, DOM handles, và model index response, nhưng chưa cần render UI cuối cùng.

**Acceptance criteria:**

- [ ] Feature mới nằm trong `src/features/assistant-turn-navigation/`.
- [ ] `src/features/register-webview.ts` đăng ký feature này cạnh `multiSession`.
- [ ] Feature chỉ đọc public surface ổn định như `controller.messageList.elements` và `controller.messageList.disableAutoScroll()`.
- [ ] Không thêm logic feature lớn vào `src/views/webview/main.ts`, `message-list.ts`, hoặc `action-buttons.ts`.

**Verification:**

- [ ] `npm run check-types`

**Dependencies:** Task 1

**Files likely touched:**

- `src/features/assistant-turn-navigation/webview.ts`
- `src/features/assistant-turn-navigation/types.ts` nếu cần typed internal state
- `src/features/register-webview.ts`

**Estimated scope:** Small: 2-3 files

### Checkpoint: Semantics và registration

- [ ] Contract turn hiện tại đã có test bảo vệ.
- [ ] Feature mới đã được register nhưng chưa đổi hành vi người dùng.
- [ ] TypeScript compile pass.

### Phase 2: Index response và hành vi điều hướng

#### Task 3: Duy trì index các completed assistant response

**Mô tả:** Implement response discovery bằng `MutationObserver` trên `#messages`. Model nên chứa ordered response entries gồm element reference, index, label text, và completed/live state nếu cần.

**Acceptance criteria:**

- [ ] Index update khi một response hoàn tất và `.message-actions` được thêm vào.
- [ ] Index clear khi DOM chat bị clear.
- [ ] Index rebuild đúng sau multi-session snapshot replay.
- [ ] Empty assistant container hoặc orphan `streamEnd` bị bỏ qua.
- [ ] Label response được tạo từ user message liền trước hoặc text đầu của response, truncate an toàn cho accessibility/tooltip.

**Verification:**

- [ ] JSDOM tests cover live append, clear, và snapshot-like rebuild.
- [ ] `npm run check-types`

**Dependencies:** Task 2

**Files likely touched:**

- `src/features/assistant-turn-navigation/webview.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Medium: 2 files

#### Task 4: Implement jump previous/next

**Mô tả:** Thêm method để nhảy tới completed assistant response trước/sau dựa trên scroll/focus hiện tại. Điều hướng phải giữ quyền kiểm soát của user bằng cách disable auto-scroll trước khi scroll/focus target. Scroll target ưu tiên `.block-text` đầu tiên trong assistant turn để phần trả lời, không phải tool/image block phía trước, nằm trên cùng viewport.

**Acceptance criteria:**

- [ ] Previous/next bỏ qua user, system, error, và tool-detail-only scroll containers; navigable entry vẫn là completed assistant response.
- [ ] Mỗi lần jump gọi `messageList.disableAutoScroll()` trước khi scroll để live generation không kéo user về cuối.
- [ ] Scroll target là `.block-text` đầu tiên của response; fallback về `.message.assistant` nếu response không có text block.
- [ ] Target response root nhận focus và có temporary visual highlight class.
- [ ] Boundary rõ ràng: previous disabled ở response đầu, next disabled ở response cuối.
- [ ] Nếu chưa có response nào đang focus/visible, previous/next chọn response gần nhất theo scroll position.

**Verification:**

- [ ] Tests cover previous, next, first/last bounds, scroll target, và focus target.
- [ ] Manual check với cuộc hội thoại có ít nhất 5 assistant responses.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/assistant-turn-navigation/webview.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Medium: 2 files

### Phase 3: UI icon trong multi-session header

#### Task 5: Render assistant response navigator trong header

**Mô tả:** Thêm navigator gọn vào multi-session header của ACP Chat webview, gồm icon previous/next. Ẩn navigator khi có ít hơn hai completed assistant responses. Counter vẫn tồn tại cho accessibility/state nội bộ nhưng không hiển thị trong UI header.

**Acceptance criteria:**

- [ ] Navigator chỉ visible khi có ít nhất hai completed assistant responses.
- [ ] State update sau khi điều hướng và sau manual scrolling.
- [ ] Nút previous/next có accessible labels và disabled state.
- [ ] UI nằm trong multi-session header, sticky bên phải, không che input panel hoặc message action bars ở các width sidebar phổ biến.
- [ ] Styling dùng VS Code theme variables và hoạt động trong dark/light theme.

**Verification:**

- [ ] JSDOM tests cover button rendering, disabled states, và counter update.
- [ ] Manual visual check ở sidebar hẹp và bình thường.

**Dependencies:** Task 4

**Files likely touched:**

- `src/features/assistant-turn-navigation/webview.ts`
- `media/main.css`
- `src/test/webview.test.ts`

**Estimated scope:** Medium: 3 files

#### Task 6: Bỏ phím tắt webview-local khỏi phạm vi hiện tại

**Mô tả:** Không đăng ký `Alt+[` / `Alt+]`. Điều hướng dùng icon trong header để tránh xung đột keybindings và tránh phải xử lý editable-control contexts.

**Acceptance criteria:**

- [ ] Không có handler `Alt+[` / `Alt+]` trong feature.
- [ ] Nút previous/next có tooltip và `aria-label` rõ ràng.
- [ ] Navigation `ArrowUp`/`ArrowDown` hiện tại trong message list không đổi.

**Verification:**

- [ ] Tests cover button navigation và header placement.
- [ ] Manual check khi focus ở input panel và khi focus ở message.

**Dependencies:** Task 5

**Files likely touched:**

- `src/features/assistant-turn-navigation/webview.ts`
- `src/test/features/assistant-turn-navigation.test.ts`

**Estimated scope:** Small: 2 files

### Checkpoint: Feature usable

- [ ] User có thể chuyển giữa completed assistant responses bằng icon previous/next trong multi-session header.
- [ ] Current response state vẫn đúng sau manual scroll.
- [ ] Chat rendering, action buttons, và keyboard navigation hiện có vẫn hoạt động.

### Phase 4: Hardening cho multi-session, history, và edge cases

#### Task 7: Làm cứng hành vi với multi-session và history

**Mô tả:** Verify và fix hành vi khi activate session, replay snapshot, load history, và đang live streaming. Task này tập trung vào timing issue do transcript replay và DOM observer.

**Acceptance criteria:**

- [ ] Khi chuyển multi-session chat, response index rebuild theo transcript active session hiện tại, không lẫn session cũ.
- [ ] Restored history có nhiều assistant responses tạo navigator count đúng.
- [ ] Live streaming không tạo duplicate response entry trước `streamEnd`.
- [ ] Cancelled/error-ended responses chỉ được tính nếu có assistant message node thật.
- [ ] Navigator state update sau `chatCleared` và `agentChanged` reset.

**Verification:**

- [ ] Thêm/chỉnh test dựa trên pattern multi-session snapshot hiện có trong `src/test/webview.test.ts`.
- [ ] Manual check: tạo hai session, chuyển qua lại, xác nhận mỗi session có response count đúng.

**Dependencies:** Tasks 3-6

**Files likely touched:**

- `src/features/assistant-turn-navigation/webview.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Medium: 2 files

#### Task 8: Thêm regression coverage cuối

**Mô tả:** Gom coverage cho feature hoàn chỉnh và đảm bảo không regress message-list behavior hiện có.

**Acceptance criteria:**

- [ ] Tests cover response indexing, header button navigation, answer-text scroll target, clear/reset, multi-session snapshot replay, và no-response cases.
- [ ] Existing tests cho action buttons, turn separation, streaming, và multi-session snapshots vẫn pass.
- [ ] Tests không phụ thuộc vào implementation details ngoài public DOM classes và accessibility attributes.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm run compile-tests`
- [ ] `npm test` hoặc invocation webview test nhỏ nhất nếu repo hỗ trợ.

**Dependencies:** Tasks 1-7

**Files likely touched:**

- `src/test/webview.test.ts`

**Estimated scope:** Small: 1 file

### Phase 5: Quality gates, packaging, và cài local

#### Task 9: Chạy checks bắt buộc và build production bundle

**Mô tả:** Chạy quality gates của repo cho thay đổi extension/webview trước khi package.

**Acceptance criteria:**

- [ ] TypeScript check pass.
- [ ] Test compilation pass.
- [ ] Relevant tests pass.
- [ ] Production package build pass.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm run compile-tests`
- [ ] `npm test`
- [ ] `npm run package`

**Dependencies:** Tasks 1-8

**Files likely touched:** Không có

**Estimated scope:** Small: commands only

#### Task 10: Package và install extension mới vào VS Code local

**Mô tả:** Làm theo rule của repo cho thay đổi extension/webview code: tạo VSIX và cài vào VS Code trước khi báo hoàn tất.

**Acceptance criteria:**

- [ ] VSIX được tạo trong temporary hoặc git-ignored path.
- [ ] VSIX được install bằng `--force`.
- [ ] Temporary VSIX được xóa khi an toàn.
- [ ] Báo user chạy `Developer: Reload Window`.

**Verification:**

- [ ] `npx vsce package --out .tmp/vscode-acp-chat-assistant-turn-navigation.vsix`
- [ ] `code --install-extension .tmp/vscode-acp-chat-assistant-turn-navigation.vsix --force`

**Dependencies:** Task 9

**Files likely touched:** Không có, trừ khi `.gitignore` cần thêm temporary output path.

**Estimated scope:** Small: commands only

## Rủi ro và cách giảm thiểu

| Rủi ro | Impact | Mitigation |
| --- | --- | --- |
| Đếm raw `streamEnd` tạo phantom turns | High | Index finalized assistant DOM nodes, không index raw `streamEnd` events. |
| Navigation đánh nhau với live auto-scroll | Medium | Luôn gọi `messageList.disableAutoScroll()` trước manual jump. |
| Tool/image block đứng trước câu trả lời bị đưa lên đầu viewport | Medium | Scroll vào `.block-text` đầu tiên của assistant turn; chỉ fallback `.message.assistant` khi không có text block. |
| Multi-session snapshot replay để lại stale entries | Medium | Rebuild từ DOM `#messages` hiện tại sau mutations và sau clear/reset; không lưu host/session id trong feature. |
| Header controls chen lấn title/status ở sidebar hẹp | Medium | Control chỉ gồm icon, đặt `margin-left:auto`, sticky bên phải, counter ẩn khỏi visual UI. |
| Keyboard shortcuts xung đột khi đang nhập hoặc với default VS Code | Low | Không đăng ký `Alt+[` / `Alt+]` trong iteration hiện tại; dùng icon trong header. |
| `MutationObserver` update quá nhiều khi streaming | Low | Debounce rebuild bằng `requestAnimationFrame` và chỉ index completed assistant nodes. |
| Test brittle vì JSDOM không có real layout | Low | Unit-test index/state và stub scroll/focus; visual scroll placement kiểm tra thủ công. |

## Câu hỏi mở

- Có nên ẩn navigator khi chỉ có một assistant response không? Khuyến nghị: có, để giảm nhiễu UI.
- Cancelled/error-ended response có nên navigable không? Khuyến nghị: có nếu tồn tại assistant message element, vì user vẫn cần xem partial output hoặc failed tool context.
- Có nên thêm quick-pick/dropdown hiển thị toàn bộ response labels không? Khuyến nghị: defer. Previous/next icon controls giải quyết nhu cầu chính với UI ít phức tạp hơn.
- Có nên cấu hình shortcut qua VS Code keybindings không? Khuyến nghị: defer. Iteration hiện tại không dùng phím tắt; chỉ thêm contributed commands nếu cần global shortcuts sau này.

## Definition of Done

- Webview có compact assistant response navigator trong multi-session header cho conversation có nhiều completed assistant responses.
- Previous/next icon controls chỉ nhảy giữa completed assistant responses.
- Navigation đưa phần trả lời `.block-text` của turn đích lên đầu transcript viewport, không neo vào tool/image/action blocks trước đó.
- Navigation hoạt động sau live streaming, history replay, chat clear/reset, và multi-session switching.
- Message rendering, action buttons, input behavior, và multi-session behavior hiện có không đổi.
- Quality gates pass, production bundle build thành công, VSIX được package/install local, và user được nhắc reload VS Code.
