# Implement clickable chat resource links

Status: Implemented 2026-07-14.

Completion notes:

- Added `src/features/clickable-resource-links/` with pure detection, webview DOM decoration, external URL host handling, and tests.
- Auto-detected file links post `openFile` with `checkExists: true`; web links post `feature.clickable-resource-links.openExternal` and are opened through the host with `http:`/`https:` validation.
- Updated feature catalog and kept core integration limited to feature registration, host message dispatch, and existing file-link click handling.

## Mục tiêu

Nhận diện và biến các đường dẫn trong transcript ACP Chat thành link có thể click, bao gồm:

- File path trong workspace hoặc absolute path, ví dụ `docs/plans/README.md`, `src/views/chat.ts:471`, `/tmp/output.log`, `file:///home/user/project/src/a.ts#L10-L20`.
- Web URL, ví dụ `https://example.com`, `http://localhost:3000`, `www.example.com`.
- Các path/URL đang được assistant render dưới dạng inline code, ví dụ `` `docs/plans/README.md` ``, thay vì chỉ là `<code>` không click được.

Kết quả mong muốn:

- Click file path mở file trong VS Code editor hoặc reveal folder trong Explorer, tái sử dụng luồng `openFile` hiện có.
- Click web URL mở external browser qua Extension Host, không điều hướng iframe webview.
- Không linkify nội dung trong fenced code block, tool output/raw terminal output, mention chip, command chip, button, hoặc link Markdown đã có.
- Giảm false positive với identifier dạng `configOptions.thought_level`, package name, domain-like text không phải URL, và các đoạn code ngắn.

## Phân tích hiện trạng

### Render assistant message

```text
ACP agent
  │ session update / streamed text
  ▼
ChatViewProvider
  │ postMessage({ type: "streamChunk", text })
  ▼
WebviewController
  │ MessageRouter
  ▼
MessageListComponent.handleStreamChunk()
  │ BlockManager.ensureBlock("text")
  ▼
TextBlock.appendContent()
  │ rawContent += chunk
  │ marked.parse(rawContent)
  │ contentEl.innerHTML = rendered HTML
  │ eventBus.emit("markdownRendered", { root, kind: "text" })
  ▼
Rendered Markdown DOM
```

Các điểm chính:

- `src/views/webview/block/text-block.ts` render assistant text bằng `marked.parse(...)` rồi gán vào `innerHTML`.
- `src/views/webview/block/thought-block.ts` cũng render Markdown và phát `markdownRendered` với `kind: "thought"`.
- `src/views/webview/marked-config.ts` chỉ custom code block và table renderer; không linkify bare path/URL.
- `src/views/webview/component/message-list.ts` có `setupFileLinkHandler()` nhưng chỉ bắt click trên thẻ `<a>`.
- Markdown link như `[README](docs/plans/README.md)` đã thành `<a>` và click được qua handler hiện có.
- Inline code như `` `docs/plans/README.md` `` thành `<code>docs/plans/README.md</code>`, không phải `<a>`, nên không click được.
- Host `src/views/chat.ts` case `openFile` đã hỗ trợ `href`, relative path, absolute path, `file://`, `#L10-L20`, và suffix `:10-20`.
- External URL hiện không có host message riêng; `setupFileLinkHandler()` bỏ qua non-file scheme và để browser/webview default xử lý, không đủ rõ ràng/ổn định.

### Hook sẵn có

Feature `table-copy` đã dùng event `markdownRendered` để decorate DOM sau khi Markdown render. Đây là pattern phù hợp cho linkification vì:

- Markdown DOM bị replace lại trên mỗi streaming chunk, nên decorator phải chạy sau mỗi render.
- Không nên gắn listener trực tiếp vào từng link; dùng event delegation trên message container.
- Không cần can thiệp vào `marked` parser cho toàn bộ Markdown, tránh phá Markdown link/table/code hiện có.

## Quyết định kiến trúc

### Feature mới

Đặt logic product-specific dưới:

```text
src/features/clickable-resource-links/
├── host.ts
├── webview.ts
├── types.ts
└── index.ts

src/test/features/clickable-resource-links.test.ts
```

Trách nhiệm:

| File | Trách nhiệm |
| --- | --- |
| `types.ts` | Message contract, `ResourceLinkKind`, `DetectedResourceLink`, protocol allowlist. |
| `webview.ts` | Subscribe `markdownRendered`, scan DOM, detect path/URL, wrap thành `<a>`, handle external-link click. |
| `host.ts` | Handle external URL message bằng `vscode.env.openExternal` sau khi validate protocol. |
| `index.ts` | Optional public exports; không trộn host/browser import. |
| `src/features/register-webview.ts` | Register webview feature. |
| `src/features/register-host.ts` | Register host feature. |

### Core integration tối thiểu

| File | Thay đổi dự kiến |
| --- | --- |
| `src/views/webview/main.ts` | Không thêm logic linkification; chỉ feature được register qua `registerWebviewFeatures()` như các feature khác. |
| `src/views/chat.ts` | Thêm một integration point nhỏ để dispatch feature webview message trước switch core, ví dụ `features.clickableResourceLinks?.handleMessage(message)`. Giữ `openFile` core case cho file path. |
| `src/views/webview/component/message-list.ts` | Giữ `setupFileLinkHandler()` cho file links. Chỉ sửa nếu cần đổi tên/comment hoặc mở rộng type message nhỏ. |
| `src/views/webview/types.ts` | Không bắt buộc nếu feature tự khai báo message type; chỉ sửa nếu cần event payload/type chung. |

Không sửa `marked-config.ts` cho MVP. Linkify sau render bằng DOM decorator để giảm rủi ro với Markdown parser.

## Quyết định UX

### File links

- File link tự nhận diện dùng `href` là path gốc hoặc URL `file://` gốc.
- Click file link gửi message hiện có:

```ts
{
  type: "openFile",
  href: "docs/plans/README.md",
  checkExists: true
}
```

- `checkExists: true` dùng cho link auto-detected để tránh mở nhầm file mới do false positive.
- Markdown file link explicit hiện có vẫn giữ hành vi hiện tại. Có thể cân nhắc `checkExists` sau nếu cần nhất quán.
- Nếu path có line range (`:10`, `:10-20`, `#L10`, `#L10-L20`) thì giữ nguyên trong `href`; host `openFile` đã parse được.
- Nếu là directory, host `openFile` đã reveal trong Explorer.

### Web links

- Web URL auto-detected render thành `<a href="..." data-acp-resource-kind="web" target="_blank" rel="noopener noreferrer">`.
- Click URL không để iframe webview tự điều hướng; webview gửi feature message:

```ts
{
  type: "feature.clickable-resource-links.openExternal",
  url: "https://example.com"
}
```

- Host validate protocol allowlist rồi gọi `vscode.env.openExternal(vscode.Uri.parse(url))`.
- Allowlist MVP: `http:`, `https:`. Có thể thêm `mailto:` sau nếu có nhu cầu.
- Không mở các scheme nguy hiểm hoặc không mong muốn: `javascript:`, `command:`, `vscode:`, `data:`, `file:` trong external handler.

### Hiển thị

- Link auto-detected dùng class `acp-resource-link`.
- File link có thể thêm icon nhỏ `$(file)` bằng CSS/codicon nếu không gây nhiễu; MVP có thể chỉ dùng underline/color link của VS Code.
- Inline code chứa đúng một resource candidate được biến thành link có style khác biệt:

```html
<a class="acp-resource-link acp-inline-code-link" href="docs/plans/README.md"><code>docs/plans/README.md</code></a>
```

- Cách này vẫn giữ cảm giác monospace của path nhưng không còn là code inert.
- Link phải keyboard-focus được và có `title`/`aria-label` ngắn gọn, ví dụ `Open file docs/plans/README.md` hoặc `Open external link https://example.com`.

## Quy tắc nhận diện

### Thứ tự ưu tiên

1. Existing Markdown `<a>`: không wrap lại, chỉ external-click handler có thể intercept để mở bằng host.
2. `file://...`: file link.
3. `http://...`, `https://...`: web link.
4. `www.<domain>...`: web link, normalize href thành `https://www.<domain>...`.
5. File path có tín hiệu mạnh.
6. Không linkify nếu mơ hồ.

### Web URL candidate

MVP nhận diện:

- `https://example.com/path?q=1#hash`
- `http://localhost:3000/app`
- `http://127.0.0.1:8080/health`
- `www.example.com/docs`

Trim punctuation cuối token:

- `https://example.com/docs.` → link text/href không gồm dấu `.` cuối.
- `(https://example.com)` → link không gồm `)` nếu dấu này chỉ là punctuation bao quanh.

Không nhận diện:

- `example.com` không có scheme hoặc `www.` trong MVP, để tránh nhầm với file/package/identifier.
- `foo.bar` trong inline code.
- Unsupported schemes.

### File path candidate

MVP nhận diện path có ít nhất một trong các tín hiệu mạnh:

- Bắt đầu bằng `file://`.
- Absolute POSIX: `/home/user/project/src/a.ts`, `/tmp/output.log`.
- Windows absolute: `C:\Users\me\project\src\a.ts`, `C:/Users/me/project/src/a.ts`.
- Relative explicit: `./src/a.ts`, `../docs/a.md`.
- Relative workspace path có slash và segment file-like: `src/views/chat.ts`, `docs/plans/README.md`.
- Known root/config filename allowlist khi không có slash: `README.md`, `package.json`, `tsconfig.json`, `.gitignore`, `Dockerfile`.
- Optional line suffix: `:10`, `:10-20`, `#L10`, `#L10-L20`.

Không nhận diện:

- Identifier có dấu chấm nhưng không có slash: `configOptions.thought_level`, `foo.bar`, `object.property`.
- Package spec hoặc command fragment: `@scope/pkg`, `npm run package`.
- Email address trong MVP, trừ khi sau này thêm `mailto:`.
- Text trong fenced code block (`pre code`) hoặc terminal/tool output.

### Inline code handling

- Nếu `<code>` không nằm trong `<pre>` và toàn bộ text sau trim là đúng một URL/path candidate: replace/wrap cả inline code thành link.
- Nếu inline code chứa nhiều text như `open docs/plans/README.md now`, MVP không linkify bên trong để tránh phá semantic inline code. Có thể mở rộng ở phase sau.
- Nếu inline code là identifier mơ hồ như `configOptions.thought_level`, giữ nguyên `<code>`.

### False positive policy cho inline code

Inline code có thể chứa rất nhiều identifier/code token, nên **không được** coi mọi nội dung trong `<code>` là file path. Case `` `docs/plans/README.md` `` được xem là false-positive risk thấp vì đồng thời có nhiều tín hiệu mạnh:

- Có separator `/`, tức là path-like, không phải identifier một đoạn.
- Segment cuối là filename rõ ràng `README.md`.
- Extension `.md` thuộc nhóm file/document thường gặp.
- Toàn bộ inline code chỉ là một candidate path, không kèm câu lệnh hoặc mô tả khác.

Rule bắt buộc:

- Linkify inline code chỉ khi `trim(code.textContent)` là **exactly one** resource candidate.
- Không linkify một phần bên trong inline code dài hơn, ví dụ `` `open docs/plans/README.md now` ``.
- File candidate không có slash chỉ được phép nếu nằm trong root/config filename allowlist, ví dụ `README.md`, `package.json`, `Dockerfile`.
- Text có dấu chấm nhưng không có slash và không thuộc allowlist phải bị xem là mơ hồ, ví dụ `configOptions.thought_level`, `foo.bar`, `object.property`.
- Domain không có scheme/`www.` như `example.com` không được linkify trong MVP.
- Auto-detected file links phải gửi `checkExists: true` để host không tạo/mở nhầm file mới khi detection sai.

Ví dụ quyết định:

| Inline code | Kết quả | Lý do |
| --- | --- | --- |
| `docs/plans/README.md` | Link file | Có slash + filename + extension; exact candidate. |
| `src/views/chat.ts:471` | Link file | Workspace path + line suffix hợp lệ. |
| `./README.md` | Link file | Relative explicit. |
| `README.md` | Link file | Root filename allowlist. |
| `package.json` | Link file | Root/config filename allowlist. |
| `https://example.com/docs` | Link web | Scheme rõ ràng. |
| `www.example.com/docs` | Link web | `www.` rõ ràng, normalize sang `https://`. |
| `configOptions.thought_level` | Không link | Identifier/property path, không có slash, không thuộc allowlist. |
| `foo.bar` | Không link | Mơ hồ giữa symbol/package/domain. |
| `example.com` | Không link | Domain bare không scheme/`www.` để tránh false positive. |
| `open docs/plans/README.md now` | Không link | Inline code không phải exact single candidate. |

### Bare text node handling

- Dùng `TreeWalker` scan text node trong assistant `.block-text` root.
- Skip node nếu ancestor match:
  - `a`
  - `pre`
  - `button`
  - `textarea`
  - `.mention-chip`
  - `.command-chip`
  - `.code-block-wrapper`
  - `.table-copy-wrapper`
  - `.tool-item`
- Với mỗi text node, tokenize URL/path candidates, split text node thành text/link/text bằng `DocumentFragment`.
- Set `data-acp-linkified="true"` trên anchor để debug/idempotence.

## Message contract

### Webview → Host: open external URL

```ts
interface OpenExternalResourceLinkMessage {
  type: "feature.clickable-resource-links.openExternal";
  url: string;
}
```

Host behavior:

1. Parse URL bằng `new URL(url)`.
2. Reject nếu protocol không nằm trong allowlist.
3. Gọi `vscode.env.openExternal(vscode.Uri.parse(url))`.
4. Nếu lỗi, log debug và show error ngắn: `Unable to open external link`.

### Webview → Host: open file

Tái sử dụng message hiện tại:

```ts
interface OpenFileMessage {
  type: "openFile";
  href: string;
  checkExists?: boolean;
}
```

Không tạo message file mới trong MVP để tránh duplicate host logic.

## Danh sách task

### Phase 1: Detection utility

#### Task 1: Tạo pure detection/parser module

**Mô tả:** Tạo utility trong feature để nhận diện URL/file path từ string, trả về candidate có `kind`, `text`, `href`, `start`, `end`, `lineRangeText?`.

**Acceptance criteria:**

- [ ] Detect `https://...`, `http://...`, `www....`.
- [ ] Detect `file://...`, absolute path, relative workspace path, root config filenames allowlist.
- [ ] Preserve line suffix `:10`, `:10-20`, `#L10`, `#L10-L20`.
- [ ] Trim punctuation cuối token nhưng không trim phần hợp lệ của URL/path.
- [ ] Không detect `configOptions.thought_level`, `foo.bar`, `example.com` không scheme/`www.`.
- [ ] Utility không phụ thuộc DOM để dễ unit test.

**Verification:**

- [ ] Unit tests cho URL/path positive cases.
- [ ] Unit tests cho false positive cases.
- [ ] `npm run check-types`.

**Files likely touched:**

- `src/features/clickable-resource-links/types.ts`
- `src/features/clickable-resource-links/webview.ts` hoặc `detector.ts` nếu tách nhỏ
- `src/test/features/clickable-resource-links.test.ts`

### Phase 2: Webview DOM decorator

#### Task 2: Linkify inline code resource candidates

**Mô tả:** Subscribe `markdownRendered`, chỉ xử lý `kind === "text"`, tìm `code:not(pre code)` chứa đúng một candidate và wrap thành anchor.

**Acceptance criteria:**

- [ ] `` `docs/plans/README.md` `` render thành clickable file link.
- [ ] `` `https://example.com` `` render thành clickable web link.
- [ ] `` `configOptions.thought_level` `` vẫn là inline code inert.
- [ ] Fenced code block không bị thay đổi.
- [ ] Decorator chạy được sau nhiều streaming chunk do DOM bị replace.

**Verification:**

- [ ] JSDOM test tạo Markdown bằng `marked.parse()` rồi emit `markdownRendered`.
- [ ] Click inline file link posts `{ type: "openFile", href, checkExists: true }` hoặc được handler hiện có nhận đúng.
- [ ] Click inline web link posts `feature.clickable-resource-links.openExternal`.

**Files likely touched:**

- `src/features/clickable-resource-links/webview.ts`
- `src/features/register-webview.ts`
- `src/test/features/clickable-resource-links.test.ts`

#### Task 3: Linkify bare text nodes

**Mô tả:** Scan text nodes ngoài link/code block và wrap URL/path candidates thành anchors.

**Acceptance criteria:**

- [ ] `Files: docs/plans/README.md` render path thành link.
- [ ] `See https://example.com/docs.` render URL link không gồm dấu `.` cuối.
- [ ] Markdown link explicit không bị nested anchor.
- [ ] Code blocks, buttons, chips, table controls, tool blocks không bị scan.
- [ ] Multiple candidates trong cùng text node đều được wrap đúng.

**Verification:**

- [ ] JSDOM tests cho text node split.
- [ ] Regression test không tạo nested anchors.
- [ ] Regression test không linkify trong `pre code`.

**Files likely touched:**

- `src/features/clickable-resource-links/webview.ts`
- `src/test/features/clickable-resource-links.test.ts`

#### Task 4: External link click delegation

**Mô tả:** Webview feature bắt click external anchors bằng capture listener trên messages container, prevent default, gửi host message.

**Acceptance criteria:**

- [ ] Auto-detected `https://...` click gửi `feature.clickable-resource-links.openExternal`.
- [ ] Existing Markdown external link `[site](https://example.com)` cũng mở qua host.
- [ ] File links vẫn do `setupFileLinkHandler()` xử lý và gửi `openFile`.
- [ ] Anchor `#local` vẫn giữ hành vi hiện tại hoặc bị bỏ qua như hiện tại.
- [ ] Unsupported scheme không được mở.

**Verification:**

- [ ] Extend `src/test/webview.test.ts` hoặc feature test với fake VS Code API messages.
- [ ] Existing tests `Clicking a file:// link posts an openFile message` vẫn pass.

**Files likely touched:**

- `src/features/clickable-resource-links/webview.ts`
- `src/test/features/clickable-resource-links.test.ts`
- Có thể `src/test/webview.test.ts`

### Phase 3: Host external URL handling

#### Task 5: Tạo host feature handler

**Mô tả:** Thêm `host.ts` xử lý `feature.clickable-resource-links.openExternal` và validate URL/protocol.

**Acceptance criteria:**

- [ ] `http:` và `https:` được mở bằng `vscode.env.openExternal`.
- [ ] `javascript:`, `command:`, `vscode:`, `data:`, `file:` bị reject trong external handler.
- [ ] Invalid URL không throw ra message loop.
- [ ] Host handler không đụng vào `openFile` flow hiện có.

**Verification:**

- [ ] Unit tests hoặc host tests mock `vscode.env.openExternal`.
- [ ] `npm run check-types`.

**Files likely touched:**

- `src/features/clickable-resource-links/host.ts`
- `src/features/clickable-resource-links/types.ts`
- `src/features/register-host.ts`
- `src/views/chat.ts` với dispatch integration tối thiểu
- `src/test/features/clickable-resource-links.test.ts` hoặc `src/test/chat.test.ts`

### Phase 4: Styling and accessibility

#### Task 6: Style auto-detected resource links

**Mô tả:** Thêm CSS cho `acp-resource-link` và `acp-inline-code-link` theo theme VS Code.

**Acceptance criteria:**

- [ ] Link dùng màu `--vscode-textLink-foreground` hoặc token tương đương.
- [ ] Hover/focus có underline/outline rõ ràng.
- [ ] Inline code link không làm vỡ line height hoặc code style hiện tại.
- [ ] Long paths wrap hợp lý trong sidebar.
- [ ] Keyboard focus visible.

**Verification:**

- [ ] Manual check ở narrow sidebar.
- [ ] Manual check dark/light theme nếu có thể.

**Files likely touched:**

- `media/main.css`

### Phase 5: Regression coverage and release verification

#### Task 7: Test matrix

**Acceptance criteria:**

- [ ] Inline code file path clickable.
- [ ] Inline code web URL clickable.
- [ ] Bare file path clickable.
- [ ] Bare web URL clickable.
- [ ] Existing Markdown file link still clickable.
- [ ] Existing Markdown external link opens via host.
- [ ] `configOptions.thought_level` not linkified.
- [ ] Fenced code block not linkified.
- [ ] Tool output/raw terminal output not linkified unless explicitly opted in later.
- [ ] Line range suffix preserved and host selection still works.
- [ ] Unsupported protocols rejected.

**Verification commands:**

```bash
npm run check-types
npm run compile-tests
npm test -- --grep "resource links"
npm test -- --grep "openFile"
npm run package
```

Nếu `--grep` không được test runner hỗ trợ, chạy `npm test`.

#### Task 8: Package and install extension

Vì thay đổi extension/webview code, sau khi implementation xong phải build/package/install theo rule repo:

```bash
npm run check-types
npm run compile-tests
npm run package
npx vsce package --out .tmp/vscode-acp-chat-clickable-resource-links.vsix
code --install-extension .tmp/vscode-acp-chat-clickable-resource-links.vsix --force
```

Sau khi install thành công, nhắc người dùng chạy `Developer: Reload Window`.

## Rủi ro và giảm thiểu

| Rủi ro | Tác động | Giảm thiểu |
| --- | --- | --- |
| False positive biến identifier thành file link | UX nhiễu, click lỗi | Chỉ linkify path có tín hiệu mạnh; test `configOptions.thought_level`, `foo.bar`. |
| Linkify phá code block hoặc tool output | Làm sai nội dung kỹ thuật | Skip ancestor `pre`, `.code-block-wrapper`, `.tool-item`, terminal/tool containers. |
| Streaming replace DOM liên tục | Link mất hoặc listener duplicate | Decorate trên `markdownRendered`, dùng event delegation một lần. |
| External link điều hướng iframe webview | Mất trạng thái chat hoặc bị CSP chặn | Capture click và route qua `vscode.env.openExternal`. |
| URL/path có punctuation cuối | Link mở sai | Tokenizer trim punctuation bao quanh/cuối token. |
| Path có space | Regex bare text khó chính xác | MVP hỗ trợ tốt trong inline code exact; bare text có space để phase sau hoặc Markdown link explicit. |
| Security scheme injection | Mở command/protocol nguy hiểm | Host allowlist protocol; reject unsupported schemes. |

## Ngoài phạm vi MVP

- Workspace-wide prevalidation/link existence highlighting trước khi click.
- Fuzzy file resolution khi assistant chỉ ghi `chat.ts` mà không có path.
- Linkify package names, symbols, issue IDs, Jira IDs.
- Rich hover preview hoặc peek file.
- Linkify bên trong fenced code block.
- Linkify non-HTTP schemes ngoài allowlist.

## Definition of Done

- Assistant output tự động biến high-confidence file paths và web URLs thành clickable links.
- Inline code chỉ chứa file path/web URL trở thành clickable link.
- File links mở bằng editor/reveal folder qua `openFile` hiện có.
- Web links mở external browser qua host feature với protocol validation.
- False positives chính được test và không bị linkify.
- Typecheck, compile tests, relevant tests, production package pass.
- VSIX được package và install local trước khi báo hoàn tất implementation.
