/**
 * Permission dialog widget.
 *
 * Displays a permission request UI either embedded inside a tool block or
 * as a modal overlay.  The user can allow/reject the action once or always.
 */

import type { VsCodeApi, Block } from "../types";

/** Configuration accepted by the {@link PermissionDialog} constructor. */
export interface PermissionDialogOptions {
  doc: Document;
  vscode: VsCodeApi;
  getIsGenerating: () => boolean;
  setGenerating: (value: boolean) => void;
  scrollToBottom: () => void;
  findToolBlock: (toolCallId: string) => Block | undefined;
}

/**
 * Manages permission request dialogs in the webview.
 *
 * Supports two rendering modes:
 * - **Embedded**: injected into an existing tool block's content area.
 * - **Overlay**: a full-screen modal dialog when no tool block is found.
 */
export class PermissionDialog {
  private doc: Document;
  private vscode: VsCodeApi;
  private getIsGenerating: () => boolean;
  private setGenerating: (value: boolean) => void;
  private scrollToBottom: () => void;
  private findToolBlock: (toolCallId: string) => Block | undefined;

  constructor(options: PermissionDialogOptions) {
    this.doc = options.doc;
    this.vscode = options.vscode;
    this.getIsGenerating = options.getIsGenerating;
    this.setGenerating = options.setGenerating;
    this.scrollToBottom = options.scrollToBottom;
    this.findToolBlock = options.findToolBlock;
  }

  /**
   * Show a permission dialog for the given request.
   *
   * If `toolCallId` matches an existing tool block, the permission UI is
   * embedded inside that block.  Otherwise a modal overlay is shown.
   */
  show(
    requestId: string,
    toolCall: { kind?: string; title?: string; description?: string },
    options: Array<{ optionId: string; kind: string; name: string }>,
    toolCallId?: string
  ): void {
    const wasGenerating = this.getIsGenerating();
    // Always block input while waiting for permission
    this.setGenerating(true);

    if (options.length === 0) {
      options.push({
        optionId: "cancel",
        kind: "reject_once",
        name: "Cancel (No options provided)",
      });
    }

    // Try to find the tool block to embed the permission UI
    let targetContainer: HTMLElement | null = null;
    if (toolCallId) {
      const block = this.findToolBlock(toolCallId);
      if (block) {
        targetContainer = block.contentEl;
      }
    }

    if (targetContainer) {
      this.renderEmbedded(
        targetContainer,
        requestId,
        toolCall,
        options,
        wasGenerating
      );
    } else {
      this.renderOverlay(requestId, toolCall, options, wasGenerating);
    }
  }

  private handleOptionClick(
    requestId: string,
    option: { optionId: string; kind: string },
    cleanup: () => void,
    wasGenerating: boolean
  ): void {
    const isReject = option.kind.startsWith("reject");
    const outcome = isReject
      ? { outcome: "cancelled" as const }
      : { outcome: "selected" as const, optionId: option.optionId };

    this.vscode.postMessage({
      type: "permissionResponse",
      requestId,
      outcome,
    });

    cleanup();
    this.setGenerating(wasGenerating);
  }

  private renderEmbedded(
    container: HTMLElement,
    requestId: string,
    toolCall: { kind?: string; title?: string; description?: string },
    options: Array<{ optionId: string; kind: string; name: string }>,
    wasGenerating: boolean
  ): void {
    const wrapper = this.doc.createElement("div");
    wrapper.className = "embedded-permission";

    const header = this.doc.createElement("div");
    header.className = "embedded-permission-header";
    header.innerHTML = `<span class="permission-icon codicon codicon-lock"></span> <span>Permission Required</span>`;

    const body = this.doc.createElement("div");
    body.className = "embedded-permission-body";

    if (toolCall.description) {
      const desc = this.doc.createElement("div");
      desc.className = "permission-tool-desc";
      desc.style.marginBottom = "8px";
      desc.textContent = toolCall.description;
      body.appendChild(desc);
    }

    const optionsContainer = this.doc.createElement("div");
    optionsContainer.className = "embedded-permission-options";

    options.forEach((opt) => {
      const btn = this.doc.createElement("button");
      const isAllow = !opt.kind.startsWith("reject");
      const isAlways = opt.kind.endsWith("always");

      btn.className = `embedded-permission-option ${
        isAllow
          ? "embedded-permission-option-allow"
          : "embedded-permission-option-reject"
      } ${isAlways ? "embedded-permission-option-always" : ""}`;

      const icon = this.doc.createElement("span");
      icon.className = "embedded-permission-option-icon";
      icon.innerHTML = isAllow
        ? `<div class="codicon codicon-check"></div>`
        : `<div class="codicon codicon-close"></div>`;

      const text = this.doc.createElement("span");
      const label = this.getOptionLabel(opt.kind);
      text.textContent = `${label}: ${opt.name}`;

      btn.appendChild(icon);
      btn.appendChild(text);

      btn.addEventListener("click", () => {
        this.handleOptionClick(
          requestId,
          opt,
          () => wrapper.remove(),
          wasGenerating
        );
      });

      optionsContainer.appendChild(btn);
    });

    body.appendChild(optionsContainer);
    wrapper.appendChild(header);
    wrapper.appendChild(body);

    container.appendChild(wrapper);
    this.scrollToBottom();
  }

  private renderOverlay(
    requestId: string,
    toolCall: { kind?: string; title?: string; description?: string },
    options: Array<{ optionId: string; kind: string; name: string }>,
    wasGenerating: boolean
  ): void {
    const overlay = this.doc.createElement("div");
    overlay.className = "permission-dialog-overlay";

    const dialog = this.doc.createElement("div");
    dialog.className = "permission-dialog";

    const header = this.doc.createElement("div");
    header.className = "permission-dialog-header";
    header.innerHTML = `
      <span class="permission-icon codicon codicon-lock"></span>
      <span>Permission Required</span>
    `;

    const body = this.doc.createElement("div");
    body.className = "permission-dialog-body";

    const info = this.doc.createElement("div");
    info.className = "permission-tool-info";

    const kind = this.doc.createElement("div");
    kind.className = "permission-tool-kind";
    kind.textContent = toolCall.kind || "Unknown";

    const title = this.doc.createElement("div");
    title.className = "permission-tool-title";
    title.textContent = toolCall.title || "Tool Call";

    info.appendChild(kind);
    info.appendChild(title);

    if (toolCall.description) {
      const desc = this.doc.createElement("div");
      desc.className = "permission-tool-desc";
      desc.textContent = toolCall.description;
      info.appendChild(desc);
    }

    const optionsContainer = this.doc.createElement("div");
    optionsContainer.className = "permission-options";

    options.forEach((opt) => {
      const btn = this.doc.createElement("button");
      btn.className = `permission-option-btn permission-option-${opt.kind}`;

      const label = this.getOptionLabel(opt.kind);
      btn.textContent = `${label}: ${opt.name}`;

      btn.addEventListener("click", () => {
        this.handleOptionClick(
          requestId,
          opt,
          () => overlay.remove(),
          wasGenerating
        );
      });

      optionsContainer.appendChild(btn);
    });

    body.appendChild(info);
    body.appendChild(optionsContainer);

    dialog.appendChild(header);
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    this.doc.body.appendChild(overlay);
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
