import type { WebviewController } from "../../views/webview/main";
import type {
  AssistantTurnEntry,
  AssistantTurnNavigationDirection,
} from "./types";

const LABEL_MAX_LENGTH = 80;
const READING_ANCHOR_EPSILON_PX = 1;

export class AssistantTurnNavigationWebviewFeature {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly messagesEl: HTMLElement;
  private readonly navigatorEl: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly counterEl: HTMLElement;
  private readonly observer: MutationObserver;
  private entries: AssistantTurnEntry[] = [];
  private activeIndex = -1;
  private rebuildFrame: number | null = null;
  private lastFocusedAssistantElement: HTMLElement | null = null;
  private hasButtonNavigationAnchor = false;
  private readonly clearButtonNavigationAnchor = () => {
    this.hasButtonNavigationAnchor = false;
    this.lastFocusedAssistantElement = null;
  };
  private readonly onMessagesScroll = () => this.updateActiveFromScroll();
  private readonly onMessagesFocusIn = (event: Event) => {
    const target = (event.target as Element | null)?.closest(
      ".message.assistant"
    ) as HTMLElement | null;
    if (!target) return;
    this.clearButtonNavigationAnchor();
    this.lastFocusedAssistantElement = target;
    this.setActiveByElement(target);
  };

  constructor(private readonly controller: WebviewController) {
    this.doc = controller.getDocument();
    this.win = controller.getWindow();
    this.messagesEl = controller.messageList.elements.messagesEl;

    const { navigatorEl, previousButton, nextButton, counterEl } =
      this.createNavigator();
    this.navigatorEl = navigatorEl;
    this.previousButton = previousButton;
    this.nextButton = nextButton;
    this.counterEl = counterEl;
    this.attachNavigator();

    const MutationObserverCtor = (
      this.win as Window & { MutationObserver: typeof MutationObserver }
    ).MutationObserver;
    this.observer = new MutationObserverCtor(() => this.scheduleRebuild());
    this.observer.observe(this.messagesEl, { childList: true, subtree: true });

    this.messagesEl.addEventListener("scroll", this.onMessagesScroll);
    this.messagesEl.addEventListener("focusin", this.onMessagesFocusIn);
    this.messagesEl.addEventListener("wheel", this.clearButtonNavigationAnchor);
    this.messagesEl.addEventListener(
      "pointerdown",
      this.clearButtonNavigationAnchor
    );
    this.messagesEl.addEventListener(
      "touchstart",
      this.clearButtonNavigationAnchor
    );
    this.messagesEl.addEventListener(
      "keydown",
      this.clearButtonNavigationAnchor
    );

    this.rebuildEntries();
  }

  dispose(): void {
    this.observer.disconnect();
    if (this.rebuildFrame !== null) {
      this.cancelFrame(this.rebuildFrame);
      this.rebuildFrame = null;
    }
    this.messagesEl.removeEventListener("scroll", this.onMessagesScroll);
    this.messagesEl.removeEventListener("focusin", this.onMessagesFocusIn);
    this.messagesEl.removeEventListener(
      "wheel",
      this.clearButtonNavigationAnchor
    );
    this.messagesEl.removeEventListener(
      "pointerdown",
      this.clearButtonNavigationAnchor
    );
    this.messagesEl.removeEventListener(
      "touchstart",
      this.clearButtonNavigationAnchor
    );
    this.messagesEl.removeEventListener(
      "keydown",
      this.clearButtonNavigationAnchor
    );
    this.navigatorEl.remove();
  }

  navigate(direction: AssistantTurnNavigationDirection): boolean {
    if (this.entries.length === 0) return false;

    this.jumpTo(this.resolveNavigationTargetIndex(direction));
    return true;
  }

  private createNavigator(): {
    navigatorEl: HTMLElement;
    previousButton: HTMLButtonElement;
    nextButton: HTMLButtonElement;
    counterEl: HTMLElement;
  } {
    const navigatorEl = this.doc.createElement("div");
    navigatorEl.className =
      "assistant-turn-navigator assistant-turn-navigator-header";
    navigatorEl.hidden = true;
    navigatorEl.setAttribute("role", "group");
    navigatorEl.setAttribute("aria-label", "Assistant response navigation");

    const previousButton = this.createButton(
      "chevron-up",
      "Previous assistant response",
      () => this.navigate("previous")
    );
    previousButton.classList.add("assistant-turn-prev");

    const counterEl = this.doc.createElement("span");
    counterEl.className = "assistant-turn-counter";
    counterEl.setAttribute("aria-live", "polite");
    counterEl.textContent = "Assistant 0 / 0";

    const nextButton = this.createButton(
      "chevron-down",
      "Next assistant response",
      () => this.navigate("next")
    );
    nextButton.classList.add("assistant-turn-next");

    navigatorEl.append(previousButton, counterEl, nextButton);
    return { navigatorEl, previousButton, nextButton, counterEl };
  }

  private attachNavigator(): void {
    const header = this.doc.querySelector<HTMLElement>(".multi-session-header");
    if (header) {
      header.appendChild(this.navigatorEl);
      return;
    }

    // Fallback for tests or single-session webview surfaces where the optional
    // multi-session header has not been mounted yet.
    this.controller.messageList.elements.containerEl.appendChild(
      this.navigatorEl
    );
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
    const previousActiveWasLast =
      this.activeIndex === previousEntriesLength - 1;
    const previousElement = this.entries[this.activeIndex]?.element;
    this.entries = Array.from(
      this.messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    )
      .flatMap((element) => {
        if (!element.querySelector(".message-actions")) return [];

        const scrollTarget = this.findResponseScrollTarget(element);
        if (!scrollTarget) return [];

        return [{ element, scrollTarget }];
      })
      .map((entry, index) => ({
        ...entry,
        index,
        label: this.createLabel(entry.element, index),
      }));

    if (previousElement) {
      const nextIndex = this.entries.findIndex(
        (entry) => entry.element === previousElement
      );
      this.activeIndex =
        previousActiveWasLast && this.entries.length > previousEntriesLength
          ? this.entries.length - 1
          : nextIndex;
      if (this.activeIndex < 0) {
        this.hasButtonNavigationAnchor = false;
        this.activeIndex = this.entries.length - 1;
      }
    } else {
      this.activeIndex = this.entries.length - 1;
    }

    if (this.entries.length === 0) {
      this.activeIndex = -1;
      this.clearButtonNavigationAnchor();
    }
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

  private findResponseScrollTarget(element: HTMLElement): HTMLElement | null {
    return (
      Array.from(element.querySelectorAll<HTMLElement>(".block-text")).find(
        (block) => (block.textContent ?? "").trim().length > 0
      ) ?? null
    );
  }

  private ensureActiveIndex(): void {
    if (this.entries.length === 0) {
      this.activeIndex = -1;
      return;
    }

    const focusedAssistant = this.getFocusedAssistantElement();
    if (focusedAssistant && this.setActiveByElement(focusedAssistant)) return;

    if (this.activeIndex >= 0 && this.activeIndex < this.entries.length) return;
    this.activeIndex = this.findNearestIndexFromScroll();
  }

  private resolveNavigationTargetIndex(
    direction: AssistantTurnNavigationDirection
  ): number {
    const focusedAssistant = this.getFocusedAssistantElement();
    if (focusedAssistant) {
      return this.resolveTargetFromAssistant(focusedAssistant, direction);
    }

    if (
      this.hasButtonNavigationAnchor &&
      this.activeIndex >= 0 &&
      this.activeIndex < this.entries.length
    ) {
      return this.clampIndex(
        this.activeIndex + (direction === "previous" ? -1 : 1)
      );
    }

    const lastFocusedAssistant = this.getLastFocusedAssistantElement();
    if (lastFocusedAssistant) {
      return this.resolveTargetFromAssistant(lastFocusedAssistant, direction);
    }

    const directionalIndex =
      this.findDirectionalIndexFromReadingAnchor(direction);
    if (directionalIndex >= 0) return directionalIndex;

    this.ensureActiveIndex();
    return this.clampIndex(
      this.activeIndex + (direction === "previous" ? -1 : 1)
    );
  }

  private resolveTargetFromAssistant(
    element: HTMLElement,
    direction: AssistantTurnNavigationDirection
  ): number {
    const index = this.findEntryIndexByElement(element);
    if (index >= 0) {
      return this.clampIndex(index + (direction === "previous" ? -1 : 1));
    }

    const insertionIndex = this.findEntryInsertionIndex(element);
    if (insertionIndex >= 0) {
      return this.clampIndex(
        direction === "previous" ? insertionIndex - 1 : insertionIndex
      );
    }

    this.ensureActiveIndex();
    return this.clampIndex(
      this.activeIndex + (direction === "previous" ? -1 : 1)
    );
  }

  private findDirectionalIndexFromReadingAnchor(
    direction: AssistantTurnNavigationDirection
  ): number {
    const containerRect = this.messagesEl.getBoundingClientRect();
    if (containerRect.height <= 0) return -1;

    const anchorY =
      containerRect.top + Math.max(24, containerRect.height * 0.25);
    const positions = this.entries.map(
      (entry) => entry.scrollTarget.getBoundingClientRect().top
    );
    if (positions.some((top) => !Number.isFinite(top))) return -1;

    if (direction === "next") {
      let nextIndex = -1;
      let nearestTop = Number.POSITIVE_INFINITY;
      positions.forEach((top, index) => {
        if (
          top > anchorY + READING_ANCHOR_EPSILON_PX &&
          top < nearestTop
        ) {
          nearestTop = top;
          nextIndex = index;
        }
      });
      return nextIndex >= 0 ? nextIndex : this.entries.length - 1;
    }

    let previousIndex = -1;
    let nearestTop = Number.NEGATIVE_INFINITY;
    positions.forEach((top, index) => {
      if (
        top < anchorY - READING_ANCHOR_EPSILON_PX &&
        top >= nearestTop
      ) {
        nearestTop = top;
        previousIndex = index;
      }
    });
    return previousIndex >= 0 ? previousIndex : 0;
  }

  private clampIndex(index: number): number {
    return Math.max(0, Math.min(this.entries.length - 1, index));
  }

  private getFocusedAssistantElement(): HTMLElement | null {
    const element = (this.doc.activeElement as Element | null)?.closest(
      ".message.assistant"
    ) as HTMLElement | null;
    return element && this.messagesEl.contains(element) ? element : null;
  }

  private getLastFocusedAssistantElement(): HTMLElement | null {
    return this.lastFocusedAssistantElement &&
      this.messagesEl.contains(this.lastFocusedAssistantElement)
      ? this.lastFocusedAssistantElement
      : null;
  }

  private getViewportAssistantElement(): HTMLElement | null {
    if (typeof this.doc.elementFromPoint !== "function") return null;

    const rect = this.messagesEl.getBoundingClientRect();
    const x = rect.left + Math.max(1, rect.width / 2);
    const y = rect.top + Math.max(24, rect.height * 0.25);
    const element = this.doc.elementFromPoint(x, y);
    if (!element || !this.messagesEl.contains(element)) return null;

    return element.closest(".message.assistant") as HTMLElement | null;
  }

  private setActiveByElement(element: HTMLElement): boolean {
    const index = this.findEntryIndexByElement(element);
    if (index >= 0) {
      this.activeIndex = index;
      this.updateNavigator();
      return true;
    }

    const insertionIndex = this.findEntryInsertionIndex(element);
    if (insertionIndex < 0) return false;

    this.activeIndex = Math.max(
      0,
      Math.min(this.entries.length - 1, insertionIndex - 1)
    );
    this.updateNavigator();
    return true;
  }

  private findEntryIndexByElement(element: HTMLElement): number {
    return this.entries.findIndex((entry) => entry.element === element);
  }

  private findEntryInsertionIndex(element: HTMLElement): number {
    const assistantMessages = Array.from(
      this.messagesEl.querySelectorAll<HTMLElement>(".message.assistant")
    );
    const assistantIndex = assistantMessages.indexOf(element);
    if (assistantIndex < 0) return -1;

    const entryElements = new Set(this.entries.map((entry) => entry.element));
    let insertionIndex = 0;
    for (let index = 0; index < assistantIndex; index++) {
      if (entryElements.has(assistantMessages[index])) insertionIndex += 1;
    }
    return insertionIndex;
  }

  private updateActiveFromScroll(): void {
    if (this.entries.length === 0) return;
    if (this.hasButtonNavigationAnchor) return;

    const viewportAssistant = this.getViewportAssistantElement();
    if (viewportAssistant && this.setActiveByElement(viewportAssistant)) return;

    this.activeIndex = this.findNearestIndexFromScroll();
    this.updateNavigator();
  }

  private findNearestIndexFromScroll(): number {
    if (this.entries.length === 0) return -1;

    const containerRect = this.messagesEl.getBoundingClientRect();
    const anchor =
      containerRect.top + Math.max(24, containerRect.height * 0.25);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    this.entries.forEach((entry, index) => {
      const rect = entry.scrollTarget.getBoundingClientRect();
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
    this.hasButtonNavigationAnchor = true;
    this.controller.messageList.disableAutoScroll();
    entry.scrollTarget.scrollIntoView?.({ behavior: "smooth", block: "start" });
    this.updateNavigator();
  }

  private updateNavigator(): void {
    this.navigatorEl.hidden = this.entries.length === 0;
    this.previousButton.disabled = false;
    this.nextButton.disabled = false;

    if (this.entries.length === 0) {
      this.counterEl.textContent = "Assistant 0 / 0";
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
