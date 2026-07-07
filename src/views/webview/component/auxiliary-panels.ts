import { DiffSummary } from "../widget/diff-summary";
import { PlanView } from "../widget/plan-view";
import type { AuxiliaryPanelElements, PlanEntry, VsCodeApi } from "../types";
import { getRequiredElement } from "../widget/dom";

/**
 * Groups side-channel panels that sit outside the message stream but are still
 * part of the chat session state. The concrete widgets remain isolated here so
 * the controller can treat plan and diff summary updates uniformly.
 */
export class AuxiliaryPanelsComponent {
  readonly elements: AuxiliaryPanelElements;
  private planView?: PlanView;
  private diffSummary?: DiffSummary;

  constructor(
    doc: Document,
    options?: {
      elements?: AuxiliaryPanelElements;
      vscode?: VsCodeApi;
      onSaveState?: () => void;
    }
  ) {
    this.elements = options?.elements ?? {
      planContainer: getRequiredElement(doc, "agent-plan-container"),
      diffSummaryContainer: getRequiredElement(doc, "diff-summary-container"),
    };

    if (options?.vscode) {
      this.attach(options.vscode, options.onSaveState);
    }
  }

  attach(vscode: VsCodeApi, onSaveState?: () => void): void {
    if (this.planView || this.diffSummary) return;

    this.planView = new PlanView({
      container: this.elements.planContainer,
    });

    this.diffSummary = new DiffSummary({
      container: this.elements.diffSummaryContainer,
      vscode,
      // In tests this component may be constructed without persistence hooks.
      onSaveState: onSaveState ?? (() => {}),
    });
  }

  showPlan(entries: PlanEntry[]): void {
    this.planView?.show(entries);
  }

  hidePlan(): void {
    this.planView?.hide();
  }

  setDiffChanges(
    changes: Array<{
      path: string;
      relativePath: string;
      oldText: string | null;
      newText: string;
      status: string;
    }>
  ): void {
    this.diffSummary?.setChanges(changes);
  }

  getDiffChanges():
    | Array<{
        path: string;
        relativePath: string;
        oldText: string | null;
        newText: string;
        status: string;
      }>
    | undefined {
    return this.diffSummary?.getChanges();
  }

  clearDiff(): void {
    this.diffSummary?.clear();
  }
}
