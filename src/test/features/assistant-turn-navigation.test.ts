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

  test("renders only for completed assistant responses and ignores empty streamEnd", async () => {
    controller.handleMessage({ type: "streamEnd" });
    await settleNavigation();

    assert.strictEqual(
      messagesEl.querySelectorAll(".message.assistant").length,
      0
    );
    assert.strictEqual(getNavigator()?.hidden ?? true, true);

    addCompletedAssistantTurn("Question 1", "Answer 1");
    await settleNavigation();
    assert.strictEqual(getNavigator()?.hidden ?? true, true);

    addCompletedAssistantTurn("Question 2", "Answer 2");
    await settleNavigation();

    assert.strictEqual(getNavigator()?.hidden, false);
    assert.strictEqual(getCounter(), "Assistant 2 / 2");
    assert.strictEqual(
      messagesEl.querySelectorAll(".message.assistant .message-actions").length,
      2
    );
  });

  test("buttons navigate previous and next between assistant responses", async () => {
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
    assistantMsgs[2].focus();

    getNavButton("previous").click();
    await settleNavigation();

    assert.strictEqual(document.activeElement, assistantMsgs[1]);
    assert.ok(
      assistantMsgs[1].querySelector(".block-tool"),
      "expected a tool block before the answer text"
    );
    assert.strictEqual(
      scrollTargets.at(-1),
      assistantMsgs[1].querySelector(".block-text")
    );
    assert.strictEqual(getCounter(), "Assistant 2 / 3");
    assert.strictEqual(
      assistantMsgs[1].classList.contains("assistant-turn-highlight"),
      true
    );
    assert.strictEqual(getNavButton("previous").disabled, false);
    assert.strictEqual(getNavButton("next").disabled, false);

    getNavButton("next").click();
    await settleNavigation();

    assert.strictEqual(document.activeElement, assistantMsgs[2]);
    assert.strictEqual(getCounter(), "Assistant 3 / 3");
    assert.strictEqual(getNavButton("next").disabled, true);

    getNavButton("previous").click();
    getNavButton("previous").click();
    await settleNavigation();

    assert.strictEqual(document.activeElement, assistantMsgs[0]);
    assert.strictEqual(getCounter(), "Assistant 1 / 3");
    assert.strictEqual(getNavButton("previous").disabled, true);
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
      const scrollTarget = assistantMsgs[index].querySelector<HTMLElement>(
        ".block-text"
      );
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
