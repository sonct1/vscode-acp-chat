# Implementation Plan: Built-in Grok Build ACP Agent

| Attribute  | Value                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Draft                                                                                                                                                                                                          |
| Owner      | TBD                                                                                                                                                                                                            |
| Phase      | Planning complete; implementation pending                                                                                                                                                                      |
| Scope      | Feature-owned external CLI configuration, built-in agent catalog, generic ACP model compatibility, tests, docs, packaging, local install                                                                       |
| References | `src/acp/agents.ts`, `src/acp/client.ts`, `src/acp/session-manager.ts`, `src/features/agent-selection/`, `src/test/agents.test.ts`, `src/test/client.test.ts`, `README.md`, `docs/features/feature-catalog.md` |

## Objective

Thêm **Grok Build** vào danh sách built-in agent của extension với id ổn định `grok-build`.

Trạng thái mong muốn:

- Khi CLI `grok` có trên `PATH`, agent selector tự hiển thị **Grok Build**.
- Extension chạy trực tiếp ACP server chính thức bằng:

  ```bash
  grok --no-auto-update agent stdio
  ```

- User không cần khai báo `vscode-acp-chat.customAgents` thủ công.
- Custom agent có cùng `id: "grok-build"` vẫn override built-in configuration.
- Extension không bundle, tải xuống, tự cập nhật hoặc quản lý credential của Grok Build.
- Model metadata dạng ACP cũ mà Grok hiện trả về được hiển thị đúng trong session toolbar.

> Built-in ở đây nghĩa là extension ship sẵn cấu hình catalog. Grok CLI vẫn là dependency cài ngoài và phải được user xác thực trước.

## Preconditions

- Grok Build được cài và có thể chạy bằng `grok` từ môi trường Extension Host.
- User đã chạy `grok login`, hoặc Extension Host nhận được `XAI_API_KEY` hợp lệ.
- Không có custom agent `id: "grok-build"`, trừ khi user chủ động muốn override built-in entry.
- Khi triển khai, giữ nguyên mọi thay đổi ngoài phạm vi đang tồn tại trong working tree.

## Verified baseline

### Extension hiện tại

- `src/acp/agents.ts` tạo built-in catalog và merge `vscode-acp-chat.customAgents` theo `id`.
- Custom agent cùng id thay thế hoàn toàn built-in agent.
- Availability mặc định được kiểm tra bằng `isCommandAvailable(agent.command)`.
- Agent selector chỉ hiển thị agent có `available: true`.
- `ACPClient.connect()` spawn process với stdio pipe và dùng ACP protocol version `1`.
- `AgentSessionManager` dùng local session cache khi agent không advertise `sessionCapabilities.list`.

### Grok Build đã smoke test

Baseline được kiểm tra với:

```text
grok 0.2.101 (5bc4b5dfad) [stable]
```

Kết quả:

- `grok --no-auto-update agent stdio` khởi động ACP JSON-RPC qua stdin/stdout.
- `initialize` chấp nhận `protocolVersion: 1`.
- Với cached login hợp lệ, `session/new` và `session/load` thành công.
- `initialize` advertise `loadSession: true`, MCP HTTP/SSE và các auth method như `cached_token` / `grok.com` tùy môi trường.
- `sessionCapabilities` hiện rỗng; gọi `session/list` trực tiếp trả `Method not found`. Extension phải tiếp tục dùng local session cache và không gọi method không được advertise.
- Với `GROK_HOME` rỗng và không có `XAI_API_KEY`, `session/new` trả lỗi `Authentication required` / `no auth method id provided`.
- `session/new` trả model metadata qua field ACP cũ `models`, không qua `configOptions`.
- Grok có thể phát notification riêng `_x.ai/*`; chúng không được làm hỏng ACP stream hoặc transcript chuẩn.

### Compatibility gap cần xử lý

`ACPClient.newSession()` ghi chú precedence là:

```text
configOptions -> old-format models/modes -> existing metadata
```

Nhưng implementation hiện chỉ fallback `response.modes`, bỏ sót `response.models`. Nếu chỉ thêm catalog entry, Grok chat có thể chạy nhưng model metadata sẽ không được đưa vào session toolbar.

Đây là protocol compatibility bug dùng chung, không phải workaround theo agent id.

## Architecture decisions

### 1. Dùng built-in id `grok-build`

Cấu hình mục tiêu:

```ts
{
  id: "grok-build",
  name: "Grok Build",
  command: "grok",
  args: ["--no-auto-update", "agent", "stdio"]
}
```

Lý do:

- Id mô tả đúng product integration và nhất quán với các id như `claude-code`, `qwen-code`.
- Không chiếm namespace `grok` quá rộng nếu xAI bổ sung sản phẩm hoặc ACP mode khác.
- Id là key lâu dài cho selected-agent state, session metadata và custom override; cần chốt trước khi release.

### 2. Giữ code Grok-specific trong feature folder

Tạo:

```text
src/features/grok-build/
├── host.ts
└── index.ts
```

`host.ts` chỉ export constant/factory cấu hình built-in. `src/acp/agents.ts` chỉ giữ import và một lời gọi factory làm integration point tối thiểu.

Không cần đăng ký qua `src/features/register-host.ts` vì feature không có command, controller, lifecycle listener hoặc webview behavior riêng.

### 3. Chạy trực tiếp external CLI, không bundle adapter

Không thêm:

- vendored source;
- esbuild entrypoint;
- artifact dưới `dist/`;
- `.vscodeignore` exception;
- runtime download/install;
- version pin trong extension.

Grok đã cung cấp ACP stdio native nên adapter trung gian sẽ tăng maintenance và protocol drift không cần thiết.

### 4. Luôn tắt background auto-update trong ACP process

Dùng đúng thứ tự argument:

```text
--no-auto-update agent stdio
```

Mục tiêu là tránh update check/background mutation khi extension mở agent process, đặc biệt trong CI hoặc nhiều session đồng thời. User vẫn tự quản lý phiên bản bằng CLI chính thức.

### 5. Authentication nằm ngoài MVP

MVP yêu cầu user chạy trước:

```bash
grok login
```

hoặc cung cấp `XAI_API_KEY` cho môi trường Extension Host.

Không tự gọi `agent.authenticate` trong thay đổi này vì đây là bài toán generic cross-agent gồm method selection, browser/device flow, cancellation, retry, credential lifecycle và UX. Extension chỉ surface lỗi ACP hiện có khi session creation thất bại.

Một thiết kế ACP authentication chung phải là plan riêng nếu cần.

### 6. Sửa generic old-format model fallback trong core

Sửa `ACPClient.newSession()` theo precedence:

```ts
models = models ?? response.models ?? this.sessionMetadata?.models ?? null;
modes = modes ?? response.modes ?? this.sessionMetadata?.modes ?? null;
```

Yêu cầu:

- Không phân nhánh theo `agentConfig.id`.
- `configOptions` vẫn có precedence cao nhất.
- Existing metadata chỉ là fallback cuối.
- Chỉ mở rộng `loadSession()` nếu SDK type và response thực tế có old-format `models`/`modes`; không dùng cast hoặc `any` để ép behavior chưa xác minh.
- Chỉ thêm fallback `session/set_model` nếu smoke test chứng minh Grok advertise nhiều model nhưng không hỗ trợ `session/set_config_option`; không thêm suy đoán trước khi có failure tái hiện được.

Generic protocol fix này nên là atomic change riêng với Grok catalog change để có thể review/rollback độc lập.

## Scope

### In scope

- Feature-owned Grok Build config factory.
- Built-in catalog entry `grok-build`.
- Detection bằng command `grok` trên `PATH`/global bin paths hiện có.
- Exact launch args `--no-auto-update agent stdio`.
- Existing custom-agent override semantics.
- Generic `response.models` fallback trong `ACPClient.newSession()`.
- Unit/integration tests cho config, catalog, override và old-format models.
- README, feature catalog và changelog.
- Authenticated/unauthenticated Grok smoke test.
- Production build, VSIX packaging và local install.

### Out of scope

- Bundle hoặc tự cài Grok CLI.
- Pin hoặc tự nâng cấp Grok CLI.
- ACP auth picker, browser login, device auth hoặc tự gọi `agent.authenticate`.
- Lưu/refresh/logout credential.
- Grok-specific adapter/proxy.
- Emulate `session/list` hoặc gọi ACP method không được advertise.
- Grok-specific webview, icon, telemetry, settings hoặc live-tool-output profile.
- Parse private `_x.ai/*` metadata thành UI riêng.
- Sửa behavior không được tái hiện bằng test hoặc smoke check.

## Proposed file changes

```text
src/features/grok-build/host.ts           # constants + createGrokBuildAgentConfig()
src/features/grok-build/index.ts          # public host export
src/acp/agents.ts                         # minimal built-in catalog integration
src/acp/client.ts                         # generic old-format response.models fallback
src/test/features/grok-build.test.ts      # exact Grok launch config tests
src/test/agents.test.ts                   # catalog presence + custom override
src/test/client.test.ts                   # generic old-format model metadata regression test
README.md                                 # prerequisite, auth, detection table, built-in note
docs/features/feature-catalog.md          # built-in id and capability/limitation notes
CHANGELOG.md                               # Unreleased feature entry
docs/plans/implement-built-in-grok-build-agent.md
docs/plans/README.md                      # plan index
```

Không dự kiến sửa `package.json`, `esbuild.js`, `.vscodeignore`, `src/features/register-host.ts` hoặc webview code.

## Implementation phases

### Phase 1: Generic ACP model compatibility

#### Task 1.1: Add failing regression test

Thêm test trong `src/test/client.test.ts` cho `session/new` response có:

- `models` dạng cũ;
- không có `configOptions`;
- không có existing session metadata.

Acceptance criteria:

- Test fail với implementation hiện tại.
- Test không phụ thuộc Grok id hoặc executable thật.

#### Task 1.2: Fix metadata precedence

Sửa `ACPClient.newSession()` để nhận `response.models` trước existing metadata.

Acceptance criteria:

- Regression test pass.
- Existing `configOptions` model/mode tests vẫn pass.
- Không thêm `any`, type suppression hoặc agent-id branch.

### Phase 2: Feature-owned Grok Build configuration

#### Task 2.1: Add config factory

Tạo `src/features/grok-build/host.ts` và `index.ts`.

Factory phải trả chính xác:

```ts
{
  id: "grok-build",
  name: "Grok Build",
  command: "grok",
  args: ["--no-auto-update", "agent", "stdio"]
}
```

Không thêm `env`, `availabilityCommand`, `prepare` hoặc `liveToolOutputProfile` nếu không có requirement mới.

Acceptance criteria:

- Grok-specific logic không nằm trực tiếp trong core catalog.
- Unit test xác minh exact id/name/command/ordered args.

#### Task 2.2: Integrate into built-in catalog

Import factory vào `src/acp/agents.ts` và thêm entry cùng nhóm external native ACP CLIs, trước các optional/bundled agents.

Acceptance criteria:

- `grok-build` có trong built-in catalog.
- Existing built-in ids vẫn unique.
- Thứ tự catalog không làm thay đổi default agent khi OpenCode hoặc agent ưu tiên trước đó vẫn available.
- Grok chỉ xuất hiện trong selector khi command `grok` available theo mechanism hiện có.

#### Task 2.3: Preserve custom override

Thêm test custom agent:

```json
{
  "id": "grok-build",
  "name": "Custom Grok",
  "command": "custom-grok-acp",
  "args": ["--stdio"]
}
```

Acceptance criteria:

- `getAgent("grok-build")` trả hoàn toàn custom config.
- Custom config không inherit internal marker hoặc argument từ built-in config.

### Phase 3: Documentation and release notes

#### Task 3.1: Update README

Cập nhật:

- feature summary;
- prerequisites/install link cho Grok Build;
- detection table với `grok --no-auto-update agent stdio`;
- setup/auth note:

  ```bash
  grok login
  grok --version
  ```

- `XAI_API_KEY` là lựa chọn cho môi trường không dùng cached login;
- custom agent `id: "grok-build"` override built-in entry.

Không ghi rằng extension bundle Grok hoặc có login UI tích hợp.

#### Task 3.2: Update durable feature catalog

Cập nhật `docs/features/feature-catalog.md`:

- thêm `grok-build` vào built-in ids;
- ghi direct external CLI launch;
- ghi `loadSession` được dùng khi advertise;
- ghi session list hiện fallback local cache vì Grok không advertise list;
- ghi auth là out-of-band;
- ghi model metadata compatibility ở mức generic ACP.

#### Task 3.3: Update changelog and plan status

- Thêm entry dưới `CHANGELOG.md` → `Unreleased` → `Features`.
- Sau khi hoàn tất, đổi plan status thành `Implemented` và ghi exact verification outcomes.

### Phase 4: Automated verification

Chạy theo thứ tự:

```bash
npm run check-types
npm run lint
npm test
npm run package
```

Acceptance criteria:

- Typecheck pass.
- Lint pass mà không để lại sửa đổi ngoài phạm vi.
- Test suite pass, gồm test Grok config/catalog/override và old-format models.
- Production bundle tạo thành công.

### Phase 5: VSIX packaging and local install

```bash
VSIX_PATH="/tmp/vscode-acp-chat-grok-build.vsix"
npx vsce package --no-dependencies --out "$VSIX_PATH"
code --install-extension "$VSIX_PATH" --force
code --list-extensions --show-versions | grep '^fiyqkrc.vscode-acp-chat@'
rm -f "$VSIX_PATH"
```

Sau khi cài:

- chạy `Developer: Reload Window`;
- xác minh version extension đã cài;
- không commit VSIX.

## Manual acceptance matrix

Thực hiện trong disposable workspace để không ảnh hưởng source tree.

| Case                       | Setup                                               | Expected result                                                                                        |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| CLI unavailable            | `grok` không resolve từ Extension Host PATH         | Grok Build không xuất hiện trong available selector; connect không spawn process                       |
| Authenticated cached login | `grok login` đã hoàn tất                            | Initialize và session creation thành công                                                              |
| API key auth               | Extension Host nhận `XAI_API_KEY` hợp lệ            | Session creation thành công mà không cần interactive login                                             |
| Unauthenticated profile    | `GROK_HOME` rỗng, không có `XAI_API_KEY`            | User thấy lỗi authentication rõ ràng; extension không tự chọn auth method                              |
| Prompt streaming           | Gửi prompt read-only ngắn                           | Assistant text stream qua `session/update`, turn kết thúc bình thường                                  |
| Tool/permission path       | Prompt yêu cầu edit file trong disposable workspace | Tool activity/permission không làm treo session; file result hiển thị theo capability Grok phát ra     |
| Model metadata             | Tạo session mới                                     | Toolbar nhận model từ old-format `response.models`                                                     |
| Model change               | Chỉ khi có từ hai model trở lên                     | Set model hoạt động; nếu `set_config_option` fail, ghi evidence trước khi thêm generic legacy fallback |
| History load               | Load local session vừa tạo                          | `session/load` replay thành công                                                                       |
| History list fallback      | Grok không advertise list                           | Extension dùng local cache và không gọi `session/list`                                                 |
| MCP forwarding             | Có stdio/HTTP/SSE test config phù hợp               | Chỉ transport tương thích capability được gửi; session vẫn khởi tạo                                    |
| Multi-session              | Mở ít nhất hai Grok sessions                        | Mỗi session có process/state độc lập, không lẫn transcript                                             |
| Unknown notifications      | Grok phát `_x.ai/*` notifications                   | ACP stream tiếp tục hoạt động, không có protocol crash                                                 |
| Custom override            | Khai báo custom `id: "grok-build"`                  | Selector/runtime dùng custom command thay built-in config                                              |

## Risks and mitigations

| Risk                                                    | Impact | Mitigation                                                                                          |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| User hiểu “built-in” là extension bundle Grok           | Medium | README nói rõ built-in catalog, external CLI prerequisite                                           |
| Grok CLI command/flags thay đổi                         | High   | Dùng command chính thức hiện tại, smoke test real CLI, ghi tested version, không thêm adapter riêng |
| Background updater làm chậm hoặc mutate process startup | Medium | Luôn truyền `--no-auto-update` trước `agent stdio`                                                  |
| User chưa login                                         | High   | Document `grok login`/`XAI_API_KEY`; surface ACP error; không tự chọn auth method                   |
| Generic auth implementation bị kéo vào feature nhỏ      | High   | Giữ auth ngoài scope và lập plan riêng nếu cần                                                      |
| Model metadata không hiển thị                           | Medium | Sửa generic `response.models` fallback với regression test                                          |
| Model selector hiển thị nhưng set-model contract khác   | Medium | Smoke test; chỉ thêm generic legacy fallback sau khi có failure tái hiện                            |
| Grok không hỗ trợ `session/list`                        | Low    | Dựa vào advertised capability và local session cache hiện có                                        |
| Private `_x.ai/*` notifications gây lỗi SDK/client      | Medium | Manual smoke; ignore an toàn nếu SDK đã hỗ trợ unknown notifications; không parse riêng trong MVP   |
| Custom config cũ dùng id `grok` thay vì `grok-build`    | Low    | Document id chính thức; không tự migrate unknown custom ids                                         |
| Catalog change vô tình đổi default agent                | Low    | Đặt Grok sau existing always-on external entries; test ordering/default behavior                    |

## Rollback strategy

Tách implementation thành hai atomic change units:

1. Generic ACP old-format model compatibility.
2. Grok Build feature/catalog/tests/docs.

Nếu Grok integration phải rollback:

- bỏ factory `src/features/grok-build/` và catalog entry;
- bỏ Grok-specific tests/docs/changelog;
- giữ generic `response.models` fix nếu test chứng minh đúng cho ACP agents khác.

Không có data migration, credential migration, schema change hoặc generated artifact cần rollback.

## Beads handoff

Khi bắt đầu implementation, tạo executable task graph theo các unit:

1. `ACP old-format models regression + generic fix`.
2. `Grok Build feature factory + built-in catalog + override tests` — phụ thuộc unit 1 chỉ ở bước verification tích hợp, không phụ thuộc file implementation.
3. `README + feature catalog + changelog` — phụ thuộc unit 2.
4. `Quality gates + real Grok smoke + VSIX package/install` — phụ thuộc tất cả unit trước.

Không gộp generic ACP compatibility fix và product-specific Grok integration vào cùng một leaf task.

## Definition of Done

- `Grok Build` xuất hiện như built-in agent khi `grok` available.
- Built-in id là `grok-build` và custom same-id override vẫn hoạt động.
- Runtime command chính xác là `grok --no-auto-update agent stdio`.
- Extension không bundle hoặc tự cài Grok.
- Prior CLI authentication requirement được ghi rõ.
- `ACPClient.newSession()` nhận old-format `response.models` theo precedence đúng.
- Automated tests pass.
- Authenticated prompt/session/load smoke pass trên Grok version được ghi nhận.
- Unauthenticated behavior được xác minh và surface rõ ràng.
- README, feature catalog, changelog và plan completion notes được cập nhật.
- Production build, VSIX packaging và local installation thành công.
- User được nhắc chạy `Developer: Reload Window`.

## Revision history

| Date       | Author | Summary                                                                                                    |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| 2026-07-16 | Bytes  | Initial plan based on repository flow, official Grok ACP docs, and local Grok 0.2.101 protocol smoke tests |
