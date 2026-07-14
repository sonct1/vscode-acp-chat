# Implementation Plan: Correct Agent Selection and Start a New Session

| Attribute  | Value |
| ---------- | ----- |
| Status     | Planned |
| Owner      | TBD |
| Scope      | Select Agent QuickPick, selected-agent source of truth, multi-session/legacy session lifecycle, tests, feature docs |
| References | `src/extension.ts`, `src/views/chat.ts`, `src/features/register-host.ts`, `src/features/multi-session/host.ts`, `src/test/features/multi-session.test.ts` |

## Tổng quan

Sửa command **Select Agent** để:

1. Agent có nhãn `Currently selected` luôn khớp với agent người dùng đã chọn, kể cả khi mở lại QuickPick trong cùng Extension Host hoặc sau khi reload VS Code.
2. Khi click một agent, extension chọn agent đó và lập tức tạo/activate một chat mới cùng ACP session của agent đó.
3. Các session đang mở hoặc đang chạy của agent khác không bị huỷ trong multi-session mode.

## Phân tích hiện trạng

Luồng hiện tại bị tách source of truth:

- `src/extension.ts` dựng QuickPick và xác định `Currently selected` bằng `acpClient.getAgentId()` từ singleton ACP client.
- Khi multi-session được bật, `ChatViewProvider.switchAgent()` chuyển tiếp tới `MultiSessionHostController.switchAgent()`.
- `MultiSessionHostController.switchAgent()` chỉ cập nhật `defaultAgent`, lưu `vscode-acp-chat.selectedAgent`, và có thể đổi agent của active draft chưa start.
- Singleton `acpClient` không được cập nhật trong multi-session mode, nên mở lại QuickPick vẫn có thể đánh dấu agent cũ.
- Luồng multi-session hiện tại không gọi `newChat()` hoặc `ensureRuntime(..., true)`, vì vậy chọn agent chưa đảm bảo tạo một local chat mới và một ACP session mới.
- Ở legacy mode, `handleAgentChange()` reconnect và có thể tạo ACP session, nhưng không reset đầy đủ chat surface như một thao tác **New Chat**. Nếu nối trực tiếp `handleAgentChange()` với `handleNewChat()`, có nguy cơ gọi `session/new` hai lần.

## Mục tiêu

- QuickPick đọc selected agent từ đúng runtime authority:
  - multi-session: `MultiSessionHostController.defaultAgent`;
  - legacy: singleton `ACPClient`.
- Persist selected agent vào `vscode-acp-chat.selectedAgent` và restore đúng khi extension activate lại.
- Chọn bất kỳ agent nào, kể cả agent đang được chọn, đều tạo một chat/session mới bằng agent đó.
- Multi-session tạo một local session mới, activate/focus session đó, start runtime và gọi ACP `session/new` đúng một lần.
- Legacy mode clear chat cũ, đổi agent, connect và gọi ACP `session/new` đúng một lần.
- Không huỷ, mutate hoặc tái sử dụng nhầm session cũ trong multi-session mode.
- Nếu user đóng QuickPick hoặc không chọn item, không thay đổi agent/session.

## Quyết định hành vi

### 1. `Currently selected` biểu thị selected/default agent

Trong multi-session mode, nhãn này biểu thị agent đã chọn làm mặc định cho thao tác tạo chat mới, không đọc từ singleton client và không suy ra từ một session cũ đang chạy nền.

Sau khi user chọn agent, chat mới của agent đó được activate ngay nên selected/default agent và active session agent sẽ đồng nhất tại thời điểm hoàn tất thao tác.

### 2. Chọn agent luôn là thao tác “select + new chat”

Kể cả khi user click lại chính agent có nhãn `Currently selected`, extension vẫn tạo một chat/session mới. Đây là hành vi rõ ràng và nhất quán với yêu cầu click agent để bắt đầu session mới.

### 3. Multi-session không thay đổi session hiện hữu

Không tiếp tục behavior đổi agent trực tiếp trên active draft. Thay vào đó:

1. validate agent;
2. cập nhật/persist selected agent;
3. tạo local draft mới với agent được truyền tường minh;
4. activate và focus chat mới;
5. start runtime;
6. gọi ACP `session/new` một lần.

Session cũ, kể cả draft hoặc session đang chạy, được giữ nguyên.

### 4. Legacy mode dùng một lifecycle hợp nhất

Không gọi tuần tự hai flow hiện tại vì có thể tạo session hai lần. Cần một operation duy nhất thực hiện:

1. confirmation/cancel nếu agent đang generate;
2. reset transcript, metadata, diff và usage state;
3. set/persist agent;
4. connect client;
5. sync capabilities;
6. gọi ACP `session/new` đúng một lần;
7. publish `agentChanged`, metadata và connection/session state mới.

### 5. Xử lý lỗi

- Agent id không hợp lệ: không đổi state, không tạo chat.
- Multi-session start/new thất bại: giữ chat mới của agent đã chọn ở trạng thái retry được, lưu `lastError`, không ảnh hưởng session cũ.
- Legacy connect/new thất bại: hiển thị lỗi trên chat surface; selected agent vẫn là agent user đã chọn để lần retry tiếp theo dùng đúng agent.
- Không tạo thêm client/session khi user click một lần.

## Target architecture

```text
vscode-acp-chat.selectAgent
  └─ agent-selection host feature
       ├─ getSelectedAgentId()
       ├─ build available-agent QuickPick items
       └─ selectAgentAndStartNewChat(agentId)
            └─ ChatViewProvider
                 ├─ multi-session
                 │    └─ MultiSessionHostController.selectAgentAndNewChat()
                 │         ├─ persist default agent
                 │         ├─ create + activate local session
                 │         └─ ensureRuntime(session, true)
                 └─ legacy
                      └─ reset + set agent + connect + session/new once
```

Command UI/registration phải nằm dưới `src/features/agent-selection/`; `src/extension.ts` chỉ giữ integration/registration tối thiểu theo quy tắc tổ chức feature của repository.

## Implementation phases

### Phase 1: Tách Select Agent command thành host feature

#### Task 1: Tạo agent-selection host module

**Mô tả:** Tạo `src/features/agent-selection/host.ts` để sở hữu QuickPick và command registration.

Định nghĩa interface hẹp, không import trực tiếp `ChatViewProvider` vào feature:

```ts
interface AgentSelectionTarget {
  getSelectedAgentId(): string;
  selectAgentAndStartNewChat(agentId: string): Promise<void>;
}
```

**Acceptance criteria:**

- [ ] `vscode-acp-chat.selectAgent` được đăng ký qua `registerExtensionHostFeatures()`.
- [ ] `src/extension.ts` không còn chứa logic dựng item hoặc xử lý agent switch.
- [ ] QuickPick vẫn chỉ hiển thị agent available như hiện tại.
- [ ] Item khớp `getSelectedAgentId()` có `picked` và `$(check) Currently selected`.
- [ ] Cancel QuickPick không gọi target action.
- [ ] Logic tạo item được tách thành helper thuần để unit test marker mà không cần mở UI thật.

**Files likely touched:**

- `src/features/agent-selection/host.ts` — new
- `src/features/register-host.ts`
- `src/extension.ts`

### Phase 2: Thêm selected-agent query không side effect

#### Task 2: Expose source of truth qua `ChatViewProvider`

**Mô tả:** Thêm `ChatViewProvider.getSelectedAgentId()`:

- multi-session trả về getter trực tiếp từ `MultiSessionHostController`;
- legacy trả về `acpClient.getAgentId()`.

Không dùng `getManagerStateSnapshot()` chỉ để đọc agent vì builder này tăng manager revision và phát sinh side effect không cần thiết.

**Acceptance criteria:**

- [ ] Multi-session getter trả `defaultAgent.id`.
- [ ] Legacy getter trả singleton client agent id.
- [ ] Getter phản ánh agent mới ngay sau khi persistence/update hoàn tất.
- [ ] Tạo controller/provider mới với cùng `globalState` restore đúng selected agent.

**Files likely touched:**

- `src/features/multi-session/host.ts`
- `src/views/chat.ts`

### Phase 3: Implement multi-session select + new session

#### Task 3: Tạo API `selectAgentAndNewChat()` trong multi-session controller

**Mô tả:** Thay semantics `switchAgent()` hiện tại bằng operation tạo session mới. Có thể giữ compatibility wrapper tạm thời nếu còn caller cũ, nhưng command mới phải gọi API có tên thể hiện đúng hành vi.

Refactor `createDraft()` để nhận agent tường minh hoặc thêm helper `createDraftForAgent(agent)`; không dựa vào việc mutate active draft.

**Acceptance criteria:**

- [ ] Agent được validate trước khi thay đổi state.
- [ ] `defaultAgent` và `vscode-acp-chat.selectedAgent` được cập nhật.
- [ ] Một local session mới được tạo với đúng `agentId`/`agentName`.
- [ ] Session mới được activate và chat view được focus.
- [ ] `ensureRuntime(session, true)` tạo đúng một ACP client/runtime và gọi `session/new` đúng một lần.
- [ ] Active/running session cũ không bị cancel, dispose hoặc đổi agent.
- [ ] Active draft cũ không bị mutate sang agent mới.
- [ ] Chọn lại cùng agent vẫn tạo local session và ACP session mới.
- [ ] Manager/chat state và snapshot được publish với session mới là active.
- [ ] Nếu runtime/new session lỗi, session mới giữ đúng agent, có `lastError`, và có thể retry.

**Files likely touched:**

- `src/features/multi-session/host.ts`
- `src/views/chat.ts`

### Phase 4: Implement legacy select + new session

#### Task 4: Hợp nhất agent change và new-chat reset

**Mô tả:** Thêm một flow legacy riêng cho command mới, tái sử dụng helper reset state thay vì gọi nối tiếp `handleAgentChange()` và `handleNewChat()`.

**Acceptance criteria:**

- [ ] Nếu đang generate, user được confirm một lần; từ chối thì không đổi agent/session.
- [ ] Chat transcript, pending tool metadata, diff summary, mode/model/config metadata và context usage được reset như **New Chat**.
- [ ] Client đổi sang agent đã chọn và persistence được cập nhật.
- [ ] Client connect lại và ACP `session/new` chỉ chạy một lần.
- [ ] `agentChanged` và session metadata mới được gửi tới webview.
- [ ] Không còn transcript cũ nằm dưới agent mới.

**Files likely touched:**

- `src/views/chat.ts`

### Phase 5: Tests

#### Task 5: Unit test agent-selection feature

Tạo `src/test/features/agent-selection.test.ts`.

**Acceptance criteria:**

- [ ] Đúng item có `Currently selected` dựa trên target getter.
- [ ] Không item nào khác có marker.
- [ ] Chọn item gọi `selectAgentAndStartNewChat(id)` đúng một lần.
- [ ] Cancel không gọi action.
- [ ] Available-agent filtering không bị thay đổi.

#### Task 6: Multi-session lifecycle tests

Cập nhật `src/test/features/multi-session.test.ts`.

**Acceptance criteria:**

- [ ] Sau khi chọn `opencode`, selected/default id và persisted key đều là `opencode`.
- [ ] Một session mới của OpenCode được active; session cũ còn nguyên.
- [ ] Fake client mới dùng đúng agent config, connect một lần, manager `newCalls === 1`.
- [ ] Session cũ đang chạy không bị cancel.
- [ ] Active draft cũ không bị đổi agent.
- [ ] Chọn lại agent hiện tại vẫn tạo session mới.
- [ ] Khởi tạo controller mới với cùng memento restore marker đúng agent.
- [ ] Failure path giữ chosen-agent draft và không làm hỏng session cũ.

Test hiện tại `switching the selected agent updates draft sessions and state` phải được thay bằng expectation mới; không giữ assertion mutate draft cũ.

#### Task 7: Legacy provider tests

Cập nhật `src/test/chat.test.ts`.

**Acceptance criteria:**

- [ ] `getSelectedAgentId()` dùng đúng legacy client.
- [ ] Select agent reset chat và tạo đúng một session.
- [ ] Đang generate + reject confirmation không thay đổi state.
- [ ] Connect/session creation error được report nhưng không tạo session lặp.

### Phase 6: Documentation updates after implementation

- Cập nhật `docs/features/feature-catalog.md`:
  - **Agent selection and custom agents**: selected agent restore đúng và selection tạo chat/session mới.
  - **Concurrent multi-session chat**: agent selection tạo một independent active session, không huỷ session cũ.
  - command reference của `vscode-acp-chat.selectAgent`.
- Cập nhật mô tả icon `[robot]` trong `docs/architecture/acp-chat-layout.md` để phản ánh “select agent và tạo session mới”; không thay đổi layout nếu icon/vị trí không đổi.
- Cập nhật completion notes/status của plan sau khi implementation hoàn tất.

## Verification

Quality gates theo thứ tự project:

```bash
npm run check-types
npm run lint
npm run compile-tests
npm test -- --grep "agent selection|multi-session"
npm run package
npx vsce package --out .tmp/vscode-acp-chat-agent-selection.vsix
code --install-extension .tmp/vscode-acp-chat-agent-selection.vsix --force
rm -f .tmp/vscode-acp-chat-agent-selection.vsix
```

Nếu tên test không hỗ trợ regex trên runner hiện tại, chạy test suite feature tương ứng hoặc toàn bộ `npm test`.

Manual verification:

- [ ] Mở **Select Agent**, chọn OpenCode, mở lại picker: OpenCode có `Currently selected`.
- [ ] Reload bằng `Developer: Reload Window`, mở picker: marker vẫn ở OpenCode.
- [ ] Ngay sau khi chọn OpenCode, chat mới được active và đã có ACP session của OpenCode.
- [ ] Chọn Claude Code: tạo thêm chat/session Claude Code; session OpenCode cũ vẫn còn trong manager.
- [ ] Để một session đang stream, chọn agent khác: session đang stream không bị cancel.
- [ ] Click lại agent đang selected: tạo thêm một session mới của cùng agent.
- [ ] Tắt `vscode-acp-chat.multiSession.enabled`, lặp lại thao tác: transcript được reset và chỉ một ACP session mới được tạo.
- [ ] Chạy command từ Command Palette khi chat view chưa focus: chat mới được tạo và view được focus.

Sau khi install VSIX, yêu cầu chạy `Developer: Reload Window` để extension mới có hiệu lực.

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Gọi agent change rồi new chat gây hai lần `session/new` ở legacy mode | Dùng một lifecycle hợp nhất, test call count chính xác. |
| Multi-session vô tình đổi/cancel active draft hoặc running session cũ | Luôn tạo `ManagedSession` mới với agent tường minh; test identity và cancel count của session cũ. |
| QuickPick lại đọc nhầm singleton hoặc manager snapshot có side effect | Chỉ đọc qua `ChatViewProvider.getSelectedAgentId()` và getter trực tiếp của controller. |
| Chọn agent tạo runtime vượt `maxConcurrentSessions` | Dùng guard hiện có; giữ chosen-agent draft với lỗi retry được và không dispose session khác. |
| Persistence hoàn tất sau khi QuickPick được mở lại rất nhanh | Await `globalState.update()` trước khi resolve select action. |
| Agent selection command logic tiếp tục phình trong core file | Đưa UI/command logic vào `src/features/agent-selection/host.ts`; core chỉ cung cấp target interface/integration. |

## Non-goals

- Không thay đổi danh sách built-in/custom agents hoặc cách kiểm tra CLI availability.
- Không tự đóng các session cũ để lấy slot runtime.
- Không thay đổi UI của Session Manager ngoài state cập nhật từ session mới.
- Không thêm setting để chọn giữa “switch only” và “switch + new chat” trong phase này.
- Không thay đổi semantics của `Switch Chat Session`; command đó vẫn chỉ activate session hiện hữu.

## Definition of done

- `Currently selected` luôn lấy từ đúng selected-agent source of truth và restore đúng.
- Chọn agent tạo, activate và focus một chat/session mới của agent đó.
- Multi-session giữ nguyên mọi session cũ; legacy reset chat sạch và tạo đúng một session.
- Tests cover marker, persistence/reload, same-agent selection, running-session isolation, legacy single-session count và failure paths.
- Feature catalog/layout mapping được cập nhật.
- Typecheck, lint, tests, production package và local VSIX installation thành công, hoặc blocker được báo rõ.
