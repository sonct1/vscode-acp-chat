/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import { JSDOM, DOMWindow } from "jsdom";
import { WebviewController } from "../../views/webview/main";
import type { VsCodeApi } from "../../views/webview/types";

function createMockVsCodeApi(): VsCodeApi & {
  _getMessages: () => unknown[];
} {
  const messages: unknown[] = [];
  let state: Record<string, unknown> = {};
  return {
    postMessage: (message: unknown) => messages.push(message),
    getState: <T>() => state as T,
    setState: <T>(newState: T) => {
      state = newState as Record<string, unknown>;
      return newState;
    },
    _getMessages: () => messages,
  };
}

function createWebviewHTML(): string {
  return `<!DOCTYPE html><html><head></head><body>
    <div id="welcome-view" class="welcome-view"></div>
    <div id="agent-plan-container"></div>
    <div class="multi-session-header"><button type="button" class="multi-session-open"></button><div class="multi-session-heading"><strong>New chat</strong><span>Idle · PI</span></div></div>
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

suite("assistant-turn-navigation feature", () => {
  let dom: JSDOM;
  let document: Document;
  let window: DOMWindow;
  let controller: WebviewController;
  let headerEl: HTMLElement;
  let messagesEl: HTMLElement;

  setup(() => {
    dom = new JSDOM(createWebviewHTML(), {
      runScripts: "dangerously",
      url: "https://localhost",
    });
    document = dom.window.document;
    window = dom.window;
    (global as any).Node = window.Node;
    (global as any).NodeFilter = window.NodeFilter;
    controller = new WebviewController(
      createMockVsCodeApi(),
      document,
      window as unknown as Window
    );
    headerEl = document.querySelector(".multi-session-header")!;
    messagesEl = document.getElementById("messages")!;
  });

  teardown(() => {
    dom.window.close();
  });

  function addCompletedAssistantTurn(question: string, answer: string): void {
    controller.handleMessage({ type: "userMessage", text: question });
    controller.handleMessage({ type: "streamStart" });
    controller.handleMessage({ type: "streamChunk", text: answer });
    controller.handleMessage({ type: "streamEnd" });
  }

  function addToolThenCompletedAssistantTurn(
    question: string,
    answer: string
  ): void {
    controller.handleMessage({ type: "userMessage", text: question });
    controller.handleMessage({ type: "streamStart" });
    controller.handleMessage({
      type: "toolCallStart",
      toolCallId: `tool-${question}`,
      name: "Edit",
      kind: "edit",
    });
    controller.handleMessage({
      type: "toolCallComplete",
      toolCallId: `tool-${question}`,
      status: "completed",
      title: "Edit",
      kind: "edit",
      rawInput: { description: "edit" },
    });
    controller.handleMessage({ type: "streamChunk", text: answer });
    controller.handleMessage({ type: "streamEnd" });
  }

  function addToolOnlyAssistantTurn(question: string): void {
    controller.handleMessage({ type: "userMessage", text: question });
    controller.handleMessage({ type: "streamStart" });
    controller.handleMessage({
      type: "toolCallStart",
      toolCallId: `tool-only-${question}`,
      name: "Edit",
      kind: "edit",
    });
    controller.handleMessage({
      type: "toolCallComplete",
      toolCallId: `tool-only-${question}`,
      status: "completed",
      title: "Edit",
      kind: "edit",
      rawInput: { description: "edit" },
    });
    controller.handleMessage({ type: "streamEnd" });
  }

  async function settleNavigation(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  function getNavigator(): HTMLElement | null {
    return headerEl.querySelector(".assistant-turn-navigator");
  }

  function getCounter(): string {
    return (
      getNavigator()?.querySelector(".assistant-turn-counter")?.textContent ??
      ""
    ).trim();
  }

  function getNavButton(direction: "previous" | "next"): HTMLButtonElement {
    const label =
      direction === "previous"
        ? "Previous assistant response"
        : "Next assistant response";
    const button = getNavigator()?.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`
    );
    assert.ok(button, `expected ${direction} assistant turn button`);
    return button;
  }

  function setReadingGeometry(targetTops: number[]): HTMLElement[] {
    const targets = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(
        ".message.assistant .block-text"
      )
    ).filter((target) => (target.textContent ?? "").trim().length > 0);
    assert.strictEqual(targets.length, targetTops.length);

    Object.defineProperty(messagesEl, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 0,
          height: 800,
          bottom: 800,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    });

    targets.forEach((target, index) => {
      const top = targetTops[index];
      Object.defineProperty(target, "getBoundingClientRect", {
        configurable: true,
        value: () =>
          ({
            top,
            height: 40,
            bottom: top + 40,
            left: 0,
            right: 300,
            width: 300,
            x: 0,
            y: top,
            toJSON: () => ({}),
          }) as DOMRect,
      });
    });

    return targets;
  }

  test("renders for one completed assistant response and ignores empty streamEnd", async () => {
    controller.handleMessage({ type: "streamEnd" });
    await settleNavigation();

    assert.strictEqual(
      messagesEl.querySelectorAll(".message.assistant").length,
      0
    );
    assert.strictEqual(getNavigator()?.hidden ?? true, true);

    addCompletedAssistantTurn("Question 1", "Answer 1");
    await settleNavigation();

    assert.strictEqual(getNavigator()?.hidden, false);
    assert.strictEqual(getCounter(), "Assistant 1 / 1");
    assert.strictEqual(getNavButton("previous").disabled, false);
    assert.strictEqual(getNavButton("next").disabled, false);
    assert.strictEqual(
      messagesEl.querySelectorAll(".message.assistant .message-actions").length,
      1
    );
  });

  test("keeps navigation enabled for one assistant response", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    await settleNavigation();

    const assistantMessage =
      messagesEl.querySelector<HTMLElement>(".message.assistant");
    assert.ok(assistantMessage);

    getNavButton("previous").click();
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMessage.querySelector(".block-text")
    );

    getNavButton("next").click();
    assert.strictEqual(scrollTargets.length, 2);
    assert.strictEqual(getCounter(), "Assistant 1 / 1");
    assert.strictEqual(getNavButton("previous").disabled, false);
    assert.strictEqual(getNavButton("next").disabled, false);
  });

  test("selects the nearest next response after the reading anchor", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    addCompletedAssistantTurn("Question 4", "Answer 4");
    await settleNavigation();

    const targets = setReadingGeometry([100, 180, 210, 300]);

    getNavButton("next").click();
    assert.strictEqual(scrollTargets.at(-1), targets[2]);
    assert.strictEqual(getCounter(), "Assistant 3 / 4");

    messagesEl.dispatchEvent(new window.Event("scroll"));
    getNavButton("next").click();
    assert.strictEqual(scrollTargets.at(-1), targets[3]);
    assert.strictEqual(getCounter(), "Assistant 4 / 4");
  });

  test("selects the nearest response by geometry even when DOM order differs", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    addCompletedAssistantTurn("Question 4", "Answer 4");
    await settleNavigation();

    const targets = setReadingGeometry([100, 300, 210, 180]);

    getNavButton("next").click();
    assert.strictEqual(scrollTargets.at(-1), targets[2]);

    messagesEl.dispatchEvent(new window.WheelEvent("wheel"));
    getNavButton("previous").click();
    assert.strictEqual(scrollTargets.at(-1), targets[3]);
  });

  test("uses geometry when a response is exactly at the reading anchor", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    addCompletedAssistantTurn("Question 4", "Answer 4");
    await settleNavigation();

    const targets = setReadingGeometry([100, 300, 200, 180]);

    getNavButton("next").click();
    assert.strictEqual(scrollTargets.at(-1), targets[1]);

    messagesEl.dispatchEvent(new window.WheelEvent("wheel"));
    getNavButton("previous").click();
    assert.strictEqual(scrollTargets.at(-1), targets[3]);
  });

  test("selects the nearest previous response before the reading anchor", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    addCompletedAssistantTurn("Question 4", "Answer 4");
    await settleNavigation();

    const targets = setReadingGeometry([100, 180, 210, 300]);

    getNavButton("previous").click();
    assert.strictEqual(scrollTargets.at(-1), targets[1]);
    assert.strictEqual(getCounter(), "Assistant 2 / 4");

    messagesEl.dispatchEvent(new window.Event("scroll"));
    getNavButton("previous").click();
    assert.strictEqual(scrollTargets.at(-1), targets[0]);
    assert.strictEqual(getCounter(), "Assistant 1 / 4");
  });

  test("skips a response within the anchor epsilon for directional lookup", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    await settleNavigation();

    const targets = setReadingGeometry([100, 200.5, 300]);

    getNavButton("next").click();
    assert.strictEqual(scrollTargets.at(-1), targets[2]);

    messagesEl.dispatchEvent(new window.WheelEvent("wheel"));
    getNavButton("previous").click();
    assert.strictEqual(scrollTargets.at(-1), targets[0]);
  });

  test("clamps directional navigation when the anchor is outside all responses", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    await settleNavigation();

    const targets = setReadingGeometry([100, 180]);
    getNavButton("next").click();
    assert.strictEqual(scrollTargets.at(-1), targets[1]);

    messagesEl.dispatchEvent(new window.WheelEvent("wheel"));
    setReadingGeometry([210, 300]);
    getNavButton("previous").click();
    assert.strictEqual(scrollTargets.at(-1), targets[0]);
  });

  test("buttons navigate previous and next without wrapping", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addToolThenCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    await settleNavigation();

    const assistantMsgs = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );

    getNavButton("previous").click();
    await settleNavigation();

    assert.ok(
      assistantMsgs[1].querySelector(".block-tool"),
      "expected a tool block before the answer text"
    );
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[1].querySelector(".block-text")
    );
    assert.strictEqual(getCounter(), "Assistant 2 / 3");
    assert.strictEqual(getNavButton("previous").disabled, false);
    assert.strictEqual(getNavButton("next").disabled, false);

    getNavButton("next").click();
    await settleNavigation();

    assert.strictEqual(getCounter(), "Assistant 3 / 3");
    assert.strictEqual(getNavButton("next").disabled, false);

    const scrollCountAtLast = scrollTargets.length;
    getNavButton("next").click();
    await settleNavigation();

    assert.strictEqual(scrollTargets.length, scrollCountAtLast + 1);
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[2].querySelector(".block-text")
    );
    assert.strictEqual(getCounter(), "Assistant 3 / 3");

    getNavButton("previous").click();
    getNavButton("previous").click();
    await settleNavigation();

    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[0].querySelector(".block-text")
    );
    assert.strictEqual(getCounter(), "Assistant 1 / 3");

    const scrollCountAtFirst = scrollTargets.length;
    getNavButton("previous").click();
    await settleNavigation();

    assert.strictEqual(scrollTargets.length, scrollCountAtFirst + 1);
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[0].querySelector(".block-text")
    );
    assert.strictEqual(getCounter(), "Assistant 1 / 3");
  });

  test("skips completed assistant turns without text", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addToolOnlyAssistantTurn("Question 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    await settleNavigation();

    const assistantMsgs = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );
    assert.strictEqual(assistantMsgs.length, 3);
    assert.strictEqual(getCounter(), "Assistant 2 / 2");

    getNavButton("previous").click();

    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[0].querySelector(".block-text")
    );
    assert.notStrictEqual(scrollTargets.at(-1), assistantMsgs[1]);
    assert.strictEqual(getCounter(), "Assistant 1 / 2");
  });

  test("preserves focused navigable turn when focus moves to the header button", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    await settleNavigation();

    const assistantMsgs = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );
    setReadingGeometry([210, 300, 400]);

    assistantMsgs[1].focus();
    const previousButton = getNavButton("previous");
    previousButton.focus();
    previousButton.click();

    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[0].querySelector(".block-text")
    );
  });

  test("preserves focused tool-only turn when focus moves to the header button", async () => {
    const scrollTargets: HTMLElement[] = [];
    (window.HTMLElement.prototype as any).scrollIntoView = function () {
      scrollTargets.push(this as HTMLElement);
    };

    addCompletedAssistantTurn("Question 1", "Answer 1");
    addToolOnlyAssistantTurn("Question 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    await settleNavigation();

    const assistantMsgs = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );
    setReadingGeometry([300, 400]);

    assistantMsgs[1].focus();
    const previousButton = getNavButton("previous");
    previousButton.focus();
    previousButton.click();
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[0].querySelector(".block-text")
    );

    messagesEl.dispatchEvent(new window.WheelEvent("wheel"));
    assistantMsgs[1].focus();
    const nextButton = getNavButton("next");
    nextButton.focus();
    nextButton.click();
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[2].querySelector(".block-text")
    );
  });

  test("uses the visible tool-only turn as the counter anchor", async () => {
    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addToolOnlyAssistantTurn("Question 3");
    await settleNavigation();

    const assistantMsgs = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );
    const toolOnlyBlock = assistantMsgs[2].querySelector<HTMLElement>(
      ".block-tool"
    );
    assert.ok(toolOnlyBlock, "expected trailing tool-only assistant turn");

    Object.defineProperty(messagesEl, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 0,
          height: 400,
          bottom: 400,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => toolOnlyBlock,
    });
    const textTargets = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(
        ".message.assistant .block-text"
      )
    ).filter((target) => (target.textContent ?? "").trim().length > 0);
    [20, 60].forEach((top, index) => {
      Object.defineProperty(textTargets[index], "getBoundingClientRect", {
        configurable: true,
        value: () =>
          ({
            top,
            height: 40,
            bottom: top + 40,
            left: 0,
            right: 300,
            width: 300,
            x: 0,
            y: top,
            toJSON: () => ({}),
          }) as DOMRect,
      });
    });

    messagesEl.dispatchEvent(new window.Event("scroll"));
    assert.strictEqual(getCounter(), "Assistant 2 / 2");
  });

  test("updates the counter from manual scroll position", async () => {
    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    addCompletedAssistantTurn("Question 3", "Answer 3");
    await settleNavigation();

    const assistantMsgs = Array.from(
      messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );
    Object.defineProperty(messagesEl, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 0,
          height: 400,
          bottom: 400,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    [320, 80, 700].forEach((top, index) => {
      const scrollTarget =
        assistantMsgs[index].querySelector<HTMLElement>(".block-text");
      assert.ok(scrollTarget, "expected answer text block");
      Object.defineProperty(scrollTarget, "getBoundingClientRect", {
        configurable: true,
        value: () =>
          ({
            top,
            height: 80,
            bottom: top + 80,
            left: 0,
            right: 0,
            width: 0,
            x: 0,
            y: top,
            toJSON: () => ({}),
          }) as DOMRect,
      });
    });

    messagesEl.dispatchEvent(new window.Event("scroll"));

    assert.strictEqual(getCounter(), "Assistant 2 / 3");
    assert.strictEqual(getNavButton("previous").disabled, false);
    assert.strictEqual(getNavButton("next").disabled, false);
  });

  test("rebuilds after chat clear and multi-session snapshot replay", async () => {
    addCompletedAssistantTurn("Question 1", "Answer 1");
    addCompletedAssistantTurn("Question 2", "Answer 2");
    await settleNavigation();
    assert.strictEqual(getNavigator()?.hidden, false);

    controller.handleMessage({ type: "chatCleared" });
    await settleNavigation();
    assert.strictEqual(getNavigator()?.hidden ?? true, true);

    await controller.handleMessage({
      type: "feature.multi-session.state",
      enabled: true,
      activeLocalSessionId: "local-a",
      activationRevision: 1,
      sessions: [
        {
          localSessionId: "local-a",
          agentId: "test-agent",
          agentName: "Test Agent",
          title: "A",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
          pendingPermissionCount: 0,
        },
      ],
      aggregate: { running: 0, awaitingPermission: 0 },
    } as any);

    await controller.handleMessage({
      type: "feature.multi-session.snapshot",
      activeLocalSessionId: "local-a",
      activationRevision: 1,
      session: {
        localSessionId: "local-a",
        agentId: "test-agent",
        agentName: "Test Agent",
        title: "A",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
        pendingPermissionCount: 0,
      },
      transcript: [
        { seq: 1, createdAt: 1, message: { type: "userMessage", text: "Q1" } },
        { seq: 2, createdAt: 2, message: { type: "streamStart" } },
        { seq: 3, createdAt: 3, message: { type: "streamChunk", text: "A1" } },
        { seq: 4, createdAt: 4, message: { type: "streamEnd" } },
        { seq: 5, createdAt: 5, message: { type: "userMessage", text: "Q2" } },
        { seq: 6, createdAt: 6, message: { type: "streamStart" } },
        { seq: 7, createdAt: 7, message: { type: "streamChunk", text: "A2" } },
        { seq: 8, createdAt: 8, message: { type: "streamEnd" } },
      ],
      lastSeq: 8,
      metadata: null,
      contextUsage: null,
      diffChanges: [],
      pendingPermissions: [],
      isGenerating: false,
    } as any);
    await settleNavigation();

    assert.strictEqual(getNavigator()?.hidden, false);
    assert.strictEqual(getCounter(), "Assistant 2 / 2");
  });
});
