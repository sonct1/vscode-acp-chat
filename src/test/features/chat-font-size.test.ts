/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { JSDOM } from "jsdom";
import {
  CHAT_FONT_SIZE_MESSAGE_TYPE,
  ChatFontSizeHostController,
  ChatFontSizeWebviewController,
  normalizeChatFontSize,
} from "../../features/chat-font-size";
import { registerHostFeatures } from "../../features/register-host";

class TestMemento implements vscode.Memento {
  private readonly state = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.state.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.state.has(key) ? this.state.get(key) : defaultValue) as
      | T
      | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.state.delete(key);
    else this.state.set(key, value);
  }
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../../..", relativePath),
    "utf8"
  );
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...css.matchAll(
      new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`, "gm")
    ),
  ];
  assert.ok(matches.length > 0, `Expected CSS block for ${selector}`);
  return matches[matches.length - 1][0];
}

async function waitForMessage(
  messages: Record<string, unknown>[],
  count: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (messages.length >= count) return messages[messages.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} messages`);
}

suite("chat-font-size feature", () => {
  let previousFontSize: number | undefined;
  let previousMultiSessionEnabled: boolean | undefined;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    previousFontSize = config.inspect<number>("fontSize")?.globalValue;
    previousMultiSessionEnabled = config.inspect<boolean>(
      "multiSession.enabled"
    )?.globalValue;
    await config.update("fontSize", 0, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update(
      "fontSize",
      previousFontSize,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "multiSession.enabled",
      previousMultiSessionEnabled,
      vscode.ConfigurationTarget.Global
    );
  });

  test("normalizes default, invalid, rounded, and clamped values", () => {
    assert.strictEqual(normalizeChatFontSize(0), null);
    assert.strictEqual(normalizeChatFontSize(-1), null);
    assert.strictEqual(normalizeChatFontSize("16"), null);
    assert.strictEqual(normalizeChatFontSize(Number.NaN), null);
    assert.strictEqual(normalizeChatFontSize(7), 8);
    assert.strictEqual(normalizeChatFontSize(16.4), 16);
    assert.strictEqual(normalizeChatFontSize(16.6), 17);
    assert.strictEqual(normalizeChatFontSize(41), 40);
  });

  test("host sends normalized settings from configuration", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update("fontSize", 16, vscode.ConfigurationTarget.Global);

    const messages: Record<string, unknown>[] = [];
    const controller = new ChatFontSizeHostController({
      postMessage: (message) => messages.push(message),
    });

    try {
      controller.sendSettings();
      assert.deepStrictEqual(messages.at(-1), {
        type: CHAT_FONT_SIZE_MESSAGE_TYPE,
        fontSize: 16,
      });
    } finally {
      controller.dispose();
    }
  });

  test("host resends settings when configuration changes", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update("fontSize", 0, vscode.ConfigurationTarget.Global);

    const messages: Record<string, unknown>[] = [];
    const controller = new ChatFontSizeHostController({
      postMessage: (message) => messages.push(message),
    });

    try {
      await config.update("fontSize", 20, vscode.ConfigurationTarget.Global);
      const message = await waitForMessage(messages, 1);
      assert.deepStrictEqual(message, {
        type: CHAT_FONT_SIZE_MESSAGE_TYPE,
        fontSize: 20,
      });
    } finally {
      controller.dispose();
    }
  });

  test("host feature registers even when multi-session is disabled", async () => {
    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update("multiSession.enabled", false, vscode.ConfigurationTarget.Global);

    const features = registerHostFeatures({
      globalState: new TestMemento(),
      postMessage: () => {},
    });

    try {
      assert.ok(features.chatFontSize);
      assert.strictEqual(features.multiSession, undefined);
    } finally {
      features.chatFontSize?.dispose();
      features.multiSession?.dispose();
    }
  });

  test("primary CSS defines root font fallback and shared typography tokens", () => {
    const vscodeCss = readRepoFile("media/vscode.css");

    assert.ok(
      cssBlock(vscodeCss, "html").includes(
        "font-size: var(--acp-chat-font-size-effective);"
      )
    );
    assert.ok(
      vscodeCss.includes(
        "--acp-chat-font-size-effective: var(\n    --acp-chat-font-size,\n    var(--vscode-font-size, 13px)\n  );"
      )
    );
    for (const token of [
      "--acp-font-size-normal",
      "--acp-font-size-xxs",
      "--acp-font-size-xs",
      "--acp-font-size-sm",
      "--acp-font-size-base",
      "--acp-font-size-md",
      "--acp-font-size-lg",
      "--acp-font-size-prose",
      "--acp-font-size-code",
      "--acp-font-size-code-block",
      "--acp-font-size-heading-1",
      "--acp-font-size-heading-2",
      "--acp-font-size-heading-3",
    ]) {
      assert.ok(vscodeCss.includes(token), `Expected ${token}`);
    }
  });

  test("body, input, prose, and code consume chat typography tokens", () => {
    const vscodeCss = readRepoFile("media/vscode.css");
    const mainCss = readRepoFile("media/main.css");

    assert.ok(
      cssBlock(vscodeCss, "body").includes(
        "font-size: var(--acp-font-size-base);"
      )
    );
    assert.ok(
      cssBlock(vscodeCss, "code").includes(
        "font-size: var(--acp-font-size-code);"
      )
    );
    assert.ok(
      cssBlock(vscodeCss, "code").includes(
        "font-family: var(--vscode-editor-font-family), monospace;"
      )
    );
    assert.ok(
      cssBlock(vscodeCss, "pre code").includes(
        "font-size: var(--acp-font-size-code-block);"
      )
    );
    assert.ok(
      cssBlock(mainCss, "#input").includes(
        "font-size: var(--acp-font-size-base);"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".message-content-text").includes(
        "font-size: var(--acp-font-size-prose);"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".block-text").includes(
        "font-size: var(--acp-font-size-prose);"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".message.assistant code").includes(
        "font-size: var(--acp-font-size-code);"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".message.assistant h1").includes(
        "font-size: var(--acp-font-size-heading-1);"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".message.assistant h2").includes(
        "font-size: var(--acp-font-size-heading-2);"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".message.assistant h3").includes(
        "font-size: var(--acp-font-size-heading-3);"
      )
    );
    const assistantHeadingReset = mainCss.match(
      /\.message\.assistant h1,[\s\S]*?\.message\.assistant h6\s*\{[^}]*\}/m
    );
    assert.ok(assistantHeadingReset, "Expected assistant h1-h6 reset block");
    assert.ok(
      assistantHeadingReset[0].includes(
        "font-size: var(--acp-font-size-normal);"
      )
    );
  });

  test("uses the configured size for normal text and keeps large-font dialogs usable", () => {
    const vscodeCss = readRepoFile("media/vscode.css");
    const mainCss = readRepoFile("media/main.css");

    assert.ok(vscodeCss.includes("--acp-font-size-normal: 1rem;"));
    for (const token of [
      "xxs",
      "xs",
      "sm",
      "base",
      "md",
      "lg",
      "prose",
      "code",
      "code-block",
      "caption",
    ]) {
      assert.ok(
        vscodeCss.includes(
          `--acp-font-size-${token}: var(--acp-font-size-normal);`
        ),
        `Expected ${token} to use the configured normal size`
      );
    }
    assert.ok(vscodeCss.includes("--acp-font-size-heading-1: clamp("));
    assert.ok(vscodeCss.includes("--acp-font-size-heading-2: clamp("));
    assert.ok(
      vscodeCss.includes(
        "--acp-font-size-heading-3: clamp(1rem, 1.05rem, calc(1rem + 1px));"
      )
    );

    for (const selector of [".permission-dialog", ".confirm-dialog"]) {
      assert.ok(
        cssBlock(mainCss, selector).includes(
          "max-height: calc(100vh - 24px);"
        )
      );
    }
    for (const selector of [
      ".permission-dialog-body",
      ".confirm-dialog-body",
    ]) {
      const block = cssBlock(mainCss, selector);
      assert.ok(block.includes("min-height: 0;"));
      assert.ok(block.includes("overflow-y: auto;"));
    }
  });

  test("main and dynamic feature text avoid fixed small pixel sizes", () => {
    const mainCss = readRepoFile("media/main.css");
    const dynamicFeatureCss = [
      readRepoFile("src/features/table-copy/styles.ts"),
      readRepoFile("src/features/multi-session/styles.ts"),
      readRepoFile("src/features/latest-user-prompt-tip/styles.ts"),
      readRepoFile("src/features/message-queue/styles.ts"),
    ].join("\n");

    assert.strictEqual(/font-size:\s*(?:10|11|13)px/.test(mainCss), false);
    assert.strictEqual(
      /font-size:\s*(?:10|11|13)px/.test(dynamicFeatureCss),
      false
    );
    assert.strictEqual(/font-size:\s*12px/.test(dynamicFeatureCss), false);

    const fixed12Matches = [...mainCss.matchAll(/font-size:\s*12px/g)].map(
      (match) => match.index ?? -1
    );
    assert.strictEqual(fixed12Matches.length, 1);
    const fixed12Context = mainCss.slice(
      Math.max(0, fixed12Matches[0] - 80),
      fixed12Matches[0] + 80
    );
    assert.ok(fixed12Context.includes(".dropdown-chevron .codicon"));
  });

  test("representative icon declarations remain fixed pixel geometry", () => {
    const mainCss = readRepoFile("media/main.css");
    const tableCopyStyles = readRepoFile("src/features/table-copy/styles.ts");
    const multiSessionStyles = readRepoFile("src/features/multi-session/styles.ts");

    assert.ok(
      cssBlock(mainCss, ".dropdown-chevron .codicon").includes(
        "font-size: 12px;"
      )
    );
    assert.ok(
      cssBlock(mainCss, ".action-btn .codicon").includes(
        "font-size: 14px;"
      )
    );
    assert.ok(tableCopyStyles.includes(".table-copy-button .codicon{font-size:14px"));
    assert.ok(multiSessionStyles.includes(".multi-session-button .codicon{font-size:14px"));
  });

  test("webview applies and removes the CSS font-size variable", () => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    const controller = new ChatFontSizeWebviewController(dom.window.document);
    const style = dom.window.document.documentElement.style;

    assert.strictEqual(
      controller.handleMessage({
        type: CHAT_FONT_SIZE_MESSAGE_TYPE,
        fontSize: 18,
      } as any),
      true
    );
    assert.strictEqual(style.getPropertyValue("--acp-chat-font-size"), "18px");

    controller.handleMessage({
      type: CHAT_FONT_SIZE_MESSAGE_TYPE,
      fontSize: null,
    } as any);
    assert.strictEqual(style.getPropertyValue("--acp-chat-font-size"), "");
  });
});
