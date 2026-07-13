import type { WebviewController } from "../../views/webview/main";
import type {
  AssistantTurnEntry,
  AssistantTurnNavigationDirection,
} from "./types";

const HIGHLIGHT_MS = 900;
const LABEL_MAX_LENGTH = 80;

export class AssistantTurnNavigationWebviewFeature {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly messagesContainerEl: HTMLElement;
  private readonly messagesEl: HTMLElement;
  private readonly navigatorEl: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly counterEl: HTMLElement;
  private readonly observer: MutationObserver;
  private entries: AssistantTurnEntry[] = [];
  private activeIndex = -1;
  private rebuildFrame: number | null = null;
  private highlightTimeout: ReturnType<Window["setTimeout"]> | null = null;
  private readonly onMessagesScroll = () => this.updateActiveFromScroll();
  private readonly onMessagesFocusIn = (event: Event) => {
    const target = (event.target as Element | null)?.closest(
      ".message.assistant"
    ) as HTMLElement | null;
    if (target) this.setActiveByElement(target);
  };
  private readonly onWindowKeyDown = (event: KeyboardEvent) =>
    this.handleKeyDown(event);

  constructor(private readonly controller: WebviewController) {
    this.doc = controller.getDocument();
    this.win = controller.getWindow();
    this.messagesContainerEl = controller.messageList.elements.containerEl;
    this.messagesEl = controller.messageList.elements.messagesEl;

    const { navigatorEl, previousButton, nextButton, counterEl } =
      this.createNavigator();
    this.navigatorEl = navigatorEl;
    this.previousButton = previousButton;
    this.nextButton = nextButton;
    this.counterEl = counterEl;
    this.messagesContainerEl.appendChild(this.navigatorEl);

    const MutationObserverCtor = (
      this.win as Window & { MutationObserver: typeof MutationObserver }
    ).MutationObserver;
    this.observer = new MutationObserverCtor(() => this.scheduleRebuild());
    this.observer.observe(this.messagesEl, { childList: true, subtree: true });

    this.messagesEl.addEventListener("scroll", this.onMessagesScroll);
    this.messagesEl.addEventListener("focusin", this.onMessagesFocusIn);
    this.win.addEventListener("keydown", this.onWindowKeyDown);

    this.rebuildEntries();
  }

  dispose(): void {
    this.observer.disconnect();
    if (this.rebuildFrame !== null) {
      this.cancelFrame(this.rebuildFrame);
      this.rebuildFrame = null;
    }
    if (this.highlightTimeout !== null) {
      this.win.clearTimeout(this.highlightTimeout);
      this.highlightTimeout = null;
    }
    this.messagesEl.removeEventListener("scroll", this.onMessagesScroll);
    this.messagesEl.removeEventListener("focusin", this.onMessagesFocusIn);
    this.win.removeEventListener("keydown", this.onWindowKeyDown);
    this.entries.forEach((entry) =>
      entry.element.classList.remove("assistant-turn-highlight")
    );
    this.navigatorEl.remove();
  }

  navigate(direction: AssistantTurnNavigationDirection): boolean {
    if (this.entries.length === 0) return false;

    this.ensureActiveIndex();
    const nextIndex =
      direction === "previous" ? this.activeIndex - 1 : this.activeIndex + 1;
    if (nextIndex < 0 || nextIndex >= this.entries.length) {
      this.updateNavigator();
      return false;
    }

    this.jumpTo(nextIndex);
    return true;
  }

  private createNavigator(): {
    navigatorEl: HTMLElement;
    previousButton: HTMLButtonElement;
    nextButton: HTMLButtonElement;
    counterEl: HTMLElement;
  } {
    const navigatorEl = this.doc.createElement("div");
    navigatorEl.className = "assistant-turn-navigator";
    navigatorEl.hidden = true;
    navigatorEl.setAttribute("role", "group");
    navigatorEl.setAttribute("aria-label", "Assistant response navigation");

    const previousButton = this.createButton(
      "chevron-up",
      "Previous assistant response (Alt+[)",
      () => this.navigate("previous")
    );
    previousButton.classList.add("assistant-turn-prev");

    const counterEl = this.doc.createElement("span");
    counterEl.className = "assistant-turn-counter";
    counterEl.setAttribute("aria-live", "polite");
    counterEl.textContent = "Assistant 0 / 0";

    const nextButton = this.createButton(
      "chevron-down",
      "Next assistant response (Alt+])",
      () => this.navigate("next")
    );
    nextButton.classList.add("assistant-turn-next");

    navigatorEl.append(previousButton, counterEl, nextButton);
    return { navigatorEl, previousButton, nextButton, counterEl };
  }

  private createButton(
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = "assistant-turn-nav-btn";
    button.setAttribute("aria-label", label);
    button.setAttribute("acp-title", label);

    const iconEl = this.doc.createElement("span");
    iconEl.className = `codicon codicon-${icon}`;
    iconEl.setAttribute("aria-hidden", "true");
    button.appendChild(iconEl);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });

    return button;
  }

  private scheduleRebuild(): void {
    if (this.rebuildFrame !== null) return;
    this.rebuildFrame = this.requestFrame(() => {
      this.rebuildFrame = null;
      this.rebuildEntries();
    });
  }

  private rebuildEntries(): void {
    const previousEntriesLength = this.entries.length;
    const previousActiveWasLast = this.activeIndex === previousEntriesLength - 1;
    const previousElement = this.entries[this.activeIndex]?.element;
    this.entries = Array.from(
      this.messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    )
      .filter((element) => element.querySelector(".message-actions"))
      .map((element, index) => ({
        element,
        index,
        label: this.createLabel(element, index),
      }));

    if (previousElement) {
      const nextIndex = this.entries.findIndex(
        (entry) => entry.element === previousElement
      );
      this.activeIndex =
        previousActiveWasLast && this.entries.length > previousEntriesLength
          ? this.entries.length - 1
          : nextIndex;
      if (this.activeIndex < 0) this.activeIndex = this.entries.length - 1;
    } else {
      this.activeIndex = this.entries.length - 1;
    }

    if (this.entries.length === 0) this.activeIndex = -1;
    this.updateNavigator();
  }

  private createLabel(element: HTMLElement, index: number): string {
    const previousUser = this.findPreviousUserMessage(element);
    const rawLabel =
      previousUser?.textContent?.trim() || element.textContent?.trim() || "";
    const collapsed = rawLabel.replace(/\s+/g, " ");
    if (!collapsed) return `Assistant response ${index + 1}`;
    if (collapsed.length <= LABEL_MAX_LENGTH) return collapsed;
    return `${collapsed.slice(0, LABEL_MAX_LENGTH - 1)}…`;
  }

  private findPreviousUserMessage(element: HTMLElement): HTMLElement | null {
    let current = element.previousElementSibling;
    while (current) {
      if (current.classList.contains("message")) {
        if (current.classList.contains("user")) return current as HTMLElement;
        if (current.classList.contains("assistant")) return null;
      }
      current = current.previousElementSibling;
    }
    return null;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "[" && event.key !== "]") return;
    if (this.isEditableTarget(event.target)) return;

    const didNavigate = this.navigate(event.key === "[" ? "previous" : "next");
    if (!didNavigate) return;

    event.preventDefault();
    event.stopPropagation();
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as Element).closest !== "function") {
      return false;
    }
    const element = target as Element;
    return Boolean(
      element.closest(
        'input, textarea, select, [contenteditable], .custom-dropdown.open, .dropdown-popover, [role="listbox"], [role="menu"]'
      )
    );
  }

  private ensureActiveIndex(): void {
    if (this.entries.length === 0) {
      this.activeIndex = -1;
      return;
    }

    const focusedAssistant = (this.doc.activeElement as Element | null)?.closest(
      ".message.assistant"
    ) as HTMLElement | null;
    if (focusedAssistant && this.setActiveByElement(focusedAssistant)) return;

    if (this.activeIndex >= 0 && this.activeIndex < this.entries.length) return;
    this.activeIndex = this.findNearestIndexFromScroll();
  }

  private setActiveByElement(element: HTMLElement): boolean {
    const index = this.entries.findIndex((entry) => entry.element === element);
    if (index < 0) return false;
    this.activeIndex = index;
    this.updateNavigator();
    return true;
  }

  private updateActiveFromScroll(): void {
    if (this.entries.length === 0) return;
    this.activeIndex = this.findNearestIndexFromScroll();
    this.updateNavigator();
  }

  private findNearestIndexFromScroll(): number {
    if (this.entries.length === 0) return -1;

    const containerRect = this.messagesEl.getBoundingClientRect();
    const anchor = containerRect.top + Math.max(24, containerRect.height * 0.25);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    this.entries.forEach((entry, index) => {
      const rect = entry.element.getBoundingClientRect();
      const distance = Math.abs(rect.top - anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  private jumpTo(index: number): void {
    const entry = this.entries[index];
    if (!entry) return;

    this.activeIndex = index;
    this.controller.messageList.disableAutoScroll();
    entry.element.scrollIntoView?.({ behavior: "smooth", block: "start" });
    entry.element.focus({ preventScroll: true });
    this.highlight(entry.element);
    this.updateNavigator();
  }

  private highlight(element: HTMLElement): void {
    this.entries.forEach((entry) =>
      entry.element.classList.remove("assistant-turn-highlight")
    );
    if (this.highlightTimeout !== null) {
      this.win.clearTimeout(this.highlightTimeout);
      this.highlightTimeout = null;
    }

    element.classList.add("assistant-turn-highlight");
    this.highlightTimeout = this.win.setTimeout(() => {
      element.classList.remove("assistant-turn-highlight");
      this.highlightTimeout = null;
    }, HIGHLIGHT_MS);
  }

  private updateNavigator(): void {
    const visible = this.entries.length >= 2;
    this.navigatorEl.hidden = !visible;

    if (this.entries.length === 0) {
      this.counterEl.textContent = "Assistant 0 / 0";
      this.previousButton.disabled = true;
      this.nextButton.disabled = true;
      return;
    }

    if (this.activeIndex < 0 || this.activeIndex >= this.entries.length) {
      this.activeIndex = this.entries.length - 1;
    }

    const activeEntry = this.entries[this.activeIndex];
    this.counterEl.textContent = `Assistant ${this.activeIndex + 1} / ${this.entries.length}`;
    this.counterEl.setAttribute(
      "title",
      activeEntry?.label ?? "Assistant response"
    );
    this.previousButton.disabled = this.activeIndex <= 0;
    this.nextButton.disabled = this.activeIndex >= this.entries.length - 1;
  }

  private requestFrame(callback: FrameRequestCallback): number {
    if (typeof this.win.requestAnimationFrame === "function") {
      return this.win.requestAnimationFrame(callback);
    }
    return this.win.setTimeout(() => callback(Date.now()), 0);
  }

  private cancelFrame(frame: number): void {
    if (typeof this.win.cancelAnimationFrame === "function") {
      this.win.cancelAnimationFrame(frame);
      return;
    }
    this.win.clearTimeout(frame);
  }
}

export function registerAssistantTurnNavigationWebviewFeature(
  controller: WebviewController
): AssistantTurnNavigationWebviewFeature {
  return new AssistantTurnNavigationWebviewFeature(controller);
}
