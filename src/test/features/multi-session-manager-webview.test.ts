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
          aggregate: { open: 2, running: 1, awaitingPermission: 1, unread: 3 },
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
              unreadCount: 0,
              pendingPermissionCount: 0,
              diffCount: 1,
              conflictedDiffCount: 0,
            },
            {
              localSessionId: "local-b",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "B",
              status: "awaiting_permission",
              createdAt: 1,
              updatedAt: 3,
              unreadCount: 3,
              pendingPermissionCount: 1,
              diffCount: 0,
              conflictedDiffCount: 0,
            },
          ],
        },
      })
    );

    assert.ok(
      dom.window.document
        .querySelector(".manager-summary")
        ?.textContent?.includes("Running 1")
    );
    assert.strictEqual(
      dom.window.document.querySelectorAll(".session-row").length,
      2
    );
    assert.ok(dom.window.document.querySelector(".session-row.active"));
    assert.ok(dom.window.document.querySelector(".badge-permission"));
  });

  test("running filter includes starting/loading/cancelling states", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: { open: 2, running: 1, awaitingPermission: 0, unread: 0 },
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
              unreadCount: 0,
              pendingPermissionCount: 0,
              diffCount: 0,
              conflictedDiffCount: 0,
            },
            {
              localSessionId: "local-b",
              agentId: "test-agent",
              agentName: "Test Agent",
              title: "B",
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
              unreadCount: 0,
              pendingPermissionCount: 0,
              diffCount: 0,
              conflictedDiffCount: 0,
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

  test("permission-waiting rows expose non-destructive stop action", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: { open: 1, running: 0, awaitingPermission: 1, unread: 0 },
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
              unreadCount: 0,
              pendingPermissionCount: 1,
              diffCount: 0,
              conflictedDiffCount: 0,
            },
          ],
        },
      })
    );

    const stopButton = [...dom.window.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop"
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

  test("row actions post selected localSessionId", () => {
    new MultiSessionManagerWebview(dom.window.document);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "feature.multi-session.managerState",
          revision: 1,
          activeLocalSessionId: "local-a",
          aggregate: { open: 1, running: 0, awaitingPermission: 0, unread: 0 },
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
              unreadCount: 0,
              pendingPermissionCount: 0,
              diffCount: 0,
              conflictedDiffCount: 0,
            },
          ],
        },
      })
    );

    const openButton = [...dom.window.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open Chat"
    ) as HTMLButtonElement;
    openButton.click();

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
