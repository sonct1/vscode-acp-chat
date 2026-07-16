import type { WebviewController } from "../../views/webview/main";
import type { MessageScrollPosition } from "../../views/webview/types";
import { LATEST_USER_PROMPT_TIP_STYLES } from "./styles";

interface UserTurnEntry {
  element: HTMLElement;
  preview: string;
}

interface RenderedPromptState {
  index: number;
  preview: string;
}

export class LatestUserPromptTipWebviewFeature {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly messagesEl: HTMLElement;
  private readonly inputContainerEl: HTMLElement;
  private readonly tipEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly previousButtonEl: HTMLButtonElement;
  private readonly nextButtonEl: HTMLButtonElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly observer: MutationObserver;
  private readonly surfaceLockObserver: MutationObserver;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly scrollPositionSubscription: { dispose(): void };
  private rebuildFrame: number | null = null;
  private updateFrame: number | null = null;
  private pendingNavigationResetTimer: number | null = null;
  private entries: UserTurnEntry[] = [];
  private isNearBottom = true;
  private isSurfaceLocked = false;
  private activeIndex: number | null = null;
  private pendingNavigationIndex: number | null = null;
  private renderedPrompt: RenderedPromptState | null = null;

  constructor(private readonly controller: WebviewController) {
    this.doc = controller.getDocument();
    this.win = controller.getWindow();
    this.messagesEl = controller.messageList.elements.messagesEl;
    const inputContainerEl = this.doc.getElementById("input-container");
    if (!inputContainerEl) {
      throw new Error("Latest user prompt tip requires the chat composer");
    }
    this.inputContainerEl = inputContainerEl;
    this.styleEl = this.injectStyles();

    const { tipEl, previewEl, previousButtonEl, nextButtonEl } =
      this.createTip();
    this.tipEl = tipEl;
    this.previewEl = previewEl;
    this.previousButtonEl = previousButtonEl;
    this.nextButtonEl = nextButtonEl;
    this.attachTip();

    this.scrollPositionSubscription =
      controller.messageList.onScrollPositionChange(
        (position: MessageScrollPosition) => {
          this.isNearBottom = position.isNearBottom;
          this.scheduleActivePromptUpdate();
        }
      );

    const MutationObserverCtor = (
      this.win as Window & {
        MutationObserver: typeof MutationObserver;
      }
    ).MutationObserver;
    this.observer = new MutationObserverCtor((records) => {
      if (records.some(hasUserMessageMutation)) {
        this.scheduleRebuildEntries();
      }
    });
    this.observer.observe(this.messagesEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    this.surfaceLockObserver = new MutationObserverCtor(() =>
      this.updateSurfaceLockState()
    );
    this.surfaceLockObserver.observe(this.inputContainerEl, {
      attributes: true,
      attributeFilter: ["inert", "aria-busy"],
    });
    this.updateSurfaceLockState();

    this.messagesEl.addEventListener(
      "wheel",
      this.handleManualNavigationInterruption
    );
    this.messagesEl.addEventListener(
      "pointerdown",
      this.handleManualNavigationInterruption
    );
    this.messagesEl.addEventListener(
      "touchstart",
      this.handleManualNavigationInterruption
    );
    this.messagesEl.addEventListener(
      "keydown",
      this.handleManualNavigationInterruption
    );

    const ResizeObserverCtor = (
      this.win as Window & {
        ResizeObserver?: typeof ResizeObserver;
      }
    ).ResizeObserver;
    this.resizeObserver = ResizeObserverCtor
      ? new ResizeObserverCtor(() => this.handleViewportResize())
      : null;
    this.resizeObserver?.observe(this.messagesEl);
    this.win.addEventListener("resize", this.handleWindowResize);

    this.rebuildEntries();
  }

  dispose(): void {
    this.observer.disconnect();
    this.surfaceLockObserver.disconnect();
    this.resizeObserver?.disconnect();
    this.win.removeEventListener("resize", this.handleWindowResize);
    this.messagesEl.removeEventListener(
      "wheel",
      this.handleManualNavigationInterruption
    );
    this.messagesEl.removeEventListener(
      "pointerdown",
      this.handleManualNavigationInterruption
    );
    this.messagesEl.removeEventListener(
      "touchstart",
      this.handleManualNavigationInterruption
    );
    this.messagesEl.removeEventListener(
      "keydown",
      this.handleManualNavigationInterruption
    );
    this.clearPendingNavigation();
    if (this.rebuildFrame !== null) {
      this.cancelFrame(this.rebuildFrame);
      this.rebuildFrame = null;
    }
    if (this.updateFrame !== null) {
      this.cancelFrame(this.updateFrame);
      this.updateFrame = null;
    }
    this.scrollPositionSubscription.dispose();
    this.tipEl.remove();
    this.styleEl.remove();
  }

  private readonly handleWindowResize = (): void => {
    this.handleViewportResize();
  };

  private readonly handleManualNavigationInterruption = (): void => {
    this.clearPendingNavigation();
    this.scheduleActivePromptUpdate();
  };

  private handleViewportResize(): void {
    this.isNearBottom = this.controller.messageList.getScrollPosition().isNearBottom;
    this.scheduleActivePromptUpdate();
  }

  private createTip(): {
    tipEl: HTMLElement;
    previewEl: HTMLElement;
    previousButtonEl: HTMLButtonElement;
    nextButtonEl: HTMLButtonElement;
  } {
    const tipEl = this.doc.createElement("div");
    tipEl.className = "latest-user-prompt-tip";
    tipEl.hidden = true;
    tipEl.tabIndex = 0;
    tipEl.setAttribute("role", "note");

    const labelEl = this.doc.createElement("span");
    labelEl.className = "latest-user-prompt-tip-label";
    labelEl.textContent = "Tip:";

    const previewEl = this.doc.createElement("span");
    previewEl.className = "latest-user-prompt-tip-preview";

    const actionsEl = this.doc.createElement("div");
    actionsEl.className = "latest-user-prompt-tip-actions";
    actionsEl.setAttribute("role", "group");
    actionsEl.setAttribute("aria-label", "Navigate user prompts");

    const previousButtonEl = this.createNavigationButton(
      "previous",
      "Navigate to previous user prompt",
      "chevron-up"
    );
    const nextButtonEl = this.createNavigationButton(
      "next",
      "Navigate to next user prompt",
      "chevron-down"
    );
    previousButtonEl.addEventListener("click", (event) =>
      this.handleNavigationClick(event, -1)
    );
    nextButtonEl.addEventListener("click", (event) =>
      this.handleNavigationClick(event, 1)
    );
    actionsEl.append(previousButtonEl, nextButtonEl);

    tipEl.append(labelEl, previewEl, actionsEl);
    return { tipEl, previewEl, previousButtonEl, nextButtonEl };
  }

  private createNavigationButton(
    direction: "previous" | "next",
    label: string,
    codicon: "chevron-up" | "chevron-down"
  ): HTMLButtonElement {
    const buttonEl = this.doc.createElement("button");
    buttonEl.type = "button";
    buttonEl.className = `latest-user-prompt-tip-action latest-user-prompt-tip-action-${direction}`;
    buttonEl.setAttribute("aria-label", label);
    buttonEl.setAttribute("acp-title", label);

    const iconEl = this.doc.createElement("span");
    iconEl.className = `codicon codicon-${codicon}`;
    iconEl.setAttribute("aria-hidden", "true");
    buttonEl.append(iconEl);
    return buttonEl;
  }

  private attachTip(): void {
    const composerEl = this.doc.getElementById("chat-input-area");
    if (!composerEl) {
      throw new Error("Latest user prompt tip requires the chat composer");
    }

    composerEl.insertBefore(this.tipEl, this.inputContainerEl);
  }

  private scheduleRebuildEntries(): void {
    if (this.rebuildFrame !== null) return;

    this.rebuildFrame = this.requestFrame(() => {
      this.rebuildFrame = null;
      this.rebuildEntries();
    });
  }

  private rebuildEntries(): void {
    this.clearPendingNavigation();
    this.entries = Array.from(this.messagesEl.children).flatMap((child) => {
      if (child.nodeType !== 1) return [];
      const element = child as HTMLElement;
      if (!element.classList.contains("message")) return [];
      if (!element.classList.contains("user")) return [];

      return [
        {
          element,
          preview: getUserMessagePreview(element),
        },
      ];
    });
    this.scheduleActivePromptUpdate();
  }

  private scheduleActivePromptUpdate(): void {
    if (this.updateFrame !== null) return;

    this.updateFrame = this.requestFrame(() => {
      this.updateFrame = null;
      this.updateActivePrompt();
    });
  }

  private updateActivePrompt(): void {
    if (this.isNearBottom || this.entries.length === 0) {
      this.clearPendingNavigation();
      this.activeIndex = null;
      this.render(null);
      return;
    }

    const containerRect = this.messagesEl.getBoundingClientRect();
    const anchorY =
      containerRect.top + Math.max(24, containerRect.height * 0.25);
    let low = 0;
    let high = this.entries.length - 1;
    let viewportIndex = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const entryTop =
        this.entries[middle].element.getBoundingClientRect().top;
      if (entryTop <= anchorY) {
        viewportIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (this.pendingNavigationIndex !== null) {
      const pendingEntry = this.entries[this.pendingNavigationIndex];
      if (viewportIndex === this.pendingNavigationIndex || !pendingEntry?.preview) {
        this.clearPendingNavigation();
      } else {
        this.activeIndex = this.pendingNavigationIndex;
        this.render({
          index: this.pendingNavigationIndex,
          preview: pendingEntry.preview,
        });
        return;
      }
    }

    this.activeIndex = viewportIndex;
    const preview = this.entries[viewportIndex].preview;
    this.render(preview ? { index: viewportIndex, preview } : null);
  }

  private handleNavigationClick(event: MouseEvent, direction: -1 | 1): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.isSurfaceLocked) return;

    const targetIndex = this.findNavigableIndex(direction);
    if (targetIndex === null) return;

    this.setPendingNavigation(targetIndex);
    this.activeIndex = targetIndex;
    const targetEntry = this.entries[targetIndex];
    this.render({ index: targetIndex, preview: targetEntry.preview });
    this.controller.messageList.disableAutoScroll();
    targetEntry.element.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private setPendingNavigation(index: number): void {
    this.clearPendingNavigation();
    this.pendingNavigationIndex = index;
    this.pendingNavigationResetTimer = this.win.setTimeout(() => {
      this.pendingNavigationResetTimer = null;
      this.pendingNavigationIndex = null;
      this.scheduleActivePromptUpdate();
    }, 1500);
  }

  private clearPendingNavigation(): void {
    this.pendingNavigationIndex = null;
    if (this.pendingNavigationResetTimer !== null) {
      this.win.clearTimeout(this.pendingNavigationResetTimer);
      this.pendingNavigationResetTimer = null;
    }
  }

  private updateSurfaceLockState(): void {
    this.isSurfaceLocked = this.inputContainerEl.hasAttribute("inert");
    this.tipEl.toggleAttribute("inert", this.isSurfaceLocked);
    this.tipEl.setAttribute("aria-busy", this.isSurfaceLocked ? "true" : "false");
    this.updateNavigationButtonState();
  }

  private findNavigableIndex(direction: -1 | 1): number | null {
    if (this.activeIndex === null) return null;

    for (
      let index = this.activeIndex + direction;
      index >= 0 && index < this.entries.length;
      index += direction
    ) {
      if (this.entries[index].preview) return index;
    }
    return null;
  }

  private render(prompt: RenderedPromptState | null): void {
    const renderedPrompt = this.renderedPrompt;
    const promptChanged =
      prompt?.index !== renderedPrompt?.index ||
      prompt?.preview !== renderedPrompt?.preview;

    if (promptChanged) {
      this.renderedPrompt = prompt;
      const visiblePreview = prompt?.preview ?? "";
      if (this.previewEl.textContent !== visiblePreview) {
        this.previewEl.textContent = visiblePreview;
      }

      if (prompt) {
        this.tipEl.setAttribute(
          "aria-label",
          `Prompt for current conversation turn: ${prompt.preview}`
        );
        this.tipEl.setAttribute("acp-title", prompt.preview);
      } else {
        this.tipEl.removeAttribute("aria-label");
        this.tipEl.removeAttribute("acp-title");
      }
    }

    this.updateNavigationButtonState();
    this.tipEl.hidden = prompt === null;
  }

  private updateNavigationButtonState(): void {
    this.previousButtonEl.disabled =
      this.isSurfaceLocked || this.findNavigableIndex(-1) === null;
    this.nextButtonEl.disabled =
      this.isSurfaceLocked || this.findNavigableIndex(1) === null;
  }

  private injectStyles(): HTMLStyleElement {
    const style = this.doc.createElement("style");
    style.dataset.feature = "latest-user-prompt-tip";
    style.textContent = LATEST_USER_PROMPT_TIP_STYLES;
    this.doc.head.append(style);
    return style;
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

function hasUserMessageMutation(record: MutationRecord): boolean {
  const targetElement =
    record.target.nodeType === 1
      ? (record.target as Element)
      : record.target.parentElement;
  if (targetElement?.closest(".message.user")) return true;

  return [...record.addedNodes, ...record.removedNodes].some((node) => {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return (
      element.matches(".message.user") ||
      element.querySelector(".message.user") !== null
    );
  });
}

function getUserMessagePreview(messageEl: HTMLElement): string {
  const contentEl = messageEl.querySelector<HTMLElement>(".message-content-text");
  if (!contentEl) return "";

  const clone = contentEl.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll<HTMLElement>(".mention-chip, .command-chip")
    .forEach((chip) => chip.classList.remove("readonly"));

  return normalizePreview(clone.textContent ?? "");
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function registerLatestUserPromptTipWebviewFeature(
  controller: WebviewController
): LatestUserPromptTipWebviewFeature {
  return new LatestUserPromptTipWebviewFeature(controller);
}
