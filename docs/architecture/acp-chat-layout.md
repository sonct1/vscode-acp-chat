# ACP Chat layout architecture

Tài liệu này mô tả bố cục runtime của ACP Chat trong VS Code workbench/webview và ánh xạ từng vùng UI tới file code chịu trách nhiệm.

## Điểm vào UI

| Lớp | Code | Vai trò |
| --- | --- | --- |
| VS Code contribution | [`package.json`](../../package.json) | Khai báo secondary sidebar container `vscode-acp-chat-secondary`, webview view `vscode-acp-chat.chatView`, commands và configuration. |
| Extension host | [`src/extension.ts`](../../src/extension.ts) `activate()` | Tạo `ACPClient`, `ChatViewProvider`, status bar, command handlers, rồi đăng ký `registerWebviewViewProvider()`. |
| Webview host provider | [`src/views/chat.ts`](../../src/views/chat.ts) `ChatViewProvider` | Tạo HTML qua `getHtmlContent()`, nhận message từ webview, quản lý ACP lifecycle, diff/file/terminal/permission/session metadata. |
| Webview runtime | [`src/views/webview/main.ts`](../../src/views/webview/main.ts) `WebviewController` | Orchestrator trong iframe: tạo context, component tree, message router, event bus và top-level message handlers. |
| Root composition | [`src/views/webview/component/webview-root.ts`](../../src/views/webview/component/webview-root.ts) `WebviewRootComponent` | Tạo các component chính: message list, input panel, session toolbar, auxiliary panels, chip renderer. |

## VS Code chrome phía trên webview

Phần `ACP CHAT` và dãy icon phía trên ảnh chụp là chrome của VS Code Workbench, không phải DOM bên trong iframe webview. Nó được VS Code render từ `package.json`: `viewsContainers.secondarySidebar`, `views`, và `menus.view/title`.

```text
VS Code secondary sidebar title area
┌────────────────────────────────────────────────────────────────────────────┐
│ [0] ACP CHAT                                      [robot] [+] [≡] [≡×] [↺] │
└────────────────────────────────────────────────────────────────────────────┘
                                                     │      │    │    │    │
                                                     │      │    │    │    └─ Load History
                                                     │      │    │    └────── Clear Chat
                                                     │      │    └─────────── Manage Chat Sessions
                                                     │      └──────────────── New Chat
                                                     └─────────────────────── Select Agent
```

| Vùng | Nguồn khai báo | Ý nghĩa |
| --- | --- | --- |
| `ACP CHAT` | [`package.json`](../../package.json) `contributes.viewsContainers.secondarySidebar[].title` | Tên container trong secondary sidebar. |
| Webview view `vscode-acp-chat.chatView` | [`package.json`](../../package.json) `contributes.views` | View chứa iframe ACP Chat; `contextualTitle` là `ACP Chat`. |
| `[robot]` | `vscode-acp-chat.selectAgent`, icon `$(robot)` | Chọn agent ACP. |
| `[+]` | `vscode-acp-chat.newChat`, icon `$(add)` | Tạo chat mới. |
| `[≡]` | `vscode-acp-chat.manageSessions`, icon `$(list-tree)` | Mở quản lý chat sessions. |
| `[≡×]` | `vscode-acp-chat.clearChat`, icon `$(clear-all)` | Xoá transcript/chat hiện tại. |
| `[↺]` | `vscode-acp-chat.loadHistory`, icon `$(history)` | Tải lịch sử chat. |

## Wireframe tổng thể

Bố cục dưới đây bắt đầu từ phần bên trong webview iframe, nằm dưới vùng VS Code chrome `[0]`. Bố cục gốc được sinh trong `ChatViewProvider.getHtmlContent()` ở [`src/views/chat.ts`](../../src/views/chat.ts). Các vùng multi-session được inject thêm bằng `document.body.prepend()` trong [`src/features/multi-session/webview.ts`](../../src/features/multi-session/webview.ts), nên không xuất hiện trực tiếp trong HTML template.

```text
ACP Chat webview in VS Code secondary sidebar
┌────────────────────────────────────────────────────────────────────────────┐
│ [A] Multi-session header, optional, sticky                                 │
│     [Sessions N]  Active session title / status                [+ New]     │
├────────────────────────────────────────────────────────────────────────────┤
│ [B] Multi-session loading strip, optional                                  │
│     Spinner + "Initializing / Loading history / Stopping ..."              │
├────────────────────────────────────────────────────────────────────────────┤
│ [C] Welcome view, visible only when transcript is empty                    │
│     Logo + "Welcome to VSCode ACP" + short description                     │
├────────────────────────────────────────────────────────────────────────────┤
│ [D] Agent plan panel, optional                                             │
│     Collapsible execution plan + progress                                  │
├────────────────────────────────────────────────────────────────────────────┤
│ [E] Messages container, flex:1 scroll area                                 │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ fade top                                                               │ │
│ │                                                                        │ │
│ │ [E1] User message bubble                                               │ │
│ │      text + @mention chips + /command chips                            │ │
│ │                                                                        │ │
│ │ [E2] Assistant message                                                 │ │
│ │      text block + thought block + tool blocks                          │ │
│ │      action buttons after stream end                                   │ │
│ │                                                                        │ │
│ │ [E3] Typing indicator while agent is generating                        │ │
│ │                                                                        │ │
│ │ fade bottom                                                            │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────┤
│ [F] Diff summary panel, optional                                           │
│     Changed files + review / accept / discard actions                      │
├────────────────────────────────────────────────────────────────────────────┤
│ [G] Chat input area, fixed bottom                                          │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ [G1] Autocomplete popover: slash commands or workspace file search     │ │
│ │ [G2] Rich contenteditable input: text, mention chips, command chips    │ │
│ │ [G3] Input hint: Enter / Shift+Enter guidance                          │ │
│ ├────────────────────────────────────────────────────────────────────────┤ │
│ │ [G4] Options toolbar                                                   │ │
│ │      [attach] [mode] [model] [dynamic config] [context]       [send]   │ │
│ │                                                              or [stop] │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

## Modal và overlay

```text
Runtime overlays above the chat surface
┌────────────────────────────────────────────────────────────────────────────┐
│ [H] Multi-session manager overlay, fixed full webview                      │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ Sessions                                            [New] [Close]      │ │
│ ├────────────────────────────────────────────────────────────────────────┤ │
│ │ Session item                                                           │ │
│ │   status icon + title + status/agent meta + badges                     │ │
│ │   actions: [Open] [Review] [Stop] [Close]                              │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────┤
│ [I] Permission dialog                                                      │
│     Embedded inside a tool block when possible, otherwise modal overlay    │
├────────────────────────────────────────────────────────────────────────────┤
│ [J] Confirm dialog                                                         │
│     Stop current generation before running another guarded action          │
├────────────────────────────────────────────────────────────────────────────┤
│ [K] Image preview popover                                                  │
│     Hover preview for image mention chips                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Component mapping

| ID | Thành phần UI | DOM/CSS chính | Code chịu trách nhiệm |
| --- | --- | --- | --- |
| 0 | VS Code secondary sidebar title area | VS Code Workbench chrome, không nằm trong webview DOM | [`package.json`](../../package.json) `contributes.viewsContainers.secondarySidebar`, `contributes.views`, `contributes.menus.view/title`; command handlers đăng ký trong [`src/extension.ts`](../../src/extension.ts). |
| A | Multi-session header | `.multi-session-header`, `.multi-session-open`, `.multi-session-title`, `.multi-session-status`, `.multi-session-new` | [`src/features/multi-session/webview.ts`](../../src/features/multi-session/webview.ts) `MultiSessionWebviewController.createHeader()`, `renderHeader()`; CSS inject từ [`src/features/multi-session/styles.ts`](../../src/features/multi-session/styles.ts). |
| B | Multi-session loading strip | `.multi-session-loading`, `.multi-session-spinner` | [`src/features/multi-session/webview.ts`](../../src/features/multi-session/webview.ts) `createLoading()`, `renderLoading()`. |
| C | Welcome view | `#welcome-view`, `.welcome-view`, `.welcome-logo` | HTML ở [`src/views/chat.ts`](../../src/views/chat.ts) `getHtmlContent()`; visibility do [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts) `MessageListComponent.updateViewState()` điều khiển; style ở [`media/main.css`](../../media/main.css). |
| D | Agent plan panel | `#agent-plan-container` | [`src/views/webview/component/auxiliary-panels.ts`](../../src/views/webview/component/auxiliary-panels.ts) nhận `plan` / `planComplete`; [`src/views/webview/widget/plan-view.ts`](../../src/views/webview/widget/plan-view.ts) render plan. |
| E | Messages scroll area | `#messages-container`, `#messages`, `.messages-fade-top`, `.messages-fade-bottom` | HTML ở [`src/views/chat.ts`](../../src/views/chat.ts); style flex/scroll ở [`media/main.css`](../../media/main.css); logic ở [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts). |
| E1 | User message bubble | `.message.user`, `.message-content-text`, `.message-mentions` | [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts) `addMessage()`, `renderMessageText()`; chips do [`src/views/webview/component/chip-renderer.ts`](../../src/views/webview/component/chip-renderer.ts). |
| E2 | Assistant message | `.message.assistant`, `.block`, `.block-tool`, `.tool-item` | [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts) `ensureAssistantMessage()`; block lifecycle ở [`src/views/webview/block/block-manager.ts`](../../src/views/webview/block/block-manager.ts); block types ở [`text-block.ts`](../../src/views/webview/block/text-block.ts), [`thought-block.ts`](../../src/views/webview/block/thought-block.ts), [`tool-block.ts`](../../src/views/webview/block/tool-block.ts). |
| E2a | Markdown text block | `.block-text` | [`src/views/webview/block/text-block.ts`](../../src/views/webview/block/text-block.ts); Markdown renderer config ở [`src/views/webview/marked-config.ts`](../../src/views/webview/marked-config.ts). |
| E2b | Thought block | `.block-thought` | [`src/views/webview/block/thought-block.ts`](../../src/views/webview/block/thought-block.ts) render collapsible thinking content. |
| E2c | Tool block | `.block-tool`, `details.tool-item`, `.tool-summary`, `.tool-details-content` | [`src/views/webview/block/tool-block.ts`](../../src/views/webview/block/tool-block.ts); summary/detail HTML do [`src/views/webview/tool-render.ts`](../../src/views/webview/tool-render.ts); diff HTML do [`src/views/webview/widget/diff-render.ts`](../../src/views/webview/widget/diff-render.ts); ANSI terminal output do [`src/views/webview/ansi-render.ts`](../../src/views/webview/ansi-render.ts). |
| E2d | Assistant action buttons | `.message-actions` | [`src/views/webview/component/action-buttons.ts`](../../src/views/webview/component/action-buttons.ts) render copy, paste-to-input, scroll actions after `streamEnd`. |
| E3 | Typing indicator | `#typing-indicator`, `.typing-indicator`, `.zed-loader` | HTML ở [`src/views/chat.ts`](../../src/views/chat.ts); [`src/views/webview/component/message-list.ts`](../../src/views/webview/component/message-list.ts) `setGenerating()`, `showTypingIndicator()`, `hideTypingIndicator()`. |
| F | Diff summary panel | `#diff-summary-container`, `.diff-summary-container` | [`src/views/webview/component/auxiliary-panels.ts`](../../src/views/webview/component/auxiliary-panels.ts) nhận `diffSummary`; [`src/views/webview/widget/diff-summary.ts`](../../src/views/webview/widget/diff-summary.ts) render; host diff state từ [`src/acp/diff-manager.ts`](../../src/acp/diff-manager.ts) qua [`src/views/chat.ts`](../../src/views/chat.ts). |
| G | Chat input area | `#chat-input-area`, `#input-container` | HTML ở [`src/views/chat.ts`](../../src/views/chat.ts); layout/style ở [`media/main.css`](../../media/main.css); logic ở [`src/views/webview/component/input-panel.ts`](../../src/views/webview/component/input-panel.ts). |
| G1 | Autocomplete popover | `#command-autocomplete` | [`src/views/webview/component/autocomplete.ts`](../../src/views/webview/component/autocomplete.ts); file search request/response đi qua [`src/views/chat.ts`](../../src/views/chat.ts) và [`src/utils/file-search.ts`](../../src/utils/file-search.ts). |
| G2 | Rich input | `#input.input-rich`, `.mention-chip`, `.command-chip` | [`src/views/webview/component/input-panel.ts`](../../src/views/webview/component/input-panel.ts) handles keydown/input/paste/collectMessage; chip rendering ở [`src/views/webview/component/chip-renderer.ts`](../../src/views/webview/component/chip-renderer.ts). |
| G3 | Input hint | `#input-hint` | Static HTML trong [`src/views/chat.ts`](../../src/views/chat.ts), styled by [`media/main.css`](../../media/main.css). |
| G4 | Options toolbar | `#options-bar`, `#left-options`, `#right-options` | `#send`, `#stop`, `#attach-image` thuộc [`src/views/webview/component/input-panel.ts`](../../src/views/webview/component/input-panel.ts); mode/model/config/context thuộc [`src/views/webview/component/session-toolbar.ts`](../../src/views/webview/component/session-toolbar.ts). |
| G4a | Mode/model/config dropdowns | `#mode-dropdown`, `#model-dropdown`, `#config-options-container`, `.custom-dropdown`, `.dropdown-popover` | [`src/views/webview/component/session-toolbar.ts`](../../src/views/webview/component/session-toolbar.ts); reusable dropdown ở [`src/views/webview/widget/dropdown.ts`](../../src/views/webview/widget/dropdown.ts). |
| G4b | Context usage ring | `#context-usage-ring`, `.context-usage__bg`, `.context-usage__fg` | [`src/views/webview/component/session-toolbar.ts`](../../src/views/webview/component/session-toolbar.ts) nhận `contextUsage`; renderer ở [`src/views/webview/widget/context-usage.ts`](../../src/views/webview/widget/context-usage.ts). |
| H | Multi-session manager overlay | `.multi-session-overlay`, `.multi-session-list`, `.multi-session-item`, `.multi-session-actions` | [`src/features/multi-session/webview.ts`](../../src/features/multi-session/webview.ts) `createOverlay()`, `renderOverlay()`, `activateSession()`, `createNewSession()`; host counterpart ở [`src/features/multi-session/host.ts`](../../src/features/multi-session/host.ts). |
| I | Permission dialog | Tool-block embedded dialog or modal overlay | [`src/views/webview/widget/permission-dialog.ts`](../../src/views/webview/widget/permission-dialog.ts); host request queue in [`src/views/chat.ts`](../../src/views/chat.ts) `handlePermissionRequest()`. |
| J | Confirm dialog | Modal confirm overlay | [`src/views/webview/widget/confirm-dialog.ts`](../../src/views/webview/widget/confirm-dialog.ts); requested by `confirmAction` messages from [`src/views/chat.ts`](../../src/views/chat.ts). |
| K | Image preview popover | `#image-preview-popover` | HTML in [`src/views/chat.ts`](../../src/views/chat.ts); image attach/paste in [`src/views/webview/component/input-panel.ts`](../../src/views/webview/component/input-panel.ts); hover preview in [`src/views/webview/component/chip-renderer.ts`](../../src/views/webview/component/chip-renderer.ts). |

## Runtime component tree

```text
WebviewController
┌─────────────────────────────────────────────────────────────────────────────┐
│ src/views/webview/main.ts                                                   │
│                                                                             │
│ creates WebviewContext                                                      │
│   vscode API + document + window + StatePersistenceService                  │
│   MessageRouter + EventBus                                                  │
│                                                                             │
│ WebviewRootComponent                                                        │
│ ├─ ChipRendererComponent                                                    │
│ ├─ MessageListComponent                                                     │
│ │  ├─ BlockManager                                                          │
│ │  │  ├─ TextBlock                                                          │
│ │  │  ├─ ThoughtBlock                                                       │
│ │  │  └─ ToolBlock                                                          │
│ │  └─ ActionButtonsComponent                                                │
│ ├─ InputPanelComponent                                                      │
│ │  └─ AutocompleteComponent                                                 │
│ ├─ SessionToolbarComponent                                                  │
│ │  ├─ Dropdown(mode)                                                        │
│ │  ├─ Dropdown(model)                                                       │
│ │  ├─ Dropdown(dynamic config options)                                      │
│ │  └─ Context usage ring                                                    │
│ └─ AuxiliaryPanelsComponent                                                 │
│    ├─ PlanView                                                              │
│    └─ DiffSummary                                                           │
│                                                                             │
│ registerWebviewFeatures()                                                   │
│ └─ MultiSessionWebviewController injects header, loading strip, overlay     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Host-to-webview flow

```text
Extension Host                                 Webview iframe
┌────────────────────────────────────────┐     ┌────────────────────────────────┐
│ extension.ts activate()                │     │ main.ts WebviewController      │
│ └─ ChatViewProvider                    │     │ ├─ handleTopLevelMessage()     │
│    ├─ ACPClient session updates        │     │ ├─ MessageRouter handlers      │
│    ├─ DiffManager / FileHandler        │     │ └─ feature handlers            │
│    ├─ TerminalHandler                  │     │                                │
│    ├─ DocumentSyncManager              │     │ component tree updates DOM     │
│    └─ MultiSessionHostController       │     │ and posts user actions back    │
└────────────────────┬───────────────────┘     └───────────────▲────────────────┘
                     │ postMessage / onDidReceiveMessage         │
                     └───────────────────────────────────────────┘
```

Các message layout quan trọng:

| Hướng | Message | Vùng UI bị ảnh hưởng | Handler chính |
| --- | --- | --- | --- |
| host → webview | `connectionState`, `agentChanged`, `chatCleared` | trạng thái tổng thể, placeholder, reset transcript | [`WebviewController.handleTopLevelMessage()`](../../src/views/webview/main.ts) |
| host → webview | `sessionMetadata`, `modeUpdate`, `modelUpdate`, `contextUsage` | toolbar mode/model/config/context | [`SessionToolbarComponent`](../../src/views/webview/component/session-toolbar.ts) |
| host → webview | `userMessage`, `streamStart`, `streamChunk`, `thoughtChunk`, `toolCallStart`, `toolCallComplete`, `streamEnd` | message list, assistant blocks, typing indicator, action buttons | [`MessageListComponent`](../../src/views/webview/component/message-list.ts), [`BlockManager`](../../src/views/webview/block/block-manager.ts) |
| host → webview | `plan`, `planComplete`, `diffSummary` | plan panel, diff summary panel | [`AuxiliaryPanelsComponent`](../../src/views/webview/component/auxiliary-panels.ts) |
| host → webview | `permissionRequest`, `confirmAction` | permission / confirm dialogs | [`PermissionDialog`](../../src/views/webview/widget/permission-dialog.ts), [`showConfirmDialog()`](../../src/views/webview/widget/confirm-dialog.ts) |
| host → webview | `feature.multi-session.state`, `snapshot`, `delta`, `openManager` | multi-session header, overlay, surface switch | [`MultiSessionWebviewController`](../../src/features/multi-session/webview.ts) |
| webview → host | `ready`, `sendMessage`, `stop`, `searchFiles`, `openFile`, `permissionResponse`, `selectMode`, `selectModel`, `selectConfigOption`, `toggleModelStar` | host actions and ACP client calls | [`ChatViewProvider.resolveWebviewView()` message switch](../../src/views/chat.ts) |
| webview → host | `feature.multi-session.*` | multi-session lifecycle and active surface | [`MultiSessionHostController`](../../src/features/multi-session/host.ts) via [`register-host.ts`](../../src/features/register-host.ts) |

## Layout rules from CSS

| Rule | Code |
| --- | --- |
| Webview body is a vertical flex container with `height: 100vh`, `overflow: hidden`, `min-width: 250px`. | [`media/main.css`](../../media/main.css) `body` |
| Message surface owns remaining vertical space through `#messages-container { flex: 1; min-height: 0; }`. | [`media/main.css`](../../media/main.css) `#messages-container` |
| Actual transcript scroll happens in `#messages { overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }`. | [`media/main.css`](../../media/main.css) `#messages` |
| Bottom input is non-scrolling and pinned by layout through `#chat-input-area { flex-shrink: 0; margin: 0 12px 12px; }`. | [`media/main.css`](../../media/main.css) `#chat-input-area` |
| Toolbar splits left controls and right send/stop controls using `#options-bar`, `#left-options`, `#right-options`. | [`media/main.css`](../../media/main.css) `#options-bar` |
| Multi-session header is sticky at top and overlay is fixed full-webview. | [`src/features/multi-session/styles.ts`](../../src/features/multi-session/styles.ts) `.multi-session-header`, `.multi-session-overlay` |
