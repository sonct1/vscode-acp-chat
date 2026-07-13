# Implement table copy controls

## Mục tiêu

Bổ sung nút copy ở góc trên bên phải của từng bảng Markdown trong câu trả lời assistant. Người dùng có thể chọn một trong ba định dạng:

1. **Markdown** — copy đúng GFM table source mà agent trả về.
2. **HTML** — copy bảng dưới dạng HTML semantic, ưu tiên hỗ trợ rich paste và có `text/plain` fallback.
3. **Displayed text** — copy nội dung đang hiển thị trên UI dưới dạng tab/newline để dán vào terminal, editor hoặc spreadsheet.

Không thay đổi nút **Copy response** hiện tại và không cần Extension Host cho luồng clipboard chính.

## Phân tích hiện trạng

### Luồng render

```text
ACP agent
  │ session update / streamed text
  ▼
ChatViewProvider (Extension Host)
  │ webview.postMessage({ type: "streamChunk", text })
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
  ▼
Marked GFM table HTML
  └─ <table><thead>...<tbody>...</table>
```

Các điểm chính:

- `src/views/webview/marked-config.ts` cấu hình `marked` với `gfm: true`, nên pipe-table được parse thành `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>` và `<td>`.
- `src/views/webview/block/text-block.ts` render lại **toàn bộ** `rawContent` bằng `marked.parse()` trên mỗi streaming chunk. Vì gán lại `innerHTML`, mọi DOM state hoặc listener gắn trực tiếp vào bảng sẽ bị phá và tạo lại trong lúc stream.
- `src/views/webview/block/thought-block.ts` dùng cùng pipeline Markdown. Scope đề xuất mặc định chỉ áp dụng cho `.block-text` của câu trả lời assistant, không áp dụng cho thought nội bộ.
- `src/views/webview/component/message-list.ts` đang dùng event delegation cho `.code-copy-btn`; đây là pattern phù hợp để xử lý table controls mà không cần rebind listener sau mỗi chunk.
- `src/views/webview/component/action-buttons.ts` copy toàn bộ response từ `data-raw-content`. Chức năng mới là per-table nên không nên ghép vào message-level action bar.
- `media/main.css` chưa có selector/styling cho table. Bảng hiện tại dùng gần như browser default và có thể tràn chiều ngang sidebar.
- Clipboard hiện tại chỉ gọi `navigator.clipboard.writeText()`. Extension Host có case `copyMessage` dùng `vscode.env.clipboard.writeText()`, nhưng API đó chỉ hỗ trợ plain text, không phù hợp để ghi đồng thời `text/html`.

### DOM hiện tại do `marked` sinh

Ví dụ source:

```markdown
| Name | Value |
| :--- | ----: |
| A    |     1 |
```

HTML tương ứng:

```html
<table>
  <thead>
    <tr>
      <th align="left">Name</th>
      <th align="right">Value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="left">A</td>
      <td align="right">1</td>
    </tr>
  </tbody>
</table>
```

`marked` table token có `raw`, vì vậy có thể lưu source chính xác của riêng bảng ngay lúc render, không cần cắt ngược từ toàn bộ message Markdown.

### Khoảng trống cần xử lý

1. `<table>` chưa có wrapper để đặt toolbar ở góc trên bên phải.
2. DOM table bị replace liên tục khi stream, nên không được giữ table element/button reference lâu dài.
3. Chưa có table-specific Markdown source trong DOM.
4. Chưa có serializer cho displayed text.
5. Chưa có rich clipboard (`ClipboardItem`) và fallback rõ ràng.
6. Chưa có CSS cho border, cell spacing, overflow và keyboard/focus state.
7. Markdown pipeline đang gán HTML trực tiếp vào `innerHTML` mà không có sanitizer; feature không được mở rộng bề mặt này bằng cách copy wrapper/button markup vào HTML output.

## Quyết định UX

### Vị trí và hành vi

- Mỗi table nằm trong `.table-copy-wrapper` có toolbar ở góc trên bên phải.
- Toolbar dùng **split button** gồm:
  - Nút chính có icon copy: click sẽ copy ngay dưới dạng **Markdown**, không mở menu.
  - Nút phụ có icon chevron-down: click mới mở menu lựa chọn format.
- Menu gồm:
  - `Copy as Markdown`
  - `Copy as HTML`
  - `Copy displayed text`
- Markdown là format mặc định. Menu vẫn có `Copy as Markdown` để người dùng nhận biết format hiện tại và có thể gọi lại cùng hành động từ menu.
- Menu mở khi click nút chevron-down; đóng khi chọn item, click ngoài hoặc nhấn `Escape`.
- Nút chính có `type="button"`, `aria-label="Copy table as Markdown"` và `acp-title="Copy table as Markdown"`.
- Nút chevron có `type="button"`, `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Choose table copy format"` và `acp-title="More copy formats"`.
- Sau khi copy thành công, icon nút chính chuyển sang check và tooltip thành `Copied as …` trong 1.5 giây, kể cả khi hành động được chọn từ menu.
- Toolbar có thể mờ khi idle nhưng phải hiện khi wrapper hover, `:focus-within`, và luôn dễ nhận biết trên thiết bị không có hover.
- Split button phải có visual grouping rõ ràng nhưng vẫn giữ hai hit target và focus target độc lập.

### Định nghĩa ba format

#### Markdown

- Giá trị: `token.raw` của table GFM, normalize tối thiểu thành một trailing newline.
- Giữ nguyên alignment markers, inline Markdown, escaped pipes và cách viết của agent.
- Ghi bằng `navigator.clipboard.writeText(markdown)`.

#### HTML

- Chỉ serialize chính `table.outerHTML`; không gồm `.table-copy-wrapper`, toolbar hoặc menu.
- Tạo standalone semantic fragment, không copy CSS/theme-dependent classes của extension nếu không cần thiết.
- Khi `navigator.clipboard.write` và `ClipboardItem` khả dụng:
  - `text/html`: `table.outerHTML`
  - `text/plain`: displayed text fallback
- Khi rich clipboard không khả dụng hoặc bị từ chối, fallback sang `navigator.clipboard.writeText(table.outerHTML)` để người dùng vẫn nhận được HTML source.

#### Displayed text

- Đọc từng `tr`; trong mỗi hàng đọc các direct `th`/`td` theo DOM order.
- Mỗi cell dùng `innerText` nếu có, fallback `textContent`; normalize line break và whitespace trong cell thành một khoảng trắng.
- Join cells bằng `\t`, join rows bằng `\n`.
- Không dùng toàn bộ `table.innerText` vì browser/JSDOM có thể tạo spacing khác nhau và khó test ổn định.

## Kiến trúc đề xuất

Đây là product-specific webview feature, nên đặt logic dưới `src/features/table-copy/`. Không cần `host.ts` vì render, DOM serialization và rich clipboard đều thuộc browser/webview environment.

```text
src/features/
├── table-copy/
│   ├── types.ts
│   ├── webview.ts
│   ├── styles.ts
│   └── index.ts
└── register-webview.ts

src/test/features/
└── table-copy.test.ts
```

### Trách nhiệm file

| File                                   | Trách nhiệm                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/features/table-copy/types.ts`     | `TableCopyFormat`, typed clipboard adapter và các type thuần để test                           |
| `src/features/table-copy/webview.ts`   | Decorate tables, event delegation, menu lifecycle, serializers, clipboard fallback và feedback |
| `src/features/table-copy/styles.ts`    | CSS riêng cho wrapper, table, toolbar, menu, focus, overflow và responsive behavior            |
| `src/features/table-copy/index.ts`     | Optional public webview exports; không tạo cross-environment import                            |
| `src/features/register-webview.ts`     | Register feature và cung cấp bridge tối thiểu tới message container/document                   |
| `src/test/features/table-copy.test.ts` | Unit/integration tests bằng JSDOM cho decoration, formats, menu và clipboard                   |

### Core integration tối thiểu

| File                                    | Thay đổi                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/views/webview/marked-config.ts`    | Thêm table renderer override để giữ `token.raw` trong một inert metadata node/attribute có encode an toàn, đồng thời giữ nguyên semantic table HTML của default renderer |
| `src/views/webview/block/text-block.ts` | Sau mỗi `innerHTML` assignment, gọi một generic post-render hook/callback để feature decorate table mới; không đặt table-copy implementation trực tiếp trong block       |
| `src/views/webview/main.ts`             | Expose bridge tối thiểu cần thiết, ví dụ message container và callback registration; không thêm table-copy logic                                                         |
| `src/features/register-webview.ts`      | Register `tableCopy` cùng các webview feature khác                                                                                                                       |

Không sửa `src/views/chat.ts`, `src/features/register-host.ts` hoặc host message contracts cho MVP.

## Thiết kế render hook

### Phương án chọn: synchronous post-render decorator

Sau khi `TextBlock.appendContent()` gán `innerHTML`, gọi hook generic với root vừa render:

```ts
this.ctx.eventBus.emit("markdownRendered", {
  root: this.contentEl,
  kind: "text",
});
```

Feature `table-copy` subscribe event và chỉ decorate `kind === "text"`.

Lý do chọn:

- Đồng bộ với lần render hiện tại, không phụ thuộc timing của `MutationObserver`.
- Chỉ scan subtree vừa thay đổi, tránh quan sát toàn bộ transcript.
- Hoạt động đúng khi snapshot/multi-session replay lại các `streamChunk`.
- Giữ `TextBlock` generic: chỉ phát lifecycle event, không biết table copy.
- Event delegation đặt một lần trên messages container nên table/button mới tạo sau mỗi chunk vẫn hoạt động.

Cần thêm payload typed vào `WebviewEventMap`:

```ts
markdownRendered: {
  root: HTMLElement;
  kind: "text" | "thought";
}
```

`ThoughtBlock` có thể phát cùng event để generic hóa lifecycle, nhưng feature bỏ qua `kind: "thought"`. Nếu muốn giảm thay đổi, phase đầu chỉ phát từ `TextBlock`.

### Table renderer metadata

Dùng default `marked.Renderer.prototype.table` để tránh tự copy logic render table của dependency:

```ts
table(token) {
  const html = defaultTableRenderer.call(this, token);
  const markdown = encodeURIComponent(token.raw);
  return `<template class="table-copy-source" data-markdown="${markdown}"></template>${html}`;
}
```

Decorator sẽ:

1. Tìm `template.table-copy-source + table`.
2. Decode source.
3. Tạo `.table-copy-wrapper` bằng DOM APIs.
4. Move `template` và `table` vào wrapper.
5. Thêm toolbar/menu bằng `createElement`, không nội suy source vào active HTML.
6. Đánh dấu `data-table-copy-enhanced="true"` để idempotent trong cùng render pass.

Nếu `template` gây selector/DOM compatibility issue, thay bằng encoded `data-markdown` trên wrapper do renderer tạo. Dù dùng cách nào, dữ liệu Markdown phải encode trước khi đưa vào attribute và decode trong feature.

## Clipboard adapter

Tạo adapter nhỏ để logic test được mà không phụ thuộc trực tiếp global browser API:

```ts
interface TableClipboard {
  writeText(value: string): Promise<void>;
  writeHtml?(html: string, plainText: string): Promise<void>;
}
```

Browser implementation:

1. `writeText`: `navigator.clipboard.writeText`.
2. `writeHtml`:
   - feature-detect `navigator.clipboard.write` và `window.ClipboardItem`;
   - tạo `Blob` cho `text/html` và `text/plain`;
   - gọi `navigator.clipboard.write([item])`;
   - nếu API thiếu hoặc call fail, gọi `writeText(html)`.

Không post HTML lên Extension Host vì `vscode.env.clipboard` chỉ có plain-text API và sẽ làm mất rich HTML flavor.

## Styling

`styles.ts` inject CSS scoped dưới `.table-copy-wrapper`:

- wrapper: `position: relative; max-width: 100%; overflow-x: auto; margin: 12px 0`;
- table: `border-collapse: collapse; width: max-content; min-width: 100%`;
- `th`, `td`: border, padding, vertical alignment, text alignment từ `align` attribute vẫn được tôn trọng;
- `thead`: dùng VS Code theme variables như `--vscode-editor-lineHighlightBackground`;
- row hover optional, không bắt buộc cho MVP;
- toolbar: split button sticky/absolute ở top-right, không che header bằng cách reserve top padding hoặc đặt trên một toolbar strip;
- menu: theme-aware background, border, shadow, z-index; không tràn viewport hẹp;
- focus-visible: dùng `--vscode-focusBorder`;
- print/copy HTML không chứa feature CSS vì chỉ serialize `<table>`.

Khuyến nghị dùng một top toolbar strip nhỏ thay vì overlay trực tiếp lên cell header để nút không che text khi bảng chỉ có một cột hoặc sidebar rất hẹp.

## Trình tự thực hiện

### Phase 1 — Render metadata và lifecycle seam

1. Thêm typed `markdownRendered` event vào `WebviewEventMap`.
2. Phát event ngay sau Markdown `innerHTML` update của `TextBlock`.
3. Extend `marked` renderer cho table để giữ `token.raw` và reuse default table renderer.
4. Test render một bảng có alignment, inline code, link và escaped content; xác nhận semantic `<table>` không đổi và source round-trip đúng.

**Gate:** tables vẫn render như trước; streaming chunk không throw; source của từng table độc lập và chính xác.

### Phase 2 — Feature decoration và UI

1. Tạo `src/features/table-copy/webview.ts`.
2. Register feature qua `src/features/register-webview.ts` với bridge tới `Document`, `Window` và messages container hoặc event bus subscription.
3. Implement idempotent `enhanceTables(root)`.
4. Tạo split button và menu bằng DOM API; nút chính dispatch trực tiếp format Markdown, nút chevron chỉ quản lý menu.
5. Dùng một click/keydown listener delegated tại transcript container hoặc document.
6. Inject scoped styles từ `styles.ts`.

**Gate:** mỗi table có đúng một control; không nhân đôi sau nhiều chunk; menu keyboard-accessible; thought table không bị decorate.

### Phase 3 — Serializers và clipboard

1. Implement `serializeTableAsMarkdown()` từ stored raw source.
2. Implement `serializeTableAsHtml()` từ `table.outerHTML`.
3. Implement `serializeTableAsDisplayedText()` bằng row/cell traversal.
4. Implement browser clipboard adapter và fallback.
5. Thêm success/error state; error chỉ log rõ context, không hiển thị success giả.

**Gate:** ba format có output deterministic; HTML rich copy có `text/html` + `text/plain`; fallback hoạt động khi `ClipboardItem` không tồn tại hoặc `write()` reject.

### Phase 4 — Verification và regression

1. Thêm `src/test/features/table-copy.test.ts`.
2. Chỉ bổ sung test vào `src/test/webview.test.ts` nếu cần xác nhận core render event/registry integration.
3. Chạy quality gates nhỏ nhất theo thứ tự project:
   - `npm run check-types`
   - lint targeted không dùng `--fix` nếu chỉ verify, hoặc project lint theo quy ước hiện tại
   - compile tests / targeted test nếu harness hỗ trợ
   - `npm run compile`
4. Manual test trong Extension Development Host với dark/light/high-contrast theme và sidebar hẹp.

## Test cases

### Render và streaming

1. Complete GFM table tạo một `.table-copy-wrapper` và một `<table>`.
2. Table source đến qua nhiều `streamChunk`; control chỉ xuất hiện khi parser đã nhận diện table và không duplicate sau chunk kế tiếp.
3. Hai table trong cùng text block nhận đúng source riêng.
4. Table trước và sau tool block vẫn hoạt động khi `BlockManager` tạo nhiều text block.
5. Snapshot/multi-session replay tạo lại controls đúng.
6. Thought table không có controls trong MVP.

### Markdown format

1. Giữ alignment row `:---`, `---:`, `:---:`.
2. Giữ inline Markdown: emphasis, code, link.
3. Giữ escaped pipe và trailing newline theo normalization đã định.
4. Không copy text ngoài table.

### HTML format

1. Output bắt đầu bằng `<table` và không chứa `table-copy-wrapper`, button, menu hoặc encoded Markdown metadata.
2. Giữ `thead`, `tbody`, links, inline code và `align` attributes.
3. Rich clipboard nhận cả `text/html` và `text/plain`.
4. Fallback copy HTML source khi rich API không tồn tại/reject.

### Displayed text format

1. Header/data rows phân tách bằng newline.
2. Cells phân tách bằng tab.
3. Inline markup chỉ còn visible text.
4. Whitespace/newline trong cell được normalize.
5. Empty cell vẫn giữ đúng số cột.

### Interaction và accessibility

1. Click nút copy chính sẽ copy ngay Markdown của đúng table và không mở menu.
2. Click nút chevron-down mở menu của đúng table và không tự copy.
3. Menu hiển thị đủ Markdown, HTML và displayed text.
4. Click ngoài và `Escape` đóng menu.
5. Chọn format đóng menu và flash check state trên nút chính.
6. `aria-expanded` của nút chevron cập nhật đúng.
7. Keyboard focus đi được độc lập qua nút chính, nút chevron và menu items.
8. `Enter`/`Space` trên nút chính copy Markdown; `Enter`/`Space` trên chevron mở menu.
9. Click table-copy không trigger file link hoặc code-copy handler lân cận.

### Styling/manual

1. Table rộng scroll ngang trong message, không làm toàn sidebar overflow.
2. Toolbar không che header text.
3. Dark, light và high-contrast theme có border/focus rõ.
4. Menu không bị cắt ở cạnh phải hoặc dưới viewport.

## Acceptance criteria

- Mọi GFM table trong assistant text response có split copy control ở góc trên bên phải.
- Click nút copy chính mặc định copy Markdown ngay lập tức; chỉ nút chevron-down mới mở danh sách format.
- Người dùng copy được Markdown, HTML hoặc displayed text của **đúng table**.
- Markdown output lấy từ source token, không reverse-engineer từ DOM.
- HTML output không chứa UI controls/feature metadata.
- Displayed text dùng tab/newline ổn định.
- Không duplicate controls trong streaming/replay.
- Không thay đổi behavior của code copy và whole-response copy.
- Không thêm host-side code hoặc custom host message không cần thiết.
- Logic product-specific nằm trong `src/features/table-copy/`; core chỉ có render metadata, lifecycle hook và registry integration nhỏ.
- Typecheck, relevant tests và build pass.

## Rủi ro và giảm thiểu

| Rủi ro                                                         | Giảm thiểu                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Re-render mỗi chunk xóa menu/control đang mở                   | Decorate lại sau render; không bảo đảm menu giữ trạng thái trong lúc agent còn stream; event delegation không cần rebind |
| Table renderer override lệch behavior của `marked` khi upgrade | Gọi default renderer thay vì tự tái tạo table HTML; có regression tests cho structure/alignment                          |
| Raw Markdown làm vỡ attribute/HTML                             | Encode trước khi đưa vào metadata; decode sau; tạo UI bằng DOM APIs                                                      |
| Rich clipboard bị chặn hoặc không hỗ trợ                       | Feature detection và `writeText(html)` fallback                                                                          |
| Split button che nội dung hoặc quá rộng                        | Dùng toolbar strip/reserved space, icon-only controls với tooltip/ARIA và test sidebar hẹp                               |
| Table rất rộng làm message overflow                            | Wrapper `overflow-x: auto`, không set width vượt parent                                                                  |
| HTML copy mang theo extension UI/style                         | Serialize đúng `table.outerHTML`, không serialize wrapper                                                                |
| Existing unsanitized Markdown HTML                             | Không mở rộng phạm vi trust; không execute copied content; ghi nhận sanitizer là vấn đề riêng ngoài scope                |
| JSDOM thiếu `innerText`/ClipboardItem đầy đủ                   | Serializer fallback `textContent`; inject clipboard adapter/mocks trong tests                                            |

## Ngoài phạm vi

- Thay toàn bộ Markdown pipeline hoặc thêm sanitizer.
- Copy CSV/TSV như một lựa chọn menu riêng; displayed text đã dùng tab/newline.
- Persist default copy format giữa sessions.
- Host command, keybinding hoặc context-menu cấp VS Code.
- Apply controls cho thought blocks, tool output HTML tables hoặc user-authored text.
- Export table thành file.

## Files dự kiến thay đổi

```text
src/views/webview/marked-config.ts
src/views/webview/block/text-block.ts
src/views/webview/types.ts
src/views/webview/main.ts                 # chỉ khi cần expose generic bridge
src/features/register-webview.ts
src/features/table-copy/types.ts
src/features/table-copy/webview.ts
src/features/table-copy/styles.ts
src/features/table-copy/index.ts          # optional
src/test/features/table-copy.test.ts
src/test/webview.test.ts                  # chỉ cho integration seam nếu cần
```

Không dự kiến sửa `src/views/chat.ts`, `src/features/register-host.ts`, `package.json` hoặc thêm dependency mới.
