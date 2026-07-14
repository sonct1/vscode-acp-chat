import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage, VsCodeApi } from "../../views/webview/types";
import type {
  MultiSessionChatStateMessage,
  MultiSessionDeltaMessage,
  MultiSessionListItem,
  MultiSessionSnapshot,
  MultiSessionStateMessage,
} from "./contracts";
import type { MultiSessionWebviewState } from "./types";
import { MULTI_SESSION_STYLES } from "./styles";

interface ChatSurfaceBridge {
  reset(): void;
  dispatch(message: ExtensionMessage): Promise<void> | void;
  setGenerating(value: boolean): void;
  getInputHtml(): string;
  setInputHtml(value: string): void;
  getScrollTop(): number;
  setScrollTop(value: number): void;
  getWebviewState(): MultiSessionWebviewState | undefined;
  saveWebviewState(state: MultiSessionWebviewState): void;
}

interface ChatAggregate {
  open: number;
  running: number;
  awaitingPermission: number;
  unread: number;
}

export class MultiSessionWebviewController {
  private header: HTMLElement;
  private loading: HTMLElement;
  private title: HTMLElement;
  private status: HTMLElement;
  private aggregateEl: HTMLElement;
  private activeLocalSessionId: string | undefined;
  private activationRevision = 0;
  private active: MultiSessionListItem | undefined;
  private aggregate: ChatAggregate = {
    open: 0,
    running: 0,
    awaitingPermission: 0,
    unread: 0,
  };
  private lastSeqBySession: Record<string, number> = {};
  private drafts: Record<string, string> = {};
  private scrollTop: Record<string, number> = {};
  private optimisticLoadingText: string | undefined;

  constructor(
    private readonly vscode: VsCodeApi,
    private readonly doc: Document,
    private readonly bridge: ChatSurfaceBridge
  ) {
    this.restoreState();
    this.header = this.createHeader();
    this.loading = this.createLoading();
    this.title = this.header.querySelector(
      ".multi-session-title"
    ) as HTMLElement;
    this.status = this.header.querySelector(
      ".multi-session-status"
    ) as HTMLElement;
    this.aggregateEl = this.header.querySelector(
      ".multi-session-aggregate"
    ) as HTMLElement;
    this.header.hidden = true;
    this.loading.hidden = true;
    this.doc.body.prepend(this.header, this.loading);
    this.injectStyles();
  }

  handleMessage(
    msg: ExtensionMessage
  ): boolean | void | Promise<boolean | void> {
    if (msg.type === "feature.multi-session.chatState") {
      this.applyChatState(msg as MultiSessionChatStateMessage);
      return true;
    }
    if (msg.type === "feature.multi-session.state") {
      this.applyLegacyState(msg as MultiSessionStateMessage);
      return true;
    }
    if (msg.type === "feature.multi-session.snapshot") {
      return this.applySnapshot(msg as MultiSessionSnapshot).then(() => true);
    }
    if (msg.type === "feature.multi-session.delta") {
      return this.applyDelta(msg as MultiSessionDeltaMessage).then(() => true);
    }
    if (msg.type === "feature.multi-session.openManager") {
      this.vscode.postMessage({ type: "feature.multi-session.openManagerPanel" });
      return true;
    }
    return;
  }

  beforeSend(): void {
    const sessionId = this.activeLocalSessionId;
    if (!sessionId) return;

    delete this.drafts[sessionId];
    this.scrollTop[sessionId] = this.bridge.getScrollTop();
    this.persistState({ inputValue: "" });
  }

  private applyLegacyState(msg: MultiSessionStateMessage): void {
    const active = msg.sessions.find(
      (session) => session.localSessionId === msg.activeLocalSessionId
    );
    this.applyChatState({
      type: "feature.multi-session.chatState",
      enabled: msg.enabled,
      activeLocalSessionId: msg.activeLocalSessionId,
      activationRevision: msg.activationRevision,
      active,
      aggregate: {
        open: msg.aggregate.open ?? msg.sessions.length,
        running: msg.aggregate.running,
        awaitingPermission: msg.aggregate.awaitingPermission,
        unread: msg.aggregate.unread,
      },
    });
  }

  private applyChatState(msg: MultiSessionChatStateMessage): void {
    if (!msg.enabled) {
      this.header.hidden = true;
      this.loading.hidden = true;
      return;
    }

    const activeChanged =
      msg.activeLocalSessionId !== this.activeLocalSessionId ||
      msg.activationRevision !== this.activationRevision;
    this.header.hidden = false;
    if (msg.activeLocalSessionId) {
      this.activeLocalSessionId = msg.activeLocalSessionId;
      this.activationRevision = msg.activationRevision;
    }
    this.active = msg.active ?? this.active;
    this.aggregate = msg.aggregate;
    this.clearOptimisticLoadingIfSettled();
    this.renderHeader();
    this.renderLoading();
    if (activeChanged) {
      this.persistState();
    }
  }

  private async applySnapshot(msg: MultiSessionSnapshot): Promise<void> {
    const previousSessionId = this.activeLocalSessionId;
    if (previousSessionId && previousSessionId !== msg.activeLocalSessionId) {
      this.saveActiveSurfaceState();
    }
    this.activeLocalSessionId = msg.activeLocalSessionId;
    this.activationRevision = msg.activationRevision;
    this.active = msg.session;
    this.bridge.reset();
    for (const event of msg.transcript) {
      await this.bridge.dispatch(event.message as ExtensionMessage);
    }
    this.lastSeqBySession[msg.activeLocalSessionId] = msg.lastSeq;
    if (msg.metadata) {
      await this.bridge.dispatch({
        ...(msg.metadata as ExtensionMessage),
        type: "sessionMetadata",
      });
    } else {
      await this.bridge.dispatch({
        type: "sessionMetadata",
        modes: null,
        models: null,
        genericConfigOptions: [],
      });
    }
    if (msg.contextUsage) {
      await this.bridge.dispatch({ type: "contextUsage", ...msg.contextUsage });
    } else {
      await this.bridge.dispatch({
        type: "contextUsage",
        used: null,
        size: null,
        cost: null,
      });
    }
    await this.bridge.dispatch({
      type: "diffSummary",
      changes: msg.diffChanges ?? [],
    });
    for (const permission of msg.pendingPermissions ?? []) {
      await this.bridge.dispatch(permission as ExtensionMessage);
    }
    this.bridge.setGenerating(msg.isGenerating);
    this.bridge.setInputHtml(this.drafts[msg.activeLocalSessionId] ?? "");
    this.bridge.setScrollTop(this.scrollTop[msg.activeLocalSessionId] ?? 0);
    this.clearOptimisticLoadingIfSettled();
    this.renderHeader();
    this.renderLoading();
    this.persistState();
  }

  private async applyDelta(msg: MultiSessionDeltaMessage): Promise<void> {
    if (
      msg.localSessionId !== this.activeLocalSessionId ||
      msg.activationRevision !== this.activationRevision
    ) {
      return;
    }
    const lastSeq = this.lastSeqBySession[msg.localSessionId] ?? 0;
    if (msg.event.seq <= lastSeq) return;
    if (msg.event.seq !== lastSeq + 1) {
      this.vscode.postMessage({ type: "feature.multi-session.resync" });
      return;
    }
    this.lastSeqBySession[msg.localSessionId] = msg.event.seq;
    await this.bridge.dispatch(msg.event.message as ExtensionMessage);
  }

  private saveActiveSurfaceState(): void {
    if (!this.activeLocalSessionId) return;
    this.drafts[this.activeLocalSessionId] = this.bridge.getInputHtml();
    this.scrollTop[this.activeLocalSessionId] = this.bridge.getScrollTop();
    this.persistState();
  }

  private renderHeader(): void {
    const active = this.active;

    this.title.textContent = active?.title ?? "Untitled chat";
    this.status.textContent = active
      ? `${formatStatus(active.status)} · ${active.agentName}`
      : "Draft";
    setStatusClasses(this.status, active?.status);
    this.status.classList.toggle(
      "busy",
      Boolean(active && isRunningStatus(active.status))
    );

    const parts = [
      `Sessions ${this.aggregate.open}`,
      `Running ${this.aggregate.running}`,
      `Waiting ${this.aggregate.awaitingPermission}`,
      `Unread ${this.aggregate.unread}`,
    ];
    this.aggregateEl.textContent = parts.join(" · ");
  }

  private createHeader(): HTMLElement {
    const header = this.doc.createElement("div");
    header.className = "multi-session-header";
    header.innerHTML = `<button type="button" class="multi-session-open multi-session-button multi-session-button-ghost" aria-label="Switch chat session"><span class="codicon codicon-list-selection" aria-hidden="true"></span></button><div class="multi-session-heading"><strong class="multi-session-title"></strong><span class="multi-session-status"></span><span class="multi-session-aggregate"></span></div><button type="button" class="multi-session-manager multi-session-button multi-session-button-secondary" aria-label="Open session manager"><span class="codicon codicon-list-tree" aria-hidden="true"></span><span>Manager</span></button>`;
    header
      .querySelector(".multi-session-open")
      ?.addEventListener("click", () => {
        this.vscode.postMessage({ type: "feature.multi-session.quickSwitch" });
      });
    header
      .querySelector(".multi-session-manager")
      ?.addEventListener("click", () => {
        this.vscode.postMessage({
          type: "feature.multi-session.openManagerPanel",
        });
      });
    return header;
  }

  private createLoading(): HTMLElement {
    const loading = this.doc.createElement("div");
    loading.className = "multi-session-loading";
    loading.hidden = true;
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-live", "polite");
    loading.innerHTML = `<span class="multi-session-spinner" aria-hidden="true"></span><span class="multi-session-loading-text"></span>`;
    return loading;
  }

  private showOptimisticLoading(text: string): void {
    this.optimisticLoadingText = text;
    this.renderLoading();
  }

  private renderLoading(): void {
    const active = this.active;
    const stateLoading = Boolean(
      active && isSurfaceLoadingStatus(active.status)
    );
    const textValue = stateLoading
      ? loadingText(active!.status, active!.agentName)
      : this.optimisticLoadingText;
    this.loading.hidden = !textValue;
    if (!textValue) return;
    const text = this.loading.querySelector(
      ".multi-session-loading-text"
    ) as HTMLElement;
    text.textContent = textValue;
  }

  private clearOptimisticLoadingIfSettled(): void {
    if (!this.optimisticLoadingText) return;
    const active = this.active;
    if (!active) return;
    if (
      active.lastError ||
      active.status === "idle" ||
      active.status === "running" ||
      active.status === "awaiting_permission" ||
      active.status === "error" ||
      active.status === "closed"
    ) {
      this.optimisticLoadingText = undefined;
    }
  }

  private restoreState(): void {
    const state = this.bridge.getWebviewState();
    this.drafts = state?.multiSession?.drafts ?? {};
    this.scrollTop = state?.multiSession?.scrollTop ?? {};
    this.activeLocalSessionId = state?.multiSession?.activeLocalSessionId;
  }

  private persistState(
    overrides: Partial<MultiSessionWebviewState> = {}
  ): void {
    const existingState = this.bridge.getWebviewState();
    const normalizedState: MultiSessionWebviewState = {
      ...(existingState ?? { isConnected: false, inputValue: "" }),
      ...overrides,
      isConnected: overrides.isConnected ?? existingState?.isConnected ?? false,
      inputValue: overrides.inputValue ?? existingState?.inputValue ?? "",
    };
    this.bridge.saveWebviewState({
      ...normalizedState,
      multiSession: {
        activeLocalSessionId: this.activeLocalSessionId,
        drafts: this.drafts,
        scrollTop: this.scrollTop,
      },
    });
  }

  private injectStyles(): void {
    const style = this.doc.createElement("style");
    style.textContent = MULTI_SESSION_STYLES;
    this.doc.head.append(style);
  }
}

function setStatusClasses(el: HTMLElement, status?: string): void {
  const statusClasses = Array.from(el.classList).filter((className) =>
    className.startsWith("multi-session-status-")
  );
  el.classList.remove(...statusClasses);
  if (status) {
    el.classList.add(`multi-session-status-${status}`);
  }
}

function isRunningStatus(status: string): boolean {
  return (
    status === "running" ||
    status === "starting" ||
    status === "loading_history" ||
    status === "cancelling"
  );
}

function isSurfaceLoadingStatus(status: string): boolean {
  return (
    status === "starting" ||
    status === "loading_history" ||
    status === "cancelling"
  );
}

function loadingText(status: string, agentName: string): string {
  if (status === "loading_history") return "Loading chat history…";
  if (status === "cancelling") return "Stopping the active chat…";
  return `Initializing ${agentName}…`;
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function registerMultiSessionWebviewFeature(
  controller: WebviewController
): MultiSessionWebviewController {
  return new MultiSessionWebviewController(
    controller.getVsCodeApi(),
    controller.getDocument(),
    {
      reset: () => controller.resetChatState(),
      dispatch: async (message) => {
        await controller.handleMessage(message);
      },
      setGenerating: (value) => controller.inputPanel.setGenerating(value),
      getInputHtml: () => controller.inputPanel.getInputHtml(),
      setInputHtml: (value) => controller.inputPanel.setInputHtml(value),
      getScrollTop: () => controller.messageList.getScrollTop(),
      setScrollTop: (value) => controller.messageList.setScrollTop(value),
      getWebviewState: () => controller.getWebviewState(),
      saveWebviewState: (state) => controller.saveWebviewState(state),
    }
  );
}
