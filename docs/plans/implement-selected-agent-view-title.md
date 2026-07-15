# Implementation Plan: Inline Agent Selector on ACP Chat Surface

| Attribute | Value |
| --- | --- |
| Status | Planned |
| Owner | TBD |
| Scope | Always-visible agent selector, shared chat header, host/webview contracts, selection lifecycle, responsive UI, tests, architecture documentation |
| References | `package.json`, `src/features/agent-selection/host.ts`, `src/features/register-host.ts`, `src/features/register-webview.ts`, `src/views/chat.ts`, `src/features/multi-session/host.ts`, `src/features/multi-session/webview.ts`, `docs/architecture/acp-chat-layout.md` |

## Tổng quan

Thay icon robot **Select Agent** trong VS Code title toolbar bằng một agent selector hiển thị trực tiếp trên ACP Chat surface. Người dùng thấy ngay agent đang selected và mở dropdown/listbox tại chỗ để chọn agent khác, không phải mở VS Code QuickPick.

Target UX:

```text
VS Code secondary sidebar title area
┌────────────────────────────────────────────────────────────────────────────┐
│ ACP CHAT                                [+] [≡] [⇄] [≡×] [↺] [gear]       │
└────────────────────────────────────────────────────────────────────────────┘

ACP Chat shared sticky header
┌────────────────────────────────────────────────────────────────────────────┐
│ [robot  Pi ▾] [switch] Active session title / status             [↑] [↓] │
└────────────────────────────────────────────────────────────────────────────┘
       │
       └─ click mở agent list ngay trong webview

Agent selector popover
┌──────────────────────────────┐
│ Search agents…               │
├──────────────────────────────┤
│ ✓ Pi                         │
│   OpenCode                   │
│   Claude Code                │
│   Custom ACP Agent           │
└──────────────────────────────┘
```

VS Code không cung cấp API public để render một dynamic `<select>`/listbox thực sự trong `menus.view/title`. Native title menu/submenu được khai báo tĩnh trong `package.json`, không thể sinh item cho arbitrary `customAgents` tại runtime. Vì vậy selector phải nằm ngay dưới Workbench chrome, trong ACP Chat webview header.

## Thay đổi quyết định so với plan trước

Plan cũ chọn `WebviewView.description` thụ động và giữ robot mở QuickPick. Quyết định đó được thay thế hoàn toàn:

- Không dùng `WebviewView.description` để hiển thị selected agent.
- Không giữ robot trong `menus.view/title` làm primary selector.
- Thêm agent selector interactive, luôn visible trong chat header.
- Giữ command `vscode-acp-chat.selectAgent` và QuickPick chỉ làm fallback cho Command Palette/backward compatibility.
- Selector webview và QuickPick dùng chung một host selection pipeline, không tạo hai implementation khác nhau.

## Phân tích hiện trạng

- `package.json` khai báo `vscode-acp-chat.selectAgent` với icon `$(robot)` và đặt command tại `menus.view/title`, `group: navigation@0`.
- `src/features/agent-selection/host.ts` đã:
  - lấy danh sách agent available;
  - đánh dấu selected agent;
  - mở QuickPick;
  - gọi `selectAgentAndStartNewChat(agentId)`.
- Selected-agent source of truth hiện đúng:
  - multi-session: `MultiSessionHostController.defaultAgent`;
  - legacy: singleton `ACPClient`.
- Chọn agent hiện có semantics **select agent + create/activate new chat/session**, kể cả chọn lại cùng agent.
- Multi-session header hiện được tạo riêng trong `src/features/multi-session/webview.ts` và bị ẩn hoàn toàn khi multi-session disabled.
- Assistant response navigator đang attach vào multi-session header.
- Legacy mode chưa có shared top header để đặt agent selector.
- Agent catalog chứa built-in và arbitrary `vscode-acp-chat.customAgents`; custom agent có thể override display name của built-in agent.

## Mục tiêu

- Selected/default agent luôn visible trên ACP Chat surface.
- Click selector mở agent list ngay trong secondary sidebar webview, không chuyển focus sang QuickPick toàn màn hình.
- Hỗ trợ built-in, overridden built-in và arbitrary custom agents.
- Selector hoạt động trong cả multi-session và legacy mode.
- Giữ nguyên semantics chọn agent tạo một chat/session mới.
- Multi-session không huỷ hoặc mutate session cũ.
- Selector state được đồng bộ từ Extension Host; webview không tự làm source of truth.
- UI usable ở secondary sidebar hẹp, keyboard-only, screen reader, light/dark/high-contrast theme.
- Loại bỏ robot title action để tránh hai primary entry point trùng chức năng và giải phóng title toolbar.

## Quyết định UX và hành vi

### 1. Selector đại diện selected/default agent

Selector hiển thị agent dùng cho thao tác tạo chat mới, cùng semantics với marker hiện tại trong QuickPick:

- Multi-session: `defaultAgent`.
- Legacy: agent hiện tại của singleton ACP client.

Trong multi-session, selected/default agent có thể khác agent của historical session đang active:

```text
Selector: Pi
Active historical session: OpenCode
```

Đây là trạng thái hợp lệ:

- selector cho biết agent sẽ dùng khi tạo chat mới;
- session title/status tiếp tục cho biết agent của session đang xem.

Tooltip/ARIA label phải diễn đạt rõ, ví dụ: `Selected agent for new chats: Pi`.

### 2. Chọn agent vẫn tạo new chat/session

Giữ behavior hiện tại:

- click một agent khác → select, persist, create và activate chat/session mới;
- click lại chính agent đang selected → vẫn tạo một chat/session mới của agent đó;
- chỉ mở/đóng popover → không thay đổi state;
- switch historical session → không thay đổi selected/default agent.

### 3. Selector là button + searchable popover/listbox

Không dùng native `<select>` vì:

- không hỗ trợ tốt thao tác chọn lại chính option đang selected để tạo session mới;
- khó search khi agent catalog dài;
- styling/secondary metadata bị giới hạn;
- khó kiểm soát pending state và error announcement.

Control gồm:

- trigger button: robot icon, agent name, chevron;
- search input;
- listbox option theo agent;
- check marker tại selected agent;
- optional agent id làm secondary text, nhất là custom agent;
- live region thông báo pending/cancel/error.

### 4. Chỉ cho phép một selection request đang chạy

Sau khi chọn option:

- đóng popover;
- disable trigger;
- hiển thị trạng thái ngắn như `Starting Pi…`;
- host serialize request để ngăn tạo hai session do double-click hoặc command/webview chạy đồng thời;
- khi operation hoàn tất/cancel/fail, re-enable selector.

### 5. Robot title action được loại bỏ

Xoá `vscode-acp-chat.selectAgent` khỏi `contributes.menus.view/title`.

Giữ nguyên:

- command contribution `vscode-acp-chat.selectAgent`;
- command handler;
- QuickPick hiện tại khi chạy từ Command Palette/keybinding;
- selection lifecycle dùng chung.

## Target architecture

```text
Extension Host
┌──────────────────────────────────────────────────────────────────────────┐
│ AgentSelectionHostController                                             │
│ ├─ buildState()                                                          │
│ │  ├─ selected/default agent                                             │
│ │  └─ available runtime agent catalog                                    │
│ ├─ handleMessage(feature.agent-selection.*)                              │
│ ├─ select(agentId, requestId)                                            │
│ ├─ serialize in-flight selection                                         │
│ ├─ publish state/result                                                  │
│ └─ openQuickPick() — Command Palette fallback                            │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ postMessage
                                ▼
ACP Chat webview
┌──────────────────────────────────────────────────────────────────────────┐
│ SharedChatSurfaceHeader                                                   │
│ ├─ agent slot   → AgentSelectionWebviewFeature                            │
│ ├─ session slot → MultiSessionWebviewController                           │
│ └─ action slot  → AssistantTurnNavigationWebviewFeature                   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Feature/file organization

```text
src/features/
├── agent-selection/
│   ├── contracts.ts
│   ├── host.ts
│   ├── webview.ts
│   ├── styles.ts
│   └── index.ts              # optional, environment-safe exports only
├── shared/
│   ├── chat-surface-header.ts
│   └── chat-surface-header-styles.ts
├── multi-session/
│   ├── webview.ts
│   └── styles.ts
├── register-host.ts
└── register-webview.ts
```

`src/features/shared/` hợp lệ vì header shell được tái sử dụng thực tế bởi agent selection, multi-session và assistant navigation.

Core files chỉ giữ integration nhỏ:

- `src/views/chat.ts`: route feature messages và HTML integration tối thiểu nếu cần.
- `src/views/webview/main.ts`: không thêm agent-specific DOM logic.
- `package.json`: remove title-menu robot entry.

## Message contracts

Proposed contracts trong `src/features/agent-selection/contracts.ts`:

```ts
export interface AgentSelectionOption {
  id: string;
  name: string;
  available: boolean;
}

export interface AgentSelectionStateMessage {
  type: "feature.agent-selection.state";
  revision: number;
  selected: { id: string; name: string };
  options: AgentSelectionOption[];
  pendingRequestId?: string;
  pendingAgentName?: string;
}

export interface AgentSelectionSelectMessage {
  type: "feature.agent-selection.select";
  requestId: string;
  agentId: string;
}

export interface AgentSelectionResyncMessage {
  type: "feature.agent-selection.resync";
}

export interface AgentSelectionResultMessage {
  type: "feature.agent-selection.result";
  requestId: string;
  outcome: "committed" | "cancelled" | "rejected" | "failed";
  message?: string;
}
```

Rules:

- `revision` tăng đơn điệu mỗi lần state snapshot thay đổi.
- Webview không persist selected id/name làm authority trong `vscode.setState()`.
- Host revalidate `agentId` khi nhận request, không tin option list cũ trong browser.
- Result phải correlate bằng `requestId`; stale result không được clear pending request mới hơn.
- `resync` gửi full state mới nhất sau reload hoặc revision mismatch.

## Implementation phases

### Phase 1: Tạo shared chat surface header

#### Task 1: Tách header shell khỏi ownership riêng của multi-session

**Mô tả:** Tạo shared sticky header có ba slot ổn định:

```text
agent slot | session slot | action slot
```

Header được tạo một lần khi webview features register và visible trong cả legacy/multi-session mode.

**Acceptance criteria:**

- [ ] Header nằm ngay dưới VS Code Workbench title chrome.
- [ ] Header chỉ chiếm một hàng ở width bình thường.
- [ ] Agent slot luôn tồn tại.
- [ ] Session slot hiển thị switch button + title/status khi multi-session enabled; ẩn ở legacy mode.
- [ ] Action slot chứa assistant response navigation.
- [ ] Loading strip multi-session nằm ngay dưới shared header.
- [ ] Không tạo hai permanent header row chồng nhau.
- [ ] Header không phụ thuộc private DOM của feature khác.

**Files likely touched:**

- `src/features/shared/chat-surface-header.ts` — new
- `src/features/shared/chat-surface-header-styles.ts` — new
- `src/features/register-webview.ts`
- `src/features/multi-session/webview.ts`
- `src/features/multi-session/styles.ts`
- `src/features/assistant-turn-navigation/webview.ts`

#### Task 2: Giữ behavior multi-session header hiện tại sau refactor

**Acceptance criteria:**

- [ ] Switch session icon vẫn gọi `feature.multi-session.quickSwitch`.
- [ ] Active session title/status vẫn update theo chat state/snapshot.
- [ ] Loading optimistic/state strip không đổi semantics.
- [ ] Assistant navigation vẫn attach đúng, wrap first/last như hiện tại.
- [ ] Chat transcript, composer và scroll restoration không bị thay đổi.

### Phase 2: Mở rộng Agent Selection host feature

#### Task 3: Dùng một provider-scoped controller cho QuickPick và webview

**Mô tả:** Refactor `AgentSelectionHostController` để sở hữu chung:

- state builder;
- message handling;
- selection request serialization;
- QuickPick fallback;
- state/result publishing.

Không tạo một controller cho command và controller khác cho webview.

**Acceptance criteria:**

- [ ] QuickPick và inline selector gọi cùng một `selectAgentAndStartNewChat()` pipeline.
- [ ] Available filtering dùng cùng helper.
- [ ] Selected marker/state dùng cùng source of truth.
- [ ] Controller được register qua `src/features/register-host.ts`.
- [ ] `src/extension.ts` chỉ đăng ký command bằng controller hiện có hoặc integration tương đương tối thiểu.
- [ ] Command Palette behavior cũ tiếp tục hoạt động.

**Files likely touched:**

- `src/features/agent-selection/host.ts`
- `src/features/agent-selection/contracts.ts` — new
- `src/features/register-host.ts`
- `src/extension.ts`
- `src/views/chat.ts`

#### Task 4: Route agent-selection messages qua feature dispatcher

**Acceptance criteria:**

- [ ] `feature.agent-selection.select` được host feature xử lý trước core message switch.
- [ ] `feature.agent-selection.resync` trả full state.
- [ ] Webview `ready` trigger initial state publish.
- [ ] Không thêm agent-selection implementation lớn vào `ChatViewProvider` switch.
- [ ] Invalid/stale agent id trả `rejected` và publish state mới nhất.

### Phase 3: Implement inline selector webview

#### Task 5: Tạo `AgentSelectionWebviewFeature`

**Mô tả:** Render trigger vào agent slot và quản lý popover/listbox.

**Acceptance criteria:**

- [ ] Trigger hiển thị robot icon + selected agent name + chevron.
- [ ] Agent name dùng ellipsis, không làm header overflow ngang.
- [ ] Click trigger toggle popover.
- [ ] Search filter theo agent name và id, case-insensitive.
- [ ] Selected option có check marker và `aria-selected="true"`.
- [ ] Click option gửi đúng một `feature.agent-selection.select` request.
- [ ] Chọn lại selected option vẫn gửi request và tạo new session.
- [ ] Click outside/Escape đóng popover mà không đổi agent.
- [ ] Pending request disable trigger và ngăn duplicate submit.
- [ ] Result cancel/fail re-enable trigger và announce message.
- [ ] New state snapshot update visible agent name/options.

**Files likely touched:**

- `src/features/agent-selection/webview.ts` — new
- `src/features/agent-selection/styles.ts` — new
- `src/features/register-webview.ts`

#### Task 6: Keyboard và accessibility

**Trigger:**

- `button[type="button"]`;
- `aria-haspopup="dialog"` vì popover chứa search + listbox;
- `aria-expanded`;
- `aria-controls`;
- accessible label: `Selected agent for new chats: <name>. Activate to select an agent and start a new chat.`

**Popover:**

- non-modal dialog có accessible label;
- search input dùng combobox semantics và reference listbox;
- options dùng `role="option"`;
- Arrow Up/Down di chuyển active option;
- Home/End tới đầu/cuối;
- Enter chọn option;
- Escape đóng và trả focus về trigger;
- Tab không bị trap;
- focus leaving popover đóng popover;
- polite live region announce pending/result/error.

**Acceptance criteria:**

- [ ] Toàn bộ flow dùng được không cần mouse.
- [ ] Focus indicator dùng VS Code focus theme token.
- [ ] Screen reader phân biệt selected option và active option.
- [ ] Reduced-motion setting được tôn trọng.
- [ ] Không dùng `tabindex` dương.

### Phase 4: Selection lifecycle và state synchronization

#### Task 7: Multi-session commit flow

Expected order:

1. host revalidate agent;
2. set `defaultAgent`;
3. await persist `vscode-acp-chat.selectedAgent`;
4. publish agent-selection state tại commit point;
5. create/activate local session mới;
6. focus chat;
7. start runtime và gọi ACP `session/new` đúng một lần;
8. publish result.

**Acceptance criteria:**

- [ ] Session cũ không bị cancel/close/mutate.
- [ ] Chọn same agent tạo session mới.
- [ ] Runtime start failure vẫn giữ selected/default agent mới.
- [ ] Selector state không chờ runtime startup mới đổi tên.
- [ ] Switch historical session không đổi selector.
- [ ] Failure trả message rõ và trigger được re-enable.

#### Task 8: Legacy commit flow

Expected order:

1. nếu đang generate, mở confirmation hiện có;
2. cancel → trả `cancelled`, không đổi selected agent/chat;
3. reset legacy chat surface;
4. set agent;
5. await persist selected agent;
6. publish selector state tại commit point;
7. connect và gọi ACP `session/new` đúng một lần;
8. publish result.

**Acceptance criteria:**

- [ ] Reject confirmation giữ agent/transcript cũ.
- [ ] Successful selection clear transcript cũ.
- [ ] Connect/new-session failure vẫn giữ selected agent đã commit.
- [ ] Không tạo session hai lần.
- [ ] Concurrent command/webview requests được serialize.

#### Task 9: Catalog/configuration refresh

Sau khi existing config watcher gọi `getAgentsWithStatus(true)`, yêu cầu agent-selection controller publish state mới.

**Acceptance criteria:**

- [ ] Add custom agent xuất hiện trong selector mà không reload extension.
- [ ] Rename custom agent với cùng id update visible name.
- [ ] Custom override built-in name được giữ.
- [ ] Refresh catalog không tạo chat/session.
- [ ] Nếu selected agent bị remove/unavailable, trigger vẫn hiển thị current runtime/default identity.
- [ ] Selected unavailable agent có thể hiển thị disabled row `Unavailable — currently selected`; không silent-switch agent.

### Phase 5: Manifest và command compatibility

#### Task 10: Remove robot khỏi Workbench view title

Xoá duy nhất menu entry:

```json
{
  "command": "vscode-acp-chat.selectAgent",
  "when": "view == vscode-acp-chat.chatView",
  "group": "navigation@0"
}
```

**Acceptance criteria:**

- [ ] Robot không còn xuất hiện trong ACP Chat title toolbar.
- [ ] `[+]`, manage, switch, clear, history, settings giữ nguyên thứ tự tương đối.
- [ ] `vscode-acp-chat.selectAgent` vẫn tồn tại trong `contributes.commands`.
- [ ] Chạy command từ Command Palette vẫn mở QuickPick.
- [ ] Không thêm static command/menu item theo từng agent.

**Files likely touched:**

- `package.json`

### Phase 6: Responsive layout và styling

#### Task 11: Thiết kế cho secondary sidebar hẹp

Normal width:

```text
[Pi ▾] [switch] Session title/status                         [↑][↓]
```

Width dưới khoảng `320–340px`:

```text
[Pi ▾] [switch]                                           [↑][↓]
Session title/status
```

Responsive rules:

- selector có practical min width và max width;
- agent name ellipsis;
- session heading được phép xuống grid row thứ hai trước khi ẩn control;
- không tạo horizontal document scroll;
- không ẩn selector;
- popover ít nhất rộng bằng trigger;
- popover bình thường cap khoảng `280–320px`;
- ở width hẹp dùng viewport insets, ví dụ `left: 8px; right: 8px`;
- list có max height và internal scroll;
- header/popover không bị clip bởi `overflow: hidden`;
- dùng VS Code color/font/border/focus variables;
- light, dark và high-contrast đều đọc được.

**Acceptance criteria:**

- [ ] Layout usable tại webview width 250px.
- [ ] Popover nằm hoàn toàn trong viewport.
- [ ] Header sticky không che loading strip hoặc transcript target.
- [ ] Không làm assistant navigation hoặc session switch mất click area.

### Phase 7: Tests

#### Task 12: Host/controller tests

Cập nhật `src/test/features/agent-selection.test.ts`.

**Acceptance criteria:**

- [ ] State gồm selected agent và all available options.
- [ ] Unavailable agents bị loại khỏi selectable list.
- [ ] Arbitrary custom agent được include.
- [ ] Custom override name được giữ.
- [ ] Selected agent absent khỏi catalog vẫn có trigger presentation fallback.
- [ ] Webview selection và QuickPick dùng cùng target operation.
- [ ] Invalid/stale id bị reject.
- [ ] Duplicate in-flight request không tạo hai session.
- [ ] State revision tăng đơn điệu.
- [ ] Catalog refresh publish options/name mới mà không select agent.

#### Task 13: Webview/JSDOM tests

Tạo `src/test/features/agent-selection-webview.test.ts` hoặc cập nhật webview suite phù hợp.

**Acceptance criteria:**

- [ ] Selector visible trong multi-session và legacy mode.
- [ ] Trigger update từ host state.
- [ ] Open, outside click, Escape và focus restore đúng.
- [ ] Arrow keys, Home/End, Enter hoạt động.
- [ ] Search filter theo name/id.
- [ ] ARIA roles/relationships/selected state đúng.
- [ ] Select gửi đúng một request id + agent id.
- [ ] Pending disable trigger.
- [ ] Cancel/fail re-enable trigger.
- [ ] Stale result không clear pending request mới.
- [ ] Popover không overflow viewport hẹp.

#### Task 14: Multi-session integration tests

- [ ] Chọn agent khác tạo và activate đúng một session mới.
- [ ] Session cũ đang chạy vẫn tiếp tục.
- [ ] Chọn same agent tạo thêm session mới.
- [ ] Runtime failure giữ selected/default agent.
- [ ] Historical session switch không đổi selector.
- [ ] Webview reload/resync restore selector từ host authority.

#### Task 15: Legacy integration tests

- [ ] Selector visible khi multi-session disabled.
- [ ] Selection clear chat và tạo đúng một ACP session.
- [ ] Reject confirmation giữ agent/transcript cũ.
- [ ] Connect/new-session failure giữ selected agent mới.
- [ ] Rapid duplicate selection không overlap reconnect/session creation.

#### Task 16: Manifest/layout regression tests

- [ ] Command contribution vẫn tồn tại.
- [ ] `menus.view/title` không còn `vscode-acp-chat.selectAgent`.
- [ ] Các title action còn lại giữ thứ tự.
- [ ] Multi-session switch/navigation header tests vẫn pass sau shared-header refactor.

### Phase 8: Documentation và verification

#### Task 17: Cập nhật layout source of truth

Cập nhật `docs/architecture/acp-chat-layout.md` trong cùng implementation:

- xoá `[robot]` khỏi VS Code title toolbar wireframe;
- thêm shared sticky chat header;
- thêm `[robot Agent ▾]` selector và popover;
- mapping code tới `src/features/agent-selection/webview.ts`;
- mô tả selected/default agent khác active historical session agent;
- cập nhật ownership của multi-session header và assistant navigator sau shared-header refactor.

Cập nhật `docs/features/feature-catalog.md` vì đây là visible capability/UI change.

Cập nhật status/completion notes của plan này sau implementation.

#### Task 18: Quality gates, build, package và install

```bash
npm run check-types
npm run lint
npm run compile-tests
npm test -- --grep "agent-selection|multi-session|assistant-turn|ChatViewProvider"
npm run package
npx vsce package --out .tmp/vscode-acp-chat-inline-agent-selector.vsix
code --install-extension .tmp/vscode-acp-chat-inline-agent-selector.vsix --force
rm -f .tmp/vscode-acp-chat-inline-agent-selector.vsix
```

Nếu runner không hỗ trợ grep, chạy test files liên quan hoặc full `npm test`.

Sau install, yêu cầu chạy `Developer: Reload Window`.

## Manual verification

- [ ] ACP Chat title toolbar không còn robot Select Agent.
- [ ] Inline selector hiển thị đúng selected/default agent ngay khi mở view.
- [ ] Click selector mở list tại chỗ, không mở VS Code QuickPick.
- [ ] Search và keyboard navigation hoạt động.
- [ ] Chọn OpenCode tạo/activate session OpenCode mới.
- [ ] Chọn Pi tạo/activate session Pi mới; session OpenCode cũ còn nguyên.
- [ ] Chọn lại Pi tạo thêm một Pi session.
- [ ] Switch về historical OpenCode session: selector vẫn là Pi; session status hiển thị OpenCode.
- [ ] Đang generate và reject confirmation ở legacy mode: selector/chat không đổi.
- [ ] Runtime startup failure: selector vẫn giữ agent đã commit và hiển thị lỗi.
- [ ] Add/rename custom agent: list/name refresh không tạo session.
- [ ] Width 250px, normal width và wide width đều không horizontal overflow.
- [ ] Light, dark, high-contrast và keyboard-only flow đều usable.
- [ ] Command Palette `Select Agent` vẫn mở QuickPick fallback.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| VS Code title chrome không hỗ trợ dynamic native selector | High | Đặt selector trong webview shared header; không dùng private Workbench API. |
| Shared-header refactor làm hỏng multi-session/navigation | High | Tạo slot API nhỏ, giữ behavior tests hiện có và test regression trực tiếp. |
| Người dùng nhầm selected/default agent với active historical session agent | Medium | Label/tooltip rõ “for new chats”; active session agent vẫn hiển thị trong status. |
| Double-click tạo nhiều session | High | Serialize host request, correlate `requestId`, disable trigger pending. |
| Popover bị clip trong sidebar hẹp | Medium | Shared header overflow visible, viewport inset và dedicated narrow-width tests. |
| Custom agent thay đổi làm option/state stale | Medium | Full state revision + resync + publish sau catalog refresh. |
| Legacy và multi-session dùng source of truth khác nhau | Medium | Provider target expose unified selected-agent presentation; tests cho cả hai mode. |
| QuickPick và inline selector diverge behavior | Medium | Dùng một host controller/selection pipeline. |
| Core file phình | Low | DOM/contract/controller logic nằm trong `src/features/agent-selection/`; core chỉ route/register. |

## Rejected alternatives

### Dynamic `<select>` trong VS Code `view/title`

VS Code không expose arbitrary control API tại vị trí này. `menus.view/title` chỉ nhận command/submenu contribution.

### Static VS Code submenu cho agent

Submenu item được khai báo tĩnh trong `package.json`; không hỗ trợ arbitrary runtime custom agents hoặc dynamic renamed agents.

### Native HTML `<select>` trong webview

Không hỗ trợ tốt chọn lại current agent để tạo session mới, không có search và khó biểu diễn pending/error/secondary agent id.

### Giữ robot title action cùng inline selector

Tạo hai primary entry point trùng chức năng và tiếp tục chiếm toolbar width. Robot command chỉ được giữ ở Command Palette fallback.

### `WebviewView.description`

Chỉ là passive text, không đáp ứng yêu cầu chọn agent trực tiếp.

### Private VS Code Workbench DOM/API

Không ổn định và không được extension API hỗ trợ.

## Non-goals

- Không thay đổi agent availability detection.
- Không thay đổi semantics Select Agent + New Session.
- Không tự đổi selected/default agent khi switch historical session.
- Không đóng session cũ để lấy runtime slot.
- Không rewrite mode/model/config dropdown hiện có.
- Không thêm setting chọn QuickPick hay inline selector trong iteration đầu.
- Không thêm telemetry.

## Definition of Done

- Robot Select Agent bị loại khỏi VS Code view-title toolbar.
- Agent selector luôn visible trong shared ACP Chat header ở legacy và multi-session mode.
- Selector hỗ trợ search, keyboard, screen reader và arbitrary custom agents.
- Chọn option tại chỗ dùng đúng lifecycle tạo new chat/session hiện có.
- Multi-session giữ session cũ; legacy tạo đúng một session và giữ confirmation behavior.
- Host là source of truth, request được serialize và state/result correlate bằng revision/request id.
- Shared header giữ nguyên session switch, loading và assistant navigation behavior.
- Responsive UI hoạt động tại width 250px mà không horizontal overflow.
- Command Palette QuickPick fallback vẫn hoạt động.
- Tests, typecheck, lint, production package và local VSIX installation pass, hoặc blocker được báo rõ.
- Architecture/layout doc và feature catalog được cập nhật sau implementation.
