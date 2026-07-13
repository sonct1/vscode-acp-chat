import * as vscode from "vscode";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  ACPClient,
  type ContextUsageUpdate,
  type SessionMetadata,
} from "../../acp/client";
import {
  getAgent,
  getAgentsWithStatus,
  getFirstAvailableAgent,
  type AgentConfig,
} from "../../acp/agents";
import type {
  AgentSessionManager,
  SessionInfo,
} from "../../acp/session-manager";
import { DiffManager } from "../../acp/diff-manager";
import { FileHandler } from "../../acp/file-handler";
import { TerminalHandler } from "../../acp/terminal-handler";
import { DocumentSyncManager } from "../../acp/document-sync";
import {
  SessionOutputPipeline,
  clientMetadata,
  type SessionRenderMessage,
} from "../../acp/session-output-pipeline";
import { getWorkspaceRoot } from "../../utils/workspace";
import { AsyncSerialProcessor } from "../../utils/async-queue";
import type { Mention } from "../../utils/mention-serializer";
import { TranscriptStore } from "./transcript-store";
import { WorkspaceMutationCoordinator } from "./workspace-mutation-coordinator";
import {
  SessionCatalogService,
  type CatalogCapabilities,
} from "./session-catalog";
import type {
  MultiSessionHostMessage,
  MultiSessionListItem,
  MultiSessionStatus,
} from "./contracts";

const SELECTED_AGENT_KEY = "vscode-acp-chat.selectedAgent";
const AGENT_PREFS_KEY = "vscode-acp-chat.agentPreferences.v1";

export interface MultiSessionRuntimeClient {
  readonly client: ACPClient;
  readonly manager: AgentSessionManager;
}

export interface MultiSessionClientFactoryResult {
  client: ACPClient;
  sessionManager?: AgentSessionManager;
}

export interface MultiSessionHostOptions {
  globalState: vscode.Memento;
  postMessage: (message: Record<string, unknown>) => void;
  onStatusChanged?: (summary: string) => void;
  clientFactory?: (
    agent: AgentConfig
  ) => ACPClient | MultiSessionClientFactoryResult;
}

interface AgentPreference {
  modeId?: string;
  modelId?: string;
  configOptionValues: Record<string, string>;
  starredModels: string[];
  modelConfigOptionValues?: Record<string, Record<string, string>>;
}

type AgentPreferences = Record<string, AgentPreference>;

type PermissionPending = {
  id: string;
  params: RequestPermissionRequest;
  resolver: (response: RequestPermissionResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
};

interface SessionResources {
  diffManager: DiffManager;
  fileHandler: FileHandler;
  terminalHandler: TerminalHandler;
}

interface ManagedSession {
  localSessionId: string;
  acpSessionId?: string;
  runtimeId?: string;
  agent: AgentConfig;
  cwd: string;
  title: string;
  status: MultiSessionStatus;
  createdAt: number;
  updatedAt: number;
  unreadCount: number;
  lastError?: string;
  transcript: TranscriptStore;
  metadata: Partial<SessionMetadata> | null;
  contextUsage: ContextUsageUpdate | null;
  permissionQueue: PermissionPending[];
  conflictedDiffPaths: Set<string>;
  stderrBuffer: string;
  isGenerating: boolean;
  isLoadingHistory: boolean;
  sendInFlight: boolean;
  resources?: SessionResources;
  client?: ACPClient;
  sessionManager?: AgentSessionManager;
  queue?: AsyncSerialProcessor<SessionNotification>;
  output?: SessionOutputPipeline;
}

export class MultiSessionHostController implements vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly sessions = new Map<string, ManagedSession>();
  private activeLocalSessionId: string | undefined;
  private activationRevision = 0;
  private defaultAgent: AgentConfig;
  private readonly mutationCoordinator = new WorkspaceMutationCoordinator();
  private readonly catalog: SessionCatalogService;
  private documentSync?: DocumentSyncManager;
  private activeDocumentSyncSessionId: string | undefined;
  private managerOpen = false;
  private disposed = false;

  private readonly globalState: vscode.Memento;
  private readonly post: (message: Record<string, unknown>) => void;
  private readonly statusChanged: (summary: string) => void;
  private readonly clientFactory: (
    agent: AgentConfig
  ) => ACPClient | MultiSessionClientFactoryResult;

  constructor(
    globalStateOrOptions: vscode.Memento | MultiSessionHostOptions,
    postMessage?: (message: Record<string, unknown>) => void,
    onStatusChanged: (summary: string) => void = () => {}
  ) {
    if ("globalState" in globalStateOrOptions) {
      this.globalState = globalStateOrOptions.globalState;
      this.post = globalStateOrOptions.postMessage;
      this.statusChanged = globalStateOrOptions.onStatusChanged ?? (() => {});
      this.clientFactory =
        globalStateOrOptions.clientFactory ??
        ((agent) => new ACPClient({ agentConfig: agent }));
    } else {
      this.globalState = globalStateOrOptions;
      this.post = postMessage ?? (() => {});
      this.statusChanged = onStatusChanged;
      this.clientFactory = (agent) => new ACPClient({ agentConfig: agent });
    }

    const savedAgentId = this.globalState.get<string>(SELECTED_AGENT_KEY);
    this.defaultAgent =
      (savedAgentId && getAgent(savedAgentId)) || getFirstAvailableAgent();
    this.catalog = new SessionCatalogService(this.globalState);
    this.mutationCoordinator.onDidWrite((ownerId, path) =>
      this.markOtherDiffsStale(ownerId, path)
    );
    this.createDraft();
  }

  static isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("vscode-acp-chat")
      .get<boolean>("multiSession.enabled", true);
  }

  attachView(view: vscode.WebviewView): void {
    this.view = view;
    this.sendState();
    this.sendSnapshot();
  }

  async handleMessage(message: MultiSessionHostMessage): Promise<boolean> {
    if (!message.type.startsWith("feature.multi-session.")) return false;

    switch (message.type) {
      case "feature.multi-session.ready":
        this.sendState();
        this.sendSnapshot();
        return true;
      case "feature.multi-session.new":
        await this.newChat();
        return true;
      case "feature.multi-session.activate":
        this.activate(message.localSessionId);
        return true;
      case "feature.multi-session.stop":
        await this.stop(message.localSessionId);
        return true;
      case "feature.multi-session.close":
        await this.close(message.localSessionId);
        return true;
      case "feature.multi-session.manage":
        this.openManager();
        return true;
      case "feature.multi-session.hideManager":
        this.closeManager();
        return true;
      case "feature.multi-session.resync":
        this.sendSnapshot();
        return true;
      case "feature.multi-session.reviewPermission":
        this.activate(message.localSessionId);
        return true;
      case "feature.multi-session.permission.respond":
        this.respondPermission(
          message.localSessionId,
          message.requestId,
          message.outcome
        );
        return true;
    }

    return false;
  }

  async handleCoreMessage(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<boolean> {
    switch (message.type) {
      case "sendMessage":
        await this.sendActiveMessage(
          typeof message.text === "string" ? message.text : "",
          Array.isArray(message.images) ? (message.images as string[]) : [],
          Array.isArray(message.mentions) ? (message.mentions as Mention[]) : []
        );
        return true;
      case "connect":
        await this.connectActive();
        return true;
      case "ready":
        this.sendState();
        this.sendSnapshot();
        return true;
      case "newChat":
        await this.newChat();
        return true;
      case "clearChat":
        this.clearActive();
        return true;
      case "stop":
        await this.stop();
        return true;
      case "selectMode":
        if (typeof message.modeId === "string") {
          await this.setActiveMode(message.modeId);
        }
        return true;
      case "selectModel":
        if (typeof message.modelId === "string") {
          await this.setActiveModel(message.modelId);
        }
        return true;
      case "selectConfigOption":
        if (
          typeof message.configId === "string" &&
          typeof message.value === "string"
        ) {
          await this.setActiveConfigOption(message.configId, message.value);
        }
        return true;
      case "toggleModelStar":
        if (
          typeof message.modelId === "string" &&
          typeof message.isStarred === "boolean"
        ) {
          await this.toggleActiveModelStar(message.modelId, message.isStarred);
        }
        return true;
      case "permissionResponse":
        if (typeof message.requestId === "string" && message.outcome) {
          this.respondPermissionByRequestId(
            message.requestId,
            message.outcome as
              | { outcome: "selected"; optionId: string }
              | { outcome: "cancelled" }
          );
        }
        return true;
      case "reviewDiff":
        if (typeof message.path === "string") {
          await this.reviewDiff(message.path);
        }
        return true;
      case "acceptDiff":
        if (typeof message.path === "string") {
          await this.acceptDiff(message.path);
        }
        return true;
      case "rollbackDiff":
        if (typeof message.path === "string") {
          await this.rollbackDiff(message.path);
        }
        return true;
      case "acceptAllDiffs":
        await this.acceptAllDiffs();
        return true;
      case "rollbackAllDiffs":
        await this.rollbackAllDiffs();
        return true;
      default:
        return false;
    }
  }

  async newChat(): Promise<void> {
    const session = this.createDraft();
    this.activate(session.localSessionId);

    try {
      await this.ensureRuntime(session, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.status = "draft";
      session.lastError = message;
      this.append(session, { type: "error", text: message });
      this.sendState();
      if (session.localSessionId === this.activeLocalSessionId) {
        this.sendSnapshot();
      }
    }
  }

  openManager(): void {
    this.managerOpen = true;
    this.sendState();
  }

  closeManager(): void {
    if (!this.managerOpen) return;
    this.managerOpen = false;
    this.sendState();
  }

  clearActive(): void {
    const session = this.getActive();
    if (!session) return;
    session.transcript.clear();
    session.resources?.diffManager.clear();
    session.conflictedDiffPaths.clear();
    session.contextUsage = null;
    session.output?.reset();
    this.touch(session);
    this.sendSnapshot();
  }

  async connectActive(): Promise<void> {
    const session = this.getActive() ?? this.createDraft();
    if (this.managerOpen) {
      this.managerOpen = false;
      this.sendState();
    }

    try {
      await this.ensureRuntime(session, false);
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : String(error);
      this.touch(session);
      this.sendState();
      this.sendSnapshot();
      throw error;
    }

    if (!session.acpSessionId && session.status === "starting") {
      session.status = "idle";
      this.touch(session);
      this.sendState();
    }
    this.rebindDocumentSync(session);
    this.sendSnapshot();
  }

  async sendActiveMessage(
    text: string,
    images: string[] = [],
    mentions: Mention[] = []
  ): Promise<void> {
    const session = this.getActive() ?? this.createDraft();
    if (session.isGenerating || session.sendInFlight) return;
    session.sendInFlight = true;

    try {
      await this.ensureRuntime(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.status = "draft";
      session.lastError = message;
      this.append(session, { type: "error", text: message });
      this.sendState();
      this.openManager();
      session.sendInFlight = false;
      return;
    }

    session.isGenerating = true;
    session.status = "running";
    session.lastError = undefined;
    session.output?.reset();
    this.append(session, { type: "userMessage", text, images, mentions });
    this.append(session, { type: "streamStart" });
    this.sendState();

    try {
      const response = await session.client!.sendMessage(
        text,
        images,
        mentions
      );
      await session.output!.finalizePendingToolCalls(response.stopReason);
      this.append(session, {
        type: "streamEnd",
        stopReason: response.stopReason,
      });
      session.status = "idle";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.lastError = message;
      session.status = "error";
      this.append(session, { type: "error", text: `Error: ${message}` });
      await session.output!.finalizePendingToolCalls("error");
      this.append(session, { type: "streamEnd", stopReason: "error" });
    } finally {
      session.isGenerating = false;
      session.sendInFlight = false;
      this.touch(session);
      this.sendState();
      if (session.localSessionId === this.activeLocalSessionId) {
        this.sendSnapshot();
      }
    }
  }

  async stop(localSessionId?: string): Promise<void> {
    const session = localSessionId
      ? this.sessions.get(localSessionId)
      : this.getActive();
    if (!session?.client || !session.isGenerating) return;
    session.status = "cancelling";
    this.sendState();
    await session.client.cancel();
  }

  async close(localSessionId: string): Promise<void> {
    const session = this.sessions.get(localSessionId);
    if (!session) return;

    if (session.isGenerating) {
      const confirmed = await vscode.window.showWarningMessage(
        `Stop and close "${session.title}"?`,
        { modal: true },
        "Stop and Close"
      );
      if (confirmed !== "Stop and Close") return;
      await session.client?.cancel();
      await this.waitForIdle(session);
    }

    this.disposeSession(session);
    this.sessions.delete(localSessionId);

    if (this.activeLocalSessionId === localSessionId) {
      const next = this.sessions.values().next().value as
        ManagedSession | undefined;
      this.activeLocalSessionId =
        next?.localSessionId ?? this.createDraft().localSessionId;
      this.activationRevision += 1;
    }

    this.sendState();
    this.sendSnapshot();
  }

  async loadHistorySession(sessionId: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.acpSessionId === sessionId) {
        this.activate(session.localSessionId);
        return;
      }
    }

    const session = this.createDraft("loading_history");
    session.title = `History ${sessionId.slice(0, 8)}`;
    this.activate(session.localSessionId);

    try {
      await this.ensureRuntime(session, false);
      if (!session.sessionManager?.supportsLoadSession) {
        throw new Error(
          `Agent "${session.agent.name}" does not support loading history sessions.`
        );
      }
      session.isLoadingHistory = true;
      session.output!.setLoadingHistory(true);
      await session.sessionManager.loadSession(sessionId, session.cwd);
      session.acpSessionId = sessionId;
      this.rebindDocumentSync(session);
      await session.queue!.waitForIdle();
      session.output!.flushUserMessageBuffer();
      session.status = "idle";
      session.metadata = clientMetadata(session.client!);
      this.append(session, { type: "streamEnd", stopReason: "history_load" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.status = "error";
      session.lastError = message;
      this.append(session, {
        type: "error",
        text: `Failed to load history: ${message}`,
      });
    } finally {
      session.isLoadingHistory = false;
      session.output?.setLoadingHistory(false);
      this.touch(session);
      this.sendState();
      this.sendSnapshot();
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const session = this.getActive() ?? this.createDraft();
    const runtime = this.getCatalogRuntime(session);
    return this.catalog.listSessions(session.agent, runtime);
  }

  async deleteHistorySession(sessionId: string): Promise<void> {
    const session = this.getActive() ?? this.createDraft();
    await this.catalog.deleteSession(
      session.agent,
      sessionId,
      this.getCatalogRuntime(session)
    );
  }

  getSupportsLoadSession(): boolean {
    return this.getActive()?.sessionManager?.supportsLoadSession ?? true;
  }

  getSupportsListSessions(): boolean {
    return this.getActive()?.sessionManager?.supportsListSessions ?? true;
  }

  getSupportsDeleteSession(): boolean {
    return this.getActive()?.sessionManager?.supportsDeleteSession ?? true;
  }

  async getHistoryCapabilities(): Promise<CatalogCapabilities> {
    const session = this.getActive() ?? this.createDraft();
    return this.catalog.getCapabilities(
      session.agent,
      this.getCatalogRuntime(session)
    );
  }

  getStateForTest(): {
    activeLocalSessionId?: string;
    sessions: MultiSessionListItem[];
  } {
    return {
      activeLocalSessionId: this.activeLocalSessionId,
      sessions: [...this.sessions.values()].map((session) =>
        this.toListItem(session)
      ),
    };
  }

  addMention(mention: Mention): void {
    this.post({ type: "addMention", mention });
  }

  addSelection(
    selection: Mention & { type: "selection" | "terminal"; content: string }
  ): void {
    this.addMention(selection);
  }

  async switchAgent(agentId: string): Promise<void> {
    const agent = getAgent(agentId);
    if (!agent) return;
    this.defaultAgent = agent;
    await this.globalState.update(SELECTED_AGENT_KEY, agentId);

    const active = this.getActive();
    if (active && active.status === "draft" && !active.client) {
      active.agent = agent;
      active.title = "Untitled chat";
      this.touch(active);
      this.sendSnapshot();
    }
    this.sendState();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const localSessionId = new URLSearchParams(uri.query).get("localSessionId");
    const session = localSessionId
      ? this.sessions.get(localSessionId)
      : this.getActive();
    const change = session?.resources?.diffManager
      .getPendingChanges()
      .find((item) => item.path === uri.path);
    return change?.oldText ?? "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.documentSync?.dispose();
    this.documentSync = undefined;
    for (const session of this.sessions.values()) this.disposeSession(session);
    this.sessions.clear();
    this.catalog.dispose();
  }

  private createDraft(status: MultiSessionStatus = "draft"): ManagedSession {
    const now = Date.now();
    const session: ManagedSession = {
      localSessionId: `local-${now}-${Math.random().toString(36).slice(2)}`,
      agent: this.defaultAgent,
      cwd: getWorkspaceRoot(),
      title: "Untitled chat",
      status,
      createdAt: now,
      updatedAt: now,
      unreadCount: 0,
      transcript: new TranscriptStore(),
      metadata: null,
      contextUsage: null,
      permissionQueue: [],
      conflictedDiffPaths: new Set<string>(),
      stderrBuffer: "",
      isGenerating: false,
      isLoadingHistory: false,
      sendInFlight: false,
    };
    this.sessions.set(session.localSessionId, session);
    if (!this.activeLocalSessionId) {
      this.activeLocalSessionId = session.localSessionId;
    }
    this.sendState();
    return session;
  }

  private ensureResources(session: ManagedSession): SessionResources {
    if (session.resources) return session.resources;

    const diffManager = new DiffManager();
    const fileHandler = new FileHandler(
      diffManager,
      this.mutationCoordinator.forOwner(session.localSessionId)
    );
    const terminalHandler = new TerminalHandler();
    session.resources = { diffManager, fileHandler, terminalHandler };

    diffManager.onDidChange((changes) => {
      this.append(session, {
        type: "diffSummary",
        localSessionId: session.localSessionId,
        changes: changes.map((change) => ({
          path: change.path,
          relativePath: vscode.workspace.asRelativePath(change.path),
          oldText: change.oldText,
          newText: change.newText,
          status: session.conflictedDiffPaths.has(change.path)
            ? "conflicted"
            : change.status,
        })),
      });
      this.sendState();
    });
    return session.resources;
  }

  private async ensureRuntime(
    session: ManagedSession,
    createAcpSession = true
  ): Promise<void> {
    if (!session.client) {
      const max = vscode.workspace
        .getConfiguration("vscode-acp-chat")
        .get<number>("multiSession.maxConcurrentSessions", 4);
      const started = [...this.sessions.values()].filter(
        (item) => item.client
      ).length;
      if (started >= max) {
        throw new Error(
          `Maximum concurrent sessions (${max}) reached. Close an idle session and retry.`
        );
      }

      const resources = this.ensureResources(session);
      const created = this.clientFactory(session.agent);
      const isFactoryResult =
        typeof created === "object" && created !== null && "client" in created;
      const client = isFactoryResult ? created.client : created;
      const sessionManager = isFactoryResult
        ? (created.sessionManager ?? this.catalog.createManager(client))
        : this.catalog.createManager(client);
      const output = new SessionOutputPipeline({
        client,
        fileHandler: resources.fileHandler,
        emit: (message) => this.append(session, message),
        onMetadataChanged: (metadata) => {
          session.metadata = metadata;
          this.emitSessionMetadata(session);
        },
        onContextUsageChanged: (usage) => {
          session.contextUsage = usage;
          this.append(session, {
            type: "contextUsage",
            used: usage?.used ?? null,
            size: usage?.size ?? null,
            cost: usage?.cost ?? null,
          });
        },
        onSessionInfoChanged: (update) => {
          const title = update.title;
          if (typeof title === "string" && title.trim()) {
            session.title = title;
            this.touch(session);
            this.sendState();
          }
        },
      });
      const queue = new AsyncSerialProcessor<SessionNotification>((update) =>
        output.handleSessionUpdate(update)
      );

      session.client = client;
      session.sessionManager = sessionManager;
      session.output = output;
      session.queue = queue;
      session.runtimeId = `runtime-${session.localSessionId}`;
      this.bindClient(session, client, resources);
      session.status = "starting";
      this.sendState();

      try {
        await client.connect(session.cwd);
        sessionManager.syncCapabilities();
        if (session.localSessionId === this.activeLocalSessionId) {
          this.rebindDocumentSync(session);
        }
      } catch (error) {
        this.disposeRuntime(session);
        session.status = session.acpSessionId ? "error" : "draft";
        throw error;
      }
    }

    if (createAcpSession && !session.acpSessionId) {
      const response = await session.sessionManager!.newSession(session.cwd);
      session.acpSessionId = response.sessionId;
      this.rebindDocumentSync(session);
      session.title = "New chat";
      session.metadata = clientMetadata(session.client!);
      await this.restoreSessionPreferences(session);
      session.status = "idle";
      this.sendState();
      this.emitSessionMetadata(session);
      this.sendSnapshot();
    }
  }

  private bindClient(
    session: ManagedSession,
    client: ACPClient,
    resources: SessionResources
  ): void {
    client.setOnSessionUpdate((update) => session.queue?.push(update));
    client.setOnStderr((text) => this.handleStderr(session, text));
    client.setOnReadTextFile((params) =>
      resources.fileHandler.handleReadTextFile(params)
    );
    client.setOnWriteTextFile((params) =>
      resources.fileHandler.handleWriteTextFile(params)
    );
    client.setOnCreateTerminal((params) =>
      resources.terminalHandler.handleCreateTerminal(params)
    );
    client.setOnTerminalOutput((params) =>
      resources.terminalHandler.handleTerminalOutput(params)
    );
    client.setOnWaitForTerminalExit((params) =>
      resources.terminalHandler.handleWaitForTerminalExit(params)
    );
    client.setOnKillTerminalCommand((params) =>
      resources.terminalHandler.handleKillTerminalCommand(params)
    );
    client.setOnReleaseTerminal((params) =>
      resources.terminalHandler.handleReleaseTerminal(params)
    );
    client.setOnPermissionRequest((params) =>
      this.handlePermissionRequest(session, params)
    );
    client.setOnStateChange((state) => {
      this.append(session, { type: "connectionState", state });
      if (state === "error" || state === "disconnected") {
        if (session.isGenerating) session.status = "error";
        if (session.stderrBuffer.trim()) {
          this.append(session, {
            type: "agentError",
            text: `Agent process ${state}.\nLast stderr:\n${session.stderrBuffer}`,
          });
          session.stderrBuffer = "";
        }
        this.sendState();
      }
    });
  }

  private handlePermissionRequest(
    session: ManagedSession,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      const requestId = `perm-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      const timeout = setTimeout(
        () =>
          this.respondPermission(session.localSessionId, requestId, {
            outcome: "cancelled",
          }),
        60_000
      );
      timeout.unref?.();
      session.permissionQueue.push({
        id: requestId,
        params,
        resolver: resolve,
        timeout,
      });
      session.status = "awaiting_permission";
      this.append(session, this.permissionMessage(requestId, params));
      this.sendState();
    });
  }

  private permissionMessage(
    requestId: string,
    params: RequestPermissionRequest
  ): SessionRenderMessage {
    return {
      type: "permissionRequest",
      requestId,
      toolCallId: params.toolCall?.toolCallId,
      toolCall: {
        kind: params.toolCall?.kind || "Unknown",
        title: params.toolCall?.title || "Tool Call",
      },
      options: (params.options || []).map((option) => ({
        optionId: option.optionId,
        kind: option.kind,
        name: option.name,
      })),
    };
  }

  private respondPermission(
    localSessionId: string,
    requestId: string,
    outcome:
      { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
  ): void {
    const session = this.sessions.get(localSessionId);
    const pending = session?.permissionQueue.find(
      (item) => item.id === requestId
    );
    if (!session || !pending) return;

    clearTimeout(pending.timeout);
    pending.resolver({ outcome });
    session.permissionQueue = session.permissionQueue.filter(
      (item) => item.id !== requestId
    );
    session.status = session.isGenerating ? "running" : "idle";
    this.sendState();
  }

  private respondPermissionByRequestId(
    requestId: string,
    outcome:
      { outcome: "selected"; optionId: string } | { outcome: "cancelled" }
  ): void {
    for (const session of this.sessions.values()) {
      if (session.permissionQueue.some((item) => item.id === requestId)) {
        this.respondPermission(session.localSessionId, requestId, outcome);
        return;
      }
    }
  }

  private append(session: ManagedSession, message: SessionRenderMessage): void {
    const event = session.transcript.append(message);
    this.touch(session);

    if (session.localSessionId !== this.activeLocalSessionId) {
      session.unreadCount += 1;
      this.sendState();
      return;
    }

    this.post({
      type: "feature.multi-session.delta",
      localSessionId: session.localSessionId,
      activationRevision: this.activationRevision,
      event,
    });
  }

  private activate(localSessionId: string): void {
    const session = this.sessions.get(localSessionId);
    if (!session) return;
    this.activeLocalSessionId = localSessionId;
    this.activationRevision += 1;
    this.managerOpen = false;
    session.unreadCount = 0;
    this.rebindDocumentSync(session);
    this.sendState();
    this.sendSnapshot();
  }

  private sendSnapshot(): void {
    const session = this.getActive();
    if (!session) return;

    this.post({
      type: "feature.multi-session.snapshot",
      activeLocalSessionId: session.localSessionId,
      activationRevision: this.activationRevision,
      session: this.toListItem(session),
      transcript: session.transcript.snapshot(),
      lastSeq: session.transcript.lastSeq,
      metadata: session.metadata,
      contextUsage: session.contextUsage,
      diffChanges: this.getDiffChanges(session),
      pendingPermissions: session.permissionQueue.map((pending) =>
        this.permissionMessage(pending.id, pending.params)
      ),
      isGenerating: session.isGenerating,
    });
  }

  private sendState(): void {
    if (this.disposed) return;
    const sessions = [...this.sessions.values()].map((session) =>
      this.toListItem(session)
    );
    const running = sessions.filter((session) =>
      ["running", "starting", "loading_history", "cancelling"].includes(
        session.status
      )
    ).length;
    const awaitingPermission = sessions.filter(
      (session) => session.status === "awaiting_permission"
    ).length;
    const unread = sessions.reduce(
      (sum, session) => sum + session.unreadCount,
      0
    );

    this.post({
      type: "feature.multi-session.state",
      enabled: true,
      activeLocalSessionId: this.activeLocalSessionId,
      activationRevision: this.activationRevision,
      sessions,
      aggregate: { running, awaitingPermission, unread },
      agents: getAgentsWithStatus()
        .filter((agent) => agent.available || agent.id === this.defaultAgent.id)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
        })),
      selectedAgentId: this.defaultAgent.id,
      managerOpen: this.managerOpen,
    });
    this.statusChanged(
      running || awaitingPermission
        ? `ACP: ${running} running${awaitingPermission ? `, ${awaitingPermission} waiting` : ""}`
        : "ACP: Idle"
    );
  }

  private toListItem(session: ManagedSession): MultiSessionListItem {
    return {
      localSessionId: session.localSessionId,
      acpSessionId: session.acpSessionId,
      agentId: session.agent.id,
      agentName: session.agent.name,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      unreadCount: session.unreadCount,
      pendingPermissionCount: session.permissionQueue.length,
      diffCount: session.resources?.diffManager.getPendingChanges().length ?? 0,
      conflictedDiffCount: session.conflictedDiffPaths.size,
      lastError: session.lastError,
    };
  }

  private getDiffChanges(session: ManagedSession): Array<{
    path: string;
    relativePath: string;
    oldText: string | null;
    newText: string;
    status: string;
  }> {
    return (
      session.resources?.diffManager.getPendingChanges().map((change) => ({
        path: change.path,
        relativePath: vscode.workspace.asRelativePath(change.path),
        oldText: change.oldText,
        newText: change.newText,
        status: session.conflictedDiffPaths.has(change.path)
          ? "conflicted"
          : change.status,
      })) ?? []
    );
  }

  private getActive(): ManagedSession | undefined {
    return this.activeLocalSessionId
      ? this.sessions.get(this.activeLocalSessionId)
      : undefined;
  }

  private getCatalogRuntime(
    session: ManagedSession
  ): MultiSessionRuntimeClient | undefined {
    return session.client && session.sessionManager
      ? { client: session.client, manager: session.sessionManager }
      : undefined;
  }

  private rebindDocumentSync(session: ManagedSession): void {
    if (
      this.activeDocumentSyncSessionId === session.localSessionId &&
      this.documentSync
    ) {
      return;
    }
    this.documentSync?.dispose();
    this.documentSync = undefined;
    this.activeDocumentSyncSessionId = undefined;
    if (!session.client?.isConnected() || !session.acpSessionId) return;

    this.documentSync = new DocumentSyncManager(session.client);
    this.documentSync.syncCapabilities();
    this.activeDocumentSyncSessionId = session.localSessionId;
  }

  private touch(session: ManagedSession): void {
    session.updatedAt = Date.now();
  }

  private handleStderr(session: ManagedSession, text: string): void {
    session.stderrBuffer = (session.stderrBuffer + text).slice(-5000);
  }

  private async setActiveMode(modeId: string): Promise<void> {
    const session = this.getActive();
    if (!session) return;
    await this.ensureRuntime(session, true);
    await session.client!.setMode(modeId);
    await this.updateAgentPreference(session.agent.id, (preference) => ({
      ...preference,
      modeId,
    }));
    session.metadata = clientMetadata(session.client!);
    this.emitSessionMetadata(session);
  }

  private async setActiveModel(modelId: string): Promise<void> {
    const session = this.getActive();
    if (!session) return;
    await this.ensureRuntime(session, true);
    await session.client!.setModel(modelId);
    await this.updateAgentPreference(session.agent.id, (preference) => ({
      ...preference,
      modelId,
    }));
    await this.restorePerModelConfigOptions(session, modelId);
    session.metadata = clientMetadata(session.client!);
    this.emitSessionMetadata(session);
  }

  private async setActiveConfigOption(
    configId: string,
    value: string
  ): Promise<void> {
    const session = this.getActive();
    if (!session) return;
    await this.ensureRuntime(session, true);
    await session.client!.setConfigOption(configId, value);
    const thoughtLevelIds = this.getThoughtLevelConfigOptionIds(session);
    await this.updateAgentPreference(session.agent.id, (preference) => {
      const updated: AgentPreference = {
        ...preference,
        configOptionValues: {
          ...preference.configOptionValues,
          [configId]: value,
        },
      };
      if (thoughtLevelIds.has(configId) && preference.modelId) {
        const modelValues = {
          ...(updated.modelConfigOptionValues ?? {}),
        };
        modelValues[preference.modelId] = {
          ...(modelValues[preference.modelId] ?? {}),
          [configId]: value,
        };
        updated.modelConfigOptionValues = modelValues;
      }
      return updated;
    });
    session.metadata = clientMetadata(session.client!);
    this.emitSessionMetadata(session);
  }

  private async toggleActiveModelStar(
    modelId: string,
    isStarred: boolean
  ): Promise<void> {
    const session = this.getActive();
    if (!session) return;
    await this.updateAgentPreference(session.agent.id, (preference) => {
      const starred = new Set(preference.starredModels);
      if (isStarred) starred.add(modelId);
      else starred.delete(modelId);
      return { ...preference, starredModels: [...starred] };
    });
    this.emitSessionMetadata(session);
  }

  private emitSessionMetadata(session: ManagedSession): void {
    this.append(session, {
      type: "sessionMetadata",
      ...(session.metadata ?? {}),
      starredModels: this.getAgentPreference(session.agent.id).starredModels,
    });
  }

  private async reviewDiff(path: string): Promise<void> {
    const session = this.findDiffOwner(path) ?? this.getActive();
    const change = session?.resources?.diffManager.getChange(path);
    if (!session || !change) return;
    const uri = vscode.Uri.file(path);
    if (change.oldText === null) {
      await vscode.window.showTextDocument(uri);
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.from({
        scheme: "acp-old-content",
        path,
        query: `localSessionId=${encodeURIComponent(session.localSessionId)}`,
      }),
      uri,
      `Diff: ${vscode.workspace.asRelativePath(path)} (Original ↔ Modified)`
    );
  }

  private async acceptDiff(path: string): Promise<void> {
    const session = this.findDiffOwner(path) ?? this.getActive();
    const change = session?.resources?.diffManager.getChange(path);
    if (!session || !change) return;
    const matches = await this.mutationCoordinator.matchesCurrent(change);
    if (!matches) {
      session.conflictedDiffPaths.add(path);
      this.emitDiffSnapshot(session);
      await vscode.window.showWarningMessage(
        `Cannot accept ${vscode.workspace.asRelativePath(path)} because the file changed after this session wrote it.`
      );
      this.sendState();
      return;
    }
    session.resources?.diffManager.accept(path);
    session.conflictedDiffPaths.delete(path);
  }

  private async rollbackDiff(path: string): Promise<void> {
    const session = this.findDiffOwner(path) ?? this.getActive();
    const change = session?.resources?.diffManager.getChange(path);
    if (!session || !change) return;

    const result = await this.mutationCoordinator.safeRollback(change);
    if (result.ok) {
      session.resources!.diffManager.removeChange(path);
      session.conflictedDiffPaths.delete(path);
    } else if (result.conflict) {
      session.conflictedDiffPaths.add(path);
      this.append(session, {
        type: "error",
        text: result.message ?? "Rollback conflict",
      });
      await vscode.window.showWarningMessage(
        result.message ?? "Rollback conflict"
      );
      this.emitDiffSnapshot(session);
    }
    this.sendState();
  }

  private async acceptAllDiffs(): Promise<void> {
    const session = this.getActive();
    if (!session?.resources) return;
    for (const change of session.resources.diffManager.getPendingChanges()) {
      await this.acceptDiff(change.path);
    }
  }

  private async rollbackAllDiffs(): Promise<void> {
    const session = this.getActive();
    if (!session?.resources) return;
    for (const change of session.resources.diffManager.getPendingChanges()) {
      await this.rollbackDiff(change.path);
    }
  }

  private emitDiffSnapshot(session: ManagedSession): void {
    this.append(session, {
      type: "diffSummary",
      localSessionId: session.localSessionId,
      changes: this.getDiffChanges(session),
    });
  }

  private markOtherDiffsStale(ownerId: string | undefined, path: string): void {
    for (const session of this.sessions.values()) {
      if (session.localSessionId === ownerId) continue;
      const change = session.resources?.diffManager.getChange(path);
      if (!change || change.status !== "pending") continue;
      session.conflictedDiffPaths.add(path);
      this.emitDiffSnapshot(session);
    }
    this.sendState();
  }

  private findDiffOwner(path: string): ManagedSession | undefined {
    const active = this.getActive();
    if (active?.resources?.diffManager.getChange(path)) return active;
    return [...this.sessions.values()].find((session) =>
      session.resources?.diffManager.getChange(path)
    );
  }

  private getAgentPreference(agentId: string): AgentPreference {
    const allPreferences =
      this.globalState.get<AgentPreferences>(AGENT_PREFS_KEY) ?? {};
    return (
      allPreferences[agentId] ?? {
        configOptionValues: {},
        starredModels: [],
      }
    );
  }

  private async updateAgentPreference(
    agentId: string,
    updater: (preference: AgentPreference) => AgentPreference
  ): Promise<void> {
    const allPreferences =
      this.globalState.get<AgentPreferences>(AGENT_PREFS_KEY) ?? {};
    allPreferences[agentId] = updater(
      allPreferences[agentId] ?? {
        configOptionValues: {},
        starredModels: [],
      }
    );
    await this.globalState.update(AGENT_PREFS_KEY, allPreferences);
  }

  private getThoughtLevelConfigOptionIds(session: ManagedSession): Set<string> {
    const options =
      session.client?.getSessionMetadata()?.genericConfigOptions ?? [];
    return new Set(
      options
        .filter((option) => option.category === "thought_level")
        .map((option) => option.id)
    );
  }

  private async restorePerModelConfigOptions(
    session: ManagedSession,
    modelId: string
  ): Promise<void> {
    const preference = this.getAgentPreference(session.agent.id);
    const modelValues = preference.modelConfigOptionValues?.[modelId];
    if (!modelValues || !session.client) return;

    for (const [configId, savedValue] of Object.entries(modelValues)) {
      const option = session.client
        .getSessionMetadata()
        ?.genericConfigOptions.find((item) => item.id === configId);
      if (!option?.options.some((item) => item.value === savedValue)) continue;
      if (option.currentValue === savedValue) continue;
      await session.client.setConfigOption(configId, savedValue);
    }
  }

  private async restoreSessionPreferences(
    session: ManagedSession
  ): Promise<void> {
    const client = session.client;
    if (!client) return;
    const metadata = client.getSessionMetadata();
    const preference = this.getAgentPreference(session.agent.id);

    if (
      preference.modeId &&
      metadata?.modes?.availableModes.some(
        (mode) => mode.id === preference.modeId
      )
    ) {
      await client.setMode(preference.modeId);
    }
    if (
      preference.modelId &&
      metadata?.models?.availableModels.some(
        (model) => model.modelId === preference.modelId
      )
    ) {
      await client.setModel(preference.modelId);
    }
    for (const [configId, savedValue] of Object.entries(
      preference.configOptionValues
    )) {
      const option = client
        .getSessionMetadata()
        ?.genericConfigOptions.find((item) => item.id === configId);
      if (!option?.options.some((item) => item.value === savedValue)) continue;
      if (option.currentValue === savedValue) continue;
      await client.setConfigOption(configId, savedValue);
    }
    if (preference.modelId) {
      await this.restorePerModelConfigOptions(session, preference.modelId);
    }
    session.metadata = clientMetadata(client);
  }

  private async waitForIdle(session: ManagedSession): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (session.isGenerating && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !session.isGenerating;
  }

  private disposeRuntime(session: ManagedSession): void {
    if (this.activeDocumentSyncSessionId === session.localSessionId) {
      this.documentSync?.dispose();
      this.documentSync = undefined;
      this.activeDocumentSyncSessionId = undefined;
    }
    session.queue?.dispose();
    session.output?.dispose();
    session.client?.dispose();
    session.queue = undefined;
    session.output = undefined;
    session.client = undefined;
    session.sessionManager = undefined;
    session.runtimeId = undefined;
  }

  private disposeSession(session: ManagedSession): void {
    for (const pending of session.permissionQueue) {
      clearTimeout(pending.timeout);
      pending.resolver({ outcome: { outcome: "cancelled" } });
    }
    session.permissionQueue = [];
    this.disposeRuntime(session);
    session.resources?.diffManager.dispose();
    session.resources?.fileHandler.dispose();
    session.resources?.terminalHandler.dispose();
    session.resources = undefined;
  }
}
