import { BlockWidget } from "./block-widget";
import { renderToolSummary, renderToolDetails } from "../tool-render";
import type { WebviewContext } from "../context";
import type { ToolCallSummary, ToolKind } from "../types";

/**
 * Streaming tool block. Renders as a collapsible <details> element with
 * summary (icon + label) and detail panel (input/output/diff).
 *
 * The summary and detail panels are updated in-place as the host streams
 * toolCallStart / toolCallComplete messages.
 */
export class ToolBlock extends BlockWidget {
  constructor(
    ctx: WebviewContext,
    element: HTMLElement,
    contentEl: HTMLElement,
    toolId: string
  ) {
    super(ctx, element, contentEl, `tool:${toolId}`, "tool");
    this.toolId = toolId;
  }

  static create(ctx: WebviewContext, toolId: string): ToolBlock {
    const blockEl = ctx.doc.createElement("div");
    blockEl.className = "block block-tool";

    const details = ctx.doc.createElement("details");
    details.className = "tool-item";
    details.setAttribute("open", "");
    details.innerHTML = `
      <summary class="tool-summary">
        <span class="tool-status running"><span class="codicon codicon-loading animate-spin"></span></span>
        <span class="tool-summary-content"><span class="tool-name">Initializing...</span></span>
      </summary>
      <div class="tool-details-content"></div>
    `;
    blockEl.appendChild(details);

    const contentEl = details.querySelector(".tool-details-content")!;
    return new ToolBlock(ctx, blockEl, contentEl as HTMLElement, toolId);
  }

  appendContent(): void {
    // Tool blocks are updated via updateSummary/updateDetails, not appendContent.
  }

  /**
   * Update the summary row (called on toolCallStart and toolCallComplete).
   */
  updateSummary(info: ToolCallSummary): void {
    if (info.kind) this.kind = info.kind as ToolKind;
    if (info.title) this.title = info.title;
    if (info.status) this.status = info.status;

    const summary = this.element.querySelector("summary");
    if (!summary) return;

    const summaryContent = summary.querySelector(".tool-summary-content");
    if (summaryContent) {
      summaryContent.innerHTML = renderToolSummary(info);
    }
  }

  /**
   * Render the full detail panel (called on toolCallComplete).
   */
  updateDetails(info: ToolCallSummary): void {
    this.contentEl.innerHTML = renderToolDetails(info);
  }

  /**
   * Mark the tool as failed by adding a failure icon to the summary.
   */
  markFailed(): void {
    const summary = this.element.querySelector("summary");
    if (summary) {
      summary.querySelector(".tool-status.failed")?.remove();
      const failIcon = this.ctx.doc.createElement("span");
      failIcon.className = "tool-status failed";
      failIcon.innerHTML = '<span class="codicon codicon-close"></span>';
      summary.appendChild(failIcon);
    }

    const toolItem = this.element.querySelector(".tool-item");
    if (toolItem) {
      toolItem.classList.add("tool-failed");
    }
  }

  /**
   * Remove the running spinner from the summary.
   */
  removeSpinner(): void {
    const summary = this.element.querySelector("summary");
    summary?.querySelector(".tool-status.running")?.remove();
  }

  finalize(): void {
    const details = this.element.querySelector("details");
    if (!details) return;

    // Don't close running tool blocks
    if (!this.status || this.status === "in_progress") return;

    // Keep edit/write/execute tools and failed tools open
    const isWriteOrEdit = this.kind === "edit" || this.kind === "write";
    const isExecute = this.kind === "execute";
    const shouldKeepOpen =
      isWriteOrEdit || isExecute || this.status === "failed";

    if (!shouldKeepOpen) {
      details.removeAttribute("open");
    }
  }
}
