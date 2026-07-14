/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as vscode from "vscode";
import { JSDOM } from "jsdom";
import {
  detectExactResourceLink,
  detectResourceLinks,
} from "../../features/clickable-resource-links/detector";
import { ClickableResourceLinksWebviewController } from "../../features/clickable-resource-links/webview";
import { ClickableResourceLinksHostController } from "../../features/clickable-resource-links/host";
import { OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE } from "../../features/clickable-resource-links/types";
import { EventBus } from "../../views/webview/event-bus";
import type { WebviewEventMap } from "../../views/webview/types";

suite("clickable-resource-links feature", () => {
  suite("detector", () => {
    test("detects web URL candidates", () => {
      const links = detectResourceLinks(
        "See https://example.com/docs?q=1#intro, http://localhost:3000/app and www.example.com/docs."
      );

      assert.deepStrictEqual(
        links.map((link) => ({ kind: link.kind, text: link.text, href: link.href })),
        [
          {
            kind: "web",
            text: "https://example.com/docs?q=1#intro",
            href: "https://example.com/docs?q=1#intro",
          },
          {
            kind: "web",
            text: "http://localhost:3000/app",
            href: "http://localhost:3000/app",
          },
          {
            kind: "web",
            text: "www.example.com/docs",
            href: "https://www.example.com/docs",
          },
        ]
      );
    });

    test("detects file path candidates and preserves line suffixes", () => {
      const links = detectResourceLinks(
        "Open docs/plans/README.md, src/views/chat.ts:471, /tmp/output.log, file:///home/user/project/src/a.ts#L10-L20, ./README.md and package.json"
      );

      assert.deepStrictEqual(
        links.map((link) => ({
          kind: link.kind,
          text: link.text,
          href: link.href,
          lineRangeText: link.lineRangeText,
        })),
        [
          {
            kind: "file",
            text: "docs/plans/README.md",
            href: "docs/plans/README.md",
            lineRangeText: undefined,
          },
          {
            kind: "file",
            text: "src/views/chat.ts:471",
            href: "src/views/chat.ts:471",
            lineRangeText: ":471",
          },
          {
            kind: "file",
            text: "/tmp/output.log",
            href: "/tmp/output.log",
            lineRangeText: undefined,
          },
          {
            kind: "file",
            text: "file:///home/user/project/src/a.ts#L10-L20",
            href: "file:///home/user/project/src/a.ts#L10-L20",
            lineRangeText: "#L10-L20",
          },
          {
            kind: "file",
            text: "./README.md",
            href: "./README.md",
            lineRangeText: undefined,
          },
          {
            kind: "file",
            text: "package.json",
            href: "package.json",
            lineRangeText: undefined,
          },
        ]
      );
    });

    test("does not detect ambiguous identifiers or bare domains", () => {
      const links = detectResourceLinks(
        "Ignore configOptions.thought_level, foo.bar, object.property, example.com and @scope/pkg"
      );

      assert.deepStrictEqual(links, []);
    });

    test("requires inline code to be exactly one resource candidate", () => {
      assert.strictEqual(
        detectExactResourceLink("docs/plans/README.md")?.href,
        "docs/plans/README.md"
      );
      assert.strictEqual(
        detectExactResourceLink(" https://example.com/docs ")?.href,
        "https://example.com/docs"
      );
      assert.strictEqual(
        detectExactResourceLink("open docs/plans/README.md now"),
        undefined
      );
      assert.strictEqual(
        detectExactResourceLink("configOptions.thought_level"),
        undefined
      );
    });
  });

  suite("host", () => {
    let originalOpenExternal: typeof vscode.env.openExternal;
    let opened: string[];

    setup(() => {
      originalOpenExternal = vscode.env.openExternal;
      opened = [];
      Object.defineProperty(vscode.env, "openExternal", {
        value: async (uri: vscode.Uri) => {
          opened.push(uri.toString());
          return true;
        },
        configurable: true,
        writable: true,
      });
    });

    teardown(() => {
      Object.defineProperty(vscode.env, "openExternal", {
        value: originalOpenExternal,
        configurable: true,
        writable: true,
      });
    });

    test("opens only http and https external URLs", async () => {
      const controller = new ClickableResourceLinksHostController();

      assert.strictEqual(await controller.openExternal("https://example.com/docs"), true);
      assert.strictEqual(await controller.openExternal("http://localhost:3000/app"), true);
      assert.strictEqual(await controller.openExternal("javascript:alert(1)"), false);
      assert.strictEqual(await controller.openExternal("command:test"), false);
      assert.strictEqual(await controller.openExternal("vscode://file/test"), false);
      assert.strictEqual(await controller.openExternal("data:text/plain,test"), false);
      assert.strictEqual(await controller.openExternal("file:///tmp/test.txt"), false);
      assert.strictEqual(await controller.openExternal("not a url"), false);

      assert.deepStrictEqual(opened, [
        "https://example.com/docs",
        "http://localhost:3000/app",
      ]);
    });

    test("handles feature messages without throwing", async () => {
      const controller = new ClickableResourceLinksHostController();

      assert.strictEqual(
        await controller.handleMessage({
          type: OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE,
          url: "https://example.com/docs",
        }),
        true
      );
      assert.strictEqual(await controller.handleMessage({ type: "other" }), false);
      assert.deepStrictEqual(opened, ["https://example.com/docs"]);
    });
  });

  suite("webview decorator", () => {
    function setup() {
      const dom = new JSDOM(
        `<!DOCTYPE html><html><body><div id="messages"></div></body></html>`,
        { url: "https://localhost" }
      );
      const doc = dom.window.document;
      (global as any).NodeFilter = dom.window.NodeFilter;
      const messages: unknown[] = [];
      const eventBus = new EventBus<WebviewEventMap>();
      new ClickableResourceLinksWebviewController(
        doc,
        doc.getElementById("messages")!,
        eventBus,
        (message) => messages.push(message)
      );
      return { dom, doc, eventBus, messages };
    }

    test("linkifies exact inline code resource candidates", () => {
      const { doc, eventBus } = setup();
      const root = doc.createElement("div");
      root.innerHTML =
        "<p><code>docs/plans/README.md</code> <code>https://example.com/docs</code> <code>configOptions.thought_level</code></p>";

      eventBus.emit("markdownRendered", { root, kind: "text" });

      const fileLink = root.querySelector(
        'a.acp-inline-code-link[href="docs/plans/README.md"]'
      ) as HTMLAnchorElement | null;
      const webLink = root.querySelector(
        'a.acp-inline-code-link[href="https://example.com/docs"]'
      ) as HTMLAnchorElement | null;

      assert.ok(fileLink, "expected inline file code to become a link");
      assert.ok(webLink, "expected inline URL code to become a link");
      assert.strictEqual(fileLink.querySelector("code")?.textContent, "docs/plans/README.md");
      assert.ok(
        Array.from(root.querySelectorAll("code")).some(
          (code) => code.textContent === "configOptions.thought_level"
        ),
        "ambiguous inline code should remain inert"
      );
    });

    test("does not linkify fenced code block content", () => {
      const { doc, eventBus } = setup();
      const root = doc.createElement("div");
      root.innerHTML = "<pre><code>docs/plans/README.md</code></pre>";

      eventBus.emit("markdownRendered", { root, kind: "text" });

      assert.strictEqual(root.querySelectorAll("a").length, 0);
    });

    test("linkifies bare text nodes and trims trailing punctuation", () => {
      const { doc, eventBus } = setup();
      const root = doc.createElement("div");
      root.innerHTML =
        '<p>Files: docs/plans/README.md and src/views/chat.ts:471. See https://example.com/docs.</p>';

      eventBus.emit("markdownRendered", { root, kind: "text" });

      assert.ok(root.querySelector('a[href="docs/plans/README.md"]'));
      assert.ok(root.querySelector('a[href="src/views/chat.ts:471"]'));
      assert.ok(root.querySelector('a[href="https://example.com/docs"]'));
      assert.ok(root.textContent?.includes("."), "trailing punctuation should remain text");
    });

    test("does not create nested anchors or scan skipped containers", () => {
      const { doc, eventBus } = setup();
      const root = doc.createElement("div");
      root.innerHTML =
        '<p><a href="https://example.com">https://example.com</a></p><pre><code>src/views/chat.ts</code></pre><button>docs/plans/README.md</button><div class="tool-item">/tmp/output.log</div>';

      eventBus.emit("markdownRendered", { root, kind: "text" });

      assert.strictEqual(root.querySelectorAll("a").length, 1);
      assert.strictEqual(root.querySelector("a a"), null);
    });

    test("routes external link clicks through the extension host", () => {
      const { dom, doc, eventBus, messages } = setup();
      const messagesEl = doc.getElementById("messages")!;
      const root = doc.createElement("div");
      root.innerHTML = '<p><a href="https://example.com/docs">site</a></p>';
      messagesEl.append(root);

      eventBus.emit("markdownRendered", { root, kind: "text" });
      root.querySelector("a")!.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })
      );

      assert.deepStrictEqual(messages, [
        {
          type: OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE,
          url: "https://example.com/docs",
        },
      ]);
    });

    test("ignores thought markdown events", () => {
      const { doc, eventBus } = setup();
      const root = doc.createElement("div");
      root.textContent = "docs/plans/README.md";

      eventBus.emit("markdownRendered", { root, kind: "thought" });

      assert.strictEqual(root.querySelectorAll("a").length, 0);
    });
  });
});
