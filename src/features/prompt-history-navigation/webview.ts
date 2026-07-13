import type { WebviewController } from "../../views/webview/main";
import type { PromptHistoryDirection } from "./types";

export class PromptHistoryNavigationWebviewFeature {
  private activeIndex: number | null = null;
  private draftBeforeNavigationHtml = "";
  private suppressInputReset = false;
  private readonly observer: MutationObserver;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(private readonly controller: WebviewController) {
    const inputEl = this.controller.inputPanel.elements.inputEl;
    inputEl.addEventListener("keydown", (event) => this.handleKeyDown(event));
    inputEl.addEventListener("input", () => this.handleInput());

    this.controller.inputPanel.elements.commandAutocomplete.addEventListener(
      "click",
      () => this.reset()
    );
    this.disposables.push(this.controller.onMessageSent(() => this.reset()));

    const MutationObserverCtor = (
      this.controller.getWindow() as Window & {
        MutationObserver: typeof MutationObserver;
      }
    ).MutationObserver;
    this.observer = new MutationObserverCtor(() => this.reset());
    this.observer.observe(this.controller.messageList.elements.messagesEl, {
      childList: true,
      subtree: true,
    });
  }

  dispose(): void {
    this.observer.disconnect();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      this.reset();
      return;
    }
    if (!this.shouldNavigate(event)) return;

    const direction: PromptHistoryDirection =
      event.key === "ArrowUp" ? "previous" : "next";
    const didNavigate = this.navigate(direction);
    if (!didNavigate) return;

    event.preventDefault();
    event.stopPropagation();
  }

  private shouldNavigate(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }

    if (this.isAutocompleteVisible()) return false;

    const selection = this.controller.getWindow().getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const inputEl = this.controller.inputPanel.elements.inputEl;
    if (!inputEl.contains(range.startContainer)) return false;

    return event.key === "ArrowUp"
      ? this.isCaretOnFirstLogicalLine(range)
      : this.isCaretOnLastLogicalLine(range);
  }

  private navigate(direction: PromptHistoryDirection): boolean {
    const history = this.controller.messageList.getUserMessageDrafts();
    if (history.length === 0) return false;

    if (direction === "next" && this.activeIndex === null) return false;

    if (this.activeIndex === null) {
      this.draftBeforeNavigationHtml = this.controller.inputPanel.getInputHtml();
      this.activeIndex = history.length;
    }

    if (direction === "previous") {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      this.setInputHtml(history[this.activeIndex].html);
      return true;
    }

    this.activeIndex = Math.min(history.length, this.activeIndex + 1);
    if (this.activeIndex === history.length) {
      this.setInputHtml(this.draftBeforeNavigationHtml);
      this.reset();
      return true;
    }

    this.setInputHtml(history[this.activeIndex].html);
    return true;
  }

  private setInputHtml(html: string): void {
    this.suppressInputReset = true;
    this.controller.inputPanel.setDraftHtmlAndFocus(html);
    this.suppressInputReset = false;
  }

  private handleInput(): void {
    if (this.suppressInputReset) return;
    this.reset();
  }

  private reset(): void {
    this.activeIndex = null;
    this.draftBeforeNavigationHtml = "";
  }

  private isAutocompleteVisible(): boolean {
    return this.controller.inputPanel.elements.commandAutocomplete.classList.contains(
      "visible"
    );
  }

  private isCaretOnFirstLogicalLine(range: Range): boolean {
    return !this.getTextBeforeCaret(range).includes("\n");
  }

  private isCaretOnLastLogicalLine(range: Range): boolean {
    return !this.getTextAfterCaret(range).includes("\n");
  }

  private getTextBeforeCaret(range: Range): string {
    const prefixRange = this.controller.getDocument().createRange();
    prefixRange.selectNodeContents(this.controller.inputPanel.elements.inputEl);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    return prefixRange.toString();
  }

  private getTextAfterCaret(range: Range): string {
    const suffixRange = this.controller.getDocument().createRange();
    suffixRange.selectNodeContents(this.controller.inputPanel.elements.inputEl);
    suffixRange.setStart(range.startContainer, range.startOffset);
    return suffixRange.toString();
  }
}

export function registerPromptHistoryNavigationWebviewFeature(
  controller: WebviewController
): PromptHistoryNavigationWebviewFeature {
  return new PromptHistoryNavigationWebviewFeature(controller);
}
