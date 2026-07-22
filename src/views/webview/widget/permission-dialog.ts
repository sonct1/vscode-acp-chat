import type { WebviewContext } from "../context";
import { BlockManager } from "../block/block-manager";
import type { PermissionView } from "../../../features/permission-ui/types";

type RenderedPermission = {
  ownerId: string;
  requestId: string;
  element: HTMLElement;
  responsePending: boolean;
};

/**
 * Permission dialog widget.
 *
 * Renders authoritative replacement permission state. It owns DOM idempotency
 * and removes stale embedded/modal UI when host state no longer lists it.
 */
export class PermissionDialog {
  private rendered = new Map<string, RenderedPermission>();
  private generatingBaseline: boolean | undefined;

  constructor(
    private ctx: WebviewContext,
    private getBlockManager: () => BlockManager,
    private getIsGenerating: () => boolean,
    private setGenerating: (value: boolean) => void,
    private scrollToBottom: () => void
  ) {}

  reconcile(ownerId: string, pending: PermissionView[]): void {
    const nextKeys = new Set(pending.map((item) => key(ownerId, item.requestId)));
    for (const [renderKey, rendered] of [...this.rendered]) {
      if (rendered.ownerId !== ownerId || !nextKeys.has(renderKey)) {
        this.dismiss(renderKey);
      }
    }
    for (const item of pending) {
      const renderKey = key(ownerId, item.requestId);
      if (this.rendered.has(renderKey)) {
        this.restoreActionability(renderKey);
        continue;
      }
      this.show(ownerId, item);
    }
  }

  clear(): void {
    for (const renderKey of [...this.rendered.keys()]) {
      this.dismiss(renderKey);
    }
  }

  private show(ownerId: string, permission: PermissionView): void {
    if (this.rendered.size === 0) {
      this.generatingBaseline = this.getIsGenerating();
    }
    this.setGenerating(true);

    let targetContainer: HTMLElement | null = null;
    if (permission.toolCallId) {
      const block = this.getBlockManager().getToolBlock(permission.toolCallId);
      if (block) {
        targetContainer = block.contentEl;
      }
    }

    const element = targetContainer
      ? this.renderEmbedded(ownerId, targetContainer, permission)
      : this.renderOverlay(ownerId, permission);

    this.rendered.set(key(ownerId, permission.requestId), {
      ownerId,
      requestId: permission.requestId,
      element,
      responsePending: false,
    });
  }

  private dismiss(renderKey: string): void {
    const rendered = this.rendered.get(renderKey);
    if (!rendered) return;
    rendered.element.remove();
    this.rendered.delete(renderKey);
    if (this.rendered.size === 0) {
      this.setGenerating(this.generatingBaseline ?? false);
      this.generatingBaseline = undefined;
    }
  }

  private cancel(ownerId: string, requestId: string): void {
    if (!this.markResponsePending(ownerId, requestId)) return;
    this.ctx.vscode.postMessage({
      type: "permissionResponse",
      requestId,
      ownerId,
      outcome: { outcome: "cancelled" },
    });
  }

  private handleOptionClick(
    ownerId: string,
    requestId: string,
    option: { optionId: string; kind: string }
  ): void {
    if (!this.markResponsePending(ownerId, requestId)) return;
    this.ctx.vscode.postMessage({
      type: "permissionResponse",
      requestId,
      ownerId,
      outcome: {
        outcome: "selected" as const,
        optionId: option.optionId,
      },
    });
  }

  private markResponsePending(ownerId: string, requestId: string): boolean {
    const rendered = this.rendered.get(key(ownerId, requestId));
    if (!rendered || rendered.responsePending) return false;
    rendered.responsePending = true;
    for (const button of rendered.element.querySelectorAll("button")) {
      button.disabled = true;
    }
    return true;
  }

  private restoreActionability(renderKey: string): void {
    const rendered = this.rendered.get(renderKey);
    if (!rendered || !rendered.responsePending) return;
    rendered.responsePending = false;
    for (const button of rendered.element.querySelectorAll("button")) {
      button.disabled = false;
    }
  }

  private renderEmbedded(
    ownerId: string,
    container: HTMLElement,
    permission: PermissionView
  ): HTMLElement {
    const { doc } = this.ctx;
    const wrapper = doc.createElement("div");
    wrapper.className = "embedded-permission";
    wrapper.dataset.permissionOwner = ownerId;
    wrapper.dataset.permissionRequestId = permission.requestId;

    const header = doc.createElement("div");
    header.className = "embedded-permission-header";
    header.innerHTML = `<span class="permission-icon codicon codicon-lock"></span> <span>Permission Required</span>`;

    const body = doc.createElement("div");
    body.className = "embedded-permission-body";

    if (permission.toolCall.description) {
      const desc = doc.createElement("div");
      desc.className = "permission-tool-desc";
      desc.style.marginBottom = "8px";
      desc.textContent = permission.toolCall.description;
      body.appendChild(desc);
    }

    body.appendChild(this.renderOptions(ownerId, permission, true));
    wrapper.appendChild(header);
    wrapper.appendChild(body);

    container.appendChild(wrapper);
    this.scrollToBottom();
    return wrapper;
  }

  private renderOverlay(ownerId: string, permission: PermissionView): HTMLElement {
    const { doc } = this.ctx;
    const overlay = doc.createElement("div");
    overlay.className = "permission-dialog-overlay";
    overlay.dataset.permissionOwner = ownerId;
    overlay.dataset.permissionRequestId = permission.requestId;

    const dialog = doc.createElement("div");
    dialog.className = "permission-dialog";

    const header = doc.createElement("div");
    header.className = "permission-dialog-header";
    header.innerHTML = `
      <span class="permission-icon codicon codicon-lock"></span>
      <span>Permission Required</span>
    `;

    const body = doc.createElement("div");
    body.className = "permission-dialog-body";

    const info = doc.createElement("div");
    info.className = "permission-tool-info";

    const kindEl = doc.createElement("div");
    kindEl.className = "permission-tool-kind";
    kindEl.textContent = permission.toolCall.kind || "Unknown";

    const titleEl = doc.createElement("div");
    titleEl.className = "permission-tool-title";
    titleEl.textContent = permission.toolCall.title || "Tool Call";

    info.appendChild(kindEl);
    info.appendChild(titleEl);

    if (permission.toolCall.description) {
      const desc = doc.createElement("div");
      desc.className = "permission-tool-desc";
      desc.textContent = permission.toolCall.description;
      info.appendChild(desc);
    }

    body.appendChild(info);
    body.appendChild(this.renderOptions(ownerId, permission, false));

    dialog.appendChild(header);
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    doc.body.appendChild(overlay);
    return overlay;
  }

  private renderOptions(
    ownerId: string,
    permission: PermissionView,
    embedded: boolean
  ): HTMLElement {
    const { doc } = this.ctx;
    const optionsContainer = doc.createElement("div");
    optionsContainer.className = embedded
      ? "embedded-permission-options"
      : "permission-options";

    if (permission.options.length === 0) {
      const btn = doc.createElement("button");
      btn.className = embedded
        ? "embedded-permission-option embedded-permission-option-reject"
        : "permission-option-btn permission-option-reject_once";
      btn.textContent = "Cancel";
      btn.addEventListener("click", () =>
        this.cancel(ownerId, permission.requestId)
      );
      optionsContainer.appendChild(btn);
      return optionsContainer;
    }

    for (const opt of permission.options) {
      const btn = doc.createElement("button");
      if (embedded) {
        const isAllow = !opt.kind.startsWith("reject");
        const isAlways = opt.kind.endsWith("always");
        btn.className = `embedded-permission-option ${
          isAllow
            ? "embedded-permission-option-allow"
            : "embedded-permission-option-reject"
        } ${isAlways ? "embedded-permission-option-always" : ""}`;

        const icon = doc.createElement("span");
        icon.className = "embedded-permission-option-icon";
        icon.innerHTML = isAllow
          ? '<div class="codicon codicon-check"></div>'
          : '<div class="codicon codicon-close"></div>';

        const text = doc.createElement("span");
        text.textContent = `${this.getOptionLabel(opt.kind)}: ${opt.name}`;
        btn.appendChild(icon);
        btn.appendChild(text);
      } else {
        btn.className = `permission-option-btn permission-option-${opt.kind}`;
        btn.textContent = `${this.getOptionLabel(opt.kind)}: ${opt.name}`;
      }
      btn.addEventListener("click", () =>
        this.handleOptionClick(ownerId, permission.requestId, opt)
      );
      optionsContainer.appendChild(btn);
    }
    return optionsContainer;
  }

  private getOptionLabel(kind: string): string {
    const labels: Record<string, string> = {
      allow_once: "Allow Once",
      allow_always: "Always Allow",
      reject_once: "Reject Once",
      reject_always: "Always Reject",
    };
    return labels[kind] || kind;
  }
}

function key(ownerId: string, requestId: string): string {
  return `${ownerId}:${requestId}`;
}
