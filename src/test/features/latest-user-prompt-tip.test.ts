/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import { JSDOM, DOMWindow } from "jsdom";
import { WebviewController } from "../../views/webview/main";
import type { VsCodeApi } from "../../views/webview/types";

function createMockVsCodeApi(): VsCodeApi {
  let state: Record<string, unknown> = {};
  return {
    postMessage: () => {},
    getState: <T>() => state as T,
    setState: <T>(newState: T) => {
      state = newState as Record<string, unknown>;
      return newState;
    },
  };
}

function createWebviewHTML(): string {
  return `<!DOCTYPE html><html><head></head><body>
    <div id="welcome-view" class="welcome-view"></div>
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

suite("latest user prompt tip feature", () => {
  let dom: JSDOM;
  let document: Document;
  let window: DOMWindow;
  let controller: WebviewController;
  let messagesEl: HTMLElement;
  let scrollHeight: number;
  let clientHeight: number;
  let scrollTop: number;
  let containerTop: number;
  let containerHeight: number;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  setup(() => {
    dom = new JSDOM(createWebviewHTML(), {
      runScripts: "dangerously",
      url: "https://localhost",
    });
    document = dom.window.document;
    window = dom.window;
    (global as any).Node = window.Node;
    (global as any).NodeFilter = window.NodeFilter;

    frames = new Map<number, FrameRequestCallback>();
    nextFrameId = 1;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      frames.set(frameId, callback);
      return frameId;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((frame: number) => {
      frames.delete(frame);
    }) as typeof window.cancelAnimationFrame;

    messagesEl = document.getElementById("messages")!;
    scrollHeight = 1000;
    clientHeight = 200;
    scrollTop = 800;
    containerTop = 0;
    containerHeight = 200;
    Object.defineProperty(messagesEl, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(messagesEl, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(messagesEl, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    messagesEl.getBoundingClientRect = () =>
      ({
        top: containerTop,
        bottom: containerTop + containerHeight,
        height: containerHeight,
        left: 0,
        right: 600,
        width: 600,
        x: 0,
        y: containerTop,
        toJSON: () => ({}),
      }) as DOMRect;

    controller = new WebviewController(
      createMockVsCodeApi(),
      document,
      window as unknown as Window
    );
  });

  teardown(() => {
    dom.window.close();
  });

  function flushFrames(): void {
    for (let guard = 0; guard < 20 && frames.size > 0; guard++) {
      const queued = [...frames.entries()];
      frames.clear();
      for (const [frameId, callback] of queued) callback(frameId);
    }
  }

  async function settle(): Promise<void> {
    await Promise.resolve();
    flushFrames();
    await Promise.resolve();
    flushFrames();
  }

  function getTip(): HTMLElement {
    return document.querySelector<HTMLElement>(".latest-user-prompt-tip")!;
  }

  function getPreview(): HTMLElement {
    return document.querySelector<HTMLElement>(
      ".latest-user-prompt-tip-preview"
    )!;
  }

  function setDocumentOffset(element: HTMLElement, offsetTop: number): void {
    element.getBoundingClientRect = () =>
      ({
        top: offsetTop - scrollTop,
        bottom: offsetTop - scrollTop + 40,
        height: 40,
        left: 0,
        right: 600,
        width: 600,
        x: 0,
        y: offsetTop - scrollTop,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  function appendUserMessage(text: string, offsetTop: number): HTMLElement {
    const message = document.createElement("div");
    message.className = "message user";
    const content = document.createElement("div");
    content.className = "message-content-text";
    content.textContent = text;
    message.appendChild(content);
    setDocumentOffset(message, offsetTop);
    messagesEl.appendChild(message);
    return message;
  }

  function appendImageOnlyUserMessage(offsetTop: number): HTMLElement {
    const message = document.createElement("div");
    message.className = "message user";
    setDocumentOffset(message, offsetTop);
    messagesEl.appendChild(message);
    return message;
  }

  function appendAssistantMessage(text: string): HTMLElement {
    const message = document.createElement("div");
    message.className = "message assistant";
    const block = document.createElement("div");
    block.className = "block-text";
    block.textContent = text;
    message.appendChild(block);
    messagesEl.appendChild(message);
    return message;
  }

  async function scrollTo(value: number): Promise<void> {
    scrollTop = value;
    messagesEl.dispatchEvent(new window.Event("scroll"));
    await settle();
  }

  async function appendThreeTurns(): Promise<void> {
    appendUserMessage("Prompt one", 0);
    appendAssistantMessage("Response one");
    appendUserMessage("Prompt two", 300);
    appendAssistantMessage("Response two");
    appendUserMessage("Prompt three", 600);
    appendAssistantMessage("Response three");
    scrollHeight = 1000;
    clientHeight = 200;
    await settle();
  }

  test("inserts a hidden tip above the prompt input", () => {
    const tip = getTip();
    const inputContainer = document.getElementById("input-container")!;

    assert.strictEqual(tip.hidden, true);
    assert.strictEqual(tip.tabIndex, 0);
    assert.strictEqual(tip.nextElementSibling, inputContainer);
    assert.strictEqual(
      tip.querySelector(".latest-user-prompt-tip-label")?.textContent,
      "Tip:"
    );
  });

  test("selects the active prompt while scrolling across three turn boundaries", async () => {
    await appendThreeTurns();

    await scrollTo(550);
    assert.strictEqual(getTip().hidden, false);
    assert.strictEqual(getPreview().textContent, "Prompt three");

    await scrollTo(320);
    assert.strictEqual(getPreview().textContent, "Prompt two");
    assert.strictEqual(
      getTip().getAttribute("aria-label"),
      "Prompt for current conversation turn: Prompt two"
    );

    await scrollTo(80);
    assert.strictEqual(getPreview().textContent, "Prompt one");

    await scrollTo(320);
    assert.strictEqual(getPreview().textContent, "Prompt two");

    await scrollTo(550);
    assert.strictEqual(getPreview().textContent, "Prompt three");
  });

  test("uses a deterministic inclusive boundary at the reading anchor", async () => {
    await appendThreeTurns();

    await scrollTo(250);
    assert.strictEqual(getPreview().textContent, "Prompt two");

    await scrollTo(249);
    assert.strictEqual(getPreview().textContent, "Prompt one");
  });

  test("hides while near the bottom", async () => {
    await appendThreeTurns();

    await scrollTo(700);
    assert.strictEqual(getTip().hidden, true);
  });

  test("does not switch prompts for assistant streaming mutations below the reading position", async () => {
    await appendThreeTurns();
    await scrollTo(320);
    assert.strictEqual(getPreview().textContent, "Prompt two");

    const assistant = appendAssistantMessage("Streaming output");
    await settle();
    assert.strictEqual(getPreview().textContent, "Prompt two");

    assistant.querySelector(".block-text")!.textContent = "Streaming output continues";
    await settle();
    assert.strictEqual(getPreview().textContent, "Prompt two");
  });

  test("hides for active non-text turns without falling back to stale text", async () => {
    appendUserMessage("Prompt one", 0);
    appendAssistantMessage("Response one");
    appendImageOnlyUserMessage(300);
    appendAssistantMessage("Image response");
    appendUserMessage("Prompt three", 600);
    await settle();

    await scrollTo(80);
    assert.strictEqual(getPreview().textContent, "Prompt one");

    await scrollTo(320);
    assert.strictEqual(getTip().hidden, true);
    assert.strictEqual(getPreview().textContent, "");
  });

  test("hides after chat clear and rebuilds from replacement transcript", async () => {
    appendUserMessage("Old session prompt", 0);
    await settle();
    await scrollTo(0);
    assert.strictEqual(getPreview().textContent, "Old session prompt");

    controller.handleMessage({ type: "chatCleared" });
    await settle();
    assert.strictEqual(getTip().hidden, true);

    appendUserMessage("Active session prompt", 0);
    controller.messageList.setScrollTop(0);
    await settle();

    assert.strictEqual(getTip().hidden, false);
    assert.strictEqual(getPreview().textContent, "Active session prompt");
  });

  test("restores a multi-session snapshot at the prompt for the restored viewport", async () => {
    controller.handleMessage({
      type: "feature.multi-session.chatState",
      enabled: true,
      activeLocalSessionId: "session-1",
      activationRevision: 1,
      active: {
        localSessionId: "session-1",
        agentId: "pi",
        agentName: "Pi",
        title: "Session 1",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
        pendingPermissionCount: 0,
      },
      aggregate: { open: 1, running: 0, awaitingPermission: 0 },
    } as any);

    await controller.handleMessage({
      type: "feature.multi-session.snapshot",
      activeLocalSessionId: "session-1",
      activationRevision: 1,
      session: {
        localSessionId: "session-1",
        agentId: "pi",
        agentName: "Pi",
        title: "Session 1",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
        pendingPermissionCount: 0,
      },
      transcript: [
        { seq: 1, createdAt: 1, message: { type: "userMessage", text: "Restored one" } },
        { seq: 2, createdAt: 2, message: { type: "userMessage", text: "Restored two" } },
      ],
      lastSeq: 2,
      isGenerating: false,
    } as any);

    const userMessages = messagesEl.querySelectorAll<HTMLElement>(".message.user");
    setDocumentOffset(userMessages[0], 0);
    setDocumentOffset(userMessages[1], 300);
    scrollHeight = 1000;
    controller.messageList.setScrollTop(250);
    await settle();

    assert.strictEqual(scrollTop, 250);
    assert.strictEqual(getTip().hidden, false);
    assert.strictEqual(getPreview().textContent, "Restored two");
  });

  test("recomputes from the resized viewport anchor without rebuilding entries", async () => {
    await appendThreeTurns();

    await scrollTo(249);
    assert.strictEqual(getPreview().textContent, "Prompt one");

    containerHeight = 204;
    window.dispatchEvent(new window.Event("resize"));
    await settle();

    assert.strictEqual(getPreview().textContent, "Prompt two");
  });

  test("refreshes near-bottom visibility when resize crosses the threshold", async () => {
    await appendThreeTurns();

    scrollTop = 650;
    clientHeight = 200;
    messagesEl.dispatchEvent(new window.Event("scroll"));
    await settle();
    assert.strictEqual(getTip().hidden, false);

    clientHeight = 260;
    window.dispatchEvent(new window.Event("resize"));
    await settle();
    assert.strictEqual(getTip().hidden, true);

    clientHeight = 200;
    window.dispatchEvent(new window.Event("resize"));
    await settle();
    assert.strictEqual(getTip().hidden, false);
  });

  test("notifies scroll subscribers continuously away from bottom and stops after disposal", async () => {
    const positions: Array<{ isNearBottom: boolean; scrollTop: number }> = [];
    const subscription = controller.messageList.onScrollPositionChange(
      (position) => positions.push(position)
    );

    await scrollTo(400);
    await scrollTo(350);
    controller.messageList.setScrollTop(800);
    await settle();
    subscription.dispose();
    await scrollTo(300);

    assert.deepStrictEqual(positions, [
      { isNearBottom: true, scrollTop: 800 },
      { isNearBottom: false, scrollTop: 400 },
      { isNearBottom: false, scrollTop: 350 },
      { isNearBottom: true, scrollTop: 800 },
    ]);
  });
});
