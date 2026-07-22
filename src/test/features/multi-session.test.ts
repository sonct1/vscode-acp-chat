/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { TranscriptStore } from "../../features/multi-session/transcript-store";
import { WorkspaceMutationCoordinator } from "../../features/multi-session/workspace-mutation-coordinator";
import { MultiSessionHostController } from "../../features/multi-session/host";
import { activeSessionBindingKey } from "../../features/multi-session/active-session-persistence";

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
  deleteCalls: string[] = [];
  listCalls = 0;
  listedSessions: Array<{
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: string;
  }> = [];
  nextSessionIds: string[] = [];

  syncCapabilities(): void {}

  newPromise?: Promise<void>;

  async newSession(): Promise<{ sessionId: string }> {
    this.newCalls += 1;
    if (this.newPromise) await this.newPromise;
    return { sessionId: this.nextSessionIds.shift() ?? `acp-${this.newCalls}` };
  }

  loadError?: unknown;
  loadPromise?: Promise<void>;

  async loadSession(sessionId: string): Promise<{ sessionId: string }> {
    this.loadCalls.push(sessionId);
    if (this.loadPromise) await this.loadPromise;
    if (this.loadError) throw this.loadError;
    return { sessionId };
  }

  async listSessionPage(): Promise<{
    sessions: Array<{
      sessionId: string;
      title: string;
      cwd: string;
      updatedAt: string;
    }>;
    nextCursor: string | null;
  }> {
    this.listCalls += 1;
    return { sessions: this.listedSessions, nextCursor: null };
  }

  async listSessions(): Promise<
    Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }>
  > {
    this.listCalls += 1;
    return this.listedSessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleteCalls.push(sessionId);
  }
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
  connectPromise?: Promise<void>;
  sendMessageHook?: () => Promise<{ stopReason: string }>;
  connectCalls = 0;
  cancelCalls = 0;
  disposeCalls = 0;
  promptResolvers: Array<(value: { stopReason: string }) => void> = [];
  sessionUpdate?: (update: unknown) => void;
  stateChange?: (state: string) => void;
  permissionRequest?: (params: unknown) => Promise<unknown>;
  elicitationRequest?: (context: {
    params: unknown;
    requestId: string | number;
    signal: AbortSignal;
  }) => Promise<unknown>;
  onCancel?: () => Promise<void> | void;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectPromise) await this.connectPromise;
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

  setOnElicitationRequest(
    callback: (context: {
      params: unknown;
      requestId: string | number;
      signal: AbortSignal;
    }) => Promise<unknown>
  ): void {
    this.elicitationRequest = callback;
  }

  async sendMessage(): Promise<{ stopReason: string }> {
    if (this.sendMessageHook) return this.sendMessageHook();
    return new Promise((resolve) => this.promptResolvers.push(resolve));
  }

  resolvePrompt(index = 0, stopReason = "end_turn"): void {
    this.promptResolvers[index]?.({ stopReason });
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    await this.onCancel?.();
  }

  setModeCalls = 0;
  setModelCalls = 0;

  async setMode(): Promise<void> {
    this.setModeCalls += 1;
  }
  async setModel(): Promise<void> {
    this.setModelCalls += 1;
  }
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
    onFocusChat?: () => Thenable<void> | void;
  } = {}
) {
  const messages: Record<string, unknown>[] = [];
  const clients: FakeClient[] = [];
  const managers: FakeSessionManager[] = [];
  const controller = new MultiSessionHostController({
    globalState: options.state ?? new TestMemento(),
    postMessage: (message) => messages.push(message),
    onFocusChat: options.onFocusChat,
    clientFactory: (agent) => {
      const client = new FakeClient();
      client.agentId = agent.id;
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

  test("adjacent stream chunks compact snapshots while preserving sequence metadata", () => {
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
    assert.strictEqual(store.length, 4);
    assert.strictEqual(store.lastSeq, 4);
  });

  test("snapshot returns defensive copies", () => {
    const store = new TranscriptStore();
    store.append({ type: "system", text: "original" });
    const snapshot = store.snapshot();
    snapshot[0].message.text = "mutated";
    assert.strictEqual(store.snapshot()[0].message.text, "original");
  });

  test("tool progress compacts by tool id and completion supersedes it", () => {
    const store = new TranscriptStore();
    store.append({
      type: "toolCallStart",
      toolCallId: "tool-1",
      name: "bash",
    });
    store.append({
      type: "toolCallProgress",
      toolCallId: "tool-1",
      revision: 1,
      presentation: { format: "terminal", text: "one", truncated: false },
    });
    store.append({
      type: "toolCallProgress",
      toolCallId: "tool-1",
      revision: 2,
      presentation: {
        format: "terminal",
        text: "one\ntwo",
        truncated: false,
      },
    });

    assert.deepStrictEqual(
      store
        .snapshot()
        .map((event) => [
          event.seq,
          event.message.type,
          (event.message.presentation as { text?: string } | undefined)?.text,
        ]),
      [
        [1, "toolCallStart", undefined],
        [3, "toolCallProgress", "one\ntwo"],
      ]
    );
    assert.strictEqual(store.lastSeq, 3);

    store.append({
      type: "toolCallComplete",
      toolCallId: "tool-1",
      revision: 3,
      status: "completed",
    });
    assert.deepStrictEqual(
      store.snapshot().map((event) => event.message.type),
      ["toolCallStart", "toolCallComplete"]
    );
    assert.strictEqual(store.lastSeq, 4);
  });

  test("selecting an agent persists it and starts a new active session without mutating the old draft", async () => {
    const state = new TestMemento();
    const { controller, clients, managers } = createController(undefined, {
      state,
    });
    const originalSession = controller.getStateForTest().sessions[0];

    await controller.selectAgentAndNewChat("opencode");

    const managerState = controller.getManagerStateSnapshot();
    const sessions = controller.getStateForTest().sessions;
    const activeSession = sessions.find(
      (session) => session.localSessionId === managerState.activeLocalSessionId
    );

    assert.strictEqual(controller.getDefaultAgentId(), "opencode");
    assert.strictEqual(state.get("vscode-acp-chat.selectedAgent"), "opencode");
    assert.strictEqual(managerState.selectedAgentId, "opencode");
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(
      sessions[0].localSessionId,
      originalSession.localSessionId
    );
    assert.strictEqual(sessions[0].agentId, originalSession.agentId);
    assert.strictEqual(activeSession?.agentId, "opencode");
    assert.strictEqual(activeSession?.agentName, "OpenCode");
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].agentId, "opencode");
    assert.strictEqual(clients[0].connectCalls, 1);
    assert.strictEqual(managers[0].newCalls, 1);

    const restored = createController(undefined, { state }).controller;
    assert.strictEqual(restored.getDefaultAgentId(), "opencode");
    restored.dispose();
    controller.dispose();
  });

  test("selecting the current agent still creates a new ACP session", async () => {
    const state = new TestMemento();
    await state.update("vscode-acp-chat.selectedAgent", "opencode");
    const { controller, clients, managers } = createController(undefined, {
      state,
    });

    await controller.selectAgentAndNewChat("opencode");

    const sessions = controller.getStateForTest().sessions;
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(sessions[1].agentId, "opencode");
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].agentId, "opencode");
    assert.strictEqual(managers[0].newCalls, 1);
    controller.dispose();
  });

  test("selecting an agent does not cancel a running session and keeps failure isolated", async () => {
    let clientCount = 0;
    const { controller, clients, managers } = createController((client) => {
      clientCount += 1;
      if (clientCount === 2) {
        client.connectError = new Error("opencode failed");
      }
    });
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runningState = controller.getStateForTest();
    const runningSession = runningState.activeLocalSessionId!;
    const runningAgentId = runningState.sessions.find(
      (session) => session.localSessionId === runningSession
    )?.agentId;

    await controller.selectAgentAndNewChat("opencode");

    const state = controller.getStateForTest();
    const oldSession = state.sessions.find(
      (session) => session.localSessionId === runningSession
    );
    const activeSession = state.sessions.find(
      (session) => session.localSessionId === state.activeLocalSessionId
    );

    assert.strictEqual(clients[0].cancelCalls, 0);
    assert.strictEqual(oldSession?.status, "running");
    assert.strictEqual(oldSession?.agentId, runningAgentId);
    assert.strictEqual(activeSession?.agentId, "opencode");
    assert.strictEqual(activeSession?.status, "error");
    assert.strictEqual(activeSession?.lastError, "opencode failed");
    assert.strictEqual(clients.length, 2);
    assert.strictEqual(managers[1].newCalls, 0);

    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("new chat initializes a new agent session without cancelling running work", async () => {
    const { controller, clients, managers } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(clients.length, 1);

    await controller.newChat();
    // newChat starts runtime in background; let it complete
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(clients[0].cancelCalls, 0);
    assert.strictEqual(clients.length, 2);
    assert.strictEqual(managers[1].newCalls, 1);
    assert.strictEqual(clients[1].state, "connected");

    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(clients.length, 2);
    // ACP session is created on first send
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

  test("background updates retain transcripts and duplicate tool ids per runtime", async () => {
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
    assert.strictEqual(snapshotA.scrollToBottom, true);
    assert.ok(
      snapshotA.transcript.some(
        (event: any) =>
          typeof event.message.toolCallId === "string" &&
          event.message.toolCallId === "same-id" &&
          JSON.stringify(event.message).includes("A tool")
      )
    );
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

  test("structured tool diffs are scoped to the owning session when low-resource mode is disabled", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const original = config.inspect<boolean>(
      "multiSession.lowResourceMode"
    )?.globalValue;
    await config.update("multiSession.lowResourceMode", false, true);
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
      await config.update("multiSession.lowResourceMode", original, true);
    }
  });

  test("low-resource mode leaves file writes usable without diff state", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const original = config.inspect<boolean>(
      "multiSession.lowResourceMode"
    )?.globalValue;
    await config.update("multiSession.lowResourceMode", true, true);
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vscode-acp-chat-low-resource-write-")
    );
    const filePath = path.join(tmpRoot, "created.ts");
    const { controller, clients } = createController();
    const prompt = controller.sendActiveMessage("write");
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      await clients[0].writeTextFile?.({
        path: filePath,
        content: "created",
      });
      const sessionId = controller.getStateForTest().activeLocalSessionId!;
      const session = (controller as any).sessions.get(sessionId);

      assert.strictEqual(fs.readFileSync(filePath, "utf8"), "created");
      assert.strictEqual(session.resources.diffManager.isEnabled(), false);
      assert.deepStrictEqual(
        session.resources.diffManager.getPendingChanges(),
        []
      );
      assert.deepStrictEqual(controller.getChatStateSnapshot().aggregate, {
        open: 1,
        running: 1,
        awaitingPermission: 0,
        awaitingInput: 0,
      });
    } finally {
      clients[0].resolvePrompt();
      await prompt;
      controller.dispose();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      await config.update("multiSession.lowResourceMode", original, true);
    }
  });

  test("structured tool diff does not duplicate a matching writeTextFile change when low-resource mode is disabled", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const original = config.inspect<boolean>(
      "multiSession.lowResourceMode"
    )?.globalValue;
    await config.update("multiSession.lowResourceMode", false, true);
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

      assert.strictEqual(
        (controller as any).sessions
          .get(sessionId)
          .resources.diffManager.getPendingChanges().length,
        1
      );
    } finally {
      clients[0].resolvePrompt();
      await prompt;
      controller.dispose();
      fs.rmSync(path.dirname(duplicatePath), { recursive: true, force: true });
      await config.update("multiSession.lowResourceMode", original, true);
    }
  });

  test("mismatched structured tool diff is not actionable or stale-marking when low-resource mode is disabled", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const original = config.inspect<boolean>(
      "multiSession.lowResourceMode"
    )?.globalValue;
    await config.update("multiSession.lowResourceMode", false, true);
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

      assert.strictEqual(
        (controller as any).sessions
          .get(sessionA)
          .resources.diffManager.getPendingChanges().length,
        1
      );
      const sessionB = controller.getStateForTest().activeLocalSessionId!;
      assert.strictEqual(
        (controller as any).sessions
          .get(sessionB)
          .resources.diffManager.getPendingChanges().length,
        0
      );

      clients[1].resolvePrompt();
      await promptB;
    } finally {
      clients[0].resolvePrompt();
      await promptA;
      controller.dispose();
      fs.rmSync(path.dirname(mismatchPath), { recursive: true, force: true });
      await config.update("multiSession.lowResourceMode", original, true);
    }
  });

  test("structured tool diffs skip conflict bookkeeping in low-resource mode", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const original = config.inspect<boolean>(
      "multiSession.lowResourceMode"
    )?.globalValue;
    await config.update("multiSession.lowResourceMode", true, true);
    const conflictPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vscode-acp-chat-low-conflict-")),
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

      const sessionARecord = (controller as any).sessions.get(sessionA);
      assert.strictEqual(sessionARecord.conflictedDiffPaths, undefined);
      assert.deepStrictEqual(
        sessionARecord.resources.diffManager.getPendingChanges(),
        []
      );

      clients[1].resolvePrompt();
      await promptB;
    } finally {
      clients[0].resolvePrompt();
      await promptA;
      controller.dispose();
      fs.rmSync(path.dirname(conflictPath), { recursive: true, force: true });
      await config.update("multiSession.lowResourceMode", original, true);
    }
  });

  test("structured tool diffs mark other sessions pending on the same path as conflicted when low-resource mode is disabled", async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    const original = config.inspect<boolean>(
      "multiSession.lowResourceMode"
    )?.globalValue;
    await config.update("multiSession.lowResourceMode", false, true);
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

      const sessionARecord = (controller as any).sessions.get(sessionA);
      assert.strictEqual(
        sessionARecord.resources.diffManager.getPendingChanges().length,
        1
      );
      assert.strictEqual(sessionARecord.conflictedDiffPaths.size, 1);

      clients[1].resolvePrompt();
      await promptB;
    } finally {
      clients[0].resolvePrompt();
      await promptA;
      controller.dispose();
      fs.rmSync(path.dirname(conflictPath), { recursive: true, force: true });
      await config.update("multiSession.lowResourceMode", original, true);
    }
  });

  test("answered permission does not replay after turn snapshot and resync", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-a", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pendingSnapshot = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.permission-ui.state" &&
          Array.isArray((message as any).pending) &&
          (message as any).pending.length === 1
      ) as any;
    assert.ok(pendingSnapshot);
    const transcriptSnapshot = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.snapshot") as any;
    assert.strictEqual(transcriptSnapshot.transcript.length, 2);
    assert.ok(
      !transcriptSnapshot.transcript.some(
        (event: any) => event.message.type === "permissionRequest"
      )
    );
    assert.strictEqual(transcriptSnapshot.lastSeq, 2);

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId: pendingSnapshot.ownerId,
      requestId: pendingSnapshot.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "selected", optionId: "allow" },
    });

    clients[0].resolvePrompt();
    await prompt;

    const turnEndSnapshot = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.snapshot") as any;
    assert.deepStrictEqual(turnEndSnapshot.pendingPermissions, []);
    assert.ok(turnEndSnapshot.lastSeq >= transcriptSnapshot.lastSeq);
    assert.ok(
      !turnEndSnapshot.transcript.some(
        (event: any) => event.message.type === "permissionRequest"
      )
    );

    await controller.handleMessage({ type: "feature.multi-session.resync" });
    const resyncSnapshot = messages[messages.length - 1] as any;
    assert.strictEqual(resyncSnapshot.type, "feature.multi-session.snapshot");
    assert.deepStrictEqual(resyncSnapshot.pendingPermissions, []);
    assert.strictEqual(resyncSnapshot.lastSeq, turnEndSnapshot.lastSeq);
    assert.ok(
      !resyncSnapshot.transcript.some(
        (event: any) => event.message.type === "permissionRequest"
      )
    );

    controller.dispose();
  });

  test("invalid permission optionId cancels the request", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-invalid", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId: state.ownerId,
      requestId: state.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "forged" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "cancelled" },
    });

    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("missing permission optionId cancels the request", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-missing", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId: state.ownerId,
      requestId: state.pending[0].requestId,
      outcome: { outcome: "selected" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "cancelled" },
    });

    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("deny permission preserves selected deny optionId and does not enter transcript", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-deny", title: "Write", kind: "write" },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "deny-always", kind: "reject_always", name: "Deny always" },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.permission-ui.state" &&
          Array.isArray((message as any).pending) &&
          (message as any).pending.length === 1
      ) as any;
    assert.ok(snapshot);

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId: snapshot.ownerId,
      requestId: snapshot.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "deny-always" },
    });

    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "selected", optionId: "deny-always" },
    });

    clients[0].resolvePrompt();
    await prompt;

    const finalSnapshot = [...messages]
      .reverse()
      .find((message) => message.type === "feature.multi-session.snapshot") as any;
    assert.deepStrictEqual(finalSnapshot.pendingPermissions, []);
    assert.ok(
      !finalSnapshot.transcript.some(
        (event: any) => event.message.type === "permissionRequest"
      )
    );

    controller.dispose();
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
      ownerId: sessionA,
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

  test("ownerless permission response is ignored and correct owner settles", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ownerId = controller.getStateForTest().activeLocalSessionId!;

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-ownerless", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      requestId: state.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.strictEqual(
      controller.getStateForTest().sessions.find((session) => session.localSessionId === ownerId)
        ?.pendingPermissionCount,
      1
    );

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId,
      requestId: state.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("invalid permission discriminator cancels the request", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-invalid-discriminator", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId: state.ownerId,
      requestId: state.pending[0].requestId,
      outcome: { outcome: "approved", optionId: "allow" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "cancelled" },
    });
    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("permission after sendMessage settles is cancelled before queue finalization", async () => {
    let latePermission: Promise<unknown> | undefined;
    let resolveSendMessage: ((value: { stopReason: string }) => void) | undefined;
    const { controller, messages, clients } = createController((client) => {
      client.sendMessageHook = async () =>
        new Promise((resolve) => {
          resolveSendMessage = resolve;
        });
    });
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session = (controller as any).sessions.get(
      controller.getStateForTest().activeLocalSessionId!
    );
    const originalWaitForIdle = session.queue.waitForIdle.bind(session.queue);
    session.queue.waitForIdle = async () => {
      latePermission = clients[0].permissionRequest!({
        toolCall: { toolCallId: "tool-after-send", title: "Write", kind: "write" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return originalWaitForIdle();
    };
    resolveSendMessage?.({ stopReason: "end_turn" });
    await prompt;

    assert.deepStrictEqual(await latePermission, {
      outcome: { outcome: "cancelled" },
    });
    assert.strictEqual(
      controller.getStateForTest().sessions.find((item) => item.localSessionId === session.localSessionId)
        ?.pendingPermissionCount,
      0
    );
    assert.ok(
      !messages.some(
        (message) =>
          message.type === "feature.permission-ui.state" &&
          Array.isArray((message as any).pending) &&
          (message as any).pending.some(
            (pending: any) => pending.toolCallId === "tool-after-send"
          )
      )
    );
    controller.dispose();
  });

  test("old prompt response cannot settle a later prompt permission", async () => {
    const { controller, messages, clients } = createController();
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ownerId = controller.getStateForTest().activeLocalSessionId!;

    const oldPermission = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-old-prompt", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oldState = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;
    clients[0].resolvePrompt();
    assert.deepStrictEqual(await oldPermission, {
      outcome: { outcome: "cancelled" },
    });
    await promptA;

    const promptB = controller.sendActiveMessage("B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newPermission = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-new-prompt", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newState = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.permission-ui.state" &&
          Array.isArray((message as any).pending) &&
          (message as any).pending[0]?.toolCallId === "tool-new-prompt"
      ) as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId,
      requestId: oldState.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.strictEqual(
      controller.getStateForTest().sessions.find((item) => item.localSessionId === ownerId)
        ?.pendingPermissionCount,
      1
    );

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId,
      requestId: newState.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.deepStrictEqual(await newPermission, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    clients[0].resolvePrompt(1);
    await promptB;
    controller.dispose();
  });

  test("wrong-owner permission response is ignored and correct owner settles", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ownerId = controller.getStateForTest().activeLocalSessionId!;

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-a", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId: "wrong-owner",
      requestId: state.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.strictEqual(
      controller.getStateForTest().sessions.find((session) => session.localSessionId === ownerId)
        ?.pendingPermissionCount,
      1
    );

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId,
      requestId: state.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("stale permission response after runtime replacement is ignored", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ownerId = controller.getStateForTest().activeLocalSessionId!;

    const oldPermission = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-a", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oldState = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;

    clients[0].stateChange?.("disconnected");
    assert.deepStrictEqual(await oldPermission, {
      outcome: { outcome: "cancelled" },
    });
    clients[0].resolvePrompt(0, "error");
    await prompt;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const session = (controller as any).sessions.get(ownerId);
    session.client = undefined;
    session.sessionManager = undefined;
    session.acpSessionId = undefined;
    session.status = "idle";
    session.isGenerating = true;
    await (controller as any).ensureRuntime(session, true);
    session.acceptingPermissionRequests = true;
    assert.strictEqual(clients.length, 2);

    const newPermission = clients[1].permissionRequest!({
      toolCall: { toolCallId: "tool-b", title: "Read", kind: "read" },
      options: [{ optionId: "deny", kind: "reject_once", name: "Deny" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newState = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.permission-ui.state" &&
          Array.isArray((message as any).pending) &&
          (message as any).pending[0]?.toolCallId === "tool-b"
      ) as any;

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId,
      requestId: oldState.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.strictEqual(
      controller.getStateForTest().sessions.find((item) => item.localSessionId === ownerId)
        ?.pendingPermissionCount,
      1
    );

    await controller.handleCoreMessage({
      type: "permissionResponse",
      ownerId,
      requestId: newState.pending[0].requestId,
      outcome: { outcome: "selected", optionId: "deny" },
    });
    assert.deepStrictEqual(await newPermission, {
      outcome: { outcome: "selected", optionId: "deny" },
    });
    assert.strictEqual(
      controller.getStateForTest().sessions.find((item) => item.localSessionId === ownerId)
        ?.pendingPermissionCount,
      0
    );
    controller.dispose();
  });

  test("stop cancels pending permission once and publishes empty state", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const permissionPromise = clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-a", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.stop();

    assert.deepStrictEqual(await permissionPromise, {
      outcome: { outcome: "cancelled" },
    });
    assert.strictEqual(clients[0].cancelCalls, 1);
    const emptyState = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.permission-ui.state" &&
          Array.isArray((message as any).pending) &&
          (message as any).pending.length === 0
      ) as any;
    assert.ok(emptyState);
    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("post-stop permission request fails closed without queueing", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await controller.stop();

    const messageCount = messages.length;
    const response = await clients[0].permissionRequest!({
      toolCall: { toolCallId: "tool-post-stop", title: "Write", kind: "write" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    });

    assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
    const session = controller.getStateForTest().sessions.find(
      (item) => item.localSessionId === controller.getStateForTest().activeLocalSessionId
    );
    assert.strictEqual(session?.pendingPermissionCount, 0);
    assert.strictEqual(
      messages
        .slice(messageCount)
        .some((message) => message.type === "feature.permission-ui.state"),
      false
    );
    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("stop second pass cancels permission emitted while client cancel is in flight", async () => {
    const { controller, messages, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    let inFlightPermission: Promise<unknown> | undefined;
    clients[0].onCancel = async () => {
      inFlightPermission = clients[0].permissionRequest!({
        toolCall: { toolCallId: "tool-race", title: "Write", kind: "write" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await controller.stop();

    assert.strictEqual(clients[0].cancelCalls, 1);
    assert.deepStrictEqual(await inFlightPermission, {
      outcome: { outcome: "cancelled" },
    });
    const session = controller.getStateForTest().sessions.find(
      (item) => item.localSessionId === controller.getStateForTest().activeLocalSessionId
    );
    assert.strictEqual(session?.pendingPermissionCount, 0);
    const latestPermissionState = [...messages]
      .reverse()
      .find((message) => message.type === "feature.permission-ui.state") as any;
    if (latestPermissionState) {
      assert.deepStrictEqual(latestPermissionState.pending, []);
    }
    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("background elicitation is routed to its owner and Stop cancels it", async () => {
    const focusCalls: string[] = [];
    const { controller, messages, clients } = createController(undefined, {
      onFocusChat: () => {
        focusCalls.push("focus");
      },
    });
    const promptA = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionA = controller.getStateForTest().activeLocalSessionId!;
    await controller.newChat();

    const pending = clients[0].elicitationRequest!({
      params: {
        mode: "form",
        sessionId: "acp-1",
        message: "Choose environment",
        requestedSchema: {
          type: "object",
          required: ["environment"],
          properties: {
            environment: {
              type: "string",
              enum: ["Development", "Staging", "Production"],
            },
          },
        },
      },
      requestId: "elicitation-1",
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const background = controller.getChatStateSnapshot().activeLocalSessionId;
    assert.notStrictEqual(background, sessionA);
    const ownerState = controller
      .getManagerStateSnapshot()
      .sessions.find((session) => session.localSessionId === sessionA);
    assert.strictEqual(ownerState?.status, "awaiting_input");
    assert.strictEqual(ownerState?.pendingElicitationCount, 1);
    assert.strictEqual(
      controller.getManagerStateSnapshot().aggregate.awaitingInput,
      1
    );
    assert.ok(
      !messages.some(
        (message) =>
          message.type === "feature.acp-elicitation.show" &&
          message.ownerId === sessionA
      )
    );

    const focusCountBeforeReview = focusCalls.length;
    await controller.handleMessage({
      type: "feature.multi-session.reviewInput",
      localSessionId: sessionA,
      focusChat: true,
    });
    assert.strictEqual(focusCalls.length, focusCountBeforeReview + 1);
    const snapshot = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.multi-session.snapshot" &&
          message.activeLocalSessionId === sessionA
      ) as {
      pendingElicitations?: Array<{ interactionId: string }>;
    };
    assert.strictEqual(snapshot.pendingElicitations?.length, 1);

    const interactionId = snapshot.pendingElicitations![0].interactionId;
    assert.strictEqual(
      await controller.handleMessage({
        type: "feature.acp-elicitation.respond",
        ownerId: sessionA,
        interactionId,
        action: "accept",
        content: { environment: "Staging" },
      } as never),
      true
    );
    assert.deepStrictEqual(await pending, {
      action: "accept",
      content: { environment: "Staging" },
    });

    const pendingStop = clients[0].elicitationRequest!({
      params: {
        mode: "form",
        requestId: "before-session",
        message: "Confirm",
        requestedSchema: {
          type: "object",
          properties: { confirmed: { type: "boolean" } },
        },
      },
      requestId: "elicitation-2",
      signal: new AbortController().signal,
    });
    await controller.stop(sessionA);
    assert.deepStrictEqual(await pendingStop, { action: "cancel" });

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
      assert.strictEqual(active?.status, "error");
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

  test("history list, load, and delete use the active listed agent when default differs", async () => {
    const state = new TestMemento();
    await state.update("vscode-acp-chat.selectedAgent", "pi");
    const { controller, clients, managers } = createController(undefined, {
      state,
    });
    const piSessionId = controller.getStateForTest().activeLocalSessionId!;

    await controller.connectActive();
    await controller.selectAgentAndNewChat("opencode");
    managers[0].listedSessions = [
      {
        sessionId: "pi-history",
        title: "Pi history",
        cwd: "/workspace",
        updatedAt: new Date().toISOString(),
      },
    ];
    managers[1].listedSessions = [
      {
        sessionId: "opencode-history",
        title: "OpenCode history",
        cwd: "/workspace",
        updatedAt: new Date().toISOString(),
      },
    ];

    controller.activateSession(piSessionId);
    const sessions = await controller.listSessions();
    await controller.loadHistorySession({
      agentId: "pi",
      sessionId: "pi-history",
      title: "Pi history",
      cwd: "/workspace",
      updatedAt: new Date().toISOString(),
      source: "agent",
    });
    await controller.deleteHistorySession({
      agentId: "pi",
      sessionId: "pi-history",
      title: "Pi history",
      cwd: "/workspace",
      updatedAt: new Date().toISOString(),
      source: "agent",
    });

    const active = controller
      .getStateForTest()
      .sessions.find(
        (session) =>
          session.localSessionId ===
          controller.getStateForTest().activeLocalSessionId
      );

    assert.strictEqual(controller.getDefaultAgentId(), "opencode");
    assert.strictEqual(clients[0].agentId, "pi");
    assert.strictEqual(clients[1].agentId, "opencode");
    assert.strictEqual(clients[2].agentId, "pi");
    assert.deepStrictEqual(
      sessions.map((session) => session.sessionId),
      ["pi-history"]
    );
    assert.strictEqual(active?.agentId, "pi");
    assert.deepStrictEqual(managers[2].loadCalls, ["pi-history"]);
    assert.strictEqual(managers[2].listCalls, 0);
    assert.deepStrictEqual(managers[0].deleteCalls, ["pi-history"]);
    assert.deepStrictEqual(managers[1].deleteCalls, []);
    controller.dispose();
  });

  test("explicit missing history load reports error without creating replacement", async () => {
    const { controller, managers } = createController(undefined, {
      configureManager: (manager) => {
        manager.loadError = new Error("Session not found");
      },
    });

    await controller.loadHistorySession("missing-history");

    const active = controller
      .getStateForTest()
      .sessions.find(
        (session) =>
          session.localSessionId ===
          controller.getStateForTest().activeLocalSessionId
      );
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(active?.status, "error");
    assert.match(active?.lastError ?? "", /Session not found/);
    controller.dispose();
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

  test("loading history uses selected item title without relisting", async () => {
    const fullSessionId = "019f5f61-1234-4567-89ab-full-history-id";
    const { controller, managers } = createController();

    await controller.loadHistorySession({
      agentId: "pi",
      sessionId: fullSessionId,
      title: "Backend debug",
      cwd: "/workspace",
      updatedAt: new Date().toISOString(),
      source: "agent",
    });

    const state = controller.getStateForTest();
    const active = state.sessions.find(
      (session) => session.localSessionId === state.activeLocalSessionId
    );
    assert.strictEqual(active?.title, "Backend debug");
    assert.strictEqual(active?.acpSessionId, fullSessionId);
    assert.strictEqual(managers[0].listCalls, 0);
    controller.dispose();
  });

  test("history collection suppresses content deltas and emits one snapshot", async () => {
    const { controller, clients, messages } = createController();
    const load = controller.loadHistorySession("history-snapshot");

    clients[0].sessionUpdate?.({
      sessionId: "history-snapshot",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    await load;

    const deltas = messages.filter(
      (message) =>
        message.type === "feature.multi-session.delta" &&
        ["streamStart", "streamChunk", "streamEnd"].includes(
          ((message as any).event as any)?.message?.type
        )
    );
    const snapshots = messages.filter(
      (message) => message.type === "feature.multi-session.snapshot"
    ) as any[];
    const nonEmptySnapshots = snapshots.filter(
      (snapshot) => snapshot.transcript.length > 0
    );
    const finalSnapshot = nonEmptySnapshots[nonEmptySnapshots.length - 1];

    assert.strictEqual(deltas.length, 0);
    assert.strictEqual(nonEmptySnapshots.length, 1);
    assert.ok(finalSnapshot.transcript.length > 0);
    assert.strictEqual(
      finalSnapshot.lastSeq,
      finalSnapshot.transcript.at(-1).seq
    );
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    // newChat now creates the ACP session immediately with the expected session ID
    let active = controller
      .getStateForTest()
      .sessions.find(
        (session) =>
          session.localSessionId ===
          controller.getStateForTest().activeLocalSessionId
      );
    assert.strictEqual(active?.acpSessionId, fullSessionId);
    assert.strictEqual(active?.title, `Pi ${fullSessionId}`);

    // Title update from session_info emits a session state delta
    const prompt = controller.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    active = controller
      .getStateForTest()
      .sessions.find(
        (session) =>
          session.localSessionId ===
          controller.getStateForTest().activeLocalSessionId
      );
    assert.strictEqual(active?.acpSessionId, fullSessionId);
    assert.strictEqual(active?.title, `Pi ${fullSessionId}`);

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

    clients[0].resolvePrompt();
    await prompt;
    controller.dispose();
  });

  test("session summaries derive running status from runtime flags", () => {
    const { controller } = createController();
    const activeId = controller.getStateForTest().activeLocalSessionId!;
    const session = (controller as any).sessions.get(activeId);
    session.status = "idle";
    session.isGenerating = true;

    const active = controller
      .getStateForTest()
      .sessions.find((item) => item.localSessionId === activeId)!;

    assert.strictEqual(active.status, "running");
    controller.dispose();
  });

  test("chat state excludes the full session list while manager state keeps summaries", () => {
    const { controller, messages } = createController();

    const chatState = [...messages]
      .reverse()
      .find(
        (message) => message.type === "feature.multi-session.chatState"
      ) as any;
    const managerState = controller.getManagerStateSnapshot();

    assert.strictEqual(Array.isArray(chatState.sessions), false);
    assert.ok(chatState.active);
    assert.strictEqual(chatState.aggregate.open, 1);
    assert.strictEqual(managerState.sessions.length, 1);
    assert.strictEqual(managerState.aggregate.open, 1);
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

  test("ready creates a new ACP session immediately", async () => {
    const { controller, clients, managers } = createController();

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const active = controller
      .getStateForTest()
      .sessions.find(
        (session) =>
          session.localSessionId ===
          controller.getStateForTest().activeLocalSessionId
      )!;
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].state, "connected");
    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(active.status, "idle");
    assert.strictEqual(active.acpSessionId, "acp-1");
    controller.dispose();
  });

  test("repeated ready does not start another runtime", async () => {
    const { controller, clients, managers } = createController();

    await controller.handleMessage({ type: "feature.multi-session.ready" });
    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].connectCalls, 1);
    assert.strictEqual(managers[0].newCalls, 1);
    controller.dispose();
  });

  test("failed ready auto-start leaves retryable error state", async () => {
    const { controller, messages, clients, managers } = createController(
      (client) => {
        client.connectError = new Error("connect failed");
      }
    );

    await controller.handleMessage({ type: "feature.multi-session.ready" });
    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const active = controller
      .getStateForTest()
      .sessions.find(
        (session) =>
          session.localSessionId ===
          controller.getStateForTest().activeLocalSessionId
      )!;
    const errors = messages.filter(
      (message) =>
        message.type === "feature.multi-session.delta" &&
        (message.event as any)?.message?.type === "error"
    );
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].disposeCalls, 1);
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(active.status, "error");
    assert.match(active.lastError ?? "", /connect failed/);
    assert.strictEqual(errors.length, 1);
    controller.dispose();
  });

  test("invalid persisted agent binding is cleared after fallback draft creation", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "unknown-agent",
      sessionId: "stale-session",
      cwd: process.cwd(),
    });

    const { controller } = createController(undefined, { state });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(state.get(key), undefined);
    assert.strictEqual(controller.getStateForTest().sessions.length, 1);
    controller.dispose();
  });

  test("malformed persisted binding is cleared through the serialized host path", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "pi",
      sessionId: "",
      cwd: process.cwd(),
    });

    const { controller } = createController(undefined, { state });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(state.get(key), undefined);
    controller.dispose();
  });

  test("ready restores persisted supported session without creating new", async () => {
    const state = new TestMemento();
    await state.update(activeSessionBindingKey(process.cwd()), {
      agentId: "pi",
      sessionId: "saved-1",
      cwd: process.cwd(),
      title: "Saved chat",
    });
    const { controller, managers } = createController(undefined, { state });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const active = controller.getStateForTest().sessions[0];
    assert.strictEqual(managers[0].loadCalls[0], "saved-1");
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(active.acpSessionId, "saved-1");
    assert.strictEqual(active.status, "idle");
    controller.dispose();
  });

  test("unsupported persisted load creates new ACP session", async () => {
    const state = new TestMemento();
    await state.update(activeSessionBindingKey(process.cwd()), {
      agentId: "pi",
      sessionId: "saved-2",
      cwd: process.cwd(),
    });
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.supportsLoadSession = false;
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const active = controller.getStateForTest().sessions[0];
    assert.deepStrictEqual(managers[0].loadCalls, []);
    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(active.acpSessionId, "acp-1");
    controller.dispose();
  });

  test("missing persisted load clears binding and creates replacement", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "pi",
      sessionId: "missing-1",
      cwd: process.cwd(),
    });
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadError = new Error("Session not found");
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(
      controller.getStateForTest().sessions[0].acpSessionId,
      "acp-1"
    );
    assert.strictEqual(state.get<any>(key)?.sessionId, "acp-1");
    controller.dispose();
  });

  test("generic persisted load error remains error and retains binding", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "pi",
      sessionId: "saved-err",
      cwd: process.cwd(),
    });
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadError = new Error("backend unavailable");
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const active = controller.getStateForTest().sessions[0];
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(active.status, "error");
    assert.strictEqual(active.acpSessionId, undefined);
    assert.strictEqual(state.get<any>(key)?.sessionId, "saved-err");
    controller.dispose();
  });

  test("unrelated invalid params do not discard a persisted session", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "pi",
      sessionId: "saved-invalid-params",
      cwd: process.cwd(),
    });
    const error = Object.assign(new Error("cwd must be absolute"), {
      code: -32602,
    });
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadError = error;
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(
      controller.getStateForTest().sessions[0].status,
      "error"
    );
    assert.strictEqual(state.get<any>(key)?.sessionId, "saved-invalid-params");
    controller.dispose();
  });

  test("string error data identifies a missing persisted session", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "pi",
      sessionId: "missing-string-data",
      cwd: process.cwd(),
    });
    const error = Object.assign(new Error("Invalid params"), {
      code: -32602,
      data: "Unknown sessionId: missing-string-data",
    });
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadError = error;
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(state.get<any>(key)?.sessionId, "acp-1");
    controller.dispose();
  });

  test("Codex no-rollout persisted load error creates a replacement", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "codex",
      sessionId: "019f6b9a-6ab8-7873-901a-1e17e915e5d6",
      cwd: process.cwd(),
    });
    const error = Object.assign(new Error("Internal error"), {
      code: -32603,
      data: {
        details:
          "no rollout found for thread id 019f6b9a-6ab8-7873-901a-1e17e915e5d6",
      },
    });
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadError = error;
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const active = controller.getStateForTest().sessions[0];
    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(active.status, "idle");
    assert.strictEqual(active.acpSessionId, "acp-1");
    assert.strictEqual(state.get<any>(key)?.sessionId, "acp-1");
    controller.dispose();
  });

  test("session-specific invalid params replace a missing persisted session", async () => {
    const state = new TestMemento();
    const key = activeSessionBindingKey(process.cwd());
    await state.update(key, {
      agentId: "pi",
      sessionId: "missing-invalid-params",
      cwd: process.cwd(),
    });
    const error = Object.assign(
      new Error("Unknown sessionId: missing-invalid-params"),
      { code: -32602 }
    );
    const { controller, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadError = error;
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(state.get<any>(key)?.sessionId, "acp-1");
    controller.dispose();
  });

  test("retry reuses pending resume target with fresh runtime", async () => {
    const state = new TestMemento();
    await state.update(activeSessionBindingKey(process.cwd()), {
      agentId: "pi",
      sessionId: "retry-target",
      cwd: process.cwd(),
    });
    let fail = true;
    const { controller, clients, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        if (fail) manager.loadError = new Error("backend unavailable");
      },
    });

    await controller.handleMessage({ type: "feature.multi-session.ready" });
    const localSessionId =
      controller.getStateForTest().sessions[0].localSessionId;
    fail = false;
    await controller.handleMessage({
      type: "feature.multi-session.retry",
      localSessionId,
    });

    assert.strictEqual(clients.length, 2);
    assert.strictEqual(managers[1].loadCalls[0], "retry-target");
    assert.strictEqual(
      controller.getStateForTest().sessions[0].acpSessionId,
      "retry-target"
    );
    controller.dispose();
  });

  test("failed retry restores the existing transcript surface", async () => {
    let clientCount = 0;
    const { controller } = createController(undefined, {
      configureManager: (manager) => {
        clientCount += 1;
        if (clientCount === 2) {
          manager.loadError = new Error("backend unavailable");
        }
      },
    });
    await controller.handleMessage({ type: "feature.multi-session.ready" });
    const sessionId = controller.getStateForTest().activeLocalSessionId!;
    const managedSession = (controller as any).sessions.get(sessionId);
    managedSession.transcript.append({ type: "userMessage", text: "keep me" });
    managedSession.status = "error";

    await controller.retry(sessionId);

    const snapshot = (managedSession.transcript as TranscriptStore).snapshot();
    assert.strictEqual(managedSession.status, "error");
    assert.strictEqual(
      snapshot.some((event) => event.message.text === "keep me"),
      true
    );
    controller.dispose();
  });

  test("retry reloads an established ACP session on a fresh runtime", async () => {
    const { controller, clients, managers } = createController();
    await controller.handleMessage({ type: "feature.multi-session.ready" });
    const sessionId = controller.getStateForTest().activeLocalSessionId!;
    const managedSession = (controller as any).sessions.get(sessionId);
    managedSession.status = "error";
    managedSession.lastError = "transport failed";

    await controller.retry(sessionId);

    assert.strictEqual(clients.length, 2);
    assert.deepStrictEqual(managers[1].loadCalls, ["acp-1"]);
    assert.strictEqual(managers[1].newCalls, 0);
    assert.strictEqual(controller.getStateForTest().sessions[0].status, "idle");
    assert.strictEqual(
      controller.getStateForTest().sessions[0].lastError,
      undefined
    );
    controller.dispose();
  });

  test("send joins deferred ready-time newSession; exactly one new; prompt waits", async () => {
    let releaseNew!: () => void;
    const newBlocked = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const { controller, clients, managers } = createController(undefined, {
      configureManager: (manager) => {
        manager.newPromise = newBlocked;
      },
    });

    const ready = controller.handleMessage({
      type: "feature.multi-session.ready",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = controller.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(clients.length, 1);
    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(clients[0].promptResolvers.length, 0);

    releaseNew();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(clients[0].promptResolvers.length, 1);

    clients[0].resolvePrompt();
    await prompt;
    await ready;
    controller.dispose();
  });

  test("send joins deferred persisted restore; no new session; prompt waits", async () => {
    const state = new TestMemento();
    await state.update(activeSessionBindingKey(process.cwd()), {
      agentId: "pi",
      sessionId: "saved-deferred",
      cwd: process.cwd(),
    });
    let releaseLoad!: () => void;
    const loadBlocked = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { controller, clients, managers } = createController(undefined, {
      state,
      configureManager: (manager) => {
        manager.loadPromise = loadBlocked;
      },
    });

    const ready = controller.handleMessage({
      type: "feature.multi-session.ready",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = controller.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepStrictEqual(managers[0].loadCalls, ["saved-deferred"]);
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(clients[0].promptResolvers.length, 0);

    releaseLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(clients[0].promptResolvers.length, 1);

    clients[0].resolvePrompt();
    await prompt;
    await ready;
    controller.dispose();
  });

  test("send joins deferred explicit history load; no new", async () => {
    let releaseLoad!: () => void;
    const loadBlocked = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { controller, clients, managers } = createController(undefined, {
      configureManager: (manager) => {
        manager.loadPromise = loadBlocked;
      },
    });

    const load = controller.loadHistorySession("history-deferred");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = controller.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepStrictEqual(managers[0].loadCalls, ["history-deferred"]);
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(clients[0].promptResolvers.length, 0);

    releaseLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(clients[0].promptResolvers.length, 1);

    clients[0].resolvePrompt();
    await prompt;
    await load;
    controller.dispose();
  });

  test("newChat emits one guarded focus intent after view focus", async () => {
    const focusCalls: string[] = [];
    const { controller, messages } = createController(undefined, {
      onFocusChat: async () => {
        focusCalls.push("focusView");
      },
    });
    const disposeEmitter = new vscode.EventEmitter<void>();
    controller.attachView({
      webview: { postMessage: async () => true } as any,
      onDidDispose: disposeEmitter.event,
      show: () => {},
    } as any);

    await controller.newChat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(
      messages.some(
        (message) => message.type === "feature.multi-session.focusInput"
      ),
      false
    );
    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const focusMessages = messages.filter(
      (message) => message.type === "feature.multi-session.focusInput"
    );
    const state = controller.getStateForTest();
    const snapshot = [...messages]
      .reverse()
      .find(
        (message) =>
          message.type === "feature.multi-session.snapshot" &&
          message.activeLocalSessionId === focusMessages[0].localSessionId
      );
    assert.strictEqual(focusCalls.length, 1);
    assert.strictEqual(focusMessages.length, 1);
    assert.strictEqual(
      focusMessages[0].localSessionId,
      state.activeLocalSessionId
    );
    assert.strictEqual(
      focusMessages[0].activationRevision,
      snapshot?.activationRevision
    );
    assert.strictEqual(
      typeof focusMessages[0].requestId === "string" &&
        focusMessages[0].requestId.startsWith("focus-"),
      true
    );

    await controller.handleMessage({
      type: "feature.multi-session.focusInputArmed",
      requestId: focusMessages[0].requestId as string,
      localSessionId: focusMessages[0].localSessionId as string,
      activationRevision: focusMessages[0].activationRevision as number,
    });
    const commit = messages.find(
      (message) => message.type === "feature.multi-session.focusInputCommit"
    );
    assert.ok(commit);
    assert.strictEqual(focusCalls.length, 2);

    await controller.handleMessage({
      type: "feature.multi-session.focusInputAck",
      requestId: focusMessages[0].requestId as string,
      localSessionId: focusMessages[0].localSessionId as string,
      activationRevision: focusMessages[0].activationRevision as number,
    });
    controller.dispose();
  });

  test("activating existing session requests input focus", async () => {
    const focusCalls: string[] = [];
    const { controller, messages } = createController(undefined, {
      onFocusChat: () => {
        focusCalls.push("focusView");
      },
    });
    await controller.newChat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    messages.length = 0;
    focusCalls.length = 0;
    const firstSession =
      controller.getStateForTest().sessions[0].localSessionId;

    controller.activateSession(firstSession, { focusChat: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.deepStrictEqual(focusCalls, ["focusView"]);
    assert.strictEqual(
      messages.some(
        (message) => message.type === "feature.multi-session.focusInput"
      ),
      true
    );
    controller.dispose();
  });

  test("deferred view focus is awaited and stale deferred input focus is dropped", async () => {
    let releaseFocus!: () => void;
    const focusStarted = new Promise<void>((resolve) => {
      releaseFocus = resolve;
    });
    const { controller, messages } = createController(undefined, {
      onFocusChat: () => focusStarted,
    });

    const first = controller.newChat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staleSession = controller.getStateForTest().activeLocalSessionId;
    await controller.newChat();
    releaseFocus();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.handleMessage({ type: "feature.multi-session.ready" });

    const focusMessages = messages.filter(
      (message) => message.type === "feature.multi-session.focusInput"
    );
    assert.ok(
      focusMessages.every((message) => message.localSessionId !== staleSession)
    );
    assert.strictEqual(focusMessages.length, 1);
    assert.strictEqual(
      focusMessages[0].localSessionId,
      controller.getStateForTest().activeLocalSessionId
    );
    controller.dispose();
  });

  test("newChat still emits input focus when view focus fails", async () => {
    const { controller, messages } = createController(undefined, {
      onFocusChat: async () => {
        throw new Error("focus failed");
      },
    });

    await controller.newChat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.handleMessage({ type: "feature.multi-session.ready" });

    assert.strictEqual(
      messages.filter(
        (message) => message.type === "feature.multi-session.focusInput"
      ).length,
      1
    );
    controller.dispose();
  });

  test("newChat activates a draft before background connect resolves", async () => {
    let releaseConnect!: () => void;
    const { controller, messages, clients } = createController((client) => {
      client.connectPromise = new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
    });

    await controller.newChat();

    // newChat resolved; draft is active but connect hasn't resolved yet
    const state = controller.getStateForTest();
    const active = state.sessions.find(
      (s) => s.localSessionId === state.activeLocalSessionId
    )!;
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].connectCalls, 1);
    assert.strictEqual(clients[0].state, "disconnected"); // still connecting
    // Status is "starting" because startRuntime completes synchronously
    // up to setting the status before yielding on connectPromise
    assert.strictEqual(active.status, "starting");

    // Verify snapshot was posted before connect resolved
    assert.ok(
      messages.some((m) => m.type === "feature.multi-session.snapshot")
    );

    releaseConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.dispose();
  });

  test("newChat creates an ACP session immediately", async () => {
    const { controller, clients, managers } = createController();

    await controller.newChat();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = controller.getStateForTest();
    const active = state.sessions.find(
      (s) => s.localSessionId === state.activeLocalSessionId
    )!;
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(typeof active.acpSessionId, "string");
    assert.strictEqual(active.status, "idle");
    controller.dispose();
  });

  test("background connect failure does not reject newChat and leaves retryable error", async () => {
    const { controller, messages, clients, managers } = createController(
      (client) => {
        client.connectError = new Error("connect failed");
      }
    );

    await controller.newChat();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = controller.getStateForTest();
    const active = state.sessions.find(
      (s) => s.localSessionId === state.activeLocalSessionId
    )!;
    const errors = messages.filter(
      (m) =>
        m.type === "feature.multi-session.delta" &&
        (m.event as any)?.message?.type === "error"
    );
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].disposeCalls, 1);
    assert.strictEqual(managers[0].newCalls, 0);
    assert.strictEqual(active.status, "error");
    assert.match(active.lastError ?? "", /connect failed/);
    assert.strictEqual(errors.length, 1);
    controller.dispose();
  });

  test("first send during pending newChat background startup reuses the same client and creates exactly one ACP session before send", async () => {
    let releaseConnect!: () => void;
    let resolveConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      resolveConnectStarted = resolve;
    });
    const { controller, clients, managers } = createController((client) => {
      client.connectPromise = new Promise<void>((resolve) => {
        releaseConnect = resolve;
        resolveConnectStarted();
      });
    });

    // Start newChat (background runtime begins connecting)
    const newChatPromise = controller.newChat();
    await connectStarted;

    // Send a message while runtime is still connecting
    const prompt = controller.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only one client, prompt not yet sent (connect still pending)
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].promptResolvers.length, 0);

    // Release the connect
    releaseConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // After connect: single client, single ACP session, one send proceeding
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].connectCalls, 1);
    assert.strictEqual(managers[0].newCalls, 1);
    assert.strictEqual(clients[0].promptResolvers.length, 1);

    clients[0].resolvePrompt();
    await prompt;
    await newChatPromise;
    controller.dispose();
  });

  test("preference restore skips setMode/setModel when metadata already advertises current values", async () => {
    const state = new TestMemento();
    await state.update("vscode-acp-chat.agentPreferences.v1", {
      "test-agent": {
        modeId: "chat",
        modelId: "claude-sonnet-4",
        configOptionValues: {},
        starredModels: [],
      },
    });

    const { controller: ctrl, clients } = createController(
      (client) => {
        client.metadata = {
          modes: {
            currentModeId: "chat",
            availableModes: [{ id: "chat", name: "Chat" }],
          },
          models: {
            currentModelId: "claude-sonnet-4",
            availableModels: [
              { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
            ],
          },
          genericConfigOptions: [],
          commands: null,
        };
      },
      { state }
    );

    // First send triggers ensureRuntime which restores preferences
    const prompt = ctrl.sendActiveMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // setMode and setModel should NOT be called since current values match
    assert.strictEqual(clients[0].setModeCalls, 0);
    assert.strictEqual(clients[0].setModelCalls, 0);

    clients[0].resolvePrompt();
    await prompt;
    ctrl.dispose();
  });

  test("start chat opens the active chat surface", async () => {
    const { controller, messages, clients } = createController();

    await controller.connectActive();

    const snapshot = [...messages]
      .reverse()
      .find(
        (message) => message.type === "feature.multi-session.snapshot"
      ) as any;

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

  test("failed start chat publishes error state instead of leaving starting visible", async () => {
    const { controller } = createController((client) => {
      client.connectError = new Error("connect failed");
    });

    await assert.rejects(controller.connectActive(), /connect failed/);

    const state = controller.getManagerStateSnapshot();
    const active = state.sessions.find(
      (session: any) => session.localSessionId === state.activeLocalSessionId
    );

    assert.strictEqual(active?.status, "error");
    assert.match(active?.lastError ?? "", /connect failed/);
    controller.dispose();
  });

  test("close drops a stale request after session identity changes", async () => {
    const { controller, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessionId = controller.getStateForTest().activeLocalSessionId!;

    const originalShowWarningMessage = vscode.window.showWarningMessage;
    let resolveConfirmation!: (value: "Stop and Close") => void;
    const confirmation = new Promise<"Stop and Close">((resolve) => {
      resolveConfirmation = resolve;
    });
    (vscode.window as any).showWarningMessage = () => confirmation;

    try {
      const close = controller.close(sessionId);
      const managedSession = (controller as any).sessions.get(sessionId);
      managedSession.identityEpoch += 1;
      resolveConfirmation("Stop and Close");
      await close;

      assert.strictEqual(controller.getStateForTest().sessions.length, 1);
      assert.strictEqual(clients[0].cancelCalls, 0);
    } finally {
      (vscode.window as any).showWarningMessage = originalShowWarningMessage;
      clients[0].resolvePrompt();
      await prompt;
      controller.dispose();
    }
  });

  test("closing last session creates a new active ACP session", async () => {
    const { controller, clients } = createController();
    const prompt = controller.sendActiveMessage("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    clients[0].resolvePrompt();
    await prompt;
    const sessionId = controller.getStateForTest().activeLocalSessionId!;
    await controller.close(sessionId);
    // close schedules runtime start in background; wait for it to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(clients[0].disposeCalls, 1);
    assert.strictEqual(controller.getStateForTest().sessions.length, 1);
    assert.strictEqual(
      controller.getStateForTest().sessions[0].status,
      "idle"
    );
    assert.strictEqual(
      typeof controller.getStateForTest().sessions[0].acpSessionId,
      "string"
    );
    assert.strictEqual(clients.length, 2);
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
