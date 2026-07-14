# Implementation Plan: Full ACP Session ID Display

## Tổng quan

Hiển thị đầy đủ ACP session id trong UI multi-session thay vì dùng short id như `sessionId.slice(0, 8)`. Mục tiêu là người dùng có thể đối chiếu chính xác session đang mở với Pi/ACP session id thật, đặc biệt khi debug hoặc resume history.

## Phân tích hiện trạng

Các điểm liên quan hiện tại:

- Multi-session host lưu id ACP thật trong `ManagedSession.acpSessionId` sau `session/new` và `session/load`.
- Webview nhận `acpSessionId` qua `MultiSessionListItem` nhưng hiện chưa render id này trong metadata.
- Item trong session manager overlay render title và metadata tại `src/features/multi-session/webview.ts`.
- Metadata hiện chỉ gồm `formatStatus(session.status)` và `session.agentName`.
- New ACP session hiện bị đặt title hard-code là `"New chat"` sau khi nhận `response.sessionId`.
- History session hiện có placeholder title `History ${sessionId.slice(0, 8)}` trước khi load xong.
- Extension đã có logic cập nhật title thật từ `session_info_update.title`; Pi hiện chỉ gửi title khi user đặt tên bằng `/name`.

Root cause: UI không thiếu session id; id đã có trong state nhưng không được hiển thị, và một số fallback title còn chủ động rút gọn id.

## Quyết định UX

- Hiển thị **full ACP session id**, không dùng short id, trong metadata của session item.
- Metadata format đề xuất:

```text
<Status> · <Agent name> · <Full ACP session id>
```

Ví dụ:

```text
Idle · Pi · 019f5f61-...-full-id
```

- Khi session chưa có `acpSessionId` như draft chưa start, metadata vẫn giữ nguyên:

```text
Draft · Pi
```

- Primary title ưu tiên tên thật do agent/user cung cấp:
  1. Nếu Pi session có `name`/title thật, ví dụ user đặt bằng `/name Backend debug` hoặc title lấy từ `session/list`, UI dùng `Backend debug` làm title thay cho `New chat`/`History ...`.
  2. Nếu chưa có title thật, fallback mới dùng full id, ví dụ `Pi <full-session-id>` hoặc `History <full-session-id>`.
  3. Full session id vẫn luôn nằm trong metadata/tooltip để truy vết, kể cả khi primary title đang là tên thật.
- Với mọi fallback title dựa trên id, không rút gọn id bằng `slice(0, 8)`.
- Để tránh mất thông tin khi sidebar hẹp, set tooltip/title attribute cho metadata hoặc session item chứa full session id.

## Không nằm trong phạm vi

- Không đổi ACP protocol hoặc Pi adapter protocol.
- Không yêu cầu Pi gửi title trong `session/new`.
- Không tạo database/session persistence mới.
- Không thay đổi cách `/name` cập nhật title; nếu Pi gửi title, UI vẫn dùng title đó.
- Không thêm command copy id trong phiên đầu tiên; có thể làm follow-up nếu cần.

## Danh sách task

### Phase 1: Render full session id trong multi-session UI

#### Task 1: Cập nhật metadata builder

**Mô tả:** Sửa `buildSessionMeta()` để append full `session.acpSessionId` khi có id.

**Acceptance criteria:**

- [ ] Session đã start/load hiển thị full `acpSessionId` trong metadata.
- [ ] Draft chưa có ACP session id không hiển thị id rỗng.
- [ ] Không dùng `slice(0, 8)` hoặc rút gọn id trong metadata.
- [ ] Format status/agent hiện tại được giữ nguyên.

**Verification:**

- [ ] Unit/JSDOM test hoặc targeted webview test xác nhận metadata chứa full id.
- [ ] Manual check: session Pi mới hiển thị full id trong multi-session overlay.

**Files likely touched:**

- `src/features/multi-session/webview.ts`
- `src/test/features/multi-session.test.ts` hoặc test webview phù hợp nếu đã có harness

**Estimated scope:** Small: 1-2 files

#### Task 2: Thêm tooltip chứa full id

**Mô tả:** Gán `title` attribute cho metadata/session item để người dùng xem full id khi text bị ellipsis trong sidebar hẹp.

**Acceptance criteria:**

- [ ] Tooltip của metadata chứa đúng full `acpSessionId`.
- [ ] Tooltip không hiện `undefined` với draft session.
- [ ] Không ảnh hưởng click activate session.

**Verification:**

- [ ] Manual hover trên session item ở sidebar hẹp.
- [ ] JSDOM assertion nếu test hiện tại dễ mở rộng.

**Files likely touched:**

- `src/features/multi-session/webview.ts`

**Estimated scope:** Small: 1 file

### Phase 2: Loại bỏ short-id fallback title

#### Task 3: Dùng Pi title thật cho history, fallback bằng full id

**Mô tả:** Khi load history, tìm `SessionInfo.title` từ catalog/session list nếu có. Nếu title non-empty thì dùng title đó làm primary title; nếu không có title thật mới fallback `History <full-session-id>`.

**Acceptance criteria:**

- [ ] History session có Pi `name`/title thật hiển thị title đó, không hiển thị `New chat` hoặc `History ...`.
- [ ] History session chưa có title thật dùng fallback `History <full-session-id>`.
- [ ] Không còn truncation bằng `slice(0, 8)` cho history title.
- [ ] `session_info_update.title` vẫn override fallback nếu agent gửi title mới sau khi load.

**Verification:**

- [ ] Test `loadHistorySession()` kiểm tra title/state dùng full session id.
- [ ] Manual load history Pi và xác nhận UI không rút gọn id.

**Files likely touched:**

- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`

**Estimated scope:** Small: 2 files

#### Task 4: Dùng title thật cho Pi session mới, fallback bằng full id

**Mô tả:** Với Pi session mới, ban đầu thường chưa có `name`, nên dùng fallback `Pi <full-session-id>` thay cho `New chat`. Khi user chạy `/name <name>` và Pi gửi `session_info_update.title`, title phải đổi sang `<name>`.

**Recommended implementation:**

```ts
session.title =
  session.agent.id === "pi" ? `Pi ${response.sessionId}` : "New chat";
```

**Acceptance criteria:**

- [ ] Pi new session chưa có name dùng fallback `Pi <full-session-id>`, không dùng `New chat`.
- [ ] Full session id được dùng, không rút gọn.
- [ ] Khi user chạy `/name <name>`, `session_info_update.title` override fallback và UI hiển thị `<name>` làm title.

**Verification:**

- [ ] Test new Pi session state title.
- [ ] Manual create Pi session và chạy `/name <name>` để xác nhận title được cập nhật.

**Files likely touched:**

- `src/features/multi-session/host.ts`
- `src/test/features/multi-session.test.ts`

**Estimated scope:** Small: 2 files

### Phase 3: Documentation and feature catalog

#### Task 5: Cập nhật feature catalog

**Mô tả:** Ghi nhận behavior mới trong session history / multi-session feature docs.

**Acceptance criteria:**

- [ ] `docs/features/feature-catalog.md` mô tả multi-session/session history hiển thị full ACP session id.
- [ ] Nội dung không biến README docs thành backlog.

**Verification:**

- [ ] Đọc lại section `Concurrent multi-session chat` và `Session history and retention` để đảm bảo nhất quán.

**Files likely touched:**

- `docs/features/feature-catalog.md`

**Estimated scope:** Small: 1 file

### Phase 4: Quality gates, build, package, install

#### Task 6: Chạy kiểm tra và cài extension local

**Mô tả:** Vì thay đổi extension/webview code, cần build, package VSIX và install local trước khi báo hoàn tất.

**Acceptance criteria:**

- [ ] Typecheck pass.
- [ ] Relevant tests pass.
- [ ] Production bundle build pass.
- [ ] VSIX được tạo ở path tạm/git-ignored.
- [ ] VSIX được install vào VS Code bằng `--force`.
- [ ] User được nhắc chạy `Developer: Reload Window`.

**Verification:**

```bash
npm run check-types
npm run compile-tests
npm test -- --grep "multi-session"
npm run package
npx vsce package --out .tmp/vscode-acp-chat-full-session-id.vsix
code --install-extension .tmp/vscode-acp-chat-full-session-id.vsix --force
```

Nếu test runner không hỗ trợ `--grep`, chạy targeted test command phù hợp hoặc fallback sang `npm test`.

## Rủi ro và giảm thiểu

| Risk                                    | Impact | Mitigation                                                                       |
| --------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| Full id quá dài làm UI chật             | Medium | Giữ ellipsis CSS hiện tại và thêm tooltip chứa full id.                          |
| User nhầm title với id                  | Low    | Đặt full id trong metadata, không thay title thật do user/agent cung cấp.        |
| History vẫn hiện short id ở placeholder | Medium | Loại bỏ `slice(0, 8)` ở history fallback và thêm regression test.                |
| Non-Pi agent có id dài khác format      | Low    | Dùng `acpSessionId` nguyên bản, không parse/format theo Pi-specific assumptions. |
| `/name` không đổi title sau fallback id | Medium | Giữ nguyên flow `session_info_update.title` đang update `ManagedSession.title`.  |

## Completion notes

- Implemented full ACP session id rendering in multi-session manager metadata and tooltip.
- Removed short-id history fallback; history fallback titles now use `History <full-session-id>` and catalog titles are preferred when available.
- Pi new-session fallback titles now use `Pi <full-session-id>` until `session_info_update.title` supplies a real title.
- Updated feature catalog with the full-id display behavior.

## Definition of Done

- Full ACP session id hiển thị trong multi-session metadata khi session đã có `acpSessionId`.
- Không còn short-id fallback trong các vị trí đã xác định cho session id display.
- Title thật từ agent/user vẫn được ưu tiên.
- Tests/checks pass.
- Extension được build, package và install local theo quy định repo.
