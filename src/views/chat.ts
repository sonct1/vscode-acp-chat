import * as path from "path";
import * as vscode from "vscode";
import { searchWorkspaceFiles } from "../utils/file-search";
import { getWorkspaceRoot } from "../utils/workspace";
import { ACPClient, type SessionMetadata } from "../acp/client";
import { getAgent, getFirstAvailableAgent } from "../acp/agents";
import { DiffManager } from "../acp/diff-manager";
import { FileHandler } from "../acp/file-handler";
import { recordStructuredDiffsFromContent } from "../acp/structured-diff-recorder";
import { TerminalHandler } from "../acp/terminal-handler";
import { SessionOutputPipeline } from "../acp/session-output-pipeline";
import {
  AgentSessionManager,
  globalStateSessionStore,
  inMemorySessionStore,
  type HistoryCatalogScope,
  type HistorySessionPage,
  type HistorySessionRef,
  type SessionInfo,
} from "../acp/session-manager";
import { DocumentSyncManager } from "../acp/document-sync";
import type { Mention } from "../utils/mention-serializer";
import { AsyncSerialQueue, AsyncSerialProcessor } from "../utils/async-queue";
import {
  registerHostFeatures,
  type HostFeatureRegistry,
} from "../features/register-host";
import type {
  MessageQueueController,
  ComposerPayload,
  MessageQueueHostMessage,
} from "../features/message-queue";
import { expandHomeResourcePath } from "../features/clickable-resource-links/host";
import { MultiSessionManagerViewProvider } from "../features/multi-session/manager-view";
import { showMultiSessionQuickSwitch } from "../features/multi-session/quick-switch";
import {
  deleteRemoteHistoryCatalogSession,
  readRemoteHistoryCatalog,
  writeRemoteHistoryCatalogPage,
} from "../features/fast-chat-history/cache";
import {
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

const SELECTED_AGENT_KEY = "vscode-acp-chat.selectedAgent";
const AGENT_PREFS_KEY = "vscode-acp-chat.agentPreferences.v1";

interface AgentPreference {
  modeId?: string;
  modelId?: string;
  configOptionValues: Record<string, string>;
  starredModels: string[];
  modelConfigOptionValues?: Record<string, Record<string, string>>;
}

type AgentPreferences = Record<string, AgentPreference>;

interface WebviewMessage {
  type:
    | "sendMessage"
    | "ready"
    | "feature.multi-session.new"
    | "feature.message-queue.submit"
    | "feature.message-queue.abortAndRestore"
    | "feature.message-queue.restoreQueued"
    | "feature.clickable-resource-links.openExternal"
    | "selectMode"
    | "selectModel"
    | "selectConfigOption"
    | "connect"
    | "newChat"
    | "clearChat"
    | "copyMessage"
    | "searchFiles"
    | "openFile"
    | "permissionResponse"
    | "stop"
    | "reviewDiff"
    | "acceptDiff"
    | "rollbackDiff"
    | "acceptAllDiffs"
    | "rollbackAllDiffs"
    | "toggleModelStar"
    | "confirmActionResponse";
  text?: string;
  modeId?: string;
  modelId?: string;
  configId?: string;
  value?: string;
  isStarred?: boolean;
  images?: string[];
  mentions?: Array<{
    name: string;
    path?: string;
    type?: "file" | "folder" | "selection" | "terminal" | "image";
    content?: string;
    range?: { startLine: number; endLine: number };
    dataUrl?: string;
  }>;
  path?: string;
  href?: string;
  url?: string;
  range?: { startLine: number; endLine: number };
  requestId?: string;
  outcome?: { outcome: "selected" | "cancelled"; optionId?: string };
  confirmed?: boolean;
  intent?: "steer" | "followUp";
  payload?: ComposerPayload;
  currentDraft?: ComposerPayload;
  action?: string;
  actionLabel?: string;
  checkExists?: boolean;
}

type FileLineRange = { startLine: number; endLine: number };

function parseFileLineRange(value: string): FileLineRange | undefined {
  const match = value.match(/^L?(\d+)(?:-L?(\d+))?$/);
  if (!match) return undefined;

  const startLine = parseInt(match[1], 10);
  const endLine = match[2] ? parseInt(match[2], 10) : startLine;
  return { startLine, endLine };
}

function splitTrailingLineSuffix(pathText: string): {
  path: string;
  range?: FileLineRange;
} {
  // Supports common markdown file links such as path/to/file.ts:10 and path/to/file.ts:10-20.
  const match = pathText.match(/^(.*):(\d+)(?:-(\d+)|:\d+)?$/);
  if (!match || !match[1] || /^[a-zA-Z]$/.test(match[1])) {
    return { path: pathText };
  }

  const startLine = parseInt(match[2], 10);
  const endLine = match[3] ? parseInt(match[3], 10) : startLine;
  return { path: match[1], range: { startLine, endLine } };
}

export type SelectionMention = Mention & {
  type: "selection" | "terminal";
  content: string;
};

export class ChatViewProvider
  implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider
{
  public static readonly viewType = "vscode-acp-chat.chatView";

  private view?: vscode.WebviewView;
  private hasSession = false;
  private globalState: vscode.Memento;
  private hasRestoredModeModel = false;
  private sessionManager: AgentSessionManager;
  private diffManager: DiffManager;
  private fileHandler: FileHandler;
  private terminalHandler: TerminalHandler;
  private documentSyncManager: DocumentSyncManager;
  private outputPipeline: SessionOutputPipeline;
  private features: HostFeatureRegistry;
  private multiSessionManagerView?: MultiSessionManagerViewProvider;
  private permissionQueue: Array<{
    id: string;
    params: RequestPermissionRequest;
    resolver: (response: RequestPermissionResponse) => void;
  }> = [];
  // Serializes ACP session updates so they render in arrival order.
  // Without this, rapid updates can interleave and cause out-of-order
  // messages (e.g. streamEnd arriving before the last tool_call_complete).
  private sessionUpdateNotifier = new AsyncSerialProcessor<SessionNotification>(
    (update) => this.handleSessionUpdate(update)
  );
  // Serializes webview.postMessage calls so fast messages (streamEnd)
  // cannot overtake slower ones (streamChunk) that are still pending.
  private webviewPostNotifier = new AsyncSerialQueue();

  // Flag to track if the agent is currently generating a response
  private isGenerating = false;
  private legacyMessageQueue?: MessageQueueController;

  // Pending confirmation requests from isGenerating guard
  private pendingConfirmations = new Map<
    string,
    (confirmed: boolean) => void
  >();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly acpClient: ACPClient,
    globalState: vscode.Memento
  ) {
    this.globalState = globalState;
    this.features = registerHostFeatures({
      globalState,
      postMessage: (message) => this.postMessage(message),
      onStatusChanged: (summary) => this.onMultiSessionStatus(summary),
      onOpenManager: () => this.revealMultiSessionManager(),
      onFocusChat: () =>
        vscode.commands.executeCommand("vscode-acp-chat.chatView.focus"),
      onQuickSwitch: () => this.switchSession(),
    });
    if (this.features.multiSession) {
      this.multiSessionManagerView = new MultiSessionManagerViewProvider(
        this.extensionUri,
        this.features.multiSession
      );
    }
    this.diffManager = new DiffManager();
    this.fileHandler = new FileHandler(this.diffManager);
    this.terminalHandler = new TerminalHandler();
    // Choose session store based on user preference:
    //   - enablePersistentSessions=false → in-memory store, sessions lost on restart
    //   - enablePersistentSessions=true  → globalState-backed store with automatic
    //     cleanup of sessions older than `sessionRetentionDays` and enforcement of
    //     a per-agent `maxSessionsPerAgent` cap (runs once on first load)
    this.sessionManager = new AgentSessionManager(acpClient, (agentId) => {
      const config = vscode.workspace.getConfiguration("vscode-acp-chat");
      const persistent = config.get<boolean>("enablePersistentSessions", true);
      if (!persistent) {
        return inMemorySessionStore();
      }
      const retentionDays = config.get<number>("sessionRetentionDays", 30);
      const maxSessions = config.get<number>("maxSessionsPerAgent", 300);
      return globalStateSessionStore(
        globalState,
        `vscode-acp-chat.localSessions.v1.${agentId}`,
        { retentionDays, maxSessions }
      );
    });
    this.documentSyncManager = new DocumentSyncManager(acpClient);
    this.outputPipeline = new SessionOutputPipeline({
      client: this.acpClient,
      fileHandler: this.fileHandler,
      emit: (message) => this.postMessage(message),
      liveToolOutputProfile: undefined,
      onMetadataChanged: () => this.sendSessionMetadata(),
      onContextUsageChanged: () => this.sendContextUsage(),
      onSessionInfoChanged: () => {},
      onStructuredDiffContent: async (content) => {
        await recordStructuredDiffsFromContent(content, {
          cwd: getWorkspaceRoot(),
          diffManager: this.diffManager,
        });
      },
      onToolCallComplete: () => this.emitDiffSummary(),
    });

    vscode.workspace.registerTextDocumentContentProvider(
      "acp-old-content",
      this
    );

    const savedAgentId = this.globalState.get<string>(SELECTED_AGENT_KEY);
    if (savedAgentId) {
      const agent = getAgent(savedAgentId);
      if (agent) {
        this.acpClient.setAgent(agent);
        this.outputPipeline.setLiveToolOutputProfile(
          agent.liveToolOutputProfile
        );
      }
    } else {
      const agent = getFirstAvailableAgent();
      this.acpClient.setAgent(agent);
      this.outputPipeline.setLiveToolOutputProfile(agent.liveToolOutputProfile);
    }

    this.acpClient.setOnStateChange((state) => {
      this.postMessage({ type: "connectionState", state });
      if (state === "disconnected" || state === "error") {
        this.postMessage({ type: "streamEnd", stopReason: "error" });
        if (this.stderrBuffer.trim().length > 0) {
          const lastLines = this.stderrBuffer
            .trim()
            .split("\n")
            .slice(-5)
            .join("\n");
          this.postMessage({
            type: "agentError",
            text: `Agent process ${state}.\nLast stderr:\n${lastLines}`,
          });
          this.stderrBuffer = "";
        }
      }
    });

    this.acpClient.setOnSessionUpdate((update) => {
      this.sessionUpdateNotifier.push(update);
    });

    this.acpClient.setOnStderr((text) => {
      this.handleStderr(text);
    });

    this.acpClient.setOnReadTextFile(async (params) => {
      return this.fileHandler.handleReadTextFile(params);
    });

    this.acpClient.setOnWriteTextFile(async (params) => {
      return this.fileHandler.handleWriteTextFile(params);
    });

    this.acpClient.setOnCreateTerminal(async (params) => {
      return this.terminalHandler.handleCreateTerminal(params);
    });

    this.acpClient.setOnTerminalOutput(async (params) => {
      return this.terminalHandler.handleTerminalOutput(params);
    });

    this.acpClient.setOnWaitForTerminalExit(async (params) => {
      return this.terminalHandler.handleWaitForTerminalExit(params);
    });

    this.acpClient.setOnKillTerminalCommand(async (params) => {
      return this.terminalHandler.handleKillTerminalCommand(params);
    });

    this.acpClient.setOnReleaseTerminal(async (params) => {
      return this.terminalHandler.handleReleaseTerminal(params);
    });

    this.acpClient.setOnPermissionRequest(
      this.handlePermissionRequest.bind(this)
    );

    this.diffManager.onDidChange(() => this.emitDiffSummary());
  }

  private emitDiffSummary(): void {
    const config = vscode.workspace.getConfiguration("vscode-acp-chat");
    if (!config.get<boolean>("enableDiffSummary", true)) return;
    this.postMessage({
      type: "diffSummary",
      changes: this.diffManager.getPendingChanges().map((change) => ({
        path: change.path,
        relativePath: vscode.workspace.asRelativePath(change.path),
        oldText: change.oldText,
        newText: change.newText,
        status: change.status,
      })),
    });
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    if (this.features.multiSession) {
      return this.features.multiSession.provideTextDocumentContent(uri);
    }
    const path = uri.path;
    const changes = this.diffManager.getPendingChanges();
    const change = changes.find((c) => c.path === path);
    return change?.oldText || "";
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.features.multiSession?.attachView(webviewView);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    this.features.chatFontSize?.sendSettings();

    if (!this.features.multiSession) {
      this.handleConnect().catch((err) => {
        console.error("[Chat] Auto-connect failed:", err);
      });
    }

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (await this.features.multiSession?.handleMessage(message as never)) {
        return;
      }
      if (
        await this.features.multiSession?.handleCoreMessage(message as never)
      ) {
        return;
      }
      if (await this.features.clickableResourceLinks?.handleMessage(message)) {
        return;
      }
      if (message.type.startsWith("feature.message-queue.")) {
        await this.handleMessageQueueMessage(
          message as MessageQueueHostMessage & WebviewMessage
        );
        return;
      }
      switch (message.type) {
        case "feature.multi-session.new":
          // Backward-compatible fallback for webviews restored while the
          // feature flag is disabled or after an extension downgrade.
          await this.handleNewChat();
          break;
        case "sendMessage":
          if (
            message.text !== undefined ||
            (message.images && message.images.length > 0)
          ) {
            if (this.features.multiSession) {
              await this.features.multiSession.sendActiveMessage(
                message.text || "",
                message.images,
                message.mentions
              );
            } else {
              await this.getLegacyMessageQueue().submit({
                id: `legacy-${Date.now()}`,
                intent: "steer",
                payload: {
                  text: message.text || "",
                  images: message.images ?? [],
                  mentions: message.mentions ?? [],
                  composerHtml: message.text || "",
                },
              });
            }
          }
          break;
        case "selectMode":
          if (message.modeId) {
            await this.handleModeChange(message.modeId);
          }
          break;
        case "selectModel":
          if (message.modelId) {
            await this.handleModelChange(message.modelId);
          }
          break;
        case "selectConfigOption":
          if (message.configId && message.value !== undefined) {
            await this.handleConfigOptionChange(
              message.configId,
              message.value
            );
          }
          break;
        case "toggleModelStar":
          if (
            message.modelId !== undefined &&
            message.isStarred !== undefined
          ) {
            await this.updateCurrentAgentPreference((pref) => {
              const starred = new Set(pref.starredModels);
              if (message.isStarred) {
                starred.add(message.modelId!);
              } else {
                starred.delete(message.modelId!);
              }
              return { ...pref, starredModels: Array.from(starred) };
            });
            this.sendSessionMetadata();
          }
          break;
        case "connect":
          await this.handleConnect();
          break;
        case "newChat":
          if (this.features.multiSession) {
            await this.features.multiSession.newChat();
          } else {
            await this.handleNewChat();
          }
          break;
        case "clearChat":
          if (this.features.multiSession) {
            this.features.multiSession.clearActive();
          } else {
            this.handleClearChat();
          }
          break;
        case "copyMessage":
          if (message.text) {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage("Message copied to clipboard");
          }
          break;
        case "searchFiles":
          if (message.text !== undefined) {
            const query = message.text;
            // 使用新的搜索工具函数，支持文件和文件夹搜索
            const results = await searchWorkspaceFiles(query, {
              maxResults: 20,
            });

            this.postMessage({
              type: "fileSearchResults",
              results,
            });
          }
          break;
        case "openFile":
          {
            let uri: vscode.Uri | undefined;
            let range: { startLine: number; endLine: number } | undefined;

            if (message.href) {
              try {
                let pathPart = message.href;
                let fragmentPart = "";
                const hashIndex = message.href.indexOf("#");
                if (hashIndex !== -1) {
                  pathPart = message.href.substring(0, hashIndex);
                  fragmentPart = message.href.substring(hashIndex + 1);
                }

                if (fragmentPart) {
                  range = parseFileLineRange(fragmentPart);
                } else {
                  const parsedPath = splitTrailingLineSuffix(pathPart);
                  pathPart = parsedPath.path;
                  range = parsedPath.range;
                }

                if (pathPart.startsWith("file://")) {
                  uri = vscode.Uri.parse(pathPart);
                  if (!range) {
                    const parsedFsPath = splitTrailingLineSuffix(uri.fsPath);
                    if (parsedFsPath.range) {
                      uri = vscode.Uri.file(parsedFsPath.path);
                      range = parsedFsPath.range;
                    }
                  }
                } else {
                  // decodeURIComponent might throw if percent-encoding is malformed,
                  // which is handled by the outer try/catch.
                  const decodedPath = decodeURIComponent(pathPart);
                  const parsedDecodedPath = range
                    ? { path: decodedPath }
                    : splitTrailingLineSuffix(decodedPath);
                  if (parsedDecodedPath.range) {
                    range = parsedDecodedPath.range;
                  }

                  const filePath = expandHomeResourcePath(
                    parsedDecodedPath.path
                  );
                  if (
                    path.isAbsolute(filePath) ||
                    /^[a-zA-Z]:[/\\]/.test(filePath)
                  ) {
                    uri = vscode.Uri.file(filePath);
                  } else {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                      // Attempt to resolve the relative path against each active workspace folder.
                      for (const folder of workspaceFolders) {
                        const possibleUri = vscode.Uri.joinPath(
                          folder.uri,
                          filePath
                        );
                        try {
                          await vscode.workspace.fs.stat(possibleUri);
                          uri = possibleUri;
                          break;
                        } catch {
                          // The file does not exist in this folder; ignore and continue checking other folders.
                        }
                      }
                      // Fallback to the first workspace folder if not resolved anywhere else
                      if (!uri) {
                        uri = vscode.Uri.joinPath(
                          workspaceFolders[0].uri,
                          filePath
                        );
                      }
                    } else {
                      uri = vscode.Uri.file(filePath);
                    }
                  }
                }
              } catch (err) {
                console.error("Failed to parse href:", message.href, err);
              }
            } else if (message.path) {
              uri = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(message.path)
                ? vscode.Uri.parse(message.path)
                : vscode.Uri.file(message.path);
            }

            if (uri) {
              let stat: vscode.FileStat | undefined;
              if (message.checkExists) {
                try {
                  stat = await vscode.workspace.fs.stat(uri);
                } catch {
                  vscode.window.showErrorMessage(
                    `File does not exist: ${uri.fsPath}`
                  );
                  return;
                }
              }

              try {
                const fileStat = stat || (await vscode.workspace.fs.stat(uri));
                if (fileStat.type === vscode.FileType.Directory) {
                  await vscode.commands.executeCommand("revealInExplorer", uri);
                } else {
                  const options: vscode.TextDocumentShowOptions = {
                    preview: true,
                  };
                  if (range) {
                    const start = new vscode.Position(
                      Math.max(0, range.startLine - 1),
                      0
                    );
                    const end = new vscode.Position(
                      Math.max(0, range.endLine - 1),
                      0
                    );
                    options.selection = new vscode.Range(start, end);
                  }
                  await vscode.window.showTextDocument(uri, options);
                }
              } catch {
                // Fallback to opening the document directly if stat fails (e.g. file is not local or lacks read access).
                await vscode.window.showTextDocument(uri);
              }
            }
          }
          break;
        case "stop":
          if (this.features.multiSession) {
            await this.features.multiSession.stop();
          } else {
            await this.acpClient.cancel();
          }
          break;
        case "permissionResponse":
          if (message.requestId && message.outcome) {
            const pending = this.permissionQueue.find(
              (p) => p.id === message.requestId
            );
            if (pending) {
              const outcome =
                message.outcome.outcome === "selected"
                  ? {
                      outcome: "selected" as const,
                      optionId: message.outcome.optionId!,
                    }
                  : { outcome: "cancelled" as const };
              pending.resolver({ outcome });
              this.permissionQueue = this.permissionQueue.filter(
                (p) => p.id !== message.requestId
              );
            }
          }
          break;
        case "reviewDiff":
          if (message.path) {
            await this.handleReviewDiff(message.path);
          }
          break;
        case "acceptDiff":
          if (message.path) {
            this.diffManager.accept(message.path);
          }
          break;
        case "rollbackDiff":
          if (message.path) {
            await this.diffManager.rollback(message.path);
          }
          break;
        case "acceptAllDiffs":
          this.diffManager.acceptAll();
          break;
        case "rollbackAllDiffs":
          await this.diffManager.rollbackAll();
          break;
        case "confirmActionResponse":
          if (message.requestId && message.confirmed !== undefined) {
            const resolver = this.pendingConfirmations.get(message.requestId);
            if (resolver) {
              resolver(message.confirmed);
              this.pendingConfirmations.delete(message.requestId);
            }
          }
          break;
        case "ready":
          this.features.chatFontSize?.sendSettings();
          if (this.features.multiSession) {
            await this.features.multiSession.handleMessage({
              type: "feature.multi-session.ready",
            });
            break;
          }
          this.postMessage({
            type: "feature.multi-session.chatState",
            enabled: false,
            activationRevision: 0,
            aggregate: {
              open: 0,
              running: 0,
              awaitingPermission: 0,
            },
          });
          this.postMessage({
            type: "connectionState",
            state: this.acpClient.getState(),
          });
          this.postMessage({
            type: "agentChanged",
            agentId: this.acpClient.getAgentId(),
            agentName: this.acpClient.getAgentName(),
          });
          this.sendSessionMetadata();
          this.sendContextUsage();
          break;
      }
    });
  }

  private async handleReviewDiff(path: string): Promise<void> {
    const changes = this.diffManager.getPendingChanges();
    const change = changes.find((c) => c.path === path);
    if (change) {
      const uri = vscode.Uri.file(path);
      if (change.oldText === null) {
        // New file
        await vscode.window.showTextDocument(uri);
      } else {
        // Modified file - open diff view
        // VS Code doesn't have a direct "diff with string" command that's easy to use here
        // without writing to a temp file.
        // Actually, we can use a custom FileSystemProvider or just use the current disk state.
        // Since we already modified the disk, we need the OLD content to show a diff.

        // Strategy: use a custom TextDocumentContentProvider for the old content

        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.parse(`acp-old-content:${path}`),
          uri,
          `Diff: ${vscode.workspace.asRelativePath(path)} (Original ↔ Modified)`
        );
      }
    }
  }

  public newChat(): void {
    const newChat = this.features.multiSession
      ? this.features.multiSession.newChat()
      : this.handleNewChat();
    newChat.catch((err) => {
      console.error("[Chat] handleNewChat failed:", err);
    });
  }

  public clearChat(): void {
    if (this.features.multiSession) {
      this.features.multiSession.clearActive();
      return;
    }
    this.handleClearChat();
  }

  public async startChat(): Promise<void> {
    if (this.features.multiSession) {
      await this.features.multiSession.connectActive();
      return;
    }
    await this.handleConnect();
  }

  public manageSessions(): Thenable<void> | void {
    return this.multiSessionManagerView?.toggle();
  }

  public getMultiSessionManagerViewProvider():
    MultiSessionManagerViewProvider | undefined {
    return this.multiSessionManagerView;
  }

  public async switchSession(): Promise<void> {
    if (!this.features.multiSession) return;
    await showMultiSessionQuickSwitch(this.features.multiSession);
  }

  private revealMultiSessionManager(): void {
    void this.multiSessionManagerView?.reveal();
  }

  public isMultiSessionEnabled(): boolean {
    return this.features.multiSession !== undefined;
  }

  private onMultiSessionStatus(summary: string): void {
    void vscode.commands
      .executeCommand("vscode-acp-chat.updateMultiSessionStatus", summary)
      .then(undefined, (error) => {
        console.debug(
          "[Chat] Multi-session status command is unavailable:",
          error
        );
      });
  }

  /**
   * List available history sessions for the current agent.
   * Returns an empty array when the agent doesn't support `loadSession`.
   */
  public async listSessions(): Promise<SessionInfo[]> {
    if (this.features.multiSession) {
      return this.features.multiSession.listSessions();
    }
    return this.sessionManager.listSessions(getWorkspaceRoot());
  }

  public async listSessionPage(
    cursor?: string | null
  ): Promise<HistorySessionPage> {
    if (this.features.multiSession) {
      return this.features.multiSession.listSessionPage(cursor);
    }
    const scope = this.getHistoryScope();
    const page = await this.sessionManager.listSessionPage(scope.cwd, cursor);
    if (page.authoritative) {
      try {
        await writeRemoteHistoryCatalogPage(
          this.globalState,
          scope.agentId,
          scope.cwd,
          page.sessions,
          Boolean(cursor)
        );
      } catch (error) {
        console.warn(
          "[FastHistory] Failed to persist remote history catalog:",
          error
        );
      }
    }
    return page;
  }

  public getHistoryScope(): HistoryCatalogScope {
    return this.features.multiSession
      ? this.features.multiSession.getHistoryScope()
      : { agentId: this.acpClient.getAgentId(), cwd: getWorkspaceRoot() };
  }

  public getCachedHistorySessions(): HistorySessionRef[] {
    if (this.features.multiSession) {
      return this.features.multiSession.getCachedHistorySessions();
    }
    const scope = this.getHistoryScope();
    return readRemoteHistoryCatalog(this.globalState, scope.agentId, scope.cwd);
  }

  public async deleteCachedHistorySession(
    ref: HistorySessionRef
  ): Promise<void> {
    await deleteRemoteHistoryCatalogSession(this.globalState, ref);
  }

  public async getLocalHistorySessions(): Promise<HistorySessionRef[]> {
    if (this.features.multiSession) {
      return this.features.multiSession.getLocalHistorySessions();
    }
    const scope = this.getHistoryScope();
    return this.sessionManager.listLocalSessionRefs(scope.cwd);
  }

  /**
   * Return whether the current agent supports `session/load`.
   */
  public getSupportsLoadSession(): boolean {
    if (this.features.multiSession)
      return this.features.multiSession.getSupportsLoadSession();
    return this.sessionManager.supportsLoadSession;
  }

  /**
   * Return whether the current agent supports `session/list`.
   */
  public getSupportsListSessions(): boolean {
    if (this.features.multiSession)
      return this.features.multiSession.getSupportsListSessions();
    return this.sessionManager.supportsListSessions;
  }

  /**
   * Return whether the current agent supports `session/delete`.
   */
  public getSupportsDeleteSession(): boolean {
    if (this.features.multiSession)
      return this.features.multiSession.getSupportsDeleteSession();
    return this.sessionManager.supportsDeleteSession;
  }

  /**
   * Delete a history session. Removes it from the agent (if supported) and
   * the local cache.
   */
  public async deleteHistorySession(
    refOrSessionId: HistorySessionRef | string
  ): Promise<void> {
    if (this.features.multiSession) {
      await this.features.multiSession.deleteHistorySession(refOrSessionId);
      return;
    }
    const sessionId =
      typeof refOrSessionId === "string"
        ? refOrSessionId
        : refOrSessionId.sessionId;
    await this.sessionManager.deleteSession(sessionId);
  }

  /**
   * Load a history session. Clears current chat, then loads via ACP.
   * The agent will stream the full conversation history back.
   */
  public async loadHistorySession(
    refOrSessionId: HistorySessionRef | string
  ): Promise<void> {
    if (this.features.multiSession) {
      await this.features.multiSession.loadHistorySession(refOrSessionId);
      return;
    }
    const sessionId =
      typeof refOrSessionId === "string"
        ? refOrSessionId
        : refOrSessionId.sessionId;
    if (this.acpClient.getCurrentSessionId() === sessionId) {
      return;
    }

    if (this.isGenerating) {
      const ok = await this.ensureIdleIfGenerating(
        `confirm-loadHistory-${Date.now()}`,
        "loadHistory",
        "Load History"
      );
      if (!ok) return;
    }

    const cwd = getWorkspaceRoot();

    // Clear the current UI
    this.hasSession = false;
    this.hasRestoredModeModel = false;
    this.outputPipeline.reset();
    this.diffManager.clear();
    this.postMessage({ type: "chatCleared" });
    this.postMessage({
      type: "sessionMetadata",
      modes: null,
      models: null,
      genericConfigOptions: [],
    });
    this.acpClient.clearLastUsageUpdate();
    this.sendContextUsage();

    try {
      if (!this.acpClient.isConnected()) {
        await this.acpClient.connect(cwd);
      }
      this.sessionManager.syncCapabilities();
      this.documentSyncManager.syncCapabilities();

      // Set flag to indicate we're loading history
      this.outputPipeline.setLoadingHistory(true);
      await this.sessionManager.loadSession(sessionId, cwd);
      // Wait for all queued session updates to finish rendering before
      // sending the final streamEnd — otherwise the webview receives
      // streamEnd before the history content arrives.
      await this.sessionUpdateNotifier.waitForIdle();
      this.outputPipeline.flushUserMessageBuffer();
      // Finalize the last agent response in the history
      this.postMessage({ type: "streamEnd", stopReason: "history_load" });
      this.outputPipeline.setLoadingHistory(false);

      this.hasSession = true;
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to load history session:", error);
      this.outputPipeline.setLoadingHistory(false);
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.postMessage({
        type: "error",
        text: `Failed to load history: ${errorMessage}`,
      });
      this.sendSessionMetadata();
    }
  }

  public addMention(mention: Mention): void {
    if (this.features.multiSession) {
      this.features.multiSession.addMention(mention);
      return;
    }
    this.postMessage({ type: "addMention", mention });
  }

  public addSelection(selection: SelectionMention): void {
    this.addMention(selection);
  }

  private stderrBuffer = "";

  private handleStderr(text: string): void {
    this.stderrBuffer += text;

    const errorMatch = this.stderrBuffer.match(
      /(\w+Error):\s*(\w+)?\s*\n?\s*data:\s*\{([^}]+)\}/
    );
    if (errorMatch) {
      const errorType = errorMatch[1];
      const errorData = errorMatch[3];
      const providerMatch = errorData.match(/providerID:\s*"([^"]+)"/);
      const modelMatch = errorData.match(/modelID:\s*"([^"]+)"/);

      let message = `Agent error: ${errorType}`;
      if (providerMatch && modelMatch) {
        message = `Model not found: ${providerMatch[1]}/${modelMatch[1]}`;
      }

      this.postMessage({ type: "agentError", text: message });
      this.stderrBuffer = "";
    }

    if (this.stderrBuffer.length > 10000) {
      this.stderrBuffer = this.stderrBuffer.slice(-5000);
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Add to queue
      this.permissionQueue.push({
        id: requestId,
        params,
        resolver: resolve,
      });

      if (params.toolCall?.toolCallId) {
        this.outputPipeline.markToolCallPendingForPermission(
          params.toolCall.toolCallId
        );
        this.postMessage({
          type: "toolCallStart",
          name: params.toolCall.title || "Tool",
          toolCallId: params.toolCall.toolCallId,
          kind: params.toolCall.kind,
        });
      }

      // Send to webview
      this.postMessage({
        type: "permissionRequest",
        requestId,
        toolCallId: params.toolCall?.toolCallId,
        toolCall: {
          kind: params.toolCall?.kind || "Unknown",
          title: params.toolCall?.title || "Tool Call",
        },
        options: (params.options || []).map((opt) => ({
          optionId: opt.optionId,
          kind: opt.kind,
          name: opt.name,
        })),
      });

      // Timeout logic
      setTimeout(() => {
        const pending = this.permissionQueue.find((p) => p.id === requestId);
        if (pending) {
          pending.resolver({ outcome: { outcome: "cancelled" } });
          this.permissionQueue = this.permissionQueue.filter(
            (p) => p.id !== requestId
          );
        }
      }, 60000); // 60s timeout
    });
  }

  public dispose(): void {
    this.features.chatFontSize?.dispose();
    this.multiSessionManagerView?.dispose();
    this.features.multiSession?.dispose();
    this.sessionUpdateNotifier.dispose();
    this.webviewPostNotifier.dispose();
    this.diffManager.dispose();
    this.documentSyncManager.dispose();
    this.fileHandler.dispose();
    this.terminalHandler.dispose();
    this.outputPipeline.dispose();
  }

  private async handleSessionUpdate(
    notification: SessionNotification
  ): Promise<void> {
    await this.outputPipeline.handleSessionUpdate(notification);
  }

  private flushUserMessageBuffer(): void {
    this.outputPipeline.flushUserMessageBuffer();
  }

  private get isLoadingHistory(): boolean {
    return this.outputPipeline.state.isLoadingHistory;
  }

  private set isLoadingHistory(value: boolean) {
    this.outputPipeline.setLoadingHistory(value);
  }

  private async finalizePendingToolCalls(
    stopReason: string | undefined
  ): Promise<void> {
    await this.outputPipeline.finalizePendingToolCalls(stopReason);
  }

  private get toolCalls() {
    return this.outputPipeline.state.toolCalls;
  }

  private get userMessageBuffer(): string {
    return this.outputPipeline.state.userMessageBuffer;
  }

  private set userMessageBuffer(value: string) {
    this.outputPipeline.state.userMessageBuffer = value;
  }

  private getLegacyMessageQueue(): MessageQueueController {
    if (!this.legacyMessageQueue) {
      const messageQueueFeature = this.features.messageQueue;
      if (!messageQueueFeature) {
        throw new Error("Message queue host feature is not registered");
      }
      this.legacyMessageQueue = messageQueueFeature.createController({
        isBusy: () => this.isGenerating,
        dispatch: (payload) =>
          this.handleUserMessage(
            payload.text,
            payload.images,
            payload.mentions
          ),
        cancel: () => this.acpClient.cancel(),
        onState: (snapshot) =>
          this.postMessage(snapshot as unknown as Record<string, unknown>),
      });
    }
    return this.legacyMessageQueue;
  }

  private async handleMessageQueueMessage(
    message: MessageQueueHostMessage & WebviewMessage
  ): Promise<void> {
    if (this.features.multiSession) {
      await this.features.multiSession.handleCoreMessage(message as never);
      return;
    }
    const queue = this.getLegacyMessageQueue();
    if (message.type === "feature.message-queue.submit") {
      if (!message.requestId || !message.payload) return;
      try {
        const disposition = await queue.submit({
          id: message.requestId,
          intent: message.intent ?? "steer",
          payload: message.payload,
        });
        this.postMessage({
          type: "feature.message-queue.submitResult",
          requestId: message.requestId,
          disposition,
          acceptedHtml: message.payload.composerHtml,
        });
      } catch (error) {
        this.postMessage({
          type: "feature.message-queue.submitResult",
          requestId: message.requestId,
          disposition: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (!message.requestId) return;
    const payloads =
      message.type === "feature.message-queue.abortAndRestore"
        ? await queue.abortAndRestore(message.currentDraft)
        : queue.restoreQueuedWithoutAbort(message.currentDraft);
    this.postMessage({
      type: "feature.message-queue.restoreResult",
      requestId: message.requestId,
      payloads,
      aborted: message.type === "feature.message-queue.abortAndRestore",
    });
  }

  private async handleUserMessage(
    text: string,
    images: string[] = [],
    mentions: Array<{
      name: string;
      path?: string;
      type?: "file" | "folder" | "selection" | "terminal" | "image";
      content?: string;
      range?: { startLine: number; endLine: number };
      dataUrl?: string;
    }> = []
  ): Promise<void> {
    if (this.isGenerating) return;
    this.isGenerating = true;

    // Clear history restoration buffer on new user interaction
    this.postMessage({ type: "userMessage", text, images, mentions });

    try {
      const workingDir = getWorkspaceRoot();

      if (!this.acpClient.isConnected()) {
        await this.acpClient.connect(workingDir);
      }

      if (!this.hasSession) {
        await this.sessionManager.newSession(workingDir);
        this.hasSession = true;
        this.sendSessionMetadata();
      }

      this.stderrBuffer = "";
      this.postMessage({ type: "streamStart" });
      const response = await this.acpClient.sendMessage(text, images, mentions);

      await this.outputPipeline.finalizePendingToolCalls(response.stopReason);
      this.postMessage({
        type: "streamEnd",
        stopReason: response.stopReason,
      });
    } catch (error) {
      console.error("[Chat] Error in handleUserMessage:", error);
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.postMessage({
        type: "error",
        text: `Error: ${errorMessage}`,
      });
      await this.outputPipeline.finalizePendingToolCalls("error");
      this.postMessage({ type: "streamEnd", stopReason: "error" });
      this.stderrBuffer = "";
      throw error;
    } finally {
      this.isGenerating = false;
      this.legacyMessageQueue?.notifyStateChanged();
    }
  }

  public getSelectedAgentId(): string {
    return this.features.multiSession
      ? this.features.multiSession.getDefaultAgentId()
      : this.acpClient.getAgentId();
  }

  public async switchAgent(agentId: string): Promise<void> {
    await this.selectAgentAndStartNewChat(agentId);
  }

  public async selectAgentAndStartNewChat(agentId: string): Promise<void> {
    if (this.features.multiSession) {
      await this.features.multiSession.selectAgentAndNewChat(agentId);
      return;
    }
    await this.handleAgentChangeAndNewChat(agentId);
  }

  private async handleAgentChange(agentId: string): Promise<void> {
    const agent = getAgent(agentId);
    if (agent) {
      if (this.isGenerating) {
        const currentAgentName = this.acpClient.getAgentName();
        const ok = await this.ensureIdleIfGenerating(
          `confirm-switchAgent-${Date.now()}`,
          "switchAgent",
          `Switch Agent: ${currentAgentName} → ${agent.name}`
        );
        if (!ok) return;
      }

      this.acpClient.setAgent(agent);
      this.outputPipeline.reset();
      this.outputPipeline.setLiveToolOutputProfile(agent.liveToolOutputProfile);
      this.globalState.update(SELECTED_AGENT_KEY, agentId);
      this.hasSession = false;
      this.hasRestoredModeModel = false;
      this.diffManager.clear();
      this.sessionManager.syncCapabilities();
      this.documentSyncManager.syncCapabilities();
      this.postMessage({
        type: "agentChanged",
        agentId,
        agentName: agent.name,
      });
      this.postMessage({
        type: "sessionMetadata",
        modes: null,
        models: null,
        genericConfigOptions: [],
      });
      this.acpClient.clearLastUsageUpdate();
      this.sendContextUsage();

      try {
        await this.handleConnect();
      } catch (error) {
        console.error(
          "[Chat] Auto-reconnect failed after agent change:",
          error
        );
      }
    }
  }

  private async handleModeChange(modeId: string): Promise<void> {
    try {
      await this.acpClient.setMode(modeId);
      await this.updateCurrentAgentPreference((pref) => ({ ...pref, modeId }));
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to set mode:", error);
    }
  }

  private async handleModelChange(modelId: string): Promise<void> {
    try {
      await this.acpClient.setModel(modelId);
      await this.updateCurrentAgentPreference((pref) => ({ ...pref, modelId }));
      await this.restorePerModelConfigOptions(modelId);
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to set model:", error);
    }
  }

  private async handleConfigOptionChange(
    configId: string,
    value: string
  ): Promise<void> {
    try {
      await this.acpClient.setConfigOption(configId, value);
      const thoughtLevelIds = this.getThoughtLevelConfigOptionIds();
      await this.updateCurrentAgentPreference((pref) => {
        const updated: AgentPreference = {
          ...pref,
          configOptionValues: {
            ...pref.configOptionValues,
            [configId]: value,
          },
        };
        if (thoughtLevelIds.has(configId) && pref.modelId) {
          const modelValues = { ...(updated.modelConfigOptionValues ?? {}) };
          modelValues[pref.modelId] = {
            ...(modelValues[pref.modelId] ?? {}),
            [configId]: value,
          };
          updated.modelConfigOptionValues = modelValues;
        }
        return updated;
      });
      this.sendSessionMetadata();
    } catch (error) {
      console.error(`[Chat] Failed to set config option ${configId}:`, error);
    }
  }

  private async handleConnect(): Promise<void> {
    try {
      const workingDir = getWorkspaceRoot();

      if (!this.acpClient.isConnected()) {
        await this.acpClient.connect(workingDir);
      }
      this.sessionManager.syncCapabilities();
      this.documentSyncManager.syncCapabilities();
      if (!this.hasSession) {
        await this.sessionManager.newSession(workingDir);
        this.hasSession = true;
        this.sendSessionMetadata();
      }
    } catch (error) {
      this.postMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to connect",
      });
    }
  }

  private async handleNewChat(): Promise<void> {
    if (this.isGenerating) {
      const ok = await this.ensureIdleIfGenerating(
        `confirm-newChat-${Date.now()}`,
        "newChat",
        "New Chat"
      );
      if (!ok) return;
    }

    this.resetLegacyChatSurface();

    try {
      if (this.acpClient.isConnected()) {
        const workingDir = getWorkspaceRoot();
        await this.sessionManager.newSession(workingDir);
        this.hasSession = true;
        this.sendSessionMetadata();
      }
    } catch (error) {
      console.error("[Chat] Failed to create new session:", error);
    }
  }

  private async handleAgentChangeAndNewChat(agentId: string): Promise<void> {
    const agent = getAgent(agentId);
    if (!agent) return;

    if (this.isGenerating) {
      const currentAgentName = this.acpClient.getAgentName();
      const ok = await this.ensureIdleIfGenerating(
        `confirm-switchAgent-${Date.now()}`,
        "switchAgent",
        `Switch Agent: ${currentAgentName} → ${agent.name}`
      );
      if (!ok) return;
    }

    this.resetLegacyChatSurface();
    this.acpClient.setAgent(agent);
    this.outputPipeline.setLiveToolOutputProfile(agent.liveToolOutputProfile);
    await this.globalState.update(SELECTED_AGENT_KEY, agentId);
    this.postMessage({
      type: "agentChanged",
      agentId,
      agentName: agent.name,
    });

    try {
      const workingDir = getWorkspaceRoot();
      if (!this.acpClient.isConnected()) {
        await this.acpClient.connect(workingDir);
      }
      this.sessionManager.syncCapabilities();
      this.documentSyncManager.syncCapabilities();
      await this.sessionManager.newSession(workingDir);
      this.hasSession = true;
      this.sendSessionMetadata();
      this.postMessage({
        type: "connectionState",
        state: this.acpClient.getState(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Chat] Failed to select agent and create session:", error);
      this.postMessage({ type: "error", text: message });
    }
  }

  private resetLegacyChatSurface(): void {
    this.hasSession = false;
    this.hasRestoredModeModel = false;
    this.outputPipeline.reset();
    this.diffManager.clear();
    this.postMessage({ type: "chatCleared" });
    this.postMessage({
      type: "sessionMetadata",
      modes: null,
      models: null,
      genericConfigOptions: [],
    });
    this.acpClient.clearLastUsageUpdate();
    this.sendContextUsage();
  }

  private handleClearChat(): void {
    this.postMessage({ type: "chatCleared" });
  }

  private requestConfirmation(
    requestId: string,
    action: string,
    actionLabel: string
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingConfirmations.set(requestId, resolve);
      this.postMessage({
        type: "confirmAction",
        requestId,
        action,
        actionLabel,
      });
    });
  }

  private waitForIdle(): Promise<boolean> {
    if (!this.isGenerating) return Promise.resolve(true);
    const timeoutMs = 10_000;
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const done = (success: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(success);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const check = () => {
        if (!this.isGenerating) {
          done(true);
        } else if (!resolved) {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private async ensureIdleIfGenerating(
    requestId: string,
    action: string,
    actionLabel: string
  ): Promise<boolean> {
    if (!this.isGenerating) return true;
    const confirmed = await this.requestConfirmation(
      requestId,
      action,
      actionLabel
    );
    if (!confirmed) return false;
    await this.acpClient.cancel();
    const idle = await this.waitForIdle();
    if (!idle) {
      vscode.window.showErrorMessage(
        "Agent is still generating. Please try again later."
      );
      return false;
    }
    return true;
  }

  private sendSessionMetadata(): void {
    const metadata = this.acpClient.getSessionMetadata();
    const pref = this.getCurrentAgentPreference();
    this.postMessage({
      type: "sessionMetadata",
      modes: metadata?.modes ?? null,
      models: metadata?.models ?? null,
      genericConfigOptions: metadata?.genericConfigOptions ?? [],
      commands: metadata?.commands ?? null,
      starredModels: pref.starredModels,
    });

    if (!this.hasRestoredModeModel && this.hasSession) {
      this.hasRestoredModeModel = true;
      this.restoreSessionPreferences().catch((error) =>
        console.warn(
          "[Chat] Failed to restore saved session preferences:",
          error
        )
      );
    }
  }

  private sendContextUsage(): void {
    const last = this.acpClient.getSessionMetadata()?.lastUsageUpdate;
    if (last && typeof last.size === "number" && last.size > 0) {
      this.postMessage({
        type: "contextUsage",
        used: last.used,
        size: last.size,
        cost: last.cost ?? null,
      });
    } else {
      this.postMessage({
        type: "contextUsage",
        used: null,
        size: null,
        cost: null,
      });
    }
  }

  private getCurrentAgentPreference(): AgentPreference {
    const agentId = this.acpClient.getAgentId();
    const allPrefs =
      this.globalState.get<AgentPreferences>(AGENT_PREFS_KEY) ?? {};
    return allPrefs[agentId] ?? { configOptionValues: {}, starredModels: [] };
  }

  private async updateCurrentAgentPreference(
    updater: (pref: AgentPreference) => AgentPreference
  ): Promise<void> {
    const agentId = this.acpClient.getAgentId();
    const allPrefs =
      this.globalState.get<AgentPreferences>(AGENT_PREFS_KEY) ?? {};
    allPrefs[agentId] = updater(
      allPrefs[agentId] ?? { configOptionValues: {}, starredModels: [] }
    );
    await this.globalState.update(AGENT_PREFS_KEY, allPrefs);
  }

  private getThoughtLevelConfigOptionIds(): Set<string> {
    const metadata = this.acpClient.getSessionMetadata();
    const generic = metadata?.genericConfigOptions ?? [];
    const ids = new Set<string>();
    for (const opt of generic) {
      if (opt.category === "thought_level") {
        ids.add(opt.id);
      }
    }
    return ids;
  }

  private async restorePerModelConfigOptions(
    modelId: string
  ): Promise<Set<string>> {
    const restored = new Set<string>();
    const pref = this.getCurrentAgentPreference();
    const modelValues = pref.modelConfigOptionValues?.[modelId];
    if (!modelValues) return restored;

    const metadata = this.acpClient.getSessionMetadata();
    const generic = metadata?.genericConfigOptions ?? [];
    for (const [configId, savedValue] of Object.entries(modelValues)) {
      const opt = generic.find((o) => o.id === configId);
      if (!opt) continue;
      const stillAvailable = opt.options.some((o) => o.value === savedValue);
      if (!stillAvailable) continue;
      if (opt.currentValue === savedValue) continue;
      try {
        await this.acpClient.setConfigOption(configId, savedValue);
        await this.updateCurrentAgentPreference((p) => ({
          ...p,
          configOptionValues: {
            ...p.configOptionValues,
            [configId]: savedValue,
          },
        }));
        restored.add(configId);
      } catch (err) {
        console.warn(
          `[Chat] Failed to restore ${configId} for model ${modelId}:`,
          err
        );
      }
    }
    return restored;
  }

  private async restoreSessionPreferences(): Promise<void> {
    const metadata = this.acpClient.getSessionMetadata();
    const availableModes = Array.isArray(metadata?.modes?.availableModes)
      ? metadata.modes.availableModes
      : [];
    const availableModels = Array.isArray(metadata?.models?.availableModels)
      ? metadata.models.availableModels
      : [];
    const genericConfigOptions = Array.isArray(metadata?.genericConfigOptions)
      ? metadata.genericConfigOptions
      : [];

    const pref = this.getCurrentAgentPreference();

    let modeRestored = false;
    let modelRestored = false;
    const configOptionsRestored = new Set<string>();

    if (
      await this.migratePiThinkingModePreference(pref, genericConfigOptions)
    ) {
      configOptionsRestored.add("thought_level");
    }

    if (
      pref.modeId &&
      availableModes.some(
        (mode: { id: string }) => mode && mode.id === pref.modeId
      )
    ) {
      await this.acpClient.setMode(pref.modeId);
      modeRestored = true;
    }

    if (
      pref.modelId &&
      availableModels.some(
        (model: { modelId: string }) => model && model.modelId === pref.modelId
      )
    ) {
      await this.acpClient.setModel(pref.modelId);
      modelRestored = true;
    }

    const savedConfigValues = pref.configOptionValues ?? {};
    for (const opt of genericConfigOptions) {
      const saved = savedConfigValues[opt.id];
      if (!saved) continue;
      const stillAvailable = opt.options.some((o) => o.value === saved);
      if (!stillAvailable) continue;
      if (saved === opt.currentValue) continue;
      try {
        await this.acpClient.setConfigOption(opt.id, saved);
        configOptionsRestored.add(opt.id);
      } catch (error) {
        console.warn(
          `[Chat] Failed to restore config option ${opt.id}:`,
          error
        );
      }
    }

    if (modelRestored && pref.modelId) {
      const perModelRestored = await this.restorePerModelConfigOptions(
        pref.modelId
      );
      for (const id of perModelRestored) {
        configOptionsRestored.add(id);
      }
    }

    if (modeRestored || modelRestored || configOptionsRestored.size > 0) {
      const refreshed = this.acpClient.getSessionMetadata();
      this.postMessage({
        type: "sessionMetadata",
        modes: refreshed?.modes ?? null,
        models: refreshed?.models ?? null,
        genericConfigOptions: refreshed?.genericConfigOptions ?? [],
        commands: refreshed?.commands ?? null,
        starredModels: pref.starredModels,
      });
    }
  }

  private async migratePiThinkingModePreference(
    pref: AgentPreference,
    genericConfigOptions: NonNullable<SessionMetadata["genericConfigOptions"]>
  ): Promise<boolean> {
    const savedModeId = pref.modeId;
    if (
      this.acpClient.getAgentId() !== "pi" ||
      !savedModeId ||
      pref.configOptionValues?.thought_level ||
      !this.isPiThinkingLevel(savedModeId)
    ) {
      return false;
    }

    const thoughtOption = genericConfigOptions.find(
      (option) =>
        option.id === "thought_level" || option.category === "thought_level"
    );
    if (
      !thoughtOption?.options.some((option) => option.value === savedModeId)
    ) {
      return false;
    }

    await this.acpClient.setConfigOption(thoughtOption.id, savedModeId);
    await this.updateCurrentAgentPreference((current) => {
      const { modeId, ...rest } = current;
      void modeId;
      return {
        ...rest,
        configOptionValues: {
          ...current.configOptionValues,
          [thoughtOption.id]: savedModeId,
        },
      };
    });
    return true;
  }

  private isPiThinkingLevel(value: string): boolean {
    return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
  }

  private postMessage(message: Record<string, unknown>): void {
    const webview = this.view?.webview;
    if (!webview) {
      return;
    }

    this.webviewPostNotifier.enqueue(async () => {
      try {
        await webview.postMessage(message);
      } catch (error) {
        console.warn("[Chat] Failed to post message to webview:", error);
      }
    });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const styleResetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "reset.css")
    );
    const styleVSCodeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vscode.css")
    );
    const styleMainUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css")
    );
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "assets", "icon.svg")
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicon.css")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link href="${codiconsUri}" rel="stylesheet">
  <link href="${styleResetUri}" rel="stylesheet">
  <link href="${styleVSCodeUri}" rel="stylesheet">
  <link href="${styleMainUri}" rel="stylesheet">
  <title>VSCode ACP Chat</title>
</head>
<body>
  <div id="welcome-view" class="welcome-view" role="main" aria-label="Welcome">
    <img src="${logoUri}" alt="VSCode ACP Logo" class="welcome-logo">
    <h3>Welcome to VSCode ACP</h3>
    <p>Chat with AI coding agents directly in VS Code.</p>
  </div>

  <div id="agent-plan-container"></div>

  <div id="messages-container">
    <div class="messages-fade-top"></div>
    <div id="messages" role="log" aria-label="Chat messages" aria-live="polite" tabindex="0"></div>
    <div class="messages-fade-bottom"></div>
  </div>

  <div id="typing-indicator" class="typing-indicator" aria-hidden="true">
    <div class="zed-loader">
      <div></div><div></div><div></div>
    </div>
  </div>

  <div id="diff-summary-container" class="diff-summary-container"></div>

  <div id="chat-input-area">
    <div id="input-container">
      <div id="command-autocomplete" role="listbox" aria-label="Slash commands"></div>
      <div
        id="input"
        class="input-rich"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        data-placeholder="Ask your agent... (Press Enter to send, Shift+Enter for new line. Type / for commands, @ for files.)"
        aria-label="Message input"
        aria-describedby="input-hint"
        aria-autocomplete="list"
        aria-controls="command-autocomplete"></div>
      <div id="input-hint" class="input-hint">Press Enter to send, Shift+Enter for new line. Type / for commands, @ for files.</div>
    </div>

    <div id="options-bar" role="toolbar" aria-label="Session options">
      <div id="left-options">
        <button id="attach-image" class="icon-button" aria-label="Attach image" acp-title="Attach image">
          <span class="dropdown-icon codicon codicon-file-media"></span>
        </button>
        <div class="custom-dropdown" id="mode-dropdown" style="display: none;">
          <div class="dropdown-trigger">
            <span class="dropdown-icon codicon codicon-sparkle"></span>
            <span class="selected-label">Mode</span>
            <span class="dropdown-chevron">
              <span class="codicon codicon-chevron-down"></span>
            </span>
          </div>
          <div class="dropdown-popover"></div>
        </div>
        <div class="custom-dropdown" id="model-dropdown" style="display: none;">
          <div class="dropdown-trigger">
            <span class="dropdown-icon codicon codicon-robot"></span>
            <span class="selected-label">Model</span>
            <span class="dropdown-chevron">
              <span class="codicon codicon-chevron-down"></span>
            </span>
          </div>
          <div class="dropdown-popover"></div>
        </div>
        <div id="config-options-container" class="config-options-container"></div>
        <div id="context-usage-ring" class="context-usage" hidden aria-label="Context usage">
          <svg viewBox="0 0 18 18" width="18" height="18" role="img">
            <circle class="context-usage__bg" cx="9" cy="9" r="7"></circle>
            <circle class="context-usage__fg" cx="9" cy="9" r="7" transform="rotate(-90 9 9)"></circle>
          </svg>
        </div>
      </div>
      <div id="right-options">
        <button id="send" class="icon-button" aria-label="Send message" acp-title="Send (Enter)" disabled>
          <span class="dropdown-icon codicon codicon-send"></span>
        </button>
        <button id="stop" class="icon-button" aria-label="Stop generation" acp-title="Stop" style="display: none;">
          <span class="dropdown-icon codicon codicon-debug-stop"></span>
        </button>
      </div>
    </div>
  </div>

  <div id="image-preview-popover" class="image-preview-popover">
    <img src="" alt="Preview">
  </div>
<script src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}
