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
  let disableAutoScrollCount: number;
  let scrolledElements: HTMLElement[];
  let scrollIntoViewOptions: ScrollIntoViewOptions[];
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
    disableAutoScrollCount = 0;
    scrolledElements = [];
    scrollIntoViewOptions = [];
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
    const originalDisableAutoScroll =
      controller.messageList.disableAutoScroll.bind(controller.messageList);
    controller.messageList.disableAutoScroll = () => {
      disableAutoScrollCount++;
      originalDisableAutoScroll();
    };
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

  function getPreviousButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
      ".latest-user-prompt-tip-action-previous"
    )!;
  }

  function getNextButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
      ".latest-user-prompt-tip-action-next"
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
    element.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      scrolledElements.push(element);
      scrollIntoViewOptions.push(
        typeof options === "object" && options !== null ? options : {}
      );
    };
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

  test("inserts a hidden accessible tip row above the prompt input", () => {
    const tip = getTip();
    const inputContainer = document.getElementById("input-container")!;
    const children = Array.from(tip.children);

    assert.strictEqual(tip.hidden, true);
    assert.strictEqual(tip.tabIndex, 0);
    assert.strictEqual(tip.getAttribute("role"), "note");
    assert.strictEqual(tip.parentElement, inputContainer.parentElement);
    assert.strictEqual(
      Array.from(inputContainer.parentElement?.children ?? []).indexOf(tip) <
        Array.from(inputContainer.parentElement?.children ?? []).indexOf(
          inputContainer
        ),
      true
    );
    assert.strictEqual(children[0]?.className, "latest-user-prompt-tip-label");
    assert.strictEqual(children[1]?.className, "latest-user-prompt-tip-preview");
    assert.strictEqual(children[2]?.className, "latest-user-prompt-tip-actions");
    assert.strictEqual(
      tip.querySelector(".latest-user-prompt-tip-label")?.textContent,
      "Tip:"
    );

    const actions = tip.querySelector<HTMLElement>(
      ".latest-user-prompt-tip-actions"
    )!;
    assert.strictEqual(actions.getAttribute("role"), "group");
    assert.strictEqual(
      actions.getAttribute("aria-label"),
      "Navigate user prompts"
    );
    assert.strictEqual(getPreviousButton().type, "button");
    assert.strictEqual(
      getPreviousButton().getAttribute("aria-label"),
      "Navigate to previous user prompt"
    );
    assert.strictEqual(
      getPreviousButton().getAttribute("acp-title"),
      "Navigate to previous user prompt"
    );
    assert.strictEqual(
      getPreviousButton().querySelector(".codicon-chevron-up") !== null,
      true
    );
    assert.strictEqual(getNextButton().type, "button");
    assert.strictEqual(
      getNextButton().getAttribute("aria-label"),
      "Navigate to next user prompt"
    );
    assert.strictEqual(
      getNextButton().getAttribute("acp-title"),
      "Navigate to next user prompt"
    );
    assert.strictEqual(
      getNextButton().querySelector(".codicon-chevron-down") !== null,
      true
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

  test("navigates to previous and next textual prompts with smooth scrolling", async () => {
    await appendThreeTurns();
    await scrollTo(320);
    let bubbledClicks = 0;
    getTip().addEventListener("click", () => {
      bubbledClicks++;
    });

    const previousClickResult = getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(previousClickResult, false);
    assert.strictEqual(bubbledClicks, 0);
    assert.strictEqual(disableAutoScrollCount, 1);
    assert.strictEqual(scrolledElements[0].textContent, "Prompt one");
    assert.deepStrictEqual(scrollIntoViewOptions[0], {
      behavior: "smooth",
      block: "start",
    });
    assert.strictEqual(getPreview().textContent, "Prompt one");

    const nextClickResult = getNextButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(nextClickResult, false);
    assert.strictEqual(bubbledClicks, 0);
    assert.strictEqual(disableAutoScrollCount, 2);
    assert.strictEqual(scrolledElements[1].textContent, "Prompt two");
    assert.deepStrictEqual(scrollIntoViewOptions[1], {
      behavior: "smooth",
      block: "start",
    });
    assert.strictEqual(getPreview().textContent, "Prompt two");
  });

  test("keeps repeated navigation anchored during intermediate smooth-scroll events", async () => {
    await appendThreeTurns();
    await scrollTo(550);

    getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(getPreview().textContent, "Prompt two");
    assert.strictEqual(scrolledElements[0].textContent, "Prompt two");

    await scrollTo(500);
    assert.strictEqual(getPreview().textContent, "Prompt two");

    getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(scrolledElements[1].textContent, "Prompt one");
    assert.strictEqual(getPreview().textContent, "Prompt one");
  });

  test("disables prompt navigation while the session surface is locked", async () => {
    await appendThreeTurns();
    await scrollTo(320);

    controller.setSessionTransitionLocked(true);
    await settle();
    assert.strictEqual(getTip().hasAttribute("inert"), true);
    assert.strictEqual(getTip().getAttribute("aria-busy"), "true");
    assert.strictEqual(getPreviousButton().disabled, true);
    assert.strictEqual(getNextButton().disabled, true);

    getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(scrolledElements.length, 0);
    assert.strictEqual(disableAutoScrollCount, 0);

    controller.setSessionTransitionLocked(false);
    await settle();
    assert.strictEqual(getTip().hasAttribute("inert"), false);
    assert.strictEqual(getTip().getAttribute("aria-busy"), "false");
    assert.strictEqual(getPreviousButton().disabled, false);
    assert.strictEqual(getNextButton().disabled, false);
  });

  test("disables navigation at boundaries without wrap-around", async () => {
    await appendThreeTurns();

    await scrollTo(80);
    assert.strictEqual(getPreviousButton().disabled, true);
    assert.strictEqual(getNextButton().disabled, false);
    getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(disableAutoScrollCount, 0);
    assert.strictEqual(scrolledElements.length, 0);
    assert.strictEqual(getPreview().textContent, "Prompt one");

    await scrollTo(550);
    assert.strictEqual(getPreviousButton().disabled, false);
    assert.strictEqual(getNextButton().disabled, true);
    getNextButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(disableAutoScrollCount, 0);
    assert.strictEqual(scrolledElements.length, 0);
    assert.strictEqual(getPreview().textContent, "Prompt three");
  });

  test("tracks duplicate prompt text by active index", async () => {
    const first = appendUserMessage("Repeat prompt", 0);
    appendAssistantMessage("Response one");
    const second = appendUserMessage("Repeat prompt", 300);
    appendAssistantMessage("Response two");
    await settle();

    await scrollTo(320);
    assert.strictEqual(getPreview().textContent, "Repeat prompt");
    assert.strictEqual(getNextButton().disabled, true);
    assert.strictEqual(getPreviousButton().disabled, false);

    getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(scrolledElements[0], first);
    assert.strictEqual(getPreview().textContent, "Repeat prompt");
    assert.strictEqual(getPreviousButton().disabled, true);
    assert.strictEqual(getNextButton().disabled, false);

    getNextButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(scrolledElements[1], second);
    assert.strictEqual(getPreviousButton().disabled, false);
    assert.strictEqual(getNextButton().disabled, true);
  });

  test("skips non-text user turns as navigation targets", async () => {
    appendUserMessage("Prompt one", 0);
    appendAssistantMessage("Response one");
    appendImageOnlyUserMessage(300);
    appendAssistantMessage("Image response");
    appendUserMessage("Prompt three", 600);
    await settle();

    await scrollTo(80);
    getNextButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(scrolledElements[0].textContent, "Prompt three");
    assert.strictEqual(getPreview().textContent, "Prompt three");

    getPreviousButton().dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    assert.strictEqual(scrolledElements[1].textContent, "Prompt one");
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
