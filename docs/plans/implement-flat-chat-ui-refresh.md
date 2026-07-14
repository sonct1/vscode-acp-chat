# Implementation Plan: Flat Chat UI Refresh

## Tổng quan

Làm phẳng giao diện ACP Chat webview theo hướng VS Code-native: ít elevation, ít bo góc, ít animation, dùng border/spacing/theme token thay cho shadow/gradient/blur. Mục tiêu là đưa UI từ mức flat hiện tại khoảng 65–70% lên khoảng 85–90% mà không đổi message protocol, ACP lifecycle, hoặc cấu trúc component lớn.

Phạm vi chính là styling và một số markup nhỏ nếu cần cho trạng thái/hành động rõ ràng hơn. Không tạo design system mới ngoài repo; ưu tiên reuse CSS hiện có và VS Code theme variables.

## Phân tích hiện trạng

Nguồn UI liên quan:

- `docs/architecture/acp-chat-layout.md` — source of truth về bố cục ACP Chat.
- `media/main.css` — CSS chính của chat surface, message list, input, dropdown, modal, diff/plan/tool panels.
- `media/vscode.css` — theme integration và CSS variables chung.
- `src/features/multi-session/styles.ts` — CSS inject cho multi-session header, loading strip, manager overlay.
- `src/views/webview/component/*` và `src/views/webview/widget/*` — DOM/component behavior cho input, toolbar, messages, dropdown, modal, diff, plan.

Hiện trạng đã khá flat ở các phần:

- Assistant message dùng background transparent, không bubble/card lớn.
- Multi-session header/list chủ yếu dùng border và background theo VS Code token.
- Button/icon phần lớn transparent, hover nhẹ.
- Toàn bộ webview dùng nhiều `--vscode-*` theme variables.

Các điểm chưa flat:

- `media/main.css` có nhiều `box-shadow`, đặc biệt ở autocomplete, dropdown, tooltip, image preview, modal, diff/plan panel.
- Message area có gradient fade (`.messages-fade-top`, `.messages-fade-bottom`).
- Radius lớn ở input (`12px`), modal (`8px`), message/user bubble (`8px`), badge pill (`999px`).
- Nhiều animation/transition: message fade-in, popover scale, slide-up modal, spinner/dots.
- Modal overlay dùng nền đen + `backdrop-filter: blur(2px)`.
- Input area nhìn như card nổi ở đáy thay vì panel phẳng.
- Popover/dropdown đang có depth rõ, chưa cùng ngôn ngữ với list/panel VS Code.

## Mục tiêu UX

- Giao diện phẳng, ít lớp nổi, gần VS Code sidebar/panel native.
- Tương phản và focus state vẫn rõ, không hy sinh accessibility.
- Các trạng thái quan trọng vẫn nhận biết được: running, error, permission, selected, hover, focus.
- Không làm giảm khả năng đọc code/diff/tool output.
- Không thay đổi behavior trừ khi cần để hỗ trợ visual cleanup.

## Nguyên tắc thiết kế

- Dùng border thay elevation: `border: 1px solid var(--vscode-panel-border)` hoặc token tương ứng.
- Hạn chế shadow: chỉ giữ nếu VS Code-native popup cần tách khỏi nền; nếu giữ thì dùng rất nhẹ hoặc theme token.
- Radius nhỏ và nhất quán: ưu tiên `0–4px`; chỉ giữ pill cho badge nhỏ nếu có ý nghĩa trạng thái.
- Motion tối thiểu: giữ spinner trạng thái; bỏ animation trang trí/entry nếu không cần.
- Không dùng blur/backdrop-filter.
- Hover/selected dùng `--vscode-list-hoverBackground`, `--vscode-list-activeSelectionBackground`, hoặc `--vscode-toolbar-hoverBackground`.
- Màu nền dùng `--vscode-sideBar-background`, `--vscode-editor-background`, `--vscode-input-background`, `--vscode-dropdown-background` theo ngữ cảnh.

## Không nằm trong phạm vi

- Không đổi layout chính của chat hoặc vị trí các vùng A–K trong `docs/architecture/acp-chat-layout.md`, trừ khi phát hiện lỗi layout khi triển khai.
- Không đổi ACP protocol, session lifecycle, multi-session behavior.
- Không thêm framework CSS hoặc dependency UI mới.
- Không thiết kế theme riêng ngoài VS Code theme token.
- Không thay đổi icon set hoặc command contribution trong `package.json`.

## Implementation phases

### Phase 1: Flat token baseline

#### Task 1: Chuẩn hoá CSS variables cho flat UI

**Mô tả:** Thêm/điều chỉnh biến CSS chung trong `media/vscode.css` để các vùng UI dùng chung radius, border, hover, panel background.

**Acceptance criteria:**

- [ ] Có biến semantic cho flat radius, border, hover background, panel background nếu cần.
- [ ] Không phá dark/light/high contrast theme.
- [ ] Các biến fallback về VS Code token hiện có.
- [ ] Không hard-code màu mới nếu VS Code token đã có.

**Verification:**

- [ ] `npm run check-types` không bị ảnh hưởng.
- [ ] Manual visual check dark/light theme.

**Files likely touched:**

- `media/vscode.css`
- `media/main.css`

**Estimated scope:** Small

#### Task 2: Audit và phân loại visual depth hiện có

**Mô tả:** Lập danh sách selector đang dùng `box-shadow`, `linear-gradient`, `backdrop-filter`, radius lớn, animation entry; quyết định remove/keep/reduce.

**Acceptance criteria:**

- [ ] Các selector depth cao được phân loại theo nhóm: message/input/dropdown/modal/diff/multi-session.
- [ ] Không xoá style phục vụ accessibility như focus ring.
- [ ] Có danh sách ngoại lệ nếu shadow/radius cần giữ.

**Verification:**

- [ ] Review diff CSS trước khi đổi sâu.

**Files likely touched:**

- `media/main.css`
- `src/features/multi-session/styles.ts`

**Estimated scope:** Small

### Checkpoint: Baseline direction

- [ ] Flat design rules được thể hiện bằng CSS variables hoặc comment ngắn.
- [ ] Không có thay đổi DOM/protocol.
- [ ] Visual target thống nhất trước khi sửa từng vùng.

### Phase 2: Main chat surface flattening

#### Task 3: Làm phẳng message area và message bubbles

**Mô tả:** Bỏ gradient fade không cần thiết, giảm animation fade-in/translate, giảm radius user bubble, giữ assistant content transparent.

**Acceptance criteria:**

- [ ] `.messages-fade-top` / `.messages-fade-bottom` không tạo gradient depth rõ; hoặc bị loại bỏ nếu scroll UX vẫn ổn.
- [ ] `.message` không dùng animation entry trang trí mặc định, hoặc được giảm theo `prefers-reduced-motion`.
- [ ] `.message.user` dùng border/radius nhỏ hơn, không giống card nổi.
- [ ] Error/system message vẫn đủ nổi bật bằng border/background token.

**Verification:**

- [ ] Manual check transcript có user, assistant, error, system messages.
- [ ] Existing webview tests không regression.

**Files likely touched:**

- `media/main.css`

**Estimated scope:** Small

#### Task 4: Làm phẳng input composer

**Mô tả:** Chuyển input từ rounded card lớn sang panel phẳng, radius nhỏ, focus bằng border/outline thay shadow.

**Acceptance criteria:**

- [ ] `#chat-input-area` giảm radius từ kiểu card lớn về flat panel (`0–4px` hoặc biến flat radius).
- [ ] Focus state không dùng `box-shadow` dày; vẫn rõ bằng border/outline.
- [ ] `#options-bar` border-top và spacing vẫn rõ.
- [ ] Mention/command chip không quá nổi; hover vẫn dễ thấy.
- [ ] Send/stop/attach buttons giữ hit target đủ dùng.

**Verification:**

- [ ] Manual check typing, multiline input, chips, attach image, send/stop.
- [ ] Narrow sidebar width không bị vỡ layout.

**Files likely touched:**

- `media/main.css`

**Estimated scope:** Medium

#### Task 5: Làm phẳng tool/thought/code/diff blocks ở message content

**Mô tả:** Giảm radius/shadow/opacity thừa trong code block, tool output, thought block, inline diff, plan/diff summary.

**Acceptance criteria:**

- [ ] Code/tool output dùng editor/code background + border nhẹ, không shadow.
- [ ] Thought/tool disclosure state rõ bằng icon/border, không phụ thuộc animation.
- [ ] Diff/plan panels không dùng elevation mạnh.
- [ ] Readability của inline diff không giảm.

**Verification:**

- [ ] Manual check assistant response có code block, tool call, thought, diff summary.
- [ ] Nếu thay đổi inline diff layout thì cập nhật test liên quan.

**Files likely touched:**

- `media/main.css`
- `src/views/webview/widget/diff-render.ts` nếu cần markup nhỏ

**Estimated scope:** Medium

### Checkpoint: Chat surface flat

- [ ] Message list, assistant content, user message, input composer đồng nhất flat style.
- [ ] Không còn shadow/gradient rõ ở chat surface chính.
- [ ] Keyboard focus vẫn đạt yêu cầu accessibility.

### Phase 3: Popover, dropdown, modal flattening

#### Task 6: Làm phẳng autocomplete và dropdown popovers

**Mô tả:** Giảm shadow/radius/animation của `#command-autocomplete` và `.dropdown-popover`, dùng border + solid background theo VS Code token.

**Acceptance criteria:**

- [ ] Autocomplete/dropdown không còn floating elevation mạnh.
- [ ] Search/model dropdown nếu có vẫn scroll tốt.
- [ ] Selected/hover row dùng list token.
- [ ] Không làm mất keyboard navigation, star toggle, selection callback.

**Verification:**

- [ ] Manual check slash command autocomplete, file search autocomplete, mode/model/config dropdown.
- [ ] Relevant webview/dropdown tests pass.

**Files likely touched:**

- `media/main.css`
- `src/views/webview/widget/dropdown.ts` chỉ nếu cần thêm class/state

**Estimated scope:** Medium

#### Task 7: Làm phẳng tooltip, image preview, confirm/permission modal

**Mô tả:** Loại bỏ blur/backdrop-filter, giảm modal shadow/radius, dùng border và background solid.

**Acceptance criteria:**

- [ ] Modal overlay không dùng `backdrop-filter`.
- [ ] Modal dialog không dùng shadow mạnh; border đủ tách nền.
- [ ] Tooltip/image preview dùng border và theme background, shadow nhẹ hoặc không shadow.
- [ ] Permission/confirm dialog vẫn nổi bật và focus trap không bị ảnh hưởng.

**Verification:**

- [ ] Manual check confirm action, permission request, image preview hover, tooltip.
- [ ] Keyboard focus trong modal vẫn hoạt động.

**Files likely touched:**

- `media/main.css`
- `src/views/webview/widget/confirm-dialog.ts` nếu cần class/markup nhỏ
- `src/views/webview/widget/permission-dialog.ts` nếu cần class/markup nhỏ

**Estimated scope:** Medium

### Checkpoint: Overlay/popover flat

- [ ] Không còn blur và shadow mạnh ở overlay/popover.
- [ ] Popup vẫn phân biệt được với nền bằng border/background.
- [ ] Interaction behavior giữ nguyên.

### Phase 4: Multi-session UI alignment

#### Task 8: Đồng bộ multi-session header/list/manager với flat tokens

**Mô tả:** Cập nhật `src/features/multi-session/styles.ts` để dùng cùng radius/border/hover rules với chat UI.

**Acceptance criteria:**

- [ ] Multi-session header vẫn sticky và không tạo cảm giác card nổi.
- [ ] Active item indicator dùng border/left accent thay `box-shadow` nếu phù hợp.
- [ ] Badges/running/permission/error states vẫn rõ.
- [ ] Manager overlay dùng background/border flat, không depth thừa.

**Verification:**

- [ ] Manual check create/activate/close sessions, running session, permission badge.
- [ ] `src/test/features/multi-session.test.ts` vẫn pass nếu chạy được.

**Files likely touched:**

- `src/features/multi-session/styles.ts`

**Estimated scope:** Small

#### Task 9: Đảm bảo assistant turn navigation và toolbar icons hòa với flat UI

**Mô tả:** Kiểm tra/điều chỉnh `.assistant-turn-navigator`, icon buttons, context usage ring để không lệch visual language.

**Acceptance criteria:**

- [ ] Navigator buttons dùng cùng hover/focus style với icon buttons.
- [ ] Disabled state rõ nhưng không quá mờ.
- [ ] Context usage warning/full state vẫn nhận biết được.

**Verification:**

- [ ] Manual check transcript có nhiều assistant turns.
- [ ] Manual check context ring states nếu có metadata.

**Files likely touched:**

- `media/main.css`

**Estimated scope:** Small

### Checkpoint: Cross-feature visual consistency

- [ ] Multi-session, navigator, toolbar, message surface cùng một hệ radius/hover/focus.
- [ ] Không còn style riêng gây lệch ở feature CSS.

### Phase 5: Documentation and verification

#### Task 10: Cập nhật tài liệu layout/style nếu có thay đổi visual contract

**Mô tả:** Nếu layout hoặc visual responsibility thay đổi, cập nhật `docs/architecture/acp-chat-layout.md`. Nếu chỉ đổi CSS token và không đổi layout, chỉ ghi completion notes trong plan khi triển khai.

**Acceptance criteria:**

- [ ] `docs/architecture/acp-chat-layout.md` được cập nhật nếu vùng UI, class ownership, hoặc layout rule thay đổi.
- [ ] Plan được cập nhật trạng thái/completion notes khi implementation hoàn tất.
- [ ] Nếu behavior/UI capability thay đổi đáng kể, cập nhật `docs/features/feature-catalog.md` theo repo rule.

**Verification:**

- [ ] Đọc lại docs liên quan để đảm bảo không mô tả style cũ trái thực tế.

**Files likely touched:**

- `docs/architecture/acp-chat-layout.md` nếu cần
- `docs/plans/implement-flat-chat-ui-refresh.md`
- `docs/features/feature-catalog.md` nếu behavior/capability thay đổi

**Estimated scope:** Small

#### Task 11: Quality gates, build, package, install

**Mô tả:** Vì thay đổi extension/webview CSS/TS, chạy checks và cài VSIX local theo repo rule trước khi báo hoàn tất.

**Acceptance criteria:**

- [ ] Typecheck pass.
- [ ] Relevant tests pass.
- [ ] Production package build pass.
- [ ] VSIX được tạo ở path tạm/git-ignored.
- [ ] VSIX được install vào VS Code bằng `--force`.
- [ ] User được nhắc chạy `Developer: Reload Window`.

**Verification:**

```bash
npm run check-types
npm run compile-tests
npm test -- --grep "webview\|multi-session" # nếu test runner hỗ trợ grep; nếu không, chạy npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-flat-ui-refresh.vsix
code --install-extension .tmp/vscode-acp-chat-flat-ui-refresh.vsix --force
```

**Dependencies:** Tasks 1–10

**Files likely touched:** None, trừ khi cần `.gitignore` cho `.tmp/`.

**Estimated scope:** Commands only

## Rủi ro và giảm thiểu

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Flat quá mức làm mất phân cấp thị giác | Medium | Giữ border, spacing, typography weight, selected/hover token rõ ràng. |
| Bỏ shadow làm popover khó phân biệt nền | Medium | Dùng `--vscode-widget-border`, solid background, selected row rõ. |
| Giảm animation làm trạng thái running kém rõ | Low | Giữ spinner/status icon cho hoạt động thật; chỉ bỏ entry/decorative animation. |
| High contrast theme bị giảm accessibility | High | Không hard-code màu; dùng VS Code token và kiểm tra high contrast nếu có thể. |
| CSS thay đổi rộng gây regression UI nhỏ | Medium | Làm theo phase, manual checklist từng vùng, chạy webview/multi-session tests. |
| Feature CSS inject riêng không ăn biến chung | Low | Đồng bộ `src/features/multi-session/styles.ts` với variables trong `media/vscode.css`. |

## Open questions

- Có cần setting để bật/tắt flat UI không? Khuyến nghị: không ở phiên bản đầu; áp dụng làm visual refresh mặc định để tránh tăng complexity.
- Có giữ shadow nhẹ cho dropdown/modal theo VS Code native không? Khuyến nghị: chỉ giữ nếu manual check cho thấy border không đủ tách nền; nếu giữ, giảm opacity và thống nhất token.
- Có giảm radius badge pill không? Khuyến nghị: giữ pill cho badge đếm/unread nhỏ, giảm radius ở container lớn trước.

## Definition of Done

- Chat webview đạt visual flat nhất quán ở message list, input, dropdown, modal, multi-session manager.
- Không còn blur/gradient/shadow mạnh không cần thiết.
- Focus, hover, selected, error, permission, running states vẫn rõ và accessible.
- Không đổi ACP protocol/session behavior.
- Relevant tests, package build, VSIX install local hoàn tất hoặc blocker được báo rõ.
