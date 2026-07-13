# Concurrent Multi-Session Chat Implementation Plan

| Attribute  | Value                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Status     | Draft                                                                                                            |
| Owner      | TBD                                                                                                              |
| Phase      | Architecture and implementation planning                                                                         |
| Scope      | Extension Host, ACP runtime lifecycle, webview session manager, transcript routing, tests                        |
| References | `src/acp/client.ts`, `src/acp/session-manager.ts`, `src/views/chat.ts`, `src/views/webview/`, `src/extension.ts` |

## Objective

Bổ sung khả năng mở và chạy nhiều chat session đồng thời trong cùng một VS Code webview:

- Session A đang sinh câu trả lời vẫn tiếp tục chạy khi người dùng chọn **New Chat** để tạo session B.
- Người dùng có thể gửi prompt ở B trong khi A vẫn chạy.
- Có màn quản lý các session đang mở/chạy, hiển thị trạng thái, session cần permission, unread và thao tác chuyển/dừng/đóng.
- Chuyển session chỉ thay nội dung trong chat view hiện tại, không tạo editor tab hoặc webview tab mới.
- Stream, tool call, permission, mode/model, context usage, plan và diff không bị lẫn giữa các session.
- Khi session chạy nền hoàn thành, toàn bộ kết quả được giữ lại và hiển thị đúng khi chuyển lại session đó.

## Current-state analysis

### Extension Host

Kiến trúc hiện tại là single-session từ đầu đến cuối:

- `src/extension.ts` tạo một `ACPClient` và một `ChatViewProvider` singleton.
- `src/acp/client.ts` giữ một `currentSessionId`, một `sessionMetadata` và một `pendingCommands`.
- Các API `sendMessage`, `cancel`, `setMode`, `setModel`, `setConfigOption` và document sync đều lấy session ngầm từ `currentSessionId`.
- `src/views/chat.ts` giữ state toàn cục cho một conversation: `hasSession`, `isGenerating`, `isLoadingHistory`, user-message buffer, tool calls, permission queue, confirmation queue, diff manager và các hàng đợi tuần tự.
- `handleNewChat()` hiện yêu cầu cancel session đang chạy trước khi tạo chat mới.
- `loadHistorySession()` xóa UI rồi dùng `session/load` để agent stream lại history.

### Webview

- `WebviewController`, `MessageListComponent`, `InputPanelComponent`, `SessionToolbarComponent` và `AuxiliaryPanelsComponent` chỉ có một instance.
- Transcript hiện nằm trong DOM; webview không có model message độc lập.
- `chatCleared` xóa toàn bộ `#messages` và reset block manager.
- `WebviewState` chỉ lưu connection, input hiện tại và diff; không lưu transcript hoặc draft theo session.
- `retainContextWhenHidden` chỉ giữ webview khi sidebar bị ẩn, không giải quyết việc chuyển nhiều conversation trong cùng webview hoặc webview reload.

### ACP protocol

ACP schema hiện tại đã mang `sessionId` trên các luồng quan trọng:

- `SessionNotification`
- `PromptRequest`
- `RequestPermissionRequest`
- filesystem requests
- terminal requests
- document notifications
- cancel/configuration requests

Tuy nhiên schema không quảng bá capability xác nhận một agent process có thể xử lý nhiều `session/prompt` đồng thời. Không được giả định mọi agent đều multiplex-safe.

## Key architecture decisions

### 1. Extension Host là source of truth

Transcript và runtime state phải được giữ tại Extension Host, không dựa vào DOM của webview.

Mỗi ACP update được chuẩn hóa thành event/state của đúng session trước khi gửi ra UI. Nếu session không active, update vẫn được lưu và chỉ cập nhật badge/trạng thái trong màn quản lý.

### 2. MVP dùng một ACP process cho mỗi session đã bắt đầu

Chiến lược triển khai đầu tiên:

- Mỗi session đã gửi prompt hoặc load history có một `ACPClient` riêng.
- Mỗi `ACPClient` chỉ quản lý một ACP session nên có thể tái sử dụng API implicit `currentSessionId` hiện tại.
- Các prompt ở nhiều session chạy thật sự độc lập ở các process khác nhau.
- Session draft chưa gửi prompt không tạo process.

Không chọn single-process multiplex làm MVP vì:

- Cần refactor sâu toàn bộ `ACPClient` sang metadata/API theo `sessionId`.
- Không có capability chuẩn để biết agent có hỗ trợ prompt song song trong cùng process hay không.
- Một số agent có thể có global mutable state hoặc tự serialize prompt.

Thiết kế runtime phải qua interface để có thể thêm `MultiplexSessionRuntime` sau này cho agent đã được kiểm chứng, nhưng không nằm trong phạm vi MVP.

### 3. Tách local session ID và ACP session ID

- `localSessionId`: ID ổn định do extension tạo, dùng cho UI, routing và state trước khi agent khởi tạo session.
- `acpSessionId`: ID do agent trả về từ `session/new` hoặc session history được load.
- `runtimeId`: ID của ACP client/process đang phục vụ local session.

Không dùng `acpSessionId` làm khóa UI vì một chat draft chưa có ACP session và runtime có thể được tạo muộn.

### 4. Switching là thao tác local, không gọi `session/load`

Khi chuyển giữa các session đang mở:

- Chỉ đổi `activeLocalSessionId`.
- Host gửi snapshot transcript và UI state của session đích.
- Webview reset chat surface và replay snapshot.
- Runtime của session cũ không bị cancel/dispose.

`session/load` chỉ dùng khi mở một history session chưa có trong open-session registry hoặc khi restore session sau khi runtime đã bị dispose.

### 5. Feature organization

Toàn bộ logic sản phẩm mới đặt dưới `src/features/multi-session/`. Core chỉ giữ integration point nhỏ để đăng ký, dispatch và cung cấp bridge.

### 6. New Chat tạo draft theo kiểu lazy

- New Chat tạo local session ngay và chuyển UI sang session đó.
- Chỉ spawn ACP process và gọi `session/new` khi người dùng gửi prompt đầu tiên.
- Draft chưa gửi có thể đóng mà không tạo history/process.

### 7. Giới hạn tài nguyên

Thêm cấu hình `vscode-acp-chat.multiSession.maxConcurrentSessions`, đề xuất mặc định `4`.

- Draft không tính vào giới hạn.
- Session có live ACP process tính vào giới hạn, kể cả đang idle.
- Khi đạt giới hạn, vẫn cho tạo draft nhưng chặn gửi prompt/load history mới với thông báo và link mở session manager để đóng session không còn dùng.
- LRU eviction tự động không triển khai trong MVP vì agent có thể không hỗ trợ load/resume an toàn.

### 8. Runtime không thể sống qua Extension Host restart

Không cam kết prompt tiếp tục chạy khi VS Code hoặc Extension Host restart. Sau restart, session đang chạy trước đó chỉ có thể xuất hiện lại trong history nếu agent đã persist session và hỗ trợ list/load.

## Scope

### In scope

- Nhiều open session trong một webview.
- Nhiều prompt chạy đồng thời qua các isolated ACP process.
- Session manager trong webview.
- Local transcript snapshots và background update retention.
- Per-session prompt status, tool calls, permission queue, mode/model/config, plan, context usage, diff và terminal ownership.
- New Chat, Stop, Close, Load History, agent selection và send-selection behavior trong mô hình multi-session.
- Resource limit và cleanup.
- Unit/integration/manual verification.

### Out of scope for MVP

- Một ACP process multiplex nhiều prompt đồng thời.
- Khôi phục một prompt đang chạy sau khi Extension Host restart.
- Hiển thị đồng thời hai transcript cạnh nhau.
- Tạo VS Code editor tab cho từng chat.
- Tự merge thay đổi khi hai session sửa cùng một file.
- Persist toàn bộ transcript event log riêng của extension lâu dài; persisted history vẫn do ACP agent/session store hiện có quản lý.
- Auto-evict idle runtime không có load/resume capability.

## Target architecture

```text
Single VS Code Webview
  ├─ Active chat surface
  └─ Session manager drawer
            │
            │ feature.multi-session.* messages
            ▼
MultiSessionHostController
  ├─ activeLocalSessionId
  ├─ sessions: Map<localSessionId, ManagedChatSession>
  ├─ transcript/state store per session
  ├─ per-session update queues
  ├─ shared session catalog/history service
  └─ shared workspace mutation coordinator
            │
            ├─ SessionRuntime A ─ ACPClient/process A ─ ACP session A
            ├─ SessionRuntime B ─ ACPClient/process B ─ ACP session B
            └─ SessionRuntime C ─ ACPClient/process C ─ ACP session C
```

## Proposed feature files

```text
src/features/
├── multi-session/
│   ├── host.ts
│   ├── runtime.ts
│   ├── transcript-store.ts
│   ├── session-catalog.ts
│   ├── workspace-mutation-coordinator.ts
│   ├── webview.ts
│   ├── styles.ts
│   ├── types.ts
│   └── index.ts
├── register-host.ts
└── register-webview.ts
```

Responsibilities:

| File                                | Responsibility                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `host.ts`                           | Session registry, active session, commands, host/webview routing, snapshots, lifecycle, aggregate status          |
| `runtime.ts`                        | Một isolated `ACPClient` cùng per-session handlers/queues/state                                                   |
| `transcript-store.ts`               | Append, sequence, compact và snapshot transcript events                                                           |
| `session-catalog.ts`                | Shared per-agent local store, list/delete history, title/update metadata, chọn control client                     |
| `workspace-mutation-coordinator.ts` | Serialize write theo path, detect stale/conflicting diff và bảo vệ rollback                                       |
| `webview.ts`                        | Session manager drawer, active-session switching, snapshot replay, unread/permission badges, draft/scroll restore |
| `styles.ts`                         | Inject CSS riêng của feature; tránh đặt substantial feature styling trong `media/main.css`                        |
| `types.ts`                          | Session model, status, transcript events và `feature.multi-session.*` contracts                                   |
| `register-host.ts`                  | Host feature registry duy nhất                                                                                    |
| `register-webview.ts`               | Webview feature registry duy nhất                                                                                 |

## Core integration changes

| File                           | Minimal integration/change                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`             | Tạo/register host feature, delegate New Chat/Load History/session commands, nhận aggregate status thay vì nghe một ACP client duy nhất                                 |
| `src/views/chat.ts`            | Giữ webview host và generic workspace/UI bridge; dispatch `feature.multi-session.*`; chuyển session-specific lifecycle/state sang feature thay vì thêm switch-case lớn |
| `src/views/webview/main.ts`    | Gọi `registerWebviewFeatures()` và cung cấp một `ChatSurface` bridge nhỏ để reset/replay core chat messages                                                            |
| `src/views/webview/context.ts` | Thêm generic feature services/session context nếu cần; không import host/Node APIs                                                                                     |
| `src/views/webview/types.ts`   | Bổ sung generic session-aware bridge types; custom contracts chính nằm trong feature `types.ts`                                                                        |
| `src/acp/client.ts`            | Không refactor multiplex trong MVP; chỉ bổ sung test seams/cleanup API nếu runtime factory cần                                                                         |
| `src/acp/diff-manager.ts`      | Bổ sung conflict-safe rollback hoặc adapter để feature quản lý diff theo session                                                                                       |
| `package.json`                 | Thêm manage-session command/configuration và optional view-title entry                                                                                                 |

## Internal session model

```ts
type SessionStatus =
  | "draft"
  | "starting"
  | "loading_history"
  | "idle"
  | "running"
  | "awaiting_permission"
  | "cancelling"
  | "error"
  | "closed";

interface ManagedChatSession {
  localSessionId: string;
  acpSessionId?: string;
  runtimeId?: string;
  agentId: string;
  agentName: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  unreadCount: number;
  lastError?: string;
  transcript: TranscriptStore;
  metadata: SessionMetadataSnapshot;
  sideState: {
    plan?: PlanSnapshot;
    contextUsage?: ContextUsageSnapshot;
    diffChanges: SessionFileChange[];
    pendingPermissions: PendingPermission[];
  };
}
```

Runtime-only state:

```ts
interface SessionRuntimeState {
  client: ACPClient;
  isGenerating: boolean;
  isLoadingHistory: boolean;
  toolCalls: Map<string, ToolCallState>;
  userMessageBuffer: string;
  userMessageImages: string[];
  updateQueue: AsyncSerialProcessor<SessionNotification>;
  permissionQueue: Map<string, PendingPermissionResolver>;
  diffManager: DiffManager;
  fileHandler: FileHandler;
  terminalHandler: TerminalHandler;
}
```

## Transcript and UI routing

### Transcript event store

Mỗi session có event sequence tăng đơn điệu:

```ts
interface TranscriptEvent {
  seq: number;
  message: CoreChatRenderMessage;
  createdAt: number;
}
```

Các message render hiện có được tái sử dụng làm payload nội bộ, ví dụ:

- `userMessage`
- `streamStart`
- `streamChunk`
- `thoughtChunk`
- `toolCallStart`
- `toolCallComplete`
- `streamEnd`
- `error`/`system`

Metadata mới nhất như mode/model, plan, diff và context usage nên lưu dạng snapshot, không append lặp vô hạn vào transcript.

### Compaction

Để tránh tăng RAM quá nhanh:

- Gộp các `streamChunk` liên tiếp cùng assistant block.
- Gộp các `thoughtChunk` liên tiếp.
- Tool-call update metadata chỉ giữ representation cần replay.
- Đặt byte/event cap per session; khi vượt cap, compact các turn đã hoàn thành thành snapshot block.
- Không drop turn đang chạy hoặc pending permission.

### Snapshot activation protocol

Custom messages phải dùng prefix `feature.multi-session.`:

- `feature.multi-session.state`
- `feature.multi-session.new`
- `feature.multi-session.activate`
- `feature.multi-session.snapshot`
- `feature.multi-session.delta`
- `feature.multi-session.stop`
- `feature.multi-session.close`
- `feature.multi-session.permission.respond`

Mỗi lần activate tăng `activationRevision`:

1. Host đặt active session.
2. Host lấy snapshot đến `seq = N`.
3. Host gửi một `feature.multi-session.snapshot` chứa session ID, revision, transcript, metadata và side state.
4. Update mới sau N được gửi qua `feature.multi-session.delta` với cùng session ID/revision.
5. Webview bỏ qua delta không khớp active session hoặc revision hiện tại.

Cơ chế revision bắt buộc để tránh delta của A đã nằm trong queue bị render vào B khi người dùng chuyển nhanh A → B.

### Webview replay

`register-webview.ts` nhận một bridge tối thiểu từ core:

```ts
interface ChatSurfaceBridge {
  reset(): void;
  dispatch(message: CoreChatRenderMessage): Promise<void> | void;
  setGenerating(value: boolean): void;
  getInputHtml(): string;
  setInputHtml(value: string): void;
  getScrollTop(): number;
  setScrollTop(value: number): void;
}
```

Khi nhận snapshot:

- Lưu draft và scroll của session cũ.
- Reset message list, block manager, toolbar và auxiliary panels.
- Replay transcript theo `seq`.
- Apply metadata/plan/diff/context/pending permission snapshot.
- Restore draft và scroll của session mới.
- Hiển thị Send hay Stop theo status của session active.

Webview state chỉ cần persist:

- active local session ID;
- input draft HTML theo local session;
- scroll position theo local session;
- drawer open/closed.

Transcript vẫn lấy lại từ Extension Host khi webview gửi `ready`.

## Session manager UX

Thêm một header nhỏ trong cùng webview và một drawer/list quản lý session.

### Header

- Active session title.
- Status dot/spinner.
- Nút mở session manager, kèm số session đang running/awaiting permission.
- Nút New Chat.

### Session item

Hiển thị:

- title;
- agent;
- status: Draft, Starting, Running, Needs permission, Idle, Cancelling, Error;
- elapsed/last activity;
- unread count;
- pending permission count;
- diff count;
- actions: Switch, Stop, Close.

### Behavior

- Click item: activate trong cùng webview.
- Stop: cancel đúng session, kể cả session đang background.
- Close idle: dispose runtime và remove khỏi open-session registry; không xóa history.
- Close running: modal confirm, cancel prompt, resolve pending permissions thành cancelled, đợi runtime idle rồi dispose.
- Delete History vẫn là hành động riêng và không đồng nghĩa Close.
- Session cần permission được đưa lên đầu list và có badge rõ; không tự động cướp focus từ session active.

## Proposed wireframes

### Layout decision

Do chat view nằm trong Secondary Sidebar và thường có chiều rộng hẹp, session manager sẽ mở thành **full-width overlay/drawer bên trong cùng webview** thay vì chia hai cột cố định. Khi đóng manager, transcript active session xuất hiện lại tại đúng vị trí scroll. Không tạo VS Code tab mới.

### 1. Active chat — session đang chạy

```text
┌────────────────────────────────────────────────────────────────────┐
│[Sessions 3]  Refactor auth API       ● Running       [+ New chat]  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ You                                                                │
│ Update the authentication middleware and add tests.                │
│                                                                    │
│ Agent                                                              │
│ I am updating the middleware and related tests...                  │
│   ◐ Read src/auth/middleware.ts                                    │
│   ● Edit src/auth/middleware.ts                                    │
│                                                                    │
│ Background: Update docs is still running • 2 unread                │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ Plan: 3/5                         Diffs: 2 files                   │
│ [ Ask the agent...                                             ]   │
│ [Attach] [Mode: Code] [Model: Claude]                  [Stop]      │
└────────────────────────────────────────────────────────────────────┘
```

Ý nghĩa:

- `[Sessions 3]` mở session manager.
- Title và status ở header luôn thuộc active session.
- `+ New chat` tạo draft mới và chuyển ngay sang draft, không cancel session hiện tại.
- Banner background chỉ là thông báo nhẹ; không chèn output của session khác vào transcript.
- Nút `Stop` chỉ dừng active session.

### 2. Session manager overlay

```text
┌────────────────────────────────────────────────────────────────────┐
│Sessions 4 • Running 2                      [+ New chat] [Close]    │
├────────────────────────────────────────────────────────────────────┤
│! Fix flaky test                                                    │
│  Needs permission • 01:14 • 2 unread                               │
│  Write package-lock.json?                   [Review] [Stop]        │
├────────────────────────────────────────────────────────────────────┤
│● Refactor auth API                                      Active     │
│  Running • 00:42 • 0 unread                              [Stop]    │
├────────────────────────────────────────────────────────────────────┤
│● Update docs                                                       │
│  Running in background • 00:18 • 5 unread        [Open] [Stop]     │
├────────────────────────────────────────────────────────────────────┤
│○ Investigate SQL query                                             │
│  Idle • updated 5m ago                         [Open] [Close]      │
├────────────────────────────────────────────────────────────────────┤
│◌ Untitled chat                                                     │
│  Draft                                         [Open] [Close]      │
├────────────────────────────────────────────────────────────────────┤
│Order: permission → running → draft → recent idle                   │
└────────────────────────────────────────────────────────────────────┘
```

Interaction:

- Click toàn bộ session item hoặc `[Open]`: activate session và đóng manager.
- `[Review]`: activate owner session rồi mở permission dialog.
- `[Stop]`: cancel đúng session nhưng vẫn giữ session trong danh sách.
- `[Close]`: đóng open session/runtime, không xóa persisted history.
- Session active được đánh dấu `Active`; session background dùng unread count.
- Danh sách ưu tiên session cần permission, sau đó running, draft và idle gần nhất.

### 3. Sau khi chuyển sang một session khác đang chạy

```text
┌────────────────────────────────────────────────────────────────────┐
│[Sessions 3]  Update docs              ● Running       [+ New chat] │
├────────────────────────────────────────────────────────────────────┤
│ Refactor auth API continues in background • 1 unread               │
│                                                                    │
│ You                                                                │
│ Update the extension documentation for multi-session chat.         │
│                                                                    │
│ Agent                                                              │
│ I am reviewing the documentation structure...                      │
│   ◐ Read docs/README.md                                            │
│   ◐ Search existing feature documentation                          │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ Plan: 2/4                         Diffs: 0 files                   │
│ [ Ask the agent...                                             ]   │
│ [Attach] [Mode: Code] [Model: Claude]                  [Stop]      │
└────────────────────────────────────────────────────────────────────┘
```

Điểm quan trọng:

- Chat surface được reset rồi replay snapshot của `Update docs`.
- `Refactor auth API` vẫn tiếp tục trong runtime nền.
- Toolbar, plan, diff, context usage và Stop đều chuyển theo active session.
- Khi quay lại `Refactor auth API`, output sinh trong nền đã có sẵn trong snapshot.

### 4. Permission của background session

Permission không tự động hiển thị đè lên session đang đọc. Session manager hiện badge `Needs permission`. Sau khi người dùng chọn `[Review]`, extension activate đúng session rồi mới mở dialog:

```text
┌────────────────────────────────────────────────────────────────────┐
│Permission required                                  [Close]        │
├────────────────────────────────────────────────────────────────────┤
│Session: Fix flaky test                                             │
│Tool: Write package-lock.json                                       │
│                                                                    │
│The background session is waiting for approval.                     │
│Review the tool details before continuing.                          │
│                                                                    │
│             [Reject] [Allow once] [Always allow]                   │
└────────────────────────────────────────────────────────────────────┘
```

### 5. Narrow sidebar behavior

Ở chiều rộng nhỏ, mỗi session item chuyển thành layout nhiều dòng; action không bị ép trên cùng một hàng:

```text
┌──────────────────────────────────────┐
│Sessions 4 • Running 2   [+ New] [×]  │
├──────────────────────────────────────┤
│! Fix flaky test                      │
│  Needs permission • 2 unread         │
│  [Review] [Stop]                     │
├──────────────────────────────────────┤
│● Refactor auth API                   │
│  Running • Active                    │
│  [Stop]                              │
├──────────────────────────────────────┤
│● Update docs                         │
│  Running • 5 unread                  │
│  [Open] [Stop]                       │
├──────────────────────────────────────┤
│○ Investigate SQL query               │
│  Idle • 5m ago                       │
│  [Open] [Close]                      │
└──────────────────────────────────────┘
```

### Status legend

| Indicator    | Meaning                                |
| ------------ | -------------------------------------- |
| `●`          | Running or starting                    |
| `!`          | Waiting for permission/user action     |
| `○`          | Idle/completed open session            |
| `◌`          | Draft, chưa tạo ACP runtime            |
| Unread count | Có output mới khi session không active |

## Detailed flows

### New Chat while session A is running

1. User chọn New Chat.
2. Không gọi `ensureIdleIfGenerating()` và không cancel A.
3. Host tạo local session B ở trạng thái `draft` với agent mặc định hiện tại.
4. Host set B active, gửi state + empty snapshot.
5. A tiếp tục nhận ACP notifications vào transcript store của A.
6. Session manager hiển thị A Running, B Draft.

### Send prompt in session B

1. Webview gửi message kèm `localSessionId = B`.
2. Host xác nhận B đang active và không running.
3. Runtime manager kiểm tra process limit.
4. Tạo `ACPClient` riêng cho B, bind agent/cwd/handlers.
5. Connect, gọi `session/new`, lưu `acpSessionId`.
6. Append `userMessage`, `streamStart`; gọi prompt trên client B.
7. A và B có update queue riêng nên không block thứ tự lẫn nhau.
8. Khi prompt B kết thúc, append `streamEnd`, chuyển B về `idle`.

### Background update

Nếu update thuộc session không active:

- Luôn append vào transcript/state trước.
- Không gửi render delta vào chat surface.
- Update session status/unread/permission badge.
- Khi hoàn thành, status chuyển `idle`; unread count tăng.

### Switch A ↔ B

- Không cancel.
- Không reconnect.
- Không gọi ACP `session/load`.
- Chỉ gửi host snapshot và replay trong cùng webview.
- Chuyển về session đang chạy phải hiển thị transcript mới nhất và nút Stop.

### Permission from background session

1. Permission request được route bằng ACP `sessionId`/runtime owner.
2. Host lưu resolver trong permission queue của đúng session.
3. Session chuyển `awaiting_permission` và manager hiện badge.
4. Nếu session active, hiển thị dialog ngay.
5. Nếu session inactive, chờ người dùng switch hoặc chọn Review trong manager; không hiển thị dialog trên transcript khác.
6. Response phải mang `localSessionId` và `requestId`.
7. Cancel/Close session phải resolve toàn bộ pending permission bằng `cancelled`.

### Stop

- Nút Stop trên chat surface chỉ tác động active session.
- Stop trong manager tác động item được chọn.
- Runtime gọi `ACPClient.cancel()` của đúng isolated client.
- Vẫn chấp nhận final tool-call updates sau cancel trước khi prompt trả stop reason.

### Load History while another session runs

1. History picker/list không cancel session đang chạy.
2. Nếu ACP session đã có trong open registry, chỉ activate local session tương ứng.
3. Nếu chưa mở, tạo local session `loading_history` và isolated runtime.
4. Gọi `session/load` trên runtime mới.
5. History replay được ghi vào transcript store của session mới.
6. Sau queue drain, append final `streamEnd(history_load)` và chuyển `idle`.

### Agent selection

- Mỗi started session giữ agent config của chính nó đến khi Close.
- `selectAgent` chỉ đổi default agent cho New Chat.
- Nếu active session là draft chưa start, có thể đổi agent của draft đó.
- Không dispose hoặc reconnect các session đang chạy khi đổi default agent.
- Session manager luôn hiển thị agent để tránh nhầm.

### Send editor/terminal selection

- Selection được thêm vào input của active session.
- Nếu chưa có active session, tạo một draft trước.
- Không đưa selection vào tất cả session.

## Side-effect isolation

### Tool calls

- `toolCalls` map và finalize logic đặt trong từng runtime/session.
- Tool-call ID chỉ unique trong session; không dùng map toàn cục.
- Cleanup timer phải bị dispose khi Close session.

### Permission

- Queue/resolver per session.
- Request message luôn có local session ID.
- Background permission không được render vào active conversation khác.

### Diff and filesystem writes

Mỗi session có `DiffManager`/`FileHandler` riêng để snapshot và summary không bị lẫn. Workspace vẫn là tài nguyên dùng chung nên cần `WorkspaceMutationCoordinator`:

- Serialize write cùng path bằng per-path mutex.
- Ghi base/current content hash cho mỗi change.
- Khi session khác hoặc người dùng sửa cùng file, đánh dấu diff cũ là `conflicted/stale`.
- Rollback chỉ được thực hiện nếu file hiện tại vẫn khớp `newText`/hash mà change đó tạo ra.
- Nếu không khớp, không overwrite; yêu cầu review thủ công.
- URI dùng cho diff review phải mang local session ID để `provideTextDocumentContent()` lấy đúng old content.

Không cố auto-merge trong MVP.

### Terminal

- Dùng một `TerminalHandler` per runtime/session.
- Close session chỉ kill/release terminal của session đó.
- Không dùng terminal ID làm global session key.

### Plan, context usage, mode/model/config

- Lưu latest snapshot per session.
- Toolbar chỉ phản ánh active session.
- Mode/model/config request gọi client của active session, không dùng default agent hoặc session khác.
- Preference lưu per agent như hiện tại; restore chỉ chạy một lần trên mỗi started session.

### Document sync

Không tạo một `DocumentSyncManager` listener cho mỗi runtime vì sẽ nhân số VS Code event listener và notification.

MVP dùng một `DocumentSyncRouter` chung với policy:

- Gửi didFocus/didOpen/didChange/didSave/didClose cho active started session.
- Khi activate một session khác, gửi snapshot/focus cần thiết cho session mới nếu agent hỗ trợ.
- Không broadcast mọi document change cho tất cả background session trong MVP.

Sau khi có profiling và agent-specific test mới cân nhắc policy broadcast.

### Connection and stderr

- Connection/error/stderr được scope theo local session.
- Một runtime crash chỉ kết thúc/đánh dấu lỗi session đó.
- Không gửi global `streamEnd(error)` cho mọi session.
- Status bar dùng aggregate state, ví dụ số session Running/Needs permission; chat surface dùng connection state của active session.

## Session history/catalog design

Không tạo một `AgentSessionManager` với cache riêng cho từng runtime vì các instance có thể cùng đọc/ghi cùng globalState prefix và tạo cache/debounce race.

Tạo `SessionCatalogService` singleton per agent:

- Sở hữu duy nhất một `SessionStore` per agent.
- Record session mới do bất kỳ runtime nào tạo.
- Apply `session_info_update` theo ACP session ID.
- List/delete history qua một connected runtime cùng agent nếu có.
- Nếu không có runtime phù hợp, tạo control client tạm thời, connect, thực hiện list/delete rồi dispose.
- `session/load` vẫn được thực hiện trên runtime đích, không trên control client.

## Implementation plan

| Step | Description                                                                                                                                 | Verification                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1    | Thêm host/webview feature registries và bridge interfaces; chưa đổi behavior                                                                | Existing tests pass; core chỉ có registration/dispatch calls                              |
| 2    | Tạo `types.ts`, session state machine, transcript store và per-session queue tests                                                          | Unit tests cho sequence, compaction, snapshot và stale revision                           |
| 3    | Chuyển current single-session lifecycle từ `ChatViewProvider` sang `MultiSessionHostController` nhưng chạy ở compatibility mode một session | Existing send/new/load/tool/history tests vẫn giữ behavior                                |
| 4    | Chuyển webview sang snapshot/replay source of truth; webview reload lấy snapshot từ host                                                    | Reload không mất transcript trong Extension Host lifetime; diff/toolbar được restore đúng |
| 5    | Thêm session manager header/drawer, per-session draft/scroll và local switching                                                             | Chuyển nhiều draft/session không tạo tab; nội dung/draft/scroll đúng                      |
| 6    | Thêm `IsolatedSessionRuntime` và lazy runtime creation; bỏ global `isGenerating` guard                                                      | A đang prompt vẫn tạo/send B; hai prompt promises cùng pending                            |
| 7    | Scope tool calls, permission, plan, usage, metadata, stderr và queues theo session                                                          | Interleaved updates/tool ID collisions không lẫn; permission đúng session                 |
| 8    | Scope diff/file/terminal; thêm workspace mutation conflict protection                                                                       | Same-file conflict không cho rollback overwrite thay đổi mới                              |
| 9    | Thêm shared DocumentSyncRouter với active-session policy                                                                                    | Document notifications mang đúng ACP session ID, không duplicate listener                 |
| 10   | Chuyển New Chat, Stop, Clear, Load History, Select Agent, send-selection commands sang orchestrator                                         | Command behavior đáp ứng flow đã định nghĩa                                               |
| 11   | Thêm process limit, Close/dispose cleanup và aggregate status                                                                               | Không leak child process, timer, terminal, listener hoặc queue sau Close                  |
| 12   | Thêm feature flag/rollout setting, migration docs và manual agent matrix                                                                    | Legacy single-session mode vẫn dùng được khi feature bị disable                           |
| 13   | Chạy full quality gates và package VSIX để manual test                                                                                      | Typecheck, lint, tests và production package thành công                                   |

## Detailed implementation phases

### Phase 1 — Integration seams

- Tạo `src/features/register-host.ts` và `src/features/register-webview.ts`.
- Định nghĩa generic host message dispatcher thay vì thêm feature cases trực tiếp vào switch lớn của `ChatViewProvider`.
- Định nghĩa `ChatSurfaceBridge` để webview feature có thể reset/replay mà không import private implementation giữa các feature.
- Giữ behavior hiện tại, chưa bật multi-session UI.

Exit criteria:

- Không có behavior regression.
- Feature code không import `vscode` trong webview entry.
- Core integration chỉ là registry, bridge và dispatch.

### Phase 2 — Session model and transcript ownership

- Tạo `MultiSessionHostController` với một session compatibility mode.
- Di chuyển `hasSession`, `isGenerating`, history buffers, tool maps, permission queue và update queue vào session/runtime state.
- Mọi render event phải append vào transcript store trước khi post UI.
- Metadata/plan/diff/context lưu latest snapshot.
- Webview `ready` nhận full state + active snapshot thay vì dựa vào DOM cũ.

Exit criteria:

- Single-session behavior giống hiện tại.
- Webview reload khôi phục transcript từ host.
- History restoration ordering tests vẫn pass.

### Phase 3 — Multi-session webview management

- Thêm manager header/drawer và session list component trong `webview.ts`.
- Thêm active session, unread, status và pending permission badge.
- Thêm per-session draft/scroll persistence.
- Implement activation revision và snapshot replay.
- New Chat mới chỉ tạo nhiều local draft/session entries; chưa cần concurrent runtime ở bước đầu của phase.

Exit criteria:

- Switching không tạo VS Code tab.
- Không mất draft hoặc transcript khi chuyển nhanh.
- Stale delta bị bỏ qua.

### Phase 4 — Concurrent isolated runtimes

- Tạo runtime factory từ agent config.
- Mỗi started session có `ACPClient`, handlers và queue riêng.
- Lazy connect/new session khi gửi prompt.
- Bỏ confirmation/cancel khi New Chat.
- Guard chỉ chặn gửi prompt thứ hai trong cùng session.
- Thêm max concurrent session limit.

Exit criteria:

- Session A và B có thể cùng `running`.
- Stop A không stop B.
- Runtime A crash không kết thúc B.

### Phase 5 — Side-channel isolation and safety

- Tool/permission/metadata/context/plan per session.
- Diff/FileHandler per session và shared mutation coordinator.
- Terminal handler per runtime.
- Document sync router active-session only.
- Diff review/accept/rollback messages mang local session ID.

Exit criteria:

- Không có cross-session UI/tool/permission leakage.
- Rollback stale diff không overwrite file mới.
- Close session cleanup đủ.

### Phase 6 — History, commands and agent lifecycle

- Shared session catalog/store per agent.
- Load history thành open local session riêng.
- Select Agent đổi default cho New Chat, không kill running sessions.
- Rewire extension commands và status bar.
- Define Clear vs Close vs Delete History behavior.

Exit criteria:

- Load history trong khi A chạy không cancel A.
- History session đã mở chỉ switch, không reload.
- Agent change không dispose runtime hiện có.

### Phase 7 — Rollout and hardening

- Thêm setting `vscode-acp-chat.multiSession.enabled` để rollout.
- Khi disabled, orchestrator chạy single-session compatibility mode và ẩn manager.
- Manual profiling RAM/CPU/process count với 1–4 sessions.
- Manual matrix trên built-in agents và ít nhất một custom agent.
- Chỉ cân nhắc multiplex runtime sau khi có agent-specific evidence.

## Tests

Đặt feature tests dưới `src/test/features/multi-session.test.ts` và chỉ sửa existing tests khi behavior upstream thực sự thay đổi.

### Host/runtime tests

1. New Chat không gọi cancel khi A đang running.
2. A prompt chưa resolve, B vẫn tạo runtime và gửi prompt.
3. A/B updates xen kẽ được ghi đúng transcript.
4. Background session complete chuyển status và tăng unread.
5. Stop active/background gọi đúng ACP client.
6. Tool-call ID trùng giữa A/B không va chạm.
7. Permission inactive được queue đúng; response resolve đúng request.
8. Cancel/Close resolve pending permissions thành cancelled.
9. Runtime disconnect chỉ ảnh hưởng owner session.
10. Process limit chặn start mới nhưng không mất draft.
11. Dispose cleanup timer, queue, client, terminal và handler.

### Transcript/switching tests

1. Snapshot giữ đúng event order.
2. Chunk compaction không đổi nội dung.
3. Switch không gọi `session/load` cho open session.
4. Delta revision cũ không render sau khi switch.
5. Background output xuất hiện đầy đủ khi switch lại.
6. Webview ready/reload nhận full active snapshot.

### Webview tests

1. Session list render status/unread/permission badges.
2. Click session gửi `feature.multi-session.activate`.
3. New Chat gửi đúng custom message.
4. Snapshot reset và replay đúng transcript.
5. Input draft/mention chips và scroll được restore per session.
6. Send/Stop state phản ánh active session, không phải bất kỳ background session nào.
7. Permission dialog chỉ hiển thị cho active owner session.

### History/agent tests

1. Load history while A running không cancel A.
2. Open history session lần hai chỉ activate.
3. Shared catalog không tạo duplicate cache/store races.
4. Select Agent chỉ đổi default agent/new draft.
5. Session info title update đúng item.

### Filesystem/diff/terminal tests

1. Diff summary per session.
2. A và B sửa file khác nhau độc lập.
3. A và B sửa cùng file: diff cũ được đánh dấu stale/conflicted.
4. Rollback stale diff bị từ chối và không ghi file.
5. Close A không kill terminal B.

### Manual verification matrix

- Hai long-running prompt cùng agent.
- Hai prompt dùng hai agent khác nhau.
- Switch liên tục trong lúc cả hai stream.
- Background permission request.
- Background tool calls và terminal commands.
- Hai session sửa cùng file.
- Webview reload trong lúc session chạy.
- Close/cancel session đang chạy.
- Extension Host restart: xác nhận không hứa tiếp tục prompt, history vẫn load được nếu agent hỗ trợ.
- Quan sát child process/RAM với số session bằng giới hạn mặc định.

## Quality gates

Thứ tự xác minh khi implement:

```bash
npm run check-types
npm run lint
npm test
npm run package
```

Ngoài full suite, cần xác nhận production bundle không kéo `vscode` hoặc Node APIs vào webview bundle.

## Acceptance criteria

- New Chat từ session đang running hoàn tất ngay mà không hiển thị confirmation cancel.
- Có thể gửi prompt ở ít nhất hai session và cả hai cùng tiếp tục xử lý.
- Chuyển session không tạo VS Code tab hoặc webview mới.
- Chuyển lại background session hiển thị đầy đủ output đã sinh trong lúc không active.
- Nút Stop và manager Stop chỉ cancel session được chọn.
- Mode/model/config, plan, usage, tool call, permission, diff và errors không xuất hiện ở sai session.
- Session manager hiển thị chính xác Draft/Running/Needs permission/Idle/Error và unread.
- Close session giải phóng process/listener/timer/terminal của session đó mà không ảnh hưởng session khác.
- Same-file conflict không cho rollback âm thầm ghi đè thay đổi mới.
- Existing history, persistent session store và single-session workflow vẫn hoạt động.
- Typecheck, lint, test và production package pass.

## Risks and rollback

| Risk                                               | Mitigation                                                                    | Rollback                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Nhiều agent process tiêu thụ RAM/CPU/MCP resources | Lazy start, configurable hard limit, explicit Close, profiling                | Disable multi-session setting; compatibility mode chỉ cho một runtime      |
| Agent không chạy ổn ở nhiều process                | Per-agent manual matrix; isolate crash; log runtime owner                     | Giới hạn session về 1 cho agent đó hoặc disable feature                    |
| Background update render nhầm active session       | Host source of truth, local session ID, activation revision, stale-delta drop | Disable live delta; chỉ refresh bằng full snapshot khi switch              |
| Permission deadlock ở background                   | Manager badge, review action, per-session queue, cancel-on-close              | Auto-cancel permission sau policy timeout và đánh dấu session error        |
| Hai session sửa cùng file                          | Per-path serialization, hashes, stale/conflict state, safe rollback guard     | Disable rollback trên conflicted files; yêu cầu review thủ công            |
| Cache transcript tăng RAM                          | Compaction, per-session byte/event cap, close cleanup                         | Giảm cap; chỉ giữ completed-turn snapshots                                 |
| Shared globalState store race                      | Singleton catalog/store per agent                                             | Fallback agent list hoặc single control client                             |
| Refactor `ChatViewProvider` gây regression         | Phase compatibility mode, migrate state từng bước, giữ focused tests          | Disable multi-session behavior; revert phase riêng thay vì toàn bộ feature |
| Webview reload trong lúc stream                    | Host snapshot source of truth, sequence/revision                              | Re-request full snapshot khi phát hiện sequence gap                        |

## Rollout strategy

1. Merge integration seams và compatibility mode trước, chưa hiển thị manager.
2. Bật feature qua setting opt-in cho development builds.
3. Chạy automated tests và manual matrix với 1–4 sessions.
4. Bật mặc định sau khi process/resource và same-file conflict behavior đạt acceptance criteria.
5. Giữ `multiSession.enabled=false` như operational rollback trong ít nhất một release.
6. Chỉ mở work item single-process multiplex sau khi có evidence cụ thể theo từng agent.

## Revision history

| Date       | Author | Summary                                                                                                |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 2026-07-13 | Bytes  | Initial implementation plan based on current Extension Host, ACP client, webview and protocol analysis |
