import type {
  MultiSessionListItem,
  MultiSessionManagerStateMessage,
  MultiSessionStatus,
} from "./contracts";
import { MANAGER_STYLES } from "./manager-styles";

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

export class MultiSessionManagerWebview {
  private readonly vscode = acquireVsCodeApi();
  private readonly sessions = new Map<string, MultiSessionListItem>();
  private activeLocalSessionId: string | undefined;
  private aggregate = { open: 0, running: 0, awaitingPermission: 0, unread: 0 };
  private filter = "all";
  private query = "";
  private summaryEl!: HTMLElement;
  private listEl!: HTMLElement;
  private filterEl!: HTMLSelectElement;
  private searchEl!: HTMLInputElement;

  constructor(private readonly doc: Document) {
    this.injectStyles();
    this.renderShell();
    this.bindHostMessages();
    this.vscode.postMessage({ type: "feature.multi-session.managerReady" });
  }

  private injectStyles(): void {
    const style = this.doc.createElement("style");
    style.textContent = MANAGER_STYLES;
    this.doc.head.append(style);
  }

  private renderShell(): void {
    this.doc.body.innerHTML = `<main class="manager-shell"><header class="manager-header"><div class="manager-title"><h1>ACP Sessions</h1><div class="manager-summary" aria-live="polite"></div></div><div class="manager-actions"><button type="button" class="manager-button manager-button-primary" data-action="new"><span class="codicon codicon-add"></span>New</button><button type="button" class="manager-button manager-button-secondary" data-action="refresh"><span class="codicon codicon-refresh"></span>Refresh</button></div></header><section class="manager-filters" aria-label="Session filters"><select class="manager-select" aria-label="Status filter"><option value="all">All</option><option value="running">Running</option><option value="awaiting_permission">Waiting</option><option value="idle">Idle</option><option value="draft">Draft</option><option value="error">Error</option></select><input class="manager-search" type="search" placeholder="Search title, agent, status, session id…" aria-label="Search sessions"></section><section class="manager-list" role="list" aria-label="ACP sessions"></section></main>`;
    this.summaryEl = this.doc.querySelector(".manager-summary") as HTMLElement;
    this.listEl = this.doc.querySelector(".manager-list") as HTMLElement;
    this.filterEl = this.doc.querySelector(".manager-select") as HTMLSelectElement;
    this.searchEl = this.doc.querySelector(".manager-search") as HTMLInputElement;

    this.doc
      .querySelector('[data-action="new"]')
      ?.addEventListener("click", () =>
        this.vscode.postMessage({
          type: "feature.multi-session.new",
          focusChat: true,
        })
      );
    this.doc
      .querySelector('[data-action="refresh"]')
      ?.addEventListener("click", () =>
        this.vscode.postMessage({ type: "feature.multi-session.managerResync" })
      );
    this.filterEl.addEventListener("change", () => {
      this.filter = this.filterEl.value;
      this.renderList();
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.renderList();
    });
  }

  private bindHostMessages(): void {
    this.doc.defaultView?.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as { type?: string };
      if (message.type === "feature.multi-session.managerState") {
        this.applyState(message as MultiSessionManagerStateMessage);
      }
    });
  }

  private applyState(message: MultiSessionManagerStateMessage): void {
    this.sessions.clear();
    for (const session of message.sessions) {
      this.sessions.set(session.localSessionId, session);
    }
    this.activeLocalSessionId = message.activeLocalSessionId;
    this.aggregate = message.aggregate;
    this.renderSummary();
    this.renderList();
  }

  private renderSummary(): void {
    this.summaryEl.textContent = `Running ${this.aggregate.running} · Waiting ${this.aggregate.awaitingPermission} · Unread ${this.aggregate.unread} · Open ${this.aggregate.open}`;
  }

  private renderList(): void {
    const sessions = [...this.sessions.values()]
      .filter((session) => this.matchesFilter(session))
      .sort(compareSessions);
    this.listEl.querySelector(".manager-empty")?.remove();
    if (sessions.length === 0) {
      this.listEl.replaceChildren();
      const empty = this.doc.createElement("div");
      empty.className = "manager-empty";
      empty.textContent = this.sessions.size
        ? "No sessions match the current filter."
        : "No open sessions.";
      this.listEl.append(empty);
      return;
    }

    const visibleIds = new Set(sessions.map((session) => session.localSessionId));
    for (const row of [...this.listEl.querySelectorAll<HTMLElement>(".session-row")]) {
      if (!row.dataset.sessionId || !visibleIds.has(row.dataset.sessionId)) {
        row.remove();
      }
    }

    for (const session of sessions) {
      const signature = rowSignature(session, this.activeLocalSessionId);
      const existing = this.listEl.querySelector<HTMLElement>(
        `.session-row[data-session-id="${cssEscape(session.localSessionId)}"]`
      );
      let row = existing;
      if (!row || row.dataset.signature !== signature) {
        row = this.createRow(session);
        row.dataset.signature = signature;
        existing?.replaceWith(row);
      }
      this.listEl.append(row);
    }
  }

  private matchesFilter(session: MultiSessionListItem): boolean {
    if (this.filter === "running" && !isRunningStatus(session.status)) return false;
    if (
      this.filter !== "all" &&
      this.filter !== "running" &&
      session.status !== this.filter
    ) {
      return false;
    }
    if (!this.query) return true;
    const haystack = [
      session.title,
      session.agentName,
      session.agentId,
      session.status,
      session.acpSessionId,
      session.localSessionId,
      session.lastError,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(this.query);
  }

  private createRow(session: MultiSessionListItem): HTMLElement {
    const row = this.doc.createElement("article");
    const isActive = session.localSessionId === this.activeLocalSessionId;
    row.className = `session-row status-${session.status}`;
    row.classList.toggle("active", isActive);
    row.dataset.sessionId = session.localSessionId;
    row.setAttribute("role", "listitem");

    const main = this.doc.createElement("div");
    main.className = "row-main";
    main.append(statusIcon(this.doc, session.status), this.createContent(session, isActive));

    const actions = this.doc.createElement("div");
    actions.className = "row-actions";
    if (session.pendingPermissionCount > 0) {
      actions.append(
        this.button("Review", "secondary", () =>
          this.vscode.postMessage({
            type: "feature.multi-session.reviewPermission",
            localSessionId: session.localSessionId,
            focusChat: true,
          })
        )
      );
    }
    actions.append(
      this.button("Open Chat", "primary", () =>
        this.vscode.postMessage({
          type: "feature.multi-session.activate",
          localSessionId: session.localSessionId,
          focusChat: true,
        })
      )
    );
    if (isStoppableStatus(session.status)) {
      actions.append(
        this.button("Stop", "danger", () =>
          this.vscode.postMessage({
            type: "feature.multi-session.stop",
            localSessionId: session.localSessionId,
          })
        )
      );
    } else {
      actions.append(
        this.button("Close", "secondary", () =>
          this.vscode.postMessage({
            type: "feature.multi-session.close",
            localSessionId: session.localSessionId,
          })
        )
      );
    }

    row.append(main, actions);
    return row;
  }

  private createContent(
    session: MultiSessionListItem,
    isActive: boolean
  ): HTMLElement {
    const content = this.doc.createElement("div");
    content.className = "row-content";

    const titleLine = this.doc.createElement("div");
    titleLine.className = "row-title-line";
    const title = this.doc.createElement("div");
    title.className = "row-title";
    title.textContent = session.title;
    titleLine.append(title);
    if (isActive) {
      const active = this.doc.createElement("span");
      active.className = "active-pill";
      active.textContent = "Active";
      titleLine.append(active);
    }

    const meta = this.doc.createElement("div");
    meta.className = "row-meta";
    meta.textContent = buildSessionMeta(session);
    meta.title = meta.textContent;

    const badges = this.createBadges(session);
    content.append(titleLine, meta);
    if (session.acpSessionId) {
      const id = this.doc.createElement("div");
      id.className = "row-path";
      id.textContent = session.acpSessionId;
      id.title = session.acpSessionId;
      content.append(id);
    }
    if (badges.childElementCount > 0) content.append(badges);
    if (session.lastError) {
      const error = this.doc.createElement("div");
      error.className = "row-path";
      error.textContent = session.lastError;
      error.title = session.lastError;
      content.append(error);
    }
    return content;
  }

  private createBadges(session: MultiSessionListItem): HTMLElement {
    const badges = this.doc.createElement("div");
    badges.className = "badges";
    if (session.pendingPermissionCount > 0) {
      badges.append(badge(this.doc, `${session.pendingPermissionCount} permission`, "permission"));
    }
    if (session.unreadCount > 0) {
      badges.append(badge(this.doc, `${session.unreadCount} unread`, "unread"));
    }
    if (session.diffCount > 0) {
      badges.append(badge(this.doc, `${session.diffCount} diff`, "diff"));
    }
    if (session.conflictedDiffCount > 0) {
      badges.append(badge(this.doc, `${session.conflictedDiffCount} conflicted`, "diff"));
    }
    return badges;
  }

  private button(
    label: string,
    variant: "primary" | "secondary" | "danger",
    onClick: () => void
  ): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = `manager-button manager-button-${variant}`;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }
}

function statusIcon(doc: Document, status: MultiSessionStatus): HTMLElement {
  const icon = doc.createElement("span");
  icon.className = `status-icon status-${status}`;
  icon.setAttribute("aria-hidden", "true");
  if (isRunningStatus(status)) {
    icon.classList.add("codicon", "codicon-loading", "codicon-modifier-spin");
  } else if (status === "awaiting_permission") {
    icon.classList.add("codicon", "codicon-warning");
  } else if (status === "error") {
    icon.classList.add("codicon", "codicon-error");
  } else {
    icon.classList.add(
      "codicon",
      status === "draft" ? "codicon-circle-large-outline" : "codicon-circle-filled"
    );
  }
  return icon;
}

function badge(doc: Document, text: string, tone: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = `badge badge-${tone}`;
  el.textContent = text;
  return el;
}

function buildSessionMeta(session: MultiSessionListItem): string {
  return [formatStatus(session.status), session.agentName]
    .filter(Boolean)
    .join(" · ");
}

function rowSignature(
  session: MultiSessionListItem,
  activeLocalSessionId: string | undefined
): string {
  return JSON.stringify({
    session,
    active: session.localSessionId === activeLocalSessionId,
  });
}

function cssEscape(value: string): string {
  const escapeFn = globalThis.CSS?.escape;
  if (escapeFn) return escapeFn(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function compareSessions(
  a: MultiSessionListItem,
  b: MultiSessionListItem
): number {
  const rank = (s: MultiSessionListItem) =>
    s.pendingPermissionCount > 0
      ? 0
      : isRunningStatus(s.status)
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

function isStoppableStatus(status: string): boolean {
  return isRunningStatus(status) || status === "awaiting_permission";
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

if (typeof document !== "undefined") {
  new MultiSessionManagerWebview(document);
}
