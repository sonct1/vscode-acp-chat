/**
 * Diff summary widget.
 *
 * Renders a collapsible summary of file changes with accept/discard actions.
 * Shows file counts, line statistics, and per-file action buttons.
 */

import { computeLineDiff } from "../../../utils/diff";
import { escapeHtml } from "../html-utils";
import { getFileIconHtml } from "../file-icon";
import type { VsCodeApi } from "../types";
import type { StatePersistenceService } from "../state-persistence";

/** A single file change entry tracked by the diff summary. */
export interface DiffChange {
  path: string;
  relativePath: string;
  oldText: string | null;
  newText: string;
  status: string;
}

/** Configuration accepted by the {@link DiffSummary} constructor. */
export interface DiffSummaryOptions {
  container: HTMLElement;
  vscode: VsCodeApi;
  stateService: StatePersistenceService;
}

/**
 * Manages the diff summary panel at the bottom of the webview.
 *
 * Tracks pending file changes and renders a collapsible list with
 * accept/discard actions for each file or globally.
 */
export class DiffSummary {
  private container: HTMLElement;
  private vscode: VsCodeApi;
  private stateService: StatePersistenceService;
  private changes: DiffChange[] = [];
  private expanded = false;

  constructor(options: DiffSummaryOptions) {
    this.container = options.container;
    this.vscode = options.vscode;
    this.stateService = options.stateService;
    this.restoreState();
  }

  /** Replace the current set of changes and re-render. */
  setChanges(changes: DiffChange[]): void {
    this.changes = changes;
    this.render();
    this.stateService.update("diffChanges", this.changes);
  }

  /** Clear all changes and collapse the summary. */
  clear(): void {
    this.changes = [];
    this.expanded = false;
    this.render();
    this.stateService.update("diffChanges", undefined);
  }

  private restoreState(): void {
    const previousState = this.stateService.restore();
    if (previousState?.diffChanges) {
      this.changes = previousState.diffChanges;
      this.render();
    }
  }

  private render(): void {
    if (this.changes.length === 0) {
      this.container.style.display = "none";
      this.container.innerHTML = "";
      return;
    }

    this.container.style.display = "block";

    // Calculate total stats
    let totalAdded = 0;
    let totalRemoved = 0;
    this.changes.forEach((change) => {
      const diff = computeLineDiff(change.oldText, change.newText);
      totalAdded += diff.filter((l) => l.type === "add").length;
      totalRemoved += diff.filter((l) => l.type === "remove").length;
    });

    let html = `
      <div class="diff-summary-header">
        <div class="diff-summary-info">
          <span class="codicon codicon-sync"></span>
          <span class="diff-summary-title">${this.changes.length} files modified</span>
          <span class="diff-stat-added">+${totalAdded}</span>
          <span class="diff-stat-removed">-${totalRemoved}</span>
        </div>
        <div class="diff-summary-actions">
          <button class="diff-action-btn accept-all" acp-title="Accept All Changes">
            <span class="codicon codicon-check"></span>
          </button>
          <button class="diff-action-btn rollback-all" acp-title="Discard All Changes">
            <span class="codicon codicon-discard"></span>
          </button>
          <button class="diff-action-btn toggle-expand ${this.expanded ? "expanded" : ""}" acp-title="${this.expanded ? "Collapse" : "Expand"}">
            <span class="codicon codicon-chevron-down"></span>
          </button>
        </div>
      </div>
    `;

    if (this.expanded) {
      html += `<div class="diff-summary-list">`;
      this.changes.forEach((change) => {
        const diff = computeLineDiff(change.oldText, change.newText);
        const added = diff.filter((l) => l.type === "add").length;
        const removed = diff.filter((l) => l.type === "remove").length;

        const parts = change.relativePath.split(/[/\\]/);
        const filename = parts.pop() || change.relativePath;
        const dirpath = parts.length > 0 ? parts.join("/") + "/" : "";

        html += `
          <div class="diff-summary-item">
            <div class="diff-item-info" acp-title="${escapeHtml(change.path)}">
      ${getFileIconHtml(filename, 14)}
              <span class="diff-item-path">
                <span style="font-weight: bold;">${escapeHtml(filename)}</span>
                ${dirpath ? `<span class="diff-item-directory">${escapeHtml(dirpath)}</span>` : ""}
              </span>
              <span class="diff-stat-added">+${added}</span>
              <span class="diff-stat-removed">-${removed}</span>
            </div>
            <div class="diff-item-actions">
              <button class="diff-item-btn review" data-path="${escapeHtml(change.path)}" acp-title="Review Diff">
                <span class="codicon codicon-diff"></span>
              </button>
              <button class="diff-item-btn accept" data-path="${escapeHtml(change.path)}" acp-title="Accept Change">
                <span class="codicon codicon-check"></span>
              </button>
              <button class="diff-item-btn rollback" data-path="${escapeHtml(change.path)}" acp-title="Discard Change">
                <span class="codicon codicon-discard"></span>
              </button>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }

    this.container.innerHTML = html;
    this.bindEvents();
  }

  private bindEvents(): void {
    // Toggle expand/collapse
    const toggleBtn = this.container.querySelector(".toggle-expand");
    toggleBtn?.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.render();
    });

    // Accept all changes
    const acceptAllBtn = this.container.querySelector(".accept-all");
    acceptAllBtn?.addEventListener("click", () => {
      this.vscode.postMessage({ type: "acceptAllDiffs" });
    });

    // Discard all changes
    const rollbackAllBtn = this.container.querySelector(".rollback-all");
    rollbackAllBtn?.addEventListener("click", () => {
      this.vscode.postMessage({ type: "rollbackAllDiffs" });
    });

    // Per-file review
    this.container.querySelectorAll(".diff-item-btn.review").forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = (btn as HTMLElement).dataset.path;
        this.vscode.postMessage({ type: "reviewDiff", path });
      });
    });

    // Per-file accept
    this.container.querySelectorAll(".diff-item-btn.accept").forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = (btn as HTMLElement).dataset.path;
        this.vscode.postMessage({ type: "acceptDiff", path });
      });
    });

    // Per-file discard
    this.container
      .querySelectorAll(".diff-item-btn.rollback")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const path = (btn as HTMLElement).dataset.path;
          this.vscode.postMessage({ type: "rollbackDiff", path });
        });
      });
  }
}
