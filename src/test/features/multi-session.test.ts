/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as vscode from "vscode";
import { TranscriptStore } from "../../features/multi-session/transcript-store";
import { WorkspaceMutationCoordinator } from "../../features/multi-session/workspace-mutation-coordinator";
import { MultiSessionHostController } from "../../features/multi-session/host";

class TestMemento implements vscode.Memento {
  private readonly state = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.state.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.state.has(key) ? this.state.get(key) : defaultValue) as
      T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.state.delete(key);
    else this.state.set(key, value);
  }
}

class FakeSessionManager {
  supportsLoadSession = true;
  supportsListSessions = true;
  supportsDeleteSession = true;
  newCalls = 0;
  loadCalls: string[] = [];

  syncCapabilities(): void {}

  async newSession(): Promise<{ sessionId: string }> {
    this.newCalls += 1;
    return { sessionId: `acp-${this.newCalls}` };
  }

  async loadSession(sessionId: string): Promise<{ sessionId: string }> {
    this.loadCalls.push(sessionId);
    return { sessionId };
  }

  async listSessions(): Promise<[]> {
    return [];
  }

  async deleteSession(): Promise<void> {}
}

class FakeClient {
  state = "disconnected";
  currentSessionId: string | null = null;
  cancelCalls = 0;
  disposeCalls = 0;
  promptResolvers: Array<(value: { stopReason: string }) => void> = [];
  sessionUpdate?: (update: unknown) => void;
  stateChange?: (state: string) => void;
  permissionRequest?: (params: unknown) => Promise<unknown>;

  async connect(): Promise<void> {
    this.state = "connected";
    this.stateChange?.("connected");
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getSessionMetadata(): any {
    return {
      modes: null,
      models: null,
      genericConfigOptions: [],
      commands: null,
    };
  }

  getNesDocumentCapabilities(): any {
    return {
      didOpen: false,
      didChange: null,
      didClose: false,
      didSave: false,
      didFocus: false,
    };
  }

  getAgentCapabilities(): any {
    return {
      loadSession: true,
      sessionCapabilities: { list: true, delete: true },
    };
  }

  getAgentId(): string {
    return "test-agent";
  }

  getAgentName(): string {
    return "Test Agent";
  }

  setOnSessionUpdate(callback: (update: unknown) => void): () => void {
    this.sessionUpdate = callback;
    return () => {};
  }

  setOnStateChange(callback: (state: string) => void): () => void {
    this.stateChange = callback;
    return () => {};
  }

  setOnStderr(): () => void {
    return () => {};
  }

  setOnReadTextFile(): void {}
  setOnWriteTextFile(): void {}
  setOnCreateTerminal(): void {}
  setOnTerminalOutput(): void {}
  setOnWaitForTerminalExit(): void {}
  setOnKillTerminalCommand(): void {}
  setOnReleaseTerminal(): void {}

  setOnPermissionRequest(
    callback: (params: unknown) => Promise<unknown>
  ): () => void {
    this.permissionRequest = callback;
    return () => {};
  }

  async sendMessage(): Promise<{ stopReason: string }> {
    return new Promise((resolve) => this.promptResolvers.push(resolve));
  }

  resolvePrompt(index = 0, stopReason = "end_turn"): void {
    this.promptResolvers[index]?.({ stopReason });
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }

  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  updateSessionMetadataFromConfigOptions(): void {}
  setLastUsageUpdate(): void {}

  async notifyDidOpenDocument(): Promise<void> {}
  async notifyDidChangeDocument(): Promise<void> {}
  async notifyDidCloseDocument(): Promise<void> {}
  async notifyDidSaveDocument(): Promise<void> {}
  async notifyDidFocusDocument(): Promise<void> {}

  dispose(): void {
    this.disposeCalls += 1;
    this.state = "disconnected";
  }
}

function createController() {
  const messages: Record<string, unknown>[] = [];
  const clients: FakeClient[] = [];
  const managers: FakeSessionManager[] = [];
  const controller = new MultiSessionHostController({
    globalState: new TestMemento(),
    postMessage: (message) => messages.push(message),
    clientFactory: () => {
      const client = new FakeClient();
      const manager = new FakeSessionManager();
      clients.push(client);
      managers.push(manager);
      return {
        client: client as any,
        sessionManager: manager as any,
      };
    },
  });
  return { controller, messages, clients, managers };
}

suite("multi-session feature", () => {
  test("transcript snapshots preserve event order", () => {
    const store = new TranscriptStore();
    store.append({ type: "userMessage", text: "A" });
    store.append({ type: "streamStart" });
    store.append({ type: "streamEnd" });

    assert.deepStrictEqual(
      store.snapshot().map((event) => [event.seq, event.message.type]),
      [
        [1, "userMessage"],
        [2, "streamStart"],
        [3, "streamEnd"],
      ]
    );
  });

  test("adjacent stream chunks compact snapshots but keep raw deltas", () => {
    const store = new TranscriptStore();
    const a = store.append({ type: "streamChunk", text: "hel" });
    const b = store.append({ type: "streamChunk", text: "lo" });
    store.append({ type: "thoughtChunk", text: "a" });
    store.append({ type: "thoughtChunk", text: "b" });

    assert.deepStrictEqual([a.message.text, b.message.text], ["hel", "lo"]);
    assert.deepStrictEqual(
      store.snapshot().map((event) => event.message.text),
      ["hello", "ab"]
    );
    assert.strictEqual(store.lastSeq, 4);
  });

  test("snapshot returns defensive copies", () => {
    const store = new TranscriptStore();
    store.append({ type: "system", text: "original" });
    const snapshot = store.snapshot();
    snapshot[0].message.text = "mutated";
    assert.strictEqual(store.snapshot()[0].message.text, "original");
  });

  test("new chat does not cancel running session and prompts can overlap", async () => {
    const { controller, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(clients.length, 1);

    controller.newChat();
    assert.strictEqual(clients[0].cancelCalls, 0);
    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(clients.length, 2);
    assert.strictEqual(clients[0].promptResolvers.length, 1);
    assert.strictEqual(clients[1].promptResolvers.length, 1);
    assert.strictEqual(
      controller
        .getStateForTest()
        .sessions.filter((session) => session.status === "running").length,
      2
    );

    clients[0].resolvePrompt();
    clients[1].resolvePrompt();
    await Promise.all([promptA, promptB]);
    controller.dispose();
  });

  test("stop routes to selected session only", async () => {
    const { controller, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;

    controller.newChat();
    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionB = controller.getStateForTest().activeLocalSessionId!;

    await controller.stop(sessionA);
    assert.strictEqual(clients[0].cancelCalls, 1);
    assert.strictEqual(clients[1].cancelCalls, 0);

    await controller.stop(sessionB);
    assert.strictEqual(clients[1].cancelCalls, 1);
    clients[0].resolvePrompt();
    clients[1].resolvePrompt();
    await Promise.all([promptA, promptB]);
    controller.dispose();
  });

  test("background updates increment unread and retain duplicate tool ids per runtime", async () => {
    const { controller, messages, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;
    controller.newChat();
    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));

    clients[0].sessionUpdate?.({
      sessionId: "a",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "same-id",
        title: "A tool",
        kind: "read",
        status: "in_progress",
      },
    });
    clients[1].sessionUpdate?.({
      sessionId: "b",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "same-id",
        title: "B tool",
        kind: "read",
        status: "in_progress",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stateA = controller
      .getStateForTest()
      .sessions.find((session) => session.localSessionId === sessionA)!;
    assert.ok(stateA.unreadCount > 0);
    assert.ok(
      messages.some(
        (message) =>
          message.type === "feature.multi-session.delta" &&
          (message.event as any)?.message?.name === "B tool"
      )
    );

    clients[0].resolvePrompt();
    clients[1].resolvePrompt();
    await Promise.all([promptA, promptB]);
    controller.dispose();
  });

  test("background permission is replayed on activation and response resolves owner", async () => {
    const { controller, messages, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;
    controller.newChat();

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-a", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(
      controller
        .getStateForTest()
        .sessions.find((session) => session.localSessionId === sessionA)
        ?.pendingPermissionCount,
      1
    );

    await controller.handleMessage({
      type: "feature.multi-session.activate",
      localSessionId: sessionA,
    });
    const snapshot = [...messages]
      .reverse()
      .find(
        (message) => message.type === "feature.multi-session.snapshot"
      ) as any;
    assert.strictEqual(snapshot.pendingPermissions.length, 1);

    const requestId = snapshot.pendingPermissions[0].requestId;
    await controller.handleCoreMessage({
      type: "permissionResponse",
      requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    clients[0].resolvePrompt();
    await promptA;
    controller.dispose();
  });

  test("process limit preserves the draft session", async () => {
    const original = vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .get<number>("multiSession.maxConcurrentSessions", 4);
    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update("multiSession.maxConcurrentSessions", 1, true);
    try {
      const { controller, clients } = createController();
      const promptA = controller.sendActiveMessage("A");
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.newChat();
      await controller.sendActiveMessage("B");
      const active = controller
        .getStateForTest()
        .sessions.find(
          (session) =>
            session.localSessionId ===
            controller.getStateForTest().activeLocalSessionId
        );
      assert.strictEqual(active?.status, "draft");
      assert.match(active?.lastError ?? "", /Maximum concurrent sessions/);
      clients[0].resolvePrompt();
      await promptA;
      controller.dispose();
    } finally {
      await vscode.workspace
        .getConfiguration("vscode-acp-chat")
        .update("multiSession.maxConcurrentSessions", original, true);
    }
  });

  test("loading an already-open history session only activates it", async () => {
    const { controller, managers } = createController();
    await controller.loadHistorySession("history-1");
    assert.strictEqual(managers[0].loadCalls.length, 1);
    const count = controller.getStateForTest().sessions.length;
    await controller.loadHistorySession("history-1");
    assert.strictEqual(managers[0].loadCalls.length, 1);
    assert.strictEqual(controller.getStateForTest().sessions.length, count);
    controller.dispose();
  });

  test("session manager visibility is host-authoritative and activation closes it", async () => {
    const { controller, messages } = createController();

    await controller.handleMessage({ type: "feature.multi-session.manage" });
    let state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    assert.strictEqual(state.managerOpen, true);

    const active = controller.getStateForTest().activeLocalSessionId!;
    await controller.handleMessage({
      type: "feature.multi-session.activate",
      localSessionId: active,
    });
    state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    assert.strictEqual(state.managerOpen, false);

    await controller.handleMessage({ type: "feature.multi-session.manage" });
    await controller.handleMessage({ type: "feature.multi-session.hideManager" });
    state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    assert.strictEqual(state.managerOpen, false);
    controller.dispose();
  });

  test("closing idle session disposes only its runtime", async () => {
    const { controller, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    clients[0].resolvePrompt();
    await prompt;
    const sessionId = controller.getStateForTest().activeLocalSessionId!;
    await controller.close(sessionId);
    assert.strictEqual(clients[0].disposeCalls, 1);
    assert.strictEqual(controller.getStateForTest().sessions.length, 1);
    assert.strictEqual(
      controller.getStateForTest().sessions[0].status,
      "draft"
    );
    controller.dispose();
  });

  test("safe rollback detects current-content conflict", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const result = await coordinator.safeRollback({
      path: "/tmp/non-existent-vscode-acp-chat-test-file",
      oldText: "old",
      newText: "expected-new",
      status: "pending",
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.conflict, true);
  });
});
