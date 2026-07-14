/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
  listedSessions: Array<{
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: string;
  }> = [];
  nextSessionIds: string[] = [];

  syncCapabilities(): void {}

  async newSession(): Promise<{ sessionId: string }> {
    this.newCalls += 1;
    return { sessionId: this.nextSessionIds.shift() ?? `acp-${this.newCalls}` };
  }

  async loadSession(sessionId: string): Promise<{ sessionId: string }> {
    this.loadCalls.push(sessionId);
    return { sessionId };
  }

  async listSessions(): Promise<
    Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }>
  > {
    return this.listedSessions;
  }

  async deleteSession(): Promise<void> {}
}

class FakeClient {
  state = "disconnected";
  currentSessionId: string | null = null;
  agentId = "test-agent";
  metadata: any = {
    modes: null,
    models: null,
    genericConfigOptions: [],
    commands: null,
  };
  setConfigOptionCalls: Array<{ configId: string; value: string }> = [];
  connectError?: Error;
  cancelCalls = 0;
  disposeCalls = 0;
  promptResolvers: Array<(value: { stopReason: string }) => void> = [];
  sessionUpdate?: (update: unknown) => void;
  stateChange?: (state: string) => void;
  permissionRequest?: (params: unknown) => Promise<unknown>;

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.state = "connected";
    this.stateChange?.("connected");
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getSessionMetadata(): any {
    return this.metadata;
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
    return this.agentId;
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

  readTextFile?: (params: unknown) => Promise<unknown>;
  writeTextFile?: (params: unknown) => Promise<unknown>;

  setOnReadTextFile(callback: (params: unknown) => Promise<unknown>): void {
    this.readTextFile = callback;
  }
  setOnWriteTextFile(callback: (params: unknown) => Promise<unknown>): void {
    this.writeTextFile = callback;
  }
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
  async setConfigOption(configId: string, value: string): Promise<void> {
    this.setConfigOptionCalls.push({ configId, value });
  }
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

function createController(
  configureClient?: (client: FakeClient) => void,
  options: {
    state?: TestMemento;
    configureManager?: (manager: FakeSessionManager) => void;
  } = {}
) {
  const messages: Record<string, unknown>[] = [];
  const clients: FakeClient[] = [];
  const managers: FakeSessionManager[] = [];
  const controller = new MultiSessionHostController({
    globalState: options.state ?? new TestMemento(),
    postMessage: (message) => messages.push(message),
    clientFactory: () => {
      const client = new FakeClient();
      configureClient?.(client);
      const manager = new FakeSessionManager();
      options.configureManager?.(manager);
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

  test("switching the selected agent updates draft sessions and state", async () => {
    const { controller, messages } = createController();

    await controller.switchAgent("opencode");

    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    const snapshot = [...messages]
      .reverse()
      .find(
        (message) => message.type === "feature.multi-session.snapshot"
      ) as any;

    assert.strictEqual(state.selectedAgentId, "opencode");
    assert.ok(
      state.agents.some(
        (agent: { id: string; name: string }) =>
          agent.id === "opencode" && agent.name === "OpenCode"
      )
    );
    assert.strictEqual(
      controller.getStateForTest().sessions[0].agentName,
      "OpenCode"
    );
    assert.strictEqual(snapshot.session.agentName, "OpenCode");
    controller.dispose();
  });

  test("new chat initializes a new agent session without cancelling running work", async () => {
    const { controller, clients, managers } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(clients.length, 1);

    await controller.newChat();
    assert.strictEqual(clients[0].cancelCalls, 0);
    assert.strictEqual(clients.length, 2);
    assert.strictEqual(managers[1].newCalls, 1);
    assert.strictEqual(clients[1].state, "connected");

    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(clients.length, 2);
    assert.strictEqual(managers[1].newCalls, 1);
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

    await controller.newChat();
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
    await controller.newChat();
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

  test("structured tool diffs are scoped to the owning session", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vscode-acp-chat-scoped-")
    );
    const fileA = path.join(tmpRoot, "a.ts");
    const fileB = path.join(tmpRoot, "b.ts");
    fs.writeFileSync(fileA, "after a");
    fs.writeFileSync(fileB, "after b");

    const { controller, messages, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;

    await controller.newChat();
    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionB = controller.getStateForTest().activeLocalSessionId!;

    try {
      clients[0].sessionUpdate?.({
        sessionId: "a",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-a",
          title: "Edit",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: fileA,
              oldText: "before a",
              newText: "after a",
            },
          ],
        },
      });
      clients[1].sessionUpdate?.({
        sessionId: "b",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-b",
          title: "Edit",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: fileB,
              oldText: "before b",
              newText: "after b",
            },
          ],
        },
      });
      await Promise.all([
        (controller as any).sessions.get(sessionA).queue.waitForIdle(),
        (controller as any).sessions.get(sessionB).queue.waitForIdle(),
      ]);

      const state = controller.getStateForTest();
      assert.strictEqual(
        state.sessions.find((session) => session.localSessionId === sessionA)
          ?.diffCount,
        1
      );
      assert.strictEqual(
        state.sessions.find((session) => session.localSessionId === sessionB)
          ?.diffCount,
        1
      );

      await controller.handleMessage({
        type: "feature.multi-session.activate",
        localSessionId: sessionA,
      });
      const snapshotA = [...messages]
        .reverse()
        .find(
          (message) =>
            message.type === "feature.multi-session.snapshot" &&
            message.activeLocalSessionId === sessionA
        ) as any;
      assert.deepStrictEqual(
        snapshotA.diffChanges.map((change: any) => change.path),
        [fileA]
      );

      await controller.handleMessage({
        type: "feature.multi-session.activate",
        localSessionId: sessionB,
      });
      const snapshotB = [...messages]
        .reverse()
        .find(
          (message) =>
            message.type === "feature.multi-session.snapshot" &&
            message.activeLocalSessionId === sessionB
        ) as any;
      assert.deepStrictEqual(
        snapshotB.diffChanges.map((change: any) => change.path),
        [fileB]
      );
    } finally {
      clients[0].resolvePrompt();
      clients[1].resolvePrompt();
      await Promise.all([promptA, promptB]);
      controller.dispose();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("structured tool diff does not duplicate a matching writeTextFile change", async () => {
    const { controller, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionId = controller.getStateForTest().activeLocalSessionId!;

    const duplicatePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vscode-acp-chat-duplicate-")),
      "duplicate.ts"
    );
    try {
      await clients[0].writeTextFile?.({
        path: duplicatePath,
        content: "after",
      });
      clients[0].sessionUpdate?.({
        sessionId: "a",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-duplicate",
          title: "Write",
          kind: "write",
          status: "completed",
          content: [
            {
              type: "diff",
              path: duplicatePath,
              oldText: null,
              newText: "after",
            },
          ],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const active = controller
        .getStateForTest()
        .sessions.find((session) => session.localSessionId === sessionId)!;
      assert.strictEqual(active.diffCount, 1);
      assert.strictEqual(active.conflictedDiffCount, 0);
    } finally {
      clients[0].resolvePrompt();
      await prompt;
      controller.dispose();
      fs.rmSync(path.dirname(duplicatePath), { recursive: true, force: true });
    }
  });

  test("mismatched structured tool diff is not actionable or stale-marking", async () => {
    const mismatchPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vscode-acp-chat-mismatch-")),
      "mismatch.ts"
    );
    fs.writeFileSync(mismatchPath, "from a");
    const { controller, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;

    try {
      clients[0].sessionUpdate?.({
        sessionId: "a",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-a",
          title: "Edit",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: mismatchPath,
              oldText: "base",
              newText: "from a",
            },
          ],
        },
      });
      await (controller as any).sessions.get(sessionA).queue.waitForIdle();

      await controller.newChat();
      const promptB = controller.sendActiveMessage("B");
      await new Promise((resolve) => setTimeout(resolve, 0));
      clients[1].sessionUpdate?.({
        sessionId: "b",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-b-stale-preview",
          title: "Edit",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: mismatchPath,
              oldText: "from a",
              newText: "from b",
            },
          ],
        },
      });
      await (controller as any).sessions
        .get(controller.getStateForTest().activeLocalSessionId!)
        .queue.waitForIdle();

      const state = controller.getStateForTest();
      const sessionAState = state.sessions.find(
        (session) => session.localSessionId === sessionA
      )!;
      const sessionBState = state.sessions.find(
        (session) => session.localSessionId !== sessionA
      )!;
      assert.strictEqual(sessionAState.diffCount, 1);
      assert.strictEqual(sessionAState.conflictedDiffCount, 0);
      assert.strictEqual(sessionBState.diffCount, 0);

      clients[1].resolvePrompt();
      await promptB;
    } finally {
      clients[0].resolvePrompt();
      await promptA;
      controller.dispose();
      fs.rmSync(path.dirname(mismatchPath), { recursive: true, force: true });
    }
  });

  test("structured tool diffs mark other sessions pending on the same path as conflicted", async () => {
    const conflictPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vscode-acp-chat-conflict-")),
      "conflict.ts"
    );
    fs.writeFileSync(conflictPath, "from a");
    const { controller, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;

    try {
      clients[0].sessionUpdate?.({
        sessionId: "a",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-a",
          title: "Edit",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: conflictPath,
              oldText: "base",
              newText: "from a",
            },
          ],
        },
      });
      await (controller as any).sessions.get(sessionA).queue.waitForIdle();

      await controller.newChat();
      const promptB = controller.sendActiveMessage("B");
      await new Promise((resolve) => setTimeout(resolve, 0));
      fs.writeFileSync(conflictPath, "from b");
      clients[1].sessionUpdate?.({
        sessionId: "b",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-b",
          title: "Edit",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: conflictPath,
              oldText: "from a",
              newText: "from b",
            },
          ],
        },
      });
      await (controller as any).sessions
        .get(controller.getStateForTest().activeLocalSessionId!)
        .queue.waitForIdle();

      const sessionAState = controller
        .getStateForTest()
        .sessions.find((session) => session.localSessionId === sessionA)!;
      assert.strictEqual(sessionAState.diffCount, 1);
      assert.strictEqual(sessionAState.conflictedDiffCount, 1);

      clients[1].resolvePrompt();
      await promptB;
    } finally {
      clients[0].resolvePrompt();
      await promptA;
      controller.dispose();
      fs.rmSync(path.dirname(conflictPath), { recursive: true, force: true });
    }
  });

  test("background permission is replayed on activation and response resolves owner", async () => {
    const { controller, messages, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;
    await controller.newChat();

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

  test("addMention posts path-only file and folder mentions", () => {
    const { controller, messages } = createController();

    controller.addMention({
      type: "file",
      name: "example.ts",
      path: "/workspace/example.ts",
    });
    controller.addMention({
      type: "folder",
      name: "src",
      path: "/workspace/src",
    });

    assert.deepStrictEqual(messages.slice(-2), [
      {
        type: "addMention",
        mention: {
          type: "file",
          name: "example.ts",
          path: "/workspace/example.ts",
        },
      },
      {
        type: "addMention",
        mention: {
          type: "folder",
          name: "src",
          path: "/workspace/src",
        },
      },
    ]);
    controller.dispose();
  });

  test("legacy addSelection alias still posts addMention", () => {
    const { controller, messages } = createController();

    controller.addSelection({
      type: "selection",
      name: "example.ts:1-1",
      path: "/workspace/example.ts",
      content: "const value = 1;",
      range: { startLine: 1, endLine: 1 },
    });

    assert.deepStrictEqual(messages[messages.length - 1], {
      type: "addMention",
      mention: {
        type: "selection",
        name: "example.ts:1-1",
        path: "/workspace/example.ts",
        content: "const value = 1;",
        range: { startLine: 1, endLine: 1 },
      },
    });
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
      await controller.newChat();
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

  test("loading history uses a catalog title when available", async () => {
    const fullSessionId = "019f5f61-1234-4567-89ab-full-history-id";
    const { controller } = createController(undefined, {
      configureManager: (manager) => {
        manager.listedSessions = [
          {
            sessionId: fullSessionId,
            title: "Backend debug",
            cwd: "/workspace",
            updatedAt: new Date().toISOString(),
          },
        ];
      },
    });

    await controller.loadHistorySession(fullSessionId);

    const state = controller.getStateForTest();
    const active = state.sessions.find(
      (session) => session.localSessionId === state.activeLocalSessionId
    );
    assert.strictEqual(active?.title, "Backend debug");
    assert.strictEqual(active?.acpSessionId, fullSessionId);
    controller.dispose();
  });

  test("loading history falls back to the full session id", async () => {
    const fullSessionId = "019f5f61-1234-4567-89ab-full-history-id";
    const { controller } = createController();

    await controller.loadHistorySession(fullSessionId);

    const state = controller.getStateForTest();
    const active = state.sessions.find(
      (session) => session.localSessionId === state.activeLocalSessionId
    );
    assert.strictEqual(active?.title, `History ${fullSessionId}`);
    controller.dispose();
  });

  test("new Pi sessions use the full session id until a title update arrives", async () => {
    const state = new TestMemento();
    await state.update("vscode-acp-chat.selectedAgent", "pi");
    const fullSessionId = "019f5f61-1234-4567-89ab-new-pi-session-id";
    const { controller, clients } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.nextSessionIds = [fullSessionId];
      },
    });

    await controller.newChat();

    const initialState = controller.getStateForTest();
    let active = initialState.sessions.find(
      (session) => session.localSessionId === initialState.activeLocalSessionId
    );
    assert.strictEqual(active?.title, `Pi ${fullSessionId}`);
    assert.strictEqual(active?.acpSessionId, fullSessionId);

    clients[0].sessionUpdate?.({
      sessionId: fullSessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: "Backend debug",
      },
    });
    await (controller as any).sessions
      .get(active!.localSessionId)
      .queue.waitForIdle();

    active = controller
      .getStateForTest()
      .sessions.find(
        (session) => session.localSessionId === active?.localSessionId
      );
    assert.strictEqual(active?.title, "Backend debug");
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
    await controller.handleMessage({
      type: "feature.multi-session.hideManager",
    });
    state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    assert.strictEqual(state.managerOpen, false);
    controller.dispose();
  });

  test("migrates saved Pi mode preference to thought_level in multi-session restore", async () => {
    const messages: Record<string, unknown>[] = [];
    const clients: FakeClient[] = [];
    const state = new TestMemento();
    await state.update("vscode-acp-chat.selectedAgent", "pi");
    await state.update("vscode-acp-chat.agentPreferences.v1", {
      pi: { modeId: "xhigh", configOptionValues: {}, starredModels: [] },
    });

    const controller = new MultiSessionHostController({
      globalState: state,
      postMessage: (message) => messages.push(message),
      clientFactory: () => {
        const client = new FakeClient();
        client.agentId = "pi";
        client.metadata = {
          modes: null,
          models: null,
          genericConfigOptions: [
            {
              id: "thought_level",
              name: "Thinking",
              category: "thought_level",
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "xhigh", name: "Xhigh" },
              ],
            },
          ],
          commands: null,
        };
        clients.push(client);
        return {
          client: client as any,
          sessionManager: new FakeSessionManager() as any,
        };
      },
    });

    const prompt = controller.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));
    clients[0].resolvePrompt();
    await prompt;

    assert.deepStrictEqual(clients[0].setConfigOptionCalls, [
      { configId: "thought_level", value: "xhigh" },
    ]);
    const prefs = state.get<any>("vscode-acp-chat.agentPreferences.v1");
    assert.strictEqual(prefs.pi.modeId, undefined);
    assert.strictEqual(prefs.pi.configOptionValues.thought_level, "xhigh");
    controller.dispose();
  });

  test("start chat opens the active chat surface instead of leaving manager on screen", async () => {
    const { controller, messages, clients } = createController();

    await controller.handleMessage({ type: "feature.multi-session.manage" });
    await controller.connectActive();

    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    const snapshot = [...messages]
      .reverse()
      .find(
        (message) => message.type === "feature.multi-session.snapshot"
      ) as any;

    assert.strictEqual(state.managerOpen, false);
    assert.strictEqual(snapshot.isGenerating, false);
    assert.strictEqual(
      controller
        .getStateForTest()
        .sessions.find(
          (session) => session.localSessionId === snapshot.activeLocalSessionId
        )?.status,
      "idle"
    );
    assert.strictEqual(clients.length, 1);
    controller.dispose();
  });

  test("failed start chat republishes draft state instead of leaving starting visible", async () => {
    const { controller, messages } = createController((client) => {
      client.connectError = new Error("connect failed");
    });

    await assert.rejects(controller.connectActive(), /connect failed/);

    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.state") as any;
    const active = state.sessions.find(
      (session: any) => session.localSessionId === state.activeLocalSessionId
    );

    assert.strictEqual(active.status, "draft");
    assert.match(active.lastError, /connect failed/);
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
