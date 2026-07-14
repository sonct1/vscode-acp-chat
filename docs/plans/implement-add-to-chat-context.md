# Implementation Plan: Add Selection/File/Folder to Chat

## Status

Completed on 2026-07-14.

Scope implemented:

- Add editor selections, terminal selections, files, and folders to the chat composer as mention chips.
- Keep command behavior as **add context to composer**, not auto-send.
- Support Explorer file/folder context menu and multi-select.
- Support `ACP: Add File to Chat` from the active editor title and editor title context menu.
- Keep file/folder mentions as path references only; do not snapshot file/folder contents.

## Overview

Mục tiêu là bổ sung luồng **Add Selection to Chat**, **Add File to Chat**, và **Add Folder to Chat** để người dùng đưa ngữ cảnh từ editor hoặc Explorer vào ô nhập chat dưới dạng mention chip. Tính năng tái sử dụng pipeline `addMention` hiện có của webview và đặt logic command-side trong `src/features/add-to-chat/`, chỉ giữ tích hợp tối thiểu ở core files.

## Current Implementation

- `src/features/add-to-chat/host.ts` chứa host-only feature cho selection, terminal selection, file, folder, multi-select, active editor fallback, file/folder picker fallback, focus chat, và feedback khi không có resource hợp lệ.
- `src/features/register-host.ts` đăng ký feature qua `registerExtensionHostFeatures(...)`.
- `src/extension.ts` chỉ gọi registry với `context` và accessor tới `chatProvider`.
- `src/views/chat.ts` expose `addMention(mention: Mention)` và giữ `addSelection(...)` alias backward-compatible.
- `src/features/multi-session/host.ts` nhận generic `Mention` qua `addMention(...)` và vẫn giữ `addSelection(...)` alias.
- `src/views/webview/component/input-panel.ts` xử lý message `{ type: "addMention", mention }` để insert chip vào composer.
- `src/views/webview/component/chip-renderer.ts` đã render chip cho `file`, `folder`, `selection`, `terminal`, và click chip gửi `openFile`.
- `src/utils/mention-serializer.ts` serialize `file | folder | selection | terminal | image`; file/folder serialize dạng path reference.
- `package.json` expose:
  - `vscode-acp-chat.sendSelectionToChat` — `ACP: Add Selection to Chat`.
  - `vscode-acp-chat.sendTerminalSelectionToChat` — `ACP: Add Terminal Selection to Chat`.
  - `vscode-acp-chat.addFileToChat` — `ACP: Add File to Chat`.
  - `vscode-acp-chat.addFolderToChat` — `ACP: Add Folder to Chat`.
- Menu contributions hiện có:
  - `editor/context`: add selection khi `editorHasSelection`.
  - `terminal/context`: add terminal selection khi `terminalTextSelected`.
  - `explorer/context`: add file/folder theo `explorerResourceIsFolder`.
  - `editor/title`: add active file to chat khi `resourceScheme == file`.
  - `editor/title/context`: add active file to chat khi `resourceScheme == file`.

## Architecture Decisions

- Host feature nằm trong `src/features/add-to-chat/`; không cần `webview.ts` vì webview đã có `addMention` và chip rendering.
- Dùng lại `Mention` từ `src/utils/mention-serializer.ts` thay vì tạo message contract mới.
- Không đổi webview message shape: vẫn dùng `{ type: "addMention", mention }`.
- File/folder MVP chỉ gửi path reference giống `@` autocomplete; không đọc toàn bộ nội dung để tránh token explosion, binary/large-file issues, và UI latency.
- Giữ backward compatibility cho command id hiện có `vscode-acp-chat.sendSelectionToChat` / `vscode-acp-chat.sendTerminalSelectionToChat`.
- `vscode-acp-chat.addFileToChat` fallback order:
  1. URI/multi-select từ VS Code menu context.
  2. Active editor document URI nếu là local `file` scheme.
  3. File picker nếu không có file context.
- `vscode-acp-chat.addFolderToChat` fallback order:
  1. URI/multi-select từ Explorer context.
  2. Folder picker nếu không có folder context.

## Task List

### Phase 1: Normalize mention insertion API

#### Task 1: Mở rộng type và API add mention

**Status:** Done.

**Acceptance criteria:**

- [x] `ChatViewProvider` có public API `addMention(mention: Mention)`.
- [x] `addSelection(...)` được giữ làm alias/backward-compatible.
- [x] Multi-session host nhận generic `Mention` qua `addMention(...)`.
- [x] Không thay đổi webview message shape: vẫn dùng `{ type: "addMention", mention }`.

**Verification:**

- [x] `npm run check-types` pass.
- [x] `npm test -- --grep "add-to-chat feature"` pass.

**Files touched:**

- `src/views/chat.ts`
- `src/features/multi-session/host.ts`

### Phase 2: Host feature implementation

#### Task 2: Tạo `add-to-chat` host feature

**Status:** Done.

**Acceptance criteria:**

- [x] Feature đăng ký handlers cho `vscode-acp-chat.sendSelectionToChat`, `vscode-acp-chat.sendTerminalSelectionToChat`, `vscode-acp-chat.addFileToChat`, `vscode-acp-chat.addFolderToChat`.
- [x] Editor selection tạo mention `{ type: "selection", name, path, content, range }` với line range 1-based.
- [x] Terminal selection giữ behavior: ưu tiên args từ terminal context, fallback copy selection + clipboard sentinel.
- [x] File command tạo mention `{ type: "file", name, path }` từ Explorer URI, active editor fallback, hoặc file picker fallback.
- [x] Folder command tạo mention `{ type: "folder", name, path }` từ Explorer URI hoặc folder picker fallback.
- [x] Multi-select thêm nhiều mention chips, filter đúng file/folder theo command, và cảnh báo ngắn nếu không có resource hợp lệ.
- [x] Sau khi add mention, chat view được focus bằng `vscode-acp-chat.chatView.focus`.

**Verification:**

- [x] Unit tests ở `src/test/features/add-to-chat.test.ts` cover mention factory/handler behavior.
- [x] `npm test -- --grep "add-to-chat feature"` pass.
- [ ] Manual check trong Extension Development Host: right-click editor selection/file/folder và editor title action insert chip vào composer, không auto-send.

**Files touched:**

- `src/features/add-to-chat/host.ts`
- `src/features/add-to-chat/index.ts`
- `src/test/features/add-to-chat.test.ts`

### Phase 3: Registry and contribution integration

#### Task 3: Tích hợp feature registry và command/menu contributions

**Status:** Done.

**Acceptance criteria:**

- [x] `src/features/register-host.ts` đăng ký host feature.
- [x] `src/extension.ts` chỉ còn integration tối thiểu: gọi registry với `context` và accessor tới `chatProvider`.
- [x] `package.json` label editor context là `ACP: Add Selection to Chat`.
- [x] `package.json` có commands:
  - `vscode-acp-chat.addFileToChat` — title `ACP: Add File to Chat`.
  - `vscode-acp-chat.addFolderToChat` — title `ACP: Add Folder to Chat`.
- [x] `package.json` có `explorer/context` menu:
  - file: `explorerResourceIsFolder == false`.
  - folder: `explorerResourceIsFolder == true`.
- [x] `package.json` có `editor/title` và `editor/title/context` menu cho `ACP: Add File to Chat` khi `resourceScheme == file`.
- [x] Command palette fallback hoạt động: file command dùng active editor nếu có, nếu không thì mở picker; folder command mở picker nếu không có Explorer URI.

**Verification:**

- [x] `npm run check-types` pass.
- [x] `npm test -- --grep "add-to-chat feature"` pass.
- [ ] Manual check command palette, Explorer context menu, editor title menu.

**Files touched:**

- `src/features/register-host.ts`
- `src/extension.ts`
- `package.json`

### Phase 4: Tests and regression coverage

#### Task 4: Bổ sung test coverage cho Add to Chat

**Status:** Done.

**Acceptance criteria:**

- [x] Test editor selection mention giữ `content` và `range` đúng.
- [x] Test file/folder resource mention không nhúng `content` mặc định.
- [x] Test multi-select tạo nhiều mentions đúng thứ tự input.
- [x] Test invalid/missing resource không gọi add mention và có feedback phù hợp.
- [x] Test file command dùng active editor fallback khi không có Explorer URI.
- [x] Test explicit URI được ưu tiên hơn active editor fallback.
- [x] Test không có active file context thì file picker fallback vẫn hoạt động.

**Verification:**

- [x] `npm run check-types` pass.
- [x] `npm test -- --grep "add-to-chat feature"` pass.

**Files touched:**

- `src/test/features/add-to-chat.test.ts`

### Phase 5: Package and install locally

#### Task 5: Build, package, install extension

**Status:** Done.

**Acceptance criteria:**

- [x] Typecheck/build production thành công.
- [x] VSIX được tạo ở path tạm hoặc versioned path không commit.
- [x] VSIX được install bằng `code --install-extension <path>.vsix --force`.
- [x] File VSIX tạm được xóa nếu nằm ngoài gitignored path.
- [x] User được nhắc chạy `Developer: Reload Window`.

**Verification:**

- [x] `npm run check-types`
- [x] `npm test -- --grep "add-to-chat feature"`
- [x] `npm run package`
- [x] `npx vsce package --out /tmp/vscode-acp-chat-add-file-title.vsix`
- [x] `code --install-extension /tmp/vscode-acp-chat-add-file-title.vsix --force`

## Checkpoints

### Checkpoint: Foundation after Tasks 1-2

- [x] Typecheck pass.
- [x] Existing editor/terminal selection behavior still inserts mention chips.
- [x] New file/folder mention factories create the expected object shape.

### Checkpoint: Integration after Task 3

- [x] Explorer context menu declared for file/folder.
- [x] Editor title/title-context menu declared for active file.
- [x] Command palette fallback supports active editor file and picker fallback.
- [x] Multi-session mode and legacy mode both receive `addMention`.

### Checkpoint: Complete after Tasks 4-5

- [x] Relevant tests pass.
- [x] Production package build pass.
- [x] VSIX installed locally.
- [ ] Manual smoke test: editor selection, editor title file, Explorer file, and Explorer folder all add chip into composer; click chip opens file/reveals folder.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Command title cũ “Send to ACP” gây hiểu nhầm là auto-send | Medium | Đổi label sang “Add … to Chat”, giữ command id cũ để không phá keybindings/scripts. |
| File/folder content quá lớn nếu nhúng vào prompt | High | MVP chỉ path reference như `@` autocomplete; nếu cần content snapshot thì làm phase riêng với size limit, ignore binary, confirmation UI. |
| Explorer multi-select có mixed file/folder | Medium | Handler filter theo command và show warning nếu không còn resource phù hợp. |
| Virtual/remote workspace URI không phải `file` | Medium | Mention path dùng `uri.toString()` cho non-file URI; editor title action chỉ hiện/fallback local `file` scheme theo manifest. |
| Core file bị phình to nếu thêm logic trực tiếp vào `extension.ts` | Medium | Logic nằm trong `src/features/add-to-chat/host.ts`; `extension.ts` chỉ gọi registry. |

## Decisions Closed

- File/folder mention chỉ là path reference cho MVP; không nhúng snapshot nội dung.
- Không đổi command id `vscode-acp-chat.sendSelectionToChat` để giữ backward compatibility.
- Giữ `vscode-acp-chat.sendTerminalSelectionToChat` trong scope và label nhất quán.
- `ACP: Add File to Chat` trên editor title dùng file đang mở nếu command không nhận URI context.

## Verification Log

- `npm run check-types` → pass.
- `npm test -- --grep "add-to-chat feature"` → pass, 12 tests.
- `npm run package` → pass.
- `npx vsce package --out /tmp/vscode-acp-chat-add-file-title.vsix` → pass; VSIX created at `/tmp/vscode-acp-chat-add-file-title.vsix`.
- `code --install-extension /tmp/vscode-acp-chat-add-file-title.vsix --force` → pass; extension installed successfully.
- `rm /tmp/vscode-acp-chat-add-file-title.vsix` → pass; temporary VSIX removed.
