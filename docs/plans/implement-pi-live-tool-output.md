# Triển khai live output từ non-final tool call, rollout Pi trước

Trạng thái: Đã triển khai cho Pi-first rollout trong working tree

## Tổng quan

Plan này triển khai live tool output theo hai tầng:

1. **Tầng ACP tổng quát**: nhận và render non-final `tool_call_update` cho mọi agent khi update chứa textual output an toàn.
2. **Tầng presentation profile riêng**: bổ sung cách chuẩn hóa/render chuyên biệt cho agent hoặc tool có structured output riêng.

Rollout đầu tiên chỉ kích hoạt presentation chuyên biệt cho Pi tích hợp sẵn:

- Pi built-in `bash`.
- Các Blackbytes sub-agent tool:
  - `delegate_explore`
  - `delegate_oracle`
  - `delegate_librarian`
  - `delegate_general`
  - `delegate_reviewer`

Sau khi Pi rollout ổn định, cùng hạ tầng sẽ được mở cho các built-in agent, MCP tool và custom tool khác nếu chúng phát non-final `tool_call_update` theo ACP.

Plan này là lát cắt thực thi đầu tiên của [Triển khai live output cho tool và custom tool](./implement-live-tool-output.md).

## Mục tiêu

### Mục tiêu ngắn hạn

Hiển thị output mới nhất trong cùng tool card khi Pi `bash` hoặc Pi sub-agent vẫn đang chạy.

### Mục tiêu kiến trúc

Tạo một pipeline dùng chung để mọi ACP agent có thể nhận live output mà không phải viết lại lifecycle:

```text
ACP agent
  -> non-final tool_call_update
  -> replacement-aware runtime merge
  -> agent/tool-specific profile nếu có
  -> generic ACP textual normalizer
  -> bounded ToolCallProgressMessage
  -> webview thay running snapshot
  -> final tool_call_update
  -> toolCallComplete
```

### Hành vi mong đợi

- Một `toolCallId` chỉ tạo một tool card trong một session.
- Spinner tồn tại đến khi tool hoàn thành hoặc thất bại.
- Progress update thay thế snapshot trước, không append mù quáng.
- Completion luôn thắng mọi pending hoặc stale progress.
- Pi bash hỗ trợ ANSI, `\r`, backspace và erase-line.
- Pi sub-agent hiển thị `outputPreview`, current nested tool và metadata thực thi.
- Generic ACP text progress có thể mở cho agent khác mà không sửa webview lifecycle.
- Legacy và multi-session mode có hành vi tương đương.
- Background session giữ latest running state mà không lưu mọi progress event.

## Hiện trạng đã xác minh

### Built-in agent trong extension

Các agent trong `src/acp/agents.ts` đều đi qua `ACPClient` dùng chung. Phần lớn chỉ là external ACP command; Pi là agent duy nhất có adapter được bundle trực tiếp trong extension.

Vì vậy:

- Extension đã nhận được `tool_call` và `tool_call_update` từ mọi agent.
- Extension không cần biết tool là built-in, MCP hay custom tool.
- Live output thực tế phụ thuộc agent/adapter có phát non-final update hay không.
- Agent chỉ phát final update vẫn giữ final-only behavior.

### Bundled Pi runtime

Extension khởi chạy:

```text
VS Code extension
  -> dist/pi-acp/index.mjs
  -> pi --mode rpc --no-themes
```

Pi packages/extensions vẫn được bật trong RPC mode. Môi trường cục bộ hiện tại load:

- `./packages/pi-toolkit`
- `https://github.com/cuongntr/pi-blackbytes.git`

### Pi bash

Luồng dữ liệu hiện tại:

```text
Pi bash tool
  -> onUpdate(partialResult)
  -> Pi RPC tool_execution_update
  -> bundled pi-acp tool_call_update
       status: in_progress
       content: normalized text snapshot
       rawOutput: original partialResult
  -> extension host lưu state
  -> webview chưa nhận running output
```

Pi tự thực thi bash; nó không dùng ACP `terminal/create`. Adapter chủ động map bash thành `kind: "other"` để client không suy luận rằng đây là ACP embedded terminal.

Code liên quan:

- `src/features/pi-agent/vendor/pi-acp/src/acp/session.ts`
- `src/features/pi-agent/vendor/pi-acp/src/acp/translate/pi-tools.ts`

### Pi Blackbytes sub-agent

Blackbytes dùng chung một progress reporter cho các `delegate_*` tool. Reporter:

- Gọi `onUpdate()` của Pi tool.
- Throttle text/thinking delta khoảng `300ms`.
- Phát full progress snapshot, ví dụ:

```ts
{
  content: [
    {
      type: "text",
      text: "Sub-agent explore running (12.3s, 1,245 chars captured)",
    },
  ],
  details: {
    agent: "explore",
    status: "running",
    model: "...",
    cwd: "...",
    elapsedMs: 12300,
    outputChars: 1245,
    outputPreview: "latest bounded accumulated preview...",
    currentTool: "grep",
    toolCallCount: 3,
    toolHistory: [
      { name: "read", summary: "src/...", startMs: 100, endMs: 350 },
      { name: "grep", summary: "pattern", startMs: 500 },
    ],
    usage: { input: 0, output: 0, total: 0, cost: 0 },
  },
}
```

Bundled Pi adapter giữ object này trong `rawOutput`. Generic text normalization của adapter chỉ lấy summary ngắn trong `content`, vì vậy Pi sub-agent cần presentation profile riêng để đọc `rawOutput.details.outputPreview`.

Code nguồn cục bộ đã xác minh:

- `~/.pi/agent/git/github.com/cuongntr/pi-blackbytes/src/sub-agents/register.ts`
- `~/.pi/agent/git/github.com/cuongntr/pi-blackbytes/src/sub-agents/progress-reporter.ts`
- `~/.pi/agent/git/github.com/cuongntr/pi-blackbytes/src/sub-agents/render.ts`

### Điểm làm mất live output hiện tại

Cả hai host path đều nhận progress nhưng chỉ render start và completion:

- Multi-session: `src/acp/session-output-pipeline.ts`
- Legacy: `src/views/chat.ts`

Non-final `tool_call_update` hiện chỉ:

1. Lưu `content`, `rawOutput` và metadata vào runtime state.
2. Có thể phát lại `toolCallStart`.
3. Chờ final status mới gửi output/details.

Webview hiện chỉ đăng ký:

- `toolCallStart`
- `toolCallComplete`

Do đó không cần thay ACP wire protocol; phần thiếu là projection, normalization, throttle, transcript compaction và webview progress rendering.

## Nguyên tắc tương thích với agent khác

### Non-final update là capability signal

ACP hiện không có capability riêng như `liveToolOutput: true`. Extension xác định agent hỗ trợ bằng chính dữ liệu nhận được:

- Có non-final displayable `tool_call_update` → render live.
- Không có non-final displayable update → giữ final-only.

Không cần hard-code danh sách mọi agent hỗ trợ.

### Các input generic được hỗ trợ

Generic ACP textual normalizer hỗ trợ các dạng an toàn sau:

| Input                                        | Hành vi                                          |
| -------------------------------------------- | ------------------------------------------------ |
| `content` chứa text block                    | Live text replacement                            |
| `rawOutput` dạng string                      | Live text replacement                            |
| `rawOutput.formatted_output` dạng string     | Live text replacement                            |
| `rawOutput.output` dạng string               | Live text replacement                            |
| `rawOutput.text` dạng string                 | Live text replacement                            |
| Status/title/kind/input/location update      | Cập nhật metadata nếu tool card đã tồn tại       |
| Arbitrary object không có field text đã biết | Không render live trong rollout generic đầu tiên |
| `content` chứa terminal reference            | Để dành cho ACP terminal bridge riêng            |
| Agent chỉ phát final update                  | Final-only như hiện tại                          |

### Không mặc định stringify arbitrary object

Generic rollout đầu tiên không stringify toàn bộ object vì có thể:

- Clone payload lớn qua `webview.postMessage()`.
- Render dữ liệu sâu hoặc không hữu ích.
- Làm lộ field nhạy cảm.
- Gây CPU/DOM churn.

Structured object chỉ được render khi có presentation profile đã xác minh, như Pi sub-agent.

### Không suy luận terminal chỉ từ `kind: "execute"`

Generic `execute` output được render dạng text trừ khi một profile xác định rõ terminal semantics.

Lý do:

- Không phải mọi `execute` output đều là terminal snapshot.
- `\r`/cursor control chỉ đúng nếu nguồn thực sự có terminal semantics.
- Pi bash cần profile `terminal` riêng dù `kind` của nó là `other`.

## Phạm vi

### Trong phạm vi rollout Pi đầu tiên

- Bundled Pi profile.
- Pi tool `bash`.
- Năm Blackbytes `delegate_*` tool hiện tại.
- Generic progress contract dùng chung.
- Replacement-aware runtime state.
- Bounded display projection.
- Revision và throttle.
- Legacy mode.
- Multi-session active/background/snapshot/resync.
- Automated tests, package và local VSIX installation.

### Trong phạm vi rollout generic tiếp theo

Sau khi Pi rollout pass manual verification:

- Bật generic textual non-final update cho mọi ACP agent.
- Áp dụng cho built-in, MCP và custom tool nếu agent chuyển tiếp progress qua ACP.
- Không cần profile riêng cho các dạng text chuẩn.
- Thêm compatibility matrix theo agent/version đã kiểm thử.

### Ngoài phạm vi

- ACP embedded terminal bridge.
- Thay đổi `TerminalHandler`.
- Interactive stdin.
- Full terminal emulator.
- Live image/audio/resource rendering.
- Live diff cho arbitrary agent trong rollout đầu tiên.
- Render Pi custom TUI component trong webview.
- Persist running process qua Extension Host restart.

## Quyết định kiến trúc

### 1. Hai tầng presentation

Dùng hai tầng theo thứ tự:

```text
Agent/tool-specific presentation profile
  -> nếu không match
Generic ACP textual normalizer
  -> nếu không có displayable text
Không phát toolCallProgress
```

Interface đề xuất:

```ts
export interface LiveToolOutputContext {
  agentId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export type LiveToolPresentation =
  | {
      format: "text";
      text: string;
      truncated: boolean;
    }
  | {
      format: "terminal";
      text: string;
      truncated: boolean;
    }
  | {
      format: "subagent";
      text: string;
      truncated: boolean;
      subagent: {
        agent?: string;
        status?: string;
        model?: string;
        elapsedMs?: number;
        outputChars?: number;
        currentTool?: string;
        toolCallCount?: number;
        toolHistory?: Array<{
          name: string;
          summary?: string;
          startMs?: number;
          endMs?: number;
        }>;
      };
    };

export interface LiveToolOutputProfile {
  id: string;
  project(context: LiveToolOutputContext): LiveToolPresentation | undefined;
}
```

### 2. Generic normalizer thuộc core, Pi structured profile thuộc feature Pi

Generic normalizer là protocol compatibility logic và thuộc core ACP, ví dụ:

```text
src/acp/tool-output-presentation.ts
```

Pi-specific structured parsing đặt tại:

```text
src/features/pi-agent/live-tool-output.ts
```

Core không import private Blackbytes implementation. Pi feature chỉ dùng structural type guard trên payload đã nhận.

### 3. Phân biệt bundled Pi với custom agent có ID `pi`

Không chỉ gate Pi structured profile bằng:

```ts
agentId === "pi";
```

`vscode-acp-chat.customAgents` cho phép custom agent override built-in agent có cùng ID. Custom agent đó không được áp dụng nhầm Blackbytes parser.

Mở rộng `AgentConfig` với marker nội bộ tùy chọn:

```ts
export type LiveToolOutputProfileId = "bundled-pi";

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  availabilityCommand?: string;
  liveToolOutputProfile?: LiveToolOutputProfileId;
}
```

`createPiAgentConfig()` đặt:

```ts
liveToolOutputProfile: "bundled-pi";
```

Custom agent override ID `pi` không có marker nên:

- Không dùng Pi structured profile.
- Vẫn có thể dùng generic ACP textual progress khi rollout generic được bật.

### 4. Pi bash không dùng ACP embedded terminal

Không sửa:

- `src/acp/terminal-handler.ts`
- `clientCapabilities.terminal`
- Pi `bash -> kind: "other"`

Pi bash presentation profile trả `format: "terminal"` để webview áp dụng cursor-control rendering, nhưng đây không phải ACP terminal resource.

### 5. Bounded display projection

Không gửi arbitrary live `rawOutput` sang webview.

Progress message đề xuất:

```ts
export interface ToolCallProgressMessage {
  type: "toolCallProgress";
  toolCallId: string;
  revision: number;
  title: string;
  kind?: ToolKind;
  status: "pending" | "in_progress";
  rawInput?: Record<string, unknown>;
  locations?: ToolCallLocation[];
  presentation: LiveToolPresentation;
}
```

Host runtime vẫn giữ full latest ACP state cho final completion. Webview chỉ nhận bounded presentation.

Giới hạn ban đầu:

- Generic text: `256 KiB` UTF-8, giữ phần cuối.
- Pi bash: `256 KiB` UTF-8, giữ phần cuối.
- Pi sub-agent preview: `32 KiB` phòng vệ; Blackbytes hiện giới hạn khoảng `8 KiB`.
- Pi sub-agent history: tối đa `30` entry mới nhất.
- Tool argument summary: tối đa `120` ký tự.

Truncation không được cắt giữa UTF-8 code point và phải có marker rõ ràng.

### 6. Replacement semantics

Mỗi update là latest snapshot.

Ví dụ:

```json
{ "rawOutput": "10%" }
{ "rawOutput": "20%" }
{ "rawOutput": "30%" }
```

UI lần lượt thay thành `10%`, `20%`, `30%`; không tạo `10%20%30%`.

Runtime merge phân biệt absent/value/null:

```ts
if (Object.prototype.hasOwnProperty.call(update, "content")) {
  state.content = update.content ?? undefined;
}

if (Object.prototype.hasOwnProperty.call(update, "rawOutput")) {
  state.rawOutput = update.rawOutput;
}
```

Áp dụng tương tự cho title, kind, status, rawInput và locations.

### 7. Một shared tool lifecycle cho legacy và multi-session

Multi-session đã dùng `SessionOutputPipeline`; legacy vẫn có implementation trùng lặp.

Không migrate toàn bộ legacy notification pipeline. Chỉ:

1. Tạo `SessionOutputPipeline` trong `ChatViewProvider`.
2. Delegate `tool_call` và `tool_call_update` cho pipeline.
3. Delegate pending tool finalization, reset và dispose.
4. Giữ assistant/thought/history/metadata/permission/connection handling ở legacy code hiện tại.
5. Xóa legacy tool state/helper sau parity tests.

### 8. Per-tool throttle và monotonic revision

- Snapshot đầu tiên có displayable output: emit ngay.
- Snapshot tiếp theo: trailing coalesce khoảng `150–200ms`.
- Chỉ giữ latest pending snapshot.
- Mỗi accepted state update tăng `revision`.
- Progress và completion đều mang revision.
- Completion đánh dấu state completed và hủy timer trước async final enrichment.
- Webview bỏ qua stale revision.
- Reset/clear/dispose hủy mọi timer.
- Cleanup mười phút chuyển thành inactivity timeout và refresh khi có progress.

### 9. Multi-session progress là replaceable state

`TranscriptStore` áp dụng:

- `toolCallProgress`: xóa retained progress cũ cùng `toolCallId`, append progress mới với sequence mới.
- `toolCallComplete`: xóa retained progress cùng tool rồi append completion.
- `nextSeq` vẫn tăng trên mọi delta phát ra.
- Snapshot có thể có gap trong event sequence; `lastSeq` là authoritative cursor.
- Background session chỉ giữ latest progress, không post DOM delta.
- Progress không update session ordering timestamp và không schedule manager refresh.

### 10. Webview không biết agent

Webview chỉ render `LiveToolPresentation`:

- `text`: escaped text output.
- `terminal`: render full snapshot bằng `ansiToHtml()` kể cả không có SGR color code.
- `subagent`: metadata + current tool + recent tool history + escaped output preview.

Webview không chứa agent ID allowlist hoặc Blackbytes-specific raw parsing.

## Generic ACP textual normalizer

Thứ tự ưu tiên:

1. Nối các ACP text content block theo thứ tự.
2. `rawOutput` dạng string.
3. `rawOutput.formatted_output` dạng string.
4. `rawOutput.output` dạng string.
5. `rawOutput.text` dạng string.
6. Không có output nếu không match.

Pseudo-code:

```ts
function normalizeGenericToolOutput(
  content: ToolCallContent[] | undefined,
  rawOutput: unknown
): LiveToolPresentation | undefined {
  const contentText = extractTextContent(content);
  if (contentText !== undefined) {
    return boundedTextPresentation(contentText);
  }

  if (typeof rawOutput === "string") {
    return boundedTextPresentation(rawOutput);
  }

  if (isRecord(rawOutput)) {
    for (const key of ["formatted_output", "output", "text"] as const) {
      const value = rawOutput[key];
      if (typeof value === "string") {
        return boundedTextPresentation(value);
      }
    }
  }

  return undefined;
}
```

Generic normalizer không parse arbitrary nested object trong rollout đầu tiên.

## Pi presentation profile

### Eligibility

Pi profile chỉ kích hoạt khi:

```text
agent.liveToolOutputProfile == "bundled-pi"
```

Tool-specific behavior:

| Tool                 | Presentation                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `bash`               | `terminal`                                                            |
| `delegate_explore`   | `subagent`                                                            |
| `delegate_oracle`    | `subagent`                                                            |
| `delegate_librarian` | `subagent`                                                            |
| `delegate_general`   | `subagent`                                                            |
| `delegate_reviewer`  | `subagent`                                                            |
| Pi tool khác         | Fallback generic nếu rollout generic bật; nếu chưa bật thì final-only |

### Bash normalization

Thứ tự ưu tiên:

1. ACP text content block.
2. `rawOutput` string.
3. `rawOutput.details.stdout` và stderr.
4. `rawOutput.stdout` và stderr.
5. `rawOutput.details.output` hoặc `rawOutput.output`.
6. `rawOutput.text`.

Kết quả là `format: "terminal"`.

Nếu payload không giữ thứ tự stdout/stderr, dùng deterministic normalization hiện có trong `pi-acp` và gắn nhãn stderr.

### Sub-agent normalization

Nhận diện payload khi `rawOutput` là object có `details` object tương thích.

Ưu tiên live text:

1. `details.outputPreview`.
2. ACP text content summary.
3. Generic textual fallback.

Metadata được chuẩn hóa phòng vệ:

- String: agent, status, model, currentTool.
- Finite number: elapsedMs, outputChars, toolCallCount.
- Tool history entry bắt buộc có string `name`.
- Bỏ field lạ.
- Không gửi `cwd`, `allowedTools`, raw nested messages hoặc provider payload sang webview.

### Completion

- Bash completion dùng full final Pi result.
- Sub-agent completion dùng final delegate content, không dùng bounded preview.
- Latest presentation chỉ làm fallback nếu final result không có displayable output.
- Completion revision phải mới hơn mọi progress revision.

## Luồng mục tiêu

### Pi bash

```text
Pi bash starts
  -> tool_execution_start
  -> pi-acp tool_call(title=bash, status=in_progress)
  -> toolCallStart

Pi bash emits cumulative snapshot
  -> tool_execution_update
  -> pi-acp non-final tool_call_update
  -> runtime replacement merge
  -> bundled-pi bash profile
  -> bounded terminal presentation
  -> toolCallProgress(revision N)
  -> same running card is replaced

Pi bash completes/fails
  -> final tool_call_update
  -> cancel pending progress
  -> toolCallComplete(revision N+1)
```

### Pi sub-agent

```text
delegate_* starts
  -> toolCallStart

Blackbytes onUpdate snapshot
  -> Pi tool_execution_update
  -> pi-acp non-final tool_call_update(rawOutput.details)
  -> bundled-pi subagent profile
  -> outputPreview + metadata presentation
  -> toolCallProgress

Delegate completes/fails
  -> final tool_call_update
  -> toolCallComplete with final answer
```

### Agent khác

```text
OpenCode / Claude / Codex / Gemini / custom ACP agent
  -> non-final tool_call_update(content or known rawOutput text)
  -> no specific profile
  -> generic ACP textual normalizer
  -> toolCallProgress(format=text)

Nếu agent không phát non-final displayable update
  -> không có progress message
  -> final-only behavior giữ nguyên
```

## Các file dự kiến thay đổi

| File                                                                        | Thay đổi                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/acp/tool-output-presentation.ts`                                       | Generic ACP text extraction, bounding, profile interfaces và profile resolution                |
| `src/features/pi-agent/live-tool-output.ts`                                 | Bundled Pi bash/sub-agent profile và Blackbytes structural type guards                         |
| `src/features/pi-agent/host.ts`                                             | Gắn marker `liveToolOutputProfile: "bundled-pi"`                                               |
| `src/features/pi-agent/index.ts`                                            | Export Pi profile an toàn cho host                                                             |
| `src/acp/agents.ts`                                                         | Mở rộng `AgentConfig` với optional live-output profile marker                                  |
| `src/acp/session-output-pipeline.ts`                                        | Replacement-aware state, profile/generic projection, scheduler, revision và final cancellation |
| `src/views/chat.ts`                                                         | Delegate legacy tool lifecycle cho shared pipeline                                             |
| `src/features/multi-session/host.ts`                                        | Truyền profile theo session agent; xử lý progress là ephemeral activity                        |
| `src/features/multi-session/transcript-store.ts`                            | Upsert progress và completion supersede retained progress                                      |
| `src/features/multi-session/contracts.ts`                                   | Mở rộng typed render/transcript contract nếu cần                                               |
| `src/views/webview/types.ts`                                                | Thêm progress/revision/presentation types                                                      |
| `src/views/webview/component/message-list.ts`                               | Xử lý progress và stale revision                                                               |
| `src/views/webview/block/tool-block.ts`                                     | Theo dõi revision, live details và output scroll state                                         |
| `src/views/webview/tool-render.ts`                                          | Render text/terminal/subagent presentation                                                     |
| `src/test/tool-output-presentation.test.ts`                                 | Generic và Pi profile unit tests                                                               |
| `src/test/session-output-pipeline.test.ts`                                  | Progress lifecycle, merge, throttle, completion và compatibility tests                         |
| `src/test/chat.test.ts`                                                     | Legacy parity                                                                                  |
| `src/test/webview.test.ts`                                                  | Live renderer, revision, ANSI/cursor, XSS và scroll tests                                      |
| `src/test/features/multi-session.test.ts`                                   | Delta, compaction, replay, background và isolation tests                                       |
| `src/features/pi-agent/vendor/pi-acp/test/component/session-events.test.ts` | Pi bash và Blackbytes progress fixtures                                                        |
| `src/test/mocks/acp-server.ts`                                              | Pi-like và generic ACP delayed progress cho integration/manual tests nếu cần                   |

Không sửa `src/acp/terminal-handler.ts` trong plan này.

## Các giai đoạn thực hiện

### Phase 0 — Cố định fixture thực tế

1. Thêm hai cumulative Pi bash update: `"one"`, sau đó `"one\ntwo"`.
2. Xác nhận adapter chuyển mỗi update thành latest ACP snapshot.
3. Thêm Blackbytes-shaped progress fixture có `outputPreview`, `currentTool`, `toolHistory`.
4. Xác nhận structured details còn nguyên trong `rawOutput`.
5. Thêm generic ACP fixtures:
   - text content.
   - rawOutput string.
   - `output`/`text`/`formatted_output`.
   - status-only.
   - arbitrary object không được hỗ trợ.

Điều kiện hoàn thành:

- Test fixtures phản ánh đúng wire shape mà host sẽ nhận.
- Replacement semantics được chứng minh bằng test.

### Phase 1 — Generic presentation core và Pi profile

1. Tạo generic extraction/bounding module.
2. Tạo profile interface/resolution.
3. Tạo bundled Pi marker trong `AgentConfig`.
4. Tạo Pi bash/sub-agent profile.
5. Thêm `LiveToolPresentation` và progress message contract.
6. Unit test malformed, unsupported, truncation và custom agent override ID `pi`.

Điều kiện hoàn thành:

- Generic text chuẩn hóa độc lập với agent.
- Pi structured parser không chạy cho custom agent chỉ trùng ID `pi`.
- Không gửi arbitrary object sang webview.

### Phase 2 — Shared host lifecycle

1. Mở rộng runtime state với status, revision, completion và scheduler.
2. Dùng property-presence merge.
3. Resolve presentation theo profile trước, generic normalizer sau.
4. Thêm per-tool throttle.
5. Hủy timer trước completion.
6. Refresh inactivity cleanup.
7. Chuyển legacy tool event/finalization/reset sang shared pipeline.
8. Xóa duplicated legacy tool state sau parity tests.

Điều kiện hoàn thành:

- Một lifecycle dùng chung cho mọi agent.
- Pi profile có thể bật độc lập với generic rollout.
- Final-only agent không thay đổi hành vi.

### Phase 3 — Webview live rendering

1. Đăng ký `toolCallProgress`.
2. Reuse block theo `toolCallId`.
3. Từ chối stale revision.
4. Giữ spinner và details mở.
5. Render `text` bằng escaped `<pre>`.
6. Render `terminal` bằng `ansiToHtml()` trên full snapshot.
7. Render structured `subagent` metadata/output.
8. Giữ output-local scroll intent và copy controls.

Điều kiện hoàn thành:

- Webview không phân biệt agent.
- Pi bash và sub-agent hiển thị đúng.
- Generic text presentation có thể bật mà không sửa renderer.

### Phase 4 — Multi-session compaction và backpressure

1. Upsert retained progress theo tool ID.
2. Completion xóa retained progress.
3. Giữ monotonic delta sequence.
4. Background session giữ latest snapshot.
5. Không update ordering/manager state theo từng progress flush.
6. Test session isolation.

Điều kiện hoàn thành:

- Transcript snapshot không tăng tuyến tính theo progress count.
- Session switch/resync hiển thị latest running state.

### Phase 5 — Rollout Pi trước

Kích hoạt:

```text
liveToolOutputProfile == bundled-pi
AND tool thuộc bash/delegate_* allowlist
```

Generic ACP normalizer đã tồn tại nhưng chưa áp dụng mặc định cho agent không có profile.

Thực hiện:

1. Automated tests đầy đủ.
2. Package/install VSIX.
3. Manual test Pi bash và năm delegate tool trong cả hai mode.
4. Theo dõi DOM responsiveness, message rate và transcript size.

Điều kiện hoàn thành:

- Tất cả Pi acceptance criteria pass.
- Không có regression với agent khác.

### Phase 6 — Mở generic textual progress cho agent khác

Sau khi Pi rollout ổn định:

1. Bật generic normalizer cho mọi agent.
2. Chỉ hỗ trợ safe textual shapes đã liệt kê.
3. Không bật arbitrary JSON fallback.
4. Smoke test từng built-in agent/version khả dụng.
5. Ghi compatibility matrix thực tế.
6. Giữ per-agent/profile override nếu một adapter có semantics không tương thích.

Điều kiện hoàn thành:

- Non-Pi agent phát text progress hiển thị live.
- Agent final-only không regress.
- Không cần thay đổi webview hoặc transcript lifecycle.

### Phase 7 — ACP embedded terminal riêng

Không thuộc implementation hiện tại. Chỉ thực hiện sau bằng terminal event/snapshot bridge theo generic plan.

## Ma trận automated test

### Generic normalizer

1. Text content update tạo `format: "text"`.
2. Raw string tạo text presentation.
3. `formatted_output`, `output`, `text` được nhận diện đúng thứ tự.
4. Arbitrary object không tạo presentation.
5. Status-only update không tạo output rỗng.
6. Explicit clear xóa output cũ.
7. Output vượt giới hạn được truncate đúng UTF-8.
8. Generic normalizer không mutate input object.

### Pi profile

1. Bundled Pi `bash` tạo terminal presentation.
2. Pi delegate tool tạo sub-agent presentation.
3. `outputPreview` ưu tiên hơn summary.
4. Malformed sub-agent details degrade an toàn.
5. Pi tool khác fallback theo rollout mode.
6. Non-Pi bash không dùng Pi bash profile.
7. Custom agent ID `pi` không dùng bundled Pi profile.

### Session output pipeline

1. Tool start chỉ tạo một card.
2. Non-final displayable update phát progress.
3. Hai snapshot replace, không concatenate.
4. Raw-output-only update hoạt động.
5. Explicit null clear state.
6. Update-before-start được xử lý phòng vệ.
7. Rapid update coalesce và latest wins.
8. First update emit ngay.
9. Completion cancel timer và có revision mới hơn.
10. Không có progress sau complete/reset/dispose.
11. Cancel/error finalization giữ latest output.
12. File diff enrichment không regress.
13. Legacy và multi-session parity.

### Webview

1. Progress-before-start tạo một fallback block.
2. Repeated progress không duplicate.
3. Spinner tồn tại khi running.
4. Stale revision bị bỏ qua.
5. Text được escape.
6. Terminal ANSI render đúng.
7. Plain `\r`, backspace, erase-line render đúng.
8. Sub-agent metadata/history/preview cập nhật đúng.
9. Copy lấy latest output.
10. Scroll intent được giữ.
11. Completion remove spinner và finalizes đúng.

### Multi-session

1. Active delta sequence liên tục.
2. Snapshot chỉ giữ latest progress mỗi tool.
3. Completion supersede progress.
4. Background không post active DOM delta.
5. Activation/resync render latest progress.
6. Cùng tool ID trong hai session không chia sẻ state.
7. Progress không reorder session liên tục.

### Negative compatibility

1. OpenCode-style final-only call không đổi.
2. Non-Pi status-only update không tạo output giả.
3. Non-Pi arbitrary object không bị stringify.
4. Structured diff của agent khác không regress.
5. History replay final-only không đổi.
6. ACP embedded terminal behavior không đổi.

## Ma trận kiểm tra thủ công

### Pi bash

Delayed lines:

```bash
for i in 1 2 3 4 5; do echo "line $i"; sleep 0.2; done
```

Carriage-return progress:

```bash
for i in 10 20 30 40 50 60 70 80 90 100; do printf '\r%3d%%' "$i"; sleep 0.2; done; echo
```

Kiểm tra thêm:

- ANSI colors.
- Mixed stdout/stderr.
- Output vượt limit.
- Cancel giữa chừng.
- Non-zero exit.

### Pi sub-agent

Chạy lần lượt:

- `delegate_explore`
- `delegate_oracle`
- `delegate_librarian`
- `delegate_general`
- `delegate_reviewer`

Xác minh:

- Status/elapsed/call count cập nhật.
- Current nested tool thay đổi.
- Recent history cập nhật.
- `outputPreview` thay đổi.
- Final answer thay live preview.
- Background session replay đúng.
- Failure/timeout/cancel giữ final state hữu ích.

### Generic agent rollout

Với mỗi agent có thể chạy trong môi trường:

1. Ghi lại agent/version.
2. Xác nhận có hoặc không phát non-final `tool_call_update`.
3. Kiểm tra text content/raw output live.
4. Kiểm tra final-only fallback.
5. Kiểm tra payload bất thường không làm crash.

## Quality gates và cài đặt

```bash
npm run check-types
npx eslint src
npm run compile-tests
npm test
npm run package
npx vsce package --out .tmp/vscode-acp-chat-live-tool-output.vsix
code --install-extension .tmp/vscode-acp-chat-live-tool-output.vsix --force
```

Sau khi cài:

1. Xóa temporary VSIX khi an toàn.
2. Chạy `Developer: Reload Window`.
3. Thực hiện manual verification matrix.

## Tiêu chí chấp nhận rollout Pi

1. Pi bash hiển thị output trước completion.
2. Năm Pi sub-agent tool hiển thị `outputPreview` trước completion.
3. Một tool call chỉ có một card.
4. Snapshot replacement đúng.
5. Spinner tồn tại đến final status.
6. ANSI và cursor control đúng.
7. Sub-agent metadata an toàn và có giới hạn.
8. Completion thắng stale progress.
9. Legacy và multi-session tương đương.
10. Background replay có latest running state.
11. Transcript không tăng tuyến tính.
12. Agent khác giữ behavior hiện tại trong rollout Pi.

## Tiêu chí chấp nhận rollout generic

1. Mọi agent phát standard non-final textual update đều có live output.
2. Không cần agent-specific branch cho standard text shapes.
3. Agent chỉ phát final update vẫn hoạt động như cũ.
4. MCP/custom tool dùng cùng generic path nếu agent relay progress qua ACP.
5. Arbitrary object không được render nếu chưa có profile.
6. Agent-specific profile có thể override generic presentation mà không thay lifecycle.

## Rủi ro và giảm thiểu

| Rủi ro                                       | Giảm thiểu                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Agent khác có semantics không tương thích    | Rollout Pi trước; generic chỉ nhận standard textual shapes; profile có thể override |
| Custom agent override ID `pi` bị parse nhầm  | Dùng internal bundled-Pi profile marker, không chỉ agent ID                         |
| Cumulative snapshot bị append trùng          | Replacement-only semantics                                                          |
| Arbitrary object lớn hoặc nhạy cảm           | Không stringify generic object; chỉ gửi bounded typed projection                    |
| Bash flood message/DOM                       | Per-tool throttle và output cap                                                     |
| Double throttle với Blackbytes               | First emit ngay; host window tối đa khoảng `150–200ms`                              |
| Plain `\r` không được xử lý                  | Pi bash profile dùng `format: "terminal"`                                           |
| Stale progress ghi đè final                  | Completed flag, timer cancellation và revision                                      |
| Long-running tool bị cleanup                 | Refresh inactivity timeout                                                          |
| Transcript phình                             | Upsert latest progress theo tool ID                                                 |
| Background session gây manager churn         | Progress là ephemeral activity                                                      |
| Legacy/multi-session diverge                 | Shared `SessionOutputPipeline` tool lifecycle                                       |
| Core shared change gây regression agent khác | Negative compatibility tests và staged rollout                                      |

## Ghi chú hoàn thành Pi-first rollout

Đã triển khai lát cắt Pi-first theo marker nội bộ `liveToolOutputProfile: "bundled-pi"`:

- Core có `src/acp/tool-output-presentation.ts` với typed presentation, safe textual normalizer, UTF-8 tail bounding, và profile resolution. Generic normalizer tồn tại nhưng không bật mặc định cho non-Pi agents.
- Pi-specific profile nằm trong `src/features/pi-agent/live-tool-output.ts`, chỉ match bundled Pi `bash` và năm `delegate_*` tool allowlist; custom agent chỉ trùng id `pi` không được parse theo Pi profile nếu thiếu marker.
- `SessionOutputPipeline` xử lý replacement-aware merge theo property presence, revision tăng đơn điệu, per-tool throttle 175ms, completion/reset/dispose cancellation, và progress projection bounded trước khi gửi webview.
- Legacy path dùng shared pipeline cho ACP session updates/tool lifecycle; multi-session truyền profile theo session agent, giữ progress ephemeral, không touch session ordering/manager churn, và transcript compact latest progress theo tool id.
- Webview nhận `toolCallProgress`, reuse cùng tool block, bỏ stale revision, giữ spinner, render text/terminal/subagent presentation; terminal live output luôn đi qua `ansiToHtml()` để hỗ trợ CR/backspace/erase kể cả khi không có SGR color.
- Tests tập trung được thêm cho adapter fixture, normalizer/Pi profile, replacement/throttle/final-wins lifecycle, webview revision/XSS/terminal rendering, legacy parity và multi-session compaction.
- Quality gates đã pass: typecheck, ESLint trên các file thay đổi, toàn bộ VS Code test suite qua `xvfb-run` (`753 passing`), production package, VSIX package và local install.

Không triển khai generic rollout cho tất cả agents và không triển khai ACP embedded terminal bridge trong thay đổi này. Manual Pi bash/delegate smoke test sau reload vẫn cần thực hiện trong VS Code UI.

## Rollout và rollback

### Rollout

1. Merge generic core nhưng chỉ bật bundled Pi profile.
2. Xác minh Pi bash/sub-agent thực tế.
3. Bật generic ACP text progress cho agent khác.
4. Thêm profile riêng chỉ khi structured output thực sự cần.
5. Thực hiện terminal bridge ở thay đổi riêng.

### Rollback

Có thể rollback độc lập:

1. Tắt generic rollout nhưng giữ Pi profile.
2. Tắt sub-agent profile nhưng giữ Pi bash.
3. Tắt toàn bộ profile nhưng giữ message contract/core code.
4. Tăng throttle hoặc giảm projection limit.
5. Revert transcript compaction nếu replay có vấn đề.

Không thay đổi ACP wire protocol và không yêu cầu data migration.
