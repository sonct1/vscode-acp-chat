import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage, VsCodeApi } from "../../views/webview/types";
import type {
  MultiSessionChatStateMessage,
  MultiSessionDeltaMessage,
  MultiSessionFocusInputCommitMessage,
  MultiSessionFocusInputMessage,
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
  beginSurfaceReplacement?(): number;
  finishSurfaceReplacement?(generation: number, committed: boolean): void;
  setSurfaceInteractionLocked?(value: boolean): void;
  focusInput?(): boolean;
  getFocusInputProof?(): {
    documentHasFocus: boolean;
    activeInput: boolean;
    caret: boolean;
  };
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
  awaitingInput: number;
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
    awaitingInput: 0,
  };
  private lastSeqBySession: Record<string, number> = {};
  private drafts: Record<string, string> = {};
  private scrollTop: Record<string, number> = {};
  private optimisticLoadingText: string | undefined;
  private snapshotReplay: SnapshotReplay | undefined;
  private pendingFocusInput: MultiSessionFocusInputMessage | undefined;
  private focusInputArmedRequestId: string | undefined;
  private focusInputCommitRequestId: string | undefined;
  private surfaceReplacementGeneration: number | undefined;
  private surfaceRecoveryPending = false;
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
    this.doc.defaultView?.addEventListener("focus", () =>
      this.commitPendingFocusInput()
    );
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
    if (msg.type === "feature.multi-session.focusInput") {
      this.requestFocusInput(msg as MultiSessionFocusInputMessage);
      return true;
    }
    if (msg.type === "feature.multi-session.focusInputCommit") {
      this.receiveFocusInputCommit(msg as MultiSessionFocusInputCommitMessage);
      return true;
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
        awaitingInput: msg.aggregate.awaitingInput,
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
      this.clearStaleFocusInput(
        msg.activeLocalSessionId,
        msg.activationRevision
      );
      this.startSurfaceReplacement();
      this.showOptimisticLoading("Opening chat…");
      this.bridge.setSurfaceInteractionLocked?.(true);
    } else if (!this.surfaceRecoveryPending) {
      this.clearOptimisticLoadingIfSettled();
    }
    this.renderHeader();
    this.renderLoading();
    if (activeChanged) {
      this.persistState();
    }
  }

  private async applySnapshot(msg: MultiSessionSnapshot): Promise<void> {
    if (
      !this.isCurrentTarget(msg.activeLocalSessionId, msg.activationRevision)
    ) {
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
    const surfaceReplacementGeneration = this.startSurfaceReplacement(false);
    await this.yieldToBrowser();

    let snapshotReplayStarted = false;
    let snapshotCommitted = false;
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
      await this.bridge.dispatch({
        type: "feature.acp-elicitation.show",
        ownerId: msg.activeLocalSessionId,
        pendingElicitations: msg.pendingElicitations ?? [],
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
      this.lastSeqBySession[msg.activeLocalSessionId] = msg.lastSeq;
      this.surfaceRecoveryPending = false;
      snapshotCommitted = true;
      this.renderedLocalSessionId = msg.activeLocalSessionId;

      this.renderHeader();
      this.persistState();
      this.hasRenderedSnapshot = true;
    } catch (error) {
      if (
        this.isCurrentTarget(msg.activeLocalSessionId, msg.activationRevision)
      ) {
        this.surfaceRecoveryPending = true;
        this.showOptimisticLoading("Reloading chat…");
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
      if (
        snapshotCommitted &&
        this.isCurrentTarget(msg.activeLocalSessionId, msg.activationRevision)
      ) {
        const catchUpSucceeded = await this.applyPendingDeltas(replay);
        if (catchUpSucceeded) {
          this.finishSurfaceReplacement(surfaceReplacementGeneration, true);
          this.clearOptimisticLoadingIfSettled();
          this.renderLoading();
          this.bridge.setSurfaceInteractionLocked?.(false);
          this.flushPendingFocusInput();
        } else {
          this.finishSurfaceReplacement(surfaceReplacementGeneration, false);
        }
      } else {
        this.finishSurfaceReplacement(surfaceReplacementGeneration, false);
      }
    }
  }

  private async applyPendingDeltas(replay: SnapshotReplay): Promise<boolean> {
    for (const delta of replay.pendingDeltas.sort(
      (a, b) => a.event.seq - b.event.seq
    )) {
      if (!(await this.applyDelta(delta))) return false;
    }
    replay.pendingDeltas = [];
    return true;
  }

  private async applyDelta(msg: MultiSessionDeltaMessage): Promise<boolean> {
    if (this.surfaceRecoveryPending) return false;
    if (
      msg.localSessionId !== this.activeLocalSessionId ||
      msg.activationRevision !== this.activationRevision
    ) {
      return false;
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
      return true;
    }

    const lastSeq = this.lastSeqBySession[msg.localSessionId] ?? 0;
    if (msg.event.seq <= lastSeq) return true;
    if (msg.event.seq !== lastSeq + 1) {
      this.enterSurfaceRecovery();
      return false;
    }
    try {
      await this.bridge.dispatch(msg.event.message as ExtensionMessage);
      this.lastSeqBySession[msg.localSessionId] = msg.event.seq;
      return true;
    } catch (error) {
      this.enterSurfaceRecovery();
      console.error("[MultiSession] Failed to apply transcript delta:", error);
      return false;
    }
  }

  private enterSurfaceRecovery(): void {
    if (this.surfaceRecoveryPending) return;
    this.surfaceRecoveryPending = true;
    this.startSurfaceReplacement();
    this.showOptimisticLoading("Reloading chat…");
    this.bridge.setSurfaceInteractionLocked?.(true);
    this.vscode.postMessage({ type: "feature.multi-session.resync" });
  }

  private requestFocusInput(message: MultiSessionFocusInputMessage): void {
    if (
      this.targetActivationRevision > 0 &&
      message.activationRevision < this.targetActivationRevision
    ) {
      return;
    }
    this.pendingFocusInput = message;
    this.focusInputArmedRequestId = undefined;
    this.focusInputCommitRequestId = undefined;
    this.armPendingFocusInput();
  }

  private receiveFocusInputCommit(
    message: MultiSessionFocusInputCommitMessage
  ): void {
    const pending = this.pendingFocusInput;
    if (!pending || !this.matchesFocusInput(message, pending)) return;
    this.focusInputCommitRequestId = message.requestId;
    this.commitPendingFocusInput();
  }

  private clearStaleFocusInput(
    localSessionId: string,
    activationRevision: number
  ): void {
    const intent = this.pendingFocusInput;
    if (!intent) return;
    if (
      intent.localSessionId !== localSessionId ||
      intent.activationRevision !== activationRevision
    ) {
      this.pendingFocusInput = undefined;
      this.focusInputArmedRequestId = undefined;
      this.focusInputCommitRequestId = undefined;
    }
  }

  private flushPendingFocusInput(): void {
    this.armPendingFocusInput();
  }

  private armPendingFocusInput(): void {
    const intent = this.pendingFocusInput;
    if (!this.isPendingFocusInputReady(intent)) return;
    if (this.focusInputArmedRequestId === intent.requestId) return;
    this.focusInputArmedRequestId = intent.requestId;
    this.vscode.postMessage({
      type: "feature.multi-session.focusInputArmed",
      requestId: intent.requestId,
      localSessionId: intent.localSessionId,
      activationRevision: intent.activationRevision,
    });
  }

  private commitPendingFocusInput(): void {
    const intent = this.pendingFocusInput;
    if (!this.isPendingFocusInputReady(intent)) return;
    if (this.focusInputCommitRequestId !== intent.requestId) return;
    const focused = this.bridge.focusInput?.() === true;
    const proof = this.bridge.getFocusInputProof?.();
    this.vscode.postMessage({
      type: "feature.multi-session.focusInputAck",
      requestId: intent.requestId,
      localSessionId: intent.localSessionId,
      activationRevision: intent.activationRevision,
      proof,
    });
    if (!focused) return;
    this.pendingFocusInput = undefined;
    this.focusInputArmedRequestId = undefined;
    this.focusInputCommitRequestId = undefined;
  }

  private isPendingFocusInputReady(
    intent: MultiSessionFocusInputMessage | undefined
  ): intent is MultiSessionFocusInputMessage {
    return Boolean(
      intent &&
        !this.snapshotReplay &&
        intent.localSessionId === this.renderedLocalSessionId &&
        intent.activationRevision === this.activationRevision
    );
  }

  private matchesFocusInput(
    message: MultiSessionFocusInputCommitMessage,
    pending: MultiSessionFocusInputMessage
  ): boolean {
    return (
      message.requestId === pending.requestId &&
      message.localSessionId === pending.localSessionId &&
      message.activationRevision === pending.activationRevision
    );
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

  private startSurfaceReplacement(restart = true): number | undefined {
    if (!restart && this.surfaceReplacementGeneration !== undefined) {
      return this.surfaceReplacementGeneration;
    }
    if (this.surfaceReplacementGeneration !== undefined) {
      this.bridge.finishSurfaceReplacement?.(
        this.surfaceReplacementGeneration,
        false
      );
    }
    this.surfaceReplacementGeneration =
      this.bridge.beginSurfaceReplacement?.();
    return this.surfaceReplacementGeneration;
  }

  private finishSurfaceReplacement(
    generation: number | undefined,
    committed: boolean
  ): void {
    if (
      generation === undefined ||
      generation !== this.surfaceReplacementGeneration
    ) {
      return;
    }
    this.bridge.finishSurfaceReplacement?.(generation, committed);
    this.surfaceReplacementGeneration = undefined;
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
    if (this.surfaceRecoveryPending || !this.optimisticLoadingText) return;
    const active = this.active;
    if (!active) return;
    if (
      active.lastError ||
      active.status === "draft" ||
      active.status === "idle" ||
      active.status === "running" ||
      active.status === "awaiting_input" ||
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
      beginSurfaceReplacement: () => controller.beginChatSurfaceReplacement(),
      finishSurfaceReplacement: (generation, committed) =>
        controller.finishChatSurfaceReplacement(generation, committed),
      setSurfaceInteractionLocked: (value) =>
        controller.setSessionTransitionLocked(value),
      focusInput: () => controller.inputPanel.focusWithCaret(),
      getFocusInputProof: () => controller.inputPanel.getFocusProof(),
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
