# Split Multi-Session Manager Panel Implementation Plan

| Attribute  | Value                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented; superseded by Activity Bar manager view follow-up                                                                                                                                                                                                                                 |
| Owner      | TBD                                                                                                                                                                                                                                         |
| Phase      | Completed implementation                                                                                                                                                                                                                    |
| Scope      | Extension Host multi-session controller, chat webview integration, dedicated session-manager webview panel, message contracts, performance throttling, tests                                                                                |
| References | `docs/plans/implement-concurrent-multi-session-chat.md`, `docs/plans/implement-session-manager-activity-bar-toggle.md`, `src/features/multi-session/host.ts`, `src/features/multi-session/webview.ts`, `src/features/multi-session/contracts.ts`, `src/views/chat.ts`, `src/views/webview/main.ts` |

## Objective

Tách màn quản lý session khỏi chat webview hiện tại để giảm lag khi chạy nhiều ACP sessions đồng thời.

Mục tiêu UI:

- Chat view hiện tại chỉ giữ vai trò **active session detail**: transcript, input, toolbar, plan/context/diff của session đang active.
- Session Manager chuyển sang một **VS Code `WebviewPanel`/tab riêng** để quản lý danh sách session, background status, permission, stop/close/open/load history.
- Thêm đường tắt chuyển nhanh bằng **QuickPick** hoặc popup nhẹ, không render full manager trong chat webview.
- Không tạo một chat webview/tab riêng cho từng session trong giai đoạn này.

Mục tiêu hiệu năng:

- Background session streaming không được buộc chat webview rebuild danh sách session theo từng token.
- Chat webview không nhận full session list nếu manager panel không mở.
- Manager panel nhận summary nhẹ, có throttle/coalescing riêng.
- Switching vẫn dùng active snapshot/delta nhưng phải giảm queue backlog từ session-manager traffic.

## Current-state summary

Multi-session hiện đã được đưa vào feature riêng dưới `src/features/multi-session/`:

- `MultiSessionHostController` trong `host.ts` là source of truth cho `sessions`, `activeLocalSessionId`, transcript, status, permission, diff và runtime.
- `MultiSessionWebviewController` trong `webview.ts` đang chạy trong cùng chat webview, tạo header + full-screen overlay manager bằng DOM.
- `feature.multi-session.state` hiện gửi `sessions` đầy đủ, aggregate, agents, selected agent và `managerOpen` cho chat webview.
- `applyState()` trong `webview.ts` luôn gọi `renderHeader()`, `renderOverlay()`, `renderLoading()` và `persistState()` khi nhận state.
- `append()` trong host gọi `sendState()` cho mỗi background render event để tăng unread/status.
- Host và webview đều đi qua queue tuần tự, nên `state`/overlay render backlog có thể chặn snapshot/delta của active chat.

Vấn đề chính: manager overlay tuy có thể hidden nhưng vẫn cùng bundle, cùng message channel, cùng DOM thread và cùng persisted state path với chat surface. Khi hai session stream đồng thời, traffic của manager ảnh hưởng trực tiếp đến chat detail.

## Target architecture

```text
Extension Host
  └─ MultiSessionHostController  (source of truth)
       ├─ active session snapshot/delta channel
       │    └─ Chat WebviewView
       │         ├─ transcript of active session only
       │         ├─ compact active aggregate badge only
       │         └─ no full session manager DOM
       │
       ├─ manager summary channel
       │    └─ Session Manager WebviewPanel
       │         ├─ session list / filters / actions
       │         ├─ no transcript replay
       │         ├─ no markdown rendering
       │         └─ throttled lightweight patches
       │
       └─ quick switch command
            └─ VS Code QuickPick using latest host summary
```

Decision:

- Use one shared `MultiSessionHostController` instance for both chat view and manager panel.
- Chat webview remains the only transcript/detail surface.
- Manager panel is a separate feature entry under `src/features/multi-session/`, not a copied chat implementation.
- Manager panel never receives transcript events or full diff text.
- QuickPick is native host UI for fast activation; it does not need a webview.

## UX decision

### Chat view

Keep current chat layout mostly unchanged.

Chat view may retain only a small status strip/header:

```text
[Sessions: 4 · Running 2 · Waiting 1 · Unread 8]  Active title  [Switch] [Manager]
```

Allowed actions in chat view:

- New Chat.
- Quick Switch.
- Open Session Manager.
- Stop active session.
- Send message to active session.

Not allowed in chat view after this split:

- Full session list rendering.
- Manager overlay with all rows/actions.
- Full agents/status panel unrelated to active detail.

### Session Manager panel

Open through `vscode-acp-chat.manageSessions`.

Suggested panel title: `ACP Sessions`.

Layout:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ACP Sessions                                      [+ New] [Refresh]  │
│ Running 2 · Waiting 1 · Unread 8 · Open 5                            │
├──────────────────────────────────────────────────────────────────────┤
│ Filter: [All v] [agent/status text search.........................] │
├──────────────────────────────────────────────────────────────────────┤
│ ! Fix flaky test                                                     │
│   Needs permission · Pi · 2 unread · Diffs 1 · /repo                 │
│   [Review] [Open Chat] [Stop]                                        │
├──────────────────────────────────────────────────────────────────────┤
│ ● Refactor auth API                                      Active      │
│   Running · Claude · 00:42 · Diffs 2                                 │
│   [Open Chat] [Stop]                                                 │
├──────────────────────────────────────────────────────────────────────┤
│ ○ Investigate SQL query                                              │
│   Idle · updated 5m ago                                              │
│   [Open Chat] [Close]                                                │
└──────────────────────────────────────────────────────────────────────┘
```

Behavior:

- `Open Chat`: activates the session in the existing chat view, focuses chat view, does not close manager unless user setting says so.
- `Review`: activates owner session, focuses chat view, opens permission UI for that session.
- `Stop`: cancels selected session without switching if possible; row status updates in manager.
- `Close`: disposes selected open session/runtime, does not delete history.
- `New`: creates draft and activates it in chat view.
- `Delete history` remains a distinct destructive action, not part of close.

### Quick switch

Command: `vscode-acp-chat.switchSession` or reuse manager command with modifier later.

Use native `showQuickPick()` with lightweight items:

```text
! Fix flaky test       Needs permission · 2 unread · Pi
● Refactor auth API    Running · Active · Claude
○ Investigate SQL      Idle · 5m ago
◌ Untitled chat        Draft
```

On selection:

1. Host activates selected local session.
2. Chat view is focused.
3. Chat webview receives active snapshot.
4. Manager panel, if open, receives patched active marker.

## Message contract changes

Keep existing prefix `feature.multi-session.`.

### Chat channel messages

Chat webview should only receive:

- `feature.multi-session.chatState`
- `feature.multi-session.snapshot`
- `feature.multi-session.delta`
- targeted permission/render messages for active owner session only

Proposed `chatState`:

```ts
interface MultiSessionChatStateMessage {
  type: "feature.multi-session.chatState";
  enabled: boolean;
  activeLocalSessionId?: string;
  activationRevision: number;
  active?: MultiSessionListItem;
  aggregate: {
    open: number;
    running: number;
    awaitingPermission: number;
    unread: number;
  };
}
```

Rules:

- No `sessions: MultiSessionListItem[]` in chat state.
- No `agents` list unless active toolbar needs it. Prefer existing session metadata messages for active session.
- No `managerOpen` in chat persisted state.
- Chat state can be sent immediately for active status transitions, but background-only unread/status changes should be coalesced.

### Manager channel messages

Manager panel receives:

- `feature.multi-session.managerState`
- `feature.multi-session.managerPatch` optional follow-up optimization
- `feature.multi-session.managerReady`
- `feature.multi-session.managerClose`

Proposed initial state:

```ts
interface MultiSessionManagerStateMessage {
  type: "feature.multi-session.managerState";
  revision: number;
  activeLocalSessionId?: string;
  sessions: MultiSessionListItem[];
  aggregate: {
    open: number;
    running: number;
    awaitingPermission: number;
    unread: number;
  };
  agents: MultiSessionAgentOption[];
  selectedAgentId: string;
}
```

Optional patch:

```ts
interface MultiSessionManagerPatchMessage {
  type: "feature.multi-session.managerPatch";
  revision: number;
  upserts: MultiSessionListItem[];
  removals: string[];
  activeLocalSessionId?: string;
  aggregate: MultiSessionManagerStateMessage["aggregate"];
}
```

Rules:

- Manager messages contain summaries only.
- Do not include transcript, `pendingPermissions` render payloads, `diffChanges.oldText/newText`, markdown, tool content, or terminal output.
- For large lists, patch by `localSessionId` instead of replacing all rows every tick.
- Manager panel may request full state on ready/resync.

### Host action messages

Reuse or add:

```ts
type MultiSessionManagerHostMessage =
  | { type: "feature.multi-session.managerReady" }
  | { type: "feature.multi-session.activate"; localSessionId: string; focusChat?: boolean }
  | { type: "feature.multi-session.new"; focusChat?: boolean }
  | { type: "feature.multi-session.stop"; localSessionId?: string }
  | { type: "feature.multi-session.close"; localSessionId: string }
  | { type: "feature.multi-session.reviewPermission"; localSessionId: string }
  | { type: "feature.multi-session.managerResync" };
```

## Proposed files

```text
src/features/multi-session/
├── host.ts                         # existing source of truth; split channels and coalescing
├── contracts.ts                    # split chat/manager contracts
├── webview.ts                      # chat-view integration only: header/status/snapshot/delta
├── manager-panel.ts                # extension-host owner of WebviewPanel lifecycle
├── manager-webview.ts              # browser DOM for Session Manager panel
├── manager-styles.ts               # panel-specific CSS
├── quick-switch.ts                 # native QuickPick session switch command helper
├── types.ts
└── index.ts
```

Core integration:

| File | Change |
| ---- | ------ |
| `src/features/register-host.ts` | Register `MultiSessionHostController` plus manager panel controller or expose shared controller to it. |
| `src/features/register-webview.ts` | Keep chat webview registration, but it should no longer create manager overlay DOM. |
| `src/views/chat.ts` | `manageSessions()` opens panel instead of toggling in-chat overlay; chat bridge unchanged for transcript replay. |
| `src/extension.ts` | Command `vscode-acp-chat.manageSessions` opens manager panel; optional new `switchSession` command uses QuickPick. |
| `package.json` | Add optional `switchSession` command and view-title/command-palette entries. No separate contributed view required if using `WebviewPanel`. |
| `esbuild.js` | Add browser bundle for `manager-webview.ts` unless manager HTML reuses `dist/webview.js` with mode flag. Prefer separate bundle. |

## Host architecture changes

### 1. Split outbound sinks

Current `MultiSessionHostController` has one `post` function for chat webview.

Add explicit sinks:

```ts
interface MultiSessionSinks {
  postChat(message: Record<string, unknown>): void;
  postManager?(message: Record<string, unknown>): void;
  focusChat?(): Thenable<void> | void;
}
```

Or keep `postChat` in the controller and let `SessionManagerPanelController` subscribe to controller events.

Preferred approach: event subscription, to avoid host controller owning VS Code panel lifecycle.

```ts
interface MultiSessionHostEvents {
  onDidChangeChatState(listener: (state: ChatState) => void): Disposable;
  onDidChangeManagerState(listener: (state: ManagerState) => void): Disposable;
  onDidChangeManagerPatch(listener: (patch: ManagerPatch) => void): Disposable;
}
```

The current direct `post()` remains for active chat snapshot/delta, but manager panel uses an event emitter and its own `webview.postMessage()`.

### 2. Coalesce state updates

Replace immediate `sendState()` calls with intent-specific methods:

```ts
private sendChatStateNow(): void;
private scheduleChatState(reason: "aggregate" | "active" | "background"): void;
private sendManagerStateNow(): void;
private scheduleManagerState(reason: "row" | "aggregate" | "bulk"): void;
```

Policy:

| Event | Chat state | Manager state |
| ----- | ---------- | ------------- |
| Active session switch | immediate | immediate or patch |
| Active session status change | immediate | throttled <= 100ms |
| Background token/chunk | throttled, aggregate only | throttled 250ms |
| Background status transition | immediate aggregate if running/waiting changes | throttled <= 100ms |
| Permission request | immediate aggregate | immediate/near-immediate row patch |
| Close/new/delete | immediate | immediate |

Minimum implementation:

- Use one timer for chat state and one timer for manager state.
- Coalesce all background append updates within 150–250ms.
- `snapshot` and `delta` remain independent from manager state.

### 3. Keep transcript routing active-only

`append()` should become:

```ts
private append(session: ManagedSession, message: SessionRenderMessage): void {
  const event = session.transcript.append(message);
  this.touch(session);

  if (session.localSessionId === this.activeLocalSessionId) {
    this.postChatDelta(event);
    this.scheduleChatState("active");
  } else {
    session.unreadCount += 1;
    this.scheduleChatState("background");
    this.scheduleManagerState("row");
  }
}
```

Do not send manager summaries through the chat webview.

### 4. Add manager lifecycle

`SessionManagerPanelController` responsibilities:

- Create/reveal/dispose `WebviewPanel`.
- Render manager HTML with CSP and `dist/session-manager-webview.js`.
- Attach message listener for manager actions and delegate to `MultiSessionHostController`.
- Subscribe to host manager state events only while panel exists.
- On panel ready, send full `managerState`.
- Dispose subscriptions when panel closes.

Panel options:

```ts
{
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [extensionUri]
}
```

Use `retainContextWhenHidden` cautiously: panel should keep filter/search UI, but manager state must still resync on reveal/ready.

### 5. Focus and activation behavior

Host actions need focus policy:

- `activate(localSessionId, { focusChat: true })` from manager/QuickPick focuses `vscode-acp-chat.chatView` after activation.
- Activation sends chat state + snapshot to chat webview if attached.
- If chat view is not attached yet, focusing it will attach, then ready handshake gets latest snapshot.
- Manager panel remains open unless action explicitly closes it.

## Webview architecture changes

### Chat webview (`webview.ts`)

Remove or disable:

- `overlay` DOM.
- full session list rows.
- `managerOpen` state.
- `renderOverlay()` from `applyState()` path.
- persisted drawer open/closed state.

Keep or replace:

- Small header/status strip.
- `applySnapshot()` and `applyDelta()`.
- draft/scroll persistence per session.
- active state rendering.

`applyChatState()` should do minimal DOM work:

```ts
private applyChatState(msg: MultiSessionChatStateMessage): void {
  this.header.hidden = !msg.enabled;
  this.activeLocalSessionId = msg.activeLocalSessionId;
  this.activationRevision = msg.activationRevision;
  this.active = msg.active;
  this.aggregate = msg.aggregate;
  this.renderHeaderOnly();
  this.persistDraftStateIfNeeded();
}
```

Avoid calling `persistState()` for pure aggregate changes unless active session/draft/scroll changed.

### Manager webview (`manager-webview.ts`)

Independent browser entry.

Responsibilities:

- Receive `managerState`/`managerPatch`.
- Maintain local `Map<localSessionId, MultiSessionListItem>`.
- Render rows with keyed DOM update, not `innerHTML = ""` on every tick.
- Preserve search/filter/sort locally.
- Post actions to host.
- Use no `vscode` Node import.
- Do not import chat `WebviewController` or message-list components.

Recommended rendering strategy:

- Full render on first state or revision reset.
- Patch existing row by `data-session-id`.
- Reorder rows only when rank/update time/status changes; acceptable to rebuild list on <=100 sessions, but only on throttled manager events.
- Avoid markdown parser and diff renderer entirely.

## Performance requirements

Hard requirements:

1. Background `streamChunk` must not post `feature.multi-session.state` with full `sessions` to chat webview per chunk.
2. Chat webview must not rebuild session manager DOM because manager DOM no longer exists there.
3. Manager panel must not receive transcript or diff full text.
4. Manager updates must be throttled/coalesced.
5. Chat `setState()` persistence must not run for every manager/aggregate tick.

Target budgets:

| Operation | Target |
| --------- | ------ |
| Background token update while manager closed | no manager DOM work; at most one coalesced chat aggregate update per 250ms |
| Background token update while manager open | one row/aggregate update per 250ms max |
| Activate session | snapshot post immediately after activation; no prior manager render backlog in chat queue |
| Manager open | first full state render under 50ms for 100 sessions |
| Manager closed | zero manager webview post/render cost |

Instrumentation to add temporarily or behind debug flag:

- chat state posts/sec;
- manager state posts/sec;
- chat incoming queue depth if available;
- `applySnapshot()` duration;
- manager render duration;
- manager row count and patch count.

## Implementation plan

| Step | Description | Verification |
| ---- | ----------- | ------------ |
| 1 | Add new plan-aware contracts: `chatState`, `managerState`, optional `managerPatch`, and host action shapes. Keep backward-compatible handling during transition. | `npm run check-types` |
| 2 | Introduce host state builders: `buildChatState()` and `buildManagerState()`. Do not change UI yet. | Unit tests for aggregate/open/running/unread counts. |
| 3 | Add coalesced scheduling in host for chat and manager summaries. Replace background `sendState()` with scheduled summary updates. | Test background append calls do not synchronously post full state per event. |
| 4 | Refactor chat webview multi-session controller to remove manager overlay/list rendering and consume `chatState`. Keep snapshot/delta replay intact. | Webview tests for header, snapshot, delta, draft/scroll. Manual switch. |
| 5 | Add `SessionManagerPanelController` on extension host. Wire `vscode-acp-chat.manageSessions` to open/reveal panel instead of in-chat overlay. | Command opens panel; chat view remains usable; closing panel disposes subscriptions. |
| 6 | Add `manager-webview.ts` and `manager-styles.ts`, with separate esbuild browser bundle. Render rows from `managerState`. | Bundle contains no `vscode`/Node imports; manager displays sessions. |
| 7 | Wire manager actions: activate/open chat, review permission, stop, close, new, resync. Add focus policy. | Each action affects correct session; manager remains synced. |
| 8 | Add QuickPick switch command using host summaries. | QuickPick activates session and focuses existing chat view. |
| 9 | Remove obsolete `managerOpen`, `feature.multi-session.manage/hideManager/openManager` chat-overlay behavior after panel parity. Keep command name but point to panel. | No references to overlay DOM/CSS remain except migration shims if needed. |
| 10 | Add tests and profiling for two concurrent streaming sessions. | State post rate bounded; switching no longer waits behind manager overlay render. |
| 11 | Run quality gates, package, install extension. | `npm run check-types`, `npm run lint`, `npm test`, `npm run package`, `npx vsce package`, `code --install-extension --force`. |

## Detailed phases

### Phase 1 — Contract and host state split

- Add `MultiSessionChatStateMessage` and `MultiSessionManagerStateMessage` to `contracts.ts`.
- Keep `MultiSessionListItem` as shared summary type.
- Add helpers in `host.ts`:
  - `buildAggregate()`;
  - `buildChatState()`;
  - `buildManagerState()`;
  - `buildSessionListItem(session)` remains current `toListItem()` or wrapper.
- Change host naming from generic `sendState()` to explicit methods.
- During transition, host may still emit old `feature.multi-session.state` for compatibility, but new chat webview should move to `chatState`.

Exit criteria:

- State construction is separated from posting.
- Tests can assert chat state does not include full session list.

### Phase 2 — Coalescing before UI split

Implement coalescing before moving UI so performance improves even during transition.

- Add timers:
  - `chatStateTimer`;
  - `managerStateTimer`.
- Immediate send for activation/new/close/permission.
- Throttled send for background token updates.
- De-duplicate multiple status changes in one tick.
- Ensure `dispose()` clears timers.

Exit criteria:

- A loop of 100 background appends produces small bounded number of state posts.
- Active deltas still stream normally.

### Phase 3 — Chat webview simplification

- Remove `createOverlay()`, `renderOverlay()`, `renderAgentIdentity()`, session item action DOM, `managerOpen`, and overlay-specific persisted state from chat `webview.ts`.
- Replace sessions button behavior:
  - primary click posts `{ type: "feature.multi-session.quickSwitch" }` or command bridge if implemented;
  - secondary/manager button posts `{ type: "feature.multi-session.openManagerPanel" }`, or existing command opens panel through host.
- Header should show aggregate counts and active status only.
- `applySnapshot()` remains, but should not call overlay render after replay.

Exit criteria:

- Chat webview no longer contains session manager row/list DOM.
- Background session state changes do not cause full list rebuild in chat webview.

### Phase 4 — Manager panel host controller

Create `manager-panel.ts`.

Skeleton:

```ts
export class MultiSessionManagerPanelController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: MultiSessionHostController
  ) {}

  open(): void;
  reveal(): void;
  dispose(): void;
}
```

Message handling delegates to host controller methods instead of duplicating logic.

Host controller should expose safe public methods:

- `getManagerStateSnapshot()`;
- `activateSession(localSessionId, options?)` or current `activate()` made public with focus option;
- `newChat(options?)`;
- `stop(localSessionId?)`;
- `close(localSessionId)`;
- `reviewPermission(localSessionId)`;
- `onDidChangeManagerState` / `onDidChangeManagerPatch`.

Exit criteria:

- Opening/closing manager panel does not affect chat transcript.
- Panel receives fresh state on ready.

### Phase 5 — Manager webview implementation

Create independent manager bundle.

Minimum DOM components:

- header summary;
- filter/search input;
- session list;
- row component;
- empty state;
- error/status line.

Actions post messages:

```ts
vscode.postMessage({ type: "feature.multi-session.activate", localSessionId, focusChat: true });
vscode.postMessage({ type: "feature.multi-session.stop", localSessionId });
vscode.postMessage({ type: "feature.multi-session.close", localSessionId });
vscode.postMessage({ type: "feature.multi-session.reviewPermission", localSessionId });
vscode.postMessage({ type: "feature.multi-session.new", focusChat: true });
```

Exit criteria:

- No dependency on chat `WebviewController`.
- No markdown/diff rendering.
- Works after panel reload via ready/resync.

### Phase 6 — Command routing and QuickPick

- Change `ChatViewProvider.manageSessions()` to call host-side manager panel controller instead of `features.multiSession.openManager()`.
- Register optional `vscode-acp-chat.switchSession` command.
- Add title/menu entry if useful:
  - `Switch Chat Session` near `Manage Chat Sessions`.
- QuickPick should use `getManagerStateSnapshot().sessions` to avoid asking webview for state.

Exit criteria:

- Command Palette `Manage Chat Sessions` opens tab/panel.
- `Switch Chat Session` activates selected session without opening manager.

### Phase 7 — Remove old overlay contract

After panel is stable:

- Remove `managerOpen` from `MultiSessionStateMessage` and persisted `MultiSessionDraftState`.
- Remove old `feature.multi-session.manage`, `hideManager`, `openManager` overlay semantics or keep as aliases to panel open for one release.
- Delete old overlay CSS from `styles.ts` or split chat header styles from manager panel styles.
- Update tests expecting overlay behavior.

Exit criteria:

- No hidden overlay DOM in chat webview.
- State messages are semantically split.

## Tests

Place feature tests under `src/test/features/`.

### Host tests

1. `buildChatState()` excludes full session list and includes aggregate + active item only.
2. `buildManagerState()` includes summaries but no transcript/diff text.
3. Background append schedules coalesced state instead of immediate full state per event.
4. Activation sends immediate chat snapshot and manager active marker update.
5. Manager panel ready receives full current state.
6. Manager action `stop` targets selected session, not active session by accident.
7. Manager action `reviewPermission` activates owner session and opens active permission flow.
8. Dispose clears coalescing timers and manager subscriptions.

### Chat webview tests

1. `chatState` renders compact header/status.
2. `chatState` does not render session rows.
3. Snapshot replay still resets and restores active transcript.
4. Delta stale revision is still dropped.
5. Draft/scroll persistence remains per session.
6. Aggregate-only update does not call full `saveWebviewState()` unnecessarily.

### Manager webview tests

1. Initial `managerState` renders list rows and aggregate.
2. Row actions post correct host messages with `localSessionId`.
3. Search/filter does not mutate host state.
4. Patch updates only changed rows.
5. Active marker moves when active session changes.
6. Empty state renders when no open sessions.

### Integration/manual tests

1. Open two streaming sessions; keep manager closed; chat switching remains responsive.
2. Open manager while two sessions stream; row counters update at bounded rate.
3. Close manager; background streaming no longer performs manager render/post work.
4. Use QuickPick switch during active streaming; selected session snapshot appears in chat.
5. Background permission appears in manager; Review activates session and shows permission UI.
6. Stop background session from manager; active chat session continues.
7. Close idle session from manager; transcript of active session is unchanged.
8. Reload webview panel; manager resyncs from host.
9. Reload chat webview; active snapshot still restores.

## Quality gates

Because this changes extension host and webview code, implementation must run:

```bash
npm run check-types
npm run lint
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-session-manager-panel.vsix
code --install-extension .tmp/vscode-acp-chat-session-manager-panel.vsix --force
```

If `vsce` or `code` is unavailable, report that blocker explicitly. Do not commit generated VSIX files.

## Acceptance criteria

- `Manage Chat Sessions` opens a separate Session Manager panel/tab, not an overlay inside chat view.
- Chat view remains focused on active transcript and does not render full session list.
- Manager panel can be closed without affecting running sessions.
- Background session streaming does not cause chat webview full state/list re-render per chunk.
- Manager panel updates are throttled/coalesced and summary-only.
- Quick switching activates existing chat view and sends active snapshot without creating a new chat tab.
- Permission, stop, close and new actions from manager target the correct session.
- No transcript, full diff text, markdown content or terminal output is sent to manager state messages.
- Existing multi-session snapshot/delta behavior still works.
- Typecheck, lint, tests, production package and local install complete or blockers are reported.

## Risks and mitigations

| Risk | Mitigation | Rollback |
| ---- | ---------- | -------- |
| Two webviews introduce duplicated state or stale manager UI | Host remains single source of truth; manager resyncs on ready/reveal; revision numbers | Close/dispose manager panel; chat flow continues |
| Additional bundle increases build complexity | Separate small entry in `esbuild.js`; no shared chat controller import | Temporarily serve manager via same bundle with explicit mode flag |
| Focus behavior is confusing | Explicit `focusChat` option; manager remains open unless user closes it | Revert to activating without focus for manager actions |
| Manager panel still receives too many updates | Coalescing plus summary-only patches; no transcript/diff text | Disable live manager patches; refresh on open/manual only |
| Chat still lags due to snapshot/markdown/diff replay | This split reduces manager-induced lag but does not replace snapshot/markdown/diff optimizations | Continue with separate performance plan for bulk replay/render batching |
| Existing tests expect overlay manager | Update tests to assert panel command + chat header behavior | Keep overlay aliases behind feature flag during migration |

## Rollout strategy

1. Implement coalesced state scheduling first, behind existing UI.
2. Add manager panel while retaining old overlay path as a temporary fallback.
3. Switch `Manage Chat Sessions` command to panel in development build.
4. Validate with two concurrent streaming sessions and manager open/closed profiling.
5. Remove overlay path after parity and tests pass.
6. Keep feature flag `vscode-acp-chat.multiSession.enabled` as global rollback.

## Non-goals

- Do not create one chat tab/webview per ACP session.
- Do not persist full transcript event logs long-term.
- Do not implement single-process ACP multiplexing.
- Do not solve markdown streaming quadratic rendering in this plan, except reducing manager-related traffic.
- Do not move diff review UI into manager; manager only shows counts/status and routes to chat/review commands.

## Completion notes

Implemented on 2026-07-14:

- Added split chat/manager contracts: `feature.multi-session.chatState` for chat and `feature.multi-session.managerState` for the separate panel.
- Refactored chat webview multi-session UI to remove the full manager overlay/list and keep only active-session detail plus quick switch; aggregate counts and manager actions live outside the chat surface.
- Added `MultiSessionManagerPanelController`, independent `manager-webview.ts` browser bundle, panel styles, and VS Code QuickPick session switching.
- Split host summary builders/coalescing from active transcript `snapshot`/`delta`; background appends no longer synchronously post full session lists to the chat webview.
- Added package command contribution for `vscode-acp-chat.switchSession` and an esbuild entry for `dist/session-manager-webview.js`.
- Updated feature/layout docs and tests for split manager behavior.

Verification performed:

```bash
npm run check-types
npm run compile-tests
npm run compile
npm test -- --grep "multi-session"
```

Full quality gates and local VSIX installation are tracked in the implementation report for this change.

## Follow-up note

The original split moved full session management out of the chat webview into a dedicated `WebviewPanel`. The follow-up plan [`implement-session-manager-activity-bar-toggle.md`](./implement-session-manager-activity-bar-toggle.md) replaces that editor panel surface with a contributed Activity Bar container and Primary Sidebar `WebviewView`, while preserving the same `MultiSessionHostController`, manager browser bundle, and summary-only manager message contract.

## Revision history

| Date       | Author | Summary                                                                                           |
| ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| 2026-07-14 | Bytes  | Initial plan to split full multi-session management into a separate WebviewPanel plus QuickPick. |
