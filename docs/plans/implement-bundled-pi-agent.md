# Implementation Plan: Bundled Pi ACP Agent

| Attribute  | Value                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented                                                                                                    |
| Owner      | TBD                                                                                                            |
| Scope      | Extension Host agent catalog, bundled ACP adapter, packaging, docs, tests                                      |
| References | `src/acp/agents.ts`, `src/acp/client.ts`, `src/utils/bin-paths.ts`, `esbuild.js`, `.vscodeignore`, `README.md` |

## Objective

Chuyển cấu hình Pi hiện đang phải khai báo thủ công qua `vscode-acp-chat.customAgents` thành built-in agent của extension.

Cấu hình cũ của user:

```json
{
  "vscode-acp-chat.customAgents": [
    {
      "id": "pi",
      "name": "Pi",
      "command": "pi-acp",
      "args": []
    }
  ]
}
```

Trạng thái mong muốn:

- Extension ship sẵn Pi trong danh sách built-in agents.
- Extension không phụ thuộc vào `pi-acp` global trên máy user.
- Adapter `pi-acp` được fork/vendor/bundle vào VSIX.
- Máy user chỉ cần cài Pi CLI (`pi`) và hoàn tất login/provider setup.
- Existing `customAgents` vẫn có thể override built-in Pi bằng `id: "pi"`.

## Current-state analysis

### Built-in/custom agent flow

- `src/acp/agents.ts` định nghĩa `AGENTS` là catalog built-in agent tĩnh.
- `getCustomAgents()` đọc `vscode-acp-chat.customAgents`.
- `getMergedAgents()` merge built-in và custom, trong đó custom agent cùng `id` sẽ override built-in.
- `getAgentsWithStatus()` validate agent và dùng `isCommandAvailable(agent.command)` để xác định availability.
- `ACPClient.connect()` spawn `agentConfig.command` với `agentConfig.args`.

### `pi-acp` hiện tại

Trên môi trường hiện tại:

```text
pi-acp -> ~/.local/share/pi-node/node-v22.22.3-linux-x64/bin/pi-acp
realpath -> ~/.local/share/pi-node/node-v22.22.3-linux-x64/lib/node_modules/pi-acp/dist/index.js
```

Package metadata:

```json
{
  "name": "pi-acp",
  "version": "0.0.31",
  "repository": "https://github.com/svkozak/pi-acp.git",
  "license": "MIT"
}
```

`pi-acp` là ACP adapter. Nó nhận ACP JSON-RPC qua stdio rồi spawn Pi ở RPC mode:

```bash
pi --mode rpc --no-themes
```

Do đó chỉ thêm built-in agent với `command: "pi-acp"` là chưa đủ, vì user vẫn phải cài adapter ngoài. Muốn built-in đúng nghĩa, extension phải ship adapter.

## Architecture decisions

### 1. Vendor/fork `pi-acp` vào extension

Không runtime-install bằng `npx -y pi-acp` vì:

- Phụ thuộc network khi dùng extension.
- Không kiểm soát version.
- Khó debug khi upstream đổi behavior.

Đưa source adapter vào repo extension và build cùng extension.

Đề xuất vị trí:

```text
src/features/pi-agent/
├── host.ts
├── index.ts
└── vendor/
    └── pi-acp/
        ├── src/
        ├── LICENSE
        ├── README.md
        └── UPSTREAM.md
```

`UPSTREAM.md` cần ghi rõ:

- Repository: `https://github.com/svkozak/pi-acp.git`
- Imported version/tag/commit.
- Local patches nếu có.
- Cách sync lại upstream.

### 2. Bundle adapter thành artifact riêng trong `dist/`

Build target mới:

```text
src/features/pi-agent/vendor/pi-acp/src/index.ts
  -> dist/pi-acp/index.mjs
```

Lý do dùng output riêng:

- `ACPClient` vẫn spawn một process stdio độc lập cho agent.
- Không cần nhúng adapter vào `dist/extension.js`.
- Dễ kiểm tra VSIX có ship adapter hay không.

### 3. Pi built-in agent chạy bundled adapter bằng VS Code runtime

Không dùng:

```ts
command: "pi-acp";
```

Dùng bundled JS adapter:

```ts
{
  id: "pi",
  name: "Pi",
  command: process.execPath,
  args: [bundledPiAcpEntrypoint],
  env: {
    ELECTRON_RUN_AS_NODE: "1"
  },
  availabilityCommand: "pi"
}
```

`process.execPath` là VS Code/Electron executable. `ELECTRON_RUN_AS_NODE=1` cho phép chạy file JS như Node process mà không yêu cầu user cài `node` riêng.

### 4. Availability của Pi check `pi`, không check adapter

Adapter bundled luôn tồn tại nếu VSIX đóng gói đúng. Điều cần kiểm tra là Pi CLI mà adapter sẽ spawn.

Mở rộng `AgentConfig`:

```ts
export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  availabilityCommand?: string;
}
```

Sửa availability:

```ts
available: isCommandAvailable(agent.availabilityCommand ?? agent.command);
```

### 5. Giữ custom override

Không bỏ `vscode-acp-chat.customAgents`. User có thể override built-in Pi nếu cần bản adapter riêng:

```json
{
  "id": "pi",
  "name": "Pi Dev",
  "command": "node",
  "args": ["/path/to/pi-acp/dist/index.js"]
}
```

## Scope

### In scope

- Vendor/fork `pi-acp` vào repo extension.
- Build bundled `pi-acp` adapter vào `dist/pi-acp/index.mjs`.
- Add built-in Pi agent vào `AGENTS`.
- Mở rộng `AgentConfig` với `availabilityCommand`.
- Update validation, availability, tests, README.
- Ensure VSIX contains bundled adapter.
- Local package/install verification.

### Out of scope

- Bundle toàn bộ Pi coding agent (`@earendil-works/pi-coding-agent`) vào extension.
- Tự động cài Pi CLI cho user.
- Thay đổi auth/provider setup của Pi.
- Refactor `ACPClient` thành in-process adapter.
- Xóa cơ chế `customAgents`.

## Proposed file changes

```text
src/features/pi-agent/
├── host.ts                         # resolve bundled adapter path / create Pi AgentConfig
├── index.ts                        # public export for Pi built-in config helper
└── vendor/pi-acp/                  # fork/vendor adapter source + metadata

src/acp/agents.ts                   # AgentConfig.availabilityCommand + built-in Pi
src/acp/agent-validator.ts          # validate optional availabilityCommand
src/utils/bin-paths.ts              # optionally expose command resolution helper if needed
src/test/agents.test.ts             # Pi catalog tests
esbuild.js                          # third build target for adapter
.vscodeignore                       # ensure dist/pi-acp/** is included
README.md                           # built-in Pi docs
package.json                        # scripts/deps if adapter source requires them
```

## Implementation phases

### Phase 1: Import and isolate `pi-acp`

#### Task 1.1: Vendor upstream source

- Clone/copy `pi-acp` source from upstream into `src/features/pi-agent/vendor/pi-acp/`.
- Preserve `LICENSE` and `README.md`.
- Add `UPSTREAM.md` with source repo, version/commit, import date, and local patch notes.

Acceptance criteria:

- Vendor source is present in repo.
- License provenance is explicit.
- No generated `node_modules` is committed.

#### Task 1.2: Decide SDK compatibility strategy

Current mismatch:

- Extension uses `@agentclientprotocol/sdk@^1.2.0`.
- `pi-acp@0.0.31` declares `@agentclientprotocol/sdk@^0.26.0`.

Options:

1. Update vendor adapter to compile against extension SDK `1.2.0`.
2. Bundle adapter with its own SDK dependency version.

Recommendation: start with option 1 only if compile/test shows ACP API compatibility is low-risk. Otherwise keep adapter dependency isolated in bundle.

Acceptance criteria:

- Adapter builds successfully.
- ACP initialize/new session/prompt smoke test passes.

### Phase 2: Build bundled adapter artifact

#### Task 2.1: Add esbuild target

Update `esbuild.js` with a Node ESM build target:

```text
entryPoints: ["src/features/pi-agent/vendor/pi-acp/src/index.ts"]
format: "esm"
platform: "node"
outfile: "dist/pi-acp/index.mjs"
```

Need preserve shebang only if output is run directly. If executed via `process.execPath dist/pi-acp/index.mjs`, executable bit/shebang is not required.

Acceptance criteria:

- `npm run package` creates `dist/pi-acp/index.mjs`.
- The adapter bundle does not rely on source files omitted by `.vscodeignore`.

#### Task 2.2: Package inclusion check

`.vscodeignore` already includes `!dist/**`, but verify final VSIX contains:

```text
extension/dist/pi-acp/index.mjs
```

Acceptance criteria:

- `unzip -l <vsix> | grep 'dist/pi-acp/index.mjs'` returns the artifact.

### Phase 3: Add Pi built-in agent

#### Task 3.1: Add Pi agent config helper

Create a small feature integration point, e.g. `src/features/pi-agent/host.ts`:

```ts
import * as path from "path";
import type { AgentConfig } from "../../acp/agents";

export function createPiAgentConfig(): AgentConfig {
  return {
    id: "pi",
    name: "Pi",
    command: process.execPath,
    args: [path.join(__dirname, "pi-acp", "index.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    availabilityCommand: "pi",
  };
}
```

Final path may need adjustment depending on bundled `__dirname` after esbuild. Verify against `dist/extension.js` runtime location.

Acceptance criteria:

- Built-in Pi points to bundled adapter path under extension `dist/`.
- No dependency on global `pi-acp` remains for default Pi.

#### Task 3.2: Extend agent typing and availability

Update `AgentConfig` and `getAgentsWithStatus()`:

```ts
available: isCommandAvailable(agent.availabilityCommand ?? agent.command);
```

Update validator to allow optional string `availabilityCommand`.

Acceptance criteria:

- Existing agents are unaffected.
- Pi availability reflects whether `pi` is on PATH.
- Custom `id: "pi"` still overrides built-in Pi.

#### Task 3.3: Add Pi to `AGENTS`

Add Pi near the end of the catalog to avoid changing default selection priority.

Acceptance criteria:

- Pi appears in agent selector when `pi` is available.
- If `pi` is missing, Pi is marked unavailable and connect error should instruct user to install `pi`, not `pi-acp`.

### Phase 4: Tests and docs

#### Task 4.1: Add tests

Add/adjust tests in `src/test/agents.test.ts`:

- `AGENTS` includes `pi`.
- `pi.command !== "pi-acp"`.
- `pi.availabilityCommand === "pi"`.
- `pi.args` includes bundled adapter entrypoint.
- Optional: validation accepts `availabilityCommand` when string and rejects non-string.

Acceptance criteria:

- Tests document the expected bundled behavior.

#### Task 4.2: Update README

Update built-in agents table:

```md
| Pi | bundled `pi-acp` adapter, requires `pi` on `$PATH` | Checks `pi` |
```

Update prerequisites:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Add migration note:

- Remove old `vscode-acp-chat.customAgents` entry with `id: "pi"` to use bundled Pi.
- Keep it only if intentionally overriding the bundled adapter.

Acceptance criteria:

- README no longer implies users must install `pi-acp` for built-in Pi.
- Custom agent docs remain valid for non-built-in agents.

### Phase 5: Verification and local install

Required commands:

```bash
npm run check-types
npm test
npm run package
npx vsce package --out /tmp/vscode-acp-chat-pi-bundled.vsix
unzip -l /tmp/vscode-acp-chat-pi-bundled.vsix | grep 'dist/pi-acp/index.mjs'
code --install-extension /tmp/vscode-acp-chat-pi-bundled.vsix --force
```

Manual checks:

- Remove/disable `vscode-acp-chat.customAgents` entry for `pi`.
- Ensure `pi` is on PATH.
- Open agent selector and verify `Pi` appears.
- Start a Pi session and verify ACP initialize/session flow works.
- Temporarily hide `pi` from PATH and verify Pi becomes unavailable / error mentions installing Pi CLI.
- Run `Developer: Reload Window` after install.

## Risks and mitigations

| Risk                                                                                    | Impact | Mitigation                                                                                                         |
| --------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `pi-acp` SDK version conflicts with extension SDK                                       | High   | Decide compatibility in Phase 1; either patch adapter to SDK `1.2.0` or bundle isolated dependency.                |
| Bundled adapter path wrong after esbuild                                                | High   | Add tests/helper around path resolution and manually verify `dist/pi-acp/index.mjs` exists in installed extension. |
| `process.execPath` without `ELECTRON_RUN_AS_NODE` launches VS Code instead of Node mode | High   | Always set `ELECTRON_RUN_AS_NODE=1` for bundled JS adapter.                                                        |
| Availability check marks Pi available because adapter exists but `pi` missing           | Medium | Use `availabilityCommand: "pi"`.                                                                                   |
| User's old custom `id: "pi"` masks built-in Pi                                          | Medium | Document migration note; preserve override intentionally.                                                          |
| VSIX excludes vendor/runtime artifact                                                   | Medium | Keep `!dist/**`; add package verification via `unzip -l`.                                                          |
| Licensing/provenance unclear after vendoring                                            | Medium | Preserve upstream license and add `UPSTREAM.md`.                                                                   |

## Open questions

- Should built-in Pi use bundled adapter by default but allow a setting to choose external `pi-acp` for development? Recommendation: no new setting initially; use `customAgents` override.
- Should Pi be placed first in `AGENTS` to make it default when available? Recommendation: place near end to avoid changing existing default agent selection behavior.
- Should the extension auto-detect Pi installed under Pi's managed Node path even if not on shell PATH? Recommendation: start with existing PATH/global-bin detection; add specialized detection only if users report issues.

## Definition of Done

- Pi is a built-in agent without requiring global `pi-acp`.
- VSIX ships bundled `dist/pi-acp/index.mjs`.
- Pi availability checks the `pi` CLI.
- Existing custom-agent override behavior is preserved.
- README documents built-in Pi and migration from old custom config.
- Typecheck, tests, package build, VSIX packaging, package content check, and local install complete successfully.

## Completion notes

Implemented on 2026-07-14:

- Vendored `pi-acp` v0.0.31 (`9e857dcc05a057404eb1537e5f31e5aef88a5863`) under `src/features/pi-agent/vendor/pi-acp/` with license and upstream provenance.
- Added a production esbuild target for `dist/pi-acp/index.mjs`.
- Added built-in Pi agent config that launches the bundled adapter through VS Code/Electron Node mode and uses `availabilityCommand: "pi"`.
- Extended agent validation, package configuration schema, tests, README, and feature catalog for `availabilityCommand` and bundled Pi behavior.
- Verification completed: `npm run check-types`, `npm test`, `npm run package`, VSIX packaging, VSIX content check, and local `code --install-extension --force`.
