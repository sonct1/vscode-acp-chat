import type {
  AvailableCommand,
  Mention,
  MessageListElements,
  UserScrollDirection,
  VsCodeApi,
} from "../types";
import { getRequiredElement } from "../widget/dom";

const BOTTOM_THRESHOLD_PX = 100;
const AUTO_SCROLL_SETTLE_FRAMES = 3;

type MessageType = "user" | "assistant" | "error" | "system";

interface AddMessageOptions {
  mentions?: Mention[];
  availableCommands: AvailableCommand[];
  // Chip rendering still depends on controller-owned ACP actions such as
  // openFile, so the list receives render callbacks instead of importing them.
  renderMentionChip: (mention: Mention, readonly: boolean) => HTMLElement;
  renderCommandChip: (
    command: string,
    description: string | undefined,
    readonly: boolean
  ) => HTMLElement;
}

/**
 * Owns the chat transcript surface: message DOM, list-level event delegation,
 * keyboard navigation, and auto-scroll state. Streaming block orchestration
 * stays in the controller because it depends on ACP message ordering.
 */
export class MessageListComponent {
  readonly elements: MessageListElements;
  private doc: Document;
  private win?: Window;
  private isAutoScrollEnabled = true;
  private pendingBottomScrollFrame: number | null = null;
  private pendingBottomScrollForce = false;
  private bottomScrollSettleFrames = 0;
  private pendingPaintFrame: number | null = null;
  private paintBump = false;
  private userScrollIntent = false;
  private pointerScrollActive = false;
  private touchScrollActive = false;
  private userScrollDirection: UserScrollDirection = "none";

  constructor(
    doc: Document,
    options?: {
      elements?: MessageListElements;
      win?: Window;
    }
  ) {
    this.doc = doc;
    this.win = options?.win;
    this.elements = options?.elements ?? {
      containerEl: getRequiredElement(doc, "messages-container"),
      messagesEl: getRequiredElement(doc, "messages"),
      typingIndicatorEl: getRequiredElement(doc, "typing-indicator"),
      welcomeView: getRequiredElement(doc, "welcome-view"),
    };
  }

  attachWindow(win: Window): void {
    this.win = win;
  }

  setupCodeCopyHandler(): void {
    this.elements.messagesEl.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const copyBtn = target.closest(".code-copy-btn") as HTMLButtonElement;

      if (!copyBtn) return;

      event.preventDefault();
      event.stopPropagation();

      const wrapper = copyBtn.closest(".code-block-wrapper");
      if (!wrapper) return;

      const pre = wrapper.querySelector("pre");
      if (!pre) return;

      const textToCopy = pre.textContent || "";

      try {
        await navigator.clipboard.writeText(textToCopy);

        const icon = copyBtn.querySelector(".codicon");
        if (icon) {
          icon.classList.remove("codicon-copy");
          icon.classList.add("codicon-check");
          copyBtn.classList.add("copied");
          copyBtn.setAttribute("acp-title", "Copied!");
        }

        setTimeout(() => {
          if (icon) {
            icon.classList.remove("codicon-check");
            icon.classList.add("codicon-copy");
            copyBtn.classList.remove("copied");
            const wrapper = copyBtn.closest(".code-block-wrapper");
            if (wrapper) {
              const pre = wrapper.querySelector("pre");
              if (pre && pre.classList.contains("detail-input")) {
                copyBtn.setAttribute("acp-title", "Copy input");
              } else if (pre && pre.classList.contains("tool-output")) {
                copyBtn.setAttribute("acp-title", "Copy output");
              } else {
                copyBtn.setAttribute("acp-title", "Copy code");
              }
            }
          }
        }, 1500);
      } catch (error) {
        console.error("Failed to copy:", error);
      }
    });
  }

  setupFileLinkHandler(vscode: VsCodeApi): void {
    this.elements.messagesEl.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest(
        "a"
      ) as HTMLAnchorElement | null;
      if (!target) return;

      const href = target.getAttribute("href");
      if (!href) return;

      if (href.startsWith("#")) return;
      if (/^[a-zA-Z][a-zA-Z0-9.+-]*:/.test(href) && !href.startsWith("file:"))
        return;

      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({
        type: "openFile",
        href,
      });
    });
  }

  setupDiffHeaderClickHandler(vscode: VsCodeApi): void {
    this.elements.messagesEl.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest(
        ".diff-header"
      ) as HTMLElement | null;
      if (!target) return;

      const path = target.getAttribute("data-file-path");
      if (!path) return;

      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({
        type: "openFile",
        path,
        checkExists: true,
      });
    });
  }

  setupScrollEventListeners(win: Window): void {
    this.attachWindow(win);
    const { messagesEl } = this.elements;

    // Auto-scroll is disabled only for deliberate list scrolling, not for
    // nested scrollable regions such as tool outputs and diff content.
    messagesEl.addEventListener("wheel", (event) => {
      if (!this.isEventFromMessagesScrollContainer(event.target)) return;
      const direction =
        event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : "unknown";
      this.markUserScrollIntent(direction);
    });

    messagesEl.addEventListener("pointerdown", (event) => {
      if (
        event.target !== messagesEl ||
        !this.isEventFromMessagesScrollContainer(event.target)
      ) {
        return;
      }
      this.pointerScrollActive = true;
      this.markUserScrollIntent("unknown");
    });

    messagesEl.addEventListener("touchstart", (event) => {
      if (!this.isEventFromMessagesScrollContainer(event.target)) return;
      this.touchScrollActive = true;
    });

    messagesEl.addEventListener("touchmove", (event) => {
      if (!this.isEventFromMessagesScrollContainer(event.target)) return;
      this.touchScrollActive = true;
      this.markUserScrollIntent("unknown");
    });

    messagesEl.addEventListener("keydown", (event) => {
      if (this.isEventFromMessagesScrollContainer(event.target)) {
        if (
          event.key === "ArrowUp" ||
          event.key === "PageUp" ||
          event.key === "Home"
        ) {
          this.markUserScrollIntent("up");
        } else if (
          event.key === "ArrowDown" ||
          event.key === "PageDown" ||
          event.key === "End" ||
          event.key === " "
        ) {
          this.markUserScrollIntent("down");
        }
      }

      const messages = Array.from(messagesEl.querySelectorAll(".message"));
      const currentIndex = messages.indexOf(this.doc.activeElement as Element);

      if (event.key === "ArrowDown" && currentIndex < messages.length - 1) {
        event.preventDefault();
        (messages[currentIndex + 1] as HTMLElement).focus();
      } else if (event.key === "ArrowUp" && currentIndex > 0) {
        event.preventDefault();
        (messages[currentIndex - 1] as HTMLElement).focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        (messages[0] as HTMLElement)?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        (messages[messages.length - 1] as HTMLElement)?.focus();
      }
    });

    messagesEl.addEventListener("scroll", () => this.handleMessagesScroll());

    win.addEventListener("pointerup", () => this.clearPointerScroll());
    win.addEventListener("pointercancel", () => this.clearPointerScroll());
    win.addEventListener("touchend", () => this.clearTouchScroll());
    win.addEventListener("touchcancel", () => this.clearTouchScroll());
  }

  addMessage(
    text: string,
    type: MessageType,
    options: AddMessageOptions
  ): HTMLElement {
    const messageEl = this.doc.createElement("div");
    messageEl.className = "message " + type;
    messageEl.setAttribute("role", "article");
    messageEl.setAttribute("tabindex", "0");

    const label =
      type === "user"
        ? "Your message"
        : type === "assistant"
          ? "Agent response"
          : type === "error"
            ? "Error message"
            : "System message";
    messageEl.setAttribute("aria-label", label);

    if (text) {
      messageEl.appendChild(this.renderMessageText(text, type, options));
    }

    this.elements.messagesEl.appendChild(messageEl);
    this.scrollToBottom(type === "user");

    if (text) {
      this.announceToScreenReader(label + ": " + text.substring(0, 100));
    }

    this.updateViewState();
    return messageEl;
  }

  updateViewState(): void {
    const hasMessages = this.elements.messagesEl.children.length > 0;
    this.elements.welcomeView.style.display = !hasMessages ? "flex" : "none";
    this.elements.containerEl.style.display = hasMessages ? "flex" : "none";
  }

  clear(): void {
    this.elements.messagesEl.innerHTML = "";
    this.updateViewState();
  }

  showTypingIndicator(currentAssistantMessage: HTMLElement | null): void {
    this.elements.typingIndicatorEl.classList.add("visible");
    if (currentAssistantMessage) {
      currentAssistantMessage.appendChild(this.elements.typingIndicatorEl);
    } else {
      this.elements.messagesEl.appendChild(this.elements.typingIndicatorEl);
    }
  }

  hideTypingIndicator(): void {
    this.elements.typingIndicatorEl.classList.remove("visible");
  }

  scrollToBottom(force = false): void {
    if (force) {
      this.enableAutoScroll();
    }

    // When the user has intentionally scrolled away, streaming updates should
    // still invalidate paint without stealing their viewport position.
    if (!force && !this.isAutoScrollEnabled) {
      this.scheduleMessagesPaintInvalidation();
      return;
    }

    this.pendingBottomScrollForce = this.pendingBottomScrollForce || force;
    this.bottomScrollSettleFrames = Math.max(
      this.bottomScrollSettleFrames,
      AUTO_SCROLL_SETTLE_FRAMES
    );
    this.scheduleBottomScrollFrame();
  }

  disableAutoScroll(): void {
    this.isAutoScrollEnabled = false;
    this.cancelPendingBottomScroll();
  }

  scrollToTop(): void {
    this.disableAutoScroll();
    this.elements.messagesEl.scrollTo({ top: 0, behavior: "smooth" });
  }

  scrollToPreviousUserMessage(messageEl: HTMLElement): void {
    this.disableAutoScroll();
    const allMessages = Array.from(
      this.elements.messagesEl.querySelectorAll(".message")
    );
    const currentIdx = allMessages.indexOf(messageEl);
    if (currentIdx <= 0) return;

    for (let index = currentIdx - 1; index >= 0; index--) {
      if (allMessages[index].classList.contains("user")) {
        allMessages[index].scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        break;
      }
    }
  }

  private renderMessageText(
    text: string,
    type: MessageType,
    options: AddMessageOptions
  ): HTMLElement {
    const textEl = this.doc.createElement("div");
    textEl.className = "message-content-text";

    const placeholderRegex = /__MENTION_(\d+)__/g;
    const commandRegex = /(?<=^|\s)\/[\w-]+(?=\s|$)/g;

    type Token =
      | { type: "mention"; start: number; end: number; index: number }
      | { type: "command"; start: number; end: number; name: string };

    const tokens: Token[] = [];
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(text)) !== null) {
      tokens.push({
        type: "mention",
        start: match.index,
        end: placeholderRegex.lastIndex,
        index: parseInt(match[1], 10),
      });
    }

    if (type === "user") {
      while ((match = commandRegex.exec(text)) !== null) {
        const commandName = match[0].substring(1);
        const command = options.availableCommands.find(
          (availableCommand) => availableCommand.name === commandName
        );
        if (command) {
          tokens.push({
            type: "command",
            start: match.index,
            end: commandRegex.lastIndex,
            name: commandName,
          });
        }
      }
    }

    tokens.sort((a, b) => a.start - b.start);

    // Mentions and slash commands can overlap in raw text. Keep the first
    // token at each span so DOM replacement never duplicates text.
    const validTokens: Token[] = [];
    let currentEnd = 0;
    for (const token of tokens) {
      if (token.start >= currentEnd) {
        validTokens.push(token);
        currentEnd = token.end;
      }
    }

    let lastIndex = 0;
    for (const token of validTokens) {
      if (token.start > lastIndex) {
        textEl.appendChild(
          this.doc.createTextNode(text.substring(lastIndex, token.start))
        );
      }

      if (token.type === "mention") {
        if (options.mentions && options.mentions[token.index]) {
          textEl.appendChild(
            options.renderMentionChip(options.mentions[token.index], true)
          );
        }
      } else if (token.type === "command") {
        const command = options.availableCommands.find(
          (availableCommand) => availableCommand.name === token.name
        )!;
        textEl.appendChild(
          options.renderCommandChip("/" + token.name, command.description, true)
        );
      }

      lastIndex = token.end;
    }

    if (lastIndex < text.length) {
      textEl.appendChild(this.doc.createTextNode(text.substring(lastIndex)));
    }

    return textEl;
  }

  private announceToScreenReader(message: string): void {
    const announcement = this.doc.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.className = "sr-only";
    announcement.textContent = message;
    this.doc.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  private isNearMessagesBottom(): boolean {
    const { messagesEl } = this.elements;
    return (
      messagesEl.scrollHeight -
        messagesEl.scrollTop -
        messagesEl.clientHeight <=
      BOTTOM_THRESHOLD_PX
    );
  }

  private isEventFromMessagesScrollContainer(
    target: EventTarget | null
  ): boolean {
    const { messagesEl } = this.elements;
    if (target === messagesEl) {
      return true;
    }
    if (!target || typeof (target as Element).closest !== "function") {
      return false;
    }

    const targetEl = target as Element;
    if (!messagesEl.contains(targetEl)) {
      return false;
    }

    return !targetEl.closest(
      ".diff-content, .tool-output, .diff-summary-list, .detail-input"
    );
  }

  private markUserScrollIntent(direction: UserScrollDirection): void {
    this.userScrollIntent = true;
    this.userScrollDirection = direction;
  }

  private clearDiscreteScrollIntent(): void {
    if (this.pointerScrollActive || this.touchScrollActive) {
      return;
    }
    this.userScrollIntent = false;
    this.userScrollDirection = "none";
  }

  private clearPointerScroll(): void {
    this.pointerScrollActive = false;
    this.clearDiscreteScrollIntent();
  }

  private clearTouchScroll(): void {
    this.touchScrollActive = false;
    this.clearDiscreteScrollIntent();
  }

  private enableAutoScroll(): void {
    this.isAutoScrollEnabled = true;
  }

  private handleMessagesScroll(): void {
    const hasUserIntent =
      this.userScrollIntent ||
      this.pointerScrollActive ||
      this.touchScrollActive;

    if (hasUserIntent) {
      const isNearBottom = this.isNearMessagesBottom();
      const direction = this.userScrollDirection;

      if (isNearBottom) {
        this.enableAutoScroll();
      } else if (this.pointerScrollActive || this.touchScrollActive) {
        this.disableAutoScroll();
      } else if (direction === "up" || direction === "unknown") {
        this.disableAutoScroll();
      }

      this.clearDiscreteScrollIntent();
    }

    this.scheduleMessagesPaintInvalidation();
  }

  private scheduleBottomScrollFrame(): void {
    if (this.pendingBottomScrollFrame !== null) {
      return;
    }

    // Streamed markdown and tool output can reflow for several frames after
    // insertion; settling over multiple frames keeps the bottom pin stable.
    this.pendingBottomScrollFrame = this.requestFrame(() => {
      this.pendingBottomScrollFrame = null;
      const shouldScroll =
        this.pendingBottomScrollForce || this.isAutoScrollEnabled;
      this.pendingBottomScrollForce = false;

      if (!shouldScroll) {
        this.bottomScrollSettleFrames = 0;
        this.scheduleMessagesPaintInvalidation();
        return;
      }

      this.performScrollToBottom();
      this.bottomScrollSettleFrames = Math.max(
        0,
        this.bottomScrollSettleFrames - 1
      );
      if (this.bottomScrollSettleFrames > 0 && this.isAutoScrollEnabled) {
        this.scheduleBottomScrollFrame();
      }
    });
  }

  private performScrollToBottom(): void {
    const { messagesEl } = this.elements;
    const previousScrollBehavior = messagesEl.style.scrollBehavior;
    messagesEl.style.scrollBehavior = "auto";
    messagesEl.scrollTop = messagesEl.scrollHeight;
    void messagesEl.offsetHeight;
    messagesEl.style.scrollBehavior = previousScrollBehavior;
    this.isAutoScrollEnabled = true;
    this.scheduleMessagesPaintInvalidation();
  }

  private cancelPendingBottomScroll(): void {
    if (this.pendingBottomScrollFrame !== null) {
      this.cancelFrame(this.pendingBottomScrollFrame);
      this.pendingBottomScrollFrame = null;
    }
    this.pendingBottomScrollForce = false;
    this.bottomScrollSettleFrames = 0;
  }

  private scheduleMessagesPaintInvalidation(): void {
    if (this.pendingPaintFrame !== null) {
      return;
    }

    this.pendingPaintFrame = this.requestFrame(() => {
      this.pendingPaintFrame = null;
      this.paintBump = !this.paintBump;
      this.elements.messagesEl.dataset.paintBump = this.paintBump ? "1" : "0";
      void this.elements.messagesEl.offsetHeight;
    });
  }

  private requestFrame(callback: FrameRequestCallback): number {
    if (typeof this.win?.requestAnimationFrame === "function") {
      return this.win.requestAnimationFrame(callback);
    }
    return this.win?.setTimeout(() => callback(Date.now()), 0) ?? 0;
  }

  private cancelFrame(frame: number): void {
    if (typeof this.win?.cancelAnimationFrame === "function") {
      this.win.cancelAnimationFrame(frame);
      return;
    }
    this.win?.clearTimeout(frame);
  }
}
