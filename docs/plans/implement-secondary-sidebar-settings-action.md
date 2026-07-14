# Implementation Plan: Secondary Sidebar Settings Action

## Tổng quan

Thêm icon settings vào vùng title của VS Code secondary sidebar cho ACP Chat. Khi người dùng click icon này, VS Code Settings UI sẽ mở trực tiếp tới phần cấu hình của extension `vscode-acp-chat`.

Vùng cần thay đổi là VS Code workbench chrome (`menus.view/title`), không phải DOM bên trong webview iframe.

## Phân tích hiện trạng

Các điểm liên quan hiện tại:

- `docs/architecture/acp-chat-layout.md` xác định vùng `VS Code secondary sidebar title area` được render từ `package.json`, gồm `viewsContainers.secondarySidebar`, `views`, và `menus.view/title`.
- `package.json` đã khai báo các command hiển thị trên title area:
  - `vscode-acp-chat.selectAgent` — `$(robot)`
  - `vscode-acp-chat.newChat` — `$(add)`
  - `vscode-acp-chat.manageSessions` — `$(list-tree)`
  - `vscode-acp-chat.clearChat` — `$(clear-all)`
  - `vscode-acp-chat.loadHistory` — `$(history)`
- `src/extension.ts` hiện đăng ký nhiều command core trực tiếp.
- Quy ước repo yêu cầu custom/product-specific functionality mới nên nằm dưới `src/features/<feature-name>/`, core files chỉ giữ integration nhỏ.
- `src/features/register-host.ts` đã là registry cho Extension Host features.

## Quyết định kiến trúc

- Tạo command riêng `vscode-acp-chat.openSettings` thay vì dùng command built-in trực tiếp trong menu contribution. Cách này giữ quyền kiểm soát title, icon, category và hành vi filter settings.
- Command dùng icon VS Code Codicon `$(gear)` để nhất quán với workbench title actions.
- Đặt command vào `contributes.menus.view/title` với `when: "view == vscode-acp-chat.chatView"` để chỉ xuất hiện trên ACP Chat view.
- Đặt thứ tự sau `Load History` bằng `group: "navigation@5"`, trừ khi sau này cần đổi vị trí UX.
- Tạo feature nhỏ `src/features/open-settings/host.ts` và đăng ký qua `src/features/register-host.ts`.
- Handler mở VS Code Settings bằng:

```ts
vscode.commands.executeCommand(
  "workbench.action.openSettings",
  "@ext:fiyqkrc.vscode-acp-chat"
);
```

- Không thay đổi webview DOM, CSS, hoặc message protocol.

## Không nằm trong phạm vi

- Không thêm settings panel riêng trong webview.
- Không thay đổi schema configuration hiện có.
- Không đổi tên container/view title.
- Không thay đổi thứ tự các action hiện có ngoài việc thêm action mới.
- Không thêm telemetry.

## Danh sách task

### Phase 1: Command contribution

#### Task 1: Khai báo command `openSettings`

**Mô tả:** Thêm command mới vào `contributes.commands` trong `package.json`.

**Acceptance criteria:**

- [ ] Có command `vscode-acp-chat.openSettings`.
- [ ] Title là `Open ACP Settings` hoặc tên tương đương rõ nghĩa.
- [ ] Category là `ACP`.
- [ ] Icon là `$(gear)`.

**Verification:**

- [ ] `npm run check-types` không bị ảnh hưởng bởi schema package.
- [ ] Extension package build không báo lỗi contribution.

**Files likely touched:**

- `package.json`

**Estimated scope:** Small: 1 file

#### Task 2: Hiển thị command trên view title

**Mô tả:** Thêm command vào `contributes.menus.view/title` để icon xuất hiện trong ACP Chat secondary sidebar title area.

**Acceptance criteria:**

- [ ] Menu item dùng `command: "vscode-acp-chat.openSettings"`.
- [ ] Điều kiện hiển thị là `view == vscode-acp-chat.chatView`.
- [ ] Group là `navigation@5` để đứng sau `Load History`.
- [ ] Các action hiện có giữ nguyên command, `when`, và thứ tự tương đối.

**Verification:**

- [ ] Manual check: icon gear xuất hiện cạnh các icon title action hiện tại.

**Files likely touched:**

- `package.json`

**Estimated scope:** Small: 1 file

### Phase 2: Host feature handler

#### Task 3: Tạo feature `open-settings`

**Mô tả:** Tạo module Extension Host feature đăng ký command `vscode-acp-chat.openSettings`.

**Acceptance criteria:**

- [ ] File mới nằm dưới `src/features/open-settings/host.ts`.
- [ ] Feature export function đăng ký command qua `context.subscriptions.push(...)`.
- [ ] Handler gọi `workbench.action.openSettings` với filter extension `@ext:fiyqkrc.vscode-acp-chat`.
- [ ] Không import webview-only code.
- [ ] Không thêm logic đáng kể vào `src/extension.ts`.

**Verification:**

- [ ] `npm run check-types` pass.
- [ ] Manual check: click icon mở VS Code Settings UI và filter đúng extension.

**Files likely touched:**

- `src/features/open-settings/host.ts`

**Estimated scope:** Small: 1 file

#### Task 4: Đăng ký feature trong host registry

**Mô tả:** Kết nối feature mới qua `src/features/register-host.ts`.

**Acceptance criteria:**

- [ ] `registerExtensionHostFeatures()` gọi `registerOpenSettingsHostFeature({ context })`.
- [ ] `HostFeatureRegistry` có field tương ứng nếu cần giữ disposable/return value.
- [ ] Không thay đổi flow multi-session hoặc add-to-chat.

**Verification:**

- [ ] `npm run check-types` pass.

**Files likely touched:**

- `src/features/register-host.ts`

**Estimated scope:** Small: 1 file

### Phase 3: Tài liệu và xác minh

#### Task 5: Cập nhật layout architecture doc

**Mô tả:** Cập nhật mapping vùng title area trong `docs/architecture/acp-chat-layout.md` để phản ánh icon settings mới.

**Acceptance criteria:**

- [ ] Wireframe title area thêm `[gear]`.
- [ ] Legend thêm `Open ACP Settings`.
- [ ] Bảng mapping thêm command `vscode-acp-chat.openSettings`, icon `$(gear)`, ý nghĩa mở VS Code Settings.
- [ ] Không mô tả icon này như DOM webview.

**Verification:**

- [ ] Đọc lại section `VS Code chrome phía trên webview` để kiểm tra nội dung nhất quán.

**Files likely touched:**

- `docs/architecture/acp-chat-layout.md`

**Estimated scope:** Small: 1 file

#### Task 6: Chạy quality gates, build, package, install

**Mô tả:** Vì thay đổi extension contribution/host code, cần build, package VSIX và install local trước khi báo hoàn tất.

**Acceptance criteria:**

- [ ] Typecheck pass.
- [ ] Production bundle build pass.
- [ ] VSIX được tạo ở path tạm/git-ignored.
- [ ] VSIX được install vào VS Code bằng `--force`.
- [ ] User được nhắc chạy `Developer: Reload Window`.

**Verification:**

```bash
npm run check-types
npm run package
npx vsce package --out .tmp/vscode-acp-chat-open-settings.vsix
code --install-extension .tmp/vscode-acp-chat-open-settings.vsix --force
```

**Dependencies:** Tasks 1-5

**Files likely touched:** None, trừ khi cần thêm `.tmp/` vào `.gitignore`.

**Estimated scope:** Small: commands only

## Rủi ro và giảm thiểu

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Icon không xuất hiện đúng vùng title | Medium | Dùng đúng contribution point `menus.view/title` và `when: view == vscode-acp-chat.chatView`. |
| Command mở Settings tổng quát thay vì settings của extension | Low | Truyền filter `@ext:fiyqkrc.vscode-acp-chat` cho `workbench.action.openSettings`. |
| Thứ tự icon gây rối UX | Low | Dùng `navigation@5` để nối sau action hiện có; có thể đổi group nếu cần. |
| Logic custom bị đặt trong core file | Low | Tách handler vào `src/features/open-settings/host.ts`, core chỉ đăng ký qua registry. |
| VS Code version cũ xử lý filter settings khác nhau | Low | Nếu filter extension không hoạt động, fallback vẫn mở Settings UI; manual verification sau install. |

## Open questions

- Vị trí cuối dãy action (`navigation@5`) có đúng mong muốn không? Khuyến nghị: đặt cuối vì settings là action ít dùng hơn chat/session actions.
- Nên filter theo extension id `@ext:fiyqkrc.vscode-acp-chat` hay query `@id:vscode-acp-chat`/`vscode-acp-chat`? Khuyến nghị: dùng `@ext:fiyqkrc.vscode-acp-chat` để mở đúng extension settings.

## Definition of Done

- Icon gear xuất hiện trong ACP Chat secondary sidebar title area.
- Click icon mở VS Code Settings UI tới cấu hình extension ACP Chat.
- Không có thay đổi webview DOM/protocol không cần thiết.
- `package.json`, host feature registry, feature handler, và architecture doc được cập nhật.
- Quality gates, package build, VSIX install local hoàn tất hoặc blocker được báo rõ.
