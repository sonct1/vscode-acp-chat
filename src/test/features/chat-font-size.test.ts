/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
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
