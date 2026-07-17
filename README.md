# VSCode ACP Chat

> Chạy các AI coding agent cục bộ trong VS Code thông qua Agent Client Protocol (ACP).

[![Giấy phép: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

[VSCode ACP Chat](https://github.com/pengjiantao/vscode-acp-chat) khởi chạy các tiến trình agent tương thích ACP trên máy cục bộ, đồng thời cung cấp giao diện chat dạng streaming, công cụ, quyền truy cập, diff và quản lý phiên ngay trong VS Code.

> [!NOTE]
> Đây là dự án cộng đồng, không phải implementation ACP chính thức hoặc integration chính thức của bất kỳ nhà cung cấp agent nào. Báo lỗi tại [GitHub Issues](https://github.com/pengjiantao/vscode-acp-chat/issues).

## Yêu cầu

Để sử dụng extension:

- VS Code `1.101.0` trở lên.
- Có ít nhất một ACP agent, adapter hoặc lệnh custom agent khả dụng.
- Hoàn tất đăng nhập/xác thực theo yêu cầu của agent trước khi kết nối.
- Cần có `npm`/`npx` nếu sử dụng adapter Claude Code hoặc Codex tích hợp sẵn, vì các adapter này được khởi chạy qua `npx`.

Để phát triển:

- Node.js `22`.
- pnpm `11.0.9` thông qua Corepack.

## Cài đặt

1. Mở **Extensions** trong VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Tìm **VSCode ACP Chat**.
3. Cài extension do `fiyqkrc` phát hành.

Bạn cũng có thể cài từ [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fiyqkrc.vscode-acp-chat).

## Bắt đầu chat

1. Mở view **ACP CHAT** trong **Secondary Sidebar** của VS Code hoặc chạy **ACP: Start Chat** từ Command Palette.
2. Nhấn biểu tượng robot trên thanh tiêu đề của view để chọn agent khả dụng. Mỗi lần chọn agent sẽ tạo một chat/session mới cho agent đó.
3. Nhập prompt. Dùng `/` để chọn lệnh do agent cung cấp và `@` để thêm file hoặc thư mục trong workspace.
4. Mở **ACP Sessions** từ Activity Bar để theo dõi và quản lý các phiên chạy đồng thời.

Các thao tác thêm ngữ cảnh:

- Chọn đoạn mã trong editor, nhấn chuột phải, sau đó chọn **ACP: Add Selection to Chat**.
- Chọn nội dung trong terminal, nhấn chuột phải, sau đó chọn **ACP: Add Terminal Selection to Chat**.
- Thêm file hoặc thư mục từ menu ngữ cảnh của Explorer.
- Đính kèm hoặc dán ảnh trực tiếp vào composer.

## Khả năng hiện tại

- **ACP agent cục bộ** — khởi chạy lệnh trên máy và giao tiếp qua ACP trên stdio.
- **Agent tích hợp sẵn và custom agent** — hỗ trợ bundled adapter, CLI trực tiếp, adapter chạy qua `npx` và cấu hình khởi chạy do người dùng định nghĩa.
- **Nhiều phiên đồng thời** — chế độ multi-session được bật mặc định; mỗi phiên có transcript, bản nháp, quyền truy cập, yêu cầu nhập liệu và trạng thái runtime độc lập, kèm trình quản lý phiên riêng.
- **Chat dạng streaming** — hiển thị Markdown, code block, nội dung suy luận, hoạt động công cụ, output terminal ANSI, hình ảnh và tiến trình trực tiếp từ các bundled agent được hỗ trợ.
- **Hàng đợi prompt** — xếp hàng prompt điều hướng và prompt tiếp nối trong khi agent đang xử lý một lượt.
- **Điều khiển theo capability** — chỉ hiển thị mode, model, tùy chọn cấu hình, lệnh, mức sử dụng context và chi phí khi agent công bố capability tương ứng.
- **Thu thập ngữ cảnh** — nhận nội dung được chọn trong editor/terminal, file và thư mục từ Explorer, workspace mention bằng `@`, slash command và hình ảnh.
- **Công cụ và quyền truy cập** — hiển thị thao tác filesystem, terminal, kết quả công cụ và yêu cầu cấp quyền tương tác.
- **ACP elicitation có cấu trúc** — agent tương thích có thể yêu cầu người dùng nhập form đã được kiểm tra dữ liệu mà không lạm dụng hộp thoại quyền truy cập.
- **Review diff** — hiển thị inline diff và cho phép review, chấp nhận hoặc hoàn tác các thay đổi file được theo dõi an toàn.
- **Lịch sử phiên** — liệt kê, tải, tiếp tục và xóa phiên khi agent hỗ trợ; metadata cục bộ của extension được dùng làm phương án dự phòng.
- **Chuyển tiếp MCP** — chuyển các định nghĩa MCP tương thích của VS Code vào lúc tạo hoặc tải ACP session.
- **Đồng bộ tài liệu** — gửi sự kiện mở/thay đổi/đóng/lưu/focus tài liệu cục bộ đến agent có hỗ trợ NES document.
- **Hỗ trợ điều hướng** — gồm lịch sử prompt, điều hướng giữa các câu trả lời, nhảy đến nội dung mới nhất, sao chép bảng và liên kết file/web có thể nhấn.

Phần lớn tính năng phụ thuộc vào capability của từng agent. Nếu agent không công bố một capability, UI hoặc thao tác protocol tương ứng sẽ không xuất hiện.

## Agent tích hợp sẵn

Extension kiểm tra tính khả dụng bằng lệnh ở cột cuối. Extension Host cũng tìm trong các thư mục binary global phổ biến của pnpm/npm nếu lệnh không có trong `PATH` ban đầu.

| Agent                       | Lệnh khởi chạy                                                       | Kiểm tra khả dụng                                   |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| OpenCode                    | `opencode acp`                                                       | `opencode`                                          |
| Claude Code                 | `npx -y @agentclientprotocol/claude-agent-acp@latest`                | `npx`                                               |
| Codex CLI                   | `npx -y @agentclientprotocol/codex-acp@latest`                       | `npx`                                               |
| Gemini CLI                  | `gemini --acp`                                                       | `gemini`                                            |
| Goose                       | `goose acp`                                                          | `goose`                                             |
| Amp                         | `amp acp`                                                            | `amp`                                               |
| Aider                       | `aider --acp`                                                        | `aider`                                             |
| Augment Code                | `augment acp`                                                        | `augment`                                           |
| Kimi CLI                    | `kimi --acp`                                                         | `kimi`                                              |
| Mistral Vibe                | `vibe acp`                                                           | `vibe`                                              |
| OpenHands                   | `openhands acp`                                                      | `openhands`                                         |
| Qwen Code                   | `qwen --acp`                                                         | `qwen`                                              |
| Kiro CLI                    | `kiro-cli acp`                                                       | `kiro-cli`                                          |
| Cursor                      | `cursor-agent acp`                                                   | `cursor-agent`                                      |
| CodeBuddy Code              | `codebuddy --acp`                                                    | `codebuddy`                                         |
| Grok Build                  | `grok --no-auto-update agent stdio`                                  | `grok`                                              |
| Pi                          | Bundled adapter `pi-acp`                                             | `pi`                                                |
| Antigravity (thử nghiệm)    | Bundled Node adapter                                                 | `agy`; được điều khiển bằng setting                 |
| Swarm (thử nghiệm, cần bật) | Bundled root orchestrator khởi chạy các ACP worker agent đã cấu hình | Bundled Node runtime; kiểm tra cấu hình khi kết nối |

Custom agent có cùng `id` với agent tích hợp sẵn sẽ thay thế cấu hình tích hợp đó. `id` mới sẽ được bổ sung vào danh sách agent.

### Grok Build

Entry `grok-build` khởi chạy trực tiếp Grok CLI chính thức đã được cài trên máy:

```bash
grok login
grok --version
```

Extension không cài đặt Grok và không quản lý thông tin xác thực. Có thể dùng `XAI_API_KEY` nếu biến này tồn tại trong môi trường của VS Code Extension Host. Khả năng tải/liệt kê phiên phụ thuộc vào capability do Grok công bố; metadata phiên cục bộ sẽ được dùng khi Grok không hỗ trợ liệt kê phiên qua ACP.

### Pi

Extension đóng gói sẵn ACP adapter nhưng vẫn yêu cầu `pi` CLI đã được cài đặt và xác thực. Mặc định, lịch sử Pi được tải lại đầy đủ theo active path từ file session JSONL của Pi:

```json
{
  "vscode-acp-chat.pi.historyLoadMode": "full"
}
```

Đặt thành `"compacted"` để phát lại context đã compact từ `get_messages` của Pi.

### Antigravity (thử nghiệm)

Manifest hiện tại bật entry Antigravity tích hợp sẵn theo mặc định bằng `vscode-acp-chat.antigravity.enabled: true`. Tính năng này vẫn đang thử nghiệm và không chính thức. Tắt setting nếu không muốn hiển thị entry này.

> [!WARNING]
> Google nêu rõ việc phần mềm bên thứ ba truy cập bằng Antigravity OAuth có thể vi phạm Điều khoản dịch vụ Antigravity và có thể khiến tài khoản bị đình chỉ hoặc chấm dứt. Hãy đọc [Điều khoản Antigravity](https://antigravity.google/terms) và [FAQ](https://antigravity.google/docs/faq) trước khi sử dụng.

Trước tiên, cài đặt và xác thực `agy` CLI chính thức:

```bash
agy
agy models
```

Bundled adapter:

- sử dụng lại phiên OAuth/keyring hiện có của `agy`;
- không cài đặt `agy` và không lưu thông tin xác thực OAuth;
- sử dụng các mode gốc của Antigravity: `default`, `accept-edits` và `plan`;
- không thêm cờ bỏ qua quyền truy cập;
- không nhận cấu hình MCP chuyển tiếp từ VS Code ACP, vì vậy MCP server cho Antigravity phải được cấu hình trong chính Antigravity.

Custom agent có `id: "antigravity"` sẽ ghi đè entry tích hợp sẵn.

### Swarm (thử nghiệm, cần bật thủ công)

Swarm mặc định bị tắt. Swarm chạy một Root ACP agent lâu dài, có thể trả lời trực tiếp hoặc định tuyến prompt vào một workflow đã cấu hình. Mỗi bước workflow chạy bằng một tiến trình ACP worker riêng, với capability policy, lock, evidence, quyền truy cập và tiến trình trực tiếp.

Tạo `.vscode/acp-swarm/` trong workspace từ [các file ví dụ Swarm](https://github.com/pengjiantao/vscode-acp-chat/tree/main/examples/acp-swarm), sau đó chỉnh sửa role và workflow. Nếu đang làm việc trong source checkout của repository này, có thể sao chép trực tiếp:

```bash
mkdir -p .vscode/acp-swarm
cp -R examples/acp-swarm/* .vscode/acp-swarm/
```

Bật tính năng trong settings:

```json
{
  "vscode-acp-chat.swarmAgent.enabled": true
}
```

`swarm.config.json` phải khai báo một `rootRole` hợp lệ. Entry Swarm được hiển thị dựa trên bundled Node runtime; cấu hình workspace và các agent được tham chiếu chỉ được kiểm tra khi kết nối. Xem [examples/acp-swarm/README.md](examples/acp-swarm/README.md) để biết cấu trúc và hành vi chi tiết. Các giới hạn hiện tại gồm: không khôi phục workflow sau khi Extension Host khởi động lại, không tự động commit và chưa có trình chỉnh sửa workflow trực quan.

## Custom agent

Cấu hình custom agent bằng `vscode-acp-chat.customAgents` trong `settings.json`:

```json
{
  "vscode-acp-chat.customAgents": [
    {
      "id": "my-agent",
      "name": "My Custom Agent",
      "command": "my-agent-cli",
      "args": ["--acp"],
      "env": {
        "API_KEY": "your-api-key"
      },
      "availabilityCommand": "my-agent-cli"
    }
  ]
}
```

| Trường                | Kiểu                     | Bắt buộc | Mô tả                                                                    |
| --------------------- | ------------------------ | -------- | ------------------------------------------------------------------------ |
| `id`                  | `string`                 | Có       | ID duy nhất; nếu trùng ID tích hợp sẵn thì custom agent sẽ ghi đè entry. |
| `name`                | `string`                 | Có       | Tên hiển thị trong trình chọn agent.                                     |
| `command`             | `string`                 | Có       | File thực thi do Extension Host khởi chạy.                               |
| `args`                | `string[]`               | Có       | Tham số dòng lệnh. Dùng `[]` nếu không có tham số.                       |
| `env`                 | `Record<string, string>` | Không    | Biến môi trường bổ sung cho tiến trình agent.                            |
| `availabilityCommand` | `string`                 | Không    | Lệnh chỉ dùng để kiểm tra khả dụng; mặc định là `command`.               |

## Tham chiếu cấu hình

Nhấn biểu tượng bánh răng trong chat view hoặc chạy **Preferences: Open Settings**, sau đó tìm `vscode-acp-chat`.

| Setting                                                  | Mặc định               | Tác dụng                                                                                                |
| -------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `vscode-acp-chat.enableDiffSummary`                      | `true`                 | Hiển thị bảng tổng hợp các file đã thay đổi.                                                            |
| `vscode-acp-chat.autoScroll.bottomThreshold`             | `100`                  | Khoảng cách đến cuối transcript mà tại đó auto-scroll vẫn hoạt động.                                    |
| `vscode-acp-chat.autoScroll.settleFrames`                | `3`                    | Số frame tiếp tục giữ transcript ở cuối khi layout thay đổi trong lúc streaming.                        |
| `vscode-acp-chat.fontSize`                               | `0`                    | Cỡ chữ chat; `0` dùng cỡ chữ VS Code, giá trị khác được giới hạn trong `8`-`40` px.                     |
| `vscode-acp-chat.multiSession.enabled`                   | `true`                 | Bật nhiều phiên đồng thời; khi tắt sẽ dùng luồng single-session cũ.                                     |
| `vscode-acp-chat.multiSession.lowResourceMode`           | `true`                 | Tắt diff tracking theo phiên, file watcher, conflict telemetry và diff badge trong trình quản lý phiên. |
| `vscode-acp-chat.multiSession.maxConcurrentSessions`     | `20`                   | Số tiến trình/ACP session cục bộ đã khởi chạy tối đa; draft session không được tính.                    |
| `vscode-acp-chat.passMcpServers`                         | `true`                 | Gửi định nghĩa MCP tương thích của VS Code trong request tạo/tải ACP session.                           |
| `vscode-acp-chat.enableDocumentSync`                     | `true`                 | Gửi sự kiện tài liệu cục bộ được hỗ trợ đến agent có capability tương ứng.                              |
| `vscode-acp-chat.debug`                                  | `false`                | Ghi log các sự kiện cập nhật ACP session thô.                                                           |
| `vscode-acp-chat.enablePersistentSessions`               | `true`                 | Lưu metadata phiên cục bộ trong VS Code global state.                                                   |
| `vscode-acp-chat.sessionRetentionDays`                   | `60`                   | Xóa metadata phiên cục bộ cũ hơn số ngày này.                                                           |
| `vscode-acp-chat.maxSessionsPerAgent`                    | `300`                  | Số metadata phiên được lưu tối đa cho mỗi agent.                                                        |
| `vscode-acp-chat.antigravity.enabled`                    | `true`                 | Hiển thị bundled Antigravity adapter thử nghiệm khi `agy` khả dụng.                                     |
| `vscode-acp-chat.swarmAgent.enabled`                     | `false`                | Hiển thị bundled Swarm orchestrator thử nghiệm.                                                         |
| `vscode-acp-chat.swarmAgent.configDirectory`             | `.vscode/acp-swarm`    | Thư mục cấu hình Swarm, có thể là đường dẫn tương đối với workspace hoặc đường dẫn tuyệt đối.           |
| `vscode-acp-chat.swarmAgent.defaultWorkflow`             | `default`              | Gợi ý phân xử định tuyến để tương thích ngược; không tự chạy workflow này khi định tuyến lỗi.           |
| `vscode-acp-chat.swarmAgent.maxWorkers`                  | `4`                    | Số Swarm worker session chạy đồng thời tối đa.                                                          |
| `vscode-acp-chat.swarmAgent.requireApprovalBeforeWrites` | `true`                 | Yêu cầu cấp quyền trước khi Swarm chuyển tiếp thao tác có khả năng ghi dữ liệu.                         |
| `vscode-acp-chat.swarmAgent.testLockPatterns`            | các lệnh test phổ biến | Các đoạn lệnh sẽ chiếm lock `test_runner` của Swarm.                                                    |
| `vscode-acp-chat.pi.historyLoadMode`                     | `full`                 | Chọn phát lại đầy đủ active path từ JSONL hoặc lịch sử Pi đã compact.                                   |
| `vscode-acp-chat.customAgents`                           | `[]`                   | Thêm hoặc ghi đè cấu hình khởi chạy ACP agent.                                                          |

Khi thay đổi `vscode-acp-chat.multiSession.enabled`, cần chạy **Developer: Reload Window** để chat controller, command và session-manager view sử dụng cùng một lifecycle nhất quán.

Khi chế độ low-resource mặc định đang bật, agent vẫn có thể ghi file nhưng trạng thái review diff/conflict theo từng multi-session sẽ không được lưu. Tắt `vscode-acp-chat.multiSession.lowResourceMode` nếu cần các thao tác review này.

## Chuyển tiếp MCP server

Khi `vscode-acp-chat.passMcpServers` được bật, extension đọc định nghĩa MCP từ:

- Workspace: `<workspace>/.vscode/mcp.json`
- Người dùng Linux: `~/.config/Code/User/mcp.json`
- Người dùng macOS: `~/Library/Application Support/Code/User/mcp.json`
- Người dùng Windows: `%APPDATA%/Code/User/mcp.json`

Hành vi:

- MCP server loại `stdio` được chuyển thành payload MCP của ACP.
- MCP server loại `http` và `sse` chỉ được chuyển tiếp khi agent công bố capability MCP tương ứng.
- Tên server được chuẩn hóa và đảm bảo không trùng trong mỗi request.
- Extension không thể hỏi người dùng giá trị `${input:id}`. Một biến môi trường chỉ chứa duy nhất tham chiếu `${input:id}` chưa được giải quyết sẽ bị bỏ qua; phép nội suy nằm trong chuỗi như `Bearer ${input:token}` không được xử lý.
- Khi tắt `vscode-acp-chat.passMcpServers`, extension không gửi định nghĩa MCP nào.
- Antigravity quản lý MCP thông qua `agy` và không dùng luồng chuyển tiếp này.

## Giới hạn phiên và capability

- Extension lưu metadata phiên và tùy chọn người dùng, không triển khai cơ sở dữ liệu transcript đầy đủ do extension tự quản lý.
- Việc phát lại toàn bộ lịch sử phụ thuộc vào hành vi `session/load` của agent. Bundled Pi adapter hỗ trợ thêm việc phát lại transcript đầy đủ từ JSONL để hiển thị.
- Khả năng liệt kê/tải/xóa lịch sử, mode, model, command, tùy chọn cấu hình chung, MCP transport, document sync và elicitation chỉ xuất hiện khi agent hỗ trợ.
- Document sync chỉ áp dụng cho tài liệu cục bộ có scheme `file:`; tài liệu virtual, untitled và các tài liệu không phải file bị loại trừ.
- Untrusted workspace được hỗ trợ có giới hạn; virtual workspace được hỗ trợ.

## Command

| Command                                        | Tác dụng                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| `ACP: Start Chat`                              | Focus chat view và kết nối.                          |
| `ACP: New Chat`                                | Tạo chat/session mới.                                |
| `ACP: Manage Chat Sessions`                    | Mở hoặc đóng trình quản lý ACP Sessions.             |
| `ACP: Switch Chat Session`                     | Chuyển active session qua Quick Pick.                |
| `ACP: Load History`                            | Tải một phiên trước đó.                              |
| `ACP: Delete History Session`                  | Xóa phiên trước đó khi agent hỗ trợ.                 |
| `ACP: Clear Chat`                              | Xóa nội dung chat/session hiện tại.                  |
| `ACP: Select Agent`                            | Chọn agent khả dụng và tạo một phiên mới.            |
| `ACP: Open ACP Settings`                       | Mở Settings đã lọc theo extension này.               |
| `ACP: Add Selection to Chat`                   | Thêm nội dung được chọn trong editor vào composer.   |
| `ACP: Add Terminal Selection to Chat`          | Thêm nội dung được chọn trong terminal vào composer. |
| `ACP: Add File to Chat` / `Add Folder to Chat` | Thêm tài nguyên từ Explorer/editor vào composer.     |

## Kiến trúc

Bản build production gồm các bundle runtime độc lập:

- `dist/extension.js` — entry point của VS Code Extension Host.
- `dist/webview.js` — webview chat chính.
- `dist/session-manager-webview.js` — webview quản lý ACP Sessions.
- Các ACP adapter Pi, Antigravity và Swarm được đóng gói sẵn.

Khi chạy, contribution của VS Code kích hoạt Extension Host; host khởi chạy và sở hữu các tiến trình ACP agent cục bộ; webview giao tiếp với host qua message có kiểu dữ liệu rõ ràng. Chức năng riêng của sản phẩm được đăng ký dưới `src/features/`, còn ACP client quản lý protocol, filesystem, terminal, quyền truy cập, phiên, MCP và document sync.

Xem [kiến trúc bố cục ACP Chat](docs/architecture/acp-chat-layout.md) để biết sơ đồ component UI/runtime hiện tại.

## Phát triển

Cài dependency bằng package manager được cố định trong repository:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Các workflow thường dùng:

```bash
# Kiểm tra kiểu dữ liệu của extension và bundled Antigravity adapter
pnpm run check-types

# Build phát triển
pnpm run compile

# Theo dõi TypeScript và esbuild
pnpm run watch

# Chạy test extension trong VS Code;
# pretest cũng build và kiểm tra Antigravity adapter
pnpm test

# Báo cáo coverage
pnpm run coverage

# Build production
pnpm run package

# Đóng gói VSIX; tắt npm dependency scan vì repository sử dụng pnpm
pnpm exec vsce package --no-dependencies --out vscode-acp-chat.vsix
```

Dùng launch configuration **Run Extension** của repository trong VS Code để khởi chạy Extension Development Host.

Các lệnh sau sẽ sửa file thay vì chỉ kiểm tra:

```bash
pnpm run lint
pnpm run format
```

## Tài liệu

- [Bản đồ tài liệu](docs/README.md)
- [Chỉ mục tài liệu tính năng](docs/features/README.md)
- [Bố cục ACP Chat và sơ đồ component](docs/architecture/acp-chat-layout.md)
- [Ví dụ cấu hình Swarm](examples/acp-swarm/README.md)
- [Lịch sử thay đổi](CHANGELOG.md)

## Ghi nhận

Dự án này là bản fork mở rộng từ [vscode-acp](https://github.com/omercnet/vscode-acp), bổ sung khả năng tương thích agent, bundled adapter, quản lý multi-session và các tính năng chat/workflow.

## Giấy phép

Giấy phép MIT. Xem [LICENSE](LICENSE).
