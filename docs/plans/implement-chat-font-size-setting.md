# Implementation Plan: Chat Font Size Setting

## Mục tiêu

Thêm setting cấu hình cỡ chữ cho ACP Chat webview để người dùng có thể tăng/giảm font của vùng chat mà không phải đổi toàn bộ VS Code UI.

Setting đề xuất:

```json
"vscode-acp-chat.fontSize": 0
```

Quy ước:

- `0`: mặc định, tiếp tục dùng font size của VS Code qua `--vscode-font-size`.
- `8`-`40`: dùng cỡ chữ tùy chỉnh theo pixel cho chat webview.

## Phân tích hiện trạng

Các điểm liên quan hiện tại:

- `package.json` chưa có setting font size riêng cho extension.
- `media/vscode.css` đặt `body { font-size: var(--vscode-font-size); }`, nên webview đang theo VS Code UI font size.
- `media/main.css` có một số vùng chat dùng kích thước tương đối:
  - `.message-content-text { font-size: 1.1em; }`
  - markdown heading/code dùng `em`, phần lớn sẽ scale theo base font.
- `#input` trong `media/main.css` đang đặt trực tiếp `font-size: var(--vscode-font-size);`, nên cần đổi để dùng cùng base chat font.
- Một số control/metadata nhỏ đang hardcode `px` như toolbar, tooltip, tool details; không nên mở rộng scope ngay nếu mục tiêu chính là tăng chữ chat và prompt input.
- Webview không đọc VS Code settings trực tiếp; Extension Host phải đọc config và gửi message xuống webview.
- Quy ước repo yêu cầu custom feature logic đặt dưới `src/features/<feature-name>/`, core files chỉ giữ integration nhỏ.

## Phạm vi MVP

Trong scope:

- Thêm setting `vscode-acp-chat.fontSize` vào VS Code Settings.
- Áp dụng setting cho base font của chat webview.
- Transcript message text, markdown content, code inline/block và prompt input scale theo setting.
- Setting thay đổi live khi user cập nhật Settings, không cần reload webview.
- Giữ mặc định hiện tại nếu user không cấu hình hoặc đặt `0`.

Ngoài scope:

- Không thêm theme/color scheme setting.
- Không thêm settings UI riêng trong webview.
- Không scale toàn bộ VS Code workbench chrome.
- Không bắt buộc scale mọi icon, tooltip, badge, timestamp, toolbar metadata hardcoded `px` trong MVP.
- Không đổi cấu trúc message rendering hay ACP protocol.

## Quyết định kiến trúc

Tạo feature riêng:

```text
src/features/chat-font-size/
├── host.ts
├── webview.ts
├── types.ts
└── index.ts
```

### Message contract

Host gửi message xuống webview:

```ts
export const CHAT_FONT_SIZE_MESSAGE_TYPE = "feature.chat-font-size.settings";

export interface ChatFontSizeSettingsMessage {
  type: typeof CHAT_FONT_SIZE_MESSAGE_TYPE;
  fontSize: number | null;
}
```

- `fontSize: null`: dùng VS Code mặc định.
- `fontSize: number`: áp dụng `${fontSize}px`.

### Normalize setting

Dùng helper chung trong `types.ts` hoặc module shared của feature:

```ts
function normalizeChatFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(40, Math.max(8, Math.round(value)));
}
```

`package.json` vẫn khai báo `minimum: 0`, vì `0` là sentinel "follow VS Code".

### Host feature

`src/features/chat-font-size/host.ts` chịu trách nhiệm:

- đọc `vscode.workspace.getConfiguration("vscode-acp-chat").get<number>("fontSize", 0)`;
- normalize thành `number | null`;
- post message `feature.chat-font-size.settings` tới webview;
- đăng ký `vscode.workspace.onDidChangeConfiguration` và gửi lại khi `affectsConfiguration("vscode-acp-chat.fontSize")`;
- expose method `sendSettings()` để `ChatViewProvider` gọi khi webview ready/resolve;
- dispose listener cùng lifecycle của provider.

Lưu ý tích hợp:

- `registerHostFeatures()` hiện return sớm `{}` nếu multi-session bị tắt. Khi thêm `chatFontSize`, cần refactor nhẹ để feature này được đăng ký bất kể `multiSession.enabled`.
- Core integration trong `src/views/chat.ts` chỉ nên gọi `this.features.chatFontSize?.sendSettings()` ở các điểm lifecycle cần thiết; không đặt logic đọc config trực tiếp trong core.

### Webview feature

`src/features/chat-font-size/webview.ts` chịu trách nhiệm:

- nhận message `feature.chat-font-size.settings`;
- nếu `fontSize` là number: set CSS variable trên `document.documentElement`:

```ts
doc.documentElement.style.setProperty("--acp-chat-font-size", `${fontSize}px`);
```

- nếu `fontSize` là `null`: remove variable để fallback về `--vscode-font-size`.

Tích hợp webview tối thiểu:

- đăng ký feature trong `src/features/register-webview.ts`;
- dispatch message tới feature qua `WebviewController.handleMessage()` hoặc một message-router API nhỏ nếu muốn tái sử dụng cho feature message sau này;
- không thêm DOM UI mới.

### CSS

Thêm custom variable fallback:

```css
body {
  font-size: var(--acp-chat-font-size, var(--vscode-font-size));
}
```

Đổi prompt input dùng cùng variable:

```css
#input {
  font-size: var(--acp-chat-font-size, var(--vscode-font-size));
}
```

Ưu tiên để message content/code dùng `em` hiện có để scale theo base. Chỉ đổi các selector hardcode `px` nếu trực tiếp làm chat text hoặc prompt không scale đúng.

## Task List

### Phase 1: Configuration schema

#### Task 1: Thêm setting `vscode-acp-chat.fontSize`

**Description:** Cập nhật `package.json` trong `contributes.configuration.properties`.

**Acceptance criteria:**

- [x] Có property `vscode-acp-chat.fontSize`.
- [x] Type là `number`.
- [x] Default là `0`.
- [x] Minimum là `0`, maximum khuyến nghị là `40`.
- [x] Description nêu rõ `0` nghĩa là follow VS Code font size, giá trị dương là pixel.

**Verification:**

- [ ] Mở Settings UI thấy setting mới.
- [ ] Settings JSON chấp nhận `"vscode-acp-chat.fontSize": 16`.

**Files likely touched:**

- `package.json`

### Phase 2: Host feature

#### Task 2: Tạo contract và normalize helper

**Description:** Tạo `src/features/chat-font-size/types.ts` chứa message contract, config key, min/max và normalize helper.

**Acceptance criteria:**

- [x] Export message type `feature.chat-font-size.settings`.
- [x] Export `normalizeChatFontSize()`.
- [x] `0`, số âm, non-number trả về `null`.
- [x] Giá trị hợp lệ được round và clamp trong khoảng `8`-`40`.

**Verification:**

- [ ] Unit test helper hoặc cover qua host/webview tests.
- [ ] `npm run check-types` pass.

**Files likely touched:**

- `src/features/chat-font-size/types.ts`
- `src/test/features/chat-font-size.test.ts`

#### Task 3: Tạo host controller cho setting

**Description:** Tạo `src/features/chat-font-size/host.ts` để đọc config và gửi settings xuống webview.

**Acceptance criteria:**

- [x] Host feature không phụ thuộc multi-session.
- [x] Có method `sendSettings()`.
- [x] Đăng ký `onDidChangeConfiguration` và chỉ phản ứng khi `vscode-acp-chat.fontSize` đổi.
- [x] Dispose listener đúng cách.
- [x] Không import webview-only code.

**Verification:**

- [ ] Test mock `postMessage` nhận đúng message khi config là `0`, `16`, invalid/clamped value.
- [ ] Test config change gọi post lại.
- [ ] `npm run check-types` pass.

**Files likely touched:**

- `src/features/chat-font-size/host.ts`
- `src/test/features/chat-font-size.test.ts`

#### Task 4: Đăng ký host feature và gửi setting khi webview ready

**Description:** Kết nối host feature vào provider lifecycle.

**Acceptance criteria:**

- [x] `registerHostFeatures()` trả về `chatFontSize` cả khi `multiSession.enabled` false.
- [x] `ChatViewProvider.resolveWebviewView()` gửi font settings sau khi set HTML hoặc khi webview ready.
- [x] Case `ready` trong single-session và multi-session đều gửi font settings.
- [x] `dispose()` dispose host feature.
- [x] Không làm thay đổi flow send/connect/session.

**Verification:**

- [ ] Existing `ChatViewProvider` tests vẫn pass.
- [ ] Test `ready` post message `feature.chat-font-size.settings`.
- [ ] Manual: đổi setting khi ACP Chat đang mở thì font đổi live.

**Files likely touched:**

- `src/features/register-host.ts`
- `src/views/chat.ts`
- `src/test/chat.test.ts`

### Phase 3: Webview feature và CSS

#### Task 5: Tạo webview feature áp dụng CSS variable

**Description:** Tạo `src/features/chat-font-size/webview.ts` và đăng ký trong webview feature registry.

**Acceptance criteria:**

- [x] Feature nhận `feature.chat-font-size.settings`.
- [x] `fontSize: 16` set `--acp-chat-font-size: 16px`.
- [x] `fontSize: null` remove variable.
- [x] Invalid message không throw.
- [x] Feature có `dispose()` nếu có listener/state cần cleanup.

**Verification:**

- [ ] JSDOM test cho set/remove CSS variable.
- [ ] `npm run check-types` pass.

**Files likely touched:**

- `src/features/chat-font-size/webview.ts`
- `src/features/chat-font-size/index.ts`
- `src/features/register-webview.ts`
- `src/views/webview/main.ts` nếu cần dispatch message tới feature.
- `src/test/features/chat-font-size.test.ts` hoặc `src/test/webview.test.ts`

#### Task 6: Cập nhật CSS dùng custom font variable

**Description:** Đổi base body/input font để nhận `--acp-chat-font-size`.

**Acceptance criteria:**

- [x] `body` fallback về `var(--vscode-font-size)` khi custom setting không có.
- [x] `#input` dùng cùng custom variable.
- [x] Message content, markdown và code block scale theo base font.
- [x] Không làm vỡ layout compact controls.

**Verification:**

- [ ] Manual với `fontSize = 0`, `16`, `20`.
- [ ] Visual check transcript, prompt input, code block.

**Files likely touched:**

- `media/vscode.css`
- `media/main.css`

### Phase 4: Tests, build, package, install

#### Task 7: Automated verification

**Description:** Chạy quality gates nhỏ nhất liên quan.

**Commands:**

```bash
npm run check-types
npm test -- --grep "chat font size"
```

Nếu test runner không hỗ trợ grep ổn định trong môi trường hiện tại, chạy toàn bộ test suite:

```bash
npm test
```

**Acceptance criteria:**

- [ ] Typecheck pass.
- [ ] Tests mới pass.
- [ ] Không có regression test hiện có.

#### Task 8: Build, package, install local extension

**Description:** Vì thay đổi extension/webview code, build production bundle, tạo VSIX và install vào VS Code trước khi báo hoàn tất.

**Commands:**

```bash
npm run package
npx vsce package --out .tmp/vscode-acp-chat-font-size.vsix
code --install-extension .tmp/vscode-acp-chat-font-size.vsix --force
```

**Acceptance criteria:**

- [ ] Production bundle build pass.
- [ ] VSIX tạo thành công ở path tạm/git-ignored.
- [ ] VSIX install thành công bằng `--force`.
- [ ] Báo user chạy `Developer: Reload Window`.

## Rủi ro và giảm thiểu

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Font setting chỉ đổi transcript nhưng input không đổi | Medium | Đổi cả `body` và `#input` sang `--acp-chat-font-size`. |
| Multi-session ready nuốt message lifecycle khiến setting không gửi | Medium | Gửi setting trong provider lifecycle và trong `ready` trước/sau multi-session handling. |
| `registerHostFeatures()` return sớm làm feature không chạy khi tắt multi-session | Medium | Refactor registry để `chatFontSize` độc lập với multi-session. |
| Hardcoded `px` khiến một số metadata vẫn nhỏ | Low | MVP giới hạn vào chat content/input; sau manual check mới mở rộng selector thật sự cần. |
| Giá trị quá nhỏ/quá lớn phá layout | Low | Schema min/max và normalize clamp `8`-`40`; `0` là fallback. |
| Setting đổi nhưng webview chưa ready | Low | Gửi lại trong `ready` và trên config change; postMessage no-op nếu chưa có view. |

## Open questions

- Setting nên tên là `vscode-acp-chat.fontSize` hay `vscode-acp-chat.chatFontSize`? Khuyến nghị: `fontSize` vì namespace đã là extension, description giải thích rõ phạm vi chat webview.
- Có cần scale toàn bộ controls/metadata không? Khuyến nghị MVP chỉ scale transcript + prompt input; nếu user vẫn thấy nhỏ thì mở rộng sau cho toolbar/tool details.
- Maximum nên là `32` hay `40`? Khuyến nghị `40` để hỗ trợ accessibility, nhưng normalize vẫn bảo vệ layout.

## Completion notes

Implemented on 2026-07-14:

- Added `vscode-acp-chat.fontSize` setting with `0` fallback and `8`-`40` px normalization.
- Added host/webview feature under `src/features/chat-font-size/`.
- Registered host feature independently from multi-session and sends settings on resolve, ready, and config changes.
- Updated webview CSS variable fallback for `body` and prompt input.
- Added automated tests for normalization, host messaging/config changes, independent registration, and CSS variable application.

## Definition of Done

- User có thể cấu hình `vscode-acp-chat.fontSize` trong Settings UI/JSON.
- `0` giữ hành vi hiện tại theo VS Code font size.
- Giá trị dương đổi cỡ chữ chat transcript và prompt input live.
- Feature code nằm dưới `src/features/chat-font-size/`; core chỉ có integration nhỏ.
- Tests/typecheck/build/package/install hoàn tất hoặc blocker được báo rõ.
