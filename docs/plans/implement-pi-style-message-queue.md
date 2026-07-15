# Implementation Plan: Pi-Style Message Queue for the Chat Composer

| Attribute            | Value                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status               | Proposed                                                                                                                                                             |
| Scope                | Composer keyboard behavior, per-session queue orchestration, legacy and multi-session hosts, bundled Pi adapter, tests, docs, packaging                              |
| Primary feature path | `src/features/message-queue/`                                                                                                                                        |
| References           | `src/views/webview/component/input-panel.ts`, `src/views/chat.ts`, `src/features/multi-session/host.ts`, `src/acp/client.ts`, `src/features/pi-agent/vendor/pi-acp/` |

## Objective

Bổ sung Pi Message Queue behavior cho chat composer để thao tác trong VS Code khớp Pi native TUI khi agent đang xử lý, đồng thời áp dụng được cho mọi agent được extension khởi chạy qua ACP.

Target keyboard behavior:

| Key           | Idle                                                    | Processing                                                 |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `Enter`       | Submit prompt bình thường                               | Queue steering message                                     |
| `Alt+Enter`   | Submit prompt bình thường                               | Queue follow-up message                                    |
| `Shift+Enter` | Insert newline                                          | Insert newline                                             |
| `Escape`      | Giữ nguyên behavior modal/autocomplete/composer hiện có | Abort current work và restore queued messages vào composer |
| `Alt+Up`      | No-op nếu không có queue                                | Restore queued messages vào composer, không abort          |

Feature phải hoạt động trên cả hai runtime path hiện có:

- default multi-session path qua `MultiSessionHostController`;
- legacy single-session fallback khi `vscode-acp-chat.multiSession.enabled=false` qua `ChatViewProvider`.

Repo hiện chỉ có một chat composer DOM trong retained `WebviewView`; không có editor-webview composer riêng. Trong plan này, “editor fallback” được hiểu là legacy single-session host fallback. Nếu sau này có editor webview thật, surface đó phải dùng lại cùng message-queue controller và contracts, không copy keyboard/queue logic.

## Current-State Analysis

### Composer hiện khóa submit khi agent đang chạy

`src/views/webview/component/input-panel.ts` hiện:

- lưu `isGenerating` trong `InputPanelComponent`;
- disable Send khi generating;
- `send()` return ngay khi generating;
- plain `Enter` chỉ gọi `send()` khi idle;
- `Shift+Enter` để browser chèn newline;
- `Escape` sau autocomplete sẽ clear composer;
- chưa xử lý `Alt+Enter` hoặc `Alt+Up`.

`src/views/webview/main.ts` lấy generation state từ `MessageListComponent` và truyền vào `InputPanelComponent`. Vì vậy composer đang đồng nhất hai khái niệm khác nhau:

- một assistant render turn đang stream;
- toàn bộ session vẫn đang processing, có thể còn queued work.

Message queue cần tách hai state này để composer vẫn ở processing mode xuyên suốt lúc queue đang drain, kể cả giữa hai ACP prompt turn liên tiếp.

### Cả hai host path đều drop busy submission

Legacy path trong `src/views/chat.ts`:

```text
sendMessage
  → handleUserMessage()
  → if (isGenerating) return
  → ACPClient.sendMessage()
```

Multi-session path trong `src/features/multi-session/host.ts`:

```text
sendMessage
  → sendActiveMessage()
  → if (session.isGenerating || session.sendInFlight) return
  → session.client.sendMessage()
```

Do đó thay đổi webview-only là không đủ. Queue phải có owner ở Extension Host để:

- không mất message sau khi webview reload/snapshot replay;
- serialize ACP prompts;
- quản lý abort/dequeue atomically;
- isolate queue theo local session;
- tiếp tục drain queue khi session đang chạy ở background.

### ACP v1 không có portable steering/follow-up API

Shared transport trong `src/acp/client.ts` chỉ dùng:

- `session/prompt` cho một complete prompt turn;
- `session/cancel` để cancel current prompt turn.

ACP v1 không định nghĩa chuẩn cho:

- mid-turn steering;
- follow-up queue;
- queue listing;
- queue dequeue/restore.

Vì vậy không thể hứa true Pi steering cho mọi generic ACP agent. Universal fallback có thể đảm bảo message không bị mất và được gửi theo thứ tự bằng các `session/prompt` tuần tự, nhưng steering fallback chỉ được dispatch sau khi current ACP prompt hoàn tất, không phải tại internal assistant/tool boundary của agent.

### Bundled Pi có native primitives nhưng adapter chưa expose đúng semantics

Pi RPC hiện hỗ trợ:

- `prompt` với `streamingBehavior: "steer" | "followUp"`;
- `steer`;
- `follow_up`;
- `queue_update`;
- `abort`.

Bundled adapter hiện chưa dùng các primitive này. `PiAcpSession` đang có adapter-owned `turnQueue` cho concurrent ACP prompts và chỉ bắt đầu queued prompt sau `agent_end`. Queue này:

- không phân biệt steering/follow-up;
- không match Pi native delivery boundary;
- sẽ tạo double queue nếu Extension Host cũng queue;
- không cung cấp exact `Alt+Up` restore.

Pi TUI restore queue bằng cách clear Pi session queues trước rồi đưa text về editor. Pi RPC hiện chưa expose atomic `drain_queue`/`clear_queue` trả lại queued payloads. Đây là blocker cho exact native `Alt+Up` và race-free Escape nếu queue đã được giao cho Pi subprocess.

## Goals

- Busy `Enter` và `Alt+Enter` không bị drop trên bất kỳ built-in agent nào.
- Queue được isolate theo session và tiếp tục hoạt động khi session chuyển background.
- Generic ACP agents nhận queued work qua serialized standard ACP turns, không nhận concurrent `session/prompt` requests.
- Bundled Pi dùng true native steering/follow-up khi adapter và Pi RPC advertise đủ capability.
- `Escape` và `Alt+Up` restore được plain text, command chips, mention chips, image chips và current unsent draft.
- Autocomplete/modal precedence và multiline editing không regression.
- Không có hai queue authorities cùng giữ undelivered message.
- UI thể hiện rõ queue hiện có và effective delivery mode.

## Non-Goals

- Không tuyên bố generic ACP fallback là true mid-turn steering.
- Không cancel current generic ACP turn để giả lập steering.
- Không gửi concurrent standard `session/prompt` requests tới agent chưa advertise native queue capability.
- Không thêm queue reorder, edit-in-place, drag/drop hoặc persistent queue qua VS Code restart trong MVP.
- Không thay đổi Pi `steeringMode`/`followUpMode` user settings; native Pi path phải tôn trọng settings hiện tại của Pi.
- Không redesign prompt-history navigation ngoài conflict handling với `Alt+Up`.
- Không tạo editor webview surface mới.

## Architecture Decisions

### 1. Một queue owner duy nhất cho mỗi session

Invariant bắt buộc:

> Mỗi thời điểm chỉ một layer được quyền giữ undelivered messages: Extension Host hoặc native agent adapter.

Hai ownership modes:

| Mode     | Owner          | Áp dụng                                                             |
| -------- | -------------- | ------------------------------------------------------------------- |
| `host`   | Extension Host | Mọi generic ACP agent và mọi agent thiếu complete native capability |
| `native` | Agent/adapter  | Bundled Pi hoặc future adapter advertise complete queue contract    |

Không dùng hybrid ownership như host giữ follow-up nhưng Pi giữ steering. Hybrid sẽ làm ordering, restore và cancellation không xác định.

### 2. Universal fallback nằm trên agent catalog

Queue orchestration đặt trên `ACPClient`, không hard-code theo từng built-in id. Vì mọi built-in và custom agent đều đi qua `ACPClient`, host-owned fallback tự áp dụng cho toàn catalog hiện tại và các built-in thêm sau này.

Không suy luận native support bằng `agentId === "pi"` vì:

- custom agent có thể override built-in Pi bằng cùng id;
- adapter version/capability có thể khác;
- future agents có thể implement cùng private contract.

Native support phải được negotiate từ connection capabilities.

### 3. Per-session `MessageQueueController`

Tạo feature mới:

```text
src/features/message-queue/
├── types.ts
├── host.ts
├── webview.ts
└── index.ts
```

`host.ts` cung cấp controller thuần TypeScript, không phụ thuộc DOM và chỉ nhận callbacks cho dispatch/cancel/state updates.

Proposed core types:

```ts
export type QueueIntent = "steer" | "followUp";
export type QueueOwnership = "host" | "native";

export interface ComposerPayload {
  text: string;
  images: string[];
  mentions: Mention[];
  composerHtml: string;
}

export interface QueuedComposerMessage {
  id: string;
  intent: QueueIntent;
  payload: ComposerPayload;
  createdAt: number;
}

export interface MessageQueueSnapshot {
  revision: number;
  ownership: QueueOwnership;
  processing: boolean;
  steering: QueuedComposerMessage[];
  followUp: QueuedComposerMessage[];
  effectiveSteering: "native" | "after-current-acp-turn";
}
```

Controller public API dự kiến:

```ts
submit(request: QueueSubmitRequest): Promise<QueueSubmitResult>;
abortAndRestore(): Promise<QueueRestoreResult>;
restoreQueuedWithoutAbort(): Promise<QueueRestoreResult>;
getSnapshot(): MessageQueueSnapshot;
```

Ownership placement:

- legacy mode: một controller thuộc `ChatViewProvider`/registered host feature;
- multi-session mode: mỗi `ManagedSession` có một controller;
- webview chỉ render snapshot và giữ presentation state, không là authoritative queue owner.

### 4. Hai logical queues, steering được ưu tiên

Match Pi semantics bằng hai FIFO queues:

- `steering`: FIFO trong nhóm steering;
- `followUp`: FIFO trong nhóm follow-up.

Khi chọn message tiếp theo:

1. dequeue steering trước;
2. nếu không còn steering thì dequeue follow-up.

Nếu follow-up đang chạy và user queue một steering message mới, steering mới được chọn sau current assistant/ACP turn trước các follow-up còn lại.

Khi restore vào composer, match Pi TUI:

1. toàn bộ steering theo enqueue order;
2. toàn bộ follow-up theo enqueue order;
3. current unsent composer draft;
4. phân cách từng message bằng `\n\n`.

### 5. Tách transcript turn state khỏi composer processing state

`streamStart`/`streamEnd` tiếp tục điều khiển transcript blocks và assistant actions.

Thêm authoritative queue/processing state riêng cho composer:

```text
host → webview: feature.message-queue.state
```

Composer processing chỉ chuyển idle khi:

- current ACP/native run đã kết thúc;
- không còn queued steering/follow-up;
- không còn dispatch đang start.

Điều này tránh idle flicker giữa queued turns và đảm bảo phím Enter tiếp tục được hiểu là steering trong toàn bộ queue-drain lifecycle.

### 6. Ack-based composer clearing

Không clear composer trước khi host xác nhận message đã được accepted.

Submission flow:

```text
webview creates requestId + payload + composerHtml
  → feature.message-queue.submit
  → host replies feature.message-queue.submitResult
  → accepted: clear only submitted composer content
  → rejected/ambiguous: keep or restore draft
```

Ack cần phân biệt:

- `dispatched`: idle prompt bắt đầu ngay;
- `queued`: busy prompt đã được queue;
- `rejected`: chưa accepted, safe to retry;
- `unknown`: transport outcome không rõ, không auto-resend để tránh duplicate.

`composerHtml` chỉ dùng cho local restore. Host không render hoặc execute HTML. Webview phải rehydrate/sanitize theo các chip types do extension tạo.

### 7. Minimal queue UI trong composer

Thêm một queue preview container gần input, hidden khi queue rỗng:

```text
Steering: <truncated prompt>
Follow-up: <truncated prompt>
Alt+Up to edit queued messages
```

MVP không có per-row remove/reorder buttons.

Processing toolbar:

- Stop vẫn visible;
- Send không bị disable chỉ vì processing;
- click Send trong processing tương đương busy `Enter`/steering;
- tooltip/ARIA label đổi thành `Queue steering message` khi processing;
- `Alt+Enter` vẫn là đường vào follow-up.

### 8. Capability-negotiated native queue contract

ACP supports `_meta` và custom methods bắt đầu bằng `_`. Bundled Pi adapter advertise private capability qua `agentCapabilities._meta`, ví dụ:

```json
{
  "vscode-acp-chat/messageQueue": {
    "version": 1,
    "enqueue": ["steer", "followUp"],
    "queueUpdates": true,
    "drain": true,
    "abortAndDrain": true
  }
}
```

Private ACP methods dự kiến:

```text
_vscode-acp-chat/message-queue/enqueue
_vscode-acp-chat/message-queue/drain
_vscode-acp-chat/message-queue/abort-and-drain
```

Native mode chỉ bật khi đủ toàn bộ contract:

- typed steer;
- typed follow-up;
- authoritative queue updates;
- atomic drain không abort;
- atomic abort-and-drain.

Thiếu bất kỳ capability nào thì session dùng host mode.

### 9. Pi RPC prerequisite

Để native mode support exact restore, Pi RPC cần command tương đương:

```ts
{
  type: "drain_queue";
  abort: boolean;
}
```

Expected response:

```ts
{
  steering: Array<{ id?: string; text: string; images?: ImageContent[] }>;
  followUp: Array<{ id?: string; text: string; images?: ImageContent[] }>;
}
```

Required semantics:

- atomically snapshot và remove pending queues;
- `abort:false` không dừng current run;
- `abort:true` clear queues và abort current run trong cùng serialized operation;
- preserve order;
- emit final `queue_update`.

Nếu Pi version hiện tại chưa có command này:

- universal host-owned queue vẫn được implement và release cho mọi agent, gồm Pi;
- true Pi native mode giữ disabled;
- adapter capability không advertise `drain`/`abortAndDrain`;
- không triển khai best-effort native dequeue có nguy cơ duplicate delivery.

## Effective Behavior by Agent Capability

| Agent capability                    | Busy `Enter`                                         | Busy `Alt+Enter`                                                            | `Escape`                                                               | `Alt+Up`                                                 |
| ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| Generic ACP / no private capability | Host queue; dispatch sau current ACP prompt          | Host follow-up queue; dispatch sau current ACP prompt và sau steering queue | Host atomically detaches queue, cancels current prompt, restores queue | Host atomically detaches và restores queue, không cancel |
| Complete native Pi capability       | Native Pi steering after current assistant/tool turn | Native Pi follow-up after agent finishes current work                       | Native abort-and-drain, restore exact queue                            | Native drain, restore exact queue, no abort              |
| Partial/old Pi capability           | Host fallback                                        | Host fallback                                                               | Host behavior                                                          | Host behavior                                            |

UI phải ghi rõ generic fallback khi cần, ví dụ:

```text
Queued for next ACP turn — this agent does not advertise native steering.
```

## Webview Keyboard Policy

Implement keyboard orchestration trong `src/features/message-queue/webview.ts`; `InputPanelComponent` chỉ expose minimal composer operations.

Event priority:

1. bỏ qua submit shortcut khi `event.isComposing`;
2. existing modal/autocomplete handler được quyền consume trước;
3. `Shift+Enter` luôn để insert newline, kể cả có `Alt`;
4. `Alt+Enter`;
5. plain `Enter`;
6. `Escape`;
7. `Alt+Up`.

### `Enter`

- idle: submit normal prompt;
- processing: submit intent `steer`;
- prevent default khi payload hợp lệ;
- clear sau accepted ack.

### `Alt+Enter`

- idle: submit normal prompt, không tạo follow-up queue;
- processing: submit intent `followUp`;
- prevent default khi payload hợp lệ.

### `Shift+Enter`

- không post message;
- không bị queue feature intercept;
- browser/contenteditable chèn newline như hiện tại.

### `Escape`

- autocomplete visible: chỉ close autocomplete;
- modal/dialog active: giữ existing modal behavior;
- idle: giữ nguyên composer behavior hiện có, không gọi cancel;
- processing:
  - không clear current unsent draft;
  - request `abortAndRestore`;
  - restore queued drafts trước current draft;
  - nếu queue rỗng vẫn abort và giữ current draft.

### `Alt+Up`

- queue rỗng: no-op, không ảnh hưởng prompt history;
- queue có item: request `restoreQueuedWithoutAbort`;
- current generation tiếp tục;
- restore queued drafts trước current draft;
- event phải `preventDefault()` và `stopPropagation()` sau khi feature nhận xử lý.

`PromptHistoryNavigationWebviewFeature` hiện đã reject `altKey`; giữ guard này và thêm regression test để bảo đảm `Alt+Up` không gọi history navigation.

## Host Queue State Machine

```text
IDLE
  └─ submit ─▶ STARTING ─▶ RUNNING

RUNNING
  ├─ busy Enter ─────▶ RUNNING_WITH_QUEUE[steering]
  ├─ busy Alt+Enter ─▶ RUNNING_WITH_QUEUE[followUp]
  ├─ Escape ─────────▶ ABORTING_AND_RESTORING
  └─ Alt+Up ─────────▶ RUNNING + queue detached/restored

RUNNING_WITH_QUEUE
  ├─ current turn ends + queue not empty ─▶ DRAINING ─▶ RUNNING
  ├─ queue empty + current turn ends ─────▶ IDLE
  └─ Escape ──────────────────────────────▶ ABORTING_AND_RESTORING
```

Queue item lifecycle:

```text
accepted
  → queued-host | queued-native
  → dispatching | consumed-native
  → completed

queued-host | queued-native
  → restoring
  → restored
```

Race rules:

- request and queue IDs được tạo trước transport call;
- queue controller serialize submit/drain/abort operations;
- restore transaction chỉ lấy items tồn tại tại revision bắt đầu transaction;
- submissions đến sau transaction start không bị restore nhầm;
- native queue updates dùng monotonic revision;
- unknown native acceptance không auto-resend;
- session switch chỉ đổi presentation, không đổi owner hoặc queue contents.

## Host-Owned Fallback Dispatch

For generic ACP agents:

1. chỉ một `session/prompt` được in flight mỗi session;
2. current prompt resolve;
3. wait `SessionNotification` queue idle;
4. finalize pending tool calls;
5. emit `streamEnd` cho turn vừa xong;
6. dequeue steering trước, rồi follow-up;
7. emit queued `userMessage` và `streamStart` tại thời điểm thực sự dispatch;
8. gọi standard `ACPClient.sendMessage()`;
9. giữ composer `processing=true` cho tới khi toàn bộ queue drain.

Không emit queued `userMessage` ngay lúc enqueue vì transcript sẽ thể hiện message như đã bắt đầu xử lý và có thể merge sai assistant blocks.

Nếu dispatch queued item fail:

- mark session error cho turn đó;
- giữ các item chưa dispatch trong queue;
- không loop retry vô hạn;
- expose recovery state để user dùng `Alt+Up` hoặc gửi lại.

## Native Pi Adapter Work

### Capability and custom ACP methods

Update bundled `pi-acp`:

- advertise private message-queue capability;
- implement `extMethod()` hoặc migrate adapter entrypoint sang SDK registration API để nhận custom ACP methods;
- validate params strictly;
- return explicit accepted queue item ids/revisions.

### Pi RPC process API

Extend `src/features/pi-agent/vendor/pi-acp/src/pi-rpc/process.ts`:

```ts
prompt(message, images, streamingBehavior?);
steer(message, images);
followUp(message, images);
drainQueue({ abort });
```

Forward `queue_update` into ACP `session_info_update._meta` or a namespaced custom notification with:

- queue revision;
- steering items;
- follow-up items;
- running state.

### Remove double queue

Refactor current `PiAcpSession.turnQueue`:

- native Crust queue submissions không đi qua `turnQueue`;
- concurrent untyped ACP prompt either uses compatibility FIFO for non-Crust clients or returns a clear busy error;
- compatibility FIFO không được active khi private native capability được negotiated;
- không tự start adapter-queued prompt sau `agent_end` trong native mode.

### Prompt completion

Adapter không được resolve root ACP prompt ở `agent_end` nếu Pi vẫn có native queued work sẽ tiếp tục run.

Settlement condition phải dựa trên:

- Pi không streaming;
- queue authoritative snapshot rỗng;
- queued updates đã flush;
- pending tool calls finalized.

Nếu Pi emits multiple `agent_end` events while follow-up queue drains, adapter chỉ resolve ACP prompt khi final idle condition đạt.

## Message Contracts

Proposed webview → host messages:

```ts
feature.message - queue.submit;
feature.message - queue.abortAndRestore;
feature.message - queue.restore;
feature.message - queue.ready;
```

Proposed host → webview messages:

```ts
feature.message - queue.state;
feature.message - queue.submitResult;
feature.message - queue.restoreResult;
```

Multi-session snapshot bổ sung queue snapshot của active session. Queue state của background sessions nằm trong host `ManagedSession`; khi activate, snapshot replay queue preview và processing state cùng transcript.

Older `sendMessage`/`stop` messages có thể giữ compatibility shim trong `ChatViewProvider`, nhưng composer mới phải route qua feature dispatcher thay vì thêm queue implementation vào core switch statement.

## Proposed File Changes

```text
src/features/message-queue/
├── types.ts                         # contracts, queue models, capability parser
├── host.ts                          # per-session queue controller
├── webview.ts                       # keyboard policy, preview UI, ack/restore
└── index.ts                         # public exports

src/features/register-host.ts        # register legacy/shared host feature
src/features/register-webview.ts     # register composer feature
src/views/webview/component/input-panel.ts
                                      # expose submit payload, processing UI, restore APIs
src/views/webview/main.ts             # smallest stable integration/wiring
src/views/webview/types.ts            # shared event/message types if needed
src/views/chat.ts                     # legacy queue dispatch/cancel integration only
src/acp/client.ts                     # capability parsing + custom ACP request helper
src/features/multi-session/contracts.ts
src/features/multi-session/host.ts    # one controller per ManagedSession
src/features/multi-session/webview.ts # queue snapshot/draft reconciliation
src/features/multi-session/types.ts

src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts
src/features/pi-agent/vendor/pi-acp/src/acp/session.ts
src/features/pi-agent/vendor/pi-acp/src/pi-rpc/process.ts
                                      # native queue capability and bridge

src/test/features/message-queue.test.ts
src/test/webview.test.ts
src/test/chat.test.ts
src/test/features/multi-session.test.ts
src/features/pi-agent/vendor/pi-acp/test/**

media/main.css                        # queue preview and processing buttons

docs/architecture/acp-chat-layout.md # queue preview + message flow

docs/features/feature-catalog.md      # durable behavior/capability fallback
```

## Implementation Phases

### Phase 0: Protocol spike and acceptance criteria lock

#### Task 0.1: Verify custom ACP extension method path

- Prove SDK `1.2.x` can send/handle methods beginning `_` through the current legacy connection APIs.
- Add a minimal round-trip test before building queue semantics.
- Finalize method names, capability namespace, parsers and error mapping.

Acceptance criteria:

- [ ] Custom request round trip works through bundled adapter transport.
- [ ] Unknown method returns method-not-found without breaking connection.
- [ ] Capability parser defaults safely to host mode.

#### Task 0.2: Verify Pi RPC queue lifecycle

- Record event order for steer, follow-up, `queue_update`, `turn_end`, `agent_end`, abort and compaction.
- Confirm installed/supported Pi version behavior.
- Determine whether atomic drain exists; if not, define upstream dependency/version gate.

Acceptance criteria:

- [ ] Event ordering tests or fixtures exist.
- [ ] Native mode blocker is explicit.
- [ ] No partial native capability is accidentally enabled.

### Phase 1: Universal host-owned queue engine

#### Task 1.1: Implement pure `MessageQueueController`

- Two typed FIFO queues.
- Serialized submit/restore/abort operations.
- Queue revisions and snapshots.
- Dispatch callbacks and error recovery.

Acceptance criteria:

- [ ] No concurrent dispatch.
- [ ] Steering priority and per-queue FIFO pass unit tests.
- [ ] `Alt+Up`-equivalent drain does not cancel.
- [ ] Escape-equivalent abort-and-drain returns exact items.

#### Task 1.2: Add generic ACP fallback scheduler

- Dispatch queued items only after current ACP prompt and notification pipeline finish.
- Keep processing true across turns.
- Stop draining after error and preserve remaining queue.

Acceptance criteria:

- [ ] Busy submits are accepted instead of dropped.
- [ ] Generic agents receive one prompt at a time.
- [ ] Queued transcript entries appear only at dispatch time.

### Phase 2: Composer keyboard and queue UI

#### Task 2.1: Extract minimal composer APIs

Add APIs for:

- collect structured payload without dispatch;
- read/write safe draft HTML;
- clear only after ack;
- set processing state;
- render Send and Stop together while processing;
- restore multiple drafts and move caret to end.

Acceptance criteria:

- [ ] Existing mention/image/command serialization remains intact.
- [ ] Existing send click and idle keyboard behavior remain compatible.

#### Task 2.2: Implement keyboard policy

- Capture processing-aware Enter/Alt+Enter/Escape/Alt+Up.
- Preserve Shift+Enter, IME and autocomplete/modal precedence.
- Prevent conflict with prompt history.

Acceptance criteria:

- [ ] Target behavior table passes JSDOM tests.
- [ ] Idle Escape behavior is unchanged.
- [ ] Busy Escape does not clear current draft before host response.

#### Task 2.3: Add queue preview and accessibility

- Render steering/follow-up rows.
- Update ARIA live status and button labels.
- Hide preview when empty.

Acceptance criteria:

- [ ] Keyboard-only workflow is discoverable.
- [ ] Long queue messages truncate visually without losing full restore data.

### Phase 3: Legacy and multi-session integration

#### Task 3.1: Integrate legacy host path

- Replace `isGenerating` busy drop with controller submission.
- Route Stop/Escape through abort-and-restore.
- Publish queue state and acknowledgements.

Acceptance criteria:

- [ ] `multiSession.enabled=false` supports all target keys.
- [ ] New chat/agent switch clears or safely recovers queue according to confirmation flow.

#### Task 3.2: Add one queue controller per `ManagedSession`

- Store controller in `ManagedSession`.
- Allow background queues to drain.
- Scope cancel/restore to selected local session.
- Include queue snapshot in active session snapshot.

Acceptance criteria:

- [ ] Session A/B queues never mix.
- [ ] Switching sessions restores each queue preview and composer draft.
- [ ] Background processing remains correctly reported.

#### Task 3.3: Reconcile multi-session drafts

- Queue ack clears only submitted active draft.
- Final snapshot cannot overwrite current unsent draft or restore result.
- Rich queued HTML is keyed by queue item id/revision.

Acceptance criteria:

- [ ] Existing multi-session input-draft preservation tests remain green.
- [ ] Escape/Alt+Up restore survives snapshot replay.

### Phase 4: Bundled Pi native capability

#### Task 4.1: Add private ACP queue capability and methods

- Advertise complete contract only when underlying Pi RPC supports atomic drain.
- Add strict request/response types and tests.

#### Task 4.2: Bridge typed queue operations to Pi RPC

- Map steering and follow-up with images.
- Forward authoritative queue updates.
- Respect Pi delivery modes.

#### Task 4.3: Eliminate double queue and fix settlement

- Isolate/remove adapter FIFO for native Crust sessions.
- Do not resolve root prompt before Pi final idle/empty queue.

Acceptance criteria:

- [ ] Busy Enter reaches Pi as true steer.
- [ ] Busy Alt+Enter reaches Pi as true follow-up.
- [ ] Native Alt+Up drains without abort and cannot later deliver restored messages.
- [ ] Native Escape drains and aborts atomically.
- [ ] Partial/old Pi versions remain on host fallback.

### Phase 5: Documentation, verification and rollout

#### Task 5.1: Update durable docs

- Update `docs/architecture/acp-chat-layout.md` in the same change because composer layout/message flow changes.
- Update `docs/features/feature-catalog.md` with keyboard behavior and capability fallback.
- Document generic ACP semantic limitation explicitly.

#### Task 5.2: Quality gates and local install

Run in project-defined order:

```bash
npm run check-types
npm run lint
npm test
npm run package
npx vsce package --out /tmp/vscode-acp-chat-message-queue.vsix
code --install-extension /tmp/vscode-acp-chat-message-queue.vsix --force
```

Also run bundled Pi adapter tests and package-content checks.

Manual verification matrix:

- generic built-in agent in multi-session mode;
- generic built-in agent in legacy mode;
- bundled Pi host fallback on old/partial capability;
- bundled Pi native mode on complete capability;
- two concurrent local sessions with independent queues;
- rich mentions/images/commands;
- autocomplete and permission modal active;
- queue restore during active tool execution.

After install, run `Developer: Reload Window`.

## Test Matrix

### Webview

- [ ] Idle Enter submits normal prompt.
- [ ] Processing Enter submits steering intent.
- [ ] Idle Alt+Enter submits normal prompt.
- [ ] Processing Alt+Enter submits follow-up intent.
- [ ] Shift+Enter never submits.
- [ ] IME composing Enter never submits prematurely.
- [ ] Autocomplete Enter/Escape has priority.
- [ ] Processing Escape requests abort-and-restore and keeps current draft.
- [ ] Alt+Up with empty queue is no-op.
- [ ] Alt+Up with queue restores without Stop/cancel message.
- [ ] Alt+Up does not trigger prompt-history navigation.
- [ ] Queue restore preserves mention, command and image chip metadata.
- [ ] Submit rejection restores exact draft.

### Host queue controller

- [ ] Steering FIFO.
- [ ] Follow-up FIFO.
- [ ] Steering priority over remaining follow-ups.
- [ ] No concurrent ACP prompts.
- [ ] Queue remains recoverable after dispatch failure.
- [ ] Abort-and-restore serialized against new submits.
- [ ] Unknown acceptance does not duplicate delivery.

### Multi-session

- [ ] Queue state isolated per local session.
- [ ] Background session drains without corrupting active transcript.
- [ ] Stop targets selected session only.
- [ ] Session switch snapshot restores correct queue and draft.
- [ ] Final snapshot does not erase current or recovered input.
- [ ] Close/dispose clears timers/controllers without cross-session effects.

### Bundled Pi adapter

- [ ] Capability advertised only with complete underlying support.
- [ ] Custom ACP methods validate params and session id.
- [ ] Steer/follow-up include images.
- [ ] Queue update revisions are monotonic.
- [ ] Duplicate message text reconciles safely.
- [ ] Drain removes messages before response.
- [ ] Abort-and-drain is atomic.
- [ ] Root ACP prompt stays open until final Pi idle and empty queue.
- [ ] Compatibility FIFO cannot coexist with native queue ownership.

## Rollout Strategy

1. Ship host-owned queue behavior first for all agents.
2. Keep native capability disabled unless complete contract is advertised.
3. Add debug log showing selected ownership and fallback reason when `vscode-acp-chat.debug=true`.
4. Enable native Pi automatically only after atomic Pi RPC drain is available and tested.
5. Do not add an agent-id allowlist; capability negotiation remains the source of truth.

## Risks and Mitigations

| Risk                                                     | Impact | Mitigation                                                                               |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Generic users hiểu fallback steering là true Pi steering | High   | Expose effective delivery mode and document ACP limitation.                              |
| Double queue giữa host và Pi adapter                     | High   | Enforce one-owner invariant and capability-gated native mode.                            |
| Queue restore race với Pi consuming message              | High   | Require atomic drain; disable partial native mode.                                       |
| Composer draft bị mất do optimistic clear                | High   | Ack-based clear and request-id recovery copy.                                            |
| Snapshot replay ghi đè restored draft                    | High   | Queue revision + active-session draft reconciliation.                                    |
| `streamEnd` làm composer flicker idle giữa queued turns  | Medium | Separate queue processing state from transcript generation state.                        |
| Error loop tự retry queued prompt vô hạn                 | Medium | Stop drain after failure; retain remaining items for manual recovery.                    |
| Rich HTML restore gây unsafe DOM                         | Medium | Store extension-generated HTML only; sanitize/rehydrate known chips.                     |
| Prompt history conflict với `Alt+Up`                     | Medium | Queue feature consumes modifier chord; keep history `altKey` guard and test.             |
| Pi version không có atomic queue drain                   | High   | Release universal host fallback; native mode remains disabled until prerequisite exists. |

## Open Questions

- Tên final của private ACP namespace có nên dùng `_vscode-acp-chat/...` hay domain-owned namespace khác? Recommendation: `_vscode-acp-chat/message-queue/*` và capability key `vscode-acp-chat/messageQueue`.
- Queue preview hiển thị full rows hay chỉ count? Recommendation: truncated rows giống Pi TUI, không thêm action buttons trong MVP.
- Stop button có phải luôn tương đương Escape processing? Recommendation: có; background manager Stop lưu recovered queue draft theo session để user thấy khi activate lại.
- Queue có persist qua Extension Host restart không? Recommendation: không trong MVP; giữ in-memory theo runtime session và ghi rõ limitation.
- Nếu generic agent trả response nhưng còn out-of-band work riêng, lúc nào được coi là idle? Recommendation: theo ACP `session/prompt` completion vì đó là portable boundary duy nhất.

## Definition of Done

- Mọi built-in agent nhận busy composer messages thay vì drop.
- Generic agents drain queue bằng serialized ACP prompts với limitation được hiển thị rõ.
- Complete-capability Pi dùng native steer/follow-up và exact queue restore.
- Escape và Alt+Up preserve queued rich drafts và current unsent draft.
- Multi-session và legacy single-session đều pass behavior matrix.
- Không có concurrent generic ACP prompts hoặc double queue ownership.
- Typecheck, lint, tests, production package, VSIX package và local install hoàn tất.
- Architecture layout và feature catalog được cập nhật cùng implementation.
