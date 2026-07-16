# Kế hoạch triển khai: Luồng ACP Elicitation dùng chung

| Thuộc tính    | Giá trị                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trạng thái    | Hoàn tất giai đoạn 1; chờ smoke test agent thực tế sau khi reload VS Code                                                                                                            |
| Phạm vi       | ACP `elicitation/create`, form nhập liệu có cấu trúc, legacy và multi-session, background session, validation, test, tài liệu và đóng gói                                            |
| Feature chính | `src/features/acp-elicitation/`                                                                                                                                                      |
| Protocol      | `@agentclientprotocol/sdk@1.2.1`; ACP elicitation hiện là unstable/experimental                                                                                                      |
| Tham chiếu    | `src/acp/client.ts`, `src/views/chat.ts`, `src/features/multi-session/`, `src/features/register-host.ts`, `src/features/register-webview.ts`, `docs/architecture/acp-chat-layout.md` |

## 1. Mục tiêu

Triển khai **một luồng elicitation dùng chung ở tầng ACP** để mọi ACP agent tương thích có thể yêu cầu người dùng cung cấp dữ liệu có cấu trúc và tiếp tục xử lý trong cùng một turn.

Luồng mục tiêu:

```text
ACP agent bất kỳ
  → ACP elicitation/create
  → ACPClient
  → feature ACP elicitation dùng chung
  → webview hiển thị form
  → user Accept / Decline / Cancel
  → Extension Host kiểm tra dữ liệu
  → CreateElicitationResponse
  → agent tiếp tục cùng turn
```

Claude Code `AskUserQuestion` là use case đầu tiên để kiểm chứng, **không phải kiến trúc riêng cho Claude Code**.

Không được triển khai logic theo agent ID:

```ts
// Không làm như vậy
if (agentId === "claude-code") {
  // render AskUserQuestion
}
```

Thay vào đó, mọi agent phát đúng ACP `elicitation/create` phải đi qua cùng transport, queue, validation, UI và response lifecycle.

## 2. Phân biệt elicitation và permission

Hai luồng có mục đích khác nhau và phải được giữ tách biệt:

```text
session/requestPermission
  → user cho phép hoặc từ chối một hành động nhạy cảm

elicitation/create
  → agent hỏi và thu thập dữ liệu có cấu trúc từ user
```

| Nội dung                  | Permission                              | Elicitation                                            |
| ------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Mục đích                  | Cho phép chạy tool, ghi file, chạy lệnh | Thu thập lựa chọn, text, số, boolean hoặc dữ liệu form |
| Request                   | `session/requestPermission`             | `elicitation/create`                                   |
| Response                  | `selected` hoặc `cancelled`             | `accept`, `decline` hoặc `cancel`                      |
| Dữ liệu trả về            | `optionId`                              | `content` theo schema                                  |
| UI                        | Permission dialog                       | Form nhập liệu riêng                                   |
| Có thể tiếp tục cùng turn | Có                                      | Có                                                     |

Không tái sử dụng permission dialog để giả lập elicitation. Việc đó sẽ làm mất semantics của `decline`, free-text, multi-select và validation theo schema.

## 3. Quyết định phạm vi

### 3.1. Giai đoạn 1: form elicitation

Chỉ quảng bá capability khi toàn bộ host handler và webview UI đã sẵn sàng:

```ts
clientCapabilities: {
  elicitation: {
    form: {},
  },
}
```

Phạm vi hỗ trợ:

- form gắn với ACP session;
- form gắn với một tool call;
- form gắn với JSON-RPC request trước khi ACP session được tạo;
- text và free-text;
- single-select;
- multi-select;
- number và integer;
- boolean;
- `email`, `uri`, `date`, `date-time`;
- response `accept`, `decline`, `cancel`;
- legacy single-session;
- multi-session active và background;
- agent hủy JSON-RPC request;
- user Stop, đóng session hoặc dispose extension.

### 3.2. Giai đoạn 2: URL elicitation

Không quảng bá `url: {}` trong giai đoạn 1.

URL elicitation có lifecycle riêng:

```text
elicitation/create(mode=url)
  → extension hiển thị yêu cầu mở URL
  → user chủ động mở browser
  → user hoàn thành flow ngoài extension
  → agent gửi elicitation/complete
  → extension đóng trạng thái chờ
```

Giai đoạn này cần thêm:

- validate URL và protocol;
- chỉ mở URL khi user chủ động;
- correlation bằng `elicitationId`;
- handler cho notification `elicitation/complete`;
- trạng thái chờ external flow;
- xử lý completion trùng hoặc đến sai thứ tự;
- chính sách riêng cho OAuth và URL có dữ liệu nhạy cảm.

### 3.3. Ngoài phạm vi giai đoạn 1

- Custom method như `opencode/question`.
- Custom method như `gemini/requestUserInput`.
- Custom method như `cursor/ask_question`.
- Refactor permission và elicitation thành một hệ thống duy nhất.
- Lưu form hoặc câu trả lời qua lần restart VS Code.
- Chuyển câu trả lời elicitation thành user prompt thông thường.
- Render custom/unknown elicitation mode theo suy đoán.
- Render custom/unknown property type theo suy đoán.
- Chạy tùy ý regular expression từ trường `pattern` do agent cung cấp.

## 4. Hiện trạng extension

`ACPClient.connect()` hiện chỉ quảng bá filesystem và terminal:

```ts
clientCapabilities: {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
}
```

Extension chưa có:

- `clientCapabilities.elicitation.form`;
- request handler cho `elicitation/create`;
- notification handler cho `elicitation/complete`;
- host queue dành cho elicitation;
- webview form renderer;
- validation câu trả lời theo schema;
- routing elicitation theo multi-session.

Hệ quả với Claude Code hiện tại:

```text
VS Code ACP Chat không quảng bá elicitation.form
  → claude-agent-acp disable AskUserQuestion
  → Claude báo tool không có trong environment
  → không có request nào tới Extension Host
```

Đây là thiếu capability ở ACP client, không phải lỗi riêng của model hoặc permission mode.

## 5. Contract ACP cần hỗ trợ

SDK `1.2.1` có:

```ts
acp.methods.client.elicitation.create;
acp.methods.client.elicitation.complete;
```

### 5.1. Form request

```ts
{
  sessionId?: string;
  requestId?: string | number;
  toolCallId?: string | null;
  mode: "form";
  message: string;
  requestedSchema: {
    type?: "object";
    title?: string | null;
    description?: string | null;
    properties?: Record<string, ElicitationPropertySchema>;
    required?: string[] | null;
  };
}
```

Request có hai loại scope:

```text
Session scope
  → có sessionId
  → có thể có toolCallId

Request scope
  → có requestId
  → có thể xảy ra trước session/new
```

Vì vậy không được route chỉ dựa trên `params.sessionId`.

### 5.2. Response

```ts
{ action: "accept", content?: Record<string, ElicitationContentValue> | null }
{ action: "decline" }
{ action: "cancel" }
```

Giá trị hợp lệ trong `content`:

```ts
string | number | boolean | string[]
```

### 5.3. Nguyên tắc fail-closed

Nếu handler chưa được đăng ký, schema không hợp lệ hoặc mode không được hỗ trợ:

```ts
{
  action: "cancel";
}
```

Không được tự điền dữ liệu hoặc tự `accept`. Không sao chép hành vi fallback hiện tại của permission là tự chọn allow option đầu tiên.

## 6. Kiến trúc mục tiêu

```text
┌──────────────────────────────────────────────────────────────┐
│ ACP agent / adapter                                          │
│ Claude, Codex, Goose, Kimi hoặc custom ACP agent            │
└───────────────────────────┬──────────────────────────────────┘
                            │ elicitation/create
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ src/acp/client.ts                                            │
│ - ACP transport                                              │
│ - capability negotiation                                     │
│ - chuyển params + requestId + AbortSignal                   │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ src/features/acp-elicitation/host.ts                         │
│ - owner registry                                             │
│ - pending FIFO                                               │
│ - lifecycle/cancellation                                     │
│ - host-side validation                                       │
└──────────────────────┬───────────────────────┬───────────────┘
                       │                       │
                       ▼                       ▼
                Legacy owner         Multi-session owner
                   legacy              localSessionId
                       │                       │
                       └──────────────┬────────┘
                                      ▼
┌──────────────────────────────────────────────────────────────┐
│ src/features/acp-elicitation/webview.ts                      │
│ - form UI dùng chung                                         │
│ - validation UX                                              │
│ - Accept / Decline / Cancel                                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ feature.acp-elicitation.respond
                            ▼
                  Host validate lần cuối
                            │
                            ▼
                  CreateElicitationResponse
```

### 6.1. Quy tắc ownership

Mỗi `ACPClient` phải được bind với đúng owner ngay khi runtime được tạo:

| Runtime                  | Owner                           |
| ------------------------ | ------------------------------- |
| Legacy ACP client        | `legacy`                        |
| Multi-session ACP client | `ManagedSession.localSessionId` |

Cách này hỗ trợ cả request-scoped elicitation chưa có `sessionId`.

### 6.2. Phân chia trách nhiệm

`src/acp/client.ts` chỉ chịu trách nhiệm:

- đăng ký ACP request handler;
- quảng bá capability;
- chuyển request context đầy đủ;
- fallback `cancel` khi không có handler.

`src/features/acp-elicitation/` chịu trách nhiệm:

- normalize schema;
- queue và owner routing;
- lifecycle pending request;
- validation;
- form UI;
- response routing;
- multi-session snapshot;
- cancellation và cleanup.

## 7. Tổ chức feature

Tạo mới:

```text
src/features/acp-elicitation/
├── host.ts
├── webview.ts
├── types.ts
├── form-schema.ts
├── styles.ts
└── index.ts

src/test/features/acp-elicitation.test.ts
```

| File             | Trách nhiệm                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `types.ts`       | DTO an toàn cho browser và message contract `feature.acp-elicitation.*`; không import `vscode`. |
| `form-schema.ts` | Chuyển ACP schema thành model nội bộ và validate response; ưu tiên pure functions.              |
| `host.ts`        | Owner registry, pending request, response routing, cancellation, snapshot projection.           |
| `webview.ts`     | Render form, thu thập dữ liệu, báo lỗi, focus management, gửi response.                         |
| `styles.ts`      | CSS riêng của feature.                                                                          |
| `index.ts`       | Export public cần thiết, không trộn host và browser dependency.                                 |

Đăng ký qua:

- `src/features/register-host.ts`;
- `src/features/register-webview.ts`.

Core files chỉ thêm integration point nhỏ, ổn định.

## 8. DTO giữa host và webview

Không gửi raw `_meta`, custom payload hoặc toàn bộ ACP schema trực tiếp sang webview.

### 8.1. Form DTO

```ts
interface ElicitationFormView {
  interactionId: string;
  ownerId: string;
  message: string;
  title?: string;
  description?: string;
  toolCallId?: string;
  fields: ElicitationFieldView[];
  createdAt: number;
}
```

Field đã normalize:

```ts
type ElicitationFieldView =
  | TextFieldView
  | SingleSelectFieldView
  | MultiSelectFieldView
  | NumberFieldView
  | BooleanFieldView;
```

Mỗi field chứa:

- property key;
- label;
- description nếu có;
- required flag;
- default value hợp lệ;
- constraints cần thiết;
- danh sách options đã sanitize nếu có.

### 8.2. Response message

```ts
interface ElicitationRespondMessage {
  type: "feature.acp-elicitation.respond";
  ownerId: string;
  interactionId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}
```

Không dùng ACP JSON-RPC request ID làm ID public trong webview. Dùng `crypto.randomUUID()` để tạo `interactionId` nội bộ.

## 9. Mapping schema sang UI

| ACP schema                                 | UI                                                    |
| ------------------------------------------ | ----------------------------------------------------- |
| `string`                                   | Text input hoặc textarea                              |
| `string` + `enum`                          | Single-select                                         |
| `string` + `oneOf`                         | Single-select có title và description                 |
| `string`, format `email`                   | Email input                                           |
| `string`, format `uri`                     | URL text input; không tự mở URL                       |
| `string`, format `date`                    | Date input                                            |
| `string`, format `date-time`               | Datetime input; chuyển về định dạng hợp lệ khi submit |
| `number`                                   | Number input                                          |
| `integer`                                  | Number input kèm integer validation                   |
| `boolean`                                  | Checkbox                                              |
| `array` với enum hoặc `anyOf` string items | Multi-select checkboxes                               |

Quy tắc render:

- dùng radio cho single-select có ít options;
- dùng listbox/select cho danh sách dài;
- dùng checkbox group cho multi-select;
- mọi text từ agent phải gán bằng `textContent`;
- không render agent content bằng `innerHTML`;
- custom field không nhận diện được phải fail closed.

Claude adapter hiện biểu diễn custom answer bằng field string riêng. Generic renderer sẽ xử lý được mà không cần biết payload đến từ Claude.

## 10. Schema compiler và validation

### 10.1. Dùng type guard của SDK

Ưu tiên các guard public:

- `CreateElicitationRequest.isForm()`;
- `ElicitationPropertySchema` guards;
- `MultiSelectItems` guards.

Không import private Zod module của SDK và không thêm dependency JSON Schema tổng quát.

### 10.2. Schema phải bị từ chối nếu

- field type không được hỗ trợ;
- `required` trỏ tới property không tồn tại;
- string field đồng thời có `enum` và `oneOf`;
- enum có giá trị trùng;
- default value không hợp lệ;
- `minimum > maximum`;
- `minLength > maxLength`;
- `minItems > maxItems`;
- multi-select items không phải string enum/`anyOf`;
- schema vượt resource limits;
- có `pattern` trong giai đoạn 1;
- mode là custom/unknown.

### 10.3. Giới hạn phòng vệ đề xuất

```ts
MAX_PENDING_PER_OWNER = 8;
MAX_FIELDS = 32;
MAX_OPTIONS_PER_FIELD = 100;
MAX_MESSAGE_CHARS = 8_000;
MAX_FIELD_LABEL_CHARS = 1_000;
MAX_STRING_ANSWER_CHARS = 16_000;
MAX_RESPONSE_BYTES = 64 * 1024;
```

Các giá trị có thể được điều chỉnh khi triển khai, nhưng phải có giới hạn rõ ràng trước khi quảng bá capability.

### 10.4. Validate hai lần

1. Webview validate để phản hồi UX ngay.
2. Extension Host validate lại vì webview message không đáng tin cậy.

Host phải kiểm tra:

- chỉ có property key đã khai báo;
- required property có mặt;
- đúng primitive type;
- array chỉ chứa string hợp lệ;
- enum membership;
- min/max length;
- min/max number;
- min/max selection count;
- integer là safe integer;
- optional field không có giá trị thì bỏ khỏi content, không gửi `null`;
- tổng response không vượt giới hạn.

Nếu dữ liệu sai, không resolve ACP request. Host trả field errors về webview để user sửa.

## 11. Host coordinator

API dự kiến:

```ts
interface AcpElicitationHostFeature {
  createOwner(options: {
    ownerId: string;
    postState: (state: ElicitationOwnerState) => void;
    onPendingChanged: () => void;
  }): AcpElicitationOwner;

  handleMessage(message: unknown): Promise<boolean>;
  dispose(): void;
}

interface AcpElicitationOwner {
  handleRequest(
    context: ElicitationRequestContext
  ): Promise<CreateElicitationResponse>;
  getPendingViews(): ElicitationFormView[];
  cancelAll(): void;
  dispose(): void;
}
```

Pending record:

```ts
interface PendingElicitation {
  interactionId: string;
  ownerId: string;
  params: CreateElicitationRequest;
  normalizedForm: NormalizedElicitationForm;
  createdAt: number;
  state: "pending" | "resolving" | "resolved" | "aborted";
  resolve: (response: CreateElicitationResponse) => void;
  reject: (error: unknown) => void;
  abortCleanup: () => void;
}
```

Quy tắc:

- mỗi request chỉ được settle đúng một lần;
- response trùng bị bỏ qua;
- owner không khớp bị từ chối;
- interaction ID không tồn tại bị bỏ qua và log không chứa answer values;
- chỉ render request pending cũ nhất;
- các request tiếp theo xếp FIFO;
- toàn bộ pending content chỉ tồn tại trong memory.

## 12. Thay đổi tại `ACPClient`

Chỉ sửa tối thiểu trong `src/acp/client.ts`.

### 12.1. Callback mới

```ts
type ElicitationCallback = (context: {
  params: CreateElicitationRequest;
  requestId: JsonRpcId;
  signal: AbortSignal;
}) => Promise<CreateElicitationResponse>;
```

Dùng một handler duy nhất, không dùng listener set, vì mỗi inbound request phải có đúng một owner trả lời.

### 12.2. Đăng ký request handler

```ts
.onRequest(acp.methods.client.elicitation.create, (ctx) =>
  this.handleCreateElicitation(ctx)
)
```

Fallback:

```ts
{
  action: "cancel";
}
```

### 12.3. Quảng bá capability có điều kiện

Handler phải được bind trước `connect()`:

```ts
clientCapabilities: {
  fs: { ... },
  terminal: true,
  elicitation: this.elicitationHandler
    ? { form: {} }
    : undefined,
}
```

Không quảng bá `url` trong giai đoạn 1.

### 12.4. Giữ cancellation context

Không chỉ chuyển `ctx.params`. Phải chuyển cả:

- `ctx.requestId`;
- `ctx.signal`.

Khi agent gửi `$/cancel_request`, UI pending phải được gỡ và request không được hiểu nhầm là user decline.

## 13. Tích hợp legacy

Trong `ChatViewProvider`:

1. Tạo owner `legacy` từ feature dùng chung.
2. Bind `acpClient.setOnElicitationRequest(...)` trước khi auto-connect.
3. Route `feature.acp-elicitation.respond` qua feature trước core switch.
4. Post owner state sang webview khi pending queue thay đổi.
5. Cancel pending request khi:
   - user Stop;
   - tạo chat mới và dispose runtime cũ;
   - đổi agent và dispose runtime cũ;
   - provider dispose;
   - connection error hoặc disconnect.

Không thêm elicitation queue riêng trực tiếp vào `ChatViewProvider`.

## 14. Tích hợp multi-session

### 14.1. Session state

Mỗi `ManagedSession` có owner trong feature dùng chung hoặc tham chiếu đến owner được quản lý tập trung bằng `localSessionId`.

Thêm vào list item:

```ts
pendingElicitationCount: number;
```

Thêm status:

```ts
"awaiting_input";
```

Thêm aggregate:

```ts
awaitingInput: number;
```

Ưu tiên status:

```text
error
  > awaiting_input
  > awaiting_permission
  > running / loading / cancelling
  > idle / draft
```

Nếu permission và elicitation cùng pending, UI phải hiển thị cả hai badge. Không tự resolve loại nào.

### 14.2. Active session

Khi active session nhận elicitation:

- render form ngay;
- giữ nguyên composer draft;
- tiếp tục cho phép Stop;
- không thay đổi `isGenerating` chỉ để hiện form;
- không đưa form vào transcript;
- không đưa answer vào transcript hoặc persisted state.

### 14.3. Background session

Khi background session nhận elicitation:

- queue đúng owner session;
- không tự chuyển session;
- không mở modal đè lên session đang đọc;
- Session Manager hiện `Needs input`;
- thêm action `Review input`;
- chỉ activate/focus session khi user chọn Review.

### 14.4. Snapshot

Mở rộng active snapshot:

```ts
pendingElicitations?: ElicitationFormView[]
```

Không append elicitation vào transcript. Pending state chỉ có một nguồn là `pendingElicitations`.

Thứ tự `applySnapshot()`:

1. gỡ elicitation UI của session cũ;
2. replay transcript;
3. apply metadata, context và diff;
4. replace elicitation state từ `pendingElicitations`;
5. restore composer draft và scroll state.

Cách này tránh render trùng khi snapshot replay.

### 14.5. Session Manager

Bổ sung:

- badge `N input`;
- action `Review input`;
- filter `awaiting_input`;
- aggregate `Input N` hoặc tổng waiting có phân loại rõ ràng.

Action Review chỉ activate đúng owner session và focus chat. Không gửi answer thay user.

## 15. Webview UX

Dùng một panel riêng phía trên composer, ngoài transcript:

```text
┌──────────────────────────────────────────────────────┐
│ Input required                              1 of 1  │
│ Which environment should I target?                  │
│                                                      │
│ ( ) Development                                      │
│ ( ) Staging                                          │
│ ( ) Production                                       │
│ [Optional custom answer............................] │
│                                                      │
│ [Cancel] [Decline]                         [Submit]  │
└──────────────────────────────────────────────────────┘
│ Composer draft vẫn được giữ nguyên                    │
```

Quy tắc UX:

- `Submit` chỉ gửi khi host có thể validate thành công;
- field lỗi đầu tiên được focus;
- error summary dùng `aria-live`;
- `Decline` và `Cancel` là hai hành động khác nhau;
- Enter trong multiline text không tự submit;
- Escape chỉ cancel khi focus nằm trong elicitation panel và không có popup con đang mở;
- submit thành công gỡ form và restore focus hợp lý;
- không gọi permission dialog hoặc dùng `setGenerating(true)`;
- không làm sai message queue processing state;
- Stop button vẫn khả dụng.

Accessibility:

- label gắn đúng input qua `for`;
- option group dùng `fieldset` và `legend`;
- help/error text nối bằng `aria-describedby`;
- required state được thông báo;
- keyboard thao tác được toàn bộ;
- responsive trong sidebar hẹp và font size lớn.

## 16. Cancellation và error semantics

| Sự kiện                         | Kết quả                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| User submit form hợp lệ         | `{ action: "accept", content }`                                     |
| User chủ động từ chối           | `{ action: "decline" }`                                             |
| User đóng/hủy form              | `{ action: "cancel" }`                                              |
| User Stop session               | Cancel toàn bộ elicitation của owner session                        |
| Đóng/dispose session            | Cancel toàn bộ elicitation của owner session                        |
| Dispose extension/provider      | Cancel pending request khi transport còn khả dụng                   |
| Agent gửi JSON-RPC cancellation | Gỡ UI, settle theo request cancellation; không báo là user decline  |
| Connection mất                  | Xóa local pending state; không đảm bảo gửi được response            |
| Schema invalid/unsupported      | Fail closed bằng `cancel`, hiển thị lỗi không chứa dữ liệu nhạy cảm |
| Mode unknown/custom             | Không render, trả `cancel`                                          |

Không đặt timeout 60 giây trong giai đoạn 1. Background elicitation có thể cần user quay lại sau một khoảng thời gian; timeout cố định dễ làm agent bị cancel ngoài ý muốn.

## 17. Security và privacy

- Xem mọi schema từ agent là untrusted input.
- Xem mọi message từ webview là untrusted input.
- Render text bằng `textContent`.
- Không log answer values.
- Không lưu answer trong transcript.
- Không lưu answer trong `globalState`.
- Không lưu answer trong webview persisted state.
- Không gửi `_meta` sang webview.
- Không render unknown custom field.
- Không chạy `pattern` trong giai đoạn 1.
- Giới hạn số field, option, text length, response size và pending count.
- Giữ CSP hiện tại của webview.
- Dùng opaque `interactionId`.
- Validate owner và interaction trên mọi response.

## 18. Giai đoạn 2: URL elicitation

Chỉ quảng bá sau khi hoàn thành toàn bộ lifecycle:

```ts
elicitation: {
  form: {},
  url: {},
}
```

Yêu cầu:

- không tự mở URL;
- mặc định chỉ cho `https:`;
- có thể cho `http:` với loopback nếu có use case xác nhận;
- từ chối URL chứa username/password;
- từ chối `javascript:`, `command:`, `vscode:`, `data:`, `file:` và scheme không hỗ trợ;
- hiển thị origin rõ ràng;
- không log query string nhạy cảm;
- mở URL qua Extension Host;
- tái sử dụng và siết chặt validator của clickable resource links;
- correlation bằng `(ownerId, elicitationId)`;
- xử lý `elicitation/complete` idempotent;
- cleanup khi decline, cancel, complete, close hoặc disconnect.

## 19. Khả năng áp dụng cho các built-in agent

Feature này là **ACP capability dùng chung**. Agent nào đã phát standard `elicitation/create` sẽ tự sử dụng được sau khi extension quảng bá capability.

Đánh giá theo public source và adapter hiện tại tại thời điểm lập kế hoạch:

| Built-in agent      | Standard ACP elicitation                                              | Kết quả sau giai đoạn 1                                                                      |
| ------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Claude Code         | Đã xác nhận form và URL                                               | `AskUserQuestion` và form-based MCP elicitation hoạt động tự động; URL chờ giai đoạn 2.      |
| Codex CLI           | Đã xác nhận generic elicitation trong adapter hiện tại                | Form hoạt động tự động khi adapter phát request.                                             |
| Goose               | Đã xác nhận form elicitation                                          | Form hoạt động tự động khi agent yêu cầu input.                                              |
| Kimi CLI            | Có elicitation trên unstable ACP surface                              | Dự kiến hoạt động nếu schema tương thích SDK `1.2.1`; cần integration test.                  |
| Amp                 | Chưa xác nhận, phụ thuộc phiên bản                                    | Extension sẵn sàng nhận form nhưng cần test agent thực tế.                                   |
| Augment Code        | Chưa xác nhận, phụ thuộc phiên bản                                    | Extension sẵn sàng nhận form nhưng cần test agent thực tế.                                   |
| Mistral Vibe        | Chưa xác nhận, phụ thuộc phiên bản                                    | Extension sẵn sàng nhận form nhưng cần test agent thực tế.                                   |
| OpenHands           | Chưa xác nhận khi chạy như ACP agent                                  | Client capability chưa đảm bảo agent sẽ phát form.                                           |
| CodeBuddy Code      | Chưa xác nhận do implementation không công khai đầy đủ                | Có thể hoạt động nếu agent phát standard request.                                            |
| OpenCode            | Hiện dùng custom question extension                                   | Không tự hoạt động; cần upstream chuyển sang ACP elicitation hoặc adapter bridge.            |
| Gemini CLI          | Hiện dùng custom `gemini/requestUserInput`                            | Không tự hoạt động; cần custom compatibility hoặc upstream migration.                        |
| Cursor              | Hiện dùng custom question method                                      | Không tự hoạt động; cần custom compatibility hoặc upstream migration.                        |
| Aider               | Chưa xác nhận standard elicitation                                    | Không có hiệu lực tự động.                                                                   |
| Qwen Code           | SDK/version mới có nhắc elicitation nhưng agent-side emission chưa rõ | Không đảm bảo tự hoạt động; cần test theo phiên bản.                                         |
| Kiro CLI            | Chưa xác nhận standard elicitation                                    | Không có hiệu lực tự động.                                                                   |
| Bundled Pi          | `select/confirm` đang đi qua permission; `input/editor` bị cancel     | Không tự hoạt động, nhưng có thể sửa adapter trong repo để chuyển sang standard elicitation. |
| Bundled Antigravity | Chưa có elicitation bridge                                            | Không tự hoạt động.                                                                          |
| Bundled Swarm       | Hiện chỉ proxy permission                                             | Cần bổ sung proxy elicitation và worker correlation.                                         |

### 19.1. Kết luận áp dụng

```text
Extension hỗ trợ ACP elicitation chung
  ├─ Agent đã dùng elicitation/create → hoạt động tự động
  ├─ Agent chưa phát elicitation       → chưa có thay đổi hành vi
  └─ Agent dùng custom method          → cần adapter/compatibility riêng
```

Không thêm custom agent method vào feature generic. Mỗi compatibility bridge, nếu cần, phải nằm trong feature/adapter của chính agent đó rồi chuyển về standard ACP elicitation.

## 20. Follow-up cho bundled adapter

### 20.1. Bundled Pi

Sau khi generic feature hoàn thành, chuyển Pi UI request:

```text
Pi extension_ui_request
  ├─ select
  ├─ confirm
  ├─ input
  └─ editor
       ↓
ACP elicitation/create
       ↓
Generic VS Code form
       ↓
Pi extension_ui_response
```

Lợi ích:

- `select/confirm` không còn bị giả lập bằng permission;
- `input/editor` không còn bị cancel;
- đúng semantics giữa permission và user input;
- dùng chung UI/validation với các agent khác.

Phần này là follow-up riêng trong `src/features/pi-agent/`, không đưa Pi-specific mapping vào `src/features/acp-elicitation/`.

### 20.2. Bundled Swarm

Bổ sung proxy:

```text
Worker elicitation/create
  → Swarm capability proxy
  → Root ACP client
  → Generic elicitation feature
  → User response
  → đúng worker session
```

Yêu cầu:

- correlation theo worker session;
- giữ workflow/step/role context ở adapter/host;
- response không được trả nhầm worker;
- close/stop worker phải cleanup pending request;
- metadata Swarm không được làm generic webview phụ thuộc Swarm.

## 21. Các task triển khai

### Task 1 — Thêm protocol seam vào `ACPClient`

Files:

- `src/acp/client.ts`
- test ACP client phù hợp

Thực hiện:

- thêm typed elicitation callback;
- đăng ký `elicitation/create`;
- chuyển `params`, `requestId`, `AbortSignal`;
- quảng bá `elicitation.form` có điều kiện;
- fallback `cancel`;
- test capability negotiation và dispatch.

Tiêu chí:

- mocked agent nhìn thấy form capability;
- request tới đúng callback;
- cancellation signal tới callback;
- không handler không bao giờ dẫn tới accept.

### Task 2 — Xây schema compiler và validator

Files:

- `src/features/acp-elicitation/form-schema.ts`
- `src/features/acp-elicitation/types.ts`
- `src/test/features/acp-elicitation.test.ts`

Thực hiện:

- normalize mọi field type được hỗ trợ;
- validate defaults và constraints;
- áp dụng resource limits;
- validate submitted content;
- sinh field-level errors.

Tiêu chí:

- schema hợp lệ normalize ổn định;
- schema invalid/custom/oversized bị cancel;
- response bị sửa/tamper không resolve request.

### Task 3 — Xây host coordinator dùng chung

Files:

- `src/features/acp-elicitation/host.ts`
- `src/features/acp-elicitation/index.ts`
- `src/features/register-host.ts`

Thực hiện:

- owner registry;
- pending FIFO;
- response routing;
- abort handling;
- cancel/dispose;
- snapshot DTO.

Tiêu chí:

- mỗi request settle đúng một lần;
- owner sai và duplicate response bị từ chối;
- không log hoặc persist answer values.

### Task 4 — Xây webview form UI dùng chung

Files:

- `src/features/acp-elicitation/webview.ts`
- `src/features/acp-elicitation/styles.ts`
- `src/features/register-webview.ts`
- integration nhỏ trong `src/views/webview/main.ts` nếu cần

Thực hiện:

- render form từ normalized DTO;
- validation UX;
- Submit/Decline/Cancel;
- focus management;
- accessibility;
- replace state khi switch session;
- inject feature-local styles.

Tiêu chí:

- thao tác hoàn toàn bằng keyboard;
- label/error accessibility đúng;
- composer draft không mất;
- không làm sai `isGenerating` và message queue.

### Task 5 — Bind legacy flow

Files:

- `src/views/chat.ts`
- legacy tests

Thực hiện:

- tạo owner `legacy`;
- bind trước connect;
- dispatch response qua feature;
- cancel khi Stop/dispose/runtime replacement;
- gỡ UI khi request settle.

Tiêu chí:

- form chặn và tiếp tục đúng cùng turn;
- Stop/New Chat/agent switch/dispose không để promise pending.

### Task 6 — Bind multi-session và Session Manager

Files:

- `src/features/multi-session/host.ts`
- `src/features/multi-session/contracts.ts`
- `src/features/multi-session/webview.ts`
- `src/features/multi-session/manager-webview.ts`
- `src/features/multi-session/manager-styles.ts` nếu cần
- `src/test/features/multi-session.test.ts`

Thực hiện:

- owner theo `localSessionId`;
- status `awaiting_input`;
- pending count và aggregate;
- active session render ngay;
- background session không cướp focus;
- snapshot `pendingElicitations`;
- Review input action;
- cancel khi Stop/close/dispose.

Tiêu chí:

- background form không xuất hiện trong session khác;
- Review mở đúng owner;
- response về đúng ACP runtime;
- snapshot chỉ render mỗi pending form một lần.

### Task 7 — Smoke test agent thực tế

Claude Code prompt:

```text
Before doing anything, use AskUserQuestion.
Ask exactly one single-choice question:
"Which environment should I target?"
Options: Development, Staging, Production.
Do not continue until the tool returns an answer.
After receiving the answer, repeat the selected value.
```

Kỳ vọng:

- extension hiện form;
- user chọn `Staging`;
- không dùng permission dialog;
- Claude tiếp tục trong cùng turn;
- Claude trả lại `Staging`.

Test thêm:

- Claude multi-select và custom text;
- background Claude session;
- decline và cancel;
- Codex, Goose, Kimi nếu đã cài và authenticated;
- fixture request-scoped trước `session/new`.

### Task 8 — Tài liệu, build, package và cài extension

Cập nhật sau implementation:

- `docs/features/feature-catalog.md`;
- `docs/architecture/acp-chat-layout.md`;
- trạng thái và completion notes trong plan này;
- `README.md` nếu cần cập nhật feature user-facing.

Verification:

```bash
npm run check-types
npx eslint <changed-typescript-files>
npm run compile-tests
# chạy focused tests trước, sau đó relevant/full suite
npm run package
npx vsce package --out .tmp/vscode-acp-chat-elicitation.vsix
code --install-extension .tmp/vscode-acp-chat-elicitation.vsix --force
```

Sau khi cài:

- xóa VSIX tạm nếu an toàn;
- chạy `Developer: Reload Window`;
- thực hiện smoke test agent thực tế.

## 22. Test matrix

### 22.1. Protocol

- Không có handler thì không quảng bá capability.
- Có handler thì quảng bá `form: {}`.
- Request handler nhận đủ params, request ID và signal.
- Custom mode trả cancel.
- Agent cancellation gỡ pending UI.

### 22.2. Schema

- Required và optional text.
- Enum và titled `oneOf`.
- Multi-select enum và titled `anyOf`.
- Number boundaries.
- Safe integer validation.
- Boolean default.
- Email, URI, date, date-time.
- Invalid default.
- Duplicate enum values.
- Contradictory ranges.
- Unknown property type.
- Unsupported pattern.
- Resource limits.

### 22.3. Response

- Accept với content hợp lệ.
- Decline không có content.
- Cancel không có content.
- Duplicate response.
- Sai owner.
- Sai field type.
- Chèn extra property.
- Oversized payload.

### 22.4. Lifecycle

- Active legacy request.
- Legacy Stop/dispose.
- Active multi-session request.
- Background multi-session request.
- Activate và snapshot replay.
- Nhiều request FIFO.
- Session close/dispose.
- Connection loss.
- Request trước khi ACP session được tạo.

### 22.5. Webview và accessibility

- Label và help text association.
- Required state.
- Error summary và first-error focus.
- Keyboard selection.
- Escape cancel.
- Focus restoration.
- Font lớn và sidebar hẹp.
- Không có unsanitized HTML.

## 23. Rủi ro và giảm thiểu

| Rủi ro                                              | Tác động                                            | Giảm thiểu                                                                                   |
| --------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ACP elicitation còn unstable                        | SDK thay đổi làm lệch contract                      | Cô lập protocol trong `ACPClient` và `src/features/acp-elicitation/`; test theo SDK `1.2.1`. |
| Quảng bá capability trước khi UI sẵn sàng           | Agent gửi request nhưng extension không render được | Bind handler trước `connect()` và quảng bá có điều kiện.                                     |
| Background session chờ vô hạn nhưng user không biết | Agent bị block                                      | Badge `Needs input`, status `awaiting_input`, Review input action.                           |
| Webview response bị sửa                             | Dữ liệu sai tới agent                               | Host-side authoritative validation.                                                          |
| Lộ dữ liệu nhạy cảm                                 | Answer xuất hiện trong log/state                    | Không log, không persist, chỉ giữ memory.                                                    |
| Schema lớn làm treo UI                              | Extension/webview bị quá tải                        | Resource limits rõ ràng.                                                                     |
| Regex gây ReDoS                                     | Extension hoặc webview bị treo                      | Không hỗ trợ `pattern` trong giai đoạn 1.                                                    |
| Elicitation làm sai message queue                   | Composer/Stop hoạt động sai                         | State riêng, không dùng `isGenerating` để điều khiển form.                                   |
| Agent cần URL mode                                  | Auth flow chưa hoạt động ở giai đoạn 1              | Không quảng bá URL cho đến giai đoạn 2.                                                      |
| Vendor custom method bị trộn vào generic feature    | Kiến trúc phụ thuộc agent                           | Compatibility bridge phải nằm trong feature/adapter riêng của agent.                         |

## 24. Definition of done

Giai đoạn 1 hoàn tất khi:

- capability `clientCapabilities.elicitation.form` chỉ được quảng bá khi feature đầy đủ đã bind;
- Claude Code `AskUserQuestion` hoạt động trong cùng turn;
- các field type được hỗ trợ render và validate đúng;
- `accept`, `decline`, `cancel` và agent abort có semantics riêng;
- legacy và multi-session đều hoạt động;
- background request hiển thị và review được mà không cướp focus;
- Stop/close/dispose không để pending request;
- answer values không bị log hoặc persist;
- focused và relevant tests pass;
- production build, VSIX package và forced local installation thành công;
- `docs/features/feature-catalog.md` và `docs/architecture/acp-chat-layout.md` phản ánh đúng implementation.

## 25. Completion notes

Hoàn thành ngày 2026-07-16:

- thêm protocol seam `elicitation/create`, truyền `params` / JSON-RPC request ID / `AbortSignal`, và chỉ quảng bá `elicitation.form` khi handler đã bind;
- thêm feature dùng chung `src/features/acp-elicitation/` với schema compiler, resource limits, host-side validation, owner registry, FIFO, cancellation, accessible webview form và response `accept` / `decline` / `cancel`;
- bind legacy owner `legacy` và multi-session owner theo `localSessionId`;
- thêm background status `awaiting_input`, pending count, aggregate `awaitingInput`, Session Manager badge/filter/`Review input`, và snapshot `pendingElicitations`;
- thêm test protocol, schema, tamper/lifecycle, webview accessibility/focus, background routing, Stop cancellation và manager action;
- cập nhật `docs/features/feature-catalog.md` và `docs/architecture/acp-chat-layout.md`;
- `npm run check-types`, targeted ESLint, `npm run compile-tests`, focused/relevant VS Code tests, `npm run package`, VSIX package và forced local installation đều thành công.

Chưa thực hiện trong môi trường agent tự động:

- smoke test Claude Code `AskUserQuestion` và các agent thực tế khác; cần chạy sau `Developer: Reload Window` với agent đã authenticated;
- URL elicitation, Pi compatibility bridge và Swarm worker proxy vẫn là phase/follow-up riêng.

## 26. Thứ tự triển khai khuyến nghị

```text
1. ACPClient protocol seam
2. Pure schema compiler/validator
3. Host coordinator dùng chung
4. Webview form UI dùng chung
5. Legacy integration
6. Multi-session/background integration
7. Claude Code smoke test
8. Codex/Goose/Kimi smoke test nếu có môi trường
9. Docs, build, VSIX package, install
10. URL elicitation ở phase riêng
11. Pi adapter bridge
12. Swarm worker elicitation proxy
```
