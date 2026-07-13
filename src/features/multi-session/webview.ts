import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage, VsCodeApi } from "../../views/webview/types";
import type {
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
}

export class MultiSessionWebviewController {
  private header: HTMLElement;
  private overlay: HTMLElement;
  private loading: HTMLElement;
  private title: HTMLElement;
  private status: HTMLElement;
  private sessionsButton: HTMLButtonElement;
  private activeLocalSessionId: string | undefined;
  private activationRevision = 0;
  private sessions: MultiSessionListItem[] = [];
  private lastSeqBySession: Record<string, number> = {};
  private drafts: Record<string, string> = {};
  private scrollTop: Record<string, number> = {};
  private managerOpen = false;

  constructor(
    private readonly vscode: VsCodeApi,
    private readonly doc: Document,
    private readonly bridge: ChatSurfaceBridge
  ) {
    this.restoreState();
    this.header = this.createHeader();
    this.overlay = this.createOverlay();
    this.loading = this.createLoading();
    this.title = this.header.querySelector(
      ".multi-session-title"
    ) as HTMLElement;
    this.status = this.header.querySelector(
      ".multi-session-status"
    ) as HTMLElement;
    this.sessionsButton = this.header.querySelector(
      ".multi-session-open"
    ) as HTMLButtonElement;
    // The host owns the feature flag. Keep the feature UI hidden until the
    // initial state handshake confirms that multi-session is enabled.
    this.header.hidden = true;
    this.overlay.hidden = true;
    this.loading.hidden = true;
    this.doc.body.prepend(this.header, this.loading, this.overlay);
    this.injectStyles();
  }

  handleMessage(
    msg: ExtensionMessage
  ): boolean | void | Promise<boolean | void> {
    if (msg.type === "feature.multi-session.state") {
      this.applyState(msg as MultiSessionStateMessage);
      return true;
    }
    if (msg.type === "feature.multi-session.snapshot") {
      return this.applySnapshot(msg as MultiSessionSnapshot).then(() => true);
    }
    if (msg.type === "feature.multi-session.delta") {
      return this.applyDelta(msg as MultiSessionDeltaMessage).then(() => true);
    }
    if (msg.type === "feature.multi-session.openManager") {
      this.setManagerOpen(true);
      return true;
    }
    return;
  }

  beforeSend(): void {
    this.saveActiveSurfaceState();
  }

  private applyState(msg: MultiSessionStateMessage): void {
    if (!msg.enabled) {
      this.header.hidden = true;
      this.overlay.hidden = true;
      this.loading.hidden = true;
      return;
    }
    this.header.hidden = false;
    this.managerOpen = msg.managerOpen ?? false;
    this.overlay.hidden = !this.managerOpen;
    this.sessions = msg.sessions;
    if (msg.activeLocalSessionId) {
      this.activeLocalSessionId = msg.activeLocalSessionId;
      this.activationRevision = msg.activationRevision;
    }
    this.renderHeader(msg.aggregate.running, msg.aggregate.awaitingPermission);
    this.renderOverlay();
    this.renderLoading();
    this.persistState();
  }

  private async applySnapshot(msg: MultiSessionSnapshot): Promise<void> {
    const previousSessionId = this.activeLocalSessionId;
    if (previousSessionId && previousSessionId !== msg.activeLocalSessionId) {
      this.saveActiveSurfaceState();
    }
    this.activeLocalSessionId = msg.activeLocalSessionId;
    this.activationRevision = msg.activationRevision;
    this.upsertSession(msg.session);
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
    this.renderHeader();
    this.renderOverlay();
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

  private renderHeader(running?: number, permission?: number): void {
    const active = this.getActiveSession();
    this.title.textContent = active?.title ?? "Untitled chat";
    this.status.textContent = active ? formatStatus(active.status) : "Draft";
    this.status.classList.toggle(
      "busy",
      Boolean(active && isRunningStatus(active.status))
    );
    const count = this.sessions.length;
    const suffix = permission
      ? ` • !${permission}`
      : running
        ? ` • ${running} running`
        : "";
    this.sessionsButton.textContent = `Sessions ${count}${suffix}`;
  }

  private renderOverlay(): void {
    const list = this.overlay.querySelector(
      ".multi-session-list"
    ) as HTMLElement;
    list.innerHTML = "";
    const ordered = [...this.sessions].sort(compareSessions);
    for (const session of ordered) {
      const item = this.doc.createElement("div");
      item.className = "multi-session-item";
      if (isRunningStatus(session.status)) {
        item.classList.add("busy");
      }
      if (session.localSessionId === this.activeLocalSessionId) {
        item.classList.add("active");
      }
      const meta = [formatStatus(session.status), session.agentName];
      if (session.unreadCount > 0) meta.push(`${session.unreadCount} unread`);
      if (session.pendingPermissionCount > 0) meta.push("needs permission");
      if (session.diffCount > 0) meta.push(`${session.diffCount} diffs`);
      item.innerHTML = `<div class="multi-session-item-main"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(meta.join(" • "))}</span></div>`;
      const actions = this.doc.createElement("div");
      actions.className = "multi-session-actions";
      actions.append(
        button(
          this.doc,
          session.localSessionId === this.activeLocalSessionId
            ? "Active"
            : "Open",
          () => {
            this.saveActiveSurfaceState();
            this.vscode.postMessage({
              type: "feature.multi-session.activate",
              localSessionId: session.localSessionId,
            });
            this.setManagerOpen(false);
          },
          session.localSessionId === this.activeLocalSessionId
        ),
        ...(isRunningStatus(session.status)
          ? [
              button(this.doc, "Stop", () =>
                this.vscode.postMessage({
                  type: "feature.multi-session.stop",
                  localSessionId: session.localSessionId,
                })
              ),
            ]
          : []),
        ...(session.pendingPermissionCount > 0
          ? [
              button(this.doc, "Review", () => {
                this.saveActiveSurfaceState();
                this.vscode.postMessage({
                  type: "feature.multi-session.reviewPermission",
                  localSessionId: session.localSessionId,
                });
                this.setManagerOpen(false);
              }),
            ]
          : []),
        button(this.doc, "Close", () =>
          this.vscode.postMessage({
            type: "feature.multi-session.close",
            localSessionId: session.localSessionId,
          })
        )
      );
      item.append(actions);
      item.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).tagName === "BUTTON") return;
        this.saveActiveSurfaceState();
        this.vscode.postMessage({
          type: "feature.multi-session.activate",
          localSessionId: session.localSessionId,
        });
        this.setManagerOpen(false);
      });
      list.append(item);
    }
  }

  private createHeader(): HTMLElement {
    const header = this.doc.createElement("div");
    header.className = "multi-session-header";
    header.innerHTML = `<button class="multi-session-open"></button><div class="multi-session-heading"><strong class="multi-session-title"></strong><span class="multi-session-status"></span></div><button class="multi-session-new">+ New chat</button>`;
    header
      .querySelector(".multi-session-open")
      ?.addEventListener("click", () => {
        this.setManagerOpen(true);
        this.vscode.postMessage({ type: "feature.multi-session.manage" });
      });
    header
      .querySelector(".multi-session-new")
      ?.addEventListener("click", () => {
        this.saveActiveSurfaceState();
        this.vscode.postMessage({ type: "feature.multi-session.new" });
        this.setManagerOpen(false);
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

  private createOverlay(): HTMLElement {
    const overlay = this.doc.createElement("div");
    overlay.className = "multi-session-overlay";
    overlay.innerHTML = `<div class="multi-session-overlay-head"><strong>Sessions</strong><div><button class="multi-session-new-overlay">+ New chat</button><button class="multi-session-close-overlay">Close</button></div></div><div class="multi-session-list"></div>`;
    overlay
      .querySelector(".multi-session-close-overlay")
      ?.addEventListener("click", () => {
        this.setManagerOpen(false);
        this.vscode.postMessage({ type: "feature.multi-session.hideManager" });
      });
    overlay
      .querySelector(".multi-session-new-overlay")
      ?.addEventListener("click", () => {
        this.saveActiveSurfaceState();
        this.vscode.postMessage({ type: "feature.multi-session.new" });
        this.setManagerOpen(false);
      });
    return overlay;
  }

  private setManagerOpen(open: boolean): void {
    this.managerOpen = open;
    this.overlay.hidden = !open;
    this.persistState();
  }

  private renderLoading(): void {
    const active = this.getActiveSession();
    const loading = Boolean(active && isSurfaceLoadingStatus(active.status));
    this.loading.hidden = !loading;
    if (!active || !loading) return;
    const text = this.loading.querySelector(
      ".multi-session-loading-text"
    ) as HTMLElement;
    text.textContent = loadingText(active.status, active.agentName);
  }

  private getActiveSession(): MultiSessionListItem | undefined {
    return this.sessions.find(
      (session) => session.localSessionId === this.activeLocalSessionId
    );
  }

  private upsertSession(session: MultiSessionListItem): void {
    const index = this.sessions.findIndex(
      (item) => item.localSessionId === session.localSessionId
    );
    if (index >= 0) {
      this.sessions[index] = session;
    } else {
      this.sessions.push(session);
    }
  }

  private restoreState(): void {
    const state = this.vscode.getState<MultiSessionWebviewState>();
    this.drafts = state?.multiSession?.drafts ?? {};
    this.scrollTop = state?.multiSession?.scrollTop ?? {};
    this.activeLocalSessionId = state?.multiSession?.activeLocalSessionId;
  }

  private persistState(): void {
    const existingState = this.vscode.getState<MultiSessionWebviewState>();
    const normalizedState: MultiSessionWebviewState = {
      ...(existingState ?? { isConnected: false, inputValue: "" }),
      isConnected: existingState?.isConnected ?? false,
      inputValue: existingState?.inputValue ?? "",
    };
    this.vscode.setState({
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

function button(
  doc: Document,
  label: string,
  onClick: () => void,
  disabled = false
): HTMLButtonElement {
  const el = doc.createElement("button");
  el.textContent = label;
  el.disabled = disabled;
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return el;
}

function compareSessions(
  a: MultiSessionListItem,
  b: MultiSessionListItem
): number {
  const rank = (s: MultiSessionListItem) =>
    s.pendingPermissionCount > 0
      ? 0
      : s.status === "running" || s.status === "starting"
        ? 1
        : s.status === "draft"
          ? 2
          : 3;
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch
  );
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
    }
  );
}
