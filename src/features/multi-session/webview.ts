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
  beginSnapshotReplay?(): void;
  endSnapshotReplay?(): void;
  setSurfaceInteractionLocked?(value: boolean): void;
  setGenerating(value: boolean): void;
  getInputHtml(): string;
  setInputHtml(value: string): void;
  getScrollTop(): number;
  setScrollTop(value: number): void;
  scrollToBottom(force?: boolean): void;
  onDraftChanged?(handler: (html: string) => void): { dispose(): void };
  getWebviewState(): MultiSessionWebviewState | undefined;
  saveWebviewState(state: MultiSessionWebviewState): void;
}

interface ChatAggregate {
  open: number;
  running: number;
  awaitingPermission: number;
}

interface SnapshotReplay {
  localSessionId: string;
  activationRevision: number;
  lastSeq: number;
  pendingDeltas: MultiSessionDeltaMessage[];
}

export class MultiSessionWebviewController {
  private header: HTMLElement;
  private loading: HTMLElement;
  private title: HTMLElement;
  private status: HTMLElement;
  private activeLocalSessionId: string | undefined;
  private targetLocalSessionId: string | undefined;
  private renderedLocalSessionId: string | undefined;
  private activationRevision = 0;
  private targetActivationRevision = 0;
  private active: MultiSessionListItem | undefined;
  private aggregate: ChatAggregate = {
    open: 0,
    running: 0,
    awaitingPermission: 0,
  };
  private lastSeqBySession: Record<string, number> = {};
  private drafts: Record<string, string> = {};
  private scrollTop: Record<string, number> = {};
  private optimisticLoadingText: string | undefined;
  private snapshotReplay: SnapshotReplay | undefined;
  private hasRenderedSnapshot = false;

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
    this.header.hidden = true;
    this.loading.hidden = true;
    this.doc.body.prepend(this.header, this.loading);
    this.injectStyles();
    this.bridge.onDraftChanged?.((html) => this.updateActiveDraft(html));
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
      this.vscode.postMessage({
        type: "feature.multi-session.openManagerPanel",
      });
      return true;
    }
    return;
  }

  beforeSend(): void {
    const sessionId = this.activeLocalSessionId;
    if (!sessionId) return;

    this.acknowledgeSubmittedDraft(sessionId);
  }

  acknowledgeSubmittedDraft(sessionId: string | undefined): void {
    if (!sessionId) return;
    delete this.drafts[sessionId];
    if (sessionId === this.activeLocalSessionId) {
      this.scrollTop[sessionId] = this.bridge.getScrollTop();
      this.persistState({ inputValue: "" });
    } else {
      this.persistState();
    }
  }

  restoreDraftPayloads(sessionId: string | undefined, html: string): void {
    if (!sessionId) return;
    if (sessionId === this.activeLocalSessionId) {
      this.bridge.setInputHtml(html);
      this.persistState({ inputValue: html });
    } else {
      this.drafts[sessionId] = html;
      this.persistState();
    }
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
      },
    });
  }

  private applyChatState(msg: MultiSessionChatStateMessage): void {
    if (!msg.enabled) {
      this.header.hidden = true;
      this.loading.hidden = true;
      this.bridge.setSurfaceInteractionLocked?.(false);
      return;
    }

    if (
      this.targetActivationRevision > 0 &&
      msg.activationRevision < this.targetActivationRevision
    ) {
      return;
    }

    const activeChanged =
      msg.activeLocalSessionId !== this.targetLocalSessionId ||
      msg.activationRevision !== this.targetActivationRevision;
    this.header.hidden = false;
    if (activeChanged) {
      this.saveRenderedSurfaceState();
    }
    if (msg.activeLocalSessionId) {
      this.activeLocalSessionId = msg.activeLocalSessionId;
      this.targetLocalSessionId = msg.activeLocalSessionId;
      this.activationRevision = msg.activationRevision;
      this.targetActivationRevision = msg.activationRevision;
    }
    this.active = msg.active ?? this.active;
    this.aggregate = msg.aggregate;
    if (activeChanged && msg.activeLocalSessionId) {
      this.showOptimisticLoading("Opening chat…");
      this.bridge.setSurfaceInteractionLocked?.(true);
    } else {
      this.clearOptimisticLoadingIfSettled();
    }
    this.renderHeader();
    this.renderLoading();
    if (activeChanged) {
      this.persistState();
    }
  }

  private async applySnapshot(msg: MultiSessionSnapshot): Promise<void> {
    if (!this.isCurrentTarget(msg.activeLocalSessionId, msg.activationRevision)) {
      return;
    }

    const previousRenderedSessionId = this.renderedLocalSessionId;
    if (
      this.hasRenderedSnapshot &&
      !msg.scrollToBottom &&
      previousRenderedSessionId === msg.activeLocalSessionId
    ) {
      this.scrollTop[msg.activeLocalSessionId] = this.bridge.getScrollTop();
    } else if (
      previousRenderedSessionId &&
      previousRenderedSessionId !== msg.activeLocalSessionId
    ) {
      this.saveRenderedSurfaceState();
    }
    this.activeLocalSessionId = msg.activeLocalSessionId;
    this.targetLocalSessionId = msg.activeLocalSessionId;
    this.activationRevision = msg.activationRevision;
    this.targetActivationRevision = msg.activationRevision;
    this.active = msg.session;
    this.showOptimisticLoading("Loading chat…");
    this.bridge.setSurfaceInteractionLocked?.(true);

    const replay: SnapshotReplay = {
      localSessionId: msg.activeLocalSessionId,
      activationRevision: msg.activationRevision,
      lastSeq: msg.lastSeq,
      pendingDeltas: [],
    };
    this.snapshotReplay = replay;
    this.lastSeqBySession[msg.activeLocalSessionId] = msg.lastSeq;
    await this.yieldToBrowser();

    let snapshotReplayStarted = false;
    try {
      this.bridge.reset();
      this.bridge.beginSnapshotReplay?.();
      snapshotReplayStarted = true;
      for (const event of msg.transcript) {
        await this.bridge.dispatch({
          ...(event.message as ExtensionMessage),
          finalized: true,
          historical: true,
        });
      }
      if (snapshotReplayStarted) {
        this.bridge.endSnapshotReplay?.();
        snapshotReplayStarted = false;
      }
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
        await this.bridge.dispatch({
          type: "contextUsage",
          ...msg.contextUsage,
        });
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
      if (msg.scrollToBottom) {
        this.bridge.scrollToBottom(true);
      } else {
        this.bridge.setScrollTop(this.scrollTop[msg.activeLocalSessionId] ?? 0);
      }
      this.renderedLocalSessionId = msg.activeLocalSessionId;

      this.clearOptimisticLoadingIfSettled();
      this.renderHeader();
      this.renderLoading();
      this.persistState();
      this.hasRenderedSnapshot = true;
    } catch (error) {
      if (this.isCurrentTarget(msg.activeLocalSessionId, msg.activationRevision)) {
        this.optimisticLoadingText = undefined;
        this.renderLoading();
        this.vscode.postMessage({ type: "feature.multi-session.resync" });
      }
      throw error;
    } finally {
      if (snapshotReplayStarted) {
        this.bridge.endSnapshotReplay?.();
      }
      if (this.snapshotReplay === replay) {
        this.snapshotReplay = undefined;
      }
      if (this.isCurrentTarget(msg.activeLocalSessionId, msg.activationRevision)) {
        this.bridge.setSurfaceInteractionLocked?.(false);
      }
    }

    for (const delta of replay.pendingDeltas.sort(
      (a, b) => a.event.seq - b.event.seq
    )) {
      await this.applyDelta(delta);
    }
  }

  private async applyDelta(msg: MultiSessionDeltaMessage): Promise<void> {
    if (
      msg.localSessionId !== this.activeLocalSessionId ||
      msg.activationRevision !== this.activationRevision
    ) {
      return;
    }

    const replay = this.snapshotReplay;
    if (
      replay &&
      replay.localSessionId === msg.localSessionId &&
      replay.activationRevision === msg.activationRevision
    ) {
      if (msg.event.seq > replay.lastSeq) {
        replay.pendingDeltas.push(msg);
      }
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

  private updateActiveDraft(html: string): void {
    const sessionId = this.renderedLocalSessionId ?? this.activeLocalSessionId;
    if (!sessionId) return;
    this.drafts[sessionId] = html;
    this.persistState({ inputValue: html });
  }

  private saveRenderedSurfaceState(): void {
    const sessionId = this.renderedLocalSessionId ?? this.activeLocalSessionId;
    if (!sessionId) return;
    this.drafts[sessionId] = this.bridge.getInputHtml();
    this.scrollTop[sessionId] = this.bridge.getScrollTop();
    this.persistState();
  }

  private isCurrentTarget(
    localSessionId: string,
    activationRevision: number
  ): boolean {
    if (!this.targetLocalSessionId) return true;
    return (
      this.targetLocalSessionId === localSessionId &&
      this.targetActivationRevision === activationRevision
    );
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
  }

  private createHeader(): HTMLElement {
    const header = this.doc.createElement("div");
    header.className = "multi-session-header";
    header.innerHTML = `<button type="button" class="multi-session-open multi-session-button multi-session-button-ghost" aria-label="Switch chat session"><span class="codicon codicon-list-selection" aria-hidden="true"></span></button><div class="multi-session-heading"><strong class="multi-session-title"></strong><span class="multi-session-status"></span></div>`;
    header
      .querySelector(".multi-session-open")
      ?.addEventListener("click", () => {
        this.vscode.postMessage({ type: "feature.multi-session.quickSwitch" });
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

  private async yieldToBrowser(): Promise<void> {
    await new Promise<void>((resolve) => {
      const win = this.doc.defaultView;
      if (win) {
        win.setTimeout(resolve, 0);
      } else {
        setTimeout(resolve, 0);
      }
    });
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
      active.status === "draft" ||
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
    this.targetLocalSessionId = this.activeLocalSessionId;
    this.renderedLocalSessionId = this.activeLocalSessionId;
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
      beginSnapshotReplay: () => controller.beginSnapshotReplay(),
      endSnapshotReplay: () => controller.endSnapshotReplay(),
      setSurfaceInteractionLocked: (value) =>
        controller.setSessionTransitionLocked(value),
      setGenerating: (value) => controller.setTurnGenerating(value),
      getInputHtml: () => controller.inputPanel.getInputHtml(),
      setInputHtml: (value) => controller.inputPanel.setInputHtml(value),
      getScrollTop: () => controller.messageList.getScrollTop(),
      setScrollTop: (value) => controller.messageList.setScrollTop(value),
      scrollToBottom: (force) => controller.messageList.scrollToBottom(force),
      onDraftChanged: (handler) => {
        const listener = (event: { html: string }) => handler(event.html);
        controller.getEventBus().on("draftChanged", listener);
        return {
          dispose: () => controller.getEventBus().off("draftChanged", listener),
        };
      },
      getWebviewState: () => controller.getWebviewState(),
      saveWebviewState: (state) => controller.saveWebviewState(state),
    }
  );
}
