# Implementation Plan: Add Selection/File/Folder to Chat

## Overview

Mục tiêu là bổ sung luồng **Add Selection to Chat**, **Add File to Chat**, và **Add Folder to Chat** để người dùng đưa ngữ cảnh từ editor hoặc Explorer vào ô nhập chat dưới dạng mention chip, không tự động gửi message. Tính năng nên tái sử dụng pipeline `addMention` hiện có của webview và đặt logic mới trong `src/features/add-to-chat/`, chỉ giữ tích hợp tối thiểu ở core files.

## Current Extension Analysis

- `package.json` hiện đã có command `vscode-acp-chat.sendSelectionToChat` và `vscode-acp-chat.sendTerminalSelectionToChat` với title `Send to ACP`; menu hiện chỉ nằm ở `editor/context` và `terminal/context`, chưa có `explorer/context` cho file/folder.
- `src/extension.ts` hiện đăng ký trực tiếp command selection/terminal, đọc editor selection hoặc terminal selection rồi gọi `chatProvider.addSelection(...)`.
- `src/views/chat.ts` có `ChatViewProvider.addSelection(...)`; legacy mode gửi `{ type: "addMention", mention }`, multi-session mode gọi `features.multiSession.addSelection(...)`.
- `src/features/multi-session/host.ts` cũng có `addSelection(...)` nhưng type hiện chỉ cho `selection | terminal`; cần mở rộng để nhận `file | folder`.
- `src/views/webview/component/input-panel.ts` đã self-register message `addMention` và insert mention chip vào composer.
- `src/views/webview/component/autocomplete.ts` đã tạo file/folder mention từ `@` autocomplete thông qua `searchFiles` / `fileSearchResults`.
- `src/views/webview/component/chip-renderer.ts` đã render chip cho `file`, `folder`, `selection`, `terminal`, và click chip sẽ gửi `openFile`.
- `src/utils/mention-serializer.ts` đã biết `file | folder | selection | terminal | image`; file/folder hiện được serialize dạng path reference, không nhúng nội dung file/folder.

Kết luận: webview đã hỗ trợ file/folder mention. Phần còn thiếu chủ yếu là host-side command/menu cho Explorer và tổ chức lại command selection hiện có vào feature module.

## Architecture Decisions

- Tạo host-only feature tại `src/features/add-to-chat/`; không cần `webview.ts` vì `addMention` và chip rendering đã có.
- Dùng lại mention contract hiện có (`Mention` trong `src/utils/mention-serializer.ts` hoặc type tương đương) thay vì tạo UI contract mới.
- Giữ behavior là **add context chip vào composer**, không auto-send message.
- Với file/folder: MVP chỉ gửi path reference giống `@` autocomplete; không đọc toàn bộ nội dung để tránh token explosion, chậm UI, và lỗi với file lớn/binary.
- Giữ backward compatibility cho command id hiện có `vscode-acp-chat.sendSelectionToChat` / `sendTerminalSelectionToChat`; chỉ đổi title/menu label sang “Add … to Chat”.
- Explorer commands hỗ trợ cả single-select và multi-select thông qua `(uri, selectedUris)` của VS Code command handler.
- Core integration chỉ gồm: gọi registry trong `extension.ts`, mở rộng registry/type ở `register-host.ts`, và mở rộng `ChatViewProvider` mention API nếu cần.

## Task List

### Phase 1: Normalize mention insertion API

#### Task 1: Mở rộng type và API add mention

**Description:** Chuẩn hóa đường đi host → chat provider → webview để nhận mọi mention type (`selection`, `terminal`, `file`, `folder`, `image` nếu cần), không chỉ selection/terminal.

**Acceptance criteria:**

- [ ] `ChatViewProvider` có public API rõ ràng để thêm mention, ví dụ `addMention(mention: Mention)`; `addSelection(...)` vẫn được giữ làm alias/backward-compatible nếu tests hoặc command cũ đang dùng.
- [ ] `MultiSessionHostController.addSelection(...)` hoặc API tương đương nhận được `file | folder` mention mà không ép `content` bắt buộc.
- [ ] Không thay đổi webview message shape: vẫn dùng `{ type: "addMention", mention }`.

**Verification:**

- [ ] Typecheck pass: `npm run check-types`.
- [ ] Existing mention tests vẫn pass: `npm test -- --grep "Mention"` nếu test runner hỗ trợ grep; nếu không, chạy full relevant test suite theo repo convention.

**Dependencies:** None

**Files likely touched:**

- `src/views/chat.ts`
- `src/features/multi-session/host.ts`
- `src/utils/mention-serializer.ts` nếu cần export/reuse type rõ hơn

**Estimated scope:** Small: 2-3 files

### Phase 2: Host feature implementation

#### Task 2: Tạo `add-to-chat` host feature

**Description:** Thêm `src/features/add-to-chat/host.ts` chứa toàn bộ logic tạo mention từ editor selection, terminal selection, file URI, folder URI, command palette fallback, multi-select handling, focus chat view, và user feedback khi không có selection/resource hợp lệ.

**Acceptance criteria:**

- [ ] Feature đăng ký hoặc expose handlers cho `vscode-acp-chat.sendSelectionToChat`, `vscode-acp-chat.sendTerminalSelectionToChat`, `vscode-acp-chat.addFileToChat`, `vscode-acp-chat.addFolderToChat`.
- [ ] Editor selection tạo mention `{ type: "selection", name, path, content, range }` với line range 1-based như hiện tại.
- [ ] Terminal selection giữ behavior hiện tại: ưu tiên args từ terminal context, fallback copy selection + clipboard.
- [ ] File command tạo mention `{ type: "file", name, path }` từ Explorer URI hoặc file picker fallback.
- [ ] Folder command tạo mention `{ type: "folder", name, path }` từ Explorer URI hoặc folder picker fallback.
- [ ] Multi-select thêm nhiều mention chips, filter đúng file/folder theo command, và cảnh báo ngắn nếu không có resource hợp lệ.
- [ ] Sau khi add mention, chat view được focus bằng `vscode-acp-chat.chatView.focus`.

**Verification:**

- [ ] Unit tests mới ở `src/test/features/add-to-chat.test.ts` cover mention factory/handler behavior.
- [ ] Manual check trong Extension Development Host: right-click editor selection/file/folder đều insert chip vào composer, không auto-send.

**Dependencies:** Task 1

**Files likely touched:**

- `src/features/add-to-chat/host.ts`
- `src/features/add-to-chat/index.ts`
- `src/features/add-to-chat/types.ts` nếu cần feature-specific options/contracts
- `src/test/features/add-to-chat.test.ts`

**Estimated scope:** Medium: 3-5 files

### Phase 3: Registry and contribution integration

#### Task 3: Tích hợp feature registry và command/menu contributions

**Description:** Đưa registration vào feature registry theo rule của repo, sau đó cập nhật manifest để expose menu labels đúng.

**Acceptance criteria:**

- [ ] `src/features/register-host.ts` là nơi đăng ký host feature mới hoặc export một registry function dành cho VS Code command features.
- [ ] `src/extension.ts` chỉ còn integration tối thiểu: gọi registry với `context` và accessor/callback tới `chatProvider`; bỏ logic command dài khỏi core file.
- [ ] `package.json` đổi label editor context từ `Send to ACP` sang `Add Selection to Chat`.
- [ ] `package.json` thêm commands:
  - `vscode-acp-chat.addFileToChat` — title `Add File to Chat`
  - `vscode-acp-chat.addFolderToChat` — title `Add Folder to Chat`
- [ ] `package.json` thêm `explorer/context` menu:
  - file: `explorerResourceIsFolder == false`
  - folder: `explorerResourceIsFolder == true`
- [ ] Command palette fallback hoạt động: nếu gọi file/folder command không có URI từ Explorer thì mở `showOpenDialog` tương ứng.

**Verification:**

- [ ] `npm run check-types`.
- [ ] Manual check command palette và Explorer context menu.

**Dependencies:** Task 2

**Files likely touched:**

- `src/features/register-host.ts`
- `src/extension.ts`
- `package.json`

**Estimated scope:** Small: 2-3 files

### Phase 4: Tests and regression coverage

#### Task 4: Bổ sung test coverage cho Add to Chat

**Description:** Thêm tests focused cho feature module và regression cho mention serialization/path-only behavior.

**Acceptance criteria:**

- [ ] Test editor selection mention giữ `content` và `range` đúng.
- [ ] Test file/folder resource mention không nhúng `content` mặc định.
- [ ] Test multi-select tạo nhiều mentions đúng thứ tự input.
- [ ] Test invalid/missing resource không gọi add mention và có feedback phù hợp.
- [ ] Nếu đổi public API `addMention`, test legacy `addSelection` alias vẫn hoạt động.

**Verification:**

- [ ] `npm run check-types`.
- [ ] `npm test` hoặc test subset nhỏ nhất có liên quan nếu full VS Code test quá chậm.

**Dependencies:** Task 3

**Files likely touched:**

- `src/test/features/add-to-chat.test.ts`
- `src/test/chat.test.ts` nếu cần cover alias/regression
- `src/test/mention_serializer.test.ts` nếu thay đổi serializer

**Estimated scope:** Medium: 2-4 files

### Phase 5: Package and install locally

#### Task 5: Build, package, install extension

**Description:** Theo rule repo, sau khi thay đổi extension/webview code phải build production bundle, tạo VSIX, cài vào VS Code, rồi báo user reload window.

**Acceptance criteria:**

- [ ] Typecheck/build production thành công.
- [ ] VSIX được tạo ở path tạm hoặc versioned path không commit.
- [ ] VSIX được install bằng `code --install-extension <path>.vsix --force`.
- [ ] File VSIX tạm được xóa nếu nằm ngoài gitignored path.
- [ ] User được nhắc chạy `Developer: Reload Window`.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm test` hoặc relevant subset
- [ ] `npm run package`
- [ ] `npx vsce package --out <temporary-or-versioned-path>.vsix`
- [ ] `code --install-extension <path>.vsix --force`

**Dependencies:** Task 4

**Files likely touched:** None beyond generated VSIX outside tracked files

**Estimated scope:** Small

## Checkpoints

### Checkpoint: Foundation after Tasks 1-2

- [ ] Typecheck pass.
- [ ] Existing editor/terminal selection behavior vẫn insert mention chip như trước.
- [ ] New file/folder mention factories tạo đúng object shape.

### Checkpoint: Integration after Task 3

- [ ] Explorer context menu hiển thị đúng cho file/folder.
- [ ] Command palette fallback chọn được file/folder.
- [ ] Multi-session mode và legacy mode đều nhận `addMention`.

### Checkpoint: Complete after Tasks 4-5

- [ ] Tests relevant pass.
- [ ] Production package build pass.
- [ ] VSIX installed locally.
- [ ] Manual smoke test: editor selection, file, folder đều add chip vào composer; click chip mở file/reveal folder.

## Risks and Mitigations

| Risk                                                              | Impact | Mitigation                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command title cũ “Send to ACP” gây hiểu nhầm là auto-send         | Medium | Đổi label sang “Add … to Chat”, giữ command id cũ để không phá keybindings/scripts.                                                                                                 |
| File/folder content quá lớn nếu nhúng vào prompt                  | High   | MVP chỉ path reference như `@` autocomplete; nếu cần content snapshot thì làm phase riêng với size limit, ignore binary, confirmation UI.                                           |
| Multi-session type hiện chỉ nhận selection/terminal               | Medium | Mở rộng mention type ở Task 1 trước khi thêm Explorer commands.                                                                                                                     |
| Explorer multi-select có mixed file/folder                        | Medium | Handler filter theo command hoặc tạo generic resource handler có stat từng URI; show warning nếu selection không phù hợp.                                                           |
| Virtual/remote workspace URI không phải `file`                    | Medium | Dùng `vscode.workspace.fs.stat` và `uri.fsPath` chỉ khi scheme hỗ trợ; với non-file scheme fallback dùng `uri.toString()` hoặc báo unsupported tùy khả năng hiện có của `openFile`. |
| Core file bị phình to nếu thêm logic trực tiếp vào `extension.ts` | Medium | Đưa logic vào `src/features/add-to-chat/host.ts`; `extension.ts` chỉ gọi registry.                                                                                                  |

## Open Questions

- File/folder mention nên chỉ là path reference như hiện tại hay phải nhúng snapshot nội dung? Khuyến nghị: path reference cho MVP, snapshot làm feature sau nếu thật sự cần.
- Có cần đổi command id sang `addSelectionToChat` không? Khuyến nghị: không đổi command id hiện có để giữ backward compatibility; chỉ đổi title/menu label.
- Có cần “Add Terminal Selection to Chat” nằm trong scope này không? Khuyến nghị: giữ command hiện có và chỉ đổi label cho nhất quán, không mở rộng thêm.

## Suggested Implementation Order

1. Task 1 — mở rộng mention API để giảm rủi ro type/multi-session.
2. Task 2 — tạo feature host và command handlers.
3. Task 3 — cập nhật registry + `package.json` menus.
4. Task 4 — tests và regression.
5. Task 5 — build/package/install theo repo rule.
