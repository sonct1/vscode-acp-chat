/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import { JSDOM } from "jsdom";
import { ACPClient } from "../acp/client";
import { PermissionDialog } from "../views/webview/widget/permission-dialog";
import { registerPermissionUiWebviewFeature } from "../features/permission-ui/webview";
import { RequestPermissionRequest } from "@agentclientprotocol/sdk";

function permission(requestId: string, title: string) {
  return {
    requestId,
    toolCall: { kind: "edit", title },
    options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
  };
}

suite("Permission Request Tests", () => {
  let client: ACPClient;

  setup(() => {
    client = new ACPClient();
  });

  teardown(() => {
    client.dispose();
  });

  test("should fail closed when no listeners are registered", async () => {
    const params: RequestPermissionRequest = {
      sessionId: "test-session",
      toolCall: {
        toolCallId: "test-tool-1",
        kind: "edit",
        title: "Write to file",
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    };

    const response = await (client as any).handleRequestPermission(params);

    assert.strictEqual(response.outcome.outcome, "cancelled");
  });

  test("should call registered listener and use its response", async () => {
    const params: RequestPermissionRequest = {
      sessionId: "test-session",
      toolCall: {
        toolCallId: "test-tool-2",
        kind: "edit",
        title: "Write to file",
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    };

    client.setOnPermissionRequest(async (p) => {
      assert.strictEqual(p.toolCall.toolCallId, "test-tool-2");
      return {
        outcome: {
          outcome: "selected",
          optionId: "deny",
        },
      };
    });

    const response = await (client as any).handleRequestPermission(params);
    assert.strictEqual(response.outcome.outcome, "selected");
    assert.strictEqual(response.outcome.optionId, "deny");
  });

  test("should fail closed if listener throws", async () => {
    const params: RequestPermissionRequest = {
      sessionId: "test-session",
      toolCall: {
        toolCallId: "test-tool-3",
        kind: "edit",
        title: "Write to file",
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    };

    client.setOnPermissionRequest(async () => {
      throw new Error("Listener failed");
    });

    const response = await (client as any).handleRequestPermission(params);
    assert.strictEqual(response.outcome.outcome, "cancelled");
  });

  test("webview owner replacement accepts new owner and ignores stale previous owner", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    let replaceSurface = () => {};
    const feature = registerPermissionUiWebviewFeature({
      getContext: () => ({
        vscode: {
          postMessage: () => {},
          getState: () => undefined,
          setState: <T>(state: T) => state,
        },
        doc: dom.window.document,
        win: dom.window as unknown as Window,
      }),
      getEventBus: () => ({
        on: (_event: string, callback: () => void) => {
          replaceSurface = callback;
        },
      }),
      messageList: {
        getBlockManager: () => ({ getToolBlock: () => null }),
        getIsGenerating: () => false,
        scrollToBottom: () => {},
      },
      inputPanel: { setGenerating: () => {} },
    } as any);

    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-a",
      activationRevision: 1,
      stateRevision: 1,
      pending: [permission("perm-a", "A")],
    } as any);
    assert.strictEqual(dom.window.document.querySelector(".permission-tool-title")?.textContent, "A");

    replaceSurface();
    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-b",
      activationRevision: 2,
      stateRevision: 1,
      pending: [permission("perm-b", "B")],
    } as any);
    assert.strictEqual(dom.window.document.querySelector(".permission-tool-title")?.textContent, "B");

    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-a",
      activationRevision: 1,
      stateRevision: 2,
      pending: [permission("perm-a2", "stale A")],
    } as any);
    assert.strictEqual(dom.window.document.querySelector(".permission-tool-title")?.textContent, "B");
  });

  test("webview rejects stale permission state revisions", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const feature = registerPermissionUiWebviewFeature({
      getContext: () => ({
        vscode: { postMessage: () => {}, getState: () => undefined, setState: <T>(state: T) => state },
        doc: dom.window.document,
        win: dom.window as unknown as Window,
      }),
      getEventBus: () => ({ on: () => {} }),
      messageList: {
        getBlockManager: () => ({ getToolBlock: () => null }),
        getIsGenerating: () => false,
        scrollToBottom: () => {},
      },
      inputPanel: { setGenerating: () => {} },
    } as any);

    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-a",
      activationRevision: 1,
      stateRevision: 2,
      pending: [permission("perm-new", "new")],
    } as any);
    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-a",
      activationRevision: 1,
      stateRevision: 1,
      pending: [permission("perm-old", "old")],
    } as any);
    assert.strictEqual(dom.window.document.querySelectorAll(".permission-dialog-overlay").length, 1);
    assert.strictEqual(dom.window.document.querySelector(".permission-tool-title")?.textContent, "new");

    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-a",
      activationRevision: 1,
      stateRevision: 3,
      pending: [],
    } as any);
    assert.strictEqual(dom.window.document.querySelectorAll(".permission-dialog-overlay").length, 0);

    feature.handleMessage({
      type: "feature.permission-ui.state",
      ownerId: "owner-a",
      activationRevision: 1,
      stateRevision: 2,
      pending: [permission("perm-old", "old")],
    } as any);
    assert.strictEqual(dom.window.document.querySelectorAll(".permission-dialog-overlay").length, 0);
  });

  test("PermissionDialog restores original generating baseline after all dismissals", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const posted: unknown[] = [];
    let generating = false;
    const generatingChanges: boolean[] = [];
    const dialog = new PermissionDialog(
      {
        vscode: {
          postMessage: (message: unknown) => posted.push(message),
          getState: () => undefined,
          setState: <T>(state: T) => state,
        },
        doc: dom.window.document,
        win: dom.window as unknown as Window,
        stateService: {} as any,
        messageRouter: {} as any,
        eventBus: {} as any,
      },
      () => ({ getToolBlock: () => null }) as any,
      () => generating,
      (value) => {
        generating = value;
        generatingChanges.push(value);
      },
      () => {}
    );

    dialog.reconcile("legacy", [permission("perm-1", "One"), permission("perm-2", "Two")]);
    const buttons = Array.from(dom.window.document.querySelectorAll("button"));
    (buttons[1] as HTMLButtonElement).click();
    assert.strictEqual(generating, true);
    (buttons[0] as HTMLButtonElement).click();
    assert.strictEqual(generating, false);
    assert.deepStrictEqual(generatingChanges.at(-1), false);
    assert.strictEqual(posted.length, 2);
  });

  test("PermissionDialog posts selected outcome with reject optionId", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const posted: unknown[] = [];
    const dialog = new PermissionDialog(
      {
        vscode: {
          postMessage: (message: unknown) => posted.push(message),
          getState: () => undefined,
          setState: <T>(state: T) => state,
        },
        doc: dom.window.document,
        win: dom.window as unknown as Window,
        stateService: {} as any,
        messageRouter: {} as any,
        eventBus: {} as any,
      },
      () => ({ getToolBlock: () => null }) as any,
      () => false,
      () => {},
      () => {}
    );

    dialog.reconcile("legacy", [
      {
        requestId: "perm-deny",
        toolCall: { kind: "edit", title: "Write" },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          {
            optionId: "deny-always",
            kind: "reject_always",
            name: "Deny always",
          },
        ],
      },
    ]);

    const denyButton = Array.from(
      dom.window.document.querySelectorAll("button")
    ).find((button) => button.textContent?.includes("Deny always"));
    assert.ok(denyButton);
    (denyButton as HTMLButtonElement).click();

    assert.deepStrictEqual(posted, [
      {
        type: "permissionResponse",
        requestId: "perm-deny",
        ownerId: "legacy",
        outcome: { outcome: "selected", optionId: "deny-always" },
      },
    ]);
  });
});
