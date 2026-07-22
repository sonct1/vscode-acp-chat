/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import * as path from "path";
import { ChatViewProvider } from "../views/chat";

interface MockMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

interface MockACPClient {
  setAgent: (config: unknown) => void;
  getAgentId: () => string;
  getAgentName: () => string;
  getState: () => string;
  getAgentCapabilities: () => unknown;
  getNesDocumentCapabilities: () => unknown;
  clearLastUsageUpdate: () => void;
  setOnStateChange: (callback: (state: string) => void) => () => void;
  setOnSessionUpdate: (callback: (update: unknown) => void) => () => void;
  setOnStderr: (callback: (data: string) => void) => () => void;
  setOnReadTextFile: (callback: unknown) => void;
  setOnWriteTextFile: (callback: unknown) => void;
  setOnCreateTerminal: (callback: unknown) => void;
  setOnTerminalOutput: (callback: unknown) => void;
  setOnWaitForTerminalExit: (callback: unknown) => void;
  setOnKillTerminalCommand: (callback: unknown) => void;
  setOnReleaseTerminal: (callback: unknown) => void;
  setOnPermissionRequest: (callback: unknown) => void;
  setOnElicitationRequest: (callback: unknown) => void;
  isConnected: () => boolean;
  connect: () => Promise<void>;
  newSession: (dir: string) => Promise<{ sessionId: string }>;
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  getSessionMetadata: () => unknown;
  sendMessage?: (text: string, images?: string[], mentions?: unknown[]) => Promise<{ stopReason: string }>;
  cancel: () => Promise<void>;
  dispose: () => void;
}

class TestMemento implements MockMemento {
  private state = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.state.set(key, value);
  }

  keys(): readonly string[] {
    return Array.from(this.state.keys());
  }

  clear(): void {
    this.state.clear();
  }
}

class TestACPClient implements MockACPClient {
  private agentIdValue = "test-agent";
  public connectCallCount = 0;
  public newSessionCallCount = 0;
  public cancelCallCount = 0;
  public clearLastUsageUpdateCallCount = 0;
  public isConnectedValue = false;
  public connectError?: Error;
  public connectHook?: () => Promise<void> | void;
  public newSessionError?: Error;
  public newSessionHook?: () => Promise<void> | void;
  public sendMessageHook?: () => Promise<{ stopReason: string }> | { stopReason: string };
  private setModeCallCount = 0;
  private setModelCallCount = 0;
  private setConfigOptionCallCount = 0;
  public lastSetModeId: string | null = null;
  public lastSetModelId: string | null = null;
  public lastSetConfigOptionId: string | null = null;
  public lastSetConfigOptionValue: string | null = null;
  public elicitationRequest?: (context: unknown) => Promise<unknown>;
  public permissionRequest?: (params: unknown) => Promise<unknown>;
  public stateChange?: (state: string) => void;
  public cancelHook?: () => Promise<void> | void;

  setAgent(config: any): void {
    if (config && config.id) {
      this.agentIdValue = config.id;
    }
  }
  getAgentId(): string {
    return this.agentIdValue;
  }
  getAgentName(): string {
    return this.agentIdValue;
  }
  getState(): string {
    return this.isConnectedValue ? "connected" : "disconnected";
  }
  getAgentCapabilities(): unknown {
    return {
      loadSession: true,
      sessionCapabilities: { list: true, delete: true },
    };
  }
  getNesDocumentCapabilities(): unknown {
    return {
      didOpen: false,
      didChange: null,
      didClose: false,
      didSave: false,
      didFocus: false,
    };
  }
  clearLastUsageUpdate(): void {
    this.clearLastUsageUpdateCallCount += 1;
  }
  setOnStateChange(callback: (state: string) => void): () => void {
    this.stateChange = callback;
    return () => {};
  }
  setOnSessionUpdate(): () => void {
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
  setOnPermissionRequest(callback: unknown): void {
    this.permissionRequest = callback as (params: unknown) => Promise<unknown>;
  }
  setOnElicitationRequest(callback: unknown): void {
    this.elicitationRequest = callback as (
      context: unknown
    ) => Promise<unknown>;
  }
  isConnected(): boolean {
    return this.isConnectedValue;
  }
  async connect(): Promise<void> {
    this.connectCallCount += 1;
    await this.connectHook?.();
    if (this.connectError) throw this.connectError;
    this.isConnectedValue = true;
  }
  async newSession(): Promise<{ sessionId: string }> {
    this.newSessionCallCount += 1;
    await this.newSessionHook?.();
    if (this.newSessionError) throw this.newSessionError;
    return { sessionId: `test-session-${this.newSessionCallCount}` };
  }

  async setMode(modeId: string): Promise<void> {
    this.setModeCallCount++;
    this.lastSetModeId = modeId;
  }

  async setModel(modelId: string): Promise<void> {
    this.setModelCallCount++;
    this.lastSetModelId = modelId;
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.setConfigOptionCallCount++;
    this.lastSetConfigOptionId = configId;
    this.lastSetConfigOptionValue = value;
  }

  getSessionMetadata(): unknown {
    return {
      modes: null,
      models: null,
      genericConfigOptions: [],
      commands: null,
    };
  }

  async sendMessage(): Promise<{ stopReason: string }> {
    if (this.sendMessageHook) return this.sendMessageHook();
    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {
    this.cancelCallCount += 1;
    await this.cancelHook?.();
  }

  getCurrentSessionId(): string | null {
    return null;
  }

  dispose(): void {}

  getSetModeCallCount(): number {
    return this.setModeCallCount;
  }

  getSetModelCallCount(): number {
    return this.setModelCallCount;
  }

  getSetConfigOptionCallCount(): number {
    return this.setConfigOptionCallCount;
  }

  resetCallCounts(): void {
    this.setModeCallCount = 0;
    this.setModelCallCount = 0;
    this.connectCallCount = 0;
    this.newSessionCallCount = 0;
    this.cancelCallCount = 0;
    this.clearLastUsageUpdateCallCount = 0;
    this.isConnectedValue = false;
    this.connectError = undefined;
    this.connectHook = undefined;
    this.newSessionError = undefined;
    this.newSessionHook = undefined;
    this.sendMessageHook = undefined;
    this.setConfigOptionCallCount = 0;
    this.lastSetModeId = null;
    this.lastSetModelId = null;
    this.lastSetConfigOptionId = null;
    this.lastSetConfigOptionValue = null;
  }
}

function getAgentPrefs(
  memento: TestMemento,
  agentId: string
):
  | {
      modeId?: string;
      modelId?: string;
      starredModels: string[];
      modelConfigOptionValues?: Record<string, Record<string, string>>;
    }
  | undefined {
  const all = memento.get<Record<string, any>>(
    "vscode-acp-chat.agentPreferences.v1"
  );
  return all?.[agentId];
}

suite("ChatViewProvider", () => {
  let memento: TestMemento;
  let acpClient: TestACPClient;
  let mockExtensionUri: vscode.Uri;
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

  setup(async () => {
    memento = new TestMemento();
    acpClient = new TestACPClient();
    mockExtensionUri = vscode.Uri.file("/mock/extension");
    // Pre-set a non-existent agent ID so constructor keeps the default test-agent
    await memento.update("vscode-acp-chat.selectedAgent", "test-agent");
  });

  teardown(() => {
    memento.clear();
    acpClient.resetCallCounts();
  });

  suite("Webview Theme Styles", () => {
    test("loads highlight styles from stylesheet instead of fixed dark inline theme", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const html = (provider as any).getHtmlContent({
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: "vscode-resource:",
      });

      assert.ok(
        !html.includes("Highlight.js GitHub Dark Theme"),
        "webview HTML should not inline a fixed dark highlight.js theme"
      );
      assert.ok(
        !html.includes("#0d1117"),
        "webview HTML should not force a dark code block background"
      );
      assert.ok(
        !html.includes("#c9d1d9"),
        "webview HTML should not force dark-theme foreground colors"
      );
    });

    test("defines VS Code light and dark palettes for markdown code blocks", () => {
      const cssPath = path.resolve(__dirname, "../../media/vscode.css");
      const css = fs.readFileSync(cssPath, "utf8");

      assert.ok(
        css.includes("body.vscode-light"),
        "highlight styles should include a light theme selector"
      );
      assert.ok(
        css.includes("body.vscode-dark"),
        "highlight styles should include a dark theme selector"
      );
      assert.ok(
        css.includes("--acp-hljs-foreground"),
        "highlight styles should expose theme-aware syntax variables"
      );
      assert.ok(
        css.includes("var(--vscode-textCodeBlock-background"),
        "highlight background should derive from VS Code code block colors"
      );
      assert.ok(
        css.includes(".hljs"),
        "highlight.js token classes should be styled by the shared stylesheet"
      );
    });
  });

  suite("Mention insertion API", () => {
    test("addMention posts generic path-only mention", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      provider.addMention({
        type: "file",
        name: "example.ts",
        path: "/workspace/example.ts",
      });

      assert.deepStrictEqual(messages, [
        {
          type: "addMention",
          mention: {
            type: "file",
            name: "example.ts",
            path: "/workspace/example.ts",
          },
        },
      ]);
      provider.dispose();
    });

    test("addSelection remains a backward-compatible alias", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      provider.addSelection({
        type: "selection",
        name: "example.ts:1-2",
        path: "/workspace/example.ts",
        content: "const value = 1;",
        range: { startLine: 1, endLine: 2 },
      });

      assert.deepStrictEqual(messages[0], {
        type: "addMention",
        mention: {
          type: "selection",
          name: "example.ts:1-2",
          path: "/workspace/example.ts",
          content: "const value = 1;",
          range: { startLine: 1, endLine: 2 },
        },
      });
      provider.dispose();
    });
  });

  suite("Mode/Model Persistence with Validation", () => {
    test("should validate and restore saved mode against available modes", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": { modeId: "test-mode", starredModels: [] },
      });

      class ACPClientWithModes extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [
                { id: "test-mode", name: "Test Mode" },
                { id: "other-mode", name: "Other Mode" },
              ],
              currentModeId: "other-mode",
            },
            models: null,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModes();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;
      await restoreMethod.call(provider);

      assert.strictEqual(client.lastSetModeId, "test-mode");
      assert.strictEqual(client.getSetModeCallCount(), 1);
    });

    test("should migrate saved Pi thinking mode to thought_level config option", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        pi: { modeId: "high", configOptionValues: {}, starredModels: [] },
      });

      class PiACPClientWithThoughtLevel extends TestACPClient {
        constructor() {
          super();
          this.setAgent({ id: "pi" });
        }

        getSessionMetadata() {
          return {
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
                  { value: "high", name: "High" },
                ],
              },
            ],
            commands: null,
          };
        }
      }

      const client = new PiACPClientWithThoughtLevel();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      await (provider as any).restoreSessionPreferences();

      assert.strictEqual(client.getSetModeCallCount(), 0);
      assert.strictEqual(client.lastSetConfigOptionId, "thought_level");
      assert.strictEqual(client.lastSetConfigOptionValue, "high");
      const pref = getAgentPrefs(memento, "pi") as any;
      assert.strictEqual(pref.modeId, undefined);
      assert.strictEqual(pref.configOptionValues.thought_level, "high");
    });

    test("should validate and restore saved model against available models", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": { modelId: "gpt-4", starredModels: [] },
      });

      class ACPClientWithModels extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "gpt-4", name: "GPT-4" },
                { modelId: "gpt-3.5", name: "GPT-3.5" },
              ],
              currentModelId: "gpt-3.5",
            },
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModels();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;
      await restoreMethod.call(provider);

      assert.strictEqual(client.lastSetModelId, "gpt-4");
      assert.strictEqual(client.getSetModelCallCount(), 1);
    });

    test("should skip invalid mode IDs not in available modes", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": { modeId: "removed-mode", starredModels: [] },
      });

      class ACPClientWithModes extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [
                { id: "valid-mode-1", name: "Valid Mode 1" },
                { id: "valid-mode-2", name: "Valid Mode 2" },
              ],
              currentModeId: "valid-mode-1",
            },
            models: null,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModes();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;
      await restoreMethod.call(provider);

      assert.strictEqual(client.getSetModeCallCount(), 0);
    });

    test("should skip invalid model IDs not in available models", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": { modelId: "removed-model", starredModels: [] },
      });

      class ACPClientWithModels extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "valid-model-1", name: "Valid Model 1" },
                { modelId: "valid-model-2", name: "Valid Model 2" },
              ],
              currentModelId: "valid-model-1",
            },
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModels();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;
      await restoreMethod.call(provider);

      assert.strictEqual(client.getSetModelCallCount(), 0);
    });

    test("should not restore if nothing is saved", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;
      await restoreMethod.call(provider);

      assert.strictEqual(acpClient.getSetModeCallCount(), 0);
      assert.strictEqual(acpClient.getSetModelCallCount(), 0);
    });

    test("should throw but be caught by caller if restoration fails", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": { modeId: "test-mode", starredModels: [] },
      });

      class FailingACPClient extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [{ id: "test-mode", name: "Test Mode" }],
              currentModeId: "test-mode",
            },
            models: null,
            commands: null,
          };
        }

        async setMode(): Promise<void> {
          throw new Error("Failed to set mode");
        }
      }

      const client = new FailingACPClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;

      await assert.rejects(() => restoreMethod.call(provider));
    });
  });

  suite("Mode/Model Storage on Change", () => {
    test("should persist mode to agent-scoped globalState when changed", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModeChange = (provider as any).handleModeChange;
      await handleModeChange.call(provider, "new-mode");

      const pref = getAgentPrefs(memento, "test-agent");
      assert.strictEqual(pref?.modeId, "new-mode");
    });

    test("should persist model to agent-scoped globalState when changed", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModelChange = (provider as any).handleModelChange;
      await handleModelChange.call(provider, "new-model");

      const pref = getAgentPrefs(memento, "test-agent");
      assert.strictEqual(pref?.modelId, "new-model");
    });

    test("should call ACP client setMode before persisting", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      acpClient.resetCallCounts();
      const handleModeChange = (provider as any).handleModeChange;
      await handleModeChange.call(provider, "new-mode");

      assert.strictEqual(acpClient.lastSetModeId, "new-mode");
      assert.ok(acpClient.getSetModeCallCount() >= 1);
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modeId,
        "new-mode"
      );
    });

    test("should call ACP client setModel before persisting", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      acpClient.resetCallCounts();
      const handleModelChange = (provider as any).handleModelChange;
      await handleModelChange.call(provider, "new-model");

      assert.strictEqual(acpClient.lastSetModelId, "new-model");
      assert.ok(acpClient.getSetModelCallCount() >= 1);
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modelId,
        "new-model"
      );
    });

    test("should handle mode change errors gracefully", async () => {
      class FailingACPClient extends TestACPClient {
        async setMode(): Promise<void> {
          throw new Error("Failed to set mode");
        }
      }

      const failingClient = new FailingACPClient();

      const provider = new ChatViewProvider(
        mockExtensionUri,
        failingClient as any,
        memento as any
      );

      const handleModeChange = (provider as any).handleModeChange;

      await handleModeChange.call(provider, "new-mode");

      const pref = getAgentPrefs(memento, "test-agent");
      assert.strictEqual(pref, undefined);
    });

    test("should handle model change errors gracefully", async () => {
      class FailingACPClient extends TestACPClient {
        async setModel(): Promise<void> {
          throw new Error("Failed to set model");
        }
      }

      const failingClient = new FailingACPClient();

      const provider = new ChatViewProvider(
        mockExtensionUri,
        failingClient as any,
        memento as any
      );

      const handleModelChange = (provider as any).handleModelChange;

      await handleModelChange.call(provider, "new-model");

      const pref = getAgentPrefs(memento, "test-agent");
      assert.strictEqual(pref, undefined);
    });

    test("should update agent preference with new values when changed multiple times", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModeChange = (provider as any).handleModeChange;

      await handleModeChange.call(provider, "mode-1");
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modeId,
        "mode-1"
      );

      acpClient.resetCallCounts();

      await handleModeChange.call(provider, "mode-2");
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modeId,
        "mode-2"
      );
    });
  });

  suite("Agent-Scoped Preference Isolation", () => {
    test("should keep mode/model isolated per agent", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModeChange = (provider as any).handleModeChange;
      const handleModelChange = (provider as any).handleModelChange;

      await handleModeChange.call(provider, "agent-a-mode");
      await handleModelChange.call(provider, "agent-a-model");

      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modeId,
        "agent-a-mode"
      );
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modelId,
        "agent-a-model"
      );

      // Switch to another agent
      acpClient.setAgent({ id: "agent-b" });

      await handleModeChange.call(provider, "agent-b-mode");
      await handleModelChange.call(provider, "agent-b-model");

      assert.strictEqual(
        getAgentPrefs(memento, "agent-b")?.modeId,
        "agent-b-mode"
      );
      assert.strictEqual(
        getAgentPrefs(memento, "agent-b")?.modelId,
        "agent-b-model"
      );

      // Agent A should be untouched
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modeId,
        "agent-a-mode"
      );
      assert.strictEqual(
        getAgentPrefs(memento, "test-agent")?.modelId,
        "agent-a-model"
      );
    });

    test("should restore mode/model for the current agent only", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "agent-a": { modeId: "mode-a", modelId: "model-a", starredModels: [] },
        "agent-b": { modeId: "mode-b", modelId: "model-b", starredModels: [] },
      });

      class ACPClientWithBoth extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [
                { id: "mode-a", name: "Mode A" },
                { id: "mode-b", name: "Mode B" },
              ],
              currentModeId: "mode-a",
            },
            models: {
              availableModels: [
                { modelId: "model-a", name: "Model A" },
                { modelId: "model-b", name: "Model B" },
              ],
              currentModelId: "model-a",
            },
            commands: null,
          };
        }
      }

      const client = new ACPClientWithBoth();
      client.setAgent({ id: "agent-b" });

      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSessionPreferences;
      await restoreMethod.call(provider);

      assert.strictEqual(client.lastSetModeId, "mode-b");
      assert.strictEqual(client.lastSetModelId, "model-b");
    });
  });

  suite("StarredModels Toggle", () => {
    test("should add starred model via toggleModelStar message", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      // Simulate receiving toggleModelStar message
      await (provider as any).handleMessage?.call(provider, {
        type: "toggleModelStar",
        modelId: "gpt-4",
        isStarred: true,
      });

      // Access private method directly via the message handler path
      // Since handleMessage is not exposed, use reflection to invoke the switch case path
      // We'll instead invoke updateCurrentAgentPreference directly
      const updatePref = (provider as any).updateCurrentAgentPreference;
      await updatePref.call(provider, (pref: any) => {
        const s = new Set(pref.starredModels);
        s.add("gpt-4");
        return { ...pref, starredModels: Array.from(s) };
      });

      const pref = getAgentPrefs(memento, "test-agent");
      assert.deepStrictEqual(pref?.starredModels, ["gpt-4"]);
    });

    test("should remove starred model via toggleModelStar message", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": { starredModels: ["gpt-4", "claude-3"] },
      });

      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const updatePref = (provider as any).updateCurrentAgentPreference;
      await updatePref.call(provider, (pref: any) => {
        const s = new Set(pref.starredModels);
        s.delete("gpt-4");
        return { ...pref, starredModels: Array.from(s) };
      });

      const pref = getAgentPrefs(memento, "test-agent");
      assert.deepStrictEqual(pref?.starredModels, ["claude-3"]);
    });

    test("should keep starredModels isolated per agent", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "agent-a": { starredModels: ["gpt-4"] },
        "agent-b": { starredModels: ["claude-3"] },
      });

      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const updatePref = (provider as any).updateCurrentAgentPreference;
      await updatePref.call(provider, (pref: any) => {
        const s = new Set(pref.starredModels);
        s.add("o1");
        return { ...pref, starredModels: Array.from(s) };
      });

      assert.deepStrictEqual(
        getAgentPrefs(memento, "test-agent")?.starredModels,
        ["o1"]
      );
      assert.deepStrictEqual(getAgentPrefs(memento, "agent-a")?.starredModels, [
        "gpt-4",
      ]);
      assert.deepStrictEqual(getAgentPrefs(memento, "agent-b")?.starredModels, [
        "claude-3",
      ]);
    });
  });

  suite("Turn Separation and History Restoration", () => {
    test("flushUserMessageBuffer sends streamEnd before userMessage", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      // Set up buffer
      (provider as any).userMessageBuffer = "Test question";

      // Trigger flush
      (provider as any).flushUserMessageBuffer();

      assert.strictEqual(messages.length, 2);
      assert.strictEqual(
        messages[0].type,
        "streamEnd",
        "streamEnd should be sent first"
      );
      assert.strictEqual(
        messages[1].type,
        "userMessage",
        "userMessage should be sent second"
      );
    });

    test("sends streamChunk and thoughtChunk to webview", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
      });
      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking" },
        },
      });

      const streamChunk = messages.find((m) => m.type === "streamChunk");
      const thoughtChunk = messages.find((m) => m.type === "thoughtChunk");

      assert.strictEqual(streamChunk?.text, "Hello");
      assert.strictEqual(thoughtChunk?.text, "Thinking");
    });
  });

  suite("Tool Call Updates", () => {
    test("treats a completed tool_call as a complete event", async () => {
      const config = vscode.workspace.getConfiguration("vscode-acp-chat");
      const previous =
        config.inspect<boolean>("enableDiffSummary")?.globalValue;
      await config.update(
        "enableDiffSummary",
        true,
        vscode.ConfigurationTarget.Global
      );
      const filePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "vscode-acp-chat-summary-")),
        "NewFile.kt"
      );
      fs.writeFileSync(filePath, "class NewFile\n");
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      try {
        await (provider as any).handleSessionUpdate({
          sessionId: "test",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "file-change-1",
            title: "Editing files",
            kind: "edit",
            status: "completed",
            content: [
              {
                type: "diff",
                path: filePath,
                oldText: null,
                newText: "class NewFile\n",
              },
            ],
          },
        });

        const diffSummary = messages.find((m) => m.type === "diffSummary");
        assert.ok(
          diffSummary,
          "structured diff should update the summary panel"
        );
        assert.deepStrictEqual(diffSummary.changes, [
          {
            path: filePath,
            relativePath: vscode.workspace.asRelativePath(filePath),
            oldText: null,
            newText: "class NewFile\n",
            status: "pending",
          },
        ]);

        const complete = messages.find((m) => m.type === "toolCallComplete");
        assert.ok(complete, "completed tool_call should finalize the tool");
        assert.strictEqual(complete.toolCallId, "file-change-1");
        assert.strictEqual(complete.title, "Editing files");
        assert.strictEqual(complete.kind, "edit");
        assert.strictEqual(complete.status, "completed");
        assert.deepStrictEqual(complete.content, [
          {
            type: "diff",
            path: filePath,
            oldText: null,
            newText: "class NewFile\n",
          },
        ]);
        assert.strictEqual(
          (provider as any).toolCalls.has("file-change-1"),
          false,
          "completed tool_call should not leave stale tool call state"
        );
      } finally {
        provider.dispose();
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
        await config.update(
          "enableDiffSummary",
          previous,
          vscode.ConfigurationTarget.Global
        );
      }
    });

    test("does not post bottom diff summary when disabled", async () => {
      const filePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "vscode-acp-chat-disabled-")),
        "Disabled.kt"
      );
      fs.writeFileSync(filePath, "after\n");
      const config = vscode.workspace.getConfiguration("vscode-acp-chat");
      const previous =
        config.inspect<boolean>("enableDiffSummary")?.globalValue;
      await config.update(
        "enableDiffSummary",
        false,
        vscode.ConfigurationTarget.Global
      );
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      try {
        const messages: any[] = [];
        (provider as any).postMessage = (msg: any) => messages.push(msg);

        await (provider as any).handleSessionUpdate({
          sessionId: "test",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "file-change-summary-disabled",
            title: "Editing files",
            kind: "edit",
            status: "completed",
            content: [
              {
                type: "diff",
                path: filePath,
                oldText: "before\n",
                newText: "after\n",
              },
            ],
          },
        });

        assert.ok(messages.some((m) => m.type === "toolCallComplete"));
        assert.ok(!messages.some((m) => m.type === "diffSummary"));
        assert.deepStrictEqual(
          (provider as any).diffManager.getPendingChanges(),
          [
            {
              path: filePath,
              oldText: "before\n",
              newText: "after\n",
              status: "pending",
            },
          ]
        );
      } finally {
        provider.dispose();
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
        await config.update(
          "enableDiffSummary",
          previous,
          vscode.ConfigurationTarget.Global
        );
      }
    });

    test("treats a failed tool_call as a complete event", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "file-change-failed",
          title: "Editing files",
          kind: "edit",
          status: "failed",
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "failed tool_call should finalize the tool");
      assert.strictEqual(complete.toolCallId, "file-change-failed");
      assert.strictEqual(complete.title, "Editing files");
      assert.strictEqual(complete.kind, "edit");
      assert.strictEqual(complete.status, "failed");
      assert.strictEqual(
        (provider as any).toolCalls.has("file-change-failed"),
        false,
        "failed tool_call should not leave stale tool call state"
      );
    });

    test("uses rawOutput text field as terminal output", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-text-output",
          title: "run command",
          kind: "execute",
          status: "completed",
          rawInput: {
            command: "ls",
            cwd: "/test/project",
          },
          rawOutput: {
            type: "text",
            text: "Exited with code 0. Final output:\nschema.json\n",
          },
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "command should complete");
      assert.strictEqual(complete.toolCallId, "command-text-output");
      assert.strictEqual(
        complete.terminalOutput,
        "Exited with code 0. Final output:\nschema.json\n"
      );
    });

    test("uses rawOutput string directly as terminal output", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-string-output",
          title: "run command",
          kind: "execute",
          status: "completed",
          rawInput: {
            command: "echo hello",
          },
          rawOutput: "hello\n",
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "command should complete");
      assert.strictEqual(complete.toolCallId, "command-string-output");
      assert.strictEqual(complete.terminalOutput, "hello\n");
    });

    test("falls back to key:value format when no known output fields match", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-kv-fallback",
          title: "run command",
          kind: "execute",
          status: "completed",
          rawInput: {
            command: "test",
            cwd: "/test/project",
          },
          rawOutput: {
            exit_code: 0,
            signal: null,
          },
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "command should complete");
      assert.strictEqual(complete.toolCallId, "command-kv-fallback");
      assert.strictEqual(complete.terminalOutput, "exit_code: 0\nsignal: null");
    });

    test("uses codex formatted_output as terminal output", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "command-formatted-output",
          title: "git diff --check",
          kind: "execute",
          status: "in_progress",
          content: [
            {
              type: "terminal",
              terminalId: "command-formatted-output",
            },
          ],
          rawInput: {
            command: "git diff --check",
            cwd: "/test/project",
          },
        },
      });
      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-formatted-output",
          status: "completed",
          rawOutput: {
            formatted_output: "Checked 2 files\n",
            exit_code: 0,
          },
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "command should complete");
      assert.strictEqual(complete.toolCallId, "command-formatted-output");
      assert.strictEqual(complete.terminalOutput, "Checked 2 files\n");
    });

    test("renders final-only command completion with output", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-final-only",
          title: "git status --short",
          kind: "execute",
          status: "completed",
          rawInput: {
            command: "git status --short",
            cwd: "/test/project",
          },
          rawOutput: {
            formatted_output: "M src/views/chat.ts\n",
            exit_code: 0,
          },
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "final-only command should still render");
      assert.strictEqual(complete.toolCallId, "command-final-only");
      assert.strictEqual(complete.title, "git status --short");
      assert.strictEqual(complete.kind, "execute");
      assert.strictEqual(complete.terminalOutput, "M src/views/chat.ts\n");
      assert.deepStrictEqual(complete.rawInput, {
        command: "git status --short",
        cwd: "/test/project",
      });
    });

    test("preserves start content when completion only updates status", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      const diffContent = [
        {
          type: "diff",
          path: "/test/project/src/file.ts",
          oldText: "old\n",
          newText: "new\n",
        },
      ];

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "file-change-status-only",
          title: "Editing files",
          kind: "edit",
          status: "in_progress",
          content: diffContent,
        },
      });
      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "file-change-status-only",
          status: "completed",
        },
      });

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(complete, "status-only completion should finalize the tool");
      assert.strictEqual(complete.toolCallId, "file-change-status-only");
      assert.strictEqual(complete.title, "Editing files");
      assert.strictEqual(complete.kind, "edit");
      assert.deepStrictEqual(complete.content, diffContent);
      assert.strictEqual(
        (provider as any).toolCalls.has("file-change-status-only"),
        false,
        "status-only completion should clear tool call state"
      );
    });

    test("synthesizes completion for pending live tools before stream end", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      const diffContent = [
        {
          type: "diff",
          path: "/test/project/src/live.ts",
          oldText: "before\n",
          newText: "after\n",
        },
      ];

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "live-write-no-final",
          title: "Editing files",
          kind: "edit",
          status: "in_progress",
          content: diffContent,
        },
      });

      await (provider as any).finalizePendingToolCalls("end_turn");

      const complete = messages.find((m) => m.type === "toolCallComplete");
      assert.ok(
        complete,
        "pending live tool should be synthesized as complete"
      );
      assert.strictEqual(complete.toolCallId, "live-write-no-final");
      assert.strictEqual(complete.status, "completed");
      assert.strictEqual(complete.title, "Editing files");
      assert.strictEqual(complete.kind, "edit");
      assert.deepStrictEqual(complete.content, diffContent);
      assert.strictEqual(
        (provider as any).toolCalls.has("live-write-no-final"),
        false,
        "synthesized completion should clear tool call state"
      );
    });
  });

  suite("Context Usage Indicator", () => {
    test("forwards usage_update to webview as contextUsage", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);

      const lastUpdate: any = {
        used: 5000,
        size: 10000,
        cost: { amount: 0.0012, currency: "USD" },
      };
      const sessionMeta: any = {
        modes: null,
        models: null,
        commands: null,
        lastUsageUpdate: null,
      };
      (acpClient as any).setLastUsageUpdate = (payload: any) => {
        sessionMeta.lastUsageUpdate = payload;
      };
      (acpClient as any).getSessionMetadata = () => sessionMeta;

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "usage_update",
          used: 5000,
          size: 10000,
          cost: { amount: 0.0012, currency: "USD" },
        },
      });

      const usageMsg = messages.find((m) => m.type === "contextUsage");
      assert.ok(usageMsg, "contextUsage message should be sent");
      assert.strictEqual(usageMsg.used, 5000);
      assert.strictEqual(usageMsg.size, 10000);
      assert.deepStrictEqual(usageMsg.cost, {
        amount: 0.0012,
        currency: "USD",
      });
      assert.deepStrictEqual(sessionMeta.lastUsageUpdate, lastUpdate);
    });

    test("ignores malformed usage_update with size <= 0", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);
      let setCalled = false;
      (acpClient as any).setLastUsageUpdate = () => {
        setCalled = true;
      };

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: { sessionUpdate: "usage_update", used: 0, size: 0 },
      });
      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: { sessionUpdate: "usage_update", used: 100 },
      });

      assert.strictEqual(
        setCalled,
        false,
        "setLastUsageUpdate should not be called"
      );
      const usageMsgs = messages.filter((m) => m.type === "contextUsage");
      assert.strictEqual(usageMsgs.length, 0);
    });

    test("clears usage when Pi context usage is explicitly unavailable", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);
      let cleared = false;
      (acpClient as any).clearLastUsageUpdate = () => {
        cleared = true;
      };
      (acpClient as any).getSessionMetadata = () => ({
        modes: null,
        models: null,
        commands: null,
        lastUsageUpdate: null,
      });

      await (provider as any).handleSessionUpdate({
        sessionId: "test",
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            piAcp: {
              contextUsage: {
                state: "unavailable",
                size: 1050000,
                reason: "post_compaction",
              },
            },
          },
        },
      });

      assert.strictEqual(cleared, true);
      const usageMsg = messages.find((m) => m.type === "contextUsage");
      assert.ok(usageMsg);
      assert.strictEqual(usageMsg.used, null);
      assert.strictEqual(usageMsg.size, null);
    });

    test("sendContextUsage emits clear message when no usage data", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);
      (acpClient as any).getSessionMetadata = () => ({
        modes: null,
        models: null,
        commands: null,
        lastUsageUpdate: null,
      });

      (provider as any).sendContextUsage();

      const usageMsg = messages.find((m) => m.type === "contextUsage");
      assert.ok(usageMsg);
      assert.strictEqual(usageMsg.used, null);
      assert.strictEqual(usageMsg.size, null);
      assert.strictEqual(usageMsg.cost, null);
    });

    test("sendContextUsage replays last-known usage", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (msg: any) => messages.push(msg);
      (acpClient as any).getSessionMetadata = () => ({
        modes: null,
        models: null,
        commands: null,
        lastUsageUpdate: {
          used: 7000,
          size: 14000,
          cost: { amount: 0.005, currency: "EUR" },
        },
      });

      (provider as any).sendContextUsage();

      const usageMsg = messages.find((m) => m.type === "contextUsage");
      assert.ok(usageMsg);
      assert.strictEqual(usageMsg.used, 7000);
      assert.strictEqual(usageMsg.size, 14000);
      assert.deepStrictEqual(usageMsg.cost, {
        amount: 0.005,
        currency: "EUR",
      });
    });
  });

  suite("Per-Model thought_level Preferences", () => {
    const defaultGenericConfigOptions = [
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        options: [
          { value: "off", name: "Off" },
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
        currentValue: "medium",
      },
    ];

    test("should save thought_level per model when config option changes", async () => {
      class ACPClientWithThought extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [{ modelId: "model-a", name: "Model A" }],
              currentModelId: "model-a",
            },
            genericConfigOptions: defaultGenericConfigOptions,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithThought();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      // Set model first
      await (provider as any).handleModelChange("model-a");
      // Change thought_level
      await (provider as any).handleConfigOptionChange("thought_level", "high");

      const pref = getAgentPrefs(memento, "test-agent");
      assert.strictEqual(pref?.modelId, "model-a");
      assert.strictEqual(
        pref?.modelConfigOptionValues?.["model-a"]?.["thought_level"],
        "high"
      );
    });

    test("should auto-switch thought_level when model changes", async () => {
      class ACPClientWithThought extends TestACPClient {
        private currentThoughtLevel = "medium";

        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "model-a", name: "Model A" },
                { modelId: "model-b", name: "Model B" },
              ],
              currentModelId: "model-a",
            },
            genericConfigOptions: [
              {
                id: "thought_level",
                name: "Thought Level",
                category: "thought_level",
                options: [
                  { value: "off", name: "Off" },
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
                currentValue: this.currentThoughtLevel,
              },
            ],
            commands: null,
          };
        }

        async setConfigOption(configId: string, value: string): Promise<void> {
          await super.setConfigOption(configId, value);
          if (configId === "thought_level") {
            this.currentThoughtLevel = value;
          }
        }
      }

      const client = new ACPClientWithThought();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      // Set model-a and save thought_level "high"
      await (provider as any).handleModelChange("model-a");
      await (provider as any).handleConfigOptionChange("thought_level", "high");

      // Set model-b and save thought_level "low"
      await (provider as any).handleModelChange("model-b");
      client.resetCallCounts();
      client.lastSetConfigOptionId = null;
      client.lastSetConfigOptionValue = null;
      await (provider as any).handleConfigOptionChange("thought_level", "low");

      // Switch back to model-a, should auto-restore "high"
      client.resetCallCounts();
      await (provider as any).handleModelChange("model-a");

      assert.strictEqual(client.lastSetConfigOptionId, "thought_level");
      assert.strictEqual(client.lastSetConfigOptionValue, "high");
    });

    test("should not switch thought_level if no preference saved for target model", async () => {
      class ACPClientWithThought extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "model-a", name: "Model A" },
                { modelId: "model-b", name: "Model B" },
              ],
              currentModelId: "model-a",
            },
            genericConfigOptions: defaultGenericConfigOptions,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithThought();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      // Save thought_level for model-a only
      await (provider as any).handleModelChange("model-a");
      await (provider as any).handleConfigOptionChange("thought_level", "high");

      // Switch to model-b (no saved preference)
      client.resetCallCounts();
      await (provider as any).handleModelChange("model-b");

      assert.strictEqual(client.getSetConfigOptionCallCount(), 0);
    });

    test("should validate saved thought_level against available options", async () => {
      class ACPClientWithLimitedOptions extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "model-a", name: "Model A" },
                { modelId: "model-b", name: "Model B" },
              ],
              currentModelId: "model-a",
            },
            genericConfigOptions: [
              {
                id: "thought_level",
                name: "Thought Level",
                category: "thought_level",
                options: [
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                ],
                currentValue: "medium",
              },
            ],
            commands: null,
          };
        }
      }

      const client = new ACPClientWithLimitedOptions();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      // Manually save a preference for model-a with value "high" (not available)
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": {
          modelId: "model-b",
          starredModels: [],
          configOptionValues: {},
          modelConfigOptionValues: {
            "model-a": { thought_level: "high" },
          },
        },
      });

      // Switch to model-a
      client.resetCallCounts();
      await (provider as any).handleModelChange("model-a");

      // "high" is not in available options, so setConfigOption should NOT be called
      assert.strictEqual(client.getSetConfigOptionCallCount(), 0);
    });

    test("should restore per-model thought_level during session restore", async () => {
      await memento.update("vscode-acp-chat.agentPreferences.v1", {
        "test-agent": {
          modelId: "model-a",
          starredModels: [],
          configOptionValues: { thought_level: "low" },
          modelConfigOptionValues: {
            "model-a": { thought_level: "high" },
          },
        },
      });

      class ACPClientWithThought extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [{ modelId: "model-a", name: "Model A" }],
              currentModelId: "model-a",
            },
            genericConfigOptions: [
              {
                id: "thought_level",
                name: "Thought Level",
                category: "thought_level",
                options: [
                  { value: "off", name: "Off" },
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
                currentValue: "medium",
              },
            ],
            commands: null,
          };
        }
      }

      const client = new ACPClientWithThought();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      await (provider as any).restoreSessionPreferences();

      // First restores global configOptionValues ("low"), then overrides with per-model ("high")
      assert.strictEqual(client.lastSetConfigOptionId, "thought_level");
      assert.strictEqual(client.lastSetConfigOptionValue, "high");
    });

    test("should isolate per-model thought_level preferences across agents", async () => {
      class ACPClientWithThought extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [{ modelId: "model-a", name: "Model A" }],
              currentModelId: "model-a",
            },
            genericConfigOptions: defaultGenericConfigOptions,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithThought();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      // Agent "test-agent" sets thought_level "high" for model-a
      await (provider as any).handleModelChange("model-a");
      await (provider as any).handleConfigOptionChange("thought_level", "high");

      // Switch to agent-b, set thought_level "low" for model-a
      client.setAgent({ id: "agent-b" });
      await (provider as any).handleModelChange("model-a");
      await (provider as any).handleConfigOptionChange("thought_level", "low");

      // Verify isolation
      const prefsA = getAgentPrefs(memento, "test-agent");
      const prefsB = getAgentPrefs(memento, "agent-b");
      assert.strictEqual(
        prefsA?.modelConfigOptionValues?.["model-a"]?.["thought_level"],
        "high"
      );
      assert.strictEqual(
        prefsB?.modelConfigOptionValues?.["model-a"]?.["thought_level"],
        "low"
      );
    });

    test("should not save per-model thought_level when no model is active", async () => {
      class ACPClientWithThought extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: null,
            genericConfigOptions: defaultGenericConfigOptions,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithThought();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      // Change thought_level without setting a model first
      await (provider as any).handleConfigOptionChange("thought_level", "high");

      const pref = getAgentPrefs(memento, "test-agent");
      assert.strictEqual(pref?.modelId, undefined);
      assert.strictEqual(pref?.modelConfigOptionValues, undefined);
    });
  });

  suite("openFile Message Handling", () => {
    let originalShowTextDocument: any;
    let originalWorkspaceFolders: any;
    let originalShowErrorMessage: any;
    let showTextDocumentCalls: any[] = [];
    let showErrorMessageCalls: string[] = [];

    setup(() => {
      originalShowTextDocument = vscode.window.showTextDocument;
      showTextDocumentCalls = [];
      Object.defineProperty(vscode.window, "showTextDocument", {
        value: async (
          uri: vscode.Uri,
          options?: vscode.TextDocumentShowOptions
        ) => {
          showTextDocumentCalls.push({ uri, options });
          return {} as any;
        },
        configurable: true,
        writable: true,
      });

      originalShowErrorMessage = vscode.window.showErrorMessage;
      showErrorMessageCalls = [];
      Object.defineProperty(vscode.window, "showErrorMessage", {
        value: async (message: string) => {
          showErrorMessageCalls.push(message);
          return {} as any;
        },
        configurable: true,
        writable: true,
      });

      originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [{ uri: vscode.Uri.file(path.dirname(__filename)) }],
        configurable: true,
        writable: true,
      });
    });

    teardown(() => {
      Object.defineProperty(vscode.window, "showTextDocument", {
        value: originalShowTextDocument,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(vscode.window, "showErrorMessage", {
        value: originalShowErrorMessage,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: originalWorkspaceFolders,
        configurable: true,
        writable: true,
      });
    });

    function resolveView(provider: ChatViewProvider): {
      messageHandler: (message: any) => Promise<void>;
    } {
      let messageHandler: ((message: any) => Promise<void>) | undefined;
      const mockWebview = {
        onDidReceiveMessage: (cb: any) => {
          messageHandler = cb;
          return { dispose: () => {} };
        },
        postMessage: async () => true,
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: "",
        options: {},
        html: "",
      };
      const mockView = {
        webview: mockWebview,
        viewType: "test",
        onDidChangeVisibility: new vscode.EventEmitter<void>().event,
        onDidDispose: new vscode.EventEmitter<void>().event,
        title: "test",
        visible: true,
        show: () => {},
      };

      provider.resolveWebviewView(mockView as any, {} as any, {} as any);
      return { messageHandler: messageHandler! };
    }

    test("getSelectedAgentId returns the legacy client agent id", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );

      await (provider as any).selectAgentAndStartNewChat("opencode");

      assert.strictEqual(provider.getSelectedAgentId(), "opencode");
      provider.dispose();
    });

    function legacyPermissionParams(toolCallId: string): any {
      return {
        toolCall: { toolCallId, title: "Write", kind: "write" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      };
    }

    function latestLegacyPermissionState(messages: any[]): any {
      return [...messages]
        .reverse()
        .find((message) => message.type === "feature.permission-ui.state");
    }

    test("legacy ready replays a pending elicitation", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const pending = acpClient.elicitationRequest!({
        params: {
          mode: "form",
          requestId: "request-scope",
          message: "Choose",
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
        requestId: "rpc-1",
        signal: new AbortController().signal,
      });
      const { messageHandler } = resolveView(provider);
      messages.length = 0;

      await messageHandler({ type: "ready" });

      const replay = messages.find(
        (message) => message.type === "feature.acp-elicitation.show"
      );
      assert.strictEqual(replay.ownerId, "legacy");
      assert.strictEqual(replay.pendingElicitations.length, 1);
      (provider as any).legacyElicitationOwner.cancelAll();
      assert.deepStrictEqual(await pending, { action: "cancel" });
      provider.dispose();
    });

    test("legacy ready republishes one pending permission without duplicates", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-ready"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { messageHandler } = resolveView(provider);
      messages.length = 0;

      await messageHandler({ type: "ready" });

      const states = messages.filter(
        (message) => message.type === "feature.permission-ui.state"
      );
      assert.strictEqual(states.length, 1);
      assert.strictEqual(states[0].ownerId, "legacy");
      assert.strictEqual(states[0].pending.length, 1);
      assert.strictEqual(states[0].pending[0].toolCallId, "tool-ready");
      assert.strictEqual((provider as any).permissionQueue.length, 1);
      (provider as any).cancelLegacyPermissions();
      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      provider.dispose();
    });

    test("legacy Stop cancels pending permission and publishes empty state", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-stop"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      messages.length = 0;

      await messageHandler({ type: "stop" });

      assert.strictEqual((provider as any).acceptingPermissionRequests, false);
      assert.strictEqual(acpClient.cancelCallCount, 1);
      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      assert.deepStrictEqual(latestLegacyPermissionState(messages).pending, []);
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      provider.dispose();
    });

    test("legacy post-stop permission request fails closed without queueing", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;

      await messageHandler({ type: "stop" });
      const messageCount = messages.length;
      const response = await acpClient.permissionRequest!(
        legacyPermissionParams("tool-post-stop")
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      assert.strictEqual(
        messages
          .slice(messageCount)
          .some((message) => message.type === "feature.permission-ui.state"),
        false
      );
      provider.dispose();
    });

    test("legacy gate stays closed during connect and new session initialization", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      const responses: unknown[] = [];
      acpClient.connectHook = async () => {
        responses.push(
          await acpClient.permissionRequest!(legacyPermissionParams("tool-connect"))
        );
      };
      acpClient.newSessionHook = async () => {
        responses.push(
          await acpClient.permissionRequest!(legacyPermissionParams("tool-new-session"))
        );
      };

      await messageHandler({ type: "sendMessage", text: "hello" });
      await (provider as any).legacyMessageQueue.waitForIdle();

      assert.deepStrictEqual(responses, [
        { outcome: { outcome: "cancelled" } },
        { outcome: { outcome: "cancelled" } },
      ]);
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      assert.ok(
        !messages.some(
          (message) =>
            message.type === "feature.permission-ui.state" &&
            Array.isArray(message.pending) &&
            message.pending.length > 0
        )
      );
      provider.dispose();
    });

    test("legacy permission after sendMessage settles cancels before finalization", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      acpClient.isConnectedValue = true;
      (provider as any).hasSession = true;
      let latePermission: Promise<unknown> | undefined;
      acpClient.sendMessageHook = async () => ({ stopReason: "end_turn" });
      const originalFinalize = (provider as any).outputPipeline.finalizePendingToolCalls.bind(
        (provider as any).outputPipeline
      );
      (provider as any).outputPipeline.finalizePendingToolCalls = async (
        ...args: any[]
      ) => {
        latePermission = acpClient.permissionRequest!(
          legacyPermissionParams("tool-after-send")
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        return originalFinalize(...args);
      };

      await messageHandler({ type: "sendMessage", text: "hello" });
      await (provider as any).legacyMessageQueue.waitForIdle();

      assert.deepStrictEqual(await latePermission, {
        outcome: { outcome: "cancelled" },
      });
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      assert.ok(
        !messages.some(
          (message) =>
            message.type === "feature.permission-ui.state" &&
            Array.isArray(message.pending) &&
            message.pending.some(
              (pending: any) => pending.toolCallId === "tool-after-send"
            )
        )
      );
      provider.dispose();
    });

    test("legacy old prompt response cannot settle a later prompt permission", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).legacyPromptGeneration = 1;
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const oldPending = acpClient.permissionRequest!(
        legacyPermissionParams("tool-old-prompt")
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const oldState = latestLegacyPermissionState(messages);
      (provider as any).acceptingPermissionRequests = false;
      (provider as any).cancelLegacyPermissions();
      assert.deepStrictEqual(await oldPending, { outcome: { outcome: "cancelled" } });

      (provider as any).legacyPromptGeneration = 2;
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const newPending = acpClient.permissionRequest!(
        legacyPermissionParams("tool-new-prompt")
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const newState = latestLegacyPermissionState(messages);

      (provider as any).settleLegacyPermission(oldState.pending[0].requestId, {
        outcome: "selected",
        optionId: "allow",
      });
      assert.strictEqual((provider as any).permissionQueue.length, 1);

      (provider as any).settleLegacyPermission(newState.pending[0].requestId, {
        outcome: "selected",
        optionId: "allow",
      });
      assert.deepStrictEqual(await newPending, {
        outcome: { outcome: "selected", optionId: "allow" },
      });
      provider.dispose();
    });

    test("legacy invalid permission optionId cancels the request", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-forged"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const state = latestLegacyPermissionState(messages);

      (provider as any).settleLegacyPermission(state.pending[0].requestId, {
        outcome: "selected",
        optionId: "forged",
      });

      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      provider.dispose();
    });

    test("legacy missing permission optionId cancels the request", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-missing"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const state = latestLegacyPermissionState(messages);

      await messageHandler({
        type: "permissionResponse",
        requestId: state.pending[0].requestId,
        outcome: { outcome: "selected" },
      });

      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      provider.dispose();
    });

    test("legacy valid reject option remains selected", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!({
        toolCall: { toolCallId: "tool-reject", title: "Write", kind: "write" },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const state = latestLegacyPermissionState(messages);

      await messageHandler({
        type: "permissionResponse",
        requestId: state.pending[0].requestId,
        outcome: { outcome: "selected", optionId: "deny" },
      });

      assert.deepStrictEqual(await pending, {
        outcome: { outcome: "selected", optionId: "deny" },
      });
      provider.dispose();
    });

    test("legacy Stop second pass cancels permission emitted during client cancel", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);
      let inFlightPermission: Promise<unknown> | undefined;
      acpClient.cancelHook = async () => {
        inFlightPermission = acpClient.permissionRequest!(
          legacyPermissionParams("tool-race")
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;

      await messageHandler({ type: "stop" });

      assert.strictEqual(acpClient.cancelCallCount, 1);
      assert.deepStrictEqual(await inFlightPermission, {
        outcome: { outcome: "cancelled" },
      });
      const latestState = latestLegacyPermissionState(messages);
      if (latestState) {
        assert.deepStrictEqual(latestState.pending, []);
      }
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      provider.dispose();
    });

    test("legacy disconnect/error cancels pending permission", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-disconnect"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      messages.length = 0;

      acpClient.stateChange?.("disconnected");

      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      assert.deepStrictEqual(latestLegacyPermissionState(messages).pending, []);
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      provider.dispose();
    });

    test("legacy new chat cancels pending permission", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-new"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      messages.length = 0;

      await (provider as any).handleNewChat(false);

      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      assert.deepStrictEqual(latestLegacyPermissionState(messages).pending, []);
      assert.strictEqual((provider as any).permissionQueue.length, 0);
      provider.dispose();
    });

    test("legacy dispose cancels pending permission", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).acceptingPermissionRequests = true;
      (provider as any).isGenerating = true;
      const pending = acpClient.permissionRequest!(legacyPermissionParams("tool-dispose"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      messages.length = 0;

      provider.dispose();

      assert.deepStrictEqual(await pending, { outcome: { outcome: "cancelled" } });
      assert.deepStrictEqual(latestLegacyPermissionState(messages).pending, []);
      assert.strictEqual((provider as any).permissionQueue.length, 0);
    });

    test("legacy agent selection resets chat and creates exactly one session", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).webviewReady = true;

      await provider.selectAgentAndStartNewChat("opencode");

      assert.strictEqual(acpClient.getAgentId(), "opencode");
      assert.strictEqual(
        memento.get("vscode-acp-chat.selectedAgent"),
        "opencode"
      );
      assert.strictEqual(acpClient.connectCallCount, 1);
      assert.strictEqual(acpClient.newSessionCallCount, 1);
      assert.ok(messages.some((message) => message.type === "chatCleared"));
      assert.ok(
        messages.some(
          (message) =>
            message.type === "agentChanged" && message.agentId === "opencode"
        )
      );
      assert.ok(messages.some((message) => message.type === "focusInput"));
      provider.dispose();
    });

    test("legacy new chat emits focusInput before ACP session creation", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      acpClient.isConnectedValue = true;
      const messages: any[] = [];
      const events: string[] = [];
      (provider as any).postMessage = (message: any) => {
        messages.push(message);
        events.push(message.type);
      };
      (provider as any).webviewReady = true;
      const originalNewSession = (
        provider as any
      ).sessionManager.newSession.bind((provider as any).sessionManager);
      (provider as any).sessionManager.newSession = async (...args: any[]) => {
        events.push("newSession");
        return originalNewSession(...args);
      };

      await (provider as any).handleNewChat();

      assert.ok(messages.some((message) => message.type === "chatCleared"));
      assert.ok(messages.some((message) => message.type === "focusInput"));
      assert.ok(events.indexOf("focusInput") < events.indexOf("newSession"));
      assert.strictEqual(acpClient.newSessionCallCount, 1);
      provider.dispose();
    });

    test("legacy new chat retains input focus until the webview is ready", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      const { messageHandler } = resolveView(provider);

      await (provider as any).handleNewChat();
      assert.strictEqual(
        messages.some((message) => message.type === "focusInput"),
        false
      );

      await messageHandler({ type: "ready" });

      assert.strictEqual(
        messages.filter((message) => message.type === "focusInput").length,
        1
      );
      provider.dispose();
    });

    test("legacy agent selection cancellation while generating keeps existing agent", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      (provider as any).isGenerating = true;

      const selection = provider.selectAgentAndStartNewChat("opencode");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const confirmation = messages.find(
        (message) => message.type === "confirmAction"
      );
      assert.ok(confirmation);
      (provider as any).pendingConfirmations.get(confirmation.requestId)?.(
        false
      );
      await selection;

      assert.strictEqual(acpClient.getAgentId(), "test-agent");
      assert.strictEqual(
        memento.get("vscode-acp-chat.selectedAgent"),
        "test-agent"
      );
      assert.strictEqual(acpClient.cancelCallCount, 0);
      assert.strictEqual(acpClient.newSessionCallCount, 0);
      assert.ok(!messages.some((message) => message.type === "chatCleared"));
      assert.ok(!messages.some((message) => message.type === "focusInput"));
      provider.dispose();
    });

    test("legacy agent selection reports session errors without retrying session creation", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        acpClient as any,
        memento as any
      );
      const messages: any[] = [];
      (provider as any).postMessage = (message: any) => messages.push(message);
      acpClient.newSessionError = new Error("session failed");

      await provider.selectAgentAndStartNewChat("opencode");

      assert.strictEqual(acpClient.getAgentId(), "opencode");
      assert.strictEqual(
        memento.get("vscode-acp-chat.selectedAgent"),
        "opencode"
      );
      assert.strictEqual(acpClient.connectCallCount, 1);
      assert.strictEqual(acpClient.newSessionCallCount, 1);
      assert.ok(
        messages.some(
          (message) =>
            message.type === "error" && message.text === "session failed"
        )
      );
      provider.dispose();
    });

    test("falls back to legacy new chat for stale multi-session webview messages", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);
      let called = 0;
      (provider as any).handleNewChat = async () => {
        called += 1;
      };

      await messageHandler({ type: "feature.multi-session.new" });

      assert.strictEqual(called, 1);
      provider.dispose();
    });

    test("should handle openFile with non-file message.path URI", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      await messageHandler({
        type: "openFile",
        path: "vscode-remote://ssh-remote+host/workspace/example.ts",
      });
      provider.dispose();

      assert.strictEqual(showTextDocumentCalls.length, 1);
      assert.strictEqual(showTextDocumentCalls[0].uri.scheme, "vscode-remote");
      assert.strictEqual(
        showTextDocumentCalls[0].uri.authority,
        "ssh-remote+host"
      );
    });

    test("should handle openFile with message.href and parse range correctly", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      const fileUri = vscode.Uri.file(__filename);
      const testHref = `${fileUri.toString()}#L15-L25`;

      // Fire openFile message with href
      await messageHandler({
        type: "openFile",
        href: testHref,
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(call.uri.fsPath, fileUri.fsPath);
      assert.ok(call.options);
      assert.ok(call.options.selection);
      assert.strictEqual(call.options.selection.start.line, 14);
      assert.strictEqual(call.options.selection.end.line, 24);
    });

    test("should handle openFile with encoded file URI colon line suffix", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      const fileUri = vscode.Uri.file(__filename);

      await messageHandler({
        type: "openFile",
        href: `${fileUri.toString()}%3A10`,
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(call.uri.fsPath, fileUri.fsPath);
      assert.ok(call.options);
      assert.ok(call.options.selection);
      assert.strictEqual(call.options.selection.start.line, 9);
      assert.strictEqual(call.options.selection.end.line, 9);
    });

    test("should handle openFile with relative message.href and resolve it", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      const baseName = path.basename(__filename);

      // Fire openFile message with relative href
      await messageHandler({
        type: "openFile",
        href: `${baseName}#L5`,
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      // It should resolve relative to the workspace folder
      assert.strictEqual(call.uri.fsPath, vscode.Uri.file(__filename).fsPath);
      assert.ok(call.options);
      assert.ok(call.options.selection);
      assert.strictEqual(call.options.selection.start.line, 4);
      assert.strictEqual(call.options.selection.end.line, 4);
    });

    test("should handle openFile with absolute path href and parse range correctly", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      // Fire openFile message with absolute href
      await messageHandler({
        type: "openFile",
        href: `${__filename}#L10`,
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(call.uri.fsPath, vscode.Uri.file(__filename).fsPath);
      assert.ok(call.options);
      assert.ok(call.options.selection);
      assert.strictEqual(call.options.selection.start.line, 9);
      assert.strictEqual(call.options.selection.end.line, 9);
    });

    test("should handle openFile with absolute path href using colon line suffix", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      await messageHandler({
        type: "openFile",
        href: `${__filename}:10`,
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(call.uri.fsPath, vscode.Uri.file(__filename).fsPath);
      assert.ok(call.options);
      assert.ok(call.options.selection);
      assert.strictEqual(call.options.selection.start.line, 9);
      assert.strictEqual(call.options.selection.end.line, 9);
    });

    test("should handle openFile with absolute path href using colon line range suffix", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      await messageHandler({
        type: "openFile",
        href: `${__filename}:10-20`,
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(call.uri.fsPath, vscode.Uri.file(__filename).fsPath);
      assert.ok(call.options);
      assert.ok(call.options.selection);
      assert.strictEqual(call.options.selection.start.line, 9);
      assert.strictEqual(call.options.selection.end.line, 19);
    });

    test("should expand home-relative href before opening it", async () => {
      const homeRelativePath = path.relative(os.homedir(), __filename);
      assert.ok(homeRelativePath && !homeRelativePath.startsWith(".."));

      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      await messageHandler({
        type: "openFile",
        href: `~/${homeRelativePath}:10`,
        checkExists: true,
      });

      assert.strictEqual(showErrorMessageCalls.length, 0);
      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(call.uri.fsPath, vscode.Uri.file(__filename).fsPath);
      assert.ok(call.options?.selection);
      assert.strictEqual(call.options.selection.start.line, 9);
      assert.strictEqual(call.options.selection.end.line, 9);
    });

    test("should fallback to showTextDocument when file stat fails", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      // Fire openFile message with a non-existent file href
      await messageHandler({
        type: "openFile",
        href: "file:///non/existent/file.ts#L5-L10",
      });

      assert.strictEqual(showTextDocumentCalls.length, 1);
      const call = showTextDocumentCalls[0];
      assert.strictEqual(
        call.uri.fsPath,
        vscode.Uri.parse("file:///non/existent/file.ts").fsPath
      );
      // options should be undefined because it fell back to catch block
      assert.strictEqual(call.options, undefined);
    });

    test("should show error message and not call showTextDocument when checkExists is true and file does not exist", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      // Fire openFile message with a non-existent file and checkExists = true
      await messageHandler({
        type: "openFile",
        path: "/non/existent/file.ts",
        checkExists: true,
      });

      assert.strictEqual(showTextDocumentCalls.length, 0);
      assert.strictEqual(showErrorMessageCalls.length, 1);
      assert.ok(showErrorMessageCalls[0].includes("File does not exist"));
    });

    test("should open file and not show error message when checkExists is true and file exists", async () => {
      const provider = new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
      const { messageHandler } = resolveView(provider);

      // Fire openFile message with a file that exists (like __filename) and checkExists = true
      await messageHandler({
        type: "openFile",
        path: __filename,
        checkExists: true,
      });

      assert.strictEqual(showErrorMessageCalls.length, 0);
      assert.strictEqual(showTextDocumentCalls.length, 1);
      assert.strictEqual(
        showTextDocumentCalls[0].uri.fsPath,
        vscode.Uri.file(__filename).fsPath
      );
    });
  });

  suite("handleReadTextFile - directory handling", () => {
    let tmpDir: string;
    let tmpCleanup: string[] = [];

    setup(async () => {
      const os = await import("os");
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      tmpDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), "vscode-acp-test-"));
    });

    teardown(async () => {
      const fs = await import("fs/promises");
      for (const p of tmpCleanup) {
        try {
          await fs.rm(p, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    function makeProvider(): ChatViewProvider {
      return new ChatViewProvider(
        vscode.Uri.file("/test"),
        new TestACPClient() as any,
        new TestMemento() as any
      );
    }

    test("should return formatted listing for an empty directory", async () => {
      const provider = makeProvider();
      const fileHandler = (provider as any).fileHandler;
      const handler = fileHandler.handleReadTextFile.bind(fileHandler);

      const result = await handler({ sessionId: "s", path: tmpDir });
      assert.ok(result.content, "content should be a non-empty string");
      assert.ok(
        result.content.includes("[Directory listing for:"),
        `content should include directory header, got: ${result.content}`
      );
      assert.ok(
        result.content.includes(tmpDir),
        `content should include the path, got: ${result.content}`
      );
      assert.ok(
        result.content.includes("(empty directory)"),
        `empty directory should be noted, got: ${result.content}`
      );
      assert.ok(
        result.content.includes("Recursive listing is not supported"),
        "limitations note should be present"
      );
    });

    test("should return formatted listing with metadata for non-empty directory", async () => {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      const subDir = pathMod.join(tmpDir, "sub");
      const filePath = pathMod.join(tmpDir, "file.ts");
      await fs.mkdir(subDir);
      await fs.writeFile(filePath, "x");
      await fs.chmod(filePath, 0o444); // readonly

      const provider = makeProvider();
      const fileHandler = (provider as any).fileHandler;
      const handler = fileHandler.handleReadTextFile.bind(fileHandler);
      const result = await handler({ sessionId: "s", path: tmpDir });

      assert.ok(result.content.includes("[DIR] sub"), "sub listed as DIR");
      assert.ok(
        result.content.includes("[FILE] file.ts"),
        "file.ts listed as FILE"
      );
      assert.ok(
        result.content.includes("size="),
        "size field present in content"
      );
      assert.ok(
        result.content.includes("mtime="),
        "mtime field present in content"
      );
      assert.ok(
        result.content.includes("perms="),
        "permissions field present in content"
      );
      assert.ok(result.content.includes("Recursive listing is not supported"));
    });

    test("should still read regular files normally (regression)", async () => {
      const fs = await import("fs/promises");
      const pathMod = await import("path");
      const filePath = pathMod.join(tmpDir, "regular.txt");
      await fs.writeFile(filePath, "hello world");

      const provider = makeProvider();
      const fileHandler = (provider as any).fileHandler;
      const handler = fileHandler.handleReadTextFile.bind(fileHandler);
      const result = await handler({ sessionId: "s", path: filePath });
      assert.strictEqual(result.content, "hello world");
    });
  });
});
