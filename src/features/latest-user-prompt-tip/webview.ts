import type { WebviewController } from "../../views/webview/main";
import type { MessageScrollPosition } from "../../views/webview/types";
import { LATEST_USER_PROMPT_TIP_STYLES } from "./styles";

interface UserTurnEntry {
  element: HTMLElement;
  preview: string;
}

export class LatestUserPromptTipWebviewFeature {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly messagesEl: HTMLElement;
  private readonly tipEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly observer: MutationObserver;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly scrollPositionSubscription: { dispose(): void };
  private rebuildFrame: number | null = null;
  private updateFrame: number | null = null;
  private entries: UserTurnEntry[] = [];
  private isNearBottom = true;
  private renderedPreview: string | null = null;

  constructor(private readonly controller: WebviewController) {
    this.doc = controller.getDocument();
    this.win = controller.getWindow();
    this.messagesEl = controller.messageList.elements.messagesEl;
    this.styleEl = this.injectStyles();

    const { tipEl, previewEl } = this.createTip();
    this.tipEl = tipEl;
    this.previewEl = previewEl;
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
    this.resizeObserver?.disconnect();
    this.win.removeEventListener("resize", this.handleWindowResize);
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

  private handleViewportResize(): void {
    this.isNearBottom = this.controller.messageList.getScrollPosition().isNearBottom;
    this.scheduleActivePromptUpdate();
  }

  private createTip(): {
    tipEl: HTMLElement;
    previewEl: HTMLElement;
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

    tipEl.append(labelEl, previewEl);
    return { tipEl, previewEl };
  }

  private attachTip(): void {
    const composerEl = this.doc.getElementById("chat-input-area");
    const inputContainerEl = this.doc.getElementById("input-container");
    if (!composerEl || !inputContainerEl) {
      throw new Error("Latest user prompt tip requires the chat composer");
    }

    composerEl.insertBefore(this.tipEl, inputContainerEl);
  }

  private scheduleRebuildEntries(): void {
    if (this.rebuildFrame !== null) return;

    this.rebuildFrame = this.requestFrame(() => {
      this.rebuildFrame = null;
      this.rebuildEntries();
    });
  }

  private rebuildEntries(): void {
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
      this.render(null);
      return;
    }

    const containerRect = this.messagesEl.getBoundingClientRect();
    const anchorY =
      containerRect.top + Math.max(24, containerRect.height * 0.25);
    let low = 0;
    let high = this.entries.length - 1;
    let activeIndex = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const entryTop =
        this.entries[middle].element.getBoundingClientRect().top;
      if (entryTop <= anchorY) {
        activeIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    this.render(this.entries[activeIndex].preview || null);
  }

  private render(preview: string | null): void {
    if (preview === this.renderedPreview) return;

    this.renderedPreview = preview;
    const visiblePreview = preview ?? "";
    if (this.previewEl.textContent !== visiblePreview) {
      this.previewEl.textContent = visiblePreview;
    }

    if (preview) {
      this.tipEl.setAttribute(
        "aria-label",
        `Prompt for current conversation turn: ${preview}`
      );
      this.tipEl.setAttribute("acp-title", preview);
    } else {
      this.tipEl.removeAttribute("aria-label");
      this.tipEl.removeAttribute("acp-title");
    }

    this.tipEl.hidden = preview === null;
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
