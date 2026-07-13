/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as vscode from "vscode";
import { ChatViewProvider } from "../views/chat";

class MockMemento implements vscode.Memento {
  private data = new Map<string, any>();
  get<T>(key: string): T | undefined {
    return this.data.get(key);
  }
  update(key: string, value: any): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }
}

class MockWebview {
  public messages: any[] = [];
  async postMessage(message: any) {
    this.messages.push(message);
    return true;
  }
  onDidReceiveMessage = new vscode.EventEmitter<any>().event;
  asWebviewUri(uri: vscode.Uri) {
    return uri;
  }
  cspSource = "";
  options = {};
  html = "";
}

class MockWebviewView implements vscode.WebviewView {
  public webview = new MockWebview() as any;
  public viewType = "test";
  public onDidChangeVisibility = new vscode.EventEmitter<void>().event;
  public onDidDispose = new vscode.EventEmitter<void>().event;
  public title = "test";
  public description = "test";
  public visible = true;
  public badge = undefined;
  public show() {}
}

class DelayedMockWebview extends MockWebview {
  constructor(private readonly delayFor: (message: any) => number) {
    super();
  }

  override async postMessage(message: any) {
    const delay = this.delayFor(message);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.messages.push(message);
    return true;
  }
}

function createHistoryLoadClient() {
  const sessionUpdateListeners: Array<(update: any) => void | Promise<void>> =
    [];
  const client = {
    setAgent: () => {},
    getAgentId: () => "test-agent",
    getAgentName: () => "Test Agent",
    getState: () => "connected",
    getCurrentSessionId: () => "current-session",
    getAgentCapabilities: () => ({ loadSession: true }),
    getNesDocumentCapabilities: () => ({
      didOpen: false,
      didChange: null,
      didClose: false,
      didSave: false,
      didFocus: false,
    }),
    getSessionMetadata: () => ({
      modes: null,
      models: null,
      genericConfigOptions: [],
      commands: null,
      lastUsageUpdate: null,
    }),
    clearLastUsageUpdate: () => {},
    setOnStateChange: () => () => {},
    setOnSessionUpdate: (cb: any) => {
      sessionUpdateListeners.push(cb);
      return () => {
        const idx = sessionUpdateListeners.indexOf(cb);
        if (idx >= 0) sessionUpdateListeners.splice(idx, 1);
      };
    },
    setOnStderr: () => () => {},
    setOnReadTextFile: () => {},
    setOnWriteTextFile: () => {},
    setOnCreateTerminal: () => {},
    setOnTerminalOutput: () => {},
    setOnWaitForTerminalExit: () => {},
    setOnKillTerminalCommand: () => {},
    setOnReleaseTerminal: () => {},
    setOnPermissionRequest: () => {},
    isConnected: () => true,
    connect: async () => {},
    newSession: async () => {},
    listSessions: async () => ({ sessions: [] }),
    loadSession: async () => {
      for (const cb of sessionUpdateListeners) {
        await cb({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "History answer." },
          },
        });
      }
      for (const cb of sessionUpdateListeners) {
        await cb({
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-late-complete",
            status: "completed",
            kind: "write",
            title: "Write generated file",
            rawInput: {
              path: "/tmp/vscode-acp-history-restoration-missing-file.txt",
              content: "generated content",
            },
          },
        });
      }
    },
    dispose: () => {},
  };

  return client;
}

async function waitForProviderQueues(
  provider: ChatViewProvider
): Promise<void> {
  await (provider as any).sessionUpdateNotifier.waitForIdle();
  await (provider as any).webviewPostNotifier.waitForIdle();
}

suite("History Restoration Order Integration", () => {
  let previousMultiSessionEnabled: boolean | undefined;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    previousMultiSessionEnabled = config.inspect<boolean>(
      "multiSession.enabled"
    )?.globalValue;
    await config.update(
      "multiSession.enabled",
      false,
      vscode.ConfigurationTarget.Global
    );
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .update(
        "multiSession.enabled",
        previousMultiSessionEnabled,
        vscode.ConfigurationTarget.Global
      );
  });

  test("serializes webview postMessage calls so streamEnd cannot overtake earlier messages", async () => {
    const memento = new MockMemento();
    const mockAcpClient = createHistoryLoadClient();
    const provider = new ChatViewProvider(
      vscode.Uri.file("/test"),
      mockAcpClient as any,
      memento
    );
    const mockView = new MockWebviewView();
    mockView.webview = new DelayedMockWebview((message) =>
      message.type === "streamChunk" ? 10 : 0
    ) as any;
    (provider as any).view = mockView;

    (provider as any).postMessage({ type: "streamChunk", text: "slow" });
    (provider as any).postMessage({ type: "streamEnd" });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepStrictEqual(
      mockView.webview.messages.map((m: any) => m.type),
      ["streamChunk", "streamEnd"]
    );
  });

  test("posts final history streamEnd after queued session updates are rendered", async () => {
    const memento = new MockMemento();
    const mockAcpClient = createHistoryLoadClient();
    const provider = new ChatViewProvider(
      vscode.Uri.file("/test"),
      mockAcpClient as any,
      memento
    );
    const mockView = new MockWebviewView();
    (provider as any).view = mockView;

    await provider.loadHistorySession("history-session");
    await waitForProviderQueues(provider);

    const messages = mockView.webview.messages;
    const finalStreamEndIndex = messages.findIndex(
      (m: any) => m.type === "streamEnd" && m.stopReason === "history_load"
    );
    const toolCompleteIndex = messages.findIndex(
      (m: any) =>
        m.type === "toolCallComplete" && m.toolCallId === "tool-late-complete"
    );

    assert.notStrictEqual(
      finalStreamEndIndex,
      -1,
      "history load should post a final streamEnd"
    );
    assert.notStrictEqual(
      toolCompleteIndex,
      -1,
      "queued tool completion should be rendered"
    );
    assert.ok(
      toolCompleteIndex < finalStreamEndIndex,
      "final streamEnd should not render before queued history updates"
    );
  });

  test("should post userMessage before thoughtChunk during history restoration", async () => {
    const memento = new MockMemento();
    const mockAcpClient = {
      setAgent: () => {},
      getAgentId: () => "test-agent",
      setOnStateChange: () => () => {},
      setOnSessionUpdate: (cb: any) => {
        mockAcpClient.sessionUpdateHandler = cb;
        return () => {};
      },
      setOnStderr: () => () => {},
      setOnReadTextFile: () => {},
      setOnWriteTextFile: () => {},
      setOnCreateTerminal: () => {},
      setOnTerminalOutput: () => {},
      setOnWaitForTerminalExit: () => {},
      setOnKillTerminalCommand: () => {},
      setOnReleaseTerminal: () => {},
      setOnPermissionRequest: () => {},
      isConnected: () => true,
      connect: async () => {},
      newSession: async () => {},
      sessionUpdateHandler: (_update: any) => {},
      dispose: () => {},
    };

    const provider = new ChatViewProvider(
      vscode.Uri.file("/test"),
      mockAcpClient as any,
      memento
    );

    const mockView = new MockWebviewView();
    provider.resolveWebviewView(mockView, {} as any, {} as any);

    // Simulate history loading scenario
    // We need to set isLoadingHistory to true so that user_message_chunk is not ignored
    // (During normal conversation, opencode echoes back user messages which should be ignored)
    (provider as any).isLoadingHistory = true;

    // Simulate history chunks
    const handler = mockAcpClient.sessionUpdateHandler;

    // 1. User message chunks
    await handler({
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Explain " },
      },
    });
    await handler({
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "this code." },
      },
    });

    // Verify no userMessage posted yet
    assert.strictEqual(
      mockView.webview.messages.filter((m: any) => m.type === "userMessage")
        .length,
      0
    );

    // 2. Agent thought chunk (should trigger flush)
    await handler({
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking..." },
      },
    });
    await waitForProviderQueues(provider);

    // 3. Verify order
    const messages = mockView.webview.messages;
    const userMsgIndex = messages.findIndex(
      (m: any) => m.type === "userMessage"
    );
    const thoughtChunkIndex = messages.findIndex(
      (m: any) => m.type === "thoughtChunk"
    );

    assert.notStrictEqual(userMsgIndex, -1, "userMessage should be posted");
    assert.notStrictEqual(
      thoughtChunkIndex,
      -1,
      "thoughtChunk should be posted"
    );
    assert.ok(
      userMsgIndex < thoughtChunkIndex,
      "userMessage should come before thoughtChunk"
    );

    assert.strictEqual(messages[userMsgIndex].text, "Explain this code.");
    assert.strictEqual(messages[thoughtChunkIndex].text, "Thinking...");
  });

  test("should not split user message when available_commands_update arrives between chunks", async () => {
    const memento = new MockMemento();
    const mockAcpClient = {
      setAgent: () => {},
      getAgentId: () => "test-agent",
      setOnStateChange: () => () => {},
      setOnSessionUpdate: (cb: any) => {
        mockAcpClient.sessionUpdateHandler = cb;
        return () => {};
      },
      setOnStderr: () => () => {},
      setOnReadTextFile: () => {},
      setOnWriteTextFile: () => {},
      setOnCreateTerminal: () => {},
      setOnTerminalOutput: () => {},
      setOnWaitForTerminalExit: () => {},
      setOnKillTerminalCommand: () => {},
      setOnReleaseTerminal: () => {},
      setOnPermissionRequest: () => {},
      isConnected: () => true,
      connect: async () => {},
      newSession: async () => {},
      sessionUpdateHandler: (_update: any) => {},
      dispose: () => {},
    };

    const provider = new ChatViewProvider(
      vscode.Uri.file("/test"),
      mockAcpClient as any,
      memento
    );

    const mockView = new MockWebviewView();
    provider.resolveWebviewView(mockView, {} as any, {} as any);
    (provider as any).isLoadingHistory = true;

    const handler = mockAcpClient.sessionUpdateHandler;

    // 1. User text chunk
    await handler({
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "image.png " },
      },
    });

    // 2. Metadata update arrives between user chunks (the bug trigger)
    await handler({
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "test", description: "test command" }],
      },
    });

    // 3. More user text with mention tags
    await handler({
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: '<mention type="image" name="image.png" />',
        },
      },
    });

    // 4. Agent chunk triggers flush
    await handler({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the answer." },
      },
    });
    await waitForProviderQueues(provider);

    const messages = mockView.webview.messages;
    const userMessages = messages.filter((m: any) => m.type === "userMessage");

    // Should be exactly ONE user message, not two
    assert.strictEqual(
      userMessages.length,
      1,
      `Expected 1 user message but got ${userMessages.length}`
    );

    // The single user message should contain all text merged.
    // "image.png" in the plain text is replaced by the placeholder since it
    // matches the mention name extracted from the <mention> tag.
    assert.strictEqual(
      userMessages[0].text,
      "__MENTION_0__",
      "User message should contain merged text with mention placeholder"
    );

    // Should have 1 mention (the image)
    assert.strictEqual(
      userMessages[0].mentions?.length,
      1,
      "Should have 1 mention"
    );
    assert.strictEqual(
      userMessages[0].mentions?.[0]?.type,
      "image",
      "Mention should be of type image"
    );
  });
});
