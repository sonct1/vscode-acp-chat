import type { WebviewController } from "../../views/webview/main";
import type { ExtensionMessage, VsCodeApi } from "../../views/webview/types";
import type {
  MultiSessionAgentOption,
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

export class MultiSessionWebviewController {
  private header: HTMLElement;
  private overlay: HTMLElement;
  private loading: HTMLElement;
  private title: HTMLElement;
  private status: HTMLElement;
  private sessionsButton: HTMLButtonElement;
  private agentIdentity: HTMLElement;
  private previousFocus: HTMLElement | undefined;
  private activeLocalSessionId: string | undefined;
  private activationRevision = 0;
  private sessions: MultiSessionListItem[] = [];
  private agents: MultiSessionAgentOption[] = [];
  private selectedAgentId: string | undefined;
  private lastSeqBySession: Record<string, number> = {};
  private drafts: Record<string, string> = {};
  private scrollTop: Record<string, number> = {};
  private managerOpen = false;
  private optimisticLoadingText: string | undefined;

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
    this.agentIdentity = this.overlay.querySelector(
      ".multi-session-agent-current"
    ) as HTMLElement;
    // The host owns the feature flag. Keep the feature UI hidden until the
    // initial state handshake confirms that multi-session is enabled.
    this.header.hidden = true;
    this.overlay.hidden = true;
    this.loading.hidden = true;
    this.doc.body.prepend(this.header, this.loading, this.overlay);
    this.syncManagerVisibility();
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
    const sessionId = this.activeLocalSessionId;
    if (!sessionId) return;

    // Sent input is no longer a draft; otherwise later snapshots restore it.
    delete this.drafts[sessionId];
    this.scrollTop[sessionId] = this.bridge.getScrollTop();
    this.persistState({ inputValue: "" });
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
    this.syncManagerVisibility();
    this.sessions = msg.sessions;
    this.agents = msg.agents ?? this.agents;
    this.selectedAgentId = msg.selectedAgentId ?? this.selectedAgentId;
    if (msg.activeLocalSessionId) {
      this.activeLocalSessionId = msg.activeLocalSessionId;
      this.activationRevision = msg.activationRevision;
    }
    this.clearOptimisticLoadingIfSettled();
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
    this.clearOptimisticLoadingIfSettled();
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
    const runningCount = running ?? countSessions(this.sessions, isRunningStatus);
    const permissionCount =
      permission ??
      this.sessions.filter((session) => session.pendingPermissionCount > 0)
        .length;

    this.title.textContent = active?.title ?? "Untitled chat";
    this.status.textContent = active
      ? `${formatStatus(active.status)} · ${active.agentName}`
      : "Draft";
    setStatusClasses(this.status, active?.status);
    this.status.classList.toggle(
      "busy",
      Boolean(active && isRunningStatus(active.status))
    );

    const count = this.sessions.length;
    const attentionLabel = permissionCount
      ? `!${permissionCount}`
      : runningCount
        ? `${runningCount}`
        : "";
    this.sessionsButton.innerHTML = `<span class="codicon codicon-arrow-left" aria-hidden="true"></span>${attentionLabel ? `<span class="multi-session-open-badge${permissionCount ? " permission" : ""}">${attentionLabel}</span>` : ""}`;
    this.sessionsButton.setAttribute(
      "aria-label",
      describeSessionManagerButton(count, runningCount, permissionCount)
    );
    this.sessionsButton.classList.toggle(
      "has-attention",
      permissionCount > 0 || runningCount > 0
    );
  }

  private renderOverlay(): void {
    const list = this.overlay.querySelector(
      ".multi-session-list"
    ) as HTMLElement;
    list.innerHTML = "";
    list.setAttribute("role", "list");

    this.renderAgentIdentity();

    const ordered = [...this.sessions].sort(compareSessions);
    for (const session of ordered) {
      const isActive = session.localSessionId === this.activeLocalSessionId;
      const item = this.doc.createElement("div");
      item.className = `multi-session-item multi-session-status-${session.status}`;
      item.setAttribute("role", "listitem");
      item.dataset.sessionId = session.localSessionId;
      item.classList.toggle("busy", isRunningStatus(session.status));
      item.classList.toggle("active", isActive);

      item.append(this.createSessionMainAction(session, isActive));
      const actions = this.doc.createElement("div");
      actions.className = "multi-session-actions";

      if (session.pendingPermissionCount > 0) {
        actions.append(
          button(
            this.doc,
            "Review",
            () => {
              this.saveActiveSurfaceState();
              this.vscode.postMessage({
                type: "feature.multi-session.reviewPermission",
                localSessionId: session.localSessionId,
              });
              this.setManagerOpen(false);
            },
            {
              variant: "secondary",
              ariaLabel: `Review permission for session ${session.title}`,
            }
          )
        );
      }

      if (isRunningStatus(session.status)) {
        actions.append(
          button(
            this.doc,
            "Stop",
            () =>
              this.vscode.postMessage({
                type: "feature.multi-session.stop",
                localSessionId: session.localSessionId,
              }),
            {
              variant: "danger",
              ariaLabel: `Stop session ${session.title}`,
            }
          )
        );
      }

      actions.append(
        button(
          this.doc,
          "Close",
          () =>
            this.vscode.postMessage({
              type: "feature.multi-session.close",
              localSessionId: session.localSessionId,
            }),
          {
            variant: "ghost",
            ariaLabel: `Close session ${session.title}`,
            icon: "codicon-close",
            iconOnly: true,
          }
        )
      );

      item.append(actions);
      item.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        this.activateSession(session);
      });
      list.append(item);
    }
  }

  private createHeader(): HTMLElement {
    const header = this.doc.createElement("div");
    header.className = "multi-session-header";
    header.innerHTML = `<button type="button" class="multi-session-open multi-session-button multi-session-button-ghost"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button><div class="multi-session-heading"><strong class="multi-session-title"></strong><span class="multi-session-status"></span></div>`;
    header
      .querySelector(".multi-session-open")
      ?.addEventListener("click", () => {
        this.setManagerOpen(true);
        this.vscode.postMessage({ type: "feature.multi-session.manage" });
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
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Session manager");
    overlay.setAttribute("aria-modal", "true");
    overlay.tabIndex = -1;
    overlay.innerHTML = `<div class="multi-session-overlay-head"><div><strong>Sessions</strong><span class="multi-session-overlay-subtitle">Open chats in this workspace</span></div><div class="multi-session-overlay-actions"><span class="multi-session-agent-current" aria-label="Selected agent"></span></div></div><div class="multi-session-list"></div>`;
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        this.trapOverlayFocus(event);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.setManagerOpen(false);
      this.vscode.postMessage({ type: "feature.multi-session.hideManager" });
    });
    return overlay;
  }

  private setManagerOpen(open: boolean): void {
    this.managerOpen = open;
    this.syncManagerVisibility();
    this.persistState();
  }

  private syncManagerVisibility(): void {
    const wasOpen = !this.overlay.hidden;
    const isOpening = this.managerOpen && !wasOpen;
    const isClosing = !this.managerOpen && wasOpen;

    if (isOpening) {
      const activeElement = this.doc.activeElement;
      const HTMLElementCtor = this.doc.defaultView?.HTMLElement;
      this.previousFocus =
        HTMLElementCtor &&
        activeElement instanceof HTMLElementCtor &&
        activeElement !== this.overlay
          ? activeElement
          : undefined;
    }

    this.overlay.hidden = !this.managerOpen;
    this.overlay.setAttribute("aria-hidden", String(!this.managerOpen));

    if (isOpening) {
      this.focusFirstOverlayControl();
    } else if (isClosing) {
      this.restorePreviousFocus();
    }
  }

  private focusFirstOverlayControl(): void {
    this.overlay.focus();
  }

  private restorePreviousFocus(): void {
    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = undefined;
  }

  private trapOverlayFocus(event: KeyboardEvent): void {
    const focusable = getFocusableOverlayElements(this.overlay);
    if (focusable.length === 0) {
      event.preventDefault();
      this.overlay.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = this.doc.activeElement;

    if (event.shiftKey && (activeElement === first || activeElement === this.overlay)) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private renderAgentIdentity(): void {
    const agent = this.getSelectedAgent();
    this.agentIdentity.textContent = "";
    this.agentIdentity.hidden = !agent;
    if (!agent) return;

    this.agentIdentity.setAttribute(
      "aria-label",
      `Selected agent: ${agent.name}`
    );
    this.agentIdentity.title = agent.name;

    const icon = this.doc.createElement("span");
    icon.className = `codicon ${agentIconClass(agent.id)}`;
    icon.setAttribute("aria-hidden", "true");

    const name = this.doc.createElement("span");
    name.className = "multi-session-agent-name";
    name.textContent = agent.name;

    this.agentIdentity.append(icon, name);
  }

  private getSelectedAgent(): MultiSessionAgentOption | undefined {
    const selected = this.selectedAgentId
      ? this.agents.find((agent) => agent.id === this.selectedAgentId)
      : undefined;
    if (selected) return selected;

    const activeSession = this.sessions.find(
      (session) => session.localSessionId === this.activeLocalSessionId
    );
    if (activeSession) {
      return { id: activeSession.agentId, name: activeSession.agentName };
    }

    return this.agents[0];
  }

  private activateSession(session: MultiSessionListItem): void {
    this.saveActiveSurfaceState();
    this.vscode.postMessage({
      type: "feature.multi-session.activate",
      localSessionId: session.localSessionId,
    });
    this.setManagerOpen(false);
  }

  private createSessionMainAction(
    session: MultiSessionListItem,
    isActive: boolean
  ): HTMLButtonElement {
    const action = this.doc.createElement("button");
    action.type = "button";
    action.className = "multi-session-item-main";
    action.setAttribute(
      "aria-label",
      `${isActive ? "Current session" : "Open session"} ${session.title}. ${formatStatus(session.status)}. ${session.agentName}.`
    );
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activateSession(session);
    });

    const icon = statusIcon(this.doc, session.status);
    const content = this.doc.createElement("span");
    content.className = "multi-session-item-content";

    const title = this.doc.createElement("strong");
    title.textContent = session.title;
    const meta = this.doc.createElement("span");
    meta.className = "multi-session-item-meta";
    meta.textContent = buildSessionMeta(session);

    content.append(title, meta);
    action.append(icon, content, this.createSessionBadges(session));
    return action;
  }

  private createSessionBadges(session: MultiSessionListItem): HTMLElement {
    const badges = this.doc.createElement("span");
    badges.className = "multi-session-badges";
    if (session.pendingPermissionCount > 0) {
      badges.append(
        createBadge(
          this.doc,
          `${session.pendingPermissionCount} permission`,
          "permission"
        )
      );
    }
    if (session.unreadCount > 0) {
      badges.append(
        createBadge(this.doc, `${session.unreadCount} unread`, "unread")
      );
    }
    if (session.diffCount > 0) {
      badges.append(createBadge(this.doc, `${session.diffCount} diff`, "diff"));
    }
    return badges;
  }

  private showOptimisticLoading(text: string): void {
    this.optimisticLoadingText = text;
    this.renderLoading();
  }

  private renderLoading(): void {
    const active = this.getActiveSession();
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
    const active = this.getActiveSession();
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
    const state = this.bridge.getWebviewState();
    this.drafts = state?.multiSession?.drafts ?? {};
    this.scrollTop = state?.multiSession?.scrollTop ?? {};
    this.activeLocalSessionId = state?.multiSession?.activeLocalSessionId;
  }

  private persistState(overrides: Partial<MultiSessionWebviewState> = {}): void {
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

function getFocusableOverlayElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    "button:not(:disabled)",
    "[href]",
    "input:not(:disabled)",
    "select:not(:disabled)",
    "textarea:not(:disabled)",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hidden
  );
}

function button(
  doc: Document,
  label: string,
  onClick: () => void,
  options: {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    disabled?: boolean;
    ariaLabel?: string;
    icon?: string;
    iconOnly?: boolean;
  } = {}
): HTMLButtonElement {
  const el = doc.createElement("button");
  el.type = "button";
  el.disabled = Boolean(options.disabled);
  el.className = `multi-session-button multi-session-button-${options.variant ?? "secondary"}`;
  if (options.iconOnly) {
    el.classList.add("multi-session-button-icon");
  }
  if (options.icon) {
    const icon = doc.createElement("span");
    icon.className = `codicon ${options.icon}`;
    icon.setAttribute("aria-hidden", "true");
    el.append(icon);
    if (!options.iconOnly) {
      const text = doc.createElement("span");
      text.textContent = label;
      el.append(text);
    }
  } else {
    el.textContent = label;
  }
  if (options.ariaLabel) {
    el.setAttribute("aria-label", options.ariaLabel);
    if (options.iconOnly) {
      el.title = options.ariaLabel;
    }
  }
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return el;
}

function countSessions(
  sessions: MultiSessionListItem[],
  predicate: (status: string) => boolean
): number {
  return sessions.filter((session) => predicate(session.status)).length;
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

function describeSessionManagerButton(
  count: number,
  running: number,
  permission: number
): string {
  const parts = [`Back to session manager. ${count} ${plural(count, "session")}.`];
  if (running > 0) parts.push(`${running} ${plural(running, "session")} running.`);
  if (permission > 0) {
    parts.push(
      `${permission} ${plural(permission, "session")} needs permission.`
    );
  }
  return parts.join(" ");
}

function buildSessionMeta(session: MultiSessionListItem): string {
  return [formatStatus(session.status), session.agentName].join(" · ");
}

function agentIconClass(agentId: string): string {
  const iconByAgent: Record<string, string> = {
    opencode: "codicon-code",
    "claude-code": "codicon-sparkle",
    codex: "codicon-openai",
    gemini: "codicon-sparkle-filled",
    goose: "codicon-github-alt",
    amp: "codicon-zap",
    aider: "codicon-tools",
    augment: "codicon-copilot",
    kimi: "codicon-color-mode",
    "mistral-vibe": "codicon-flame",
    openhands: "codicon-hubot",
    "qwen-code": "codicon-symbol-color",
    kiro: "codicon-rocket",
    cursor: "codicon-cursor",
    codebuddy: "codicon-comment-discussion-sparkle",
  };
  return iconByAgent[agentId] ?? "codicon-agent";
}

function statusIcon(doc: Document, status: string): HTMLElement {
  const icon = doc.createElement("span");
  icon.className = `multi-session-status-icon multi-session-status-${status}`;
  icon.setAttribute("aria-hidden", "true");

  if (isRunningStatus(status)) {
    icon.classList.add("codicon", "codicon-loading", "codicon-modifier-spin");
    return icon;
  }

  if (status === "awaiting_permission") {
    icon.classList.add("codicon", "codicon-warning");
    return icon;
  }

  if (status === "error") {
    icon.classList.add("codicon", "codicon-error");
    return icon;
  }

  icon.classList.add(
    "codicon",
    status === "draft" ? "codicon-circle-large-outline" : "codicon-circle-filled"
  );
  return icon;
}

function createBadge(
  doc: Document,
  label: string,
  tone: "active" | "permission" | "unread" | "diff"
): HTMLElement {
  const badge = doc.createElement("span");
  badge.className = `multi-session-badge multi-session-badge-${tone}`;
  badge.textContent = label;
  return badge;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
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
