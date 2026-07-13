/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import { JSDOM } from "jsdom";
import { EventBus } from "../../views/webview/event-bus";
import { marked } from "../../views/webview/marked-config";
import { WebviewController } from "../../views/webview/main";
import type { VsCodeApi, WebviewEventMap } from "../../views/webview/types";
import type { TableClipboard } from "../../features/table-copy/types";
import {
  TableCopyWebviewController,
  createBrowserTableClipboard,
  serializeTableAsDisplayedText,
  serializeTableAsHtml,
  serializeTableAsMarkdown,
} from "../../features/table-copy/webview";
import { TABLE_COPY_METADATA_TOKEN } from "../../views/webview/marked-config";

class FakeClipboard implements TableClipboard {
  readonly textWrites: string[] = [];
  readonly htmlWrites: Array<{ html: string; plainText: string }> = [];

  async writeText(value: string): Promise<void> {
    this.textWrites.push(value);
  }

  async writeHtml(html: string, plainText: string): Promise<void> {
    this.htmlWrites.push({ html, plainText });
  }
}

function createMockVsCodeApi(): VsCodeApi & { _messages: unknown[] } {
  const messages: unknown[] = [];
  let state: Record<string, unknown> = {};
  return {
    postMessage: (message: unknown) => messages.push(message),
    getState: <T>() => state as T,
    setState: <T>(newState: T) => {
      state = newState as Record<string, unknown>;
      return newState;
    },
    _messages: messages,
  };
}

function createWebviewHTML(): string {
  return `<!DOCTYPE html><html><head></head><body>
    <div id="welcome-view"></div>
    <div id="agent-plan-container"></div>
    <div id="messages-container"><div id="messages"></div></div>
    <div id="typing-indicator"></div>
    <div id="diff-summary-container"></div>
    <div id="chat-input-area">
      <div id="input-container">
        <div id="command-autocomplete" role="listbox"></div>
        <div id="input" contenteditable="true"></div>
      </div>
      <div id="options-bar">
        <div id="left-options">
          <button id="attach-image">Attach</button>
          <div id="mode-dropdown" class="custom-dropdown"><div class="dropdown-trigger"><span class="selected-label"></span></div><div class="dropdown-popover"></div></div>
          <div id="model-dropdown" class="custom-dropdown"><div class="dropdown-trigger"><span class="selected-label"></span></div><div class="dropdown-popover"></div></div>
          <div id="config-options-container"></div>
          <div id="context-usage-ring"></div>
        </div>
        <div id="right-options"><button id="send">Send</button><button id="stop">Stop</button></div>
      </div>
    </div>
    <div id="image-preview-popover"><img src=""></div>
  </body></html>`;
}

function setupFeature(markdown: string) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="messages"><div id="root"></div><button id="outside">outside</button></div></body></html>`,
    { url: "https://localhost" }
  );
  const doc = dom.window.document;
  const win = dom.window;
  const messagesEl = doc.getElementById("messages") as HTMLElement;
  const root = doc.getElementById("root") as HTMLElement;
  const eventBus = new EventBus<WebviewEventMap>();
  const clipboard = new FakeClipboard();
  root.innerHTML = marked.parse(markdown) as string;
  const controller = new TableCopyWebviewController(
    doc,
    win as unknown as Window,
    messagesEl,
    eventBus,
    clipboard,
    { feedbackDurationMs: 1 }
  );
  eventBus.emit("markdownRendered", { root, kind: "text" });
  return { controller, clipboard, doc, win, messagesEl, root };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

suite("table-copy feature", () => {
  test("decorates each rendered GFM table with split copy controls and raw Markdown source", () => {
    const source = "| Name | `Value` |\n| :--- | ---: |\n| [A](file.md) | 1 \\| 2 |";
    const { root } = setupFeature(source);

    const wrapper = root.querySelector(".table-copy-wrapper") as HTMLElement;
    assert.ok(wrapper, "table wrapper should be created");
    assert.strictEqual(root.querySelectorAll(".table-copy-wrapper").length, 1);
    assert.ok(wrapper.querySelector("table"), "semantic table remains present");
    assert.ok(
      wrapper.querySelector('button[aria-label="Copy table as Markdown"]'),
      "primary copy button should exist"
    );
    assert.ok(
      wrapper.querySelector('button[aria-label="Choose table copy format"]'),
      "format menu button should exist"
    );
    assert.strictEqual(serializeTableAsMarkdown(wrapper), `${source}\n`);
  });

  test("does not duplicate controls when the same root is enhanced again", () => {
    const { controller, root } = setupFeature("| A |\n|---|\n| 1 |");

    controller.enhanceTables(root);

    assert.strictEqual(root.querySelectorAll(".table-copy-wrapper").length, 1);
    assert.strictEqual(root.querySelectorAll(".table-copy-primary").length, 1);
    assert.strictEqual(root.querySelectorAll(".table-copy-menu-toggle").length, 1);
  });

  test("keeps independent Markdown source for multiple tables", () => {
    const first = "| A |\n|---|\n| 1 |";
    const second = "| B | C |\n| :--- | ---: |\n| x | y |";
    const { root } = setupFeature(`${first}\n\n${second}`);

    const wrappers = Array.from(
      root.querySelectorAll<HTMLElement>(".table-copy-wrapper")
    );

    assert.strictEqual(wrappers.length, 2);
    assert.strictEqual(serializeTableAsMarkdown(wrappers[0]), `${first}\n`);
    assert.strictEqual(serializeTableAsMarkdown(wrappers[1]), `${second}\n`);
  });

  test("ignores thought Markdown render events", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head></head><body><div id="messages"><div id="root"></div></div></body></html>`,
      { url: "https://localhost" }
    );
    const doc = dom.window.document;
    const root = doc.getElementById("root") as HTMLElement;
    root.innerHTML = marked.parse("| A |\n|---|\n| 1 |") as string;
    const eventBus = new EventBus<WebviewEventMap>();
    new TableCopyWebviewController(
      doc,
      dom.window as unknown as Window,
      doc.getElementById("messages") as HTMLElement,
      eventBus,
      new FakeClipboard()
    );

    eventBus.emit("markdownRendered", { root, kind: "thought" });

    assert.strictEqual(root.querySelector(".table-copy-wrapper"), null);
  });

  test("serializes displayed text with tab-separated cells and normalized whitespace", () => {
    const { root } = setupFeature(
      "| Name | Value | Empty |\n|---|---|---|\n| **Alpha** | line<br> break | |"
    );
    const table = root.querySelector("table") as HTMLTableElement;

    assert.strictEqual(
      serializeTableAsDisplayedText(table),
      "Name\tValue\tEmpty\nAlpha\tline break\t"
    );
  });

  test("serializes displayed text from the selected table only", () => {
    const dom = new JSDOM(`<!DOCTYPE html><table><tbody>
      <tr><th>Outer</th><td>Value<table><tbody><tr><td>Nested</td></tr></tbody></table></td></tr>
    </tbody></table>`);
    const table = dom.window.document.querySelector("table") as HTMLTableElement;

    assert.strictEqual(serializeTableAsDisplayedText(table), "Outer\tValueNested");
  });

  test("serializes HTML from the table only, excluding wrapper controls and metadata", () => {
    const { root } = setupFeature("| Name | Value |\n| :--- | ---: |\n| A | `1` |");
    const table = root.querySelector("table") as HTMLTableElement;
    const html = serializeTableAsHtml(table);

    assert.ok(html.startsWith("<table"));
    assert.ok(html.includes("<thead>"));
    assert.ok(html.includes('align="left"'));
    assert.ok(html.includes('align="right"'));
    assert.ok(!html.includes("table-copy-wrapper"));
    assert.ok(!html.includes("table-copy-source"));
    assert.ok(!html.includes("button"));
  });

  test("ignores forged table metadata from raw assistant HTML", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head></head><body><div id="messages"><div id="root">
        <template class="table-copy-source" data-markdown="%7C%20Forged%20%7C"></template>
        <table><tbody><tr><td>Rendered</td></tr></tbody></table>
      </div></div></body></html>`,
      { url: "https://localhost" }
    );
    const doc = dom.window.document;
    const root = doc.getElementById("root") as HTMLElement;
    const eventBus = new EventBus<WebviewEventMap>();
    const controller = new TableCopyWebviewController(
      doc,
      dom.window as unknown as Window,
      doc.getElementById("messages") as HTMLElement,
      eventBus,
      new FakeClipboard()
    );

    controller.enhanceTables(root);
    assert.strictEqual(root.querySelector(".table-copy-wrapper"), null);

    const source = root.querySelector("template") as HTMLTemplateElement;
    source.dataset.tableCopyToken = TABLE_COPY_METADATA_TOKEN;
    controller.enhanceTables(root);
    assert.strictEqual(root.querySelectorAll(".table-copy-wrapper").length, 1);
  });

  test("primary button copies Markdown and chevron opens the format menu without copying", async () => {
    const source = "| Name | Value |\n|---|---|\n| A | 1 |";
    const { clipboard, root } = setupFeature(source);
    const wrapper = root.querySelector(".table-copy-wrapper") as HTMLElement;
    const primary = wrapper.querySelector(
      ".table-copy-primary"
    ) as HTMLButtonElement;
    const toggle = wrapper.querySelector(
      ".table-copy-menu-toggle"
    ) as HTMLButtonElement;
    const menu = wrapper.querySelector(".table-copy-menu") as HTMLElement;

    primary.click();
    await flushPromises();

    assert.deepStrictEqual(clipboard.textWrites, [`${source}\n`]);
    assert.strictEqual(menu.hidden, true);

    toggle.click();

    assert.strictEqual(menu.hidden, false);
    assert.strictEqual(toggle.getAttribute("aria-expanded"), "true");
    assert.deepStrictEqual(clipboard.textWrites, [`${source}\n`]);
  });

  test("menu item copies rich HTML with displayed text fallback and then closes", async () => {
    const { clipboard, root } = setupFeature("| Name | Value |\n|---|---|\n| A | 1 |");
    const wrapper = root.querySelector(".table-copy-wrapper") as HTMLElement;
    const toggle = wrapper.querySelector(
      ".table-copy-menu-toggle"
    ) as HTMLButtonElement;

    toggle.click();
    const htmlItem = wrapper.querySelector(
      '[data-table-copy-format="html"]'
    ) as HTMLButtonElement;
    htmlItem.click();
    await flushPromises();

    assert.strictEqual(clipboard.htmlWrites.length, 1);
    assert.ok(clipboard.htmlWrites[0].html.startsWith("<table"));
    assert.strictEqual(clipboard.htmlWrites[0].plainText, "Name\tValue\nA\t1");
    assert.strictEqual(
      (wrapper.querySelector(".table-copy-menu") as HTMLElement).hidden,
      true
    );
    assert.strictEqual(
      (wrapper.querySelector(".table-copy-menu-toggle") as HTMLElement).getAttribute(
        "aria-expanded"
      ),
      "false"
    );
  });

  test("Escape and outside click close the open menu", () => {
    const { doc, root, win } = setupFeature("| A |\n|---|\n| 1 |");
    const wrapper = root.querySelector(".table-copy-wrapper") as HTMLElement;
    const toggle = wrapper.querySelector(
      ".table-copy-menu-toggle"
    ) as HTMLButtonElement;
    const menu = wrapper.querySelector(".table-copy-menu") as HTMLElement;

    toggle.click();
    assert.strictEqual(menu.hidden, false);

    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    assert.strictEqual(menu.hidden, true);

    toggle.click();
    assert.strictEqual(menu.hidden, false);
    (doc.getElementById("outside") as HTMLElement).click();
    assert.strictEqual(menu.hidden, true);
  });

  test("registered WebviewController decorates streamed assistant text tables but not thought tables", () => {
    const dom = new JSDOM(createWebviewHTML(), {
      runScripts: "dangerously",
      url: "https://localhost",
    });
    const win = dom.window as unknown as Window;
    const doc = dom.window.document;
    (global as any).Node = dom.window.Node;
    (global as any).NodeFilter = dom.window.NodeFilter;

    const controller = new WebviewController(createMockVsCodeApi(), doc, win);
    controller.handleMessage({ type: "streamStart" });
    controller.handleMessage({ type: "thoughtChunk", text: "| T |\n|---|\n| x |" });
    controller.handleMessage({ type: "streamChunk", text: "| A |\n|---|\n| 1 |" });

    assert.strictEqual(
      doc.querySelectorAll(".block-thought .table-copy-wrapper").length,
      0
    );
    assert.strictEqual(
      doc.querySelectorAll(".block-text .table-copy-wrapper").length,
      1
    );
  });

  test("browser clipboard writes text/html with text/plain and falls back to HTML source on rich write failure", async () => {
    const richWrites: any[] = [];
    const textWrites: string[] = [];
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    const richWindow = {
      Blob,
      ClipboardItem: TestClipboardItem,
      navigator: {
        clipboard: {
          write: async (items: unknown[]) => richWrites.push(items),
          writeText: async (value: string) => textWrites.push(value),
        },
      },
    } as unknown as Window;

    await createBrowserTableClipboard(richWindow).writeHtml?.(
      "<table><tr><td>A</td></tr></table>",
      "A"
    );

    assert.strictEqual(richWrites.length, 1);
    assert.ok(richWrites[0][0].items["text/html"] instanceof Blob);
    assert.ok(richWrites[0][0].items["text/plain"] instanceof Blob);
    assert.deepStrictEqual(textWrites, []);

    const fallbackTextWrites: string[] = [];
    const fallbackWindow = {
      Blob,
      ClipboardItem: TestClipboardItem,
      navigator: {
        clipboard: {
          write: async () => {
            throw new Error("denied");
          },
          writeText: async (value: string) => fallbackTextWrites.push(value),
        },
      },
    } as unknown as Window;

    await createBrowserTableClipboard(fallbackWindow).writeHtml?.(
      "<table><tr><td>B</td></tr></table>",
      "B"
    );

    assert.deepStrictEqual(fallbackTextWrites, [
      "<table><tr><td>B</td></tr></table>",
    ]);
  });
});
