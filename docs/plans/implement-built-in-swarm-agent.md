# Implementation Plan: Built-in Swarm Agent Infrastructure

| Attribute  | Value                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Draft                                                                                                                                                                                                                                                                     |
| Owner      | TBD                                                                                                                                                                                                                                                                       |
| Scope      | Built-in ACP agent catalog, bundled Swarm ACP adapter, configurable role/workflow infrastructure, dedicated worker sessions, monitor/state normalization, capability policy, locks, live progress UI, tests, packaging                                                     |
| References | `src/acp/agents.ts`, `src/acp/client.ts`, `src/acp/session-output-pipeline.ts`, `src/acp/tool-output-presentation.ts`, `src/features/pi-agent/`, `src/features/antigravity-agent/`, `src/features/multi-session/`, `src/features/register-host.ts`, `esbuild.js` |

## Objective

Thêm một built-in **Swarm Agent** cho extension dưới dạng **hạ tầng orchestration**, không hard-code quy trình planner → implementer → reviewer → proof-auditor.

Extension chỉ cung cấp:

- Root Orchestrator duy nhất cho mỗi Swarm run.
- Runtime để spawn worker sessions/processes độc lập.
- Role registry cấu hình được, số lượng role tùy ý.
- Workflow engine cấu hình được, do user tự định nghĩa thứ tự, điều kiện, fan-out/fan-in và retry.
- Capability policy theo role/step.
- Lock manager cho tài nguyên dùng chung.
- Department Monitor/state normalization.
- Live progress/evidence channel về chat.

User tự setup role và workflow trong workspace config. Các role như `planner`, `implementer`, `reviewer`, `proof-auditor`, `peer`, `red-team`, `security-reviewer`, `docs-writer` chỉ là ví dụ/preset mẫu, không phải role cố định của hệ thống.

Plan này áp dụng các ghi chú/thảo luận của Demonthorn như **design input thực nghiệm**, không coi đó là specification chính thức. Những giả thuyết như authority gradient được dùng để định hướng hạ tầng prompt/role autonomy, không dùng để “đánh lừa” model.

## Target user flow

1. User bật `vscode-acp-chat.swarmAgent.enabled`.
2. Agent selector hiển thị `Swarm` như một built-in agent.
3. User tạo/cập nhật cấu hình workspace, ví dụ:

```text
.vscode/acp-swarm/
├── swarm.config.toml
├── roles/
│   ├── root.toml
│   ├── architect.toml
│   ├── builder.toml
│   ├── reviewer.toml
│   ├── proof.toml
│   └── docs-writer.toml
└── workflows/
    ├── feature-dev.toml
    ├── review-only.toml
    └── docs-update.toml
```

4. User chọn workflow khi gửi prompt, hoặc dùng workflow mặc định trong `swarm.config.toml`.
5. Swarm Root đọc workflow config, spawn worker theo role/step đã cấu hình.
6. Monitor hiển thị worker status, lock status, evidence và live preview trong tool cards.
7. Root tổng hợp kết quả theo output contract của workflow, không áp đặt một quy trình cố định.

## Current-state analysis

### Built-in agent pattern

Extension đã có pattern cho built-in ACP agents:

- `src/acp/agents.ts` định nghĩa catalog built-in qua `getBuiltinAgents()`.
- `src/features/pi-agent/host.ts` tạo `AgentConfig` dùng `process.execPath` + `ELECTRON_RUN_AS_NODE=1` để chạy bundled adapter trong `dist/pi-acp/index.mjs`.
- `src/features/antigravity-agent/host.ts` dùng pattern tương tự nhưng gated bằng setting.
- `ACPClient.connect()` spawn `agentConfig.command` và giao tiếp ACP qua stdio.

Swarm nên đi theo pattern này để xuất hiện như một agent bình thường, không tạo một chat mode riêng khó bảo trì.

### Multi-session pattern

`src/features/multi-session/` đã chứng minh các khái niệm cần reuse:

- isolated runtime: mỗi session có một `ACPClient`/process riêng;
- transcript store và snapshot/delta routing;
- `WorkspaceMutationCoordinator` serialize write theo path;
- per-session `SessionOutputPipeline`;
- status aggregation và manager view.

Swarm không nên copy toàn bộ multi-session. Swarm cần một Root run có nhiều worker invocations nội bộ, nhưng target behavior tương tự: worker độc lập, routing rõ ràng, state không lẫn.

### Live worker output pattern

`src/features/pi-agent/live-tool-output.ts` và `src/views/webview/tool-render.ts` đã có presentation type `subagent` cho delegate tool output. Swarm nên mở rộng cùng cơ chế bằng live output profile mới thay vì tạo renderer riêng trong core UI.

### Feature organization constraint

Custom product feature phải nằm dưới:

```text
src/features/swarm-agent/
```

Core files chỉ được chứa integration nhỏ: import/register/config/dispatch.

## Scope

### In scope for MVP

- Built-in `Swarm` agent gated bằng setting.
- Bundled `swarm-acp` adapter chạy bằng VS Code/Electron runtime.
- Root Orchestrator duy nhất cho mỗi Swarm chat session.
- Role registry cấu hình được với số lượng role tùy ý.
- Workflow engine cấu hình được bằng DAG/steps.
- Worker sessions/processes độc lập, không dùng sub-agent tool của một agent khác.
- Worker autonomy prompt protocol: Root giao nhiệm vụ/constraints theo step, không pre-solve rồi bắt worker xác nhận.
- Department Monitor nội bộ để normalize state và emit progress.
- Capability proxy generic theo role/step: read/write/terminal/permission/test-lock.
- Lock manager generic: `test_runner`, path write locks và user-defined named locks.
- Live worker cards trong chat qua ACP `tool_call`/`tool_call_update`.
- Optional sample role/workflow templates để user tham khảo, không active mặc định.
- Unit/integration tests cho config schema, workflow engine, state machine, locks, capability policy và agent catalog.
- Build/package/install verification theo repo rules khi code implementation hoàn tất.

### Out of scope for MVP

- Hard-code planner → implementer → reviewer → proof-auditor workflow.
- Multi-level orchestrator hoặc worker tự spawn worker khác.
- Mixing Codex sub-agent, Herdr và internal spawn protocols trong cùng Swarm run.
- Persist/resume Swarm run đang chạy sau Extension Host restart.
- Distributed Swarm chạy qua nhiều máy.
- Side-by-side transcript UI cho từng worker.
- Full visual workflow editor.
- Automatic commit/push.
- Auto-running destructive shell commands without existing VS Code/ACP permission flow.
- Guarantee mọi ACP agent đều hoạt động tốt như worker; MVP hỗ trợ graceful degradation theo capability.

## Architecture decisions

### 1. Swarm là built-in ACP agent, không phải chat mode riêng

Thêm `createSwarmAgentConfig()` dưới `src/features/swarm-agent/host.ts` và register vào `src/acp/agents.ts` khi setting `swarmAgent.enabled=true`.

```ts
{
  id: "swarm",
  name: "Swarm",
  command: process.execPath,
  args: [getBundledSwarmAcpEntrypoint()],
  env: {
    ELECTRON_RUN_AS_NODE: "1",
    VSCODE_ACP_CHAT_SWARM_CONFIG_PATH: runtimeConfigPath,
  },
  liveToolOutputProfile: "bundled-swarm",
}
```

Lý do:

- Reuse `ACPClient`, agent selector, session lifecycle, permissions, diff summary, package flow.
- Không phải fork toàn bộ chat surface.
- User nhìn thấy Swarm như một agent rõ ràng, không phải magic mode.

### 2. Bundled `swarm-acp` adapter là hạ tầng Root Orchestrator

`swarm-acp` là một ACP agent process nói chuyện với VS Code extension. Bên trong nó chạy workflow engine và spawn worker ACP agents như child processes.

```text
VS Code Chat Webview
        │
        ▼
Extension ACPClient
        │ ACP stdio
        ▼
Swarm ACP Adapter / Root Orchestrator
        ├─ WorkerRuntime(step A role = user-defined)
        ├─ WorkerRuntime(step B role = user-defined)
        ├─ WorkerRuntime(step C role = user-defined)
        └─ WorkerRuntime(step N role = user-defined)
```

Root chỉ có một protocol quản lý worker: internal Swarm worker runtime qua ACP. Không thêm tầng orchestrator khác.

### 3. Role/workflow là data, không phải code cố định

Engine không được có logic kiểu:

```ts
runPlanner();
runImplementer();
runReviewer();
runProofAuditor();
```

Thay vào đó:

```ts
const workflow = loadWorkflow(config.defaultWorkflow);
await workflowEngine.execute(workflow, userPrompt);
```

Mọi role đều được resolve từ config:

```toml
# .vscode/acp-swarm/roles/security-reviewer.toml
id = "security-reviewer"
displayName = "Security Reviewer"
agentId = "pi"
mode = "review"
promptFile = "./prompts/security-reviewer.md"

[capabilities]
read = true
write = false
terminal = "restricted"
testLock = true
```

### 4. Dedicated worker sessions, không dùng sub-agent tool

Mỗi worker invocation phải có:

- process/session riêng;
- context/history riêng;
- role instruction riêng;
- capability policy riêng;
- state riêng.

Trong JavaScript runtime, “dedicated thread” được hiện thực bằng **dedicated ACP child process/session** thay vì OS thread. Không gọi `delegate_*`/sub-agent tool của Pi/Codex để tạo worker cho Swarm MVP.

### 5. Workflow config định nghĩa quy trình

Workflow là DAG hoặc step list có dependency rõ ràng:

```toml
# .vscode/acp-swarm/workflows/feature-dev.toml
id = "feature-dev"
displayName = "Feature Development"
entry = "architecture"
final = "summary"

[[steps]]
id = "architecture"
role = "architect"
prompt = "Analyze the task and identify foundation risks."
produces = ["architecture-notes"]

[[steps]]
id = "build"
role = "builder"
dependsOn = ["architecture"]
prompt = "Implement according to architecture-notes and original task."
requiresLocks = ["workspace_write"]
produces = ["diff", "verification-log"]

[[steps]]
id = "review"
role = "reviewer"
dependsOn = ["build"]
prompt = "Review diff and verification-log."
produces = ["review-findings"]

[[steps]]
id = "summary"
role = "root"
dependsOn = ["review"]
prompt = "Summarize outputs and unresolved risks."
```

Tên role và số lượng step là của user. MVP chỉ cần engine generic đủ chạy các step này.

### 6. Host materializes runtime config for adapter

Adapter process không import `vscode`. Extension Host phải materialize runtime config vào `globalStorageUri` trước khi spawn adapter:

```json
{
  "version": 1,
  "workspaceRoot": "/repo",
  "agents": [
    { "id": "pi", "name": "Pi", "command": "...", "args": ["..."], "env": { "...": "..." } }
  ],
  "roles": {
    "architect": { "agentId": "pi", "capabilities": { "read": true, "write": false } },
    "builder": { "agentId": "pi", "capabilities": { "read": true, "write": true } }
  },
  "workflows": {
    "feature-dev": { "steps": [] }
  },
  "locks": {
    "test_runner": { "patterns": ["npm test", "npm run test", "cargo test", "go test", "pytest"] }
  }
}
```

`swarm-acp` chỉ đọc file này qua env `VSCODE_ACP_CHAT_SWARM_CONFIG_PATH`.

### 7. Worker autonomy protocol

Root không gửi prompt kiểu:

```text
Tôi nghĩ đáp án là X. Hãy xác nhận.
```

Root phải render step prompt theo config, kèm original user task, dependency outputs và constraints. Role prompt có thể yêu cầu worker phản biện hoặc tự khám phá, nhưng đó là cấu hình của user.

### 8. Authority gradient mitigation bằng role wording, không deception

Không làm worker “nghĩ đang nói chuyện với human”. Hạ tầng chỉ đảm bảo:

- worker nhận role identity đầy đủ từ role config;
- step prompt không tự động pre-solve;
- output contract yêu cầu evidence/risks nếu user cấu hình;
- Root có thể pass dependency outputs nhưng không ép worker xác nhận kết luận của Root.

### 9. Monitor normalize state, tránh Idle/Done freeze

Swarm dùng một state machine chung:

```text
CREATED
  ↓
STARTING
  ↓
IDLE ── dispatch ──▶ RUNNING
  │                   │
  │                   ├─ permission ─▶ AWAITING_PERMISSION ─▶ RUNNING
  │                   ├─ blocked    ─▶ BLOCKED
  │                   ├─ success    ─▶ DONE
  │                   ├─ failure    ─▶ FAILED
  │                   └─ cancel     ─▶ CANCELLED
  └─ dispose ─▶ DISPOSED
```

Monitor chịu trách nhiệm map trạng thái worker/ACP khác nhau vào state chung. Root không chờ trực tiếp trạng thái raw như `Idle` hay `Done` từ từng worker.

### 10. Locks are explicit generic resources

MVP locks:

- `test_runner`: serialize heavy test commands.
- `workspace_write`: global write phase lock nếu workflow muốn single-writer.
- `workspace_write:<path>`: serialize writes/rollbacks theo file path.
- User-defined named locks: `database`, `docker`, `gpu`, `benchmark`, ...

Step có thể declare locks:

```toml
[[steps]]
id = "integration-tests"
role = "qa"
requiresLocks = ["test_runner", "database"]
```

Test lock có thể được acquire tự động bằng terminal command pattern matching trước khi forward `terminal/create` đến upstream client.

### 11. Capability policy is generic, not role-name based

Không hard-code reviewer/proof read-only. Read-only là capability policy của role hoặc step:

```toml
[capabilities]
read = true
write = false
terminal = "restricted"
allowFileDelete = false
```

Adapter enforce policy ở capability proxy:

| Capability      | Enforced behavior                                                |
| --------------- | ---------------------------------------------------------------- |
| `read=false`    | Deny `fs.readTextFile` forwarding                                |
| `write=false`   | Deny `fs.writeTextFile` forwarding                               |
| `terminal=false`| Deny terminal creation                                           |
| `terminal=restricted` | Allow only configured command patterns or require approval |
| `testLock=true` | Acquire `test_runner` before test-like terminal command          |

If any role sends a denied request, adapter returns a structured denial and records policy violation in the run summary.

### 12. Foundation/anti-pattern checks are optional templates

Swarm hạ tầng không bắt buộc Foundation Gate. Thay vào đó ship optional sample prompt/template pack:

```text
examples/acp-swarm/templates/
├── anti-patterns.md
├── feature-dev.workflow.toml
├── foundation-review.role.toml
└── proof-auditor.role.toml
```

User có thể copy vào workspace nếu muốn workflow có Foundation Gate, Balloon Pattern check, Lock Explosion check, v.v.

### 13. Live progress uses ACP tool cards

Swarm emits ACP tool calls instead of custom webview-only progress for MVP:

- `swarm_run`: run-level status and selected workflow.
- `swarm_step`: per-step state/progress/live preview.
- `swarm_worker`: per-worker runtime details.
- `swarm_lock`: lock wait/acquire/release events.
- `swarm_evidence`: collected outputs/artifacts.

Add live output profile `bundled-swarm` to project these tool updates as `subagent`/text/terminal presentations.

### 14. Dedicated monitor panel is phase 2, not required for first runnable MVP

MVP can show progress inside existing chat. A dedicated monitor panel under `src/features/swarm-agent/webview.ts` can be added after the adapter is stable.

## Proposed file changes

```text
src/features/swarm-agent/
├── host.ts                         # VS Code host integration: config materialization + AgentConfig
├── index.ts                        # public exports
├── live-tool-output.ts             # bundled-swarm projection for run/step/worker/lock updates
├── types.ts                        # shared role/config/workflow/state/message types; no vscode import
├── adapter/
│   ├── index.ts                    # ACP agent entrypoint
│   ├── root-orchestrator.ts        # single Root workflow controller
│   ├── workflow-engine.ts          # generic DAG/step executor
│   ├── worker-runtime.ts           # nested ACP client/process/session per worker invocation
│   ├── capability-proxy.ts         # forwards/denies worker fs/terminal/permission requests
│   ├── lock-manager.ts             # named locks and path locks
│   ├── monitor.ts                  # worker/step state normalization and progress emission
│   ├── config-loader.ts            # parse/materialize role/workflow config
│   ├── prompt-renderer.ts          # render role + step + dependency outputs
│   ├── evidence-store.ts           # collect step outputs, logs, artifacts, violations
│   └── state-machine.ts            # explicit states/transitions
├── webview.ts                      # phase 2 monitor UI, no vscode import
└── styles.ts                       # phase 2 monitor styles

examples/acp-swarm/
├── README.md
├── roles/*.toml
├── workflows/*.toml
└── templates/anti-patterns.md

src/acp/agents.ts                   # add LiveToolOutputProfileId "bundled-swarm" and built-in Swarm config
src/acp/session-output-pipeline.ts  # register bundled-swarm live profile
src/features/register-host.ts       # phase 2: register optional monitor host feature
src/features/register-webview.ts    # phase 2: register optional monitor webview feature
package.json                        # setting, command, configuration schema
esbuild.js                          # bundle dist/swarm-acp/index.mjs
.vscodeignore                       # include dist/swarm-acp/**
src/test/features/swarm-agent.test.ts
src/test/features/swarm-agent-adapter.test.ts
```

## Configuration proposal

```json
{
  "vscode-acp-chat.swarmAgent.enabled": false,
  "vscode-acp-chat.swarmAgent.configDirectory": ".vscode/acp-swarm",
  "vscode-acp-chat.swarmAgent.defaultWorkflow": "default",
  "vscode-acp-chat.swarmAgent.maxWorkers": 4,
  "vscode-acp-chat.swarmAgent.requireApprovalBeforeWrites": true,
  "vscode-acp-chat.swarmAgent.testLockPatterns": [
    "npm test",
    "npm run test",
    "cargo test",
    "go test",
    "pytest"
  ]
}
```

Recommended default: disabled, because multi-worker write/test behavior is experimental and can consume many resources.

## Implementation tasks

### Phase 1: Foundation and built-in registration

#### Task 1: Add experimental Swarm agent catalog entry

**Description:** Add `src/features/swarm-agent/host.ts` with `createSwarmAgentConfig()` and register `Swarm` in `src/acp/agents.ts` only when `swarmAgent.enabled=true`.

**Acceptance criteria:**

- [ ] `Swarm` appears in built-in agents only when setting is enabled.
- [ ] Custom agent with `id: "swarm"` can override built-in Swarm.
- [ ] Agent config uses bundled adapter entrypoint and `ELECTRON_RUN_AS_NODE=1`.
- [ ] No orchestration logic is added to core files.

**Verification:**

- [ ] `npm run check-types`
- [ ] Agent catalog tests cover enabled/disabled/override behavior.

**Dependencies:** None

**Files likely touched:**

- `src/features/swarm-agent/host.ts`
- `src/features/swarm-agent/index.ts`
- `src/acp/agents.ts`
- `package.json`
- `src/test/agents.test.ts`
- `src/test/features/swarm-agent.test.ts`

**Estimated scope:** Medium

#### Task 2: Define role/workflow/config/state schemas

**Description:** Add shared types for arbitrary roles, workflow steps, dependencies, locks, capability policy, worker state and runtime config. Implement schema validation and a pure state machine module.

**Acceptance criteria:**

- [ ] Role ids are arbitrary strings, not a closed enum.
- [ ] Workflow steps reference role ids from config.
- [ ] Invalid workflow dependencies are detected before execution.
- [ ] Worker/step states are normalized to a single enum.
- [ ] Types do not import `vscode` and can be used by both host and adapter.

**Verification:**

- [ ] Unit tests cover arbitrary role ids, missing role, cycle detection and `DONE` vs `IDLE` normalization.
- [ ] `npm run check-types`

**Dependencies:** Task 1

**Files likely touched:**

- `src/features/swarm-agent/types.ts`
- `src/features/swarm-agent/adapter/state-machine.ts`
- `src/test/features/swarm-agent.test.ts`

**Estimated scope:** Medium

#### Task 3: Materialize runtime config for adapter

**Description:** Extension Host resolves built-in/custom agents, workspace role files, workflow files, locks and settings into a runtime JSON file consumed by `swarm-acp`.

**Acceptance criteria:**

- [ ] Adapter receives a config file path via `VSCODE_ACP_CHAT_SWARM_CONFIG_PATH`.
- [ ] Runtime config includes workspace root, available agents, arbitrary role configs, workflows and lock config.
- [ ] Missing config directory produces a clear setup error or optional bootstrap prompt.
- [ ] Invalid role/workflow config surfaces a clear validation error before Swarm starts.

**Verification:**

- [ ] Unit tests for valid config, missing workflow, missing role, invalid dependency and invalid capability policy.
- [ ] `npm run check-types`

**Dependencies:** Task 2

**Files likely touched:**

- `src/features/swarm-agent/host.ts`
- `src/features/swarm-agent/adapter/config-loader.ts`
- `src/features/swarm-agent/types.ts`
- `package.json`
- `src/test/features/swarm-agent.test.ts`

**Estimated scope:** Medium

#### Checkpoint: Infrastructure config foundation

- [ ] `Swarm` can be listed as an agent when enabled.
- [ ] Runtime config can be generated deterministically.
- [ ] Arbitrary roles/workflows validate.
- [ ] No fixed planner/implementer/reviewer/proof workflow exists in code.

### Phase 2: Bundled ACP adapter and generic workflow engine

#### Task 4: Add `swarm-acp` build target and protocol skeleton

**Description:** Create bundled adapter entrypoint that implements minimal ACP agent methods: initialize, session/new, session/prompt and cancel. Initial prompt should load config and report setup errors clearly.

**Acceptance criteria:**

- [ ] `dist/swarm-acp/index.mjs` is produced by `esbuild.js`.
- [ ] VSIX includes bundled adapter.
- [ ] Adapter runs via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.
- [ ] Adapter does not import `vscode`.

**Verification:**

- [ ] `npm run package`
- [ ] Smoke test starts adapter and completes ACP initialize/new/prompt.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/swarm-agent/adapter/index.ts`
- `esbuild.js`
- `.vscodeignore`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 5: Implement generic workflow DAG executor

**Description:** Implement a workflow engine that executes configured steps by dependency order, supports serial/parallel runnable steps, condition hooks, retry limits and failure policy.

**Acceptance criteria:**

- [ ] Engine executes steps in topological order.
- [ ] Independent steps can run in parallel up to `maxWorkers`.
- [ ] Step ids, roles and prompts come only from config.
- [ ] No hard-coded role names or fixed workflow sequence.
- [ ] Failed step obeys configured `onFailure` policy: `stop`, `continue`, `retry`, or `askUser`.

**Verification:**

- [ ] Unit tests cover serial DAG, parallel DAG, cycle rejection, retry and failure policy.

**Dependencies:** Task 4

**Files likely touched:**

- `src/features/swarm-agent/adapter/workflow-engine.ts`
- `src/features/swarm-agent/adapter/root-orchestrator.ts`
- `src/features/swarm-agent/types.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 6: Implement dedicated worker runtime

**Description:** Implement nested ACP client runtime inside adapter. Each workflow step can spawn its configured role's ACP agent as a separate child process/session and isolated history/context.

**Acceptance criteria:**

- [ ] Worker runtime can initialize a child ACP agent and create a session.
- [ ] Worker runtime can send a rendered step prompt and collect final output.
- [ ] Worker stderr, session updates and exit errors are associated with step id and role id.
- [ ] Root can dispose all child processes on cancel/dispose.

**Verification:**

- [ ] Adapter tests with fake worker ACP server.
- [ ] Cancellation test proves child processes are killed/closed.

**Dependencies:** Task 5

**Files likely touched:**

- `src/features/swarm-agent/adapter/worker-runtime.ts`
- `src/features/swarm-agent/adapter/root-orchestrator.ts`
- `src/features/swarm-agent/types.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 7: Add generic capability proxy for worker requests

**Description:** When a worker asks for fs/terminal/permission capability, adapter enforces role/step policy and forwards allowed requests to the upstream VS Code ACP client.

**Acceptance criteria:**

- [ ] `write=false` denies `fs.writeTextFile` for any role.
- [ ] `terminal=false` denies terminal creation for any role.
- [ ] Denied requests return clear structured errors visible to Root summary.
- [ ] Allowed fs/terminal requests are forwarded upstream without losing response semantics.
- [ ] Permission requests include workflow id, step id and role id context.

**Verification:**

- [ ] Tests cover arbitrary read-only role write denial.
- [ ] Tests cover write-capable role forwarding.
- [ ] Tests cover permission request context propagation.

**Dependencies:** Task 6

**Files likely touched:**

- `src/features/swarm-agent/adapter/capability-proxy.ts`
- `src/features/swarm-agent/adapter/worker-runtime.ts`
- `src/features/swarm-agent/types.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 8: Add monitor and live step/worker progress

**Description:** Implement Department Monitor that observes workflow, steps, worker state, output, tool activity and lock waits, then emits ACP `tool_call`/`tool_call_update` messages to the outer chat.

**Acceptance criteria:**

- [ ] Each workflow step has a stable tool card id.
- [ ] Each worker invocation can emit status/progress under its step.
- [ ] Monitor can mark step/worker `DONE`, `FAILED`, `BLOCKED`, `CANCELLED` without Root polling raw states.
- [ ] No freeze when worker reaches `DONE` while Root expected `IDLE`.

**Verification:**

- [ ] Unit tests for monitor state normalization.
- [ ] Adapter integration test shows live `swarm_step` and `swarm_worker` updates.

**Dependencies:** Task 6

**Files likely touched:**

- `src/features/swarm-agent/adapter/monitor.ts`
- `src/features/swarm-agent/adapter/state-machine.ts`
- `src/features/swarm-agent/adapter/root-orchestrator.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 9: Add `bundled-swarm` live output profile

**Description:** Project Swarm tool updates into existing webview tool presentations, reusing `subagent`, text and terminal renderers.

**Acceptance criteria:**

- [ ] `swarm_run` renders workflow id/status.
- [ ] `swarm_step` renders step id, role id, status, elapsed time and preview.
- [ ] `swarm_lock` renders lock wait/acquire/release clearly.
- [ ] Unknown Swarm tool payloads degrade to safe text output.
- [ ] HTML is escaped and large output is bounded.

**Verification:**

- [ ] Unit tests for `bundledSwarmLiveToolOutputProfile`.
- [ ] Existing webview tool-render tests remain green.

**Dependencies:** Task 8

**Files likely touched:**

- `src/features/swarm-agent/live-tool-output.ts`
- `src/acp/agents.ts`
- `src/acp/session-output-pipeline.ts`
- `src/test/tool-output-presentation.test.ts`
- `src/test/webview.test.ts`

**Estimated scope:** Small

#### Checkpoint: Runnable infrastructure MVP

- [ ] Selecting `Swarm` can start a Swarm ACP session.
- [ ] Configured workflow with arbitrary role ids can run against fake workers.
- [ ] Cancel disposes workers.
- [ ] Capability policy is enforced by code, not only prompt.

### Phase 3: Locks, prompt rendering and evidence

#### Task 10: Implement generic lock manager

**Description:** Add lock manager for named locks and path locks. Use it in capability proxy for test commands and file writes.

**Acceptance criteria:**

- [ ] Only one worker can hold a named exclusive lock at a time.
- [ ] Test command pattern matching is configurable.
- [ ] File writes are serialized per path.
- [ ] Lock wait/acquire/release events are emitted to monitor.
- [ ] Workflow step `requiresLocks` is honored before step execution.

**Verification:**

- [ ] Unit tests run concurrent fake test commands and prove serialization.
- [ ] Unit tests run concurrent writes to same path and prove ordering.
- [ ] Unit tests cover user-defined named lock.

**Dependencies:** Task 7, Task 8

**Files likely touched:**

- `src/features/swarm-agent/adapter/lock-manager.ts`
- `src/features/swarm-agent/adapter/capability-proxy.ts`
- `src/features/swarm-agent/adapter/workflow-engine.ts`
- `src/features/swarm-agent/adapter/monitor.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 11: Add write/terminal approval gates from config

**Description:** Allow config to require user approval before selected capabilities are used, independent of role names.

**Acceptance criteria:**

- [ ] `requireApprovalBeforeWrites=true` pauses before first write-capable action.
- [ ] Step/role can require approval for terminal commands.
- [ ] Denial stops, skips, or replans according to workflow `onDenied` policy.
- [ ] No files are written before approval when approval is required.

**Verification:**

- [ ] Adapter tests cover approve/deny paths.
- [ ] Manual check with real VS Code permission UI.

**Dependencies:** Task 7

**Files likely touched:**

- `src/features/swarm-agent/adapter/root-orchestrator.ts`
- `src/features/swarm-agent/adapter/capability-proxy.ts`
- `src/features/swarm-agent/types.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Small

#### Task 12: Implement prompt renderer and step IO

**Description:** Render each step prompt from original user task, role prompt, step prompt, dependency outputs and workflow variables. Store structured outputs for downstream steps.

**Acceptance criteria:**

- [ ] Prompt renderer never injects Root’s guessed answer as truth.
- [ ] Step can consume outputs from configured dependency steps.
- [ ] Workflow variables can be referenced in prompts.
- [ ] Missing dependency output produces clear error.
- [ ] Output contract can be plain text in MVP, with structured JSON schema as optional later enhancement.

**Verification:**

- [ ] Unit tests cover prompt rendering, dependency output injection and missing output.

**Dependencies:** Task 5, Task 6

**Files likely touched:**

- `src/features/swarm-agent/adapter/prompt-renderer.ts`
- `src/features/swarm-agent/adapter/evidence-store.ts`
- `src/features/swarm-agent/adapter/workflow-engine.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Task 13: Add evidence store and final aggregation

**Description:** Collect step outputs, worker logs, capability denials, lock events, verification commands and artifacts into an evidence store. Final response is generated from workflow outputs, not hard-coded role semantics.

**Acceptance criteria:**

- [ ] Every step output is addressable by step id.
- [ ] Capability denials and failed commands appear in final evidence.
- [ ] Final aggregation uses configured `final` step or default evidence summary.
- [ ] Root never reports success if workflow ended failed/blocked/skipped without saying so.

**Verification:**

- [ ] Tests cover successful workflow, blocked workflow and partial workflow final summaries.

**Dependencies:** Task 12

**Files likely touched:**

- `src/features/swarm-agent/adapter/evidence-store.ts`
- `src/features/swarm-agent/adapter/root-orchestrator.ts`
- `src/features/swarm-agent/adapter/workflow-engine.ts`
- `src/test/features/swarm-agent-adapter.test.ts`

**Estimated scope:** Medium

#### Checkpoint: Generic configurable Swarm

- [ ] Arbitrary workflow can run multiple configured roles.
- [ ] Role/step policies and locks are enforced.
- [ ] Outputs/evidence flow between steps.
- [ ] No built-in assumption about planner/implementer/reviewer/proof exists.

### Phase 4: Optional UX and examples

#### Task 14: Add config bootstrap command

**Description:** Add optional command to create starter config files from examples. This helps users but does not force one workflow.

**Acceptance criteria:**

- [ ] Command `vscode-acp-chat.createSwarmConfig` creates `.vscode/acp-swarm/` only after user confirmation.
- [ ] User can choose from sample templates: minimal, feature-dev, review-only, docs-update.
- [ ] Existing config files are not overwritten silently.

**Verification:**

- [ ] Unit tests for bootstrap file generation.
- [ ] Manual check in temp workspace.

**Dependencies:** Task 3

**Files likely touched:**

- `src/features/swarm-agent/host.ts`
- `examples/acp-swarm/**`
- `package.json`
- `src/test/features/swarm-agent.test.ts`

**Estimated scope:** Small

#### Task 15: Add optional Swarm monitor command/panel

**Description:** Add optional monitor surface for active Swarm run status. This is separate from MVP live tool cards and should be implemented only after adapter is stable.

**Acceptance criteria:**

- [ ] Command `vscode-acp-chat.openSwarmMonitor` opens a monitor view/panel when Swarm is active.
- [ ] Webview imports no `vscode` module directly.
- [ ] Messages are prefixed `feature.swarm-agent.*`.
- [ ] Panel shows workflow, steps, roles, states, locks and latest evidence without duplicating chat transcript.

**Verification:**

- [ ] Webview unit tests for message handling/rendering.
- [ ] Manual check with active Swarm run.

**Dependencies:** Task 13

**Files likely touched:**

- `src/features/swarm-agent/host.ts`
- `src/features/swarm-agent/webview.ts`
- `src/features/swarm-agent/styles.ts`
- `src/features/register-host.ts`
- `src/features/register-webview.ts`
- `src/views/webview/main.ts`
- `package.json`
- `src/test/features/swarm-agent.test.ts`

**Estimated scope:** Medium

#### Task 16: Add docs and package verification

**Description:** Document how to enable Swarm, create arbitrary roles/workflows, define locks/capabilities, bootstrap examples and troubleshoot worker failures. Run full extension packaging and install flow.

**Acceptance criteria:**

- [ ] README or feature docs explain experimental status and required worker agents.
- [ ] Docs state that workflow is user-defined and not hard-coded.
- [ ] Role/workflow examples are documented.
- [ ] Limitations are explicit: no restart resume, no auto-commit, no guaranteed compatibility with every ACP agent.
- [ ] VSIX contains `dist/swarm-acp/index.mjs`.

**Verification:**

- [ ] `npm run check-types`
- [ ] `npm run lint`
- [ ] Relevant tests for agents, adapter, live output and webview.
- [ ] `npm run package`
- [ ] `npx vsce package --out <path>.vsix`
- [ ] `code --install-extension <path>.vsix --force`

**Dependencies:** Task 13 or Task 15 if monitor UI is included

**Files likely touched:**

- `README.md`
- `docs/features/feature-catalog.md`
- `docs/plans/implement-built-in-swarm-agent.md`
- `.vscodeignore`

**Estimated scope:** Small

## Parallelization opportunities

Safe after Task 3:

- Adapter skeleton/build target and pure state machine tests can proceed independently.
- Live output profile can be developed with fixture payloads after tool payload contract is drafted.
- Example role/workflow templates can be drafted while worker runtime is built.

Must be sequential:

- Config schema before workflow engine.
- Workflow engine before full Root orchestration.
- Worker runtime before executing real steps.
- Capability proxy before allowing write/terminal-capable roles.
- Lock manager before concurrent test/write-capable steps are enabled.

Needs coordination:

- Tool update payload shape between adapter and live output profile.
- Runtime config schema between host materializer and adapter loader.
- Monitor message contract if optional webview panel is added.

## Risks and mitigations

| Risk                                              | Impact | Mitigation                                                                                               |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| Workflow DSL becomes too complex                  | High   | MVP supports minimal DAG fields only: `id`, `role`, `prompt`, `dependsOn`, `requiresLocks`, `onFailure` |
| User expects built-in magic workflow              | Medium | Docs and UI say Swarm is infrastructure; examples are opt-in                                             |
| Nested ACP adapter becomes too complex            | High   | Fake-worker tests first; one Root protocol; no custom chat mode                                          |
| Worker agent incompatibility                      | High   | Runtime config validates capabilities; final summary reports unsupported agent/capability                |
| Read-only role accidentally modifies files        | High   | Enforce `write=false` at capability proxy, not only prompt                                               |
| Heavy tests run concurrently and produce false reds| High   | `test_runner` lock with visible wait/acquire/release events                                              |
| Live progress floods webview                      | Medium | Coalesce tool updates, send bounded full snapshots, reuse existing live-output truncation                 |
| Role config becomes blackbox                      | Medium | Expose effective config/debug dump; examples are small and editable                                      |
| Security concern from spawning multiple agent CLIs | Medium | Disabled by default, max worker limit, existing ACP permission flow, approval gates                       |
| Adapter cannot use VS Code APIs                   | Medium | Host materializes runtime config; adapter communicates only through ACP capabilities                     |
| State mismatch causes freeze                      | Medium | Monitor owns normalized state machine; Root does not wait on raw worker-specific `idle`/`done` semantics |

## Open questions

- Config format MVP: TOML to match role config notes, or JSONC to avoid adding a TOML parser dependency?
- Should missing `.vscode/acp-swarm/` show a setup error only, or offer bootstrap command automatically?
- Should default workflow be selected by setting, command argument, or a lightweight prompt picker before first Swarm prompt?
- Should each workflow step always spawn a fresh worker session, or allow reuse of a role session across multiple steps?
- Should write-capable steps default to single-writer via `workspace_write`, or leave that entirely to workflow config?

## Definition of done

- [ ] `Swarm` is selectable as a built-in agent when enabled.
- [ ] User can define arbitrary role configs; role ids are not hard-coded.
- [ ] User can define arbitrary workflow DAGs; fixed planner/implementer/reviewer/proof sequence is not hard-coded.
- [ ] A Swarm run can spawn dedicated worker sessions for configured workflow steps.
- [ ] Worker/step states and locks are visible in chat live output.
- [ ] Capability policy is enforced by code for any role.
- [ ] Test commands and file writes can be serialized through generic locks.
- [ ] Final summary reports workflow status, evidence, failures and blockers truthfully.
- [ ] Relevant automated tests pass.
- [ ] Production build, VSIX package and local install complete successfully.
