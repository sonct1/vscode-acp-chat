/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as vscode from "vscode";
import { JSDOM } from "jsdom";
import {
  CHAT_AUTO_SCROLL_MESSAGE_TYPE,
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT,
  CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT,
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MIN,
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MAX,
  CHAT_AUTO_SCROLL_SETTLE_FRAMES_MIN,
  CHAT_AUTO_SCROLL_SETTLE_FRAMES_MAX,
  normalizeChatAutoScrollSettings,
  isChatAutoScrollSettingsMessage,
} from "../../features/chat-auto-scroll";
import { ChatAutoScrollHostController } from "../../features/chat-auto-scroll/host";
import {
  ChatAutoScrollWebviewController,
  registerChatAutoScrollWebviewFeature,
} from "../../features/chat-auto-scroll/webview";
import { registerHostFeatures } from "../../features/register-host";
import { MessageListComponent } from "../../views/webview/component/message-list";
import { ChipRendererComponent } from "../../views/webview/component/chip-renderer";
import { MessageRouter } from "../../views/webview/message-router";
import { EventBus } from "../../views/webview/event-bus";
import type { WebviewContext } from "../../views/webview/context";
import type {
  MessageScrollPosition,
  WebviewEventMap,
} from "../../views/webview/types";

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

function createChatAutoScrollWebviewMock(applied: unknown[] = []) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><div id="chat-input-area"></div></body></html>'
  );
  let scrollPositionHandler:
    | ((position: MessageScrollPosition) => void)
    | undefined;
  let disposed = false;
  let lastScrollToBottomForce: boolean | undefined;

  const mockController = {
    getDocument: () => dom.window.document,
    messageList: {
      applyAutoScrollSettings: (settings: unknown) => applied.push(settings),
      onScrollPositionChange: (
        handler: (position: MessageScrollPosition) => void
      ) => {
        scrollPositionHandler = handler;
        handler({ isNearBottom: true, scrollTop: 0 });
        return {
          dispose: () => {
            disposed = true;
          },
        };
      },
      scrollToBottom: (force?: boolean) => {
        lastScrollToBottomForce = force;
      },
    },
  };

  return {
    dom,
    mockController,
    emitScrollPosition(position: MessageScrollPosition): void {
      scrollPositionHandler?.(position);
    },
    getJumpButton(): HTMLButtonElement | null {
      return dom.window.document.querySelector<HTMLButtonElement>(
        ".chat-auto-scroll-jump-button"
      );
    },
    wasScrollSubscriptionDisposed(): boolean {
      return disposed;
    },
    getLastScrollToBottomForce(): boolean | undefined {
      return lastScrollToBottomForce;
    },
  };
}

suite("chat-auto-scroll feature", () => {
  let previousBottomThreshold: number | undefined;
  let previousSettleFrames: number | undefined;
  let previousMultiSessionEnabled: boolean | undefined;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    previousBottomThreshold = config.inspect<number>(
      "autoScroll.bottomThreshold"
    )?.globalValue;
    previousSettleFrames = config.inspect<number>(
      "autoScroll.settleFrames"
    )?.globalValue;
    previousMultiSessionEnabled = config.inspect<boolean>(
      "multiSession.enabled"
    )?.globalValue;
    await config.update(
      "autoScroll.bottomThreshold",
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "autoScroll.settleFrames",
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT,
      vscode.ConfigurationTarget.Global
    );
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update(
      "autoScroll.bottomThreshold",
      previousBottomThreshold,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "autoScroll.settleFrames",
      previousSettleFrames,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "multiSession.enabled",
      previousMultiSessionEnabled,
      vscode.ConfigurationTarget.Global
    );
  });

  // -------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------

  test("normalizes default, invalid, rounded, and clamped values", () => {
    // bottomThresholdPx normalization
    const defaults = normalizeChatAutoScrollSettings({
      bottomThresholdPx: undefined,
      settleFrames: undefined,
    });
    assert.strictEqual(
      defaults.bottomThresholdPx,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT
    );
    assert.strictEqual(
      defaults.settleFrames,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT
    );

    // Invalid types
    const invalid = normalizeChatAutoScrollSettings({
      bottomThresholdPx: "abc",
      settleFrames: null,
    });
    assert.strictEqual(
      invalid.bottomThresholdPx,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT
    );
    assert.strictEqual(
      invalid.settleFrames,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT
    );

    // Non-finite
    const nan = normalizeChatAutoScrollSettings({
      bottomThresholdPx: Number.NaN,
      settleFrames: Number.POSITIVE_INFINITY,
    });
    assert.strictEqual(
      nan.bottomThresholdPx,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT
    );
    assert.strictEqual(
      nan.settleFrames,
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT
    );

    // Clamping below min
    const tooLow = normalizeChatAutoScrollSettings({
      bottomThresholdPx: -10,
      settleFrames: -5,
    });
    assert.strictEqual(
      tooLow.bottomThresholdPx,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MIN
    );
    assert.strictEqual(tooLow.settleFrames, CHAT_AUTO_SCROLL_SETTLE_FRAMES_MIN);

    // Clamping above max
    const tooHigh = normalizeChatAutoScrollSettings({
      bottomThresholdPx: 999,
      settleFrames: 50,
    });
    assert.strictEqual(
      tooHigh.bottomThresholdPx,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MAX
    );
    assert.strictEqual(tooHigh.settleFrames, CHAT_AUTO_SCROLL_SETTLE_FRAMES_MAX);

    // Rounding
    const rounded = normalizeChatAutoScrollSettings({
      bottomThresholdPx: 47.3,
      settleFrames: 2.8,
    });
    assert.strictEqual(rounded.bottomThresholdPx, 47);
    assert.strictEqual(rounded.settleFrames, 3);

    // Valid values pass through
    const valid = normalizeChatAutoScrollSettings({
      bottomThresholdPx: 250,
      settleFrames: 5,
    });
    assert.strictEqual(valid.bottomThresholdPx, 250);
    assert.strictEqual(valid.settleFrames, 5);
  });

  // -------------------------------------------------------------------
  // Host sends settings from configuration
  // -------------------------------------------------------------------

  test("host sends normalized settings from configuration", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update(
      "autoScroll.bottomThreshold",
      200,
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "autoScroll.settleFrames",
      5,
      vscode.ConfigurationTarget.Global
    );

    const messages: Record<string, unknown>[] = [];
    const controller = new ChatAutoScrollHostController({
      postMessage: (message) => messages.push(message),
    });

    try {
      controller.sendSettings();
      const last = messages.at(-1) as any;
      assert.strictEqual(last?.type, CHAT_AUTO_SCROLL_MESSAGE_TYPE);
      assert.ok(last?.settings);
      assert.strictEqual(last.settings.bottomThresholdPx, 200);
      assert.strictEqual(last.settings.settleFrames, 5);
    } finally {
      controller.dispose();
    }
  });

  test("host resends settings when configuration changes", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update(
      "autoScroll.bottomThreshold",
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_DEFAULT,
      vscode.ConfigurationTarget.Global
    );

    const messages: Record<string, unknown>[] = [];
    const controller = new ChatAutoScrollHostController({
      postMessage: (message) => messages.push(message),
    });

    try {
      await config.update(
        "autoScroll.bottomThreshold",
        150,
        vscode.ConfigurationTarget.Global
      );
      const message = await waitForMessage(messages, 1);
      assert.strictEqual((message as any)?.settings?.bottomThresholdPx, 150);
    } finally {
      controller.dispose();
    }
  });

  test("host resends when settleFrames changes", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    await config.update(
      "autoScroll.settleFrames",
      CHAT_AUTO_SCROLL_SETTLE_FRAMES_DEFAULT,
      vscode.ConfigurationTarget.Global
    );

    const messages: Record<string, unknown>[] = [];
    const controller = new ChatAutoScrollHostController({
      postMessage: (message) => messages.push(message),
    });

    try {
      await config.update(
        "autoScroll.settleFrames",
        8,
        vscode.ConfigurationTarget.Global
      );
      const message = await waitForMessage(messages, 1);
      assert.strictEqual((message as any)?.settings?.settleFrames, 8);
    } finally {
      controller.dispose();
    }
  });

  // -------------------------------------------------------------------
  // Registry availability
  // -------------------------------------------------------------------

  test("host feature registers in registry", async () => {
    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update(
        "multiSession.enabled",
        false,
        vscode.ConfigurationTarget.Global
      );

    const features = registerHostFeatures({
      globalState: new TestMemento(),
      postMessage: () => {},
    });

    try {
      assert.ok(features.chatAutoScroll);
      assert.strictEqual(features.multiSession, undefined);
    } finally {
      features.chatAutoScroll?.dispose();
      features.multiSession?.dispose();
    }
  });

  test("webview feature can be created independently", () => {
    const { dom, mockController, getJumpButton } =
      createChatAutoScrollWebviewMock();
    const wvc = registerChatAutoScrollWebviewFeature(mockController as any);

    try {
      const button = getJumpButton();
      assert.ok(wvc instanceof ChatAutoScrollWebviewController);
      assert.ok(button);
      assert.strictEqual(button.parentElement?.id, "chat-input-area");
      assert.strictEqual(button.hidden, true);
      assert.strictEqual(
        button.getAttribute("aria-label"),
        "Scroll to latest message"
      );
      assert.ok(
        dom.window.document.querySelector('style[data-feature="chat-auto-scroll"]')
      );
    } finally {
      wvc.dispose();
      dom.window.close();
    }
  });

  // -------------------------------------------------------------------
  // Message type guard
  // -------------------------------------------------------------------

  test("isChatAutoScrollSettingsMessage validates messages correctly", () => {
    assert.strictEqual(
      isChatAutoScrollSettingsMessage({
        type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
        settings: { bottomThresholdPx: 100, settleFrames: 3 },
      }),
      true
    );
    assert.strictEqual(
      isChatAutoScrollSettingsMessage({
        type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
        settings: { bottomThresholdPx: 0, settleFrames: 1 },
      }),
      true
    );
    assert.strictEqual(
      isChatAutoScrollSettingsMessage({
        type: "other.type",
        settings: { bottomThresholdPx: 100, settleFrames: 3 },
      }),
      false
    );
    assert.strictEqual(
      isChatAutoScrollSettingsMessage({
        type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
        settings: { bottomThresholdPx: "100", settleFrames: 3 },
      }),
      false
    );
    assert.strictEqual(
      isChatAutoScrollSettingsMessage({
        type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
        settings: null,
      }),
      false
    );
    assert.strictEqual(isChatAutoScrollSettingsMessage(null), false);
    assert.strictEqual(isChatAutoScrollSettingsMessage(undefined), false);
    assert.strictEqual(isChatAutoScrollSettingsMessage("string"), false);
  });

  // -------------------------------------------------------------------
  // Webview / message-list applies settings
  // -------------------------------------------------------------------

  test("webview controller forwards settings to message-list", () => {
    const applied: any[] = [];
    const { dom, mockController } = createChatAutoScrollWebviewMock(applied);
    const wvc = new ChatAutoScrollWebviewController(mockController as any);

    try {
      const result = wvc.handleMessage({
        type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
        settings: { bottomThresholdPx: 75, settleFrames: 6 },
      } as any);
      assert.strictEqual(result, true);
      assert.strictEqual(applied.length, 1);
      assert.strictEqual(applied[0].bottomThresholdPx, 75);
      assert.strictEqual(applied[0].settleFrames, 6);

      const result2 = wvc.handleMessage({
        type: "some.other.message",
      } as any);
      assert.strictEqual(result2, undefined);
      assert.strictEqual(applied.length, 1);
    } finally {
      wvc.dispose();
      dom.window.close();
    }
  });

  test("webview controller normalizes before forwarding", () => {
    const applied: any[] = [];
    const { dom, mockController } = createChatAutoScrollWebviewMock(applied);
    const wvc = new ChatAutoScrollWebviewController(mockController as any);

    try {
      wvc.handleMessage({
        type: CHAT_AUTO_SCROLL_MESSAGE_TYPE,
        settings: { bottomThresholdPx: 999, settleFrames: 50 },
      } as any);
      assert.strictEqual(applied.length, 1);
      assert.strictEqual(
        applied[0].bottomThresholdPx,
        CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD_MAX
      );
      assert.strictEqual(
        applied[0].settleFrames,
        CHAT_AUTO_SCROLL_SETTLE_FRAMES_MAX
      );
    } finally {
      wvc.dispose();
      dom.window.close();
    }
  });

  test("jump button appears away from bottom and forces scroll to latest", () => {
    const {
      dom,
      mockController,
      emitScrollPosition,
      getJumpButton,
      getLastScrollToBottomForce,
    } = createChatAutoScrollWebviewMock();
    const wvc = new ChatAutoScrollWebviewController(mockController as any);

    try {
      const button = getJumpButton();
      assert.ok(button);
      assert.strictEqual(button.hidden, true);

      emitScrollPosition({ isNearBottom: false, scrollTop: 420 });
      assert.strictEqual(button.hidden, false);

      button.click();
      assert.strictEqual(getLastScrollToBottomForce(), true);

      emitScrollPosition({ isNearBottom: true, scrollTop: 800 });
      assert.strictEqual(button.hidden, true);
    } finally {
      wvc.dispose();
      dom.window.close();
    }
  });

  test("jump button dispose removes DOM and scroll subscription", () => {
    const { dom, mockController, getJumpButton, wasScrollSubscriptionDisposed } =
      createChatAutoScrollWebviewMock();
    const wvc = new ChatAutoScrollWebviewController(mockController as any);

    assert.ok(getJumpButton());
    wvc.dispose();

    assert.strictEqual(getJumpButton(), null);
    assert.strictEqual(wasScrollSubscriptionDisposed(), true);
    assert.strictEqual(
      dom.window.document.querySelector('style[data-feature="chat-auto-scroll"]'),
      null
    );
    dom.window.close();
  });

  test("message-list uses configurable bottom threshold", () => {
    const dom = new JSDOM(
      "<!DOCTYPE html><html><head></head><body></body></html>"
    );
    const doc = dom.window.document;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    dom.window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      frames.set(frameId, callback);
      return frameId;
    }) as typeof dom.window.requestAnimationFrame;
    dom.window.cancelAnimationFrame = ((frame: number) => {
      frames.delete(frame);
    }) as typeof dom.window.cancelAnimationFrame;

    function flushFrames(): void {
      for (let guard = 0; guard < 20 && frames.size > 0; guard++) {
        const queued = [...frames.entries()];
        frames.clear();
        for (const [frameId, callback] of queued) callback(frameId);
      }
    }

    // Create minimal elements
    const containerEl = doc.createElement("div");
    containerEl.id = "messages-container";
    const messagesEl = doc.createElement("div");
    messagesEl.id = "messages";
    messagesEl.style.overflow = "auto";
    messagesEl.style.height = "200px";
    let scrollTop = 0;
    let scrollHeight = 1000;
    Object.defineProperty(messagesEl, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(messagesEl, "clientHeight", {
      configurable: true,
      get: () => 200,
    });
    Object.defineProperty(messagesEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const typingIndicatorEl = doc.createElement("div");
    typingIndicatorEl.id = "typing-indicator";
    const welcomeView = doc.createElement("div");
    welcomeView.id = "welcome-view";

    doc.body.appendChild(containerEl);
    doc.body.appendChild(messagesEl);
    doc.body.appendChild(typingIndicatorEl);
    doc.body.appendChild(welcomeView);

    // Populate enough content to make the element scrollable
    for (let i = 0; i < 100; i++) {
      const line = doc.createElement("div");
      line.style.height = "3px";
      messagesEl.appendChild(line);
    }

    const ctx = {
      vscode: {
        postMessage: () => {},
        getState: <T>(): T | undefined => undefined,
        setState: <T>(state: T): T => state,
      } as any,
      doc,
      win: dom.window as unknown as Window,
      stateService: {
        restore: (): undefined => undefined,
        save: () => {},
        flush: () => {},
      } as any,
      messageRouter: new MessageRouter(),
      eventBus: new EventBus<WebviewEventMap>(),
    } as WebviewContext;

    const chipRenderer = new ChipRendererComponent(ctx);
    const messageList = new MessageListComponent(ctx, {
      elements: {
        containerEl,
        messagesEl,
        typingIndicatorEl,
        welcomeView,
      },
      chipRenderer,
    });

    // 150 px from the bottom is not near bottom with a 100 px threshold.
    messageList.applyAutoScrollSettings({
      bottomThresholdPx: 100,
      settleFrames: 1,
    });
    messageList.setScrollTop(650);
    assert.ok(
      !messageList.getScrollPosition().isNearBottom,
      "Expected isNearBottom=false with 100px threshold at 150px from bottom"
    );

    // Non-forced scrolls respect the disabled auto-scroll state.
    messageList.scrollToBottom();
    flushFrames();
    assert.strictEqual(scrollTop, 650);

    // Raising the threshold live re-enables auto-scroll at the current position.
    messageList.applyAutoScrollSettings({
      bottomThresholdPx: 200,
      settleFrames: 1,
    });
    assert.ok(
      messageList.getScrollPosition().isNearBottom,
      "Expected isNearBottom=true with 200px threshold at 150px from bottom"
    );

    messageList.scrollToBottom();
    flushFrames();
    assert.strictEqual(scrollTop, messagesEl.scrollHeight);

    const positions: MessageScrollPosition[] = [];
    const subscription = messageList.onScrollPositionChange((position) => {
      positions.push(position);
    });
    try {
      messageList.setScrollTop(650);
      scrollHeight = 200;
      messageList.clear();
      assert.strictEqual(scrollTop, 0);
      assert.strictEqual(positions.at(-1)?.isNearBottom, true);
    } finally {
      subscription.dispose();
    }
  });
});
