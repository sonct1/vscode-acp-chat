# Kế hoạch triển khai: Session Manager trong Activity Bar với hành vi mở/đóng đồng bộ

| Thuộc tính | Giá trị                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented                                                                                                                                                            |
| Owner      | TBD                                                                                                                                                                    |
| Scope      | VS Code Activity Bar/Primary Sidebar contribution, Session Manager webview lifecycle, command toggle, responsive manager UI, tests và tài liệu                         |
| Related    | [`implement-split-session-manager-panel.md`](./implement-split-session-manager-panel.md), [`docs/architecture/acp-chat-layout.md`](../architecture/acp-chat-layout.md) |

## Mục tiêu

Chuyển điểm truy cập **ACP Sessions** sang đúng mô hình VS Code Activity Bar/Primary Sidebar:

- Có icon Session Manager ở thanh icon dọc bên trái của VS Code.
- Click icon Activity Bar mở Session Manager trong Primary Sidebar; click lại icon đang active dùng hành vi đóng/ẩn sidebar native của VS Code.
- Icon **Manage Chat Sessions** (`vscode-acp-chat.manageSessions`, `$(list-tree)`) trong title bar của ACP Chat phải dùng cùng một hành vi toggle:
  - manager đang đóng/ẩn: mở và focus manager;
  - manager đang mở/visible: đóng/ẩn Primary Sidebar.
- Hai điểm truy cập dùng chung một manager view và một `MultiSessionHostController`; không tạo hai manager độc lập.
- Đóng manager chỉ đóng UI, không stop, close hoặc dispose các ACP session đang chạy.

Trong tài liệu này, “icon ở side bar left” được hiểu là **Activity Bar icon mở một View Container trong Primary Sidebar**, không phải nút DOM nằm trong chat webview.

## Hiện trạng

Session Manager hiện đã được tách khỏi chat webview theo `implement-split-session-manager-panel.md`:

- `package.json` đóng góp ACP Chat vào `viewsContainers.secondarySidebar`.
- `vscode-acp-chat.manageSessions` xuất hiện trong `menus.view/title` của `vscode-acp-chat.chatView`.
- `src/extension.ts` route command tới `ChatViewProvider.manageSessions()`.
- `ChatViewProvider` sở hữu một `MultiSessionManagerPanelController`.
- `MultiSessionManagerPanelController.open()` tạo/reveal một editor `WebviewPanel` có view type `vscode-acp-chat.sessions`.
- Manager browser UI đã tách riêng trong:
  - `src/features/multi-session/manager-webview.ts`;
  - `src/features/multi-session/manager-styles.ts`;
  - bundle `dist/session-manager-webview.js`.
- Host state, action messages và manager summary đã nằm trong `MultiSessionHostController`; không cần tạo protocol session mới cho yêu cầu này.

Khoảng trống hiện tại:

1. VS Code không hỗ trợ một Activity Bar icon chỉ để chạy command tùy ý. Activity Bar icon phải đại diện cho một View Container có ít nhất một View.
2. Manager đang là editor `WebviewPanel`, nên không thể gắn trực tiếp panel hiện tại vào Activity Bar.
3. `vscode-acp-chat.manageSessions` hiện chỉ `open()/reveal()`, chưa toggle đóng.
4. Manager UI hiện được thiết kế chủ yếu cho editor width; cần kiểm tra và tối ưu ở Primary Sidebar width hẹp.

## UX đích

```text
VS Code Activity Bar          Primary Sidebar                 Secondary Sidebar
┌──────────┐                  ┌──────────────────────────┐    ┌──────────────────────┐
│ Explorer │                  │ ACP Sessions             │    │ ACP CHAT             │
│ Search   │                  ├──────────────────────────┤    │ ... [Manage Sessions]│
│ Source   │                  │ Running · Waiting · Open │    │                      │
│ ...      │                  │ [filter]                 │    │ active chat          │
│ Sessions│ ── click ───────▶ │ [search]                 │    │ transcript/input     │
└──────────┘                  │ session rows             │    └──────────────────────┘
                              └──────────────────────────┘
```

### Hành vi toggle

| Trạng thái hiện tại                                 | Click Activity Bar Sessions                             | Click Manage Chat Sessions                    |
| --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| Primary Sidebar đang ẩn                             | Mở container và focus manager view                      | Mở container và focus manager view            |
| Primary Sidebar đang hiển thị container khác        | Chuyển sang container ACP Sessions                      | Chuyển sang container ACP Sessions            |
| ACP Sessions đang visible                           | Dùng hành vi native của Activity Bar để ẩn/đóng sidebar | Gọi toggle command để ẩn/đóng Primary Sidebar |
| Manager webview chưa resolve hoặc vừa bị deallocate | Resolve lại view, gửi `managerReady`, nhận full state   | Tương tự                                      |
| Có ACP sessions đang chạy                           | Chỉ thay đổi UI visibility                              | Chỉ thay đổi UI visibility                    |

## Quyết định kiến trúc

### 1. Dùng `WebviewView`, không tạo Activity Bar launcher giả

Thêm View Container mới trong `contributes.viewsContainers.activitybar` và một webview view bên trong container đó:

```jsonc
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "vscode-acp-chat-session-manager",
          "title": "ACP Sessions",
          "icon": "assets/session-manager.svg",
        },
      ],
    },
    "views": {
      "vscode-acp-chat-session-manager": [
        {
          "type": "webview",
          "id": "vscode-acp-chat.sessionManagerView",
          "name": "Sessions",
          "contextualTitle": "ACP Sessions",
          "when": "config.vscode-acp-chat.multiSession.enabled",
        },
      ],
    },
  },
}
```

Lý do:

- Đây là contribution model chính thức của VS Code cho icon Activity Bar.
- Manager thực sự nằm trong sidebar thay vì click icon rồi mở một editor panel ở khu vực khác.
- View có generated focus command `vscode-acp-chat.sessionManagerView.focus`, phù hợp để mở/reveal từ `Manage Chat Sessions`.
- Không tạo launcher view rỗng, không mở thêm một manager panel thứ hai.

### 2. Thay panel controller bằng manager view provider

Thay `MultiSessionManagerPanelController` bằng `MultiSessionManagerViewProvider` trong feature `multi-session`:

```ts
export class MultiSessionManagerViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewType = "vscode-acp-chat.sessionManagerView";

  resolveWebviewView(view: vscode.WebviewView): void;
  toggle(): Promise<void>;
  reveal(): Promise<void>;
  dispose(): void;
}
```

Provider mới chịu trách nhiệm:

- lưu reference tới `vscode.WebviewView` hiện tại;
- cấu hình `webview.options`, CSP, Codicons và `session-manager-webview.js`;
- route manager actions về cùng `MultiSessionHostController`;
- subscribe manager state và chỉ post khi view visible;
- gửi full manager state khi nhận `managerReady`, `managerResync`, hoặc khi view visible trở lại;
- dispose listener/subscription đúng lifecycle;
- không dispose `MultiSessionHostController` khi sidebar bị đóng.

### 3. Giữ nguyên manager browser bundle và host protocol

Tái sử dụng:

- `manager-webview.ts`;
- `manager-styles.ts`;
- `dist/session-manager-webview.js`;
- `feature.multi-session.managerReady`;
- `feature.multi-session.managerResync`;
- `feature.multi-session.managerState`;
- các action `new`, `activate`, `reviewPermission`, `stop`, `close`.

Không copy DOM manager vào `ChatViewProvider`, `extension.ts` hoặc chat webview.

### 4. Một hàm toggle dùng cho icon Manage Chat Sessions

`MultiSessionManagerViewProvider.toggle()` là entry point chung cho command toolbar:

```ts
async toggle(): Promise<void> {
  if (this.view?.visible) {
    await vscode.commands.executeCommand(
      "workbench.action.toggleSidebarVisibility"
    );
    return;
  }

  await vscode.commands.executeCommand(
    `${MultiSessionManagerViewProvider.viewType}.focus`
  );
}
```

Quy tắc:

- Không dùng `WebviewPanel.dispose()` để mô phỏng đóng.
- Nếu manager chưa visible, luôn dùng generated view focus command để mở đúng container.
- Nếu manager đang visible ở vị trí mặc định, đóng Primary Sidebar bằng workbench command.
- Activity Bar icon dùng hành vi native của VS Code; không thể gắn custom click handler trực tiếp vào icon container.

### 5. Giữ integration trong core ở mức tối thiểu

- `src/features/multi-session/manager-view.ts` chứa toàn bộ lifecycle và toggle logic.
- `ChatViewProvider` tiếp tục sở hữu cùng multi-session host controller và manager UI adapter, nhưng chỉ expose provider để `extension.ts` đăng ký.
- `src/extension.ts` chỉ:
  - đăng ký `registerWebviewViewProvider()` cho manager view;
  - route `vscode-acp-chat.manageSessions` tới `toggle()` thông qua `ChatViewProvider`.
- Không đưa manager implementation vào `src/extension.ts` hoặc switch message lớn trong `src/views/chat.ts`.

## Cấu trúc file dự kiến

```text
assets/
└── session-manager.svg                         # icon monochrome cho Activity Bar

src/features/multi-session/
├── host.ts                                     # giữ nguyên source of truth
├── contracts.ts                                # dự kiến không đổi protocol
├── manager-view.ts                             # WebviewViewProvider + toggle lifecycle mới
├── manager-webview.ts                          # tái sử dụng, chỉnh UI hẹp nếu cần
├── manager-styles.ts                           # responsive Primary Sidebar
└── manager-panel.ts                            # xóa sau khi migration hoàn tất

src/test/features/
├── multi-session-manager-view.test.ts          # lifecycle/toggle/provider tests
└── multi-session-manager-webview.test.ts       # bổ sung responsive/DOM behavior nếu cần
```

Core integration dự kiến:

| File                | Thay đổi                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`      | Thêm Activity Bar container/view; giữ title command `Manage Chat Sessions`; điều chỉnh `when` theo multi-session setting nếu cần. |
| `src/views/chat.ts` | Thay ownership từ panel controller sang view provider; `manageSessions()` gọi toggle; expose provider registration surface nhỏ.   |
| `src/extension.ts`  | Đăng ký manager `WebviewViewProvider`; command hiện tại gọi toggle async.                                                         |
| `esbuild.js`        | Không cần entry mới vì tiếp tục dùng `session-manager-webview.js`.                                                                |

## Kế hoạch triển khai

### Phase 1 — Đóng góp Activity Bar container và icon

#### Task 1: Thêm icon Activity Bar

Tạo `assets/session-manager.svg`:

- monochrome, dùng `currentColor` hoặc màu phù hợp quy tắc icon VS Code;
- hình list/session tree tương ứng ý nghĩa `$(list-tree)` của **Manage Chat Sessions**;
- rõ ở kích thước Activity Bar và dark/light/high-contrast theme;
- không nhúng ảnh raster hoặc text.

**Acceptance criteria:**

- [ ] Icon ACP Sessions xuất hiện trong Activity Bar bên trái.
- [ ] Tooltip/title là `ACP Sessions`.
- [ ] Icon phân biệt được với ACP Chat container đang ở Secondary Sidebar.

#### Task 2: Khai báo container và webview view

Cập nhật `package.json`:

- thêm `viewsContainers.activitybar` mà không thay/xóa `viewsContainers.secondarySidebar` hiện tại;
- thêm view `vscode-acp-chat.sessionManagerView` dưới container mới;
- view chỉ hiển thị khi `vscode-acp-chat.multiSession.enabled` bật;
- không tạo command-only Activity Bar item.

**Acceptance criteria:**

- [ ] ACP Chat vẫn nằm ở Secondary Sidebar như hiện tại.
- [ ] ACP Sessions mở trong Primary Sidebar.
- [ ] Không xuất hiện editor tab `ACP Sessions` khi click Activity Bar icon.

### Phase 2 — Migration từ `WebviewPanel` sang `WebviewView`

#### Task 3: Tạo `MultiSessionManagerViewProvider`

Di chuyển lifecycle từ `manager-panel.ts` sang `manager-view.ts`:

- implement `resolveWebviewView()`;
- dùng lại HTML/CSP/Codicon/script bundle;
- bind `onDidReceiveMessage` tới `sessions.handleMessage()`;
- bind `onDidChangeVisibility` để resync khi visible;
- bind `onDidDispose` để bỏ reference/listener;
- post host manager state chỉ khi view đang visible;
- đảm bảo `managerReady` vẫn nhận full state hiện tại.

**Acceptance criteria:**

- [ ] Mở manager lần đầu render đúng danh sách session.
- [ ] Ẩn rồi mở lại manager resync đúng active session và aggregate.
- [ ] Manager ẩn không nhận update DOM liên tục từ background streaming.
- [ ] Đóng sidebar không ảnh hưởng ACP runtime/session.

#### Task 4: Xóa đường `WebviewPanel` cũ

Sau khi WebviewView đạt parity:

- bỏ `MultiSessionManagerPanelController` import/field/constructor;
- xóa `manager-panel.ts`;
- không còn `createWebviewPanel("vscode-acp-chat.sessions", ...)`;
- không giữ hai manager surfaces song song.

**Acceptance criteria:**

- [ ] Toàn repo chỉ còn một Session Manager UI surface.
- [ ] `Manage Chat Sessions` không mở editor tab cũ.

### Phase 3 — Đồng bộ hành vi toggle

#### Task 5: Implement `reveal()` và `toggle()`

- `reveal()` gọi generated command `vscode-acp-chat.sessionManagerView.focus`.
- `toggle()` kiểm tra `WebviewView.visible`:
  - visible: gọi `workbench.action.toggleSidebarVisibility`;
  - hidden/chưa resolve: gọi `reveal()`.
- Serialize hoặc guard thao tác nếu double-click nhanh để tránh command race.

**Acceptance criteria:**

- [ ] Click `Manage Chat Sessions` lần 1 mở manager.
- [ ] Click lần 2 đóng manager/Primary Sidebar.
- [ ] Click lần 3 mở lại và state còn đúng.
- [ ] Khi Explorer đang mở, click `Manage Chat Sessions` chuyển sang ACP Sessions thay vì đóng Explorer rồi dừng.

#### Task 6: Route mọi entry point về cùng provider

- `ChatViewProvider.manageSessions()` chuyển từ `open()` sang `toggle()`.
- Callback `onOpenManager` từ `MultiSessionHostController` cần chọn rõ semantics:
  - action có tên `openManagerPanel` phải dùng `reveal()`, không toggle, để request nội bộ không vô tình đóng manager;
  - command người dùng `vscode-acp-chat.manageSessions` dùng `toggle()`.
- Nếu còn compatibility message `feature.multi-session.manage`, map theo semantics đã xác định và thêm test.

**Acceptance criteria:**

- [ ] Toolbar icon và Activity Bar cùng hiển thị một manager view.
- [ ] Request nội bộ “open manager” luôn mở, không đóng do state hiện tại.
- [ ] Không có manager state hoặc listener bị nhân đôi khi chuyển qua lại giữa hai entry point.

### Phase 4 — Tối ưu UI cho Primary Sidebar

#### Task 7: Responsive manager layout

Kiểm tra `manager-webview.ts`/`manager-styles.ts` ở width 260, 320, 400 và 600 px:

- filters/search stack khi không đủ ngang;
- `min-width` không gây horizontal scroll;
- row title, full ACP session id và error text ellipsis đúng;
- row action icons xuống dòng nhưng vẫn click được;
- header summary/new/refresh không chồng nhau;
- tránh lặp title `ACP Sessions` quá nặng giữa VS Code view title và webview heading; có thể dùng compact header trong narrow layout.

**Acceptance criteria:**

- [ ] Không có horizontal overflow ở sidebar width tối thiểu được VS Code hỗ trợ.
- [ ] New/refresh/open/review/stop/close vẫn có `aria-label` và tooltip.
- [ ] Dark, light và high-contrast theme đọc được.

### Phase 5 — Tests, tài liệu và phát hành local

#### Task 8: Automated tests

Thêm coverage cho provider/toggle:

1. `resolveWebviewView()` cấu hình HTML và message listener đúng.
2. `managerReady`/`managerResync` post full state.
3. Host state chỉ được post khi view visible.
4. View visible → `toggle()` gọi `workbench.action.toggleSidebarVisibility`.
5. View hidden/chưa resolve → `toggle()` gọi `vscode-acp-chat.sessionManagerView.focus`.
6. Hide/show nhiều lần không nhân subscription.
7. Dispose provider không dispose session host controller ngoài ownership hiện tại.
8. Existing manager webview row actions vẫn gửi đúng `localSessionId`.

Có thể tách pure toggle decision helper để test không phụ thuộc hoàn toàn vào workbench UI.

#### Task 9: Cập nhật tài liệu khi implementation hoàn tất

- `docs/architecture/acp-chat-layout.md`:
  - thêm Activity Bar `ACP Sessions` container;
  - đổi manager surface từ editor `WebviewPanel` sang Primary Sidebar `WebviewView`;
  - mô tả hai entry point và toggle flow.
- `docs/features/feature-catalog.md`:
  - cập nhật user-visible behavior và command reference.
- `docs/plans/implement-split-session-manager-panel.md`:
  - chỉ thêm follow-up link/note; không viết lại completion history cũ như thể implementation ban đầu chưa hoàn tất.
- Cập nhật status/completion notes của plan này sau khi verify và install.

## Verification thủ công

1. Reload VS Code, xác nhận Activity Bar bên trái có icon ACP Sessions.
2. Để Primary Sidebar ẩn, click icon ACP Sessions: manager mở bên trái.
3. Click lại cùng Activity Bar icon: Primary Sidebar đóng theo native behavior.
4. Mở Explorer, click icon `Manage Chat Sessions` trong ACP Chat secondary sidebar: Primary Sidebar chuyển sang ACP Sessions.
5. Click `Manage Chat Sessions` lần nữa: Primary Sidebar đóng.
6. Click Activity Bar ACP Sessions: cùng manager và cùng active session xuất hiện lại.
7. Chạy hai ACP sessions, đóng manager, xác nhận sessions tiếp tục chạy.
8. Mở manager lại, xác nhận status/active marker được resync.
9. Dùng New/Open/Review/Stop/Close trong manager ở sidebar hẹp.
10. Disable `vscode-acp-chat.multiSession.enabled`, reload nếu current feature lifecycle yêu cầu, xác nhận manager contribution không tạo UI lỗi.

## Quality gates và local install

Sau khi thay đổi extension contribution/host/webview code:

```bash
npm run check-types
npm run lint
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-session-manager-activity-bar.vsix
code --install-extension .tmp/vscode-acp-chat-session-manager-activity-bar.vsix --force
```

Sau khi install, chạy `Developer: Reload Window`. Không commit file VSIX; xóa file tạm sau khi cài thành công khi an toàn.

## Acceptance criteria tổng

- Icon ACP Sessions tồn tại trong Activity Bar bên trái và mở manager trong Primary Sidebar.
- Click lại Activity Bar icon đang active đóng/ẩn sidebar theo hành vi native VS Code.
- Icon `Manage Chat Sessions` trong ACP Chat title bar toggle cùng manager view: mở khi hidden, đóng khi visible.
- Không còn editor `WebviewPanel` Session Manager cũ.
- Chỉ có một `MultiSessionHostController`, một manager view instance và một manager message channel.
- Đóng manager không stop/close session đang chạy.
- Manager resync đúng sau hide/show hoặc webview recreation.
- Manager UI dùng được ở sidebar hẹp và không horizontal overflow.
- Existing new/activate/review/stop/close behavior không regression.
- Typecheck, lint, test, production package, VSIX packaging và local installation hoàn tất hoặc blocker được báo rõ.

## Rủi ro và giảm thiểu

| Rủi ro                                                          | Ảnh hưởng                                                                                                     | Giảm thiểu                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity Bar không cho command-only icon                        | Không thể giữ panel cũ và chỉ thêm launcher icon đúng UX                                                      | Dùng View Container + `WebviewView`, không dùng launcher giả.                                                                                                                                                                      |
| Hành vi click lần hai của Activity Bar phụ thuộc native VS Code | Một số version/layout có thể chỉ focus thay vì collapse                                                       | Manual test trên minimum/current supported VS Code; không giả định có thể intercept Activity Bar click. Nếu cần strict cross-version behavior, giữ toolbar toggle là đường đóng bảo đảm hoặc xem xét nâng minimum VS Code version. |
| User di chuyển manager view sang Secondary Sidebar/Panel        | `toggleSidebarVisibility` có thể đóng sai workbench part vì public API không expose container location đầy đủ | Xác định default supported placement là Primary Sidebar; dùng generated view focus command để reopen; ghi rõ limitation và test move-view behavior trước release.                                                                  |
| Manager hidden vẫn nhận nhiều state update                      | Tốn CPU/RAM, trái mục tiêu split manager                                                                      | Gate post bằng `view.visible`; full resync khi visible/ready.                                                                                                                                                                      |
| Webview bị deallocate khi sidebar ẩn                            | Filter/search local bị reset                                                                                  | Chấp nhận trong iteration đầu để tiết kiệm resource; manager state luôn resync từ host. Chỉ bật retain context nếu profiling chứng minh cần thiết.                                                                                 |
| Đăng ký provider phụ thuộc multi-session feature lifecycle      | View contribution tồn tại nhưng provider không có khi setting tắt                                             | Dùng `when: config.vscode-acp-chat.multiSession.enabled`; giữ registration/feature enablement nhất quán và test reload setting.                                                                                                    |
| UI editor-width không phù hợp sidebar                           | Overflow, action khó dùng                                                                                     | Thêm responsive CSS và manual test ở 260–600 px.                                                                                                                                                                                   |

## Không nằm trong phạm vi

- Không chuyển ACP Chat chính từ Secondary Sidebar sang Primary Sidebar.
- Không tạo một manager cho mỗi session.
- Không thay đổi transcript/snapshot/delta protocol.
- Không thêm unread/diff/conflict telemetry đã bị loại bỏ bởi low-resource plan.
- Không stop session khi manager bị đóng.
- Không giữ editor Session Manager panel như lựa chọn song song.
- Không thêm keyboard shortcut mới trong iteration này.

## Definition of Done

- Activity Bar manager view và toolbar toggle cùng hoạt động trên một UI instance.
- Webview panel cũ đã được loại bỏ sau parity.
- Responsive, lifecycle, state resync và action routing có automated/manual coverage.
- Architecture/feature docs phản ánh layout thực tế sau implementation.
- Extension được build, package, cài local thành công; user được yêu cầu `Developer: Reload Window`.

## Completion notes

Implemented on 2026-07-15:

- Added contributed Activity Bar container `vscode-acp-chat-session-manager` with `vscode-acp-chat.sessionManagerView` webview view and `assets/session-manager.svg` using the same `list-selection` icon language as the Switch ACP Session UI shown in the reference image.
- Replaced the old editor `WebviewPanel` lifecycle with feature-local `MultiSessionManagerViewProvider` in `src/features/multi-session/manager-view.ts`; removed `manager-panel.ts` and all `createWebviewPanel("vscode-acp-chat.sessions", ...)` paths.
- Registered the manager provider from `src/extension.ts` through a small `ChatViewProvider.getMultiSessionManagerViewProvider()` accessor.
- Changed user command `vscode-acp-chat.manageSessions` to toggle: focus manager when hidden/unresolved, call `workbench.action.toggleSidebarVisibility` when visible. Internal `onOpenManager`/`openManagerPanel` semantics use `reveal()` only.
- Removed the manager host subscription while the view is hidden, then resubscribed and sent a full state on `managerReady`, `managerResync`, and visibility restoration.
- Reused the existing manager browser bundle/contracts and improved CSS for narrow Primary Sidebar widths, including a viewport-constrained scrollable session list.
- Serialized rapid toolbar toggles without dropping later requests.
- Kept manager contribution/commands unavailable when multi-session was disabled at activation; changing this setting still requires `Developer: Reload Window`, matching the controller lifecycle.
- Added focused provider lifecycle/toggle tests and kept existing manager webview tests.
- Updated layout architecture, feature catalog, and the split-panel follow-up note.

Verification performed:

```bash
npm run check-types
npm run compile-tests
npx vscode-test --grep "multi-session manager view provider|multi-session manager webview"
npm run lint
npm run package
npx vsce package --out .tmp/vscode-acp-chat-session-manager-activity-bar.vsix
code --install-extension .tmp/vscode-acp-chat-session-manager-activity-bar.vsix --force
```

Final verification results:

- focused manager tests: `12 passing`;
- full extension test suite: `687 passing`;
- lint: `0 errors`, `386` pre-existing warnings in vendored Pi/test code;
- production package and VSIX creation: passed;
- local install: `fiyqkrc.vscode-acp-chat@1.18.8` installed successfully;
- review verdict: approved, no remaining High/Medium findings.

## Revision history

| Ngày       | Tác giả | Nội dung                                                                                                                   |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-15 | Bytes   | Tạo kế hoạch follow-up: đưa Session Manager vào Activity Bar/Primary Sidebar và đồng bộ toggle với `Manage Chat Sessions`. |
