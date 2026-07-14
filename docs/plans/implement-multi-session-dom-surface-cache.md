# Multi-Session Chat Surface DOM Cache Implementation Plan

| Attribute  | Value                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status     | Draft                                                                                                                                                                                                                                      |
| Owner      | TBD                                                                                                                                                                                                                                        |
| Phase      | Architecture and implementation planning                                                                                                                                                                                                   |
| Scope      | Chat webview transcript surface, multi-session snapshot replay, per-session DOM cache, cache invalidation, memory limits, tests                                                                                                           |
| References | `docs/plans/implement-concurrent-multi-session-chat.md`, `docs/plans/implement-split-session-manager-panel.md`, `src/features/multi-session/webview.ts`, `src/views/webview/main.ts`, `src/views/webview/component/message-list.ts` |

## Objective

Giảm lag khi chuyển qua lại giữa các ACP chat sessions bằng cách cache rendered DOM transcript theo session trong **cùng một chat webview**.

Hiện tại switching session làm:

```text
activate session
  -> receive full snapshot
  -> reset chat surface
  -> replay transcript events
  -> markdown parse / tool DOM rebuild / scroll restore
```

Plan này đổi thành:

```text
activate session
  -> save current surface state
  -> attach cached surface if available
  -> append only missing events if needed
  -> apply active side state
```

Mục tiêu:

- Switch lại session đã từng mở không replay toàn bộ transcript.
- Giữ chat view là một webview duy nhất, không tạo chat tab riêng cho từng session.
- Host vẫn là source of truth; DOM cache chỉ là render cache tạm trong lifetime của webview.
- MVP dùng lazy cache: background sessions không render live, chỉ catch up khi activate.
- Có memory cap và LRU eviction để tránh tăng RAM không kiểm soát.

## Non-goals

- Không tạo `WebviewPanel`/tab chat riêng cho từng session.
- Không thay thế `MultiSessionHostController` làm source of truth.
- Không persist DOM cache qua webview reload hoặc Extension Host restart.
- Không giải quyết triệt để markdown streaming quadratic rendering trong plan này, dù cache giảm replay lại markdown.
- Không cache full diff/plan panel DOM ở MVP; side panels vẫn active-only.
- Không implement ACP single-process multiplexing.

## Dependency and sequencing

Khuyến nghị thực hiện sau hoặc song song với:

1. [Split Multi-Session Manager Panel](./implement-split-session-manager-panel.md) — loại bỏ session-manager overlay/list khỏi chat webview.
2. Coalescing `sendState()` cho background session — tránh queue state spam chặn activate/snapshot.

DOM cache giải quyết replay transcript khi switch. Nếu manager overlay vẫn render full list theo mỗi background chunk, switching vẫn có thể lag vì bị nghẽn queue trước khi cache được attach.

## Current-state analysis

### Current webview shape

`WebviewController` hiện sở hữu một set component singleton:

```text
WebviewController
  ├─ MessageListComponent
  ├─ InputPanelComponent
  ├─ SessionToolbarComponent
  └─ AuxiliaryPanelsComponent
```

`MessageListComponent` hiện:

- nhận `MessageListElements` qua constructor hoặc fallback query global IDs `messages-container`, `messages`, `typing-indicator`, `welcome-view`;
- tự register handlers vào global `MessageRouter` trong constructor;
- sở hữu một `BlockManager`;
- giữ `currentAssistantMessage`, auto-scroll state, event listeners và available commands;
- xử lý `userMessage`, `streamStart`, `streamChunk`, `thoughtChunk`, `toolCallStart`, `toolCallComplete`, `streamEnd`.

`WebviewController.handleMessage()` dispatch mọi non-feature messages qua global router. Vì vậy nếu tạo nhiều `MessageListComponent` và tất cả tự register vào router, một `streamChunk` sẽ bị render vào nhiều surfaces. Đây là điểm cần refactor.

### Current multi-session replay

`MultiSessionWebviewController.applySnapshot()` hiện:

1. lưu draft/scroll của session cũ;
2. `bridge.reset()`;
3. replay từng transcript event qua `bridge.dispatch()`;
4. apply metadata/context/diff/permissions;
5. restore input/scroll.

Chi phí lớn nằm ở reset + replay + markdown parse + tool DOM rebuild. Session đã từng render vẫn bị render lại từ đầu.

## Key architecture decisions

### 1. Cache rendered transcript surface per local session

Mỗi `localSessionId` có thể có một `ChatSurfaceInstance`:

```ts
interface ChatSurfaceInstance {
  localSessionId: string;
  surfaceEpoch: number;
  rootEl: HTMLElement;
  messageList: MessageListComponent;
  lastSeq: number;
  scrollTop: number;
  inputHtml: string;
  generating: boolean;
  lastUsedAt: number;
  hydrated: boolean;
}
```

Surface chứa transcript DOM và `BlockManager` của session đó. Khi switch khỏi session, surface được detach/hidden, không clear.

### 2. MVP là lazy cache, không background live render

Inactive session updates vẫn được lưu ở Extension Host. Chat webview không render background deltas.

Khi activate session:

- nếu surface cache up-to-date: attach ngay;
- nếu surface cache thiếu events: append missing events từ snapshot hoặc event range;
- nếu cache invalid/evicted: rebuild từ snapshot.

Lý do chọn lazy trước:

- giảm CPU khi nhiều session stream đồng thời;
- tránh nhân markdown parsing khi user không nhìn session đó;
- implementation đơn giản hơn warm rendering;
- vẫn giảm mạnh switch lặp lại A ↔ B sau lần đầu.

### 3. Host remains source of truth

DOM cache là optimization. Host vẫn giữ:

- transcript events;
- active session id;
- sequence/revision;
- permission resolvers;
- runtime state;
- metadata/context/diff snapshots.

Nếu cache mất, webview request/resync snapshot từ host.

### 4. Cache only transcript in MVP

MVP cache:

- message DOM;
- block manager state;
- current assistant message state;
- per-surface scroll;
- per-surface last rendered seq.

MVP không cache:

- input component DOM — vẫn dùng one active input, draft lưu per session;
- session toolbar DOM — apply active metadata on switch;
- plan/diff/context panels — apply active side state on switch;
- permission dialog — active owner only.

### 5. Avoid global router multi-render

Cached `MessageListComponent` instances must not all self-register in the global router.

Add one of these patterns:

Preferred:

```ts
new MessageListComponent(ctx, {
  elements,
  chipRenderer,
  registerHandlers: false,
});
```

Then `ChatSurfaceInstance.dispatch(message)` calls `messageList.handleMessage(message)` directly.

Alternative: active-surface router proxy owns registration and delegates to current surface only.

### 6. LRU cache with hard limits

Do not keep surfaces forever.

Suggested defaults:

```ts
maxCachedSurfaces = 3;
maxCachedSurfaceApproxBytes = 20 * 1024 * 1024;
maxCachedEventsPerSurface = 5000;
```

Eviction policy:

- never evict active surface;
- evict least-recently-used idle surface first;
- prefer evict surfaces without pending permission/running status;
- fallback to snapshot replay when an evicted session is activated later.

## Target architecture

```text
WebviewController
  ├─ InputPanelComponent                  # single active input
  ├─ SessionToolbarComponent              # single active metadata toolbar
  ├─ AuxiliaryPanelsComponent             # single active plan/diff/context area
  └─ ChatSurfaceCache
       ├─ activeLocalSessionId
       ├─ hostEl: #chat-surface-host
       ├─ surface A
       │    ├─ rootEl
       │    ├─ MessageListComponent A
       │    └─ BlockManager A
       ├─ surface B
       │    ├─ rootEl
       │    ├─ MessageListComponent B
       │    └─ BlockManager B
       └─ surface C ...
```

Only the active surface is attached/visible under `#chat-surface-host`. Detached surfaces retain DOM and event listeners on their own root nodes.

## Proposed files and changes

```text
src/views/webview/component/
├── chat-surface.ts              # new ChatSurfaceInstance wrapper
├── chat-surface-cache.ts        # new LRU/cache manager
├── message-list.ts              # add registerHandlers option; make setup idempotent/disposable
└── webview-root.ts              # create surface host instead of singleton message-list root ownership

src/views/webview/
├── main.ts                      # bridge active surface APIs; permission dialog uses active surface
└── types.ts                     # surface/cache options and state types if needed

src/features/multi-session/
├── webview.ts                   # cache-aware applySnapshot/applyDelta
├── contracts.ts                 # add surfaceEpoch; optional event-range messages
└── host.ts                      # include surfaceEpoch; optional event range responder
```

## DOM structure

Current global IDs should remain for compatibility only until migration completes. New surfaces should avoid duplicate IDs.

Proposed generated surface DOM:

```html
<div id="chat-surface-host" class="chat-surface-host"></div>
```

Each cached surface:

```html
<section class="chat-surface" data-session-id="local-..." aria-label="Chat transcript">
  <div class="welcome-view surface-welcome">...</div>
  <div class="messages-container surface-messages-container">
    <div class="messages surface-messages" role="log"></div>
    <div class="typing-indicator surface-typing-indicator"></div>
  </div>
</section>
```

`MessageListElements` for each instance points to these generated elements.

## Protocol changes

### MVP: cache-aware existing snapshot

Keep existing `feature.multi-session.snapshot`, add optional `surfaceEpoch`:

```ts
interface MultiSessionSnapshot {
  type: "feature.multi-session.snapshot";
  activeLocalSessionId: string;
  activationRevision: number;
  surfaceEpoch: number;
  transcript: TranscriptEvent[];
  lastSeq: number;
  // existing metadata/context/diff/pendingPermissions/isGenerating
}
```

Webview logic:

```ts
if (surface exists && surface.epoch === msg.surfaceEpoch) {
  if (surface.lastSeq === msg.lastSeq) {
    attach(surface);
  } else if (surface.lastSeq < msg.lastSeq) {
    append events from msg.transcript where seq > surface.lastSeq;
    attach(surface);
  } else {
    rebuild from snapshot;
  }
} else {
  rebuild from snapshot;
}
```

This still sends full snapshot from host, but avoids DOM replay when cache is valid. It is the lowest-risk first step.

### Follow-up: event range protocol

After MVP is stable, avoid sending full transcript on activate when webview has a cache.

Webview can send:

```ts
interface MultiSessionRequestEventsMessage {
  type: "feature.multi-session.requestEvents";
  localSessionId: string;
  fromSeq: number;
  surfaceEpoch: number;
}
```

Host responds:

```ts
interface MultiSessionEventsMessage {
  type: "feature.multi-session.events";
  localSessionId: string;
  activationRevision: number;
  surfaceEpoch: number;
  events: TranscriptEvent[];
  lastSeq: number;
}
```

Fallback to full snapshot if:

- `fromSeq` is too old;
- transcript compaction removed required raw events;
- `surfaceEpoch` mismatches;
- sequence gap detected.

## Surface epoch and invalidation

Add `surfaceEpoch` per managed session, starting at `1`.

Increment epoch when:

- chat is cleared;
- transcript reset/rebuilt;
- compaction produces a representation that cannot append missing events safely;
- host intentionally invalidates render cache due to contract change.

Cache key is:

```text
localSessionId + surfaceEpoch
```

If epoch mismatches, webview disposes old surface and rebuilds from snapshot.

## Switching flows

### First activation of session B

```text
Host -> snapshot B lastSeq=120 epoch=1
Webview:
  create surface B
  dispatch snapshot transcript once
  surfaceB.lastSeq = 120
  attach B
  apply side state
```

### Switch B -> A where A cache is current

```text
Webview:
  save B scroll/input
Host -> snapshot A lastSeq=300 epoch=1
Webview:
  find surface A lastSeq=300 epoch=1
  attach A immediately
  apply side state only
  restore A scroll/input
```

No transcript replay.

### Switch to A where A cache is behind

```text
Host -> snapshot A lastSeq=380 epoch=1
Webview:
  find surface A lastSeq=300 epoch=1
  dispatch events seq 301..380 only
  surfaceA.lastSeq = 380
  attach A
```

### Cache evicted

```text
Host -> snapshot A
Webview:
  no surface A
  rebuild from snapshot
```

## Background rendering policy

### MVP: cold/lazy background surfaces

Rules:

- Ignore `feature.multi-session.delta` for inactive sessions as today.
- Do not render inactive transcript chunks.
- Use snapshot catch-up on activation.

### Optional later: warm one recent background surface

After lazy cache is stable, add optional setting:

```json
"vscode-acp-chat.multiSession.domCache.warmBackgroundSessions": 0
```

If enabled:

- warm only N most recent running inactive sessions;
- batch background events every 100–250ms;
- stop warming if render batch exceeds frame budget or backlog is too large;
- never warm diff/plan panels.

This is explicitly not part of MVP.

## Implementation plan

| Step | Description | Verification |
| ---- | ----------- | ------------ |
| 1 | Refactor `MessageListComponent` so handler registration is optional and setup handlers are idempotent/disposable. | Existing webview tests pass; one message renders once. |
| 2 | Add factory for generated `MessageListElements` without duplicate IDs. | Unit test can create two independent message lists. |
| 3 | Add `ChatSurfaceInstance` wrapping one generated transcript DOM + `MessageListComponent`. | Direct dispatch renders only into that surface. |
| 4 | Add `ChatSurfaceCache` with attach/detach, active lookup, LRU eviction, scroll storage and `lastSeq`. | Cache tests for reuse, attach, eviction. |
| 5 | Update `WebviewController` bridge methods (`resetChatState`, `handleMessage`, `getBlockManager`, scroll APIs) to operate on active surface. | Existing single-session behavior preserved. |
| 6 | Update `MultiSessionWebviewController.applySnapshot()` to reuse surface when `lastSeq`/`surfaceEpoch` allow it, and append only missing events. | Switching back to cached session does not call full reset/replay. |
| 7 | Add `surfaceEpoch` to host snapshot and increment on clear/reset. | Clear chat invalidates old surface. |
| 8 | Keep side-state apply active-only: metadata/context/diff/permissions still dispatch after surface attach. | Toolbar/diff/context match active session after switch. |
| 9 | Add memory limits and LRU eviction config/defaults. | More than max cached sessions evicts inactive LRU. |
| 10 | Add optional instrumentation behind debug flag for snapshot replay count, cache hit/miss, append-missing duration and surface count. | Manual profiling shows cache hit on A↔B switch. |
| 11 | Run quality gates, package and install extension. | Commands in Quality gates pass or blockers reported. |

## Detailed phases

### Phase 1 — Make transcript component multi-instance-safe

Changes:

- Add constructor option:

```ts
interface MessageListOptions {
  elements?: MessageListElements;
  chipRenderer: ChipRendererComponent;
  registerHandlers?: boolean;
}
```

- Default `registerHandlers` to `true` for compatibility.
- Cached surfaces pass `registerHandlers: false`.
- Make `setupCodeCopyHandler()`, `setupFileLinkHandler()`, `setupDiffHeaderClickHandler()`, and `setupScrollEventListeners()` safe to call once per instance.
- Add `dispose()` if listeners/timers need cleanup.
- Ensure pending animation frames are cancelled on dispose.

Exit criteria:

- Two `MessageListComponent` instances can exist without duplicate router rendering.
- A message dispatched to surface A does not appear in surface B.

### Phase 2 — Surface host and cache manager

Create `ChatSurfaceInstance`:

```ts
class ChatSurfaceInstance {
  readonly localSessionId: string;
  readonly rootEl: HTMLElement;
  readonly messageList: MessageListComponent;
  surfaceEpoch = 1;
  lastSeq = 0;
  lastUsedAt = Date.now();

  attach(hostEl: HTMLElement): void;
  detach(): void;
  clear(): void;
  dispatch(message: ExtensionMessage): Promise<void> | void;
  dispatchMany(events: TranscriptEvent[]): Promise<void>;
  dispose(): void;
}
```

Create `ChatSurfaceCache`:

```ts
class ChatSurfaceCache {
  getActive(): ChatSurfaceInstance | undefined;
  getOrCreate(localSessionId: string, epoch: number): ChatSurfaceInstance;
  activate(localSessionId: string, epoch: number): ChatSurfaceInstance;
  evictIfNeeded(): void;
  remove(localSessionId: string): void;
  clear(): void;
}
```

Exit criteria:

- Active surface can be swapped without clearing DOM.
- Detached surface retains message DOM and block manager state.

### Phase 3 — WebviewController bridge migration

`WebviewController` currently exposes `messageList` directly to features. Keep compatibility but route to active surface.

Required updates:

- `resetChatState()` clears active surface only unless a full reset is requested.
- `getBlockManager()` for permission dialog uses active surface message list.
- `messageList.getScrollTop()` / `setScrollTop()` in multi-session bridge map to active surface.
- Feature code that relies on `controller.messageList` should see active message list.
- On active surface change, update delegated handlers if needed.

Exit criteria:

- Single-session mode still behaves exactly as before.
- Permission dialog can find tool blocks in active cached surface.

### Phase 4 — Cache-aware multi-session snapshot

Update `MultiSessionWebviewController.applySnapshot()`:

1. Save current active surface scroll/input.
2. Activate/create target surface.
3. If cache current: skip transcript replay.
4. If cache behind and snapshot includes missing events: append missing only.
5. If cache invalid: clear/rebuild target surface from snapshot.
6. Apply metadata/context/diff/permission side state.
7. Restore input/scroll and generating state.

Pseudo:

```ts
private async applySnapshot(msg: MultiSessionSnapshot): Promise<void> {
  this.saveActiveSurfaceState();

  const surface = this.surfaceCache.activate(
    msg.activeLocalSessionId,
    msg.surfaceEpoch ?? 1
  );

  if (surface.surfaceEpoch !== (msg.surfaceEpoch ?? 1) || surface.lastSeq > msg.lastSeq) {
    await this.rebuildSurface(surface, msg.transcript, msg.lastSeq);
  } else if (surface.lastSeq < msg.lastSeq) {
    const missing = msg.transcript.filter((event) => event.seq > surface.lastSeq);
    if (missing.length === 0 && msg.lastSeq > surface.lastSeq) {
      this.requestResync();
      return;
    }
    await surface.dispatchMany(missing);
    surface.lastSeq = msg.lastSeq;
  }

  await this.applySideState(msg);
  this.restoreInputAndScroll(msg.activeLocalSessionId);
}
```

Exit criteria:

- Switch back to unchanged cached session does zero transcript dispatches.
- Switch back to behind cached session dispatches only missing events.

### Phase 5 — Host epoch and reset semantics

Add `surfaceEpoch` to `ManagedSession` or derive from transcript store.

Host increments epoch when:

- `clearActive()` clears transcript;
- loading history replaces transcript;
- future compaction invalidates append-only representation;
- session is closed/recreated with same local id, if ever allowed.

Snapshot includes epoch.

Exit criteria:

- Clear chat cannot accidentally show stale cached DOM.
- History load/reload cannot append to an incompatible old surface.

### Phase 6 — Memory and eviction

Add settings:

```json
"vscode-acp-chat.multiSession.domCache.maxSurfaces": {
  "type": "number",
  "default": 3,
  "minimum": 1
}
```

Optional later:

```json
"vscode-acp-chat.multiSession.domCache.maxApproxBytes": {
  "type": "number",
  "default": 20971520,
  "minimum": 1048576
}
```

MVP can use surface count only, then approximate byte budget later.

Exit criteria:

- Cache does not grow unbounded.
- Evicted session still reopens via normal snapshot replay.

### Phase 7 — Optional event range optimization

Only after MVP proves stable.

- Host keeps enough raw/compacted events to serve `fromSeq` range.
- Webview sends `requestEvents` on activation if it has valid cache.
- Host sends only missing events or fallback full snapshot.
- Keep full snapshot path as resync fallback.

Exit criteria:

- Activation of cached session avoids both full transcript DOM replay and full transcript postMessage payload.

## Tests

Place feature/component tests under existing test structure, preferably `src/test/features/multi-session-dom-cache.test.ts` plus focused webview component tests.

### Component tests

1. Two `MessageListComponent` instances with separate elements render independently.
2. `registerHandlers: false` prevents global router duplicate render.
3. `ChatSurfaceInstance.dispatchMany()` preserves event order.
4. `clear()` resets block manager and DOM only for that surface.
5. `dispose()` removes listeners/timers or makes them inert.

### Cache tests

1. `getOrCreate()` returns same surface for same session/epoch.
2. Epoch mismatch rebuilds/replaces old surface.
3. LRU eviction never evicts active surface.
4. Evicted surface disposal removes DOM.
5. Scroll/input state is saved and restored per session.

### Multi-session webview tests

1. First snapshot for session A dispatches all transcript events.
2. Second snapshot for unchanged A attaches cache and dispatches zero transcript events.
3. Snapshot where `lastSeq` is greater dispatches only missing events.
4. Snapshot with lower `lastSeq` or epoch mismatch rebuilds surface.
5. Delta for active session appends to active surface and advances `lastSeq`.
6. Stale revision delta is dropped.
7. `chatCleared`/clear active invalidates old surface.
8. Metadata/context/diff side state still updates active toolbar/panels after cached attach.

### Integration/manual tests

1. Start session A, stream long response, switch to B, switch back to A: second switch should not replay transcript from zero.
2. A and B both stream; manager closed; switching A↔B remains responsive after initial surface hydration.
3. Switch to a background session with many missing chunks: only missing events append, not full DOM rebuild.
4. Clear active chat then switch away/back: stale DOM does not reappear.
5. Open more sessions than cache limit: LRU evicts old surface; evicted session still rebuilds correctly.
6. Permission dialog still attaches to active session tool block.
7. Assistant turn navigation/copy buttons/file links still work on cached and reattached surfaces.
8. Webview reload loses DOM cache but restores active snapshot from host.

## Instrumentation

Behind `vscode-acp-chat.debug` or a more specific debug flag, log counters:

```text
multiSession.domCache.hit
multiSession.domCache.miss
multiSession.domCache.rebuild
multiSession.domCache.appendMissing.count
multiSession.domCache.evict
multiSession.applySnapshot.durationMs
multiSession.applySnapshot.transcriptDispatchCount
multiSession.surface.count
```

Do not log full transcript content.

## Quality gates

Because this changes webview and extension code, implementation must run:

```bash
npm run check-types
npm run lint
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-dom-surface-cache.vsix
code --install-extension .tmp/vscode-acp-chat-dom-surface-cache.vsix --force
```

If `vsce` or `code` is unavailable, report the blocker explicitly. Do not commit generated VSIX files.

## Acceptance criteria

- Re-activating a cached session with unchanged `lastSeq` does not call `bridge.reset()` or replay transcript events.
- Re-activating a cached session with newer transcript appends only events with `seq > surface.lastSeq`.
- Clearing/resetting a session invalidates its cached DOM via `surfaceEpoch`.
- DOM cache is bounded by configured max surfaces and evicts inactive LRU surfaces.
- Background sessions do not render live in MVP.
- Active stream rendering behavior remains unchanged.
- Permission dialog, code copy, file links, diff header clicks, scroll, prompt history, and assistant turn navigation still work for active cached surface.
- Webview reload still restores from host snapshot even though DOM cache is lost.
- Typecheck, lint, tests, production package and local install complete or blockers are reported.

## Risks and mitigations

| Risk | Mitigation | Rollback |
| ---- | ---------- | -------- |
| Multiple message lists accidentally render same message | `registerHandlers: false` for cached instances; direct dispatch through active surface only | Disable cache and use old single message list path |
| Duplicate DOM IDs break selectors | Generated surfaces use classes/data attributes, not repeated IDs | Keep one legacy surface until generated factory is stable |
| Detached surfaces keep too much memory | LRU max surfaces; dispose inactive surfaces; optional byte budget | Set max surfaces to 1, equivalent to no cache |
| Sequence mismatch causes duplicate/missing chunks | `lastSeq`, `surfaceEpoch`, resync fallback to full rebuild | Force rebuild on any gap |
| Permission dialog reads wrong block manager | Permission dialog gets active surface block manager dynamically | Fallback to snapshot rebuild before showing permission |
| Features assume singleton `controller.messageList` | Expose active message list facade; update features to use getter | Keep singleton path in single-session mode |
| Diff/markdown still freeze on large content | Cache reduces repeated replay only; keep separate lazy diff and markdown batching work | Disable cache for large sessions or force rebuild threshold |
| Webview reload loses cache | Expected; host snapshot source of truth restores active session | No rollback needed |

## Rollout strategy

1. Add component-level multi-instance support behind internal code paths, no behavior change.
2. Add cache manager but keep `maxSurfaces = 1` in development to prove compatibility.
3. Enable `maxSurfaces = 3` for multi-session feature only.
4. Add instrumentation and manually compare A↔B switch with long transcripts.
5. Keep setting to disable cache or reduce to one surface:

```json
"vscode-acp-chat.multiSession.domCache.maxSurfaces": 1
```

6. Only after stable, consider event range protocol and warm background rendering.

## Revision history

| Date       | Author | Summary                                                                                          |
| ---------- | ------ | ------------------------------------------------------------------------------------------------ |
| 2026-07-14 | Bytes  | Initial plan for lazy per-session transcript DOM surface cache inside the existing chat webview. |
