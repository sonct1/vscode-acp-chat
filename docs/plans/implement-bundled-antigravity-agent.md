# Kế hoạch triển khai: ACP agent Antigravity tích hợp sẵn

| Thuộc tính   | Giá trị                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trạng thái   | Đã triển khai phần root/product integration; publication fork từ xa và OAuth smoke thủ công còn chờ                                                                                                                                    |
| Chủ sở hữu   | TBD                                                                                                                                                |
| Phạm vi      | Fork `antigravity-acp` do dự án sở hữu, chuyển runtime sang Node, catalog agent tích hợp sẵn, đóng gói, cổng kiểm soát an toàn, kiểm thử, tài liệu |
| Mốc upstream | `joel-jcs/antigravity-acp` commit `cb8421fce4a9f1451ba990a3eac7f0672077da97`                                                                       |
| Tham chiếu   | `src/acp/agents.ts`, `src/acp/client.ts`, `src/features/pi-agent/`, `esbuild.js`, `package.json`, `.vscodeignore`                                  |

## Ghi chú triển khai hiện tại

- Root/product integration đã thêm helper host, catalog built-in opt-in, setting mặc định tắt, watcher refresh agent cache, build artifact `dist/antigravity-acp/index.mjs`, copy license, dependency Node 22/protobuf/SDK, scripts kiểm thử adapter, tests catalog/helper, và tài liệu người dùng.
- Vendor source hiện nằm tại `src/features/antigravity-agent/vendor/antigravity-acp/` và chạy bằng Node 22 thay vì Bun. Root publication fork URL vẫn pending vì phiên làm việc này không có GitHub auth để tạo/xác nhận repository project-owned từ xa.
- Kết quả xác minh tự động và đóng gói được ghi ở cuối tài liệu. OAuth/manual prompt smoke với tài khoản thật chưa thực hiện do rủi ro ToS/account đã nêu.

## Mục tiêu

Phát hành Google Antigravity dưới dạng một ACP agent tích hợp sẵn ở mức thử nghiệm, không yêu cầu người dùng cài adapter `agy-acp` riêng hoặc runtime Bun.

Luồng runtime người dùng kỳ vọng:

```text
VSCode ACP Chat
  -> bundled dist/antigravity-acp/index.mjs
  -> installed agy CLI
  -> agy's existing OAuth2/keyring session
  -> Antigravity service
```

Hành vi mục tiêu:

- Người dùng tự cài đặt và xác thực `agy` CLI chính thức riêng.
- Tiện ích đóng gói một fork ACP adapter đã được rà soát và ghim phiên bản.
- Adapter chạy dưới runtime Node của VS Code/Electron, không chạy bằng runtime Bun bên ngoài.
- Antigravity xuất hiện như một agent tích hợp sẵn thử nghiệm dạng người dùng chủ động bật khi có `agy`.
- `vscode-acp-chat.customAgents` hiện có vẫn có thể ghi đè agent tích hợp sẵn bằng `id: "antigravity"`.
- Chọn model, chế độ thực thi native, streaming, cập nhật tool có cấu trúc, liệt kê/tải lịch sử, hủy tác vụ và vận hành multi-session hoạt động thông qua các hợp đồng ACP chuẩn.
- Tiện ích không tải `agy`, không lưu OAuth credential và không chèn `--dangerously-skip-permissions`.

## Ranh giới sản phẩm và pháp lý

Điều khoản và FAQ hiện tại của Google Antigravity nêu rằng việc sử dụng phần mềm bên thứ ba với Antigravity OAuth là vi phạm Điều khoản Dịch vụ và có thể dẫn tới việc tài khoản bị đình chỉ hoặc chấm dứt.

Vì vậy tính năng này không được âm thầm bật mặc định.

Quyết định:

- Thêm `vscode-acp-chat.antigravity.enabled` với mặc định `false`.
- Mô tả của thiết lập phải nêu rõ rủi ro OAuth/ToS bên thứ ba và liên kết tới điều khoản chính thức hoặc FAQ trong tài liệu README.
- Chỉ thêm Antigravity agent tích hợp sẵn vào catalog runtime khi thiết lập được bật.
- Không tuyên bố tiện ích hoặc adapter được Google hỗ trợ.
- Không thêm tuyên bố API key. Hỗ trợ API key hiện tại của `agy` chưa đủ tin cậy để trở thành một phần của hợp đồng.

Cổng kiểm soát này là kiểm soát an toàn sản phẩm, không phải ranh giới bảo mật kỹ thuật.

## Phân tích trạng thái hiện tại

### Mẫu agent tích hợp sẵn hiện có

Tính năng Pi tích hợp sẵn thiết lập mẫu trong repository:

```text
src/features/pi-agent/vendor/pi-acp/src/index.ts
  -> esbuild
  -> dist/pi-acp/index.mjs
  -> process.execPath + ELECTRON_RUN_AS_NODE=1
```

Hành vi liên quan:

- Mã nguồn đặc thù sản phẩm nằm dưới `src/features/<feature-name>/`.
- `src/acp/agents.ts` chỉ chứa một điểm tích hợp nhỏ cho catalog.
- `availabilityCommand` kiểm tra CLI bên ngoài cần thiết thay vì artifact adapter đã đóng gói.
- `.vscodeignore` loại trừ mã nguồn nhưng giữ lại `dist/**`.
- Quy trình đóng gói VSIX xác minh artifact adapter đã tạo tồn tại.

Antigravity nên theo cùng kiến trúc đó, kèm gia cố runtime bổ sung vì upstream adapter được chọn hiện đang giả định Bun và một tiến trình ACP server duy nhất.

### Upstream adapter được chọn

Mốc nền:

```text
Repository: https://github.com/joel-jcs/antigravity-acp
Commit: cb8421fce4a9f1451ba990a3eac7f0672077da97
License: MIT
```

Lý do chọn mã nguồn này:

- Sử dụng ACP SDK chuẩn.
- Bao phủ `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/delete`, `session/close`, `session/prompt`, `session/cancel` và `session/set_config_option`.
- Hỗ trợ `cwd` và `additionalDirectories` theo từng session.
- Tùy chọn config model và mode.
- Văn bản assistant trực tiếp từ stdout của `agy`.
- Cập nhật thought/tool/history có cấu trúc được tái dựng từ Antigravity SQLite conversation data.
- Phát hiện session native và replay lịch sử.
- Độ bao phủ kiểm thử mạnh hơn các adapter khác đã rà soát.

### Các khoảng trống upstream đã xác minh

| Khu vực                    | Hành vi upstream hiện tại                                                   | Xử lý bắt buộc cho sản phẩm                                                             |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Runtime                    | Yêu cầu API Bun và `bun:sqlite`                                             | Chuyển runtime production sang API Node 22                                              |
| Phân phối                  | binary standalone của Bun khoảng 64-99 MB mỗi platform                      | Không đóng gói binary Bun SEA; xuất một JS bundle nhỏ                                   |
| Cài đặt `agy`              | Có thể tự tải một phiên bản `agy` đã pin                                    | Loại bỏ toàn bộ hành vi tải xuống runtime/postinstall                                   |
| Xác thực                   | Tái sử dụng `agy` OAuth; ACP `authenticate` gần như no-op                   | Ghi tài liệu bước xác thực trước bằng `agy`; hiển thị lỗi xác thực rõ ràng              |
| Mode plan                  | Inject một chỉ dẫn lập kế hoạch ở mức prompt                                | Thay bằng `agy --mode plan` native                                                      |
| Bỏ qua quyền               | Để lộ một mode bổ sung `--dangerously-skip-permissions`                     | Loại bỏ hoàn toàn mode và flag này                                                      |
| Quyền chuẩn                | Không thể chuyển tiếp prompt phê duyệt trực tiếp của `agy` qua ACP          | Không quảng bá hỗ trợ vòng phê duyệt hai chiều; ghi tài liệu giới hạn                   |
| Chuyển tiếp MCP            | Bỏ qua ACP `mcpServers`; `agy` không có per-invocation MCP override tin cậy | Dùng cấu hình MCP riêng của Antigravity; ghi tài liệu rằng không hỗ trợ chuyển tiếp ACP |
| Trạng thái session         | File JSON nguyên khối chỉ có tuần tự hóa ghi trong cùng tiến trình          | Làm persistence an toàn giữa các tiến trình cho chế độ multi-session của tiện ích       |
| Ràng buộc conversation mới | Chủ yếu đối chiếu snapshot các file DB conversation                         | Thêm phát hiện theo tiến trình và tuần tự hóa lượt đầu giữa các tiến trình              |
| SQLite/protobuf            | Đọc schema Antigravity local chưa được ghi tài liệu                         | Thêm các chốt tương thích, lỗi schema có hướng xử lý và kiểm thử theo phiên bản         |
| Xử lý lỗi                  | Chủ yếu dựa vào exit code/stderr                                            | Phân loại auth, quota, timeout, schema và lỗi session mơ hồ                             |
| Phiên bản `agy`            | Không áp dụng phiên bản tối thiểu                                           | Yêu cầu và validate `agy >= 1.1.0`; test với phiên bản hiện tại `1.1.2`                 |

## Quyết định kiến trúc

### 1. Tạo fork do dự án sở hữu và vendor mã nguồn của fork

Tạo hoặc sử dụng một fork của `joel-jcs/antigravity-acp` do dự án kiểm soát. Fork từ xa cung cấp lịch sử rà soát và đồng bộ upstream; repository của tiện ích vendor đúng mã nguồn production được dùng cho mỗi phát hành.

Vị trí đề xuất:

```text
src/features/antigravity-agent/
├── host.ts
├── index.ts
└── vendor/
    └── antigravity-acp/
        ├── src/
        ├── test/
        ├── LICENSE
        ├── README.md
        ├── UPSTREAM.md
        ├── package.json
        └── tsconfig.json
```

`UPSTREAM.md` phải ghi lại:

- Repository upstream gốc.
- Repository fork của dự án.
- Commit nhập chính xác.
- Ngày nhập.
- Nguồn gốc giấy phép MIT.
- Danh sách patch cục bộ.
- Quy trình đồng bộ upstream.
- Các phiên bản `agy` được hỗ trợ.
- Các giới hạn ACP và ToS đã biết.

Không commit vendor `node_modules`, `dist/` build bằng Bun, binary `agy` đã tải xuống hoặc file VSIX đã tạo.

### 2. Chuyển runtime production từ Bun sang Node 22

Tiện ích không được yêu cầu người dùng cài Bun.

Thay thế các API production đặc thù Bun:

| Bun API                | Thay thế bằng Node                                                       |
| ---------------------- | ------------------------------------------------------------------------ |
| `Bun.spawn`            | `node:child_process.spawn`                                               |
| `Bun.stdin.stream()`   | `Readable.toWeb(process.stdin)`                                          |
| `Bun.stdout.writer()`  | `Writable.toWeb(process.stdout)`                                         |
| `Bun.file(...).text()` | `node:fs/promises.readFile`                                              |
| `Bun.write(...)`       | `node:fs/promises.writeFile` kèm đổi tên nguyên tử                       |
| `bun:sqlite`           | `node:sqlite` `DatabaseSync`                                             |
| `Bun.Subprocess`       | typed `ChildProcessWithoutNullStreams` hoặc một interface tiến trình hẹp |

`node:sqlite` được thêm trong Node 22 và không còn yêu cầu flag experimental từ Node 22.13, mặc dù vẫn là API đang phát triển tích cực. Electron 35.0.2 bao gồm Node 22.14 với `node:sqlite` được bật.

Quyết định runtime:

- Nâng `engines.vscode` từ `^1.74.0` lên ít nhất `^1.101.0`, có extension host dùng Node 22/Electron 35.
- Nâng `@types/node` lên phiên bản tương thích Node 22.
- Khởi chạy adapter tích hợp sẵn bằng `process.execPath`, `ELECTRON_RUN_AS_NODE=1` và `--no-warnings` để tránh phát cảnh báo SQLite experimental của Node vào luồng stderr ACP.
- Thêm kiểm tra khởi động adapter cho `node:sqlite`; trả về lỗi nghiêm trọng rõ ràng nếu host runtime hiện tại không cung cấp nó.

Thay đổi mức tương thích tối thiểu này là có chủ đích và phải được nêu bật trong ghi chú phát hành.

### 3. Đóng gói một artifact adapter riêng

Mục tiêu build:

```text
src/features/antigravity-agent/vendor/antigravity-acp/index.ts
  -> dist/antigravity-acp/index.mjs
```

Thuộc tính build:

- `platform: "node"`
- `format: "esm"`
- Node 22 target
- thu nhỏ production nhất quán với adapter build hiện có
- source map chỉ trong bản build không phải production
- `node:*` built-in được externalize tự nhiên
- root `@agentclientprotocol/sdk` và `@bufbuild/protobuf` được đóng gói vào artifact

Artifact không được tải file mã nguồn vendor khi chạy.

Copy license upstream vào:

```text
dist/antigravity-acp/LICENSE
```

để VSIX cuối cùng chứa thông báo bên thứ ba dù `src/**` và Markdown files bị loại trừ.

### 4. Yêu cầu `agy` CLI chính thức; không bao giờ auto-install nó

Cấu hình tích hợp sẵn:

```ts
{
  id: "antigravity",
  name: "Antigravity (Experimental)",
  command: process.execPath,
  args: ["--no-warnings", bundledEntrypoint],
  env: {
    ELECTRON_RUN_AS_NODE: "1"
  },
  availabilityCommand: "agy"
}
```

Quy tắc:

- Loại bỏ upstream `scripts/postinstall.ts` và lời gọi runtime `ensureAgy()` khỏi production fork.
- Resolve `agy` từ `AGY_BIN` khi được cung cấp rõ ràng, nếu không thì từ PATH được kế thừa.
- Dựa vào bổ sung PATH hiện có của ACP client để `~/.local/bin/agy` và các vị trí global-bin đã biết khác vẫn có thể phát hiện.
- Không ship binary `agy` bên trong VSIX.
- Không pin hoặc downgrade `agy` người dùng đã cài.

### 5. Dùng trạng thái OAuth2/keyring của `agy`

Hợp đồng xác thực:

1. Người dùng chạy `agy` tương tác bên ngoài extension.
2. `agy` chính thức lưu OAuth credential trong OS keyring/profile.
3. Adapter tích hợp sẵn spawn `agy` chính thức.
4. `agy` tự đọc credential của nó.

Adapter không được:

- đọc hoặc copy OAuth token;
- lưu lâu dài credential;
- yêu cầu `GEMINI_API_KEY`;
- proxy xác thực tới endpoint khác;
- triển khai OAuth client tùy chỉnh.

Nếu `agy models` hoặc prompt thất bại vì thiếu authentication, trả về thông điệp có hướng xử lý:

```text
Antigravity authentication is unavailable. Run `agy` in an interactive terminal, complete sign-in, then retry.
```

### 6. Dùng chế độ thực thi native và loại bỏ mode không an toàn

Chỉ để lộ các mode được hỗ trợ bởi flag hiện tại của `agy` CLI:

| ACP mode       | `agy` invocation      | Ghi chú                                                              |
| -------------- | --------------------- | -------------------------------------------------------------------- |
| `default`      | `--mode default`      | Dùng hành vi standard/request-review của Antigravity                 |
| `accept-edits` | `--mode accept-edits` | Cho phép workflow thiên về chỉnh sửa mà không bỏ qua quyền diện rộng |
| `plan`         | `--mode plan`         | Mode lập kế hoạch native; không có tuyên bố an toàn chỉ ở mức prompt |

Không để lộ:

- `bypassPermissions`
- `dontAsk`
- `--dangerously-skip-permissions`

Không mô tả UI quyền ACP hiện có của tiện ích như một lớp bảo vệ các lượt Antigravity. Adapter không thể tạm dừng một tiến trình `agy -p` headless và chuyển tiếp yêu cầu phê duyệt trực tiếp qua ACP.

### 7. Làm persistence của adapter an toàn trên nhiều tiến trình

Kiến trúc multi-session mặc định của tiện ích tạo một ACP tiến trình adapter cho mỗi session cục bộ. Upstream giả định một tiến trình adapter sở hữu các file trạng thái JSON, nên chuỗi promise trong tiến trình của nó là không đủ.

Thay trạng thái nguyên khối dùng chung khi khả thi:

```text
~/.vscode-acp-chat/antigravity-acp/
├── sessions/
│   └── <session-id>.json
├── tombstones/
│   └── <conversation-id>
├── locks/
└── models.json
```

Yêu cầu:

- Một file mỗi session tránh xung đột ghi giữa các session không liên quan.
- Tombstone dùng file marker thay vì một mảng dùng chung.
- Các lần ghi dùng tên tạm duy nhất chứa PID/hậu tố ngẫu nhiên trước đổi tên nguyên tử.
- Migration đọc định dạng cũ `~/.agy-acp/sessions.json` format khi có nhưng chỉ ghi định dạng mới có namespace.
- Session IDs và ID conversation phải được validate trước khi trở thành đường dẫn file.
- Các tiến trình adapter chạy đồng thời không được ghi đè trạng thái của nhau.

Cho phép `AGY_ACP_STATE_DIR` như ghi đè nâng cao, nhưng mặc định là thư mục có namespace của sản phẩm.

### 8. Làm ràng buộc conversation lượt đầu an toàn đồng thời

Một ACP session mới chưa có Antigravity ID conversation cho đến khi lần gọi `agy -p` đầu tiên tạo DB. Phát hiện chỉ dựa trên snapshot có thể ràng buộc nhầm DB khi hai session bắt đầu đồng thời.

Triển khai:

1. Khóa giữa các tiến trình cho lượt đầu trong thư mục trạng thái adapter.
2. Chụp snapshot các DB conversation hiện có sau khi lấy khóa.
3. Spawn `agy` và thử phát hiện DB dựa trên PID:
   - Linux: kiểm tra `/proc/<pid>/fd`.
   - macOS: kiểm tra `lsof -p <pid>`.
4. Fallback sang khác biệt snapshot nghiêm ngặt trong khi vẫn giữ khóa lượt đầu.
5. Từ chối ràng buộc mơ hồ thay vì chọn một DB tùy ý.
6. Lưu ràng buộc conversation trước khi nhả khóa.
7. Nhả khóa cũ bằng validate PID/timestamp và timeout có giới hạn.

Chỉ lượt đầu cần tuần tự hóa toàn cục. Prompt cho các conversation đã ràng buộc vẫn chạy đồng thời.

### 9. Giữ tích hợp dựa trên giao thức

Không thêm các nhánh `agent.id === "antigravity"` vào render chat, toolbar session, pipeline output, quyền hoặc multi-session code.

Antigravity phải tích hợp thông qua:

- cập nhật session ACP chuẩn;
- `configOptions` chuẩn cho model/selector mode;
- nội dung structured diff chuẩn;
- các method `session/list` chuẩn, `session/load`, `session/delete` và method `session/cancel`;
- metadata hiện có session cục bộ theo agent.

Các điểm tích hợp lõi duy nhất nên là:

- đăng ký catalog tích hợp sẵn;
- refresh cache cấu hình khi thiết lập người dùng chủ động bật thay đổi;
- mục tiêu build/package;
- mức tương thích tối thiểu.

## Phạm vi

### Trong phạm vi

- Tạo và ghi tài liệu một fork do dự án sở hữu.
- Vendor mã nguồn fork đã ghim.
- Chuyển runtime production từ Bun sang Node 22.
- Đóng gói một artifact adapter JS riêng.
- Thêm đăng ký Antigravity agent tích hợp sẵn ở mức thử nghiệm.
- Thêm thiết lập người dùng chủ động bật với cảnh báo ToS rõ ràng.
- Dùng `agy` đã cài và đăng nhập OAuth2/keyring hiện có của nó.
- Loại bỏ tải xuống runtime và bỏ qua quyền nguy hiểm.
- Dùng native `agy` modes.
- Gia cố trạng thái và ràng buộc conversation cho cách dùng multi-session nhiều tiến trình.
- Giữ chọn model, lịch sử, streaming, khối tool, structured diff và hủy.
- Thêm kiểm thử adapter, hợp đồng host, nội dung gói và kiểm tra smoke thủ công.
- Cập nhật README, catalog tính năng, changelog và ghi chú hoàn tất của plan này sau triển khai.

### Ngoài phạm vi

- Đóng gói executable `agy` chính thức.
- Triển khai hoặc lưu Google OAuth credential.
- Tuyên bố được Google hỗ trợ hoặc tuân thủ ToS.
- Dùng Antigravity OAuth mà không có người dùng chủ động bật rõ ràng.
- Hỗ trợ `GEMINI_API_KEY` như một Antigravity hợp đồng xác thực.
- Triển khai ACP native bên trong `agy`.
- Chuyển tiếp phê duyệt đúng nghĩa giữa turn từ `agy` tới VS Code.
- Truyền VS Code ACP `mcpServers` vào `agy`; người dùng phải cấu hình MCP trong chính Antigravity.
- Persistence transcript đầy đủ do tiện ích sở hữu.
- Xóa conversation native DB nền tảng của Antigravity khi người dùng xóa một mục lịch sử ACP.
- Luồng xử lý `additionalDirectories` multi-root trong bản phát hành đầu tiên; giữ hành vi `cwd` là root workspace đầu tiên hiện tại và theo dõi hỗ trợ multi-root tổng quát riêng.

## Các thay đổi file đề xuất

```text
src/features/antigravity-agent/
├── host.ts
├── index.ts
└── vendor/antigravity-acp/
    ├── index.ts
    ├── src/
    ├── test/
    ├── LICENSE
    ├── README.md
    ├── UPSTREAM.md
    ├── package.json
    └── tsconfig.json

src/acp/agents.ts
  # đăng ký tích hợp sẵn có điều kiện tối thiểu

src/extension.ts
  # refresh cache agent khi antigravity.enabled thay đổi

src/test/agents.test.ts
src/test/features/antigravity-agent.test.ts

esbuild.js
  # build adapter Node ESM + copy license

package.json
package-lock.json
  # thiết lập, VS Code mức engine tối thiểu, type Node 22, protobuf/runtime dependency kiểm thử

tsconfig.json
  # cô lập mã nguồn/kiểm thử vendor

.vscodeignore
  # giữ artifact/license trong dist; !dist/** hiện có là đủ

README.md
docs/features/feature-catalog.md
CHANGELOG.md
```

Không cần đăng ký qua `src/features/register-host.ts` trừ khi triển khai thêm một command riêng. Giống Pi, tính năng này được đăng ký qua catalog agent tích hợp sẵn.

## Các giai đoạn triển khai

### Giai đoạn 1: Thiết lập nguồn gốc fork

#### Tác vụ 1.1: Tạo fork do dự án sở hữu

- Fork `joel-jcs/antigravity-acp` vào một repository do organization của dự án kiểm soát.
- Tạo tag mốc nền hoặc branch tại commit `cb8421fce4a9f1451ba990a3eac7f0672077da97`.
- Áp dụng patch sản phẩm trong các commit có thể rà soát được nhóm theo chuyển runtime, an toàn, xử lý đồng thời và đóng gói.

Tiêu chí chấp nhận:

- URL fork ổn định và maintainer có thể truy cập.
- Commit mốc nền và chuỗi patch cục bộ có thể tái tạo.
- Không có dependency vào upstream `main` chưa được rà soát.

#### Tác vụ 1.2: Vendor mã nguồn đã ghim

- Chỉ import mã nguồn, kiểm thử, metadata package, README và LICENSE.
- Thêm `UPSTREAM.md` trước khi thay đổi hành vi.
- Loại bỏ binary đã tạo, `dist/`, `agy` đã tải xuống và `node_modules`.

Tiêu chí chấp nhận:

- `git ls-files` cho thấy nguồn gốc mã nguồn/giấy phép đầy đủ.
- Cây vendor có thể được cập nhật từ fork bằng các command đã ghi tài liệu.

### Giai đoạn 2: Chuyển API production từ Bun sang Node

#### Tác vụ 2.1: Chuyển stdio và thực thi tiến trình

- Thay Bun ACP đấu nối stdio bằng adapter Web stream của Node.
- Thay `Bun.spawn` bằng helper chạy tiến trình Node được inject.
- Giữ quyền sở hữu stdout nghiêm ngặt: chỉ JSON-RPC trên stdout, chẩn đoán chỉ trên stderr.
- Thêm hủy theo cây tiến trình:
  - kết thúc process group Unix khi được hỗ trợ.
  - Windows `taskkill /t /f` fallback.
- Thêm timeout có giới hạn cho `agy --version`, `agy models`, thực thi prompt và tắt.

Tiêu chí chấp nhận:

- bắt tay `initialize` hoạt động dưới `node` khi không cài Bun.
- Hủy dừng `agy` và cây tiến trình con của nó.
- Không có log làm nhiễm stdout ACP.

#### Tác vụ 2.2: Chuyển truy cập SQLite

- Thay `bun:sqlite` bằng `node:sqlite` `DatabaseSync`.
- Mở DB conversation chỉ đọc.
- Tái sử dụng statement đã chuẩn bị trong streaming.
- Xử lý ghi đồng thời qua WAL và lỗi `SQLITE_BUSY` tạm thời bằng retry/backoff có giới hạn.
- Validate bảng `steps` và cột bắt buộc trước khi query.
- Close toàn bộ handle DB một cách tất định.

Tiêu chí chấp nhận:

- `agy 1.1.2` hiện tại schema DB có thể stream và replay.
- Schema thiếu/thay đổi tạo lỗi adapter có hướng xử lý thay vì phản hồi rỗng.
- Không yêu cầu addon native hoặc binary SQLite theo nền tảng.

#### Tác vụ 2.3: Chuyển persistence file

- Thay `Bun.file` và `Bun.write` bằng `fs/promises`.
- Triển khai theo từng session và bố cục trạng thái dạng file marker.
- Thêm migration từ trạng thái upstream cũ.

Tiêu chí chấp nhận:

- Trạng thái tồn tại qua adapter restart.
- Ghi song song bởi các tiến trình adapter riêng biệt không làm mất session không liên quan.

#### Tác vụ 2.4: Căn chỉnh SDK và build TypeScript

- Dùng phiên bản `@agentclientprotocol/sdk` đã pin của tiện ích.
- Thêm `@bufbuild/protobuf` làm dependency production ở root nếu bundle vẫn cần.
- Update `@types/node` lên Node 22.
- Giữ typecheck TypeScript của vendor tách khỏi tsconfig root của tiện ích khi cần.
- Chuyển kiểm thử Bun sang `node:test` hoặc runner nhẹ khác tương thích Node; không giữ Bun làm dependency kiểm thử/runtime.

Tiêu chí chấp nhận:

- Typecheck root và vendor pass với một đồ thị dependency.
- Kiểm thử adapter chạy không cần Bun.

### Giai đoạn 3: Áp dụng patch an toàn sản phẩm và tương thích

#### Tác vụ 3.1: Loại bỏ hành vi tự cài đặt

- Xóa/tắt postinstall và đường dẫn downloader runtime.
- Chỉ resolve binary `agy` đã cài.
- Validate `agy --version` khi startup hoặc lần sử dụng đầu.

Tiêu chí chấp nhận:

- Khởi động adapter không bao giờ thực hiện tải xuống qua mạng.
- Thiếu `agy` hoặc `agy` quá cũ trả về thông điệp cài đặt/cập nhật rõ ràng.

#### Tác vụ 3.2: Triển khai mode native an toàn

- Thay mode plan được chèn qua prompt bằng `--mode plan`.
- Thêm ánh xạ `--mode default` và `--mode accept-edits`.
- Loại bỏ tất cả mode bypass và flag nguy hiểm khỏi tùy chọn cấu hình, tests và docs.
- Validate giá trị mode trước khi tạo đối số CLI.

Tiêu chí chấp nhận:

- Selector mode chỉ hiển thị ba giá trị đã được phê duyệt.
- Đối số đã tạo không bao giờ chứa `--dangerously-skip-permissions`.
- Mode plan được áp dụng bởi `agy`, không chỉ bằng cách diễn đạt prompt.

#### Tác vụ 3.3: Gia cố báo lỗi

Phân loại ít nhất:

- thiếu `agy`;
- không hỗ trợ `agy` version;
- thiếu/xác thực OAuth hết hạn;
- lỗi quota/rate-limit;
- timeout prompt;
- tiến trình crash/exit khác 0;
- không tạo DB conversation;
- ràng buộc conversation mơ hồ;
- schema SQLite không tương thích;
- session đã tombstone/không tìm thấy.

Tiêu chí chấp nhận:

- Lỗi đi tới bề mặt lỗi/system-message ACP hiện có với hướng khắc phục hữu ích.
- Lỗi backend không xuất hiện như turn rỗng thành công.

#### Tác vụ 3.4: Gia cố ràng buộc session đồng thời

- Triển khai khóa lượt đầu và phát hiện dựa trên PID.
- Thêm kiểm thử với hai session mới đồng thời.
- Xác minh session đã ràng buộc vẫn chạy đồng thời.

Tiêu chí chấp nhận:

- Hai prompt lượt đầu đồng thời không thể ràng buộc vào conversation DB của nhau.
- Khôi phục khóa có hành vi giới hạn sau tiến trình crash.

### Giai đoạn 4: Đóng gói và đăng ký tính năng

#### Tác vụ 4.1: Thêm tích hợp host cục bộ của tính năng

Tạo `src/features/antigravity-agent/host.ts` với:

- `getBundledAntigravityAcpEntrypoint()`;
- `isAntigravityAgentEnabled()`;
- `createAntigravityAgentConfig()`.

Helper sở hữu toàn bộ chính sách khởi chạy đặc thù sản phẩm.

Tiêu chí chấp nhận:

- Catalog lõi nhận một `AgentConfig` bình thường.
- Không nhúng Antigravity đường dẫn khởi chạy trong `src/acp/client.ts` hoặc `src/views/chat.ts`.

#### Tác vụ 4.2: Thêm thiết lập người dùng chủ động bật

Thêm:

```json
"vscode-acp-chat.antigravity.enabled": {
  "type": "boolean",
  "default": false,
  "description": "Bật adapter Antigravity ACP tích hợp sẵn ở mức thử nghiệm. Google nêu rằng truy cập bên thứ ba bằng Antigravity OAuth có thể vi phạm Điều khoản Dịch vụ và có thể dẫn tới việc tài khoản bị đình chỉ."
}
```

Cập nhật watcher cấu hình để refresh cache agent khi giá trị này thay đổi.

Tiêu chí chấp nhận:

- Antigravity không xuất hiện khỏi selector theo mặc định.
- Bật thiết lập và có `agy` đã cài khiến nó khả dụng mà không cần reload khi khả thi.
- Tắt thiết lập ngăn tạo session Antigravity mới; session đang chạy hiện có không bị buộc kill bởi thay đổi thiết lập.

#### Tác vụ 4.3: Thêm đăng ký catalog

- Import factory của tính năng trong `src/acp/agents.ts`.
- Thêm Antigravity gần Pi để thứ tự agent mặc định không đổi.
- Giữ khả năng ghi đè custom-agent bằng `id: "antigravity"`.

Tiêu chí chấp nhận:

- Hành vi default-agent hiện có giữ nguyên.
- Agent tùy chỉnh có cùng ID thay thế cấu hình tích hợp sẵn.
- Kiểm tra khả dụng `agy`, không phải `node`, Bun hoặc adapter bên ngoài.

#### Tác vụ 4.4: Thêm target esbuild và copy license

- Thêm ngữ cảnh build adapter vào production và mảng watch.
- Xuất `dist/antigravity-acp/index.mjs`.
- Copy MIT license vào cùng thư mục dist sau build thành công.

Tiêu chí chấp nhận:

- `npm run package` tạo cả artifact và license.
- Không cần file mã nguồn/vendor runtime trong VSIX.

### Giai đoạn 5: Xác thực hành vi ACP bên trong tiện ích

#### Tác vụ 5.1: Vòng đời session

Xác minh trong cả chế độ legacy và multi-session:

```text
spawn
-> initialize
-> newSession
-> set model/mode
-> prompt
-> cancel
-> prompt again
-> list history
-> load history
-> close/delete local history entry
```

Tiêu chí chấp nhận:

- Code ACP client chuẩn xử lý toàn bộ luồng mà không có nhánh đặc thù Antigravity.
- Metadata session và cập nhật tiêu đề chính xác.
- Replay lịch sử phát user, assistant, thought và cập nhật tool theo thứ tự.

#### Tác vụ 5.2: Toolbar model và mode

- Truy vấn model bằng `agy models` với timeout và cache.
- Emit `configOptions` chuẩn.
- Giữ giá trị đã chọn trong trạng thái session của adapter.
- Refresh tùy chọn cấu hình khi model phát hiện hoàn tất sau tạo session.

Tiêu chí chấp nhận:

- Toolbar session hiện có hiển thị model và selector mode.
- Đặt một giá trị ảnh hưởng tới lần gọi `agy` tiếp theo.
- Không xuất hiện selector trùng lặp hoặc không hỗ trợ selector.

#### Tác vụ 5.3: Render tool và diff

- Xác minh cập nhật read/search/execute/edit/subagent/task/error.
- Xác minh cập nhật edit phát ACP nội dung `diff` tương thích với `StructuredDiffRecorder`.
- Xác nhận diff đã áp dụng chỉ điền vào tổng hợp diff chung khi nội dung trên disk khớp.

Tiêu chí chấp nhận:

- Khối tool vẫn dẫn dắt bởi giao thức.
- Thay đổi có cấu trúc an toàn tham gia hành vi review/rollback hiện có.

#### Tác vụ 5.4: Ranh giới năng lực đã biết

- Không quảng bá MCP năng lực mà adapter không thể tôn trọng.
- Bỏ qua hoặc từ chối đầu vào `mcpServers` rõ ràng thay vì ngụ ý chúng đã được áp dụng.
- Không phát yêu cầu quyền ACP không thể điều khiển tiến trình `agy` đang chạy.
- Ghi tài liệu rằng MCP native và thiết lập quyền của Antigravity vẫn là nguồn quyết định.

Tiêu chí chấp nhận:

- UI không hứa sai về MCP được chuyển tiếp hoặc hỗ trợ phê duyệt tương tác.

### Giai đoạn 6: Kiểm thử

#### Tác vụ 6.1: Kiểm thử unit adapter vendor

Chuyển và giữ độ bao phủ cho:

- ACP initialize và đăng ký method;
- tuần tự hóa block prompt;
- model/mode sinh tùy chọn;
- streaming stdout UTF-8 và đối soát DB;
- giải mã protobuf và định tuyến tool;
- SQLite replay và polling tăng dần;
- phát hiện/nhận session catalog;
- persistence trạng thái theo session và migration;
- tombstones;
- hủy và phân loại lỗi;
- PID/snapshot ràng buộc conversation;
- giữa các tiến trình khóa lượt đầu;
- giá trị mode nguy hiểm bị từ chối.

Tiêu chí chấp nhận:

- Kiểm thử chạy trong Node không cần Bun.
- Không yêu cầu OAuth thật hoặc truy cập mạng.

#### Tác vụ 6.2: Kiểm thử catalog tiện ích

Thêm assertion cho cấu hình bật:

- ID ổn định và tên hiển thị;
- `command === process.execPath`;
- `ELECTRON_RUN_AS_NODE === "1"`;
- `availabilityCommand === "agy"`;
- đối số kết thúc bằng `antigravity-acp/index.mjs`;
- không có Bun command;
- không có flag nguy hiểm;
- thiết lập tắt loại agent;
- ghi đè tùy chỉnh vẫn thắng.

#### Tác vụ 6.3: Kiểm tra smoke tiến trình adapter

Khởi chạy artifact đã build với process runner giả tất định hoặc fixture `agy` giả và xác minh:

- bắt tay ACP;
- `session/new`;
- model/mode config;
- output prompt được stream;
- cập nhật tool có cấu trúc;
- cancel;
- history replay.

Fixture giả không được phụ thuộc vào cú pháp shell theo nền tảng. Ưu tiên dependency injection hoặc một tiến trình fixture Node.

#### Tác vụ 6.4: Kiểm thử đồng thời multi-session

Tạo ít nhất hai tiến trình adapter dùng chung một thư mục trạng thái và xác minh:

- file session độc lập vẫn tồn tại;
- prompt lượt đầu đồng thời ràng buộc chính xác;
- một hủy không ảnh hưởng session còn lại;
- liệt kê lịch sử loại trùng alias native và adapter.

### Giai đoạn 7: Tài liệu và phát hành

Cập nhật `README.md`:

- Thêm Antigravity vào agent được hỗ trợ dưới dạng thử nghiệm/chỉ bật khi người dùng chủ động chọn.
- Ghi tài liệu cách cài đặt `agy` chính thức.
- Ghi tài liệu thiết lập OAuth tương tác:

```bash
agy
agy models
```

- Nêu rằng không cần API key cho đường dẫn adapter.
- Bao gồm cảnh báo ToS của Google về OAuth bên thứ ba và các liên kết.
- Giải thích hành vi mode native và giới hạn quyền.
- Giải thích MCP phải được cấu hình trong Antigravity.
- Giải thích việc xóa mục custom-agent cũ nếu người dùng muốn adapter tích hợp sẵn.

Cập nhật `docs/features/feature-catalog.md` sau triển khai:

- Thêm `antigravity` vào ID tích hợp sẵn.
- Ghi nhận người dùng chủ động bật hành vi, điều kiện tiên quyết OAuth, hỗ trợ lịch sử và giới hạn.

Cập nhật `CHANGELOG.md`:

- Thêm adapter Antigravity tích hợp sẵn ở mức thử nghiệm.
- Nâng phiên bản VS Code tối thiểu để hỗ trợ Node 22/`node:sqlite`.
- Nêu rõ cảnh báo ToS và mặc định chỉ bật khi người dùng chủ động chọn.

Cập nhật plan này:

- Đổi trạng thái thành `Đã triển khai`.
- Ghi lại URL fork, commit đã import, tóm tắt patch cục bộ, kiểm thử, kích thước artifact package và kết quả smoke thủ công.

## Chuỗi xác minh

Cổng chất lượng bắt buộc:

```bash
npm run check-types
npm run lint
npm test
npm run package
```

Kiểm tra riêng cho adapter:

```bash
npm run test:antigravity-adapter
node --test <compiled-adapter-tests>
```

Script chính xác có thể được hợp nhất trong quá trình triển khai, nhưng `npm test` phải bao gồm hoặc phụ thuộc vào bộ kiểm thử adapter trước hoàn tất.

Đóng gói và cài đặt:

```bash
npx vsce package --out /tmp/vscode-acp-chat-antigravity.vsix
unzip -l /tmp/vscode-acp-chat-antigravity.vsix \
  | grep -E 'dist/antigravity-acp/(index\.mjs|LICENSE)'
code --install-extension /tmp/vscode-acp-chat-antigravity.vsix --force
rm /tmp/vscode-acp-chat-antigravity.vsix
```

Kiểm tra smoke thủ công:

1. Xác nhận runtime VS Code hiện tại đáp ứng phiên bản tối thiểu mới.
2. Xác nhận `agy --version` được hỗ trợ.
3. Chạy `agy` và hoàn tất đăng nhập OAuth.
4. Xác nhận `agy models` thành công.
5. Xác nhận Antigravity bị ẩn khi `vscode-acp-chat.antigravity.enabled` là false.
6. Bật thiết lập và xác nhận `Antigravity (Experimental)` xuất hiện.
7. Bắt đầu session Plan và xác minh native `--mode plan` hành vi.
8. Bắt đầu một session `accept-edits` trong repository dùng một lần và xác minh structured diff.
9. Bắt đầu hai session Antigravity đồng thời và xác minh output/lịch sử độc lập.
10. Hủy một session đang chạy và xác minh session còn lại vẫn hoạt động.
11. Tải một conversation Antigravity native và xác minh replay.
12. Tạm thời loại `agy` khỏi PATH và xác minh agent chuyển sang không khả dụng với thông điệp cài đặt có hướng xử lý.
13. Chạy `Developer: Reload Window` sau khi cài VSIX.

Không thực hiện OAuth thật smoke bằng tài khoản chính nhạy cảm. Người dùng phải chấp nhận rõ ràng rủi ro truy cập bên thứ ba đã ghi tài liệu.

## Rủi ro và giảm thiểu

| Rủi ro                                                                         | Tác động     | Giảm thiểu                                                                                                |
| ------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------- |
| Google có thể đình chỉ tài khoản dùng công cụ bên thứ ba với Antigravity OAuth | Nghiêm trọng | Mặc định tắt, chỉ bật khi người dùng chủ động chọn, tài liệu rõ ràng, không tuyên bố được hỗ trợ/tuân thủ |
| `agy` vẫn thiếu native ACP và chuyển tiếp phê duyệt                            | Cao          | Ghi tài liệu giới hạn rõ ràng; dùng mode native; loại bỏ bỏ qua quyền diện rộng                           |
| Schema SQLite/protobuf nội bộ thay đổi                                         | Cao          | Validate schema, ghim dải `agy` đã kiểm thử, duy trì kiểm thử fixture, hiển thị lỗi có hướng xử lý        |
| Nhiều tiến trình adapter làm hỏng trạng thái dùng chung                        | Cao          | File theo session, marker tombstone, ghi nguyên tử, khóa giữa các tiến trình                              |
| Prompt lượt đầu đồng thời ràng buộc nhầm conversation DB                       | Cao          | Tuần tự hóa lượt đầu cộng phát hiện dựa trên PID và từ chối nghiêm ngặt khi mơ hồ                         |
| Các phiên bản VS Code dưới Node 22 không chạy được `node:sqlite`               | Cao          | Nâng `engines.vscode` lên `^1.101.0` và kiểm thử runtime tối thiểu được hỗ trợ                            |
| Regression Electron tương lai loại bỏ `node:sqlite`                            | Trung bình   | Kiểm tra năng lực khi khởi động và kiểm tra smoke package                                                 |
| Adapter emit log vào stdout ACP                                                | Cao          | Chuyển toàn bộ chẩn đoán tới stderr; kiểm thử framing stdio                                               |
| Hủy để lại tiến trình con chạy                                                 | Trung bình   | Kill process group/tree và kiểm thử trên các nền tảng được hỗ trợ                                         |
| Tự cài đặt hoặc cũ `agy` version diverge khỏi thiết lập người dùng             | Trung bình   | Loại bỏ downloader; dùng CLI chính thức người dùng đã cài; áp dụng phiên bản tối thiểu                    |
| Phát hiện model chặn startup                                                   | Trung bình   | Timeout, cache, refresh nền, không hardcode danh sách model cũ                                            |
| Xóa lịch sử bị hiểu nhầm là delete conversation native của Google              | Trung bình   | Chỉ tombstone; ghi tài liệu ngữ nghĩa rõ ràng                                                             |
| kích thước VSIX tăng bất ngờ                                                   | Trung bình   | Đóng gói mã nguồn JS, không đóng gói binary Bun SEA; kiểm tra artifact và kích thước VSIX                 |
| Nâng cấp dependency/type ở root ảnh hưởng code hiện có                         | Trung bình   | Tách tsconfig vendor, chạy typecheck/kiểm thử đầy đủ, giữ thay đổi trong commit triển khai riêng          |

## Chiến lược rollback

Nếu adapter không ổn định sau phát hành:

1. Giữ `vscode-acp-chat.antigravity.enabled` mặc định false.
2. Loại bỏ hoặc tắt đăng ký catalog mà không ảnh hưởng agent tùy chỉnh.
3. Người dùng có thể tiếp tục dùng adapter bên ngoài được cấu hình thủ công qua `customAgents`.
4. Không tự động remove trạng thái adapter đã lưu.
5. Chỉ revert nâng mức engine VS Code tối thiểu nếu toàn bộ code tích hợp sẵn đặc thù Node 22 cũng được loại bỏ.

Khi Google phát hành hỗ trợ `agy --acp` chính thức:

1. Ưu tiên cấu hình tích hợp sẵn trực tiếp dùng `agy --acp` chính thức.
2. Chỉ giữ adapter tích hợp sẵn trong một giai đoạn migration có giới hạn nếu cần.
3. Chỉ migrate hành vi session/history khi ID ACP chính thức và ngữ nghĩa replay đã được xác minh.
4. Loại bỏ SQLite/protobuf reverse engineering và Node 22 adapter runtime khi không còn cần.

## Kết quả xác minh triển khai

- `agy --version`: `1.1.2`; `agy models`: thành công trên CLI đã cài.
- Adapter typecheck pass; root `npm run check-types` đã pass trong quá trình triển khai, nhưng lần chạy cuối bị chặn bởi thay đổi message-queue ngoài phạm vi tại `src/features/multi-session/host.ts`.
- `npm run lint`: pass với `0` lỗi, còn warning `no-explicit-any` trong test hiện có.
- `npm run test:antigravity-adapter`: pass `18/18` unit/hardening tests và ACP process smoke bằng fake `agy` Node, không dùng OAuth/network.
- Test VS Code tập trung cho catalog/helper Antigravity: pass `19/19` trên VS Code `1.128.1` qua `xvfb-run`.
- `npm test`: adapter suite/ACP smoke và phần lớn root suite pass; kết quả cuối `723 passing`, `1 failing` ở test webview scroll invalidation ngoài phạm vi Antigravity.
- Production bundle đã tạo `dist/antigravity-acp/index.mjs` khoảng `383 KB` và `LICENSE`; VSIX khoảng `2.08 MB` chứa đủ hai file và đã cài thành công bằng `code --install-extension --force`.
- Smoke OAuth/prompt bằng tài khoản thật không thực hiện do cảnh báo ToS/account. Không tạo fork remote vì môi trường chưa có GitHub authentication.

## Định nghĩa hoàn tất

- Fork do dự án sở hữu tồn tại và được pin trong `UPSTREAM.md` — **còn chờ publication/authentication**.
- Mã nguồn production đã vendor và giấy phép MIT được commit.
- Adapter runtime production không có dependency Bun.
- VSIX chứa `dist/antigravity-acp/index.mjs` và license của nó.
- Tiện ích không bao giờ tải `agy`.
- Antigravity tích hợp sẵn mặc định tắt và được đánh dấu thử nghiệm rõ ràng.
- Kiểm tra khả dụng `agy` CLI đã cài.
- Adapter dùng trạng thái OAuth/keyring của `agy` mà không tự xử lý credential.
- Các mode native `default`, `accept-edits` và `plan` hoạt động.
- Không code path nào thêm `--dangerously-skip-permissions`.
- Persistence multi-process và ràng buộc lượt đầu an toàn đồng thời.
- Hành vi model, streaming, structured tool/diff, cancel, list, load và resume pass kiểm thử tự động.
- MCP và giới hạn quyền được ghi tài liệu chính xác.
- Phiên bản VS Code tối thiểu và dependency Node 22 được ghi tài liệu.
- Typecheck, lint, kiểm thử, build production, kiểm tra nội dung VSIX, cài package và kiểm tra smoke thủ công hoàn tất thành công — **các cổng Antigravity pass; các lần chạy root cuối bị thay đổi message-queue ngoài phạm vi làm gián đoạn, OAuth smoke chủ động bỏ qua**.
- `docs/features/feature-catalog.md`, `README.md`, `CHANGELOG.md` và ghi chú hoàn tất của plan này được cập nhật sau triển khai.
