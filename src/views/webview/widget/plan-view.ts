/**
 * Plan view widget.
 *
 * Renders a collapsible execution plan showing pending, in-progress, and
 * completed steps.  Displays a mini progress bar and contextual labels
 * when collapsed.
 */

import { escapeHtml } from "../html-utils";
import type { PlanEntry } from "../types";

/** Configuration accepted by the {@link PlanView} constructor. */
export interface PlanViewOptions {
  container: HTMLElement;
}

/**
 * Manages the agent execution plan display.
 *
 * Shows a sticky plan header with a progress counter and expandable
 * entry list.  Automatically selects a contextual label based on the
 * current execution state.
 */
export class PlanView {
  private container: HTMLElement;
  private doc: Document;
  private planEl: HTMLElement | null = null;
  private entries: PlanEntry[] = [];
  private expanded = false;

  constructor(options: PlanViewOptions) {
    this.container = options.container;
    this.doc = options.container.ownerDocument;
  }

  /**
   * Display the given plan entries.
   *
   * Pass an empty array to hide the plan.
   */
  show(entries: PlanEntry[]): void {
    if (entries.length === 0) {
      this.hide();
      return;
    }

    this.entries = entries;

    if (!this.planEl) {
      this.planEl = this.doc.createElement("div");
      this.planEl.className = "agent-plan-sticky";
      this.planEl.setAttribute("role", "status");
      this.planEl.setAttribute("aria-live", "polite");
      this.planEl.setAttribute("aria-label", "Agent execution plan");
      this.container.appendChild(this.planEl);
    }

    const completedCount = entries.filter(
      (e) => e.status === "completed"
    ).length;
    const totalCount = entries.length;
    const inProgressCount = entries.filter(
      (e) => e.status === "in_progress"
    ).length;

    const planLabel = this.getLabel(
      completedCount,
      totalCount,
      inProgressCount
    );

    this.planEl.innerHTML = `
      <div class="plan-header" role="button" tabindex="0" aria-expanded="${this.expanded}">
        <span class="plan-toggle-icon ${this.expanded ? "expanded" : "collapsed"}"></span>
        <span class="plan-title">${planLabel}</span>
        <span class="plan-counter">${completedCount}/${totalCount}</span>
        <div class="plan-mini-progress-bar">
          <div class="plan-mini-progress-fill" style="width: ${(completedCount / totalCount) * 100}%"></div>
        </div>
      </div>
      <div class="plan-entries ${this.expanded ? "" : "collapsed"}">
        ${entries
          .map(
            (entry) => `
          <div class="plan-entry plan-entry-${entry.status} plan-priority-${entry.priority}">
            <span class="plan-status-icon">${this.getStatusHtml(entry.status)}</span>
            <span class="plan-content">${escapeHtml(entry.content)}</span>
          </div>
        `
          )
          .join("")}
      </div>
    `;

    // Add click handler for toggle - always re-bind since innerHTML recreates elements
    const headerEl = this.planEl.querySelector(".plan-header");
    if (headerEl) {
      // Use onclick to avoid duplicate bindings
      (headerEl as HTMLElement).onclick = () => this.toggle();

      headerEl.addEventListener("keydown", (e: Event) => {
        const keyboardEvent = e as KeyboardEvent;
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          e.preventDefault();
          this.toggle();
        }
      });
    }
  }

  /** Hide the plan and reset state. */
  hide(): void {
    if (this.planEl) {
      this.planEl.remove();
      this.planEl = null;
    }
    this.entries = [];
    this.expanded = false;
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    this.show(this.entries);
  }

  private getLabel(
    completedCount: number,
    _totalCount: number,
    inProgressCount: number
  ): string {
    if (this.expanded) {
      return "Plan";
    }

    // When collapsed, show "Plan(Current): xxxx" format
    if (inProgressCount > 0) {
      const currentEntry = this.entries.find((e) => e.status === "in_progress");
      if (currentEntry) {
        // Truncate long content
        const content =
          currentEntry.content.length > 50
            ? currentEntry.content.substring(0, 50) + "..."
            : currentEntry.content;
        return `Plan(Current): ${content}`;
      }
    }

    // If no in-progress, show the last completed item or first pending
    if (completedCount > 0) {
      const lastCompleted = [...this.entries]
        .reverse()
        .find((e) => e.status === "completed");
      if (lastCompleted) {
        const content =
          lastCompleted.content.length > 50
            ? lastCompleted.content.substring(0, 50) + "..."
            : lastCompleted.content;
        return `Plan(Current): ${content}`;
      }
    }

    // Default: show first pending item
    const firstPending = this.entries.find((e) => e.status === "pending");
    if (firstPending) {
      const content =
        firstPending.content.length > 50
          ? firstPending.content.substring(0, 50) + "..."
          : firstPending.content;
      return `Plan(Current): ${content}`;
    }

    return "Plan(Current)";
  }

  private getStatusHtml(status: string): string {
    switch (status) {
      case "completed":
        return '<span class="codicon codicon-check"></span>';
      case "in_progress":
        return '<span class="codicon codicon-loading codicon-modifier-spin"></span>';
      case "pending":
      default:
        return '<span class="codicon codicon-circle-large"></span>';
    }
  }
}
