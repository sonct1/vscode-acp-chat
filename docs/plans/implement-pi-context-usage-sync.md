# Implementation Plan: Đồng bộ Pi Context Usage với Terminal

| Attribute  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Owner      | TBD                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Scope      | Bundled Pi ACP usage sampling, context-unavailable semantics, prompt completion ordering, model/compaction refresh, toolbar tooltip, regression tests, docs                                                                                                                                                                                                                                                                                                                  |
| References | `docs/plans/implement-pi-agent-toolbar-context-fixes.md`, `src/features/pi-agent/vendor/pi-acp/src/acp/session.ts`, `src/features/pi-agent/vendor/pi-acp/src/acp/usage.ts`, `src/features/pi-agent/vendor/pi-acp/src/pi-rpc/process.ts`, `src/acp/session-output-pipeline.ts`, `src/views/chat.ts`, `src/features/multi-session/host.ts`, `src/views/webview/widget/context-usage.ts`, Pi `0.80.3` `dist/core/agent-session.js`, Pi Toolkit `src/editor-statusline/index.ts` |

## Mục tiêu

Làm cho context usage trong ACP Chat phản ánh cùng nguồn dữ liệu và gần cùng thời điểm với Pi terminal:

- `used` phải tương ứng với `Pi getContextUsage().tokens` của session ACP hiện tại.
- `size` phải tương ứng với `Pi getContextUsage().contextWindow` hoặc model context window hiện tại.
- Context usage phải cập nhật trong turn dài có nhiều assistant/tool step, không chỉ sau khi toàn bộ agent loop kết thúc.
- Final snapshot sau `session/prompt` phải chứa usage mới nhất, không giữ số của turn trước.
- Sau compaction khi Pi báo token count chưa xác định, UI phải clear/hide số cũ thay vì fallback sang tổng token tích lũy toàn session.
- Sau model switch, context window và tỷ lệ phải được refresh theo model mới.
- Tooltip phải dùng thuật ngữ rõ ràng: `Context window`, không dùng `Total` dễ nhầm với tổng token/cost của toàn session.

## Kết quả phân tích hiện trạng

### Pi terminal đang tính như thế nào

Pi terminal hiện tại dùng Pi `0.80.3` và package `pi-toolkit/editor-statusline` thay cho footer mặc định.

Luồng terminal:

1. Statusline gọi `ctx.getContextUsage()`.
2. Pi core lấy assistant usage hợp lệ gần nhất:
   - ưu tiên `usage.totalTokens`;
   - fallback `input + output + cacheRead + cacheWrite`.
3. Nếu có message sau assistant usage gần nhất, Pi cộng thêm token estimate cho phần trailing message.
4. Tỷ lệ được tính bằng:

```text
context usage tokens / model.contextWindow × 100
```

5. `pi-toolkit/editor-statusline` refresh tại các lifecycle event như `message_end`, model selection và input/session changes.

Pi terminal không lấy tổng cộng dồn token của mọi assistant response để làm context numerator. `getSessionStats().tokens.total` là thống kê tích lũy toàn session; `getSessionStats().contextUsage.tokens` mới là context hiện tại.

### Extension Pi đang chạy như thế nào

Runtime topology:

```text
VS Code Extension Host
└─ dist/pi-acp/index.mjs
   └─ pi --mode rpc --no-themes
```

Đặc điểm:

- Adapter dùng executable `pi` đầu tiên trong child `PATH`.
- Môi trường hiện tại resolve tới Pi global `0.80.3` dưới Pi Node installation.
- Pi ACP subprocess kế thừa `~/.pi/agent/settings.json`, `models.json`, credentials, packages và extensions.
- Mỗi local ACP session có adapter/Pi subprocess riêng; standalone Pi terminal là process khác và chỉ so sánh trực tiếp được khi cùng session ID, model và thời điểm.
- Model `dx-tokens/gpt-5.6-sol` hiện khai báo `contextWindow: 1_050_000`, nên denominator `1,050,000` trong ảnh là đúng.

### Luồng usage hiện tại trong extension

```text
Pi RPC get_session_stats/get_state
  → normalizePiUsageUpdate()
  → ACP usage_update
  → ACPClient / SessionOutputPipeline
  → ManagedSession.contextUsage
  → contextUsage webview message
  → updateContextUsageRing()
```

Công thức UI hiện tại:

```text
ratio = used / size
percent = ratio × 100, làm tròn 1 chữ số
```

Ảnh có:

```text
232987 / 1050000 = 22.189...% → 22.2%
```

Phép tính UI đúng. `232,987` là một assistant context usage cũ trong JSONL, trong khi session sau đó đã có các usage mới lớn hơn. Đây là bằng chứng số bị stale theo lifecycle, không phải lỗi chia phần trăm.

## Root cause

### Root cause 1: Adapter chỉ sample usage tại `agent_end`

`PiAcpSession` hiện bỏ qua `message_end` và chỉ gọi `get_session_stats` sau `agent_end`.

Trong turn có nhiều tool step:

```text
assistant message_end
→ tool execution/result
→ assistant message_end
→ tool execution/result
→ ...
→ agent_end
```

Terminal refresh sau từng `message_end`; extension giữ usage cũ cho tới cuối toàn bộ agent loop.

### Root cause 2: Usage update chạy sau khi ACP prompt đã resolve

Flow hiện tại tại `agent_end`:

1. resolve pending `session/prompt`;
2. fire-and-forget `emitUsageUpdate()`;
3. host tiếp tục finalize stream và snapshot.

Hệ quả:

- `sendMessage()` có thể trả về trước khi `usage_update` được enqueue.
- `queue.waitForIdle()` có thể thấy queue đang rỗng rồi hoàn tất snapshot.
- Usage đến sau đó hoặc chỉ xuất hiện khi có delta/snapshot tiếp theo.
- Background/inactive session dễ giữ số stale lâu hơn.

### Root cause 3: Fallback sau compaction dùng sai semantic

Pi core trả:

```ts
contextUsage: {
  tokens: null,
  contextWindow: number,
  percent: null,
}
```

sau compaction và trước assistant response hợp lệ tiếp theo.

`normalizePiUsageUpdate()` hiện thấy `contextUsage.tokens` không phải number rồi fallback sang:

```text
stats.tokens.total
```

Nhưng `stats.tokens.total` là tổng token tích lũy của toàn session, không phải current context. UI vì vậy có thể hiển thị một tỷ lệ sai nghiêm trọng thay vì trạng thái unknown như terminal `?/1.05M`.

### Root cause 4: Không refresh khi model/context window đổi

Khi model được đổi, metadata model cập nhật nhưng usage cache có thể vẫn dùng `size` của model trước cho tới `agent_end` tiếp theo.

### Root cause 5: Tooltip dùng nhãn gây hiểu nhầm

`Total: 1050000` thực chất là model context window, không phải total tokens đã dùng hoặc total token billing của session.

## Quyết định kiến trúc

### Quyết định 1: Pi RPC là source of truth

Không parse JSONL trong live path và không tự tokenize transcript ở VS Code extension.

Nguồn chuẩn:

- `get_session_stats.contextUsage.tokens` → current context used.
- `get_session_stats.contextUsage.contextWindow` → context size.
- `get_state.model.contextWindow` chỉ là fallback size khi Pi version cũ không có context window trong stats.

Điều này giữ semantics đồng nhất với Pi terminal vì `get_session_stats.contextUsage` gọi trực tiếp Pi core `getContextUsage()`.

### Quyết định 2: Sample tại `message_end`, coalesce RPC calls

Adapter phải nhận `message_end` và yêu cầu refresh usage, nhưng không được tạo nhiều RPC request đồng thời.

Thiết kế đề xuất:

- Một usage refresh coordinator per `PiAcpSession`.
- Tối đa một `get_session_stats/get_state` đang chạy.
- Event mới trong lúc request đang chạy chỉ đánh dấu `refreshRequested = true`.
- Sau request hiện tại, chạy thêm đúng một lần nếu có request mới.
- Có debounce ngắn nếu cần để gom các event sát nhau.
- Kết quả cũ không được overwrite kết quả mới do completion out-of-order.

Không dùng polling interval nền.

### Quyết định 3: Final usage là một phần của prompt completion ordering

Tại `agent_end`:

1. yêu cầu một final usage refresh;
2. chờ refresh coordinator hoàn tất sample mới nhất;
3. flush ACP `usage_update`/clear signal;
4. sau đó mới resolve pending `session/prompt`;
5. tiếp tục queued prompt nếu có.

Stats lookup failure không được làm prompt fail. Nếu lookup lỗi, log debug/best-effort rồi vẫn resolve turn.

### Quyết định 4: Phân biệt `unavailable` với `missing/unsupported`

Usage normalization cần trả union rõ ràng:

```ts
type NormalizedPiContextUsage =
  | {
      state: "available";
      used: number;
      size: number;
      cost: { amount: number; currency: string } | null;
    }
  | {
      state: "unavailable";
      size: number;
      reason: "post_compaction" | "pending_provider_usage";
    }
  | {
      state: "unsupported";
    };
```

Rules:

- Nếu `stats.contextUsage.tokens` là number hợp lệ: emit usage bình thường.
- Nếu `stats.contextUsage` tồn tại và `tokens === null`: không fallback sang cumulative `stats.tokens.total`; phát clear/unavailable signal.
- Chỉ fallback sang `stats.tokens.total` khi `contextUsage` hoàn toàn không tồn tại, nhằm tương thích Pi version cũ.
- Malformed stats không được overwrite usage hợp lệ trước đó trừ khi Pi chủ động báo unavailable.

### Quyết định 5: Dùng ACP `_meta` cho trạng thái context unknown

ACP `usage_update` yêu cầu numeric `used/size`, nên không gửi `null` vào payload chuẩn.

Đề xuất signal:

```ts
{
  sessionUpdate: "session_info_update",
  _meta: {
    piAcp: {
      contextUsage: {
        state: "unavailable",
        size: 1050000,
        reason: "post_compaction"
      }
    }
  }
}
```

Extension host xử lý signal này bằng cách:

- `clearLastUsageUpdate()`;
- set session `contextUsage = null`;
- gửi `contextUsage { used: null, size: null, cost: null }` tới webview;
- ring bị hide và không tiếp tục hiển thị số cũ.

Khi Pi có usage hợp lệ trở lại, ACP `usage_update` bình thường sẽ hiện ring lại.

Không dùng `used: 0`, vì `0%` khác semantic với `unknown`.

### Quyết định 6: Tooltip phản ánh đúng metric

Tooltip mới:

```text
Context window: 1,050,000
Used: 232,987 (22.2%)
```

Nếu cần giữ exact raw number cho debugging, dùng locale-independent hoặc `toLocaleString()` nhất quán trong test. Không đổi công thức hoặc threshold màu trong scope này.

## Ngoài phạm vi

- Không thay model `contextWindow` trong `~/.pi/agent/models.json`.
- Không thay Pi core/`pi-toolkit/editor-statusline`.
- Không tạo tokenizer riêng trong extension.
- Không đồng nhất standalone Pi terminal process với ACP subprocess khác session.
- Không thay auto-compaction threshold/reserve.
- Không thiết kế lại toàn bộ context usage ring hoặc toolbar layout.
- Không thêm polling usage khi session idle.

## Danh sách thay đổi dự kiến

```text
src/features/pi-agent/vendor/pi-acp/src/acp/usage.ts
  - Trả available/unavailable/unsupported rõ ràng.
  - Không fallback cumulative total khi Pi chủ động trả contextUsage.tokens = null.

src/features/pi-agent/vendor/pi-acp/src/acp/session.ts
  - Thêm usage refresh coordinator/coalescing.
  - Refresh tại message_end.
  - Await final refresh + ACP flush trước khi resolve agent_end.
  - Refresh/clear sau compaction events.
  - Public helper để agent.ts yêu cầu refresh sau manual command/model change nếu cần.

src/features/pi-agent/vendor/pi-acp/src/acp/agent.ts
  - Refresh usage sau manual /compact.
  - Refresh usage sau model selection/config model change.
  - Không duplicate refresh ở thinking-only changes.

src/features/pi-agent/vendor/pi-acp/src/pi-rpc/process.ts
  - Chỉ thêm type/helper nếu cần; không thay protocol.

src/acp/client.ts
src/acp/session-output-pipeline.ts
src/views/chat.ts
src/features/multi-session/host.ts
  - Parse Pi context-unavailable _meta tại integration point nhỏ nhất.
  - Clear cached usage và gửi null contextUsage cho active/session snapshot.

src/views/webview/widget/context-usage.ts
  - Đổi tooltip Total thành Context window.
  - Giữ ratio/tier/ring behavior hiện tại.

src/features/pi-agent/vendor/pi-acp/test/**
src/test/**
  - Regression tests cho timing, coalescing, compaction, model switch, host clear và tooltip.

docs/features/feature-catalog.md
  - Ghi nhận Pi context usage được đồng bộ live với message lifecycle và clear sau compaction.

docs/architecture/acp-chat-layout.md
  - Chỉ cập nhật label/behavior nếu tài liệu hiện mô tả tooltip hoặc context ring state.
```

## Implementation phases

### Phase 1: Sửa usage normalization semantics

#### Task 1.1: Tạo normalized usage union

Refactor `normalizePiUsageUpdate()` thành helper trả trạng thái rõ ràng.

Acceptance criteria:

- [ ] `contextUsage.tokens` numeric dùng làm `used` ưu tiên.
- [ ] `contextUsage.contextWindow` numeric dùng làm `size` ưu tiên.
- [ ] `contextUsage.tokens === null` trả `unavailable`, không dùng `stats.tokens.total`.
- [ ] Pi stats không có field `contextUsage` vẫn hỗ trợ fallback legacy từ `tokens.total` + `get_state.model.contextWindow`.
- [ ] Cost normalization hiện tại không regression.
- [ ] Malformed/negative/non-finite fields không tạo usage sai.

#### Task 1.2: Thêm test cho post-compaction state

Test shape thực tế:

```ts
stats: {
  tokens: { total: 900000 },
  contextUsage: {
    tokens: null,
    contextWindow: 1050000,
    percent: null
  }
}
```

Expected:

```text
unavailable, size 1050000
```

Không expected `used = 900000`.

### Phase 2: Usage refresh coordinator trong Pi ACP session

#### Task 2.1: Coalesce concurrent refresh requests

Thêm state trong `PiAcpSession`, ví dụ:

```ts
private usageRefreshInFlight: Promise<void> | null;
private usageRefreshRequested = false;
```

Acceptance criteria:

- [ ] Nhiều `message_end` liên tiếp không tạo RPC storm.
- [ ] Tối đa một stats request đang chạy.
- [ ] Event tới trong lúc request chạy đảm bảo có một sample tiếp theo.
- [ ] Kết quả emit theo đúng thứ tự.
- [ ] Dispose/process failure không tạo unhandled rejection.

#### Task 2.2: Refresh tại `message_end`

Trong `handlePiEvent()`:

- nhận mọi Pi `message_end` liên quan tới context;
- gọi coordinator best-effort;
- không block stream event handling.

Acceptance criteria:

- [ ] Turn có nhiều tool step gửi nhiều usage update tiến triển tương ứng, với RPC calls được coalesce.
- [ ] UI không giữ usage của turn trước trong suốt agent loop dài.
- [ ] `usage_update` không làm thay đổi transcript/tool rendering.

#### Task 2.3: Await final usage trước prompt completion

Sửa `agent_end` flow để final refresh nằm trước pending turn resolve.

Acceptance criteria:

- [ ] Khi `session.prompt()` resolve, final usage notification đã được gửi vào ACP connection hoặc đã được clear có thứ tự.
- [ ] Multi-session `queue.waitForIdle()` quan sát được update cuối trước final snapshot.
- [ ] Prompt vẫn resolve nếu stats RPC fail.
- [ ] Queued prompt không bắt đầu trước khi final usage của prompt trước được flush.

### Phase 3: Compaction và model-change correctness

#### Task 3.1: Clear usage sau compaction khi Pi trả unknown

Xử lý cả event names Pi đang dùng/hỗ trợ:

- `compaction_end`;
- `auto_compaction_end` nếu adapter cần tương thích version cũ;
- manual `/compact` adapter command.

Acceptance criteria:

- [ ] Sau compaction chưa có assistant response mới, ring cũ bị clear/hide.
- [ ] Không hiển thị cumulative session total dưới dạng current context.
- [ ] Assistant response hợp lệ tiếp theo làm ring xuất hiện lại.
- [ ] Context window/model metadata vẫn giữ nguyên.

#### Task 3.2: Refresh sau model switch

Sau các path đổi model:

- `setSessionConfigOption(MODEL_CONFIG_ID)`;
- `unstable_setSessionModel()`;
- path model setter khác nếu có.

Acceptance criteria:

- [ ] `size` đổi theo context window của model mới mà không phải chờ agent turn tiếp theo.
- [ ] Update usage và config metadata có ordering ổn định.
- [ ] Thinking-level-only change không tạo stats request không cần thiết.

### Phase 4: Host/client clear propagation

#### Task 4.1: Parse Pi unavailable metadata

Tạo helper nhỏ để nhận biết `_meta.piAcp.contextUsage.state === "unavailable"`.

Ưu tiên đặt helper ở adapter/client compatibility layer phù hợp, tránh nhét feature implementation lớn vào core switch.

Acceptance criteria:

- [ ] Single-session path clear `ACPClient.lastUsageUpdate` và gửi null payload cho webview.
- [ ] Multi-session path set `ManagedSession.contextUsage = null` và append latest contextUsage clear event.
- [ ] Inactive session giữ đúng null snapshot; khi activate không replay usage cũ.
- [ ] Non-Pi agents không bị ảnh hưởng bởi metadata không liên quan.

#### Task 4.2: Không bỏ qua explicit clear

Hiện malformed `usage_update` bị ignore. Giữ behavior này cho payload lỗi, nhưng explicit Pi unavailable signal phải là clear có chủ đích.

Acceptance criteria:

- [ ] Payload ACP malformed không xóa usage hợp lệ.
- [ ] Pi unavailable signal xóa usage hợp lệ cũ.
- [ ] Clear/new usage ordering hoạt động khi compaction và assistant response xảy ra sát nhau.

### Phase 5: Tooltip semantics

#### Task 5.1: Đổi nhãn `Total`

Sửa `updateContextUsageRing()`:

```text
Total: 1050000
```

thành:

```text
Context window: 1,050,000
```

Acceptance criteria:

- [ ] Tooltip không gọi context capacity là total token usage.
- [ ] `Used` và phần trăm không đổi công thức.
- [ ] Cost line giữ nguyên.
- [ ] ARIA label đồng bộ tooltip.

### Phase 6: Tests

#### Pi ACP unit/component tests

Bổ sung test:

- [ ] Normalize current `contextUsage` numeric.
- [ ] Explicit `tokens: null` trả unavailable.
- [ ] Legacy stats không có `contextUsage` vẫn fallback đúng.
- [ ] `message_end` trigger usage refresh.
- [ ] Burst `message_end` được coalesce.
- [ ] Final `usage_update` được emit/flush trước `session.prompt()` resolve.
- [ ] Stats failure không reject prompt.
- [ ] Compaction emits unavailable/clear signal.
- [ ] Usage hợp lệ sau compaction thay clear signal.
- [ ] Model switch refresh context window.

#### Extension host/pipeline tests

Bổ sung test:

- [ ] Single-session nhận unavailable signal và gửi `contextUsage` null.
- [ ] Multi-session nhận unavailable signal và clear per-session snapshot.
- [ ] Background session clear không làm active session khác mất usage.
- [ ] Final snapshot sau prompt chứa newest usage.
- [ ] Malformed non-Pi usage update vẫn bị ignore.

#### Webview tests

Bổ sung/điều chỉnh test:

- [ ] Tooltip dùng `Context window`.
- [ ] Exact percentage vẫn đúng.
- [ ] Null payload hide ring và xóa tooltip/ARIA stale.
- [ ] Usage update sau clear hiện ring lại.

### Phase 7: Documentation, quality gates, package và install

Docs:

- Cập nhật `docs/features/feature-catalog.md` sau implementation.
- Cập nhật `docs/architecture/acp-chat-layout.md` nếu context ring tooltip/state được mô tả ở đó.
- Cập nhật status/completion notes của plan này.

Quality gates:

```bash
npm --prefix src/features/pi-agent/vendor/pi-acp run typecheck
npm --prefix src/features/pi-agent/vendor/pi-acp run lint
npm --prefix src/features/pi-agent/vendor/pi-acp test
npm run check-types
npm run compile-tests
npm test
npm run package
```

Package/install theo repo rule:

```bash
mkdir -p .tmp
npx vsce package --out .tmp/vscode-acp-chat-pi-context-usage-sync.vsix
code --install-extension .tmp/vscode-acp-chat-pi-context-usage-sync.vsix --force
rm .tmp/vscode-acp-chat-pi-context-usage-sync.vsix
```

Manual verification:

1. Chạy `Developer: Reload Window`.
2. Tạo Pi session mới với model `dx-tokens/gpt-5.6-sol`.
3. Gửi prompt tạo nhiều tool call.
4. Theo dõi context ring cập nhật trong turn, không giữ số turn trước tới cuối.
5. So sánh với Pi `getContextUsage()`/terminal trên đúng session hoặc log RPC cùng thời điểm.
6. Xác nhận final usage vẫn đúng sau stream end và sau switch session.
7. Chạy `/compact`; ring phải clear/unknown cho tới assistant response tiếp theo.
8. Đổi sang model có context window khác; denominator phải đổi ngay.
9. Hover ring và xác nhận tooltip dùng `Context window`.

## Rủi ro và giảm thiểu

| Risk                                                        | Impact | Mitigation                                                                                                                            |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Query stats sau mọi `message_end` tạo RPC overhead          | Medium | Coalesce/debounce; tối đa một request in-flight và một pending refresh.                                                               |
| `message_end`/`agent_end` đến sát nhau gây duplicate update | Low    | Coordinator dedupe sample/emit; final refresh chỉ đảm bảo newest state.                                                               |
| Chờ final usage làm tăng nhẹ thời gian kết thúc prompt      | Low    | Chỉ chờ một local RPC; đặt timeout/best-effort và không fail prompt khi stats lỗi.                                                    |
| Custom `_meta` clear signal không được client khác hiểu     | Low    | `_meta` là optional; client khác bỏ qua an toàn, còn standard numeric `usage_update` không đổi.                                       |
| Fallback legacy bị loại bỏ nhầm cho Pi version cũ           | Medium | Chỉ chặn fallback khi `contextUsage` tồn tại và `tokens === null`; vẫn giữ fallback khi field `contextUsage` hoàn toàn không tồn tại. |
| Model switch sample ghép stats/model không cùng thời điểm   | Medium | Serialize model setter rồi mới refresh; ưu tiên `stats.contextUsage.contextWindow`, dùng `get_state` chỉ làm fallback.                |
| Clear của background session ảnh hưởng active session       | High   | Mọi usage state keyed theo `ManagedSession.localSessionId`; test isolation giữa hai session.                                          |
| Standalone terminal vẫn khác vì khác process/session        | Low    | Manual verification phải dùng cùng session ID/model/time; tài liệu nêu rõ process isolation.                                          |
| Tooltip formatting thay đổi làm test snapshot fail          | Low    | Cập nhật targeted tests; không đổi DOM structure/ring threshold.                                                                      |

## Completion notes

Implemented Pi context usage synchronization end-to-end:

- Usage normalization now distinguishes available, explicit unavailable (`contextUsage.tokens === null`), and unsupported stats; legacy cumulative-token fallback only applies when `contextUsage` is absent.
- `PiAcpSession` coalesces usage refreshes, refreshes on `message_end`, waits up to one second for the final best-effort refresh plus ACP notification flush before resolving `session/prompt`, and refreshes after compaction/model changes.
- Pi unavailable metadata clears cached single-session and multi-session context usage while malformed/non-Pi updates remain ignored.
- The context ring tooltip now labels capacity as `Context window` and clears stale tooltip/ARIA state on null payloads.
- Added targeted normalization, adapter lifecycle, host/pipeline, and webview regression tests.

## Definition of Done

- Context ring dùng cùng current-context semantics với Pi `getContextUsage()`.
- Usage cập nhật trong agent loop dài thông qua `message_end`, với RPC calls được coalesce.
- Final usage được flush trước khi ACP prompt hoàn tất và trước final multi-session snapshot.
- Sau compaction, UI không fallback sang cumulative session token total và không giữ số stale.
- Sau model switch, context window được refresh theo model mới.
- Single-session và multi-session đều clear/restore usage đúng theo session.
- Tooltip dùng `Context window`, `Used`, percentage và optional cost rõ ràng.
- Regression tests cho normalization, event timing, ordering, compaction, model switch, session isolation và webview pass.
- Pi ACP typecheck/lint/tests và root typecheck/tests/package pass.
- VSIX được package và cài local thành công; user được nhắc `Developer: Reload Window`.
