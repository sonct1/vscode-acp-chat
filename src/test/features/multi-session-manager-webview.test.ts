/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import { JSDOM } from "jsdom";
import { MultiSessionManagerWebview } from "../../features/multi-session/manager-webview";

suite("multi-session manager webview", () => {
  let dom: JSDOM;
  let messages: unknown[];

  setup(() => {
    messages = [];
    dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://localhost",
    });
    (dom.window as any).acquireVsCodeApi = () => ({
      postMessage: (message: unknown) => messages.push(message),
    });
    (globalThis as any).acquireVsCodeApi = (dom.window as any).acquireVsCodeApi;
  });

  teardown(() => {
    delete (globalThis as any).acquireVsCodeApi;
    dom.window.close();
  });

  test("initial managerState renders rows and summary", () => {
    new MultiSessionManagerWebview(dom.window.document);

    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: {
            open: 2,
            running: 1,
            awaitingPermission: 1,
            awaitingInput: 0,
          },
          agents: [],
          selectedAgentId: "test-agent",
          sessions: [
            {
              localSessionId: "local-a",
              acpSessionId: "acp-a",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "A",
              status: "running",
              createdAt: 1,
              updatedAt: 2,
              pendingPermissionCount: 0,
              pendingElicitationCount: 0,
            },
            {
              localSessionId: "local-b",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "B",
              status: "awaiting_permission",
              createdAt: 1,
              updatedAt: 3,
              pendingPermissionCount: 1,
              pendingElicitationCount: 0,
            },
          ],
        },
      })
    );

    const summary =
      dom.window.document.querySelector(".manager-summary")?.textContent ?? "";
    assert.ok(summary.includes("Running 1"));
    assert.ok(summary.includes("Permission 1"));
    assert.ok(summary.includes("Input 0"));
    assert.ok(summary.includes("Open 2"));
    assert.ok(!summary.includes("Unread"));
    assert.strictEqual(
      dom.window.document.querySelectorAll(".session-row").length,
      2
    );
    assert.ok(dom.window.document.querySelector(".session-row.active"));
    assert.ok(dom.window.document.querySelector(".badge-permission"));
    assert.ok(!dom.window.document.body.textContent?.includes("unread"));
    assert.ok(!dom.window.document.body.textContent?.includes("diff"));
    assert.ok(!dom.window.document.body.textContent?.includes("conflicted"));
  });

  test("running filter includes starting/loading/cancelling states", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: {
            open: 2,
            running: 1,
            awaitingPermission: 0,
            awaitingInput: 0,
          },
          agents: [],
          selectedAgentId: "test-agent",
          sessions: [
            {
              localSessionId: "local-a",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "A",
              status: "starting",
              createdAt: 1,
              updatedAt: 2,
              pendingPermissionCount: 0,
              pendingElicitationCount: 0,
            },
            {
              localSessionId: "local-b",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "B",
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
              pendingPermissionCount: 0,
              pendingElicitationCount: 0,
            },
          ],
        },
      })
    );

    const filter = dom.window.document.querySelector(
      ".manager-select"
    ) as HTMLSelectElement;
    filter.value = "running";
    filter.dispatchEvent(new dom.window.Event("change"));

    assert.strictEqual(
      dom.window.document.querySelectorAll(".session-row").length,
      1
    );
    assert.ok(
      dom.window.document
        .querySelector(".session-row")
        ?.textContent?.includes("A")
    );
  });

  test("narrow sidebar styles stack filters and prevent overflow", () => {
    new MultiSessionManagerWebview(dom.window.document);

    const styles = [...dom.window.document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .join("\n");

    assert.ok(styles.includes("@media(max-width:360px)"));
    assert.ok(styles.includes(".manager-filters{flex-direction:column}"));
    assert.ok(styles.includes("height:100vh;min-height:0"));
    assert.ok(styles.includes("flex:1;flex-direction:column"));
    assert.ok(styles.includes("min-height:0;overflow:auto"));
  });

  test("error rows expose Retry action", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: {
            open: 1,
            running: 0,
            awaitingPermission: 0,
            awaitingInput: 0,
          },
          agents: [],
          selectedAgentId: "test-agent",
          sessions: [
            {
              localSessionId: "local-a",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "A",
              status: "error",
              createdAt: 1,
              updatedAt: 1,
              pendingPermissionCount: 0,
              pendingElicitationCount: 0,
              lastError: "connect failed",
            },
          ],
        },
      })
    );

    const retryButton = dom.window.document.querySelector(
      'button[aria-label="Retry"]'
    ) as HTMLButtonElement;
    assert.ok(retryButton);
    assert.ok(dom.window.document.body.textContent?.includes("connect failed"));
    retryButton.click();

    assert.ok(
      messages.some(
        (message: any) =>
          message.type === "feature.multi-session.retry" &&
          message.localSessionId === "local-a"
      )
    );
  });

  test("permission-waiting rows expose non-destructive stop action", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: {
            open: 1,
            running: 0,
            awaitingPermission: 1,
            awaitingInput: 0,
          },
          agents: [],
          selectedAgentId: "test-agent",
          sessions: [
            {
              localSessionId: "local-a",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "A",
              status: "awaiting_permission",
              createdAt: 1,
              updatedAt: 1,
              pendingPermissionCount: 1,
              pendingElicitationCount: 0,
            },
          ],
        },
      })
    );

    const reviewButton = dom.window.document.querySelector(
      'button[aria-label="Review permission"]'
    ) as HTMLButtonElement;
    assert.ok(reviewButton.querySelector(".codicon-eye"));
    reviewButton.click();

    const busyReviewButton = dom.window.document.querySelector(
      'button[aria-label="Opening permission review"]'
    ) as HTMLButtonElement;
    assert.ok(busyReviewButton.querySelector(".codicon-loading"));
    assert.strictEqual(busyReviewButton.getAttribute("aria-busy"), "true");
    assert.strictEqual(
      dom.window.document.querySelector('button[aria-label="Opening chat"]'),
      null
    );
    assert.ok(
      messages.some(
        (message: any) =>
          message.type === "feature.multi-session.reviewPermission" &&
          message.localSessionId === "local-a" &&
          message.focusChat === true
      )
    );

    const stopButton = dom.window.document.querySelector(
      'button[aria-label="Stop chat"]'
    ) as HTMLButtonElement;
    assert.ok(stopButton);
    stopButton.click();
    assert.ok(
      messages.some(
        (message: any) =>
          message.type === "feature.multi-session.stop" &&
          message.localSessionId === "local-a"
      )
    );
  });

  test("input-waiting rows expose review input and stop actions", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-b",
          aggregate: {
            open: 1,
            running: 0,
            awaitingPermission: 0,
            awaitingInput: 1,
          },
          agents: [],
          selectedAgentId: "test-agent",
          sessions: [
            {
              localSessionId: "local-a",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "Needs input",
              status: "awaiting_input",
              createdAt: 1,
              updatedAt: 1,
              pendingPermissionCount: 0,
              pendingElicitationCount: 1,
            },
          ],
        },
      })
    );

    assert.ok(dom.window.document.querySelector(".badge-input"));
    const reviewButton = dom.window.document.querySelector(
      'button[aria-label="Review input"]'
    ) as HTMLButtonElement;
    reviewButton.click();
    assert.ok(
      messages.some(
        (message: any) =>
          message.type === "feature.multi-session.reviewInput" &&
          message.localSessionId === "local-a" &&
          message.focusChat === true
      )
    );
    assert.ok(
      dom.window.document.querySelector('button[aria-label="Stop chat"]')
    );
  });

  test("orders all sessions by creation time regardless of status or activity", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-b",
          aggregate: {
            open: 3,
            running: 1,
            awaitingPermission: 1,
            awaitingInput: 0,
          },
          agents: [],
          selectedAgentId: "test-agent",
          sessions: [
            {
              localSessionId: "local-a",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "Older but recently updated",
              status: "idle",
              createdAt: 1,
              updatedAt: 100,
              pendingPermissionCount: 0,
              pendingElicitationCount: 0,
            },
            {
              localSessionId: "local-b",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "Newer but quiet",
              status: "idle",
              createdAt: 2,
              updatedAt: 10,
              pendingPermissionCount: 0,
              pendingElicitationCount: 0,
            },
            {
              localSessionId: "local-c",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "Oldest and needs permission",
              status: "awaiting_permission",
              createdAt: 0,
              updatedAt: 200,
              pendingPermissionCount: 1,
              pendingElicitationCount: 0,
            },
          ],
        },
      })
    );

    const rows = [...dom.window.document.querySelectorAll(".session-row")];
    assert.ok(rows[0]?.textContent?.includes("Newer but quiet"));
    assert.ok(rows[1]?.textContent?.includes("Older but recently updated"));
    assert.ok(rows[2]?.textContent?.includes("Oldest and needs permission"));
  });

  test("row actions post selected localSessionId", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: {
            open: 1,
            running: 0,
            awaitingPermission: 0,
            awaitingInput: 0,
          },
          agents: [],
          selectedAgentId: "test-agent",
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
              pendingElicitationCount: 0,
            },
          ],
        },
      })
    );

    const openButton = dom.window.document.querySelector(
      'button[aria-label="Open chat"]'
    ) as HTMLButtonElement;
    assert.ok(openButton.querySelector(".codicon-comment"));
    assert.strictEqual(
      openButton.hasAttribute("title"),
      false,
      "Open chat should not use the native title tooltip because it renders with an unwanted border"
    );
    assert.strictEqual(openButton.textContent, "");
    openButton.click();

    const openingButton = dom.window.document.querySelector(
      'button[aria-label="Opening chat"]'
    ) as HTMLButtonElement;
    assert.ok(openingButton.querySelector(".codicon-loading"));
    assert.strictEqual(openingButton.getAttribute("aria-busy"), "true");
    assert.strictEqual(openingButton.textContent, "");

    assert.ok(
      messages.some(
        (message: any) =>
          message.type === "feature.multi-session.activate" &&
          message.localSessionId === "local-a" &&
          message.focusChat === true
      )
    );
  });
});
